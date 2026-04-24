/**
 * Email validator — EveryBuilding Tier 2
 *
 * Validates a GeneratedEmail against:
 *   1. Standard hard rules (word limit, building reference, CTA match, sender, etc.)
 *   2. CTA-specific rules from the playbook entry (CtaEntry.rules)
 *   3. Voice profile forbidden phrases and sender identity requirements
 *
 * Hard violations block sending and trigger one corrective retry.
 * Soft violations are logged but do not block sending.
 *
 * Call flow:
 *   generated  = JSON.parse(llmResponse)               // parse LLM output
 *   result     = validateEmail(generated, ctx)          // validate
 *   if (!result.passed) retry with result.retry_prompt
 */

import type {
  GeneratedEmail,
  EmailValidationResult,
  EmailValidationViolation,
  ValidationSeverity,
} from "../types/validation";
import type { CtaEntry } from "../types/cta";
import type { SelectiveVoiceProfile } from "../types/voice-profile";
import type { PropertyContext } from "../types/prompt";
import type { ResolvedSignatureLine } from "../types/prompt";
import { buildRetryPrompt } from "./buildRetryPrompt";

// ─── Validation context ───────────────────────────────────────────────────────

/**
 * Everything the validator needs to evaluate one email.
 * Assembled by the pipeline before calling validateEmail().
 */
export interface EmailValidationContext {
  /** The property this email is about — used for building reference check */
  property: PropertyContext;
  /** The CTA entry that was used to generate this email */
  cta: CtaEntry;
  /** Selective voice profile — used for forbidden phrase + sender identity checks */
  voice_profile: SelectiveVoiceProfile;
  /** The resolved signature line the LLM was directed to use */
  expected_signature_line: ResolvedSignatureLine;
}

// ─── Main entry point ─────────────────────────────────────────────────────────

/**
 * Validates a GeneratedEmail against all applicable rules.
 *
 * @param email  The parsed JSON output from Claude Haiku
 * @param ctx    Validation context (property, CTA, voice profile, signature)
 */
