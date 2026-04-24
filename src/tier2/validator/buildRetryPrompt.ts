/**
 * Retry prompt builder — EveryBuilding Tier 2
 *
 * Constructs the corrective instruction appended to the user prompt on a
 * validation retry. The corrective text is targeted and specific — it tells
 * the LLM exactly which rules failed and what to fix, without asking it to
 * start from scratch.
 *
 * Design rules:
 *   - One retry max. If the retry also fails, the contact is skipped this cycle.
 *   - Only hard violations are listed as required fixes.
 *   - Soft violations are noted separately as "also avoid if possible".
 *   - The tone is directive, not apologetic — this is a machine instruction.
 */

import type { EmailValidationViolation } from "../types/validation";
import type { EmailValidationContext } from "./validateEmail";

/**
 * Builds the corrective user prompt text for a validation retry.
 *
 * @param hardViolations  Violations that MUST be fixed
 * @param softViolations  Violations to improve if possible
 * @param actualWordCount Actual word count from the failed attempt
 * @param ctx             Validation context (CTA, property, sender)
 */
export function buildRetryPrompt(
  hardViolations: EmailValidationViolation[],
  softViolations: EmailValidationViolation[],
  actualWordCount: number,
  ctx: EmailValidationContext
): string {
  const lines: string[] = [
    "## RETRY — Previous attempt did not pass validation",
    "",
    "The previous email had the following problems that MUST be fixed:",
    "",
  ];

  // ── Hard violations — required fixes ────────────────────────────────────
  hardViolations.forEach((v, i) => {
    lines.push(`${i + 1}. [REQUIRED] ${v.description}`);
  });

  // ── Soft violations — improvement suggestions ────────────────────────────
  if (softViolations.length > 0) {
    lines.push("");
    lines.push("Also fix these if possible (these do not block sending but should be resolved):");
    softViolations.forEach((v, i) => {
      lines.push(`${i + 1}. [IMPROVE] ${v.description}`);
    });
  }

  // ── Reinforced constraints ────────────────────────────────────────────────
  lines.push("");
  lines.push("Reinforced constraints for this retry:");

  lines.push(
    `- Body word limit: ${ctx.cta.word_limit} words maximum. Previous attempt was ${actualWordCount} words.`
  );
  lines.push(
    `- Building address "${ctx.property.property_address}" or a property-specific detail MUST appear in the body.`
  );
  lines.push(
    `- CTA type MUST be #${ctx.cta.cta_number} (${ctx.cta.name}). Do not switch CTA types.`
  );

  if (ctx.voice_profile.sender_identity) {
    const s = ctx.voice_profile.sender_identity;
    lines.push(
      `- Sender: full name = "${s.sender_full_name}", title = "${s.sender_title}", sign-off = "${s.sender_sign_off_name}". Use these exactly.`
    );
  }

  lines.push(
    `- Signature line MUST be exactly: "${ctx.expected_signature_line.text}"`
  );

  // ── Final instruction ─────────────────────────────────────────────────────
  lines.push("");
  lines.push("Rewrite the complete email in the same JSON format. Do not explain the changes — only output the JSON.");

  return lines.join("\n");
}
