/**
 * tmp/run-batchdata-sample.ts
 *
 * Standalone BatchData skip trace runner.
 * Reads property rows directly from your Google Sheet (the "Leads" tab),
 * runs BatchData skip trace on each address, then appends contact results
 * to a dedicated "BatchData_Test" tab in the same spreadsheet.
 *
 * Usage:
 *   npx tsx tmp/run-batchdata-sample.ts
 *
 * Optional env overrides:
 *   SAMPLE_LIMIT=10        — max properties to process (default: 5)
 *   BATCHDATA_TAB=MyTab    — output tab name (default: BatchData_Test)
 *   SOURCE_TAB=Leads       — which sheet tab to read properties from (default: GOOGLE_SHEETS_TAB_NAME)
 */

import dotenv from "dotenv";
import { google } from "googleapis";
import { BatchDataSkipTraceClient } from "../src/enrichment/contacts/batchdata";
import { sequenceForIndex } from "../src/enrichment/contacts/merge";
import { saveToGoogleSheet } from "../src/output/saveCsv";
import type { EnrichedPropertyLead, Tier1ContactRow } from "../src/types";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const SAMPLE_LIMIT = parseInt(process.env.SAMPLE_LIMIT ?? "5", 10);
const OUTPUT_TAB = process.env.BATCHDATA_TAB ?? "BatchData_Test";
const SOURCE_TAB = process.env.SOURCE_TAB ?? process.env.GOOGLE_SHEETS_TAB_NAME ?? "Leads";

const apiKey = process.env.BATCHDATA_API_KEY;
const baseUrl = process.env.BATCHDATA_BASE_URL ?? "https://api.batchdata.com";
const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
const credentialsPath = process.env.GOOGLE_SHEETS_CREDENTIALS_PATH!;

if (!apiKey) {
  console.error("BATCHDATA_API_KEY is not set in .env");
  process.exit(1);
}

// ── Read Google Sheet ─────────────────────────────────────────────────────────

async function readSheetRows(): Promise<Record<string, string>[]> {
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: SOURCE_TAB,
  });

  const values = response.data.values ?? [];
  if (values.length < 2) return [];

  const headers = (values[0] as string[]).map((h) => h.trim());
  const dataRows = (values.slice(1) as string[][]).slice(0, SAMPLE_LIMIT);

  return dataRows.map((row) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, i) => (obj[h] = (row[i] ?? "").trim()));
    return obj;
  });
}

// ── Build EnrichedPropertyLead from a sheet row ───────────────────────────────

