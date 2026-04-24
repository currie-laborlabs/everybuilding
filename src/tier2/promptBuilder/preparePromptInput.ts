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
  const role_angle = deriveRoleAngle(row.contact_title);

  const voice_profile = selectVoiceProfileSections(
    profile,
    cta.voice_profile_sections
  );

  const signature_line = resolveSignatureLine({
    signature_line_data: profile.signature_line_data,
    last_5_blurb_types: row.last_5_signature_blurb_types,
  });

  const property: PropertyContext = {
    property_address: row.property_address,
    city: row.city,
    state: row.state,
    zip_code: row.zip_code,
    land_use: row.land_use,
    year_built: row.year_built,
    square_feet: row.square_feet,
    owner_entity: row.owner_entity,
    last_sale_date: row.last_sale_date,
    permit_summary: row.permit_summary,
    roof_permit_date: row.roof_permit_date,
    hvac_permit_date: row.hvac_permit_date,
    tax_or_distress_notes: row.tax_or_distress_notes,
  };

  const contact: ContactContext = {
    contact_name: row.contact_name,
    contact_title: row.contact_title,
    contact_email: row.contact_email,
    sequence: row.sequence,
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
