import { google } from "googleapis";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "C:/Users/Curri/Desktop/PMHOA/everybuilding/everybuilding-temp-237f7b12ba0a.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: "1vTX9tMBGV4dk8EWBUzhGUeNo171h9f6Jio0v5BHzBBI",
    range: "Leads!A1:AJ30",
  });
  const rows = r.data.values ?? [];
  const headers = rows[0] ?? [];
  console.log(`Total rows: ${rows.length - 1}`);
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const addr = row[headers.indexOf("property_address")] ?? "";
    const owner = row[headers.indexOf("owner_entity")] ?? "";
    const email = row[headers.indexOf("contact_email")] ?? "";
    const name = row[headers.indexOf("contact_name")] ?? "";
    const orStatus = row[headers.indexOf("owner_resolution_status")] ?? "";
    const domain = row[headers.indexOf("resolved_domain")] ?? "";
    console.log(`${addr} | ${owner} | email=${email||"NONE"} | name=${name||"NONE"} | OR=${orStatus} | domain=${domain||"NONE"}`);
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
