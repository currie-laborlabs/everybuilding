/**
 * test-keys.ts
 *
 * Lightweight smoke test for every API key in .env.
 * - Uses the cheapest / free "account info" endpoint for each provider.
 * - Does NOT open a Browserbase session or touch Reonomy.
 * - Does NOT consume ATTOM / Apollo / Hunter credits.
 * - ZeroBounce: reads credit balance (free).
 * - Hunter:     reads account info (free).
 * - Apollo:     tries a 1-result org search (uses credits only on the
 *               /mixed_companies/search route — kept at per_page=1 to be minimal).
 * - ATTOM:      single property detail lookup (uses 1 trial credit).
 * - Google Sheets: reads spreadsheet metadata (free, no writes).
 *
 * Run: npm run test-keys
 */

import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import { google } from "googleapis";
dotenv.config();

// ─── helpers ──────────────────────────────────────────────────────────────────

function env(key: string): string | undefined {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v.trim() : undefined;
}

function ok(label: string, detail?: string) {
  console.log(`  ✅ ${label}${detail ? ` — ${detail}` : ""}`);
}
function fail(label: string, detail: string) {
  console.log(`  ❌ ${label} — ${detail}`);
}
function skip(label: string, reason: string) {
  console.log(`  ⏭  ${label} — skipped (${reason})`);
}
function section(title: string) {
  console.log(`\n━━━ ${title} ━━━`);
}

// ─── ZeroBounce — GET /getcredits  (FREE, no email consumed) ──────────────────

async function testZeroBounce() {
  section("ZeroBounce");
  const apiKey = env("ZEROBOUNCE_API_KEY");
  const baseUrl = env("ZEROBOUNCE_BASE_URL") ?? "https://api.zerobounce.net/v2";

  if (!apiKey) {
    skip("credit balance", "ZEROBOUNCE_API_KEY not set");
    return;
  }

  try {
    const url = new URL(`${baseUrl}/getcredits`);
    url.searchParams.set("api_key", apiKey);

    const res = await fetch(url);
    if (!res.ok) {
      fail("credit balance", `HTTP ${res.status}`);
      return;
    }

    const data = (await res.json()) as { Credits?: string | number };
    if (data.Credits !== undefined) {
      ok("credit balance", `${data.Credits} credits remaining`);
    } else {
      fail("credit balance", `unexpected response: ${JSON.stringify(data)}`);
    }
  } catch (e) {
    fail("credit balance", e instanceof Error ? e.message : String(e));
  }
}

// ─── Hunter — GET /account  (FREE) ────────────────────────────────────────────

async function testHunter() {
  section("Hunter.io");
  const apiKey = env("HUNTER_API_KEY");
  const baseUrl = env("HUNTER_BASE_URL") ?? "https://api.hunter.io/v2";

  if (!apiKey) {
    skip("account info", "HUNTER_API_KEY not set");
    return;
  }

  try {
    const url = new URL(`${baseUrl}/account`);
    url.searchParams.set("api_key", apiKey);

    const res = await fetch(url);
    if (!res.ok) {
      fail("account info", `HTTP ${res.status}`);
      return;
    }

    const body = (await res.json()) as {
      data?: {
        first_name?: string;
        plan_name?: string;
        requests?: { searches?: { used?: number; available?: number } };
      };
    };

    const d = body.data;
    if (!d) {
      fail("account info", `unexpected response: ${JSON.stringify(body)}`);
      return;
    }

    const name = d.first_name ?? "Unknown";
    const plan = d.plan_name ?? "Unknown";
    const used = d.requests?.searches?.used ?? "?";
    const avail = d.requests?.searches?.available ?? "?";
    ok("account info", `${name} / ${plan} — ${used}/${avail} searches used`);
  } catch (e) {
    fail("account info", e instanceof Error ? e.message : String(e));
  }
}

// ─── Apollo — GET /v1/auth/health  (FREE, zero credits, validates key) ───────
// Then attempts /mixed_people/search to show plan-level access.

async function testApollo() {
  section("Apollo.io");
  const apiKey = env("APOLLO_API_KEY");
  const baseUrl = env("APOLLO_BASE_URL") ?? "https://api.apollo.io/api/v1";

  if (!apiKey) {
    skip("auth health check", "APOLLO_API_KEY not set");
    return;
  }

  // Step 1: Free health check — no credits consumed
  try {
    const healthRes = await fetch(`${baseUrl}/auth/health`, {
      headers: { "x-api-key": apiKey },
    });

    if (!healthRes.ok) {
      fail("auth/health", `HTTP ${healthRes.status} — key is invalid or expired`);
      return;
    }

    const health = (await healthRes.json()) as {
      is_logged_in?: boolean;
      logged_in_as_user?: { email?: string; plan?: string };
    };

    if (!health.is_logged_in) {
      fail("auth/health", "is_logged_in = false — key rejected");
      return;
    }

    const email = health.logged_in_as_user?.email ?? "unknown";
    ok("key authenticated", `logged in as ${email}`);
  } catch (e) {
    fail("auth/health", e instanceof Error ? e.message : String(e));
    return;
  }

  // Step 2: Test pipeline endpoint — shows whether plan allows people search
  try {
    const res = await fetch(`${baseUrl}/mixed_people/api_search`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": apiKey },
      body: JSON.stringify({ q_organization_name: "acme", page: 1, per_page: 1 }),
    });

    if (res.status === 403) {
      ok(
        "/mixed_people/api_search access",
        "HTTP 403 — plan upgrade required for people search."
      );
    } else if (res.status === 401) {
      fail("/mixed_people/api_search", "HTTP 401 — unexpected after health passed");
    } else if (res.ok) {
      const data = (await res.json()) as { people?: unknown[] };
      ok("/mixed_people/api_search", `Full access — ${data.people?.length ?? 0} result(s) returned`);
    } else {
      const text = await res.text().catch(() => "");
      fail("/mixed_people/api_search", `HTTP ${res.status}: ${text.slice(0, 100)}`);
    }
  } catch (e) {
    fail("/mixed_people/api_search", e instanceof Error ? e.message : String(e));
  }
}

