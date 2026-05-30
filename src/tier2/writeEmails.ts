/**
 * src/tier2/writeEmails.ts
 *
 * Production-safe Tier 2 draft writer.
 *
 * By default this reads eligible contacts, generates + validates emails, and
 * writes local draft artifacts under tmp/. It does not update Google Sheets or
 * push to Instantly unless explicitly enabled by env flags.
 *
 * Optional targeting/testing env:
 *   TIER2_CTA_NUMBER=5                 force one CTA for selected row(s)
 *   TIER2_CTA_NUMBERS=2,5,8,9,10       force multiple CTAs for selected row(s)
 *   TIER2_STORM_WITHIN_50MI_30DAYS=true lets CTA #8 pass its weather condition
 *   TIER2_HAS_NEARBY_JOB=true          marks CTA #9 as having nearby-job context
 */

import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { readAllRows, isEligible } from "./sheets/readSheet.js";
import { writeContactUpdate } from "./sheets/writeSheet.js";
import { loadCtaPlaybook, loadVoiceProfile } from "./loaders/loadJson.js";
import { runSingleContact } from "./runSingleContact.js";
import { pushToInstantly } from "./instantly/pushToInstantly.js";
import { nextCtaNumber } from "./types/index.js";
import type { CtaConditionData } from "./promptBuilder/index.js";
import type {
  CampaignConfig,
  CtaName,
  CtaNumber,
  GeneratedEmail,
  SignatureBlurbType,
  Tier2ContactRow,
} from "./types/index.js";
import type { ClaudeCallOptions } from "./claude/callClaude.js";

type DeliveryStatus = "drafted" | "validation_failed" | "skipped" | "pushed" | "push_failed";

interface DraftRecord {
  status: DeliveryStatus;
  contact_email: string;
  contact_name: string;
  property_id: string;
  property_address: string;
  cta_number?: CtaNumber;
  cta_name?: CtaName;
  signature_blurb_type?: SignatureBlurbType;
  attempts?: number;
  validation_passed?: boolean;
  validation_violations?: Array<{ rule_id: string; severity: string; description: string }>;
  email?: GeneratedEmail;
  skip_reason?: string;
  instantly_lead_id?: string;
  error?: string;
}

interface RuntimeConfig {
  sheet: {
    credentialsPath: string;
    spreadsheetId: string;
    tabName: string;
  };
  playbookPath: string;
  voiceProfilePath: string;
  campaignConfigPath: string;
  claude: ClaudeCallOptions;
  maxEmails: number;
  outputPath: string;
  pushToInstantly: boolean;
  writeback: boolean;
  instantlyApiKey: string | null;
  contactEmail: string | null;
  propertyId: string | null;
  sheetRowNumber: number | null;
  ctaNumber: CtaNumber | null;
  ctaNumbers: CtaNumber[] | null;
  ctaConditionData: CtaConditionData;
}

const PLACEHOLDER_PATTERNS = [/^your_/i, /^replace_with/i, /^c:\\\\path\\\\to\\\\/i];

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PATTERNS.some((pattern) => pattern.test(value)) ||
    value.toLowerCase().includes("placeholder");
}

function env(name: string, fallbackName?: string): string | undefined {
  const primary = process.env[name]?.trim();
  if (primary && !isPlaceholder(primary)) return primary;

  const fallback = fallbackName ? process.env[fallbackName]?.trim() : undefined;
  if (fallback && !isPlaceholder(fallback)) return fallback;

  return primary || fallback;
}

function requireRealEnv(name: string, fallbackName?: string): string {
  const value = env(name, fallbackName);
  if (!value || isPlaceholder(value)) {
    const fallbackText = fallbackName ? ` or ${fallbackName}` : "";
    throw new Error(`[writeEmails] Set ${name}${fallbackText} before running Tier 2.`);
  }
  return value;
}

function boolEnv(name: string, defaultValue = false): boolean {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  return ["1", "true", "yes", "y"].includes(raw.toLowerCase());
}

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

async function loadCampaignConfig(filePath: string): Promise<CampaignConfig> {
  const raw = await fs.readFile(path.resolve(filePath), "utf-8");
  return JSON.parse(raw) as CampaignConfig;
}

function defaultOutputPath(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join("tmp", `tier2-drafts-${stamp}.json`);
}

