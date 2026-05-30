/**
 * Prompt input assembler — EveryBuilding Tier 2
 *
 * High-level convenience function used by the daily pipeline job.
 * Wires together all the helpers and produces a PromptBuilderInput
 * ready for buildPrompt().
 *
 * Pipeline call sequence for one contact row:
 *
 *   1. evaluateCta(ctaEntry)              → skip or proceed
 *   2. preparePromptInput(row, cta, ...)  → PromptBuilderInput
 *   3. buildPrompt(input)                 → PromptBuilderOutput (system + user prompts)
 *   4. call Claude Haiku with the prompts → GeneratedEmail JSON
 *   5. validateEmail(generated, cta)      → EmailValidationResult
 *   6. push to Instantly if valid, else retry once with retry_prompt
 */

import type { ClientVoiceProfile } from "../types/voice-profile";
import type { CtaEntry } from "../types/cta";
import type { CampaignConfig } from "../types/campaign";
import type { Tier2ContactRow } from "../types/lead-row";
import type { PromptBuilderInput, PropertyContext, ContactContext } from "../types/prompt";
import { deriveRoleAngle } from "../types/prompt";
import { selectVoiceProfileSections } from "./selectVoiceProfile";
import { resolveSignatureLine } from "./selectSignatureLine";

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value.replace(/,/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function sequence(value: unknown): ContactContext["sequence"] {
  return value === "Secondary" || value === "Tertiary" ? value : "Primary";
}

/**
 * Assembles all inputs for buildPrompt() from raw pipeline data.
 *
 * This function performs no I/O — the caller is responsible for having
 * already loaded the playbook, voice profile, and campaign config.
 *
 * @param row      The Tier2ContactRow being processed
 * @param cta      The CtaEntry for row.next_cta_number (after evaluateCta passes)
 * @param profile  The full ClientVoiceProfile for this client
 * @param campaign The CampaignConfig for this client
 */
export function preparePromptInput(
  row: Tier2ContactRow,
  cta: CtaEntry,
  profile: ClientVoiceProfile,
  campaign: CampaignConfig
): PromptBuilderInput {
  const role_angle = deriveRoleAngle(text(row.contact_title));

  const voice_profile = selectVoiceProfileSections(
    profile,
    cta.voice_profile_sections
  );

  const signature_line = resolveSignatureLine({
    signature_line_data: profile.signature_line_data,
    last_5_blurb_types: Array.isArray(row.last_5_signature_blurb_types)
      ? row.last_5_signature_blurb_types
      : [],
  });

  const property: PropertyContext = {
    property_address: text(row.property_address),
    city: text(row.city),
    state: text(row.state),
    zip_code: text(row.zip_code),
    land_use: text(row.land_use),
    year_built: numberOrNull(row.year_built),
    square_feet: numberOrNull(row.square_feet),
    owner_entity: text(row.owner_entity),
    last_sale_date: text(row.last_sale_date),
    permit_summary: text(row.permit_summary),
    roof_permit_date: text(row.roof_permit_date),
    hvac_permit_date: text(row.hvac_permit_date),
    plumbing_permit_date: text(row.plumbing_permit_date),
    electrical_permit_date: text(row.electrical_permit_date),
    restoration_permit_date: text(row.restoration_permit_date),
    fire_water_permit_date: text(row.fire_water_permit_date),
    last_permit_date: text(row.last_permit_date),
    permit_contractor: text(row.permit_contractor),
    tax_or_distress_notes: text(row.tax_or_distress_notes),
    hazard_notes: text(row.hazard_notes),
    crime_notes: text(row.crime_notes),
    demographics_notes: text(row.demographics_notes),
    air_quality_notes: text(row.air_quality_notes),
    climate_notes: text(row.climate_notes),
  };

  const contact: ContactContext = {
    contact_name: text(row.contact_name),
    contact_title: text(row.contact_title),
    contact_email: text(row.contact_email),
    sequence: sequence(row.sequence),
  };

  return {
    property,
    contact,
    cta,
    role_angle,
    voice_profile,
    signature_line,
    campaign,
  };
}
