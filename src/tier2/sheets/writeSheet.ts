/**
 * src/tier2/sheets/writeSheet.ts
 *
 * Writes Tier 2 outreach tracking columns back to a Google Sheet row
 * after a contact has been processed by the daily pipeline.
 *
 * Only Tier 2 tracking columns are updated — Tier 1 columns are never touched.
 * Performs a targeted cell-range batchUpdate (one entry per changed column).
 *
 * Layout assumption (same as readSheet.ts):
 *   - Row 1 is the header row with column keys.
 *   - Data starts at row 2.
 *   - Contacts are matched by contact_email (must be unique per sheet tab).
 *
 * Array fields (last_5_signature_blurb_types) are serialized as
 * comma-separated strings to match the format readSheet.ts expects.
 */

import { google } from "googleapis";
import type { Tier2OutreachFields } from "../types/index.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface SheetWriteConfig {
  credentialsPath: string;
  spreadsheetId: string;
  tabName: string;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildSheetsClient(credentialsPath: string) {
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: [SHEETS_SCOPE],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Convert a 0-based column index to a spreadsheet column letter.
 * 0 → A, 25 → Z, 26 → AA, 27 → AB, ...
 */
function columnIndexToLetter(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/**
 * Serialize a Tier 2 field value to a string for Google Sheets.
 * Arrays are joined as comma-separated strings.
 * null/undefined → empty string (clears the cell).
 */
function serializeValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.join(",");
  return String(value);
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Updates the Tier 2 tracking columns for a specific contact row.
 *
 * Finds the contact by contact_email, then writes only the supplied fields.
 * Columns that do not exist in the sheet are silently skipped.
 *
 * @param config         Sheet access config
 * @param contact_email  Identifies which row to update
 * @param updates        The Tier 2 fields to write (partial — only changed fields)
 */
export async function writeContactUpdate(
  config: SheetWriteConfig,
  contact_email: string,
  updates: Partial<Tier2OutreachFields>
): Promise<void> {
  const sheets = buildSheetsClient(config.credentialsPath);

  // 1. Read the full sheet (headers + data rows)
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: config.tabName,
  });

  const values = response.data.values ?? [];
  if (values.length < 2) {
    throw new Error(`[writeSheet] Sheet "${config.tabName}" has no data rows.`);
  }

  const headers = (values[0] as string[]).map((h: string) => h.trim());

  // 2. Locate the contact row by email
  const emailColIndex = headers.indexOf("contact_email");
  if (emailColIndex === -1) {
    throw new Error(`[writeSheet] Column "contact_email" not found in sheet headers.`);
  }

  const dataRows = values.slice(1) as string[][];
  const rowIndex = dataRows.findIndex(
    (row) => (row[emailColIndex] ?? "").trim() === contact_email.trim()
  );

  if (rowIndex === -1) {
    throw new Error(
      `[writeSheet] Contact email "${contact_email}" not found in sheet "${config.tabName}".`
    );
  }

  // Sheet row number is 1-based; +2 accounts for 1-indexing + header row
  const sheetRowNumber = rowIndex + 2;

  // 3. Build one ValueRange per updated field
  const data: { range: string; values: string[][] }[] = [];

  for (const [key, value] of Object.entries(updates)) {
    const colIndex = headers.indexOf(key);
    if (colIndex === -1) {
      // Column not yet in sheet — skip. Add the column header manually first.
      continue;
    }
    const colLetter = columnIndexToLetter(colIndex);
    const range = `${config.tabName}!${colLetter}${sheetRowNumber}`;
    data.push({ range, values: [[serializeValue(value)]] });
  }

  if (data.length === 0) return;

  // 4. Write all updated cells in one batchUpdate
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: config.spreadsheetId,
    requestBody: {
      valueInputOption: "RAW",
      data,
    },
  });
}
