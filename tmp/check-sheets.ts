import { google } from "googleapis";

async function main() {
  const auth = new google.auth.GoogleAuth({
    keyFile: "C:/Users/Curri/Desktop/PMHOA/everybuilding/everybuilding-temp-237f7b12ba0a.json",
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });
  const r = await sheets.spreadsheets.values.get({
    spreadsheetId: "1vTX9tMBGV4dk8EWBUzhGUeNo171h9f6Jio0v5BHzBBI",
    range: "Leads!A1:D10",
  });
  console.log(JSON.stringify(r.data.values ?? "EMPTY"));
}

main().catch(e => { console.error(e.message); process.exit(1); });