function loadRuntimeConfig(): RuntimeConfig {
  const pushToInstantlyFlag = boolEnv("TIER2_PUSH_TO_INSTANTLY", false);
  const instantlyApiKey = process.env["INSTANTLY_API_KEY"] || null;

  if (pushToInstantlyFlag && !instantlyApiKey) {
    throw new Error("[writeEmails] TIER2_PUSH_TO_INSTANTLY=true requires INSTANTLY_API_KEY.");
  }

  return {
    sheet: {
      credentialsPath: requireRealEnv("TIER2_CREDENTIALS_PATH", "GOOGLE_SHEETS_CREDENTIALS_PATH"),
      spreadsheetId: requireRealEnv("TIER2_SPREADSHEET_ID", "GOOGLE_SHEETS_SPREADSHEET_ID"),
      tabName: env("TIER2_SHEET_TAB", "GOOGLE_SHEETS_TAB_NAME") || "Leads",
    },
    playbookPath: requireRealEnv("TIER2_CTA_PLAYBOOK_PATH"),
    voiceProfilePath: requireRealEnv("TIER2_VOICE_PROFILE_PATH"),
    campaignConfigPath: requireRealEnv("TIER2_CAMPAIGN_CONFIG_PATH"),
    claude: {
      apiKey: requireRealEnv("ANTHROPIC_API_KEY"),
      model: process.env["CLAUDE_MODEL"] || "claude-haiku-4-5-20251001",
    },
    maxEmails: intEnv("TIER2_MAX_EMAILS", 5),
    outputPath: process.env["TIER2_DRAFT_OUTPUT_PATH"] || defaultOutputPath(),
    pushToInstantly: pushToInstantlyFlag,
    writeback: boolEnv("TIER2_WRITEBACK", false),
    instantlyApiKey,
    contactEmail: process.env["TIER2_CONTACT_EMAIL"]?.trim() || null,
    propertyId: process.env["TIER2_PROPERTY_ID"]?.trim() || null,
    sheetRowNumber: optionalIntEnv("TIER2_SHEET_ROW_NUMBER"),
    ctaNumber: optionalCtaNumberEnv("TIER2_CTA_NUMBER"),
    ctaNumbers: optionalCtaNumbersEnv("TIER2_CTA_NUMBERS"),
    ctaConditionData: {
      storm_within_50mi_30days: optionalBoolEnv("TIER2_STORM_WITHIN_50MI_30DAYS"),
      has_nearby_job: optionalBoolEnv("TIER2_HAS_NEARBY_JOB"),
    },
  };
}

function optionalIntEnv(name: string): number | null {
  const raw = process.env[name];
  if (!raw) return null;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function optionalCtaNumberEnv(name: string): CtaNumber | null {
  const value = optionalIntEnv(name);
  if (value === null) return null;
  return value >= 1 && value <= 10 ? (value as CtaNumber) : null;
}

function optionalCtaNumbersEnv(name: string): CtaNumber[] | null {
  const raw = process.env[name];
  if (!raw) return null;

  const values = raw
    .split(",")
    .map((part) => parseInt(part.trim(), 10))
    .filter((value): value is CtaNumber =>
      Number.isFinite(value) && value >= 1 && value <= 10
    );

  return values.length > 0 ? values : null;
}

function optionalBoolEnv(name: string): boolean | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  if (["1", "true", "yes", "y"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "n"].includes(raw.toLowerCase())) return false;
  return undefined;
}

function selectRows(rows: Tier2ContactRow[], config: RuntimeConfig): Tier2ContactRow[] {
  if (config.contactEmail) {
    return rows.filter(
      (row) => row.contact_email.toLowerCase() === config.contactEmail?.toLowerCase()
    );
  }

  if (config.propertyId) {
    return rows.filter((row) => row.property_id === config.propertyId);
  }

  if (config.sheetRowNumber) {
    const dataIndex = config.sheetRowNumber - 2;
    return dataIndex >= 0 && dataIndex < rows.length ? [rows[dataIndex]] : [];
  }

  return rows.filter(isEligible).slice(0, config.maxEmails);
}

function describeSelector(config: RuntimeConfig): string {
  if (config.contactEmail) return `contact_email=${config.contactEmail}`;
  if (config.propertyId) return `property_id=${config.propertyId}`;
  if (config.sheetRowNumber) return `sheet row ${config.sheetRowNumber}`;
  return `first ${config.maxEmails} eligible row(s)`;
}

function buildSheetUpdates(
  row: Tier2ContactRow,
  record: DraftRecord,
  generatedAt: string,
  cadenceDays: number
) {
  if (!record.email || !record.cta_number || !record.cta_name) return null;

  const lastFive = [
    record.signature_blurb_type,
    ...row.last_5_signature_blurb_types,
  ].filter(Boolean);

  return {
    last_cta_number: record.cta_number,
    last_cta_type: record.cta_name,
    last_email_date: generatedAt.slice(0, 10),
    last_email_subject: record.email.subject,
    next_cta_number: nextCtaNumber(record.cta_number),
    next_email_date: addDays(generatedAt, cadenceDays),
    total_emails_sent: row.total_emails_sent + 1,
    reply_status: "pending" as const,
    skip_reason: null,
    last_signature_blurb_type: record.signature_blurb_type ?? row.last_signature_blurb_type,
    last_5_signature_blurb_types: lastFive.slice(0, 5) as SignatureBlurbType[],
  };
}

