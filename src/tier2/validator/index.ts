/**
 * Tier 2 validator — public exports
 *
 * import { validateEmail } from "../validator";
 * import type { EmailValidationContext } from "../validator";
 */

export { validateEmail } from "./validateEmail";
export type { EmailValidationContext } from "./validateEmail";
export { buildRetryPrompt } from "./buildRetryPrompt";
