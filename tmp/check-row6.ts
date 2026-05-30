import "dotenv/config";
import { google } from "googleapis";

(async () => {
const auth = new google.auth.GoogleAuth({
  keyFile: process.env.TIER2_CREDENTIALS_PATH,
  scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
});
const sheets = google.sheets({ version: "v4", auth });

const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID!;
const tabName = process.env.TIER2_SHEET_TAB ?? "Leads_Enriched";

const res = await sheets.spreadsheets.values.get({
  spreadsheetId,
  range: `${tabName}!1:7`,
});

const rows = res.data.values ?? [];
if (rows.length === 0) {
  console.log(`No data in tab: ${tabName}`);
  process.exit(0);
}

const headers = rows[0] as string[];
// Sheet row 6 = rows[5] (rows[0] = header / sheet row 1, rows[5] = sheet row 6)
const dataRow6 = (rows[5] ?? []) as string[];

console.log(`\nTab: ${tabName} — Sheet row 6\n`);
console.log("=".repeat(72));

const TIER2_IMPORTANT = [
  "property_address", "property_id", "contact_name", "contact_title",
  "contact_email", "year_built", "square_feet", "land_use", "owner_entity",
  "permit_summary", "roof_permit_date", "last_permit_date", "permit_contractor",
  "hazard_notes", "climate_notes", "last_sale_date",
  "reply_status", "skip_reason", "next_cta_number", "next_email_date",
];

const missing: string[] = [];
const present: string[] = [];

headers.forEach((h, i) => {
  const val = dataRow6[i] ?? "";
  const tag = val === "" ? "  [EMPTY]" : "";
  if (val === "") missing.push(h);
  else present.push(h);
  console.log(`  ${h}: ${val || "(empty)"}${tag}`);
});

// Headers that exist in Tier2 important list but are either missing from sheet or empty
const criticalMissing = TIER2_IMPORTANT.filter(
  (f) => !headers.includes(f) || dataRow6[headers.indexOf(f)] === ""
);

console.log("\n" + "=".repeat(72));
console.log(`\nTotal columns in header: ${headers.length}`);
console.log(`Cells with data in row 6: ${present.length}`);
console.log(`Empty cells in row 6: ${missing.length}`);
console.log(`\nCritical fields missing or empty:`);
criticalMissing.forEach((f) => console.log(`  - ${f}`));
})();
