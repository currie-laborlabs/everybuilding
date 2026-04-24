/**
 * src/tier2/runSingleContact.ts
 *
 * Core test-flow logic for a single Tier 2 contact.
 *
 * This module is intentionally decoupled from I/O so that:
 *   - The test entrypoint (testFlow.ts) wires env vars and config.
 *   - The future batch pipeline calls the same function in a loop.
 *
 * Steps:
 *   1. Resolve next eligible CTA (advancing through skipped CTAs up to 10 hops).
 *   2. Prepare prompt input from the contact row, CTA, and voice profile.
 *   3. Call Claude — up to MAX_RETRIES attempts if validation fails.
 *   4. Validate each attempt; on hard-violation retry with a corrective prompt.
 *   5. Return a structured result (pass/fail + all artifacts).
 */

import type { Tier2ContactRow } from "./types/index.js";
import type { CtaPlaybook } from "./types/index.js";
import type { ClientVoiceProfile } from "./types/index.js";
import type { CampaignConfig } from "./types/index.js";
import type { GeneratedEmail, EmailValidationResult } from "./types/index.js";
import type { CtaEntry } from "./types/index.js";
import type { SignatureBlurbType } from "./types/index.js";

import { nextCtaNumber } from "./types/index.js";
import { evaluateCta } from "./promptBuilder/index.js";
import { buildPrompt, preparePromptInput } from "./promptBuilder/index.js";
import { validateEmail } from "./validator/validateEmail.js";
import { buildRetryPrompt } from "./validator/buildRetryPrompt.js";
import { callClaude } from "./claude/callClaude.js";
import type { ClaudeCallOptions } from "./claude/callClaude.js";
import type { EmailValidationContext } from "./validator/validateEmail.js";

/** Maximum number of Claude generation attempts per contact. */
const MAX_RETRIES = 2;

/** Maximum CTA hops allowed before giving up on a contact. */
const MAX_CTA_HOPS = 10;

// ─── types ───────────────────────────────────────────────────────────────────

export interface SingleContactResult {
  /** The contact row that was processed */
  row: Tier2ContactRow;
  /** The CTA that was ultimately used (after skipping ineligible CTAs) */
  resolvedCta: CtaEntry;
  /** The generated email (from the last attempt that either passed or was the final retry) */
  email: GeneratedEmail;
  /** Validation result for the final email */
  validation: EmailValidationResult;
  /** Number of Claude attempts made (1 = first try passed) */
  attemptCount: number;
  /** Whether final output passed validation */
  passed: boolean;
  /** The signature blurb type used — needed for sheet write-back rotation tracking */
  signature_blurb_type: SignatureBlurbType;
}

export interface SingleContactSkipped {
  skipped: true;
  reason: string;
  row: Tier2ContactRow;
}

export type SingleContactOutcome = SingleContactResult | SingleContactSkipped;

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk the CTA rotation starting at `startCtaNumber`, skipping ineligible CTAs,
 * up to MAX_CTA_HOPS. Returns the first eligible CtaEntry, or null if all skip.
 */
function resolveEligibleCta(
  startCtaNumber: number,
  playbook: CtaPlaybook
): CtaEntry | null {
  let ctaNum = startCtaNumber as keyof typeof playbook.ctas;
  let hops = 0;

  while (hops < MAX_CTA_HOPS) {
    const cta = playbook.ctas[ctaNum];
    if (!cta) break;

    const evaluation = evaluateCta(cta);
    if (evaluation.eligible) return cta;

    // Advance to the suggested next number
    ctaNum = evaluation.advance_to as keyof typeof playbook.ctas;
    hops++;
  }

  return null;
}

// ─── main export ─────────────────────────────────────────────────────────────

/**
 * Run the full Tier 2 email-generation flow for a single contact row.
 *
 * @param row     - The eligible Tier2ContactRow to process.
 * @param playbook - Loaded CTA_Playbook JSON.
 * @param profile  - Loaded Client_Voice_Profile JSON.
 * @param campaign - Campaign configuration (cadence, Instantly IDs, etc.).
 * @param claudeOptions - API key and optional model overrides.
 * @param logger  - Optional logger; falls back to console.log.
 */
export async function runSingleContact(
  row: Tier2ContactRow,
  playbook: CtaPlaybook,
  profile: ClientVoiceProfile,
  campaign: CampaignConfig,
  claudeOptions: ClaudeCallOptions,
  logger: { info: (msg: string, meta?: object) => void; warn: (msg: string, meta?: object) => void } = console as never
): Promise<SingleContactOutcome> {
  // ── 1. Resolve eligible CTA ───────────────────────────────────────────────
  const startCtaNumber = row.next_cta_number ?? 1;
  const resolvedCta = resolveEligibleCta(startCtaNumber, playbook);

  if (!resolvedCta) {
    const reason = `All CTAs skipped starting from #${startCtaNumber} — max hops (${MAX_CTA_HOPS}) reached.`;
    logger.warn(`[runSingleContact] ${reason}`, { contact_email: row.contact_email });
    return { skipped: true, reason, row };
  }

  logger.info(`[runSingleContact] Resolved CTA #${resolvedCta.cta_number}: ${resolvedCta.name}`, {
    contact_email: row.contact_email,
    property_id: row.property_id,
  });

  // ── 2. Prepare prompt input ───────────────────────────────────────────────
  const promptInput = preparePromptInput(row, resolvedCta, profile, campaign);
  const { system_prompt, user_prompt, role_angle, voice_sections_used, signature_blurb_type } =
    buildPrompt(promptInput);

  logger.info(`[runSingleContact] Prompt built`, {
    role_angle,
    voice_sections_used,
    signature_blurb_type,
  });

  // ── 3. Build validation context (used across retries) ────────────────────
  const validationCtx: EmailValidationContext = {
    property: promptInput.property,
    cta: resolvedCta,
    voice_profile: profile,
    expected_signature_line: promptInput.signature_line,
  };

  // ── 4. Attempt generation with up to MAX_RETRIES ─────────────────────────
  let email!: GeneratedEmail;
  let validation!: EmailValidationResult;
  let attemptCount = 0;
  let currentUserPrompt = user_prompt;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    attemptCount = attempt;

    logger.info(`[runSingleContact] Calling Claude (attempt ${attempt}/${MAX_RETRIES})`, {
      model: claudeOptions.model ?? "claude-haiku-4-5",
    });

    email = await callClaude(system_prompt, currentUserPrompt, claudeOptions);

    validation = validateEmail(email, validationCtx);

    if (validation.passed) {
      logger.info(`[runSingleContact] Validation passed on attempt ${attempt}.`);
      break;
    }

    const hard = validation.violations.filter((v) => v.severity === "hard");
    const soft = validation.violations.filter((v) => v.severity === "soft");

    logger.warn(`[runSingleContact] Validation failed (attempt ${attempt})`, {
      hard_violations: hard.length,
      soft_violations: soft.length,
    });

    if (attempt < MAX_RETRIES) {
      // Build corrective prompt for next attempt
      currentUserPrompt = buildRetryPrompt(hard, soft, validation.word_count, validationCtx);
      logger.info(`[runSingleContact] Retrying with corrective prompt.`);
    }
  }

  // ── 5. Return result ──────────────────────────────────────────────────────
  return {
    row,
    resolvedCta,
    email,
    validation,
    attemptCount,
    passed: validation.passed,
    signature_blurb_type,
  };
}
