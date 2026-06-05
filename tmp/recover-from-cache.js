/**
 * recover-from-cache.js
 *
 * Recovers extracted property + contact data from the Stagehand LLM cache
 * (tmp/.cache/llm_calls.json) and writes it directly to Google Sheets.
 *
 * Usage:
 *   node tmp/recover-from-cache.js              → dry run (prints rows, no write)
 *   node tmp/recover-from-cache.js --write      → writes to Google Sheet
 *
 * Run from the scraper/ directory.
 */

const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

// ── Config ─────────────────────────────────────────────────────────────────

const CACHE_FILE = path.resolve(__dirname, ".cache/llm_calls.json");
const ENV_FILE   = path.resolve(__dirname, "../.env");

function loadEnv(file) {
  const env = {};
  if (!fs.existsSync(file)) return env;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    env[key] = val;
  }
  return env;
}

const env = loadEnv(ENV_FILE);
const CREDENTIALS_PATH  = env.GOOGLE_SHEETS_CREDENTIALS_PATH;
const SPREADSHEET_ID    = env.GOOGLE_SHEETS_SPREADSHEET_ID;
const TAB_NAME          = env.GOOGLE_SHEETS_TAB_NAME || "Diamond_Leads";
const ZIP_CODE          = env.REONOMY_ZIP_CODE || env.ZIP_CODES?.split(/[, ]+/)[0] || "";

const DRY_RUN = !process.argv.includes("--write");

// ── Sheet columns (must match saveCsv.ts SHEET_COLUMNS) ────────────────────