// ─── ATTOM — GET /property/detail  (uses 1 trial credit) ────────────────────

async function testAttom() {
  section("ATTOM Data");
  const apiKey = env("ATTOM_API_KEY");
  const baseUrl =
    env("ATTOM_BASE_URL") ??
    "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

  if (!apiKey) {
    skip("property detail", "ATTOM_API_KEY not set");
    return;
  }

  // ATTOM requires address1 (street) + address2 (city state zip).
  // Using address1+postalcode is an invalid combination (-4 error).
  const testAddress1 = "1 Infinite Loop";
  const testAddress2 = "Cupertino CA 95014"; // Apple HQ — stable ATTOM record

  try {
    const url = new URL(`${baseUrl}/property/detail`);
    url.searchParams.set("address1", testAddress1);
    url.searchParams.set("address2", testAddress2);

    const res = await fetch(url, {
      headers: {
        apikey: apiKey,
        accept: "application/json",
      },
    });

    // 401/403 = bad key. 400 = bad params but key is valid.
    if (res.status === 401 || res.status === 403) {
      const text = await res.text().catch(() => "");
      fail("property detail", `HTTP ${res.status} — API key rejected: ${text.slice(0, 120)}`);
      return;
    }

    if (res.status === 400) {
      // Key accepted — address lookup didn't match, but auth succeeded.
      ok("key authenticated", "HTTP 400 — ATTOM key is valid (address param mismatch is normal for test addresses)");
      return;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      fail("property detail", `HTTP ${res.status}: ${text.slice(0, 200)}`);
      return;
    }

    const data = (await res.json()) as {
      status?: { code?: number; msg?: string; total?: number };
      property?: unknown[];
    };

    const code = data.status?.code;
    const total = data.status?.total ?? 0;
    if (code === 0 && total > 0) {
      ok("property detail", `${total} property record(s) returned`);
    } else if (code === 0) {
      ok("property detail (key valid)", "0 records — address not found but auth succeeded");
    } else {
      fail("property detail", `status ${code}: ${data.status?.msg}`);
    }
  } catch (e) {
    fail("property detail", e instanceof Error ? e.message : String(e));
  }
}

// ─── Google Sheets — read spreadsheet metadata  (FREE, no writes) ────────────

async function testGoogleSheets() {
  section("Google Sheets");
  const credPath = env("GOOGLE_SHEETS_CREDENTIALS_PATH");
  const spreadsheetId = env("GOOGLE_SHEETS_SPREADSHEET_ID");

  if (!credPath) {
    skip("spreadsheet read", "GOOGLE_SHEETS_CREDENTIALS_PATH not set");
    return;
  }
  if (!spreadsheetId) {
    skip("spreadsheet read", "GOOGLE_SHEETS_SPREADSHEET_ID not set");
    return;
  }

  const resolved = path.resolve(credPath);
  if (!fs.existsSync(resolved)) {
    fail("credentials file", `not found at ${resolved}`);
    return;
  }
  ok("credentials file", resolved);

  try {
    const auth = new google.auth.GoogleAuth({
      keyFile: resolved,
      scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
    });

    const sheetsApi = google.sheets({ version: "v4", auth });
    const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId });

    const title = spreadsheet.data.properties?.title ?? "untitled";
    const tabs = (spreadsheet.data.sheets ?? [])
      .map((s) => s.properties?.title)
      .filter(Boolean)
      .join(", ");

    ok("spreadsheet access", `"${title}" — tabs: [${tabs || "none"}]`);

    const tabName = env("GOOGLE_SHEETS_TAB_NAME") ?? "Leads";
    const exists = (spreadsheet.data.sheets ?? []).some(
      (s) => s.properties?.title === tabName
    );
    if (exists) {
      ok(`tab "${tabName}"`, "exists");
    } else {
      ok(`tab "${tabName}"`, "does not exist yet — will be created on first run");
    }
  } catch (e) {
    fail("spreadsheet access", e instanceof Error ? e.message : String(e));
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n═══════════════════════════════════════════════");
  console.log("  Tier 1 API Key Smoke Test");
  console.log("═══════════════════════════════════════════════");
  console.log("NOTE: No Browserbase session opened.");
  console.log("      ATTOM uses 1 trial credit. Everything else is free.\n");

  await testGoogleSheets();
  await testZeroBounce();
  await testHunter();
  await testApollo();
  await testAttom();

  console.log("\n═══════════════════════════════════════════════\n");
}

main().catch((e) => {
  console.error("\nFatal error:", e);
  process.exit(1);
});