function sheetRowToLead(row: Record<string, string>): EnrichedPropertyLead {
  const yearBuilt = parseInt(row.year_built ?? "", 10);
  const squareFeet = parseInt(row.square_feet ?? "", 10);
  return {
    property_id: row.property_id ?? "",
    property_address: row.property_address ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    zip_code: row.zip_code ?? "",
    land_use: row.land_use ?? "",
    square_feet: Number.isFinite(squareFeet) ? squareFeet : null,
    year_built: Number.isFinite(yearBuilt) ? yearBuilt : null,
    owner_entity: row.owner_entity ?? "",
    source_platform: (row.source_platform as any) ?? "reonomy",
    source_search_area: row.source_search_area ?? "",
    source_run_date: row.source_run_date ?? "",
    source_notes: row.source_notes ?? "",
    extraction_status: (row.extraction_status as any) ?? "extracted",
    reonomy_owner_name: "",
    reonomy_owner_phone: "",
    reonomy_owner_email: "",
    reonomy_contact_name: row.contact_name ?? "",
    reonomy_contact_title: row.contact_title ?? "",
    reonomy_contact_phone: row.contact_phone ?? "",
    reonomy_contact_email: row.contact_email ?? "",
    reonomy_company_domain: "",
    reonomy_last_acquisition_date: row.last_sale_date ?? "",
    reonomy_detail_status: "not_attempted",
    reonomy_detail_notes: "",
    reonomy_contacts_json: "[]",
    review_status: "pending",
    notes: "",
    last_sale_date: row.last_sale_date ?? "",
    last_sale_price: row.last_sale_price ?? "",
    permit_summary: row.permit_summary ?? "",
    permit_type: "",
    roof_permit_date: row.roof_permit_date ?? "",
    hvac_permit_date: row.hvac_permit_date ?? "",
    plumbing_permit_date: row.plumbing_permit_date ?? "",
    electrical_permit_date: row.electrical_permit_date ?? "",
    restoration_permit_date: row.restoration_permit_date ?? "",
    fire_water_permit_date: row.fire_water_permit_date ?? "",
    last_permit_date: row.last_permit_date ?? "",
    permit_contractor: row.permit_contractor ?? "",
    ownership_transfer_flag: row.ownership_transfer_flag ?? "",
    tax_or_distress_notes: row.tax_or_distress_notes ?? "",
    hazard_notes: row.hazard_notes ?? "",
    crime_notes: row.crime_notes ?? "",
    demographics_notes: row.demographics_notes ?? "",
    air_quality_notes: row.air_quality_notes ?? "",
    climate_notes: row.climate_notes ?? "",
    enrichment_status: (row.enrichment_status as any) ?? "skipped",
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nBatchData Skip Trace — Sample Run`);
  console.log(`  Source tab : ${SOURCE_TAB}`);
  console.log(`  Output tab : ${OUTPUT_TAB}`);
  console.log(`  Limit      : ${SAMPLE_LIMIT} properties`);
  console.log(`  Sheet      : https://docs.google.com/spreadsheets/d/${spreadsheetId}\n`);

  console.log(`Reading rows from "${SOURCE_TAB}"...`);
  const rows = await readSheetRows();

  if (rows.length === 0) {
    console.error(`No data rows found in tab "${SOURCE_TAB}".`);
    process.exit(1);
  }

  // Deduplicate by property_id — only process each property once
  const seen = new Set<string>();
  const uniqueRows = rows.filter((r) => {
    const key = r.property_id || r.property_address;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const leads = uniqueRows.map(sheetRowToLead);
  console.log(`Loaded ${leads.length} unique properties from the sheet.`);

  const client = new BatchDataSkipTraceClient({
    apiKey,
    baseUrl,
    maxAttempts: 3,
    baseDelayMs: 1000,
    maxDelayMs: 8000,
    ratePerSecond: 2,
    circuitFailureThreshold: 5,
    circuitResetTimeoutMs: 60000,
  });

  const outputRows: Tier1ContactRow[] = [];

  for (const lead of leads) {
    console.log(`\n→  ${lead.property_address}, ${lead.city}, ${lead.state} ${lead.zip_code}`);
    console.log(`   Owner: ${lead.owner_entity}`);

    const candidates = await client.findContacts(lead);

    if (candidates.length === 0) {
      console.log(`   No contacts found`);
      outputRows.push({
        property_id: lead.property_id,
        property_address: lead.property_address,
        city: lead.city,
        state: lead.state,
        zip_code: lead.zip_code,
        land_use: lead.land_use,
        year_built: lead.year_built,
        square_feet: lead.square_feet,
        owner_entity: lead.owner_entity,
        source_platform: lead.source_platform,
        source_search_area: lead.source_search_area,
        source_run_date: lead.source_run_date,
        source_notes: lead.source_notes,
        contact_name: "",
        contact_title: "",
        contact_email: "",
        contact_phone: "",
        contact_source: "batchdata",
        sequence: sequenceForIndex(0),
        extraction_status: lead.extraction_status,
        enrichment_status: "failed",
        verification_status: "unverified",
        review_status: lead.review_status,
        notes: "BatchData: no contacts returned",
        last_sale_date: lead.last_sale_date,
        last_sale_price: lead.last_sale_price,
        permit_summary: lead.permit_summary,
        roof_permit_date: lead.roof_permit_date,
        hvac_permit_date: lead.hvac_permit_date,
        plumbing_permit_date: lead.plumbing_permit_date,
        electrical_permit_date: lead.electrical_permit_date,
        restoration_permit_date: lead.restoration_permit_date,
        fire_water_permit_date: lead.fire_water_permit_date,
        last_permit_date: lead.last_permit_date,
        permit_contractor: lead.permit_contractor,
        ownership_transfer_flag: lead.ownership_transfer_flag,
        tax_or_distress_notes: lead.tax_or_distress_notes,
        hazard_notes: lead.hazard_notes,
        crime_notes: lead.crime_notes,
        demographics_notes: lead.demographics_notes,
        air_quality_notes: lead.air_quality_notes,
        climate_notes: lead.climate_notes,
      });
      continue;
    }

    candidates.forEach((c, i) => {
      console.log(`   FOUND  ${c.contact_name || "(unnamed)"}  phone: ${c.contact_phone || "—"}  email: ${c.contact_email || "—"}  confidence: ${(c.confidence * 100).toFixed(0)}%`);
      outputRows.push({
        property_id: lead.property_id,
        property_address: lead.property_address,
        city: lead.city,
        state: lead.state,
        zip_code: lead.zip_code,
        land_use: lead.land_use,
        year_built: lead.year_built,
        square_feet: lead.square_feet,
        owner_entity: lead.owner_entity,
        source_platform: lead.source_platform,
        source_search_area: lead.source_search_area,
        source_run_date: lead.source_run_date,
        source_notes: lead.source_notes,
        contact_name: c.contact_name,
        contact_title: c.contact_title,
        contact_email: c.contact_email,
        contact_phone: c.contact_phone,
        contact_source: "batchdata",
        sequence: sequenceForIndex(i),
        extraction_status: lead.extraction_status,
        enrichment_status: "success",
        verification_status: "unverified",
        review_status: lead.review_status,
        notes: `BatchData skip trace — confidence ${(c.confidence * 100).toFixed(0)}%`,
        last_sale_date: lead.last_sale_date,
        last_sale_price: lead.last_sale_price,
        permit_summary: lead.permit_summary,
        roof_permit_date: lead.roof_permit_date,
        hvac_permit_date: lead.hvac_permit_date,
        plumbing_permit_date: lead.plumbing_permit_date,
        electrical_permit_date: lead.electrical_permit_date,
        restoration_permit_date: lead.restoration_permit_date,
        fire_water_permit_date: lead.fire_water_permit_date,
        last_permit_date: lead.last_permit_date,
        permit_contractor: lead.permit_contractor,
        ownership_transfer_flag: lead.ownership_transfer_flag,
        tax_or_distress_notes: lead.tax_or_distress_notes,
        hazard_notes: lead.hazard_notes,
        crime_notes: lead.crime_notes,
        demographics_notes: lead.demographics_notes,
        air_quality_notes: lead.air_quality_notes,
        climate_notes: lead.climate_notes,
      });
    });
  }

  console.log(`\nWriting ${outputRows.length} rows to tab "${OUTPUT_TAB}"...`);

  const result = await saveToGoogleSheet(outputRows, {
    credentialsPath,
    spreadsheetId,
    tabName: OUTPUT_TAB,
    writeHeaderRow: true,
  });

  console.log(`\nDone!`);
  console.log(`  Appended : ${result.appendedCount} rows`);
  console.log(`  Skipped  : ${result.skippedExistingCount} duplicate emails`);
  console.log(`  Sheet    : https://docs.google.com/spreadsheets/d/${spreadsheetId}`);
}

main().catch((err) => {
  console.error("Fatal:", err.message);
  process.exit(1);
});
