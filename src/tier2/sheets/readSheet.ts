/**
 * src/tier2/sheets/readSheet.ts
 *
 * Reads Tier2ContactRow records from a Google Sheet tab.
 *
 * Layout assumption:
 *   - Row 1 is a header row where each cell contains a column key.
 *   - Remaining rows are data rows.
 *   - The combined column set is: all Tier1ContactRow keys followed by
 *     all Tier2OutreachFields keys (TIER2_SHEET_COLUMNS).
 *
 * The sheet may still only have Tier 1 columns — readEligibleRow handles this
 * gracefully by applying TIER2_DEFAULTS for any missing Tier 2 fields.
 */

import { google } from "googleapis";
import type { Tier2ContactRow } from "../types/index.js";
import { TIER2_DEFAULTS } from "../types/index.js";

const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets.readonly";

export interface SheetReadConfig {
  credentialsPath: string;
  spreadsheetId: string;
  tabName: string;
}

/**
 * Raw row as returned by the Sheets API — array of cell strings.
 * Missing trailing cells are simply absent.
 */
type RawRow = string[];

// ─── helpers ─────────────────────────────────────────────────────────────────

function buildSheetsClient(credentialsPath: string) {
  const auth = new google.auth.GoogleAuth({
    keyFile: credentialsPath,
    scopes: [SHEETS_SCOPE],
  });
  return google.sheets({ version: "v4", auth });
}

/**
 * Zip header + data row into a partial record.
 * Any column beyond the header array length is silently dropped.
 * Any header beyond the data row length gets an empty string.
 */
function zipRow(headers: string[], row: RawRow): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < headers.length; i++) {
    out[headers[i]] = row[i] ?? "";
  }
  return out;
}

/**
 * Cast the raw string map to a Tier2ContactRow.
 * Numeric-looking fields are kept as strings here — callers may coerce if needed.
 * The TIER2_DEFAULTS are applied for any key that is missing or empty string.
 */
function castRow(raw: Record<string, string>): Tier2ContactRow {
  const base = { ...TIER2_DEFAULTS } as unknown as Record<string, unknown>;

  for (const [key, value] of Object.entries(raw)) {
    if (value !== "") {
      // Coerce numeric Tier 2 fields
      if (key === "last_cta_number" || key === "next_cta_number" || key === "total_emails_sent") {
        const n = parseInt(value, 10);
        base[key] = Number.isFinite(n) ? n : TIER2_DEFAULTS[key as keyof typeof TIER2_DEFAULTS];
      } else {
        base[key] = value;
      }
    }
  }

  return base as unknown as Tier2ContactRow;
}

// ─── public API ──────────────────────────────────────────────────────────────

/**
 * Fetch all rows from the given tab, parse headers from row 1,
 * and return typed Tier2ContactRow objects.
 */
export async function readAllRows(config: SheetReadConfig): Promise<Tier2ContactRow[]> {
  const sheets = buildSheetsClient(config.credentialsPath);

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `${config.tabName}`,
  });

  const values = response.data.values ?? [];
  if (values.length < 2) return []; // no data rows

  const headers = (values[0] as string[]).map((h) => h.trim());
  const dataRows = values.slice(1) as RawRow[];

  return dataRows.map((row) => castRow(zipRow(headers, row)));
}

/**
 * Eligibility predicate for test-flow and future batch pipeline.
 *
 * A row is eligible when:
 *   1. reply_status is "pending"
 *   2. skip_reason is null or empty string (no suppression)
 *   3. next_email_date is null/empty OR its ISO date is ≤ today
 *   4. contact_email is non-empty
 */
export function isEligible(row: Tier2ContactRow): boolean {
  if (row.reply_status !== "pending") return false;
  if (row.skip_reason !== null) return false;
  if (row.contact_email === "") return false;

  if (row.next_email_date) {
    const sendOn = new Date(row.next_email_date);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (sendOn > today) return false;
  }

  return true;
}

/**
 * Return the first eligible row from the sheet, or null if none found.
 * "Eligible" is defined by `isEligible()`.
 */
export async function readEligibleRow(
  config: SheetReadConfig
): Promise<Tier2ContactRow | null> {
  const rows = await readAllRows(config);
  return rows.find(isEligible) ?? null;
}