export function validateEmail(
  email: GeneratedEmail,
  ctx: EmailValidationContext
): EmailValidationResult {
  const violations: EmailValidationViolation[] = [];

  // ── 1. Word count ──────────────────────────────────────────────────────────
  const actualWordCount = countWords(email.body);
  if (actualWordCount >= ctx.cta.word_limit) {
    violations.push(violation(
      "word_limit",
      `Body is ${actualWordCount} words but the limit for CTA #${ctx.cta.cta_number} is ${ctx.cta.word_limit}. Reduce by ${actualWordCount - ctx.cta.word_limit + 1} word${actualWordCount - ctx.cta.word_limit + 1 === 1 ? "" : "s"}.`,
      "hard"
    ));
  }

  // ── 2. Building reference ──────────────────────────────────────────────────
  if (!referencesBuilding(email.body, ctx.property)) {
    violations.push(violation(
      "building_referenced",
      `Email body does not reference the building. It must mention the address "${ctx.property.property_address}" or a specific detail about the property (year built, sqft, land use, etc.).`,
      "hard"
    ));
  }

  // ── 3. CTA number match ────────────────────────────────────────────────────
  if (
    email.cta_number_used !== ctx.cta.cta_number ||
    email.cta_name_used !== ctx.cta.name
  ) {
    violations.push(violation(
      "cta_number_match",
      `Email was generated for CTA #${ctx.cta.cta_number} (${ctx.cta.name}) but the LLM reported using CTA #${email.cta_number_used} (${email.cta_name_used}). Regenerate using CTA #${ctx.cta.cta_number}.`,
      "hard"
    ));
  }

  // ── 4. URL / link check ────────────────────────────────────────────────────
  if (!ctx.cta.allow_link_in_body && containsUrl(email.body)) {
    violations.push(violation(
      "no_links_in_body",
      `CTA #${ctx.cta.cta_number} (${ctx.cta.name}) does not allow URLs in the body. Remove all links. If the CTA offers a link, note it will be sent upon reply — do not include it here.`,
      "hard"
    ));
  }

  // ── 5. Sender identity ────────────────────────────────────────────────────
  const senderViolations = checkSenderIdentity(email, ctx.voice_profile);
  violations.push(...senderViolations);

  // ── 6. Signature line present and correct ──────────────────────────────────
  const sigViolations = checkSignatureLine(email, ctx.expected_signature_line);
  violations.push(...sigViolations);

  // ── 7. Forbidden phrases from brand voice ──────────────────────────────────
  const phraseViolations = checkForbiddenPhrases(email.body, ctx.voice_profile);
  violations.push(...phraseViolations);

  // ── 8. Global banned phrases (always applied, regardless of voice profile) ──
  const globalViolations = checkGlobalBannedPhrases(email.body);
  violations.push(...globalViolations);

  // ── 9. AI opener check ─────────────────────────────────────────────────────
  if (hasAiOpener(email.body)) {
    violations.push(violation(
      "no_ai_opener",
      'Email opens with an AI-sounding phrase (e.g. "I hope this email finds you well", "I wanted to reach out"). Rewrite the opening line to be direct and specific to the building.',
      "soft"
    ));
  }

  // ── 10. Subject line not empty ─────────────────────────────────────────────
  if (!email.subject.trim()) {
    violations.push(violation(
      "subject_required",
      "Email subject line is empty.",
      "hard"
    ));
  }

  // ── 11. CTA-specific playbook rules ────────────────────────────────────────
  const ctaRuleViolations = checkCtaSpecificRules(email, ctx);
  violations.push(...ctaRuleViolations);

  const hardViolations = violations.filter((v) => v.severity === "hard");
  const passed = hardViolations.length === 0;

  const retry_prompt = passed
    ? null
    : buildRetryPrompt(hardViolations, violations.filter((v) => v.severity === "soft"), actualWordCount, ctx);

  return {
    passed,
    violations,
    word_count: actualWordCount,
    retry_prompt,
    validated_at: new Date().toISOString(),
  };
}

// ─── Individual check functions ───────────────────────────────────────────────

function checkSenderIdentity(
  email: GeneratedEmail,
  voice_profile: SelectiveVoiceProfile
): EmailValidationViolation[] {
  const violations: EmailValidationViolation[] = [];
  const expected = voice_profile.sender_identity;

  if (!expected) return violations;

  if (email.sender_full_name.trim() !== expected.sender_full_name.trim()) {
    violations.push(violation(
      "sender_full_name_mismatch",
      `Sender full name "${email.sender_full_name}" does not match the required sender "${expected.sender_full_name}". Use exactly "${expected.sender_full_name}".`,
      "hard"
    ));
  }

  if (email.sender_title.trim() !== expected.sender_title.trim()) {
    violations.push(violation(
      "sender_title_mismatch",
      `Sender title "${email.sender_title}" does not match the required title "${expected.sender_title}". Use exactly "${expected.sender_title}".`,
      "hard"
    ));
  }

  if (email.sender_sign_off.trim() !== expected.sender_sign_off_name.trim()) {
    violations.push(violation(
      "sender_sign_off_mismatch",
      `Sign-off name "${email.sender_sign_off}" does not match the required sign-off "${expected.sender_sign_off_name}". Use exactly "${expected.sender_sign_off_name}".`,
      "hard"
    ));
  }

  // Block obviously fake personas (AI-sounding bot names)
  const fakePersonaPattern = /\b(AI|bot|assistant|automated|system|copilot)\b/i;
  if (fakePersonaPattern.test(email.sender_full_name)) {
    violations.push(violation(
      "fake_sender_persona",
      `Sender name "${email.sender_full_name}" appears to be a fabricated AI persona. Every email must be sent from a real, named person.`,
      "hard"
    ));
  }

  return violations;
}

