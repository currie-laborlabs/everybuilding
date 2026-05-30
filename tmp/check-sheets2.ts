import { google } from "googleapis";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "C:/Users/Curri/Desktop/PMHOA/everybuilding/everybuilding-temp-237f7b12ba0a.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  // Get header + first 5 data rows, columns A-Z
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: "1vTX9tMBGV4dk8EWBUzhGUeNo171h9f6Jio0v5BHzBBI",
    range: "Leads!A1:Z6",
  });
  const rows = r.data.values ?? [];
  const headers = rows[0] ?? [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const obj: Record<string,string> = {};
    headers.forEach((h: string, idx: number) => { if (row[idx]) obj[h] = row[idx]; });
    console.log(JSON.stringify(obj));
  }
  console.log(`Total rows in range: ${rows.length - 1} data rows`);
}

main().catch(e => { console.error(e.message); process.exit(1); });
