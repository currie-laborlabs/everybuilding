/**
 * tmp/test-attom-sheet.ts
 *
 * Reads the Google Sheet, deduplicates by property address+zip,
 * runs ATTOM enrichment on the first 3 unique properties, and
 * prints the results. No Apollo / Hunter / ZeroBounce — ATTOM only.
 *
 * Run: npx tsx tmp/test-attom-sheet.ts
 */

import dotenv from "dotenv";
dotenv.config();

import { google } from "googleapis";
import { AttomClient } from "../src/enrichment/attom";
import { makePropertyKey } from "../src/utils";
import type { NormalizedLead } from "../src/types";

// ── Sheet client ──────────────────────────────────────────────────────────────

function buildSheetsClient() {
  const credPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH;
  if (!credPath) throw new Error("Missing GOOGLE_SHEETS_CREDENTIALS_PATH in .env");
  const auth = new google.auth.GoogleAuth({
    keyFile: credPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

// ── ATTOM client ──────────────────────────────────────────────────────────────

function buildAttomClient() {
  return new AttomClient({
    apiKey: process.env.ATTOM_API_KEY,
    baseUrl: process.env.ATTOM_BASE_URL ?? "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 4000,
    ratePerSecond: 1,
    circuitFailureThreshold: 3,
    circuitResetTimeoutMs: 30000,
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function rowToLead(data: Record<string, string>): NormalizedLead {
  return {
    property_id: data.property_id ?? data.property_address ?? "",
    property_address: data.property_address ?? "",
    city: data.city ?? "",
    state: data.state ?? "",
    zip_code: data.zip_code ?? "",
    land_use: data.land_use ?? "",
    year_built: parseInt(data.year_built ?? "", 10) || null,
    square_feet: parseInt(data.square_feet ?? "", 10) || null,
    owner_entity: data.owner_entity ?? "",
    source_platform: "reonomy",
    source_search_area: data.source_search_area ?? "",
    source_run_date: data.source_run_date ?? "",
    source_notes: data.source_notes ?? "",
    extraction_status: "extracted",
    reonomy_owner_name: "",
    reonomy_owner_phone: "",
    reonomy_owner_email: "",
    reonomy_contact_name: data.contact_name ?? "",
    reonomy_contact_title: data.contact_title ?? "",
    reonomy_contact_phone: data.contact_phone ?? "",
    reonomy_contact_email: data.contact_email ?? "",
    reonomy_company_domain: "",
    reonomy_last_acquisition_date: data.last_sale_date ?? "",
    reonomy_detail_status: "not_attempted",
    reonomy_detail_notes: "",
    reonomy_contacts_json: "[]",
    review_status: "pending",
    notes: "",
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
  const tabName = process.env.GOOGLE_SHEETS_TAB_NAME;
  if (!spreadsheetId || !tabName) {
    throw new Error("Missing GOOGLE_SHEETS_SPREADSHEET_ID or GOOGLE_SHEETS_TAB_NAME in .env");
  }

  // 1. Read sheet
  console.log(`\nReading sheet: ${spreadsheetId} / ${tabName} ...`);
  const sheets = buildSheetsClient();
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
  const values = res.data.values ?? [];
  if (values.length < 2) {
    console.log("Sheet is empty — nothing to test.");
    return;
  }

  const headers = (values[0] as string[]).map((h) => h.trim());
  const dataRows = values.slice(1) as string[][];

  // 2. Deduplicate by address+zip — keep first occurrence of each unique property
  const limit = parseInt(process.env.ATTOM_TEST_LIMIT ?? "3", 10);
  const seen = new Set<string>();
  const uniqueLeads: NormalizedLead[] = [];

  for (const row of dataRows) {
    const data: Record<string, string> = {};
    for (let i = 0; i < headers.length; i++) data[headers[i]] = row[i] ?? "";

    const address = (data.property_address ?? "").trim();
    const zip = (data.zip_code ?? "").trim();
    if (!address) continue;

    const key = makePropertyKey(address, zip);
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueLeads.push(rowToLead(data));

    if (uniqueLeads.length === limit) break;
  }

  console.log(`Found ${uniqueLeads.length} unique propert${uniqueLeads.length === 1 ? "y" : "ies"} to test.\n`);

  if (uniqueLeads.length === 0) {
    console.log("No valid rows with property_address found.");
    return;
  }

  // 3. Run ATTOM enrichment on each
  const attom = buildAttomClient();
  const attomKey = process.env.ATTOM_API_KEY ?? "";
  const attomBase = process.env.ATTOM_BASE_URL ?? "https://api.gateway.attomdata.com/propertyapi/v1.0.0";

  for (let i = 0; i < uniqueLeads.length; i++) {
    const lead = uniqueLeads[i];
    console.log(`\n━━━ [${i + 1}/${uniqueLeads.length}] ${lead.property_address}, ${lead.city}, ${lead.state} ${lead.zip_code} ━━━`);

    // On the first property, dump the raw permit payload so we can see all ATTOM field names.
    if (i === 0) {
      const permitUrl = new URL(`${attomBase}/property/buildingpermits`);
      permitUrl.searchParams.set("address1", lead.property_address);
      permitUrl.searchParams.set("address2", `${lead.city} ${lead.state} ${lead.zip_code}`.trim());
      const rawRes = await fetch(permitUrl, { headers: { apikey: attomKey, accept: "application/json" } });
      const rawJson = await rawRes.json();
      const firstPermit = (rawJson as any)?.property?.[0]?.buildingPermits?.[0] ?? null;
      console.log("\n  [DEBUG] Raw ATTOM permit fields (first permit):");
      console.log(JSON.stringify(firstPermit, null, 4).replace(/^/gm, "  "));

      // Also dump the raw community payload to see actual field names
      const detailUrl = new URL(`${attomBase}/property/detail`);
      detailUrl.searchParams.set("address1", lead.property_address);
      detailUrl.searchParams.set("address2", `${lead.city} ${lead.state} ${lead.zip_code}`.trim());
      const detailRes = await fetch(detailUrl, { headers: { apikey: attomKey, accept: "application/json" } });
      const detailJson = await detailRes.json();
      const geoIdV4 = (detailJson as any)?.property?.[0]?.location?.geoIdV4?.ZI ?? "";
      if (geoIdV4) {
        const origin = new URL(attomBase).origin;
        const commUrl = new URL(`${origin}/v4/neighborhood/community`);
        commUrl.searchParams.set("geoIdV4", geoIdV4);
        const commRes = await fetch(commUrl, { headers: { apikey: attomKey, accept: "application/json" } });
        const commJson = await commRes.json();
        console.log("\n  [DEBUG] Raw ATTOM community response:");
        console.log(JSON.stringify((commJson as any)?.community ?? commJson, null, 4).replace(/^/gm, "  "));
      } else {
        console.log("\n  [DEBUG] No geoIdV4 found — Community API skipped.");
      }
    }

    const result = await attom.enrichLead(lead);

    console.log("  enrichment_status     :", result.enrichment_status);
    console.log("  last_sale_date        :", result.last_sale_date || "(none)");
    console.log("  last_sale_price       :", result.last_sale_price || "(none)");
    console.log("  permit_summary        :", result.permit_summary || "(none)");
    console.log("  last_permit_date      :", result.last_permit_date || "(none)");
    console.log("  roof_permit_date      :", result.roof_permit_date || "(none)");
    console.log("  hvac_permit_date      :", result.hvac_permit_date || "(none)");
    console.log("  ownership_transfer    :", result.ownership_transfer_flag || "(none)");
    console.log("  tax_or_distress_notes :", result.tax_or_distress_notes || "(none)");
    console.log("  hazard_notes          :", result.hazard_notes || "(none)");

    // Full raw JSON for debugging
    console.log("\n  Full result:");
    console.log(JSON.stringify(result, null, 4).replace(/^/gm, "  "));
  }

  console.log("\n━━━ Done ━━━\n");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