function checkSignatureLine(
  email: GeneratedEmail,
  expected: ResolvedSignatureLine
): EmailValidationViolation[] {
  const violations: EmailValidationViolation[] = [];

  if (!email.signature_line.trim()) {
    violations.push(violation(
      "signature_line_present",
      "Email is missing the Company Signature Line. Include the signature line exactly as directed between the email body and the sign-off.",
      "hard"
    ));
    return violations;
  }

  // Normalize whitespace for comparison (don't fail on trailing space differences)
  const normalize = (s: string) => s.trim().replace(/\s+/g, " ");
  if (normalize(email.signature_line) !== normalize(expected.text)) {
    violations.push(violation(
      "signature_line_mismatch",
      `Signature line does not match the required text. Use exactly: "${expected.text}"`,
      "hard"
    ));
  }

  return violations;
}

function checkForbiddenPhrases(
  body: string,
  voice_profile: SelectiveVoiceProfile
): EmailValidationViolation[] {
  const violations: EmailValidationViolation[] = [];
  const forbidden = voice_profile.brand_voice?.phrases_to_avoid ?? [];
  const lowerBody = body.toLowerCase();

  for (const phrase of forbidden) {
    if (lowerBody.includes(phrase.toLowerCase())) {
      violations.push(violation(
        `forbidden_phrase:${slugify(phrase)}`,
        `Email contains the forbidden phrase "${phrase}". Remove it entirely and rephrase that sentence.`,
        "soft"
      ));
    }
  }

  return violations;
}

function checkGlobalBannedPhrases(body: string): EmailValidationViolation[] {
  const violations: EmailValidationViolation[] = [];
  const lowerBody = body.toLowerCase();

  const GLOBAL_BANNED: Array<{ phrase: string; rule_id: string; guidance: string }> = [
    {
      phrase: "just",
      rule_id: "no_phrase_just",
      guidance: 'Remove the word "just" (e.g. "just wanted to", "just checking in"). Rewrite the sentence without it.',
    },
    {
      phrase: "touch base",
      rule_id: "no_phrase_touch_base",
      guidance: 'Remove "touch base". Use a direct, specific statement instead.',
    },
    {
      phrase: "circle back",
      rule_id: "no_phrase_circle_back",
      guidance: 'Remove "circle back". Use a direct, specific statement instead.',
    },
    {
      phrase: "reach out",
      rule_id: "no_phrase_reach_out",
      guidance: 'Remove "reach out". Open with a direct, specific observation instead.',
    },
    {
      phrase: "hope this finds you",
      rule_id: "no_ai_opener",
      guidance: 'Remove this AI-sounding opener. Start with something specific about the building.',
    },
    {
      phrase: "i hope this email",
      rule_id: "no_ai_opener",
      guidance: 'Remove this AI-sounding opener. Start with something specific about the building.',
    },
  ];

  for (const entry of GLOBAL_BANNED) {
    if (lowerBody.includes(entry.phrase)) {
      violations.push(violation(entry.rule_id, entry.guidance, "soft"));
    }
  }

  return violations;
}

function checkCtaSpecificRules(
  email: GeneratedEmail,
  ctx: EmailValidationContext
): EmailValidationViolation[] {
  const violations: EmailValidationViolation[] = [];

  switch (ctx.cta.name) {
    case "reply_with_number": {
      // CTA #6 must contain a clear numbered question/choice
      if (!containsNumberedChoice(email.body)) {
        violations.push(violation(
          "cta_reply_with_number_missing_choice",
          "CTA #6 (Reply-With-a-Number) requires a numbered list or choice the recipient can reply with (e.g. \"Reply 1, 2, or 3\"). The email body does not contain a numbered choice.",
          "hard"
        ));
      }
      break;
    }

    case "weather_trigger": {
      // CTA #8 must reference weather, season, or storm — if somehow selected
      if (!referencesWeather(email.body)) {
        violations.push(violation(
          "cta_weather_trigger_missing_reference",
          "CTA #8 (Weather Trigger) must reference weather, storm damage, or seasonal maintenance. The email body does not contain a weather-related reference.",
          "hard"
        ));
      }
      break;
    }

    case "proximity": {
      // CTA #9 should reference a nearby location, neighborhood, or recent work in the area
      if (!referencesProximity(email.body, ctx.property)) {
        violations.push(violation(
          "cta_proximity_missing_reference",
          "CTA #9 (Proximity) should reference nearby work, a specific local area, or a neighborhood location. Ensure the email references proximity to the target building.",
          "soft"
        ));
      }
      break;
    }

    case "free_assessment":
    case "video_offer":
    case "resource_checklist":
    case "case_study_offer": {
      // These CTAs offer something — confirm there is an offer/action in the body
      if (!containsOffer(email.body)) {
        violations.push(violation(
          "cta_offer_missing",
          `CTA #${ctx.cta.cta_number} (${ctx.cta.display_name}) must contain a clear offer or call to action. The email body does not clearly offer anything.`,
          "soft"
        ));
      }
      break;
    }
  }

  return violations;
}

