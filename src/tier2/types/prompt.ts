/**
 * Prompt builder input/output contract — EveryBuilding Tier 2
 *
 * The prompt builder is the only place that assembles the LLM request.
 * It combines:
 *   - Property data from the lead row
 *   - Contact context (name, title, role angle)
 *   - The full CtaEntry (description + instructions + rules + examples)
 *   - Selective Voice Profile sections (only what this CTA needs)
 *   - Campaign-level config (signature, sending domain)
 *
 * Output is a structured prompt pair (system + user) ready for Claude Haiku.
 * The builder does NOT call the LLM — it only constructs the prompts.
 */

import type { CtaEntry, CtaNumber, CtaName, ContactRoleAngle } from "./cta";
import type { SelectiveVoiceProfile, VoiceProfileSection, SignatureLineData } from "./voice-profile";
import type { Tier2ContactRow, SignatureBlurbType } from "./lead-row";
import type { CampaignConfig } from "./campaign";

// ─── Property context (subset of Tier2ContactRow used in the prompt) ──────────

/**
 * The property fields the LLM needs to write a building-specific email.
 * Pulled directly from the lead row — no transformation required.
 */
export type PropertyContext = Pick<
  Tier2ContactRow,
  | "property_address"
  | "city"
  | "state"
  | "zip_code"
  | "land_use"
  | "year_built"
  | "square_feet"
  | "owner_entity"
  | "last_sale_date"
  | "permit_summary"
  | "roof_permit_date"
  | "hvac_permit_date"
  | "tax_or_distress_notes"
>;

/**
 * The contact fields the LLM needs to address the email appropriately.
 */
export type ContactContext = Pick<
  Tier2ContactRow,
  | "contact_name"
  | "contact_title"
  | "contact_email"
  | "sequence"
>;

// ─── Signature line context ───────────────────────────────────────────────────

/**
 * What the prompt builder passes to the signature line selector.
 * The selector picks a blurb type not used in the last 5 emails,
 * then pulls the matching data from SignatureLineData.
 */
export interface SignatureLineContext {
  signature_line_data: SignatureLineData;
  last_5_blurb_types: SignatureBlurbType[];
}

/** The resolved signature line ready for injection into the prompt */
export interface ResolvedSignatureLine {
  blurb_type: SignatureBlurbType;
  text: string; // One complete sentence, e.g. "GAF Master Elite certified since 2011."
}

// ─── Prompt builder input ─────────────────────────────────────────────────────

export interface PromptBuilderInput {
  /** Lead row data — property and contact fields only */
  property: PropertyContext;
  contact: ContactContext;

  /** The full CTA entry from the playbook (description + instructions + rules + examples) */
  cta: CtaEntry;

  /**
   * Role-based framing angle derived from contact_title.
   * Determines which financial/operational/practical lens the email uses.
   */
  role_angle: ContactRoleAngle;

  /**
   * Only the Voice Profile sections this CTA needs.
   * Constructed by the prompt builder from cta.voice_profile_sections.
   * Never pass the full profile — keep context lean.
   */
  voice_profile: SelectiveVoiceProfile;

  /** Resolved signature line for this send */
  signature_line: ResolvedSignatureLine;

  /** Campaign-level config (client name, cadence, sending domain) */
  campaign: CampaignConfig;
}

// ─── Prompt builder output ────────────────────────────────────────────────────

export interface PromptBuilderOutput {
  /** System prompt — sets role, constraints, global rules, CTA instructions */
  system_prompt: string;
  /** User prompt — property data, contact name/title, role angle, examples */
  user_prompt: string;

  // ── Metadata for logging and observability ────────────────────────────────
  cta_number: CtaNumber;
  cta_name: CtaName;
  role_angle: ContactRoleAngle;
  /** Which Voice Profile sections were included in this prompt */
  voice_sections_used: VoiceProfileSection[];
  /** Blurb type selected for the signature line */
  signature_blurb_type: SignatureBlurbType;
  built_at: string; // ISO timestamp
}

// ─── Role angle derivation ────────────────────────────────────────────────────

/**
 * Maps a contact's job title to the correct email framing angle.
 * Called before prompt construction. Case-insensitive matching.
 *
 * VP / Director / C-Suite / Owner  → "financial"
 * Facilities Director / Manager    → "operational"
 * Property Manager                 → "practical"
 * Asset Manager / Investment       → "investment"
 * Fallback (anything else)         → "operational"
 */
export function deriveRoleAngle(contactTitle: string): ContactRoleAngle {
  const t = contactTitle.toLowerCase();

  if (
    t.includes("asset manager") ||
    t.includes("asset management") ||
    t.includes("investment")
  ) {
    return "investment";
  }

  if (
    t.includes("vp") ||
    t.includes("vice president") ||
    t.includes("director") ||
    t.includes("chief") ||
    t.includes("ceo") ||
    t.includes("coo") ||
    t.includes("owner") ||
    t.includes("managing partner") ||
    t.includes("principal")
  ) {
    return "financial";
  }

  if (
    t.includes("property manager") ||
    t.includes("building manager")
  ) {
    return "practical";
  }

  // Facilities Director, Facilities Manager, Maintenance Director, VP Operations, etc.
  return "operational";
}
