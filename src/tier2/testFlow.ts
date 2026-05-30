/**
 * src/tier2/testFlow.ts
 *
 * Minimal Tier 2 test flow — one contact, end-to-end.
 *
 * Usage:
 *   tsx src/tier2/testFlow.ts
 *
 * Required environment variables (copy .env.example → .env):
 *   ANTHROPIC_API_KEY         Anthropic API key
 *   TIER2_CREDENTIALS_PATH    Path to service-account JSON for Google Sheets
 *   TIER2_SPREADSHEET_ID      Google Sheets spreadsheet ID
 *   TIER2_SHEET_TAB           Sheet tab name (e.g. "Leads")
 *   TIER2_CTA_PLAYBOOK_PATH   Local path to CTA_Playbook.json
 *   TIER2_VOICE_PROFILE_PATH  Local path to Client_Voice_Profile.json
 *   TIER2_CAMPAIGN_CONFIG_PATH Local path to Campaign_Config.json
 *
 * Optional:
 *   CLAUDE_MODEL              Override Claude model (default: claude-haiku-4-5-20251001)
 *
 * Acceptance criteria:
 *   ✓ Script runs to completion without crashing (exit 0)
 *   ✓ Prints formatted email or clear validation-failure report
 *   ✓ All TypeScript types satisfied (tsc --noEmit passes)
 *   ✓ No uncaught promise rejections
 */

import "dotenv/config";
import { readEligibleRow } from "./sheets/readSheet.js";
import { loadCtaPlaybook, loadVoiceProfile } from "./loaders/loadJson.js";
import { runSingleContact } from "./runSingleContact.js";
import type { CampaignConfig } from "./types/index.js";
import type { ClaudeCallOptions } from "./claude/callClaude.js";

// ─── env helpers ─────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[testFlow] Missing required env var: ${name}`);
    process.exit(1);
  }
  return value;
}

// ─── print helpers ────────────────────────────────────────────────────────────

const HR = "─".repeat(72);

function printHeader(title: string) {
  console.log(`\n${HR}`);
  console.log(`  ${title}`);
  console.log(HR);
}

function printEmail(email: {
  subject: string;
  body: string;
  signature_line: string;
  sender_sign_off: string;
  sender_full_name: string;
  sender_title: string;
}) {
  console.log(`\nSubject : ${email.subject}`);
  console.log(`\n${email.body}`);
  console.log(`\n${email.sender_sign_off},`);
  console.log(`${email.sender_full_name}`);
  console.log(`${email.sender_title}`);
  if (email.signature_line) console.log(`${email.signature_line}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  printHeader("EveryBuilding — Tier 2 Test Flow");

  // ── Load config from environment ─────────────────────────────────────────
  const sheetConfig = {
    credentialsPath: requireEnv("TIER2_CREDENTIALS_PATH"),
    spreadsheetId: requireEnv("TIER2_SPREADSHEET_ID"),
    tabName: requireEnv("TIER2_SHEET_TAB"),
  };

  const playbookPath = requireEnv("TIER2_CTA_PLAYBOOK_PATH");
  const voiceProfilePath = requireEnv("TIER2_VOICE_PROFILE_PATH");
  const campaignConfigPath = requireEnv("TIER2_CAMPAIGN_CONFIG_PATH");
  const apiKey = requireEnv("ANTHROPIC_API_KEY");

  const claudeOptions: ClaudeCallOptions = {
    apiKey,
    model: process.env["CLAUDE_MODEL"] ?? "claude-haiku-4-5-20251001",
  };

  // ── Load JSON files ────────────────────────────────────────────────────────
  console.log("\n[1/4] Loading CTA Playbook and Voice Profile...");
  const [playbook, voiceProfile, campaignConfig] = await Promise.all([
    loadCtaPlaybook(playbookPath),
    loadVoiceProfile(voiceProfilePath),
    import("fs/promises").then((fs) =>
      fs.readFile(campaignConfigPath, "utf-8").then((raw) => JSON.parse(raw) as CampaignConfig)
    ),
  ]);
  console.log(
    `    CTA Playbook v${playbook.version} loaded (${Object.keys(playbook.ctas).length} CTAs)`
  );
  console.log(`    Voice Profile: ${voiceProfile.company_basics?.company_name ?? voiceProfile.client_id}`);
  console.log(`    Campaign: ${campaignConfig.client_name}`);

  // ── Read eligible contact from Google Sheets ──────────────────────────────
  console.log("\n[2/4] Reading eligible contact from Google Sheets...");
  const row = await readEligibleRow(sheetConfig);

  if (!row) {
    console.log("\n  No eligible contacts found in the sheet.");
    console.log("  Eligibility criteria:");
    console.log("    • reply_status === 'pending'");
    console.log("    • skip_reason is null");
    console.log("    • contact_email is non-empty");
    console.log("    • next_email_date is null OR on/before today");
    process.exit(0);
  }

  console.log(`    Found: ${row.contact_name || "(no name)"} <${row.contact_email}>`);
  console.log(`    Property: ${row.property_address}, ${row.city}, ${row.state}`);
  console.log(`    Next CTA: #${row.next_cta_number}`);

  // ── Run single-contact flow ───────────────────────────────────────────────
  console.log("\n[3/4] Running generation + validation...");

  const outcome = await runSingleContact(
    row,
    playbook,
    voiceProfile,
    campaignConfig,
    claudeOptions
  );

  // ── Print results ─────────────────────────────────────────────────────────
  console.log("\n[4/4] Results");

  if ("skipped" in outcome) {
    printHeader("SKIPPED");
    console.log(`Reason: ${outcome.reason}`);
    process.exit(0);
  }

  const { email, validation, resolvedCta, attemptCount, passed } = outcome;

  console.log(`    CTA used : #${resolvedCta.cta_number} — ${resolvedCta.display_name}`);
  console.log(`    Attempts : ${attemptCount}`);
  console.log(`    Word count: ${validation.word_count}`);
  console.log(`    Passed   : ${passed ? "YES ✓" : "NO ✗"}`);

  if (validation.violations.length > 0) {
    console.log("\n  Violations:");
    for (const v of validation.violations) {
      const tag = v.severity === "hard" ? "[HARD]" : "[soft]";
      console.log(`    ${tag} ${v.rule_id}: ${v.description}`);
    }
  }

  if (passed) {
    printHeader("Generated Email");
    printEmail(email);
  } else {
    printHeader("FAILED — Final email (did not pass validation)");
    printEmail(email);

    if (validation.retry_prompt) {
      printHeader("Corrective Prompt (for debugging)");
      console.log(validation.retry_prompt);
    }
  }

  console.log(`\n${HR}\n`);
  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[testFlow] Fatal error:", err);
  process.exit(1);
});
