/**
 * tmp/tier2-row6-mock.ts
 *
 * Runs all 5 requested CTAs (2, 5, 8, 9, 10) for sheet row 6 with mock values
 * patched in for the empty enrichment fields. Does NOT touch the sheet or
 * push to Instantly. Output goes to tmp/tier2-row6-mock-output.json.
 *
 * Run: npx tsx tmp/tier2-row6-mock.ts
 */
import "dotenv/config";
import fs from "fs/promises";
import path from "path";
import { google } from "googleapis";
import { loadCtaPlaybook, loadVoiceProfile } from "../src/tier2/loaders/loadJson.js";
import { runSingleContact } from "../src/tier2/runSingleContact.js";
import type {
  CampaignConfig,
  CtaNumber,
  Tier2ContactRow,
} from "../src/tier2/types/index.js";
import type { CtaConditionData } from "../src/tier2/promptBuilder/index.js";

// ─── Config ──────────────────────────────────────────────────────────────────

const SHEET_ROW_NUMBER = 6; // 1-indexed, includes header row
const CTA_NUMBERS: CtaNumber[] = [2, 5, 8, 9, 10];
const OUTPUT_PATH = path.join("tmp", "tier2-row6-mock-output.json");

const HR = "─".repeat(72);

// ─── Mock enrichment values for the empty fields in row 6 ───────────────────
//
// These are plausible stand-ins for the missing ATTOM / permit data.
// Replace with real data before going to production.
//
const MOCK_PATCHES: Partial<Record<string, string>> = {
  year_built: "1962",
  square_feet: "42000",
  permit_summary:
    "No recent roof permit found on record. Building is 60+ years old with no documented roof replacement or major repair activity. High-probability candidate for deferred maintenance review.",
  last_permit_date: "2018-03-14",
  hazard_notes:
    "Urban commercial property in Hudson County. Situated in a coastal-adjacent flood corridor — periodic surge and high-wind exposure in winter months.",
  climate_notes:
    "NWS severe thunderstorm advisory for Hudson County, week of May 20 2026: 60 mph wind gusts and penny-size hail reported within 30 days of outreach date.",
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function readSheetRow(rowNumber: number): Promise<Tier2ContactRow> {
  const credentialsPath = process.env.TIER2_CREDENTIALS_PATH;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.TIER2_SHEET_TAB ?? "Leads_Enriched";

  if (!credentialsPath || !spreadsheetId) {
    throw new Error("TIER2_CREDENTIALS_PATH or GOOGLE_SHEETS_SPREADSHEET_ID not set.");
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!1:${rowNumber}`,
  });

  const values = res.data.values ?? [];
  if (values.length < 2) throw new Error(`Sheet tab "${tabName}" has fewer than 2 rows.`);

  const headers = (values[0] as string[]).map((h) => h.trim());
  // rows[0] = header (sheet row 1). rows[rowNumber-1] = sheet row `rowNumber`.
  const rawRow = (values[rowNumber - 1] as string[]) ?? [];

  // Build a raw record
  const raw: Record<string, string> = {};
  headers.forEach((h, i) => {
    raw[h] = rawRow[i] ?? "";
  });

  // Apply mock patches for empty fields
  let patchedCount = 0;
  for (const [key, mockVal] of Object.entries(MOCK_PATCHES)) {
    if (!raw[key] || raw[key] === "") {
      raw[key] = mockVal;
      patchedCount++;
    }
  }
  console.log(`[mock] Applied ${patchedCount} mock patch(es) to empty fields.`);

  // Apply Tier 2 defaults for tracking fields
  const { TIER2_DEFAULTS } = await import("../src/tier2/types/index.js");
  const row: Tier2ContactRow = {
    ...(TIER2_DEFAULTS as unknown as Tier2ContactRow),
    ...(raw as unknown as Tier2ContactRow),
    // Coerce numeric Tier 2 fields
    next_cta_number: parseInt(raw["next_cta_number"] || "1", 10) as CtaNumber || 1,
    last_cta_number: raw["last_cta_number"]
      ? (parseInt(raw["last_cta_number"], 10) as CtaNumber)
      : null,
    total_emails_sent: parseInt(raw["total_emails_sent"] || "0", 10) || 0,
    // Ensure Tier 2 string fields fall back to defaults when empty
    reply_status: (raw["reply_status"] as Tier2ContactRow["reply_status"]) || "pending",
    skip_reason: (raw["skip_reason"] as Tier2ContactRow["skip_reason"]) || null,
    last_signature_blurb_type:
      (raw["last_signature_blurb_type"] as Tier2ContactRow["last_signature_blurb_type"]) || null,
    last_5_signature_blurb_types: [],
  };

  return row;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n" + HR);
  console.log("  EveryBuilding — Tier 2 Row 6 Mock Run (CTAs 2, 5, 8, 9, 10)");
  console.log(HR);

  // ── Load required config files ─────────────────────────────────────────────
  const playbookPath = process.env.TIER2_CTA_PLAYBOOK_PATH;
  const voiceProfilePath = process.env.TIER2_VOICE_PROFILE_PATH;
  const campaignConfigPath = process.env.TIER2_CAMPAIGN_CONFIG_PATH;

  if (!playbookPath || !voiceProfilePath || !campaignConfigPath) {
    throw new Error(
      "Missing one of: TIER2_CTA_PLAYBOOK_PATH, TIER2_VOICE_PROFILE_PATH, TIER2_CAMPAIGN_CONFIG_PATH"
    );
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set.");

  console.log("\n[1/3] Loading CTA Playbook, Voice Profile, Campaign Config...");
  const [playbook, voiceProfile] = await Promise.all([
    loadCtaPlaybook(playbookPath),
    loadVoiceProfile(voiceProfilePath),
  ]);
  const campaignConfig: CampaignConfig = JSON.parse(
    await fs.readFile(campaignConfigPath, "utf-8")
  );
  console.log("      Loaded OK.");

  // ── Read and patch row 6 ───────────────────────────────────────────────────
  console.log(`\n[2/3] Reading sheet row ${SHEET_ROW_NUMBER} and applying mock patches...`);
  const row = await readSheetRow(SHEET_ROW_NUMBER);
  console.log(`      Contact : ${row.contact_name} <${row.contact_email}>`);
  console.log(`      Title   : ${row.contact_title}`);
  console.log(`      Address : ${row.property_address}, ${row.city}, ${row.state} ${row.zip_code}`);
  if ((row as unknown as Record<string, string>)["verification_status"] === "invalid") {
    console.log(
      "\n  ⚠  WARNING: verification_status=invalid — this email address was flagged by ZeroBounce."
    );
    console.log("     This is a MOCK/TEST run only. Do NOT push to Instantly with this address.");
  }

  const claudeOptions = {
    apiKey,
    model: process.env.CLAUDE_MODEL ?? "claude-haiku-4-5-20251001",
  };

  const conditionData: CtaConditionData = {
    storm_within_50mi_30days: true, // enables CTA #8
    has_nearby_job: false,
  };

  // ── Generate one email per CTA ─────────────────────────────────────────────
  console.log(`\n[3/3] Generating ${CTA_NUMBERS.length} CTA emails in one pass...\n`);

  const generatedAt = new Date().toISOString();
  const records: unknown[] = [];

  for (const ctaNum of CTA_NUMBERS) {
    console.log(HR);
    console.log(`  CTA #${ctaNum}`);
    console.log(HR);

    const rowForCta: Tier2ContactRow = { ...row, next_cta_number: ctaNum };

    try {
      const outcome = await runSingleContact(
        rowForCta,
        playbook,
        voiceProfile,
        campaignConfig,
        claudeOptions,
        conditionData
      );

      if ("skipped" in outcome) {
        console.log(`  SKIPPED: ${outcome.reason}`);
        records.push({ cta_number: ctaNum, status: "skipped", reason: outcome.reason });
        continue;
      }

      const { email, validation, attemptCount, passed, resolvedCta } = outcome;
      console.log(`  Resolved CTA : #${resolvedCta.cta_number} — ${resolvedCta.display_name}`);
      console.log(`  Attempts     : ${attemptCount}`);
      console.log(`  Validation   : ${passed ? "PASS" : "FAIL"}`);
      if (!passed) {
        validation.violations.forEach((v) =>
          console.log(`    [${v.severity}] ${v.rule_id}: ${v.description}`)
        );
      }
      console.log(`\n  Subject: ${email.subject}`);
      console.log(`\n${email.body}`);
      console.log(`\n${email.signature_line}`);
      console.log(`\n${email.sender_sign_off},`);
      console.log(`${email.sender_full_name}`);
      console.log(`${email.sender_title}\n`);

      records.push({
        cta_number: resolvedCta.cta_number,
        cta_name: resolvedCta.name,
        status: passed ? "drafted" : "validation_failed",
        attempts: attemptCount,
        validation_passed: passed,
        violations: validation.violations,
        email,
      });
    } catch (err) {
      console.error(`  ERROR for CTA #${ctaNum}:`, (err as Error).message);
      records.push({ cta_number: ctaNum, status: "error", error: (err as Error).message });
    }
  }

  // ── Save output ────────────────────────────────────────────────────────────
  const output = {
    generated_at: generatedAt,
    sheet_row: SHEET_ROW_NUMBER,
    contact_email: row.contact_email,
    contact_name: row.contact_name,
    property_address: row.property_address,
    mock_patches_applied: MOCK_PATCHES,
    records,
  };

  await fs.mkdir(path.dirname(OUTPUT_PATH), { recursive: true });
  await fs.writeFile(OUTPUT_PATH, JSON.stringify(output, null, 2));

  const passed = records.filter((r: unknown) => (r as { status: string }).status === "drafted").length;
  const failed = records.length - passed;
  console.log(HR);
  console.log(`\n  Done. ${records.length} CTA(s) processed — ${passed} passed, ${failed} failed/skipped.`);
  console.log(`  Output saved to: ${OUTPUT_PATH}\n`);
}

main().catch((err) => {
  console.error("[tier2-row6-mock] Fatal error:", err);
  process.exit(1);
});
