/**
 * Voice profile section selector — EveryBuilding Tier 2
 *
 * Extracts only the sections a given CTA needs from the full ClientVoiceProfile.
 * The prompt builder calls this instead of passing the entire profile to the LLM.
 *
 * Three sections are always included regardless of CTA type:
 *   - company_basics  (anchors every email — company name, trade, location)
 *   - brand_voice     (enforces tone + phrase rules on every send)
 *   - sender_identity (required for the sign-off on every email)
 *
 * All other sections are included only when the CTA entry explicitly requests them
 * via its `voice_profile_sections` array.
 */

import type {
  ClientVoiceProfile,
  SelectiveVoiceProfile,
  VoiceProfileSection,
} from "../types/voice-profile";

// ─── Sections always injected regardless of CTA ───────────────────────────────

const ALWAYS_INCLUDED: VoiceProfileSection[] = [
  "company_basics",
  "brand_voice",
  "sender_identity",
];

// ─── Selector ─────────────────────────────────────────────────────────────────

/**
 * Returns a minimal SelectiveVoiceProfile containing only the sections
 * needed for the given CTA plus the three always-included anchors.
 *
 * @param profile  Full ClientVoiceProfile loaded from Drive
 * @param sections The `voice_profile_sections` array from the CtaEntry
 */
export function selectVoiceProfileSections(
  profile: ClientVoiceProfile,
  sections: VoiceProfileSection[]
): SelectiveVoiceProfile {
  const requested = new Set([...ALWAYS_INCLUDED, ...sections]);
  const result: SelectiveVoiceProfile = {};

  if (requested.has("company_basics")) {
    result.company_basics = profile.company_basics;
  }

  if (requested.has("brand_voice")) {
    result.brand_voice = profile.brand_voice;
  }

  if (requested.has("sender_identity")) {
    result.sender_identity = profile.sender_identity;
  }

  if (requested.has("usps")) {
    result.primary_usp = profile.primary_usp;
    result.additional_usps = profile.additional_usps;
  }

  if (requested.has("signature_projects")) {
    result.signature_projects = profile.signature_projects;
  }

  if (requested.has("customer_praise")) {
    result.customer_praise_themes = profile.customer_praise_themes;
  }

  if (requested.has("market_positioning")) {
    result.market_positioning = profile.market_positioning;
  }

  if (requested.has("targeting_preferences") && profile.targeting_preferences !== null) {
    result.targeting_preferences = profile.targeting_preferences;
  }

  if (requested.has("assets_available") && profile.assets_available !== null) {
    result.assets_available = profile.assets_available;
  }

  if (requested.has("signature_line_data")) {
    result.signature_line_data = profile.signature_line_data;
  }

  return result;
}

/**
 * Returns the full set of VoiceProfileSection keys that will be included
 * for a given CTA's `voice_profile_sections` list.
 *
 * Use this to populate `voice_sections_used` in PromptBuilderOutput.
 */
export function resolvedSections(sections: VoiceProfileSection[]): VoiceProfileSection[] {
  return [...new Set([...ALWAYS_INCLUDED, ...sections])];
}