// ─── Pattern helpers ──────────────────────────────────────────────────────────

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function referencesBuilding(body: string, property: PropertyContext): boolean {
  const lowerBody = body.toLowerCase();

  // Check for street address components
  const addressParts = property.property_address
    .toLowerCase()
    .split(/[\s,]+/)
    .filter((p) => p.length > 2); // skip short tokens like "N", "St"

  const hasAddress = addressParts.some((part) => lowerBody.includes(part));

  // Check for property-specific details
  const hasDetails =
    (property.year_built !== null && lowerBody.includes(property.year_built.toString())) ||
    (property.square_feet !== null &&
      (lowerBody.includes(property.square_feet.toLocaleString().toLowerCase()) ||
        lowerBody.includes(property.square_feet.toString()))) ||
    (property.land_use !== "" && lowerBody.includes(property.land_use.toLowerCase()));

  return hasAddress || hasDetails;
}

function containsUrl(text: string): boolean {
  return /https?:\/\/|www\.|\.com\b|\.org\b|\.net\b/i.test(text);
}

function hasAiOpener(body: string): boolean {
  const first100 = body.slice(0, 200).toLowerCase();
  const AI_OPENERS = [
    "i hope this email finds you",
    "i hope this message finds you",
    "i hope you are doing well",
    "i hope you're doing well",
    "i wanted to reach out",
    "i am reaching out",
    "i'm reaching out",
    "i wanted to follow up",
  ];
  return AI_OPENERS.some((opener) => first100.includes(opener));
}

function containsNumberedChoice(body: string): boolean {
  // Accepts "1." "1)" "Reply 1" "Option 1:" patterns
  return /\b(?:reply|option|choice)?\s*[1-9][.):\s]|^[1-9][.)]/im.test(body);
}

function referencesWeather(body: string): boolean {
  const weatherTerms = [
    "storm", "hail", "wind", "hurricane", "rain", "leak", "flood",
    "weather", "seasonal", "winter", "summer", "freeze",
  ];
  const lowerBody = body.toLowerCase();
  return weatherTerms.some((term) => lowerBody.includes(term));
}

function referencesProximity(body: string, property: PropertyContext): boolean {
  const lowerBody = body.toLowerCase();
  const proximityTerms = ["nearby", "next door", "down the street", "in the area", "neighborhood",
    "recently completed", "just finished", "local", "around the corner", "same block"];
  const cityMatch = property.city !== "" && lowerBody.includes(property.city.toLowerCase());
  return cityMatch || proximityTerms.some((term) => lowerBody.includes(term));
}

function containsOffer(body: string): boolean {
  const offerTerms = [
    "free", "no cost", "complimentary", "assessment", "inspection",
    "report", "checklist", "video", "case study", "example", "offer",
    "would you like", "let me know", "interested",
  ];
  const lowerBody = body.toLowerCase();
  return offerTerms.some((term) => lowerBody.includes(term));
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function violation(
  rule_id: string,
  description: string,
  severity: ValidationSeverity
): EmailValidationViolation {
  return { rule_id, description, severity };
}

function slugify(phrase: string): string {
  return phrase.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}
