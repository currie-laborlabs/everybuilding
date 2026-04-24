/**
 * Tier 2 prompt builder — public exports
 *
 * Import from here rather than individual files:
 *   import { buildPrompt, preparePromptInput, evaluateCta } from "../promptBuilder";
 */

export { buildPrompt } from "./buildPrompt";
export { preparePromptInput } from "./preparePromptInput";
export { evaluateCta } from "./evaluateCta";
export type { CtaEvaluationResult, CtaConditionData } from "./evaluateCta";
export { selectVoiceProfileSections, resolvedSections } from "./selectVoiceProfile";
export { resolveSignatureLine } from "./selectSignatureLine";
