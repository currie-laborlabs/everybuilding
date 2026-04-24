/**
 * CTA Playbook types for Tier 2 — EveryBuilding
 *
 * The CTA Playbook JSON lives in Google Drive at:
 *   _System Files / CTA_Playbook.json
 *
 * The pipeline reads this file at the start of each daily run.
 * It is NOT cached permanently — reload each run so edits take effect.
 */

import type { VoiceProfileSection } from "./voice-profile";

// ─── CTA identity ────────────────────────────────────────────────────────────

export type CtaNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export type CtaName =
  | "property_insight"       // #1
  | "video_offer"            // #2
  | "free_assessment"        // #3
  | "interest_question"      // #4
  | "case_study_offer"       // #5
  | "reply_with_number"      // #6
  | "resource_checklist"     // #7
  | "weather_trigger"        // #8 — conditional on NOAA data (Phase 2)
  | "proximity"              // #9 — best with nearby job data
  | "hypothesis_challenge";  // #10

// ─── CTA condition gate ───────────────────────────────────────────────────────

/**
 * Some CTAs are conditional (e.g. #8 requires a recent storm event nearby).
 * When `skip_when_unmet` is true, the pipeline advances to the next CTA
 * rather than blocking the send cycle.
 *
 * Until NOAA integration is built:
 *   - CTA #8's condition always evaluates to false
 *   - Pipeline auto-skips to #9
 */
export interface CtaCondition {
  /** Human-readable explanation of the condition */
  description: string;
  /** When the condition cannot be evaluated (e.g. data source not built), skip */
  skip_when_unmet: boolean;
}

// ─── CTA example ─────────────────────────────────────────────────────────────

/**
 * A human-written example email that the LLM uses as a style reference.
 * Each CTA entry requires exactly two examples.
 */
export interface CtaExample {
  subject: string;
  body: string;
  /**
   * The role this example was written for.
   * Helps the LLM pick the most relevant example to emulate.
   */
  target_role: ContactRoleAngle;
}

// ─── Contact role angle (used both in CTA examples and prompt builder) ────────

/**
 * Maps contact title → framing approach in the generated email.
 *
 * VP / Director / C-Suite / Owner → "financial"
 * Facilities Director / Manager   → "operational"
 * Property Manager                → "practical"
 * Asset Manager / Investment       → "investment"
 */
export type ContactRoleAngle = "financial" | "operational" | "practical" | "investment";

// ─── CTA entry ────────────────────────────────────────────────────────────────

export interface CtaEntry {
  cta_number: CtaNumber;
  name: CtaName;
  /** Display label used in reports and logs */
  display_name: string;
  /** One-paragraph description of what this CTA does */
  description: string;
  /**
   * Prose instructions for the LLM on how to compose this email.
   * Injected verbatim into the system prompt.
   */
  instructions: string;
  /**
   * Hard rules enforced at generation time (injected as a constraint list).
   * Any generated email violating these triggers a corrective retry.
   */
  rules: string[];
  /**
   * Which Voice Profile sections to inject for this CTA type.
   * Keep selective — do NOT inject the full profile on every send.
   */
  voice_profile_sections: VoiceProfileSection[];
  /**
   * Exactly two human-written example emails.
   * Tuple enforces the two-example requirement at the type level.
   */
  examples: [CtaExample, CtaExample];
  /**
   * Optional condition gate. null = always eligible.
   * A non-null condition does NOT mean the email is blocked — see skip_when_unmet.
   */
  condition: CtaCondition | null;
  /** Hard word limit for the generated email body (excluding subject + signature) */
  word_limit: number;
  /**
   * Whether this CTA may include an external URL in the email body.
   * Most CTAs do NOT include links (link is sent on reply).
   */
  allow_link_in_body: boolean;
}

// ─── The full playbook ────────────────────────────────────────────────────────

export interface CtaPlaybook {
  /** Semver string for change tracking */
  version: string;
  updated_at: string;
  /**
   * All 10 CTA entries keyed by cta_number.
   * TypeScript's Record<CtaNumber, CtaEntry> enforces all 10 must be present.
   */
  ctas: Record<CtaNumber, CtaEntry>;
  /**
   * Global rules that apply to every generated email regardless of CTA type.
   * Injected into the system prompt alongside CTA-specific rules.
   */
  global_rules: string[];
}

// ─── CTA rotation helpers ─────────────────────────────────────────────────────

/**
 * Returns the next CTA number in the rotation.
 * After #10 resets to #1 (fresh data cycle begins).
 */
export function nextCtaNumber(current: CtaNumber): CtaNumber {
  return current === 10 ? 1 : ((current + 1) as CtaNumber);
}
