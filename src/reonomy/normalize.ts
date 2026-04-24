import type { RawReonomyRecord, NormalizedLead } from "../types";
import { cleanText, parseNumber, parseYear, makePropertyKey } from "../utils";

/** Fields we consider "key" — if any are empty the record is partial. */
const KEY_FIELDS: (keyof RawReonomyRecord)[] = [
  "property_address",
  "city",
  "state",
  "zip_code",
  "owner_entity",
];

/** All fields we track for missing-field notes. */
const ALL_FIELDS: { key: keyof RawReonomyRecord; label: string }[] = [
  { key: "property_address", label: "address" },
  { key: "city", label: "city" },
  { key: "state", label: "state" },
  { key: "zip_code", label: "zip" },
  { key: "owner_entity", label: "owner" },
  { key: "square_feet", label: "sqft" },
  { key: "year_built", label: "year_built" },
  { key: "land_use", label: "land_use" },
];

/**
 * Single-pass analysis of a raw record:
 * returns extraction_status and a notes string listing missing fields.
 */
function analyzeCompleteness(raw: RawReonomyRecord): {
  status: "extracted" | "partial";
  notes: string;
} {
  const missing: string[] = [];
  let keyMissing = false;

  for (const { key, label } of ALL_FIELDS) {
    if (!raw[key]?.trim()) {
      missing.push(label);
      if (KEY_FIELDS.includes(key)) keyMissing = true;
    }
  }

  return {
    status: keyMissing ? "partial" : "extracted",
    notes: missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
  };
}

/** Normalize a single raw Reonomy record into the canonical lead shape. */
export function normalizeRecord(
  raw: RawReonomyRecord,
  searchZip: string
): NormalizedLead {
  const address = cleanText(raw.property_address);
  const zip = cleanText(raw.zip_code) || searchZip;
  const { status, notes } = analyzeCompleteness(raw);

  return {
    property_id: makePropertyKey(address, zip),
    property_address: address,
    city: cleanText(raw.city),
    state: cleanText(raw.state).toUpperCase().slice(0, 2),
    zip_code: zip,
    land_use: cleanText(raw.land_use),
    square_feet: parseNumber(raw.square_feet),
    year_built: parseYear(raw.year_built),
    owner_entity: cleanText(raw.owner_entity),
    source_platform: "reonomy",
    source_search_area: searchZip,
    source_run_date: new Date().toISOString(),
    source_notes: "",
    extraction_status: status,
    reonomy_owner_name: "",
    reonomy_owner_phone: "",
    reonomy_owner_email: "",
    reonomy_contact_name: "",
    reonomy_contact_title: "",
    reonomy_contact_phone: "",
    reonomy_contact_email: "",
    reonomy_company_domain: "",
    reonomy_last_acquisition_date: "",
    reonomy_detail_status: "not_attempted",
    reonomy_detail_notes: "",
    review_status: "pending",
    notes,
  };
}

/**
 * Normalize an array of raw records.
 * - Skips records with no address.
 * - Deduplicates by property_key (keeps first occurrence).
 */
export function normalizeAll(
  records: RawReonomyRecord[],
  searchZip: string
): NormalizedLead[] {
  const seen = new Set<string>();
  const results: NormalizedLead[] = [];

  for (const raw of records) {
    if (!raw.property_address?.trim()) {
      console.warn("[normalize] Skipping record with no address.");
      continue;
    }

    const lead = normalizeRecord(raw, searchZip);

    if (seen.has(lead.property_id)) {
      console.warn(`[normalize] Duplicate skipped: ${lead.property_address}`);
      continue;
    }

    seen.add(lead.property_id);
    results.push(lead);
  }

  console.log(
    `[normalize] ${results.length} unique leads from ${records.length} raw records.`
  );
  return results;
}