function addDays(isoDate: string, days: number): string {
  const date = new Date(isoDate);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function printEmail(record: DraftRecord): void {
  if (!record.email) return;
  console.log(`\nSubject: ${record.email.subject}`);
  console.log(record.email.body);
  console.log("");
  console.log(record.email.signature_line);
  console.log("");
  console.log(`${record.email.sender_sign_off},`);
  console.log(record.email.sender_full_name);
  console.log(record.email.sender_title);
}

async function main(): Promise<void> {
  const config = loadRuntimeConfig();
  const generatedAt = new Date().toISOString();

  console.log("[writeEmails] Loading Tier 2 inputs...");
  const [playbook, voiceProfile, campaignConfig] = await Promise.all([
    loadCtaPlaybook(config.playbookPath),
    loadVoiceProfile(config.voiceProfilePath),
    loadCampaignConfig(config.campaignConfigPath),
  ]);

  console.log("[writeEmails] Reading eligible rows from Google Sheets...");
  const allRows = await readAllRows(config.sheet);
  const rows = selectRows(allRows, config);
  console.log(`[writeEmails] Selector: ${describeSelector(config)}`);
  console.log(`[writeEmails] Found ${rows.length} row(s).`);

  const records: DraftRecord[] = [];
  const requestedCtaNumbers: Array<CtaNumber | null> =
    config.ctaNumbers ?? (config.ctaNumber ? [config.ctaNumber] : [null]);

  for (const row of rows) {
    for (const requestedCtaNumber of requestedCtaNumbers) {
      const ctaLabel = requestedCtaNumber ? ` CTA #${requestedCtaNumber}` : "";
      console.log(`[writeEmails] Generating${ctaLabel} for ${row.contact_email} at ${row.property_address}...`);

      try {
        const rowForGeneration: Tier2ContactRow = requestedCtaNumber
          ? { ...row, next_cta_number: requestedCtaNumber }
          : row;

        const outcome = await runSingleContact(
          rowForGeneration,
          playbook,
          voiceProfile,
          campaignConfig,
          config.claude,
          config.ctaConditionData
        );

        if ("skipped" in outcome) {
          records.push({
            status: "skipped",
            contact_email: row.contact_email,
            contact_name: row.contact_name,
            property_id: row.property_id,
            property_address: row.property_address,
            skip_reason: outcome.reason,
          });
          continue;
        }

        const record: DraftRecord = {
          status: outcome.passed ? "drafted" : "validation_failed",
          contact_email: row.contact_email,
          contact_name: row.contact_name,
          property_id: row.property_id,
          property_address: row.property_address,
          cta_number: outcome.resolvedCta.cta_number,
          cta_name: outcome.resolvedCta.name,
          signature_blurb_type: outcome.signature_blurb_type,
          attempts: outcome.attemptCount,
          validation_passed: outcome.passed,
          validation_violations: outcome.validation.violations,
          email: outcome.email,
        };

        if (outcome.passed && config.pushToInstantly && config.instantlyApiKey) {
          const pushed = await pushToInstantly(row, outcome.email, campaignConfig, {
            apiKey: config.instantlyApiKey,
          });
          record.status = pushed.success ? "pushed" : "push_failed";
          record.instantly_lead_id = pushed.lead_id;
          record.error = pushed.error;
        }

        if (config.writeback && record.status === "pushed") {
          const cadenceDays = intEnv("TIER2_CADENCE_DAYS", campaignConfig.cadence_days_default);
          const updates = buildSheetUpdates(row, record, generatedAt, cadenceDays);
          if (updates) {
            await writeContactUpdate(config.sheet, row.contact_email, updates);
          }
        }

        records.push(record);
        printEmail(record);
      } catch (err) {
        records.push({
          status: "validation_failed",
          contact_email: row.contact_email,
          contact_name: row.contact_name,
          property_id: row.property_id,
          property_address: row.property_address,
          cta_number: requestedCtaNumber ?? undefined,
          error: (err as Error).message,
        });
      }
    }
  }

  await fs.mkdir(path.dirname(config.outputPath), { recursive: true });
  await fs.writeFile(config.outputPath, JSON.stringify({ generated_at: generatedAt, records }, null, 2));

  const passed = records.filter((record) => record.status === "drafted" || record.status === "pushed").length;
  const failed = records.length - passed;
  console.log(`\n[writeEmails] Saved ${records.length} draft record(s) to ${config.outputPath}`);
  console.log(`[writeEmails] Passed: ${passed}; failed/skipped: ${failed}`);

  if (config.writeback && !config.pushToInstantly) {
    console.log("[writeEmails] TIER2_WRITEBACK was ignored because drafts were not pushed to Instantly.");
  }
}

main().catch((err) => {
  console.error("[writeEmails] Fatal error:", err);
  process.exit(1);
});