const SHEET_COLUMNS = [
  "property_id", "property_address", "city", "state", "zip_code",
  "land_use", "year_built", "square_feet", "owner_entity",
  "source_platform", "source_search_area", "source_run_date", "source_notes",
  "contact_name", "contact_title", "contact_email", "contact_phone",
  "contact_source", "sequence",
  "extraction_status", "enrichment_status", "verification_status", "review_status", "notes",
  "last_sale_date", "last_sale_price", "permit_summary",
  "roof_permit_date", "hvac_permit_date", "plumbing_permit_date",
  "electrical_permit_date", "restoration_permit_date", "fire_water_permit_date",
  "last_permit_date", "permit_contractor",
  "ownership_transfer_flag", "tax_or_distress_notes",
  "hazard_notes", "crime_notes", "demographics_notes", "air_quality_notes", "climate_notes",
  "owner_resolution_status", "owner_resolution_confidence",
  "resolved_company_name", "resolved_domain", "owner_resolution_source", "owner_resolution_notes",
  "registry_contact_name", "registry_contact_title",
  "contact_linkedin",
  "contact_sources", "email_source", "phone_source", "contact_confidence", "contact_enrichment_notes",
];

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalizeEntity(s) {
  return (s || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function makePropertyId(address, zip) {
  return `${address.trim().toLowerCase().replace(/\s+/g, "-")}_${zip}`;
}

function cleanEmail(e) {
  return (e || "").trim().toLowerCase();
}

function cleanPhone(p) {
  return (p || "").trim();
}

// ── Parse cache ─────────────────────────────────────────────────────────────

console.log("[recover] Reading cache...");
const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
const allEntries = Object.values(raw)
  .filter(e => e.timestamp)
  .sort((a, b) => a.timestamp - b.timestamp);

console.log(`[recover] ${allEntries.length} total cache entries`);

// Classify entries
const propertyLists = [];
const ownerTabs     = [];
const contactTables = [];
const contactPanels = [];

for (const e of allEntries) {
  const inner = e.data?.data || e.data || {};
  if (!inner) continue;

  if (Array.isArray(inner.properties) && inner.properties.length > 0) {
    propertyLists.push({ ts: e.timestamp, entries: inner.properties });
  } else if ("owner_entity" in inner || "owner_names" in inner) {
    ownerTabs.push({ ts: e.timestamp, data: inner });
  } else if (Array.isArray(inner.contacts) && inner.contacts.length > 0) {
    contactTables.push({ ts: e.timestamp, contacts: inner.contacts });
  } else if ("emails" in inner || "phones" in inner) {
    contactPanels.push({ ts: e.timestamp, emails: inner.emails || [], phones: inner.phones || [] });
  }
}

console.log(`[recover] Property list entries: ${propertyLists.length} (${propertyLists.reduce((s,p) => s + p.entries.length, 0)} properties)`);
console.log(`[recover] Owner tab entries:     ${ownerTabs.length}`);
console.log(`[recover] Contact table entries: ${contactTables.length}`);
console.log(`[recover] Contact panel entries: ${contactPanels.length}`);

// ── Build property map: normalizedOwnerEntity → property record ─────────────
// One owner can own multiple properties — keep all of them.

const propsByEntity = new Map(); // normalizedEntity → property[]
for (const pl of propertyLists) {
  for (const p of pl.entries) {
    if (!p.property_address) continue;
    const key = normalizeEntity(p.owner_entity);
    if (!propsByEntity.has(key)) propsByEntity.set(key, []);
    // Deduplicate by address
    const existing = propsByEntity.get(key);
    if (!existing.some(ex => ex.property_address === p.property_address)) {
      existing.push(p);
    }
  }
}
console.log(`[recover] Unique owner entities from property lists: ${propsByEntity.size}`);

// ── Associate each owner tab with its subsequent contacts ───────────────────
// Window: next owner tab's timestamp (or +120s if last). Anything in that
// window after the owner tab belongs to this owner.

const NOW = Date.now();

const enrichedOwners = ownerTabs.map((ot, idx) => {
  const windowEnd = idx + 1 < ownerTabs.length
    ? ownerTabs[idx + 1].ts
    : ot.ts + 120_000;

  // Contact table rows immediately after this owner tab
  const myTable = contactTables.find(ct => ct.ts > ot.ts && ct.ts < windowEnd);

  // All contact panels in this window
  const myPanels = contactPanels.filter(cp => cp.ts > ot.ts && cp.ts < windowEnd);

  // Build contacts list
  const contacts = [];

  if (myTable && myTable.contacts.length > 0) {
    // We have a contacts table — pair each table row with its panel (in order)
    myTable.contacts.forEach((row, i) => {
      const panel = myPanels[i] || { emails: [], phones: [] };
      // Also include emails/phones from the owner tab for the first contact
      // if it matches the primary_contact_name
      const tabEmails = (i === 0 && ot.data.primary_contact_name === row.name)
        ? (ot.data.emails || [])
        : [];
      const tabPhones = (i === 0 && ot.data.primary_contact_name === row.name)
        ? (ot.data.phones || [])
        : [];

      const emails = [...new Set([...tabEmails.map(cleanEmail), ...panel.emails.map(cleanEmail)].filter(Boolean))];
      const phones = [...new Set([...tabPhones.map(cleanPhone), ...panel.phones.map(cleanPhone)].filter(Boolean))];

      contacts.push({
        name: row.name || "",
        title: row.title || "",
        relationship: row.relationship || "Contact",
        emails,
        phones,
      });
    });
  } else {
    // No contacts table — use the owner tab's primary contact + its panels
    const primaryEmails = [...new Set((ot.data.emails || []).map(cleanEmail).filter(Boolean))];
    const primaryPhones = [...new Set((ot.data.phones || []).map(cleanPhone).filter(Boolean))];

    // Merge all panels into the primary contact (since we can't tell who's who)
    for (const panel of myPanels) {
      for (const e of panel.emails) { const c = cleanEmail(e); if (c && !primaryEmails.includes(c)) primaryEmails.push(c); }
      for (const p of panel.phones) { const c = cleanPhone(p); if (c && !primaryPhones.includes(c)) primaryPhones.push(c); }
    }

    if (ot.data.primary_contact_name || primaryEmails.length > 0) {
      contacts.push({
        name: ot.data.primary_contact_name || "",
        title: ot.data.primary_contact_title || "",
        relationship: "Principal",
        emails: primaryEmails,
        phones: primaryPhones,
      });
    }

    // owner_names (individual property owners with no company)
    for (const ownerName of (ot.data.owner_names || [])) {
      if (!ownerName) continue;
      if (!contacts.some(c => c.name === ownerName)) {
        contacts.push({ name: ownerName, title: "", relationship: "Owner", emails: [], phones: [] });
      }
    }
  }

  return {
    ts: ot.ts,
    owner_entity: ot.data.owner_entity || (ot.data.owner_names || [])[0] || "",
    owner_entity_key: normalizeEntity(ot.data.owner_entity || (ot.data.owner_names || [])[0] || ""),
    last_acquisition_date: ot.data.last_acquisition_date || "",
    contacts,
  };
});

console.log(`[recover] Enriched owner entries: ${enrichedOwners.length}`);
console.log(`[recover] Owner entries with contacts: ${enrichedOwners.filter(o => o.contacts.length > 0).length}`);

// ── Build output rows ───────────────────────────────────────────────────────

const runDate = new Date().toISOString();
const outputRows = []; // { ...fields }
const seenEmails = new Set();
const seenPhoneKeys = new Set(); // "name|phone" — dedup phone-only rows

for (const owner of enrichedOwners) {
  // Find matching properties
  let props = propsByEntity.get(owner.owner_entity_key) || [];

  // Fallback: fuzzy match — try partial entity name
  if (props.length === 0 && owner.owner_entity) {
    const ownerWords = owner.owner_entity_key.split(" ").filter(w => w.length > 3);
    for (const [key, value] of propsByEntity) {
      if (ownerWords.some(w => key.includes(w))) {
        props = value;
        break;
      }
    }
  }

  // If still no match, create a placeholder property row
  if (props.length === 0) {
    props = [{
      property_address: "",
      city: "",
      state: "CA",
      zip_code: ZIP_CODE,
      land_use: "",
      square_feet: "",
      year_built: "",
      owner_entity: owner.owner_entity,
    }];
  }

  for (const prop of props) {
    const propertyId = makePropertyId(prop.property_address || owner.owner_entity, prop.zip_code || ZIP_CODE);

    if (owner.contacts.length === 0) {
      // No contacts — still emit a property row with blank contact fields
      outputRows.push({
        property_id: propertyId,
        property_address: prop.property_address || "",
        city: prop.city || "",
        state: prop.state || "CA",
        zip_code: prop.zip_code || ZIP_CODE,
        land_use: prop.land_use || "",
        year_built: prop.year_built || "",
        square_feet: prop.square_feet || "",
        owner_entity: prop.owner_entity || owner.owner_entity,
        source_platform: "reonomy",
        source_search_area: ZIP_CODE,
        source_run_date: runDate,
        source_notes: "recovered_from_cache",
        contact_name: "",
        contact_title: "",
        contact_email: "",
        contact_phone: "",
        contact_source: "reonomy",
        sequence: "1",
        extraction_status: "extracted",
        enrichment_status: "skipped",
        verification_status: "skipped",
        review_status: "pending",
        notes: owner.last_acquisition_date ? `last_acquisition: ${owner.last_acquisition_date}` : "",
      });
      continue;
    }

    // One row per email (or per phone if no email), matching pipeline logic
    let seqIdx = 1;
    for (const contact of owner.contacts) {
      const rowCount = Math.max(contact.emails.length, contact.phones.length, 1);
      for (let j = 0; j < rowCount; j++) {
        const email = contact.emails[j] || "";
        const phone = contact.phones[j] || "";

        // Skip duplicate emails (within this recovery run)
        if (email && seenEmails.has(email)) continue;
        if (email) seenEmails.add(email);

        // Skip duplicate phone-only rows (same name+phone already seen)
        if (!email && phone) {
          const phoneKey = `${contact.name}|${phone}`;
          if (seenPhoneKeys.has(phoneKey)) continue;
          seenPhoneKeys.add(phoneKey);
        }

        // Skip rows with no signal at all (no email, no phone)
        if (!email && !phone && !contact.name) continue;

        outputRows.push({
          property_id: propertyId,
          property_address: prop.property_address || "",
          city: prop.city || "",
          state: prop.state || "CA",
          zip_code: prop.zip_code || ZIP_CODE,
          land_use: prop.land_use || "",
          year_built: prop.year_built || "",
          square_feet: prop.square_feet || "",
          owner_entity: prop.owner_entity || owner.owner_entity,
          source_platform: "reonomy",
          source_search_area: ZIP_CODE,
          source_run_date: runDate,
          source_notes: "recovered_from_cache",
          contact_name: contact.name || "",
          contact_title: contact.title || "",
          contact_email: email,
          contact_phone: phone,
          contact_source: "reonomy",
          sequence: String(seqIdx++),
          extraction_status: "extracted",
          enrichment_status: "skipped",
          verification_status: "skipped",
          review_status: "pending",
          notes: owner.last_acquisition_date ? `last_acquisition: ${owner.last_acquisition_date}` : "",
        });
      }
    }
  }
}

console.log(`\n[recover] ── RECOVERY SUMMARY ─────────────────────`);
console.log(`[recover] Total output rows built: ${outputRows.length}`);
console.log(`[recover] Rows with email:         ${outputRows.filter(r => r.contact_email).length}`);
console.log(`[recover] Rows without email:      ${outputRows.filter(r => !r.contact_email).length}`);
console.log(`[recover] Unique emails:           ${seenEmails.size}`);

if (DRY_RUN) {
  console.log(`\n[recover] DRY RUN — first 10 rows:`);
  outputRows.slice(0, 10).forEach((r, i) => {
    console.log(`  [${i+1}] ${r.property_address || "(no address)"} | ${r.owner_entity} | ${r.contact_name} | ${r.contact_email} | ${r.contact_phone}`);
  });
  console.log(`\n[recover] Run with --write to write to Google Sheets.`);
  process.exit(0);
}

// ── Write to Google Sheets ──────────────────────────────────────────────────

console.log(`\n[recover] Writing to Google Sheets...`);
console.log(`[recover] Spreadsheet: ${SPREADSHEET_ID}`);
console.log(`[recover] Tab:         ${TAB_NAME}`);

async function writeToSheet() {
  const auth = new google.auth.GoogleAuth({
    keyFile: CREDENTIALS_PATH,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  const sheets = google.sheets({ version: "v4", auth });

  // Read existing emails to deduplicate against the sheet
  const emailColIdx = SHEET_COLUMNS.indexOf("contact_email");
  const emailColLetter = String.fromCharCode("A".charCodeAt(0) + emailColIdx);
  const existing = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!${emailColLetter}:${emailColLetter}`,
  });
  const existingEmails = new Set(
    (existing.data.values || [])
      .map(r => (r[0] || "").trim().toLowerCase())
      .filter(e => e && e !== "contact_email")
  );
  console.log(`[recover] ${existingEmails.size} emails already in sheet`);

  // Filter rows
  const newRows = outputRows.filter(r => {
    const e = r.contact_email.trim().toLowerCase();
    return !e || !existingEmails.has(e);
  });
  console.log(`[recover] ${outputRows.length - newRows.length} rows skipped (already in sheet)`);
  console.log(`[recover] ${newRows.length} rows to append`);

  if (newRows.length === 0) {
    console.log("[recover] Nothing new to write.");
    return;
  }

  // Check if sheet is empty (write header if so)
  const peek = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${TAB_NAME}!A1:A1`,
  });
  const isEmpty = !peek.data.values || peek.data.values.length === 0;

  if (isEmpty) {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [SHEET_COLUMNS] },
    });
    console.log("[recover] Header row written.");
  }

  // Convert rows to 2D array in column order
  const values = newRows.map(row =>
    SHEET_COLUMNS.map(col => {
      const v = row[col];
      return (v === null || v === undefined) ? "" : String(v);
    })
  );

  // Batch append in chunks of 500
  const CHUNK = 500;
  let appended = 0;
  for (let i = 0; i < values.length; i += CHUNK) {
    const chunk = values.slice(i, i + CHUNK);
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${TAB_NAME}!A1`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: chunk },
    });
    appended += chunk.length;
    console.log(`[recover] Appended ${appended}/${values.length} rows...`);
  }

  console.log(`\n[recover] ── DONE ──────────────────────────────────`);
  console.log(`[recover] Rows appended: ${appended}`);
  console.log(`[recover] Sheet: https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}`);
}

writeToSheet().catch(err => {
  console.error("[recover] ERROR:", err.message || err);
  process.exit(1);
});
