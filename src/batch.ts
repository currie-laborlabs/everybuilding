/**
 * batch.ts — Run the Tier 1 pipeline sequentially across a list of ZIP codes.
 *
 * Usage:
 *   npm run scrape:batch
 *
 * ZIP list source (in priority order):
 *   1. ZIP_CODES env var   — comma or newline separated, e.g. ZIP_CODES="07030,10019,07701"
 *   2. ZIP_CODES_FILE env var — path to a text file with one ZIP per line (blank lines ignored)
 *   3. Falls back to REONOMY_ZIP_CODE (runs a single ZIP, same as npm run scrape)
 *
 * All other .env settings (MAX_PAGES, REPROCESS_MODE, COMMERCIAL_ONLY, etc.)
 * apply identically to every ZIP in the batch.
 *
 * Each ZIP runs completely before the next starts. The scraper opens a fresh
 * Browserbase session per ZIP so sessions don't time out on long lists.
 *
 * Progress is logged to the console. Failures for one ZIP are logged and
 * skipped — the batch continues with the next ZIP.
 */

import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import dotenv from "dotenv";

dotenv.config();

function loadZipList(): string[] {
  // 1. ZIP_CODES env var
  const raw = process.env.ZIP_CODES;
  if (raw) {
    const zips = raw
      .split(/[\s,]+/)
      .map((z) => z.trim())
      .filter(Boolean);
    if (zips.length > 0) return zips;
  }

  // 2. ZIP_CODES_FILE env var
  const filePath = process.env.ZIP_CODES_FILE;
  if (filePath) {
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`ZIP_CODES_FILE not found: ${resolved}`);
    }
    const zips = fs
      .readFileSync(resolved, "utf8")
      .split(/\r?\n/)
      .map((z) => z.trim())
      .filter((z) => z && !z.startsWith("#"));
    if (zips.length > 0) return zips;
  }

  // 3. Fallback to single ZIP
  const single = process.env.REONOMY_ZIP_CODE;
  if (single) return [single.trim()];

  throw new Error(
    "No ZIP codes configured. Set ZIP_CODES, ZIP_CODES_FILE, or REONOMY_ZIP_CODE in .env"
  );
}

async function main() {
  const zips = loadZipList();

  console.log("==============================================");
  console.log("  BATCH MODE");
  console.log(`  ${zips.length} ZIP code(s) queued`);
  console.log(`  ZIPs: ${zips.slice(0, 10).join(", ")}${zips.length > 10 ? ` ... +${zips.length - 10} more` : ""}`);
  console.log("==============================================\n");

  const results: { zip: string; status: "ok" | "error"; message?: string }[] = [];

  for (let i = 0; i < zips.length; i++) {
    const zip = zips[i];
    const label = `[${i + 1}/${zips.length}] ZIP ${zip}`;

    console.log(`\n${"─".repeat(50)}`);
    console.log(`${label} — starting`);
    console.log(`${"─".repeat(50)}`);

    try {
      // Run the main scraper with this ZIP injected via env.
      // Uses the same Node + tsx as npm run scrape.
      execSync(`npx tsx src/index.ts`, {
        env: { ...process.env, REONOMY_ZIP_CODE: zip },
        stdio: "inherit",
        cwd: process.cwd(),
      });
      results.push({ zip, status: "ok" });
      console.log(`\n${label} — ✓ complete`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ zip, status: "error", message: msg });
      console.error(`\n${label} — FAILED: ${msg}`);
      console.log("Continuing to next ZIP...");
    }
  }

  // Summary
  const ok = results.filter((r) => r.status === "ok");
  const failed = results.filter((r) => r.status === "error");

  console.log("\n==============================================");
  console.log("  BATCH COMPLETE");
  console.log(`  Processed : ${results.length} ZIP(s)`);
  console.log(`  Succeeded : ${ok.length}`);
  console.log(`  Failed    : ${failed.length}`);
  if (failed.length > 0) {
    console.log("\n  Failed ZIPs:");
    failed.forEach((r) => console.log(`    ${r.zip} — ${r.message}`));
  }
  console.log("==============================================");
}

main().catch((err) => {
  console.error("[batch] Fatal error:", err);
  process.exit(1);
});
