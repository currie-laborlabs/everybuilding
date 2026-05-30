/**
 * Cobalt-only owner-resolution smoke test.
 *
 * Reads rows from a Google Sheet tab, runs only the Cobalt owner-resolution
 * adapter for up to N unique properties, and writes a copy of those rows to a
 * new tab with owner_resolution_* columns populated.
 */

import "dotenv/config";
import { google } from "googleapis";
import { config } from "./config";
import { OwnerResolver } from "./enrichment/owner-resolution/resolver";
import type { OwnerResolutionInput, OwnerResolutionResult } from "./enrichment/owner-resolution/types";
import { SHEET_COLUMNS, saveToGoogleSheet } from "./output/saveCsv";
import type { Tier1ContactRow } from "./types";

type RawSheetRow = {
  sheetRowIndex: number;
  data: Record<string, string>;
};

function intEnv(name: string, defaultValue: number): number {
  const raw = process.env[name];
  if (!raw) return defaultValue;
  const value = parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

function buildSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.output.googleSheets.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

function toNumberOrNull(value: string): number | null {
  const parsed = Number(value.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function toRow(data: Record<string, string>): Tier1ContactRow {
  const row: Record<string, unknown> = {};
  for (const column of SHEET_COLUMNS) {
    row[column] = data[column] ?? "";
  }

  row["year_built"] = toNumberOrNull(data["year_built"] ?? "");
  row["square_feet"] = toNumberOrNull(data["square_feet"] ?? "");
  row["owner_resolution_confidence"] = data["owner_resolution_confidence"]
    ? Number(data["owner_resolution_confidence"])
    : undefined;
  row["sequence"] =
    data["sequence"] === "Secondary" || data["sequence"] === "Tertiary"
      ? data["sequence"]
      : "Primary";
  row["extraction_status"] = data["extraction_status"] === "partial" ? "partial" : "extracted";
  row["enrichment_status"] =
    data["enrichment_status"] === "success" || data["enrichment_status"] === "skipped"
      ? data["enrichment_status"]
      : "success";
  row["verification_status"] = data["verification_status"] || "unverified";
  row["review_status"] = data["review_status"] || "pending";

  return row as unknown as Tier1ContactRow;
}

function normalizeOwnerName(name: string): string {
  return name
    .replace(/\b(FAMILY\s+)?TRUST\b/gi, "")
    .replace(/\bTRUSTEE(S)?\b/gi, "")
    .replace(/\bL\.?L\.?C\.?\b/gi, "")
    .replace(/\bL\.?L\.?P\.?\b/gi, "")
    .replace(/\bINC\.?\b/gi, "")
    .replace(/\bCORP(ORATION)?\.?\b/gi, "")
    .replace(/\bCO\.?\b/gi, "")
    .replace(/\bLTD\.?\b/gi, "")
    .replace(/\b[A-Z]{2}\b$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function buildInput(row: RawSheetRow): OwnerResolutionInput {
  const owner = row.data["owner_entity"] || row.data["resolved_company_name"] || "";
  return {
    property_id: row.data["property_id"] || row.data["property_address"] || `sheet-row-${row.sheetRowIndex}`,
    raw_owner_name: owner,
    normalized_owner_name: normalizeOwnerName(owner),
    owner_type: "",
    owner_mailing_address: "",
    care_of_name: "",
    property_address: row.data["property_address"] || "",
    city: row.data["city"] || "",
    state: row.data["state"] || "",
    zip: row.data["zip_code"] || "",
    source_platform: row.data["source_platform"] || "google_sheet",
  };
}

function applyResolution(row: Tier1ContactRow, result: OwnerResolutionResult): Tier1ContactRow {
  return {
    ...row,
    owner_resolution_status: result.resolution_status,
    owner_resolution_confidence: result.confidence_score,
    resolved_company_name: result.candidate_company_name,
    resolved_domain: result.candidate_domain,
    owner_resolution_source: result.resolution_source,
    owner_resolution_notes: result.notes || result.error_message || "",
    registry_contact_name: result.registry_contact_name ?? "",
    registry_contact_title: result.registry_contact_title ?? "",
  };
}

async function main(): Promise<void> {
  const sourceTab =
    process.env.OWNER_RESOLUTION_TEST_SOURCE_TAB?.trim() ||
    process.env.ENRICH_SOURCE_TAB?.trim() ||
    config.output.googleSheets.tabName;
  const outputTab =
    process.env.OWNER_RESOLUTION_TEST_OUTPUT_TAB?.trim() ||
    `${sourceTab}_Cobalt_Test`;
  const limit = intEnv("OWNER_RESOLUTION_TEST_LIMIT", 5);

  if (!config.ownerResolution.cobaltApiKey) {
    throw new Error("Missing COBALT_API_KEY in .env");
  }

  console.log("==============================================");
  console.log("  EVERYBUILDING — Cobalt Owner Resolution Test");
  console.log("==============================================");
  console.log(`Spreadsheet : ${config.output.googleSheets.spreadsheetId}`);
  console.log(`Source tab  : ${sourceTab}`);
  console.log(`Output tab  : ${outputTab}`);
  console.log(`Max credits : ${limit}`);
  console.log("----------------------------------------------");

  const sheets = buildSheetsClient();
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.output.googleSheets.spreadsheetId,
    range: sourceTab,
  });

  const values = response.data.values ?? [];
  if (values.length < 2) {
    console.log("[cobalt-test] Source tab has no data rows.");
    return;
  }

  const headers = (values[0] as string[]).map((header) => header.trim());
  const rows: RawSheetRow[] = (values.slice(1) as string[][]).map((valuesRow, index) => {
    const data: Record<string, string> = {};
    for (let column = 0; column < headers.length; column++) {
      data[headers[column]] = valuesRow[column] ?? "";
    }
    return { sheetRowIndex: index + 2, data };
  });

  const byProperty = new Map<string, RawSheetRow[]>();
  for (const row of rows) {
    const key = row.data["property_id"] || row.data["property_address"] || `row-${row.sheetRowIndex}`;
    if (!byProperty.has(key)) byProperty.set(key, []);
    byProperty.get(key)!.push(row);
  }

  const selected = Array.from(byProperty.values()).slice(0, limit);
  const resolver = new OwnerResolver(
    {
      ...config.ownerResolution,
      enabled: true,
      adapters: {
        cobalt: true,
        hunter: false,
        apollo: false,
        serper: false,
        opencorporates: false,
      },
    },
    undefined,
    undefined,
    undefined,
    undefined,
    config.ownerResolution.cobaltApiKey,
    config.ownerResolution.cobaltBaseUrl
  );

  const outputRows: Tier1ContactRow[] = [];

  for (const propertyRows of selected) {
    const first = propertyRows[0];
    const input = buildInput(first);
    console.log(`[cobalt-test] ${input.property_id} | ${input.raw_owner_name} | ${input.state}`);
    const result = await resolver.resolve(input);

    for (const row of propertyRows) {
      outputRows.push(applyResolution(toRow(row.data), result));
    }
  }

  const saveResult = await saveToGoogleSheet(outputRows, {
    credentialsPath: config.output.googleSheets.credentialsPath,
    spreadsheetId: config.output.googleSheets.spreadsheetId,
    tabName: outputTab,
    writeHeaderRow: true,
  });

  console.log(`[cobalt-test] Wrote ${saveResult.appendedCount} row(s) to "${outputTab}".`);
  if (saveResult.skippedExistingCount > 0) {
    console.log(`[cobalt-test] Skipped ${saveResult.skippedExistingCount} duplicate email row(s).`);
  }
}

main().catch((err) => {
  console.error("[cobalt-test] Fatal error:", err);
  process.exitCode = 1;
});
