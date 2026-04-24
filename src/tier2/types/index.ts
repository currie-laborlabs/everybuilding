/**
 * Tier 2 public type exports — EveryBuilding
 *
 * Import from here rather than individual files:
 *   import type { CtaPlaybook, Tier2ContactRow, ... } from "../tier2/types";
 */

export type {
  CtaNumber,
  CtaName,
  CtaCondition,
  CtaExample,
  CtaEntry,
  CtaPlaybook,
  ContactRoleAngle,
} from "./cta";
export { nextCtaNumber } from "./cta";

export type {
  VoiceProfileSection,
  CompanyBasics,
  Usp,
  SignatureProject,
  BrandVoice,
  CustomerPraiseTheme,
  MarketPositioning,
  TargetingPreferences,
  AssetsAvailable,
  SenderIdentity,
  SignatureLineData,
  ClientVoiceProfile,
  SelectiveVoiceProfile,
} from "./voice-profile";

export type {
  ReplyStatus,
  SkipReason,
  SignatureBlurbType,
  Tier2OutreachFields,
  Tier2ContactRow,
} from "./lead-row";
export { TIER2_DEFAULTS, TIER2_SHEET_COLUMNS } from "./lead-row";

export type {
  PropertyContext,
  ContactContext,
  SignatureLineContext,
  ResolvedSignatureLine,
  PromptBuilderInput,
  PromptBuilderOutput,
} from "./prompt";
export { deriveRoleAngle } from "./prompt";

export type {
  GeneratedEmail,
  ValidationSeverity,
  EmailValidationRule,
  EmailValidationViolation,
  EmailValidationResult,
  ValidationRetryContext,
} from "./validation";
export { STANDARD_VALIDATION_RULES } from "./validation";

export type { CampaignConfig } from "./campaign";
export { CAMPAIGN_CADENCE_DEFAULTS } from "./campaign";
