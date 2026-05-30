/**
 * src/enrich.ts
 *
 * Offline enrichment script — no Stagehand, no browser automation.
 *
 * Reads every row where enrichment_status="skipped" from the Google Sheet,
 * runs ATTOM + Apollo + Hunter + ZeroBounce enrichment, and writes the
 * results back in-place. Extra contacts found beyond existing rows are
 * appended as new rows.
 *
 * Typical workflow:
 *   1. Run the main scraper with REONOMY_ONLY=true  →  sheet filled with raw Reonomy data
 *   2. Run:  npm run enrich                         →  enrichment columns filled in
 *
 * Run: npm run enrich
 */

import { randomUUID } from "crypto";
import { google } from "googleapis";
import PQueue from "p-queue";
import { config } from "./config";
import { AttomClient } from "./enrichment/attom";
import { BatchDataPropertyClient } from "./enrichment/batchdata-property";
import { ApolloClient } from "./enrichment/contacts/apollo";
import { HunterClient } from "./enrichment/contacts/hunter";
import { PdlClient } from "./enrichment/contacts/pdl";
import { BatchDataSkipTraceClient } from "./enrichment/contacts/batchdata";
import { enrichContactsForLead } from "./enrichment/contacts/flow";
import { sequenceForIndex } from "./enrichment/contacts/merge";
import { ZeroBounceClient } from "./enrichment/verification/zerobounce";
import { SqliteIdempotencyStore } from "./pipeline/idempotency";
import { SHEET_COLUMNS, saveToGoogleSheet } from "./output/saveCsv";
// ── Owner Resolution (optional, disabled by default) ──────────────────────────
import {
  OwnerResolver,
  resolveOwnerSafe,
} from "./enrichment/owner-resolution/index";
import type { OwnerResolutionResult } from "./enrichment/owner-resolution/index";
// ──────────────────────────────────────────────────────────────────────────────
import type {
  ContactCandidate,
  EnrichedPropertyLead,
  NormalizedLead,
  ReonomyContact,
  Tier1ContactRow,
} from "./types";

// ─── sheet helpers ────────────────────────────────────────────────────────────

/** Convert a 0-based column index to a spreadsheet letter (A, B, ..., Z, AA, ...). */
function colLetter(index: number): string {
  let result = "";
  let n = index;
  while (n >= 0) {
    result = String.fromCharCode((n % 26) + 65) + result;
    n = Math.floor(n / 26) - 1;
  }
  return result;
}

/** The last column letter based on the SHEET_COLUMNS definition. */
const LAST_COL = colLetter(SHEET_COLUMNS.length - 1);

function toCellValue(value: string | number | null | undefined): string | number {
  if (value === null || value === undefined) return "";
  return value;
}

function rowToValues(row: Tier1ContactRow): (string | number)[] {
  // Use ?? null so optional owner_resolution_* fields (undefined) become empty cells
  return SHEET_COLUMNS.map((col) => toCellValue(row[col] ?? null));
}

function buildSheetsClient() {
  const auth = new google.auth.GoogleAuth({
    keyFile: config.output.googleSheets.credentialsPath,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

// ─── lead reconstruction ─────────────────────────────────────────────────────

/**
 * Extract the domain part from an email address.
 * Returns "" when the email is empty or has no "@".
 * e.g. "john@acmeroofing.com" → "acmeroofing.com"
 */
function extractEmailDomain(email: string): string {
  const trimmed = email.trim().toLowerCase();
  const at = trimmed.lastIndexOf("@");
  return at >= 0 ? trimmed.slice(at + 1) : "";
}

/**
 * Rebuild a NormalizedLead from a raw sheet row (parsed from header map).
 * contact_* fields in the sheet were originally reonomy_contact_* values.
 */
function sheetRowToNormalizedLead(row: Record<string, string>): NormalizedLead {
  const yearBuilt = parseInt(row.year_built ?? "", 10);
  const squareFeet = parseInt(row.square_feet ?? "", 10);

  return {
    property_id: row.property_id ?? "",
    property_address: row.property_address ?? "",
    city: row.city ?? "",
    state: row.state ?? "",
    zip_code: row.zip_code ?? "",
    land_use: row.land_use ?? "",
    year_built: Number.isFinite(yearBuilt) ? yearBuilt : null,
    square_feet: Number.isFinite(squareFeet) ? squareFeet : null,
    owner_entity: row.owner_entity ?? "",
    source_platform: "reonomy",
    source_search_area: row.source_search_area ?? "",
    source_run_date: row.source_run_date ?? "",
    source_notes: row.source_notes ?? "",
    extraction_status: row.extraction_status === "partial" ? "partial" : "extracted",
    reonomy_owner_name: "",
    reonomy_owner_phone: "",
    reonomy_owner_email: "",
    // Reonomy contact fields were saved into the generic contact_* columns.
    reonomy_contact_name: row.contact_name ?? "",
    reonomy_contact_title: row.contact_title ?? "",
    reonomy_contact_phone: row.contact_phone ?? "",
    reonomy_contact_email: row.contact_email ?? "",
    // Seed domain from owner-resolution result first, then fall back to
    // extracting it from any email already on the row (Reonomy or previous
    // enrichment run). This lets Hunter + Apollo run domain-based searches
    // even when no explicit domain was scraped from Reonomy.
    reonomy_company_domain:
      row.resolved_domain?.trim() ||
      extractEmailDomain(row.contact_email ?? ""),
    reonomy_last_acquisition_date: row.last_sale_date ?? "",
    reonomy_detail_status:
      row.contact_name || row.contact_email ? "success" : "not_attempted",
    reonomy_detail_notes: "",
    reonomy_contacts_json: "[]",
    review_status: "pending",
    notes: "",
  };
}

function buildReonomyCandidates(lead: NormalizedLead): ContactCandidate[] {
  const candidates: ContactCandidate[] = [];

  // 1. Parse reonomy_contacts_json — ALL contacts extracted from the property
  //    detail Owner tab + "View All Contacts" page.
  //
  //    Row explosion rules (per person):
  //      - emails drive row count: one row per email
  //      - phones are zipped with emails: row[0] gets phones[0], row[1] gets phones[1], etc.
  //      - extra emails beyond the phone count get an empty phone cell
  //      - if no emails but phone(s) exist: one row per phone (email = "")
  //      - if neither: one row with just the name/title (skipped downstream if no signal)
  if (lead.reonomy_contacts_json && lead.reonomy_contacts_json !== "[]") {
    try {
      const contacts = JSON.parse(lead.reonomy_contacts_json) as ReonomyContact[];
      for (const c of contacts) {
        if (!c.name) continue;

        // Row count = whichever is larger: emails or phones (minimum 1)
        // Row[i] gets emails[i] (or "") and phones[i] (or "").
        // So 3 phones + 2 emails → 3 rows: rows 1-2 have both, row 3 has phone only.
        const rowCount = Math.max(c.emails.length, c.phones.length, 1);
        for (let j = 0; j < rowCount; j++) {
          const email = (c.emails[j] ?? "").toLowerCase().trim();
          const phone = (c.phones[j] ?? "").trim();
          candidates.push({
            property_id: lead.property_id,
            owner_entity: lead.owner_entity,
            contact_name: c.name,
            contact_title: c.title,
            contact_phone: phone,
            contact_email: email,
            contact_source: "reonomy",
            confidence: email ? 0.95 : phone ? 0.75 : 0.5,
          });
        }
      }
      if (candidates.length > 0) return candidates;
    } catch {
      // JSON parse failed — fall through to legacy single-contact path
    }
  }

  // 2. Legacy fallback: single contact stored in reonomy_contact_* fields
  //    (used for rows that were scraped before multi-contact support was added,
  //    or when reonomy_contacts_json is empty/missing)
  if (
    lead.reonomy_contact_name ||
    lead.reonomy_contact_title ||
    lead.reonomy_contact_email
  ) {
    candidates.push({
      property_id: lead.property_id,
      owner_entity: lead.owner_entity,
      contact_name: lead.reonomy_contact_name,
      contact_title: lead.reonomy_contact_title,
      contact_phone: lead.reonomy_contact_phone,
      contact_email: lead.reonomy_contact_email,
      contact_source: "reonomy",
      confidence: lead.reonomy_contact_email ? 0.95 : 0.75,
    });
  }
  return candidates;
}

/** Build a full Tier1ContactRow from enriched lead + contact candidate. */
function buildRow(
  enriched: EnrichedPropertyLead,
  candidate: ContactCandidate,
  verificationStatus: string,
  idx: number,
  resolutionResult?: OwnerResolutionResult | null  // Optional — populated when OWNER_RESOLUTION_ENABLED=true
): Tier1ContactRow {
  const ownerMeta: Partial<Tier1ContactRow> = resolutionResult
    ? {
        owner_resolution_status: resolutionResult.resolution_status,
        owner_resolution_confidence: resolutionResult.confidence_score,
        resolved_company_name: resolutionResult.candidate_company_name,
        resolved_domain: resolutionResult.candidate_domain,
        owner_resolution_source: resolutionResult.resolution_source,
        owner_resolution_notes: resolutionResult.notes,
        registry_contact_name: resolutionResult.registry_contact_name ?? "",
        registry_contact_title: resolutionResult.registry_contact_title ?? "",
      }
    : {};

  return {
    property_id: enriched.property_id,
    property_address: enriched.property_address,
    city: enriched.city,
    state: enriched.state,
    zip_code: enriched.zip_code,
    land_use: enriched.land_use,
    year_built: enriched.year_built,
    square_feet: enriched.square_feet,
    owner_entity: enriched.owner_entity,
    source_platform: enriched.source_platform,
    source_search_area: enriched.source_search_area,
    source_run_date: enriched.source_run_date,
    source_notes: enriched.source_notes,
    contact_name: candidate.contact_name,
    contact_title: candidate.contact_title,
    contact_email: candidate.contact_email,
    contact_phone: candidate.contact_phone,
    contact_source: candidate.contact_source,
    contact_sources: (candidate.contact_sources ?? [candidate.contact_source])
      .filter((source) => source !== "hybrid")
      .join(","),
    email_source: candidate.email_source ?? (candidate.contact_email ? candidate.contact_source : ""),
    phone_source: candidate.phone_source ?? (candidate.contact_phone ? candidate.contact_source : ""),
    contact_confidence: candidate.confidence,
    contact_enrichment_notes: candidate.contact_enrichment_notes ?? "",
    sequence: sequenceForIndex(idx),
    extraction_status: enriched.extraction_status,
    enrichment_status: enriched.enrichment_status,
    verification_status: verificationStatus,
    review_status: enriched.review_status,
    notes: candidate.contact_email
      ? enriched.reonomy_detail_notes || ""
      : `${enriched.reonomy_detail_notes ? enriched.reonomy_detail_notes + "; " : ""}Missing email`,
    last_sale_date: enriched.last_sale_date || enriched.reonomy_last_acquisition_date,
    last_sale_price: enriched.last_sale_price,
    permit_summary: enriched.permit_summary,
    roof_permit_date: enriched.roof_permit_date,
    hvac_permit_date: enriched.hvac_permit_date,
    plumbing_permit_date: enriched.plumbing_permit_date,
    electrical_permit_date: enriched.electrical_permit_date,
    restoration_permit_date: enriched.restoration_permit_date,
    fire_water_permit_date: enriched.fire_water_permit_date,
    last_permit_date: enriched.last_permit_date,
    permit_contractor: enriched.permit_contractor,
    ownership_transfer_flag: enriched.ownership_transfer_flag,
    tax_or_distress_notes: enriched.tax_or_distress_notes,
    hazard_notes: enriched.hazard_notes,
    crime_notes: enriched.crime_notes,
    demographics_notes: enriched.demographics_notes,
    air_quality_notes: enriched.air_quality_notes,
    climate_notes: enriched.climate_notes,
    contact_linkedin: candidate.contact_linkedin ?? "",
    ...ownerMeta,
  };
}

/**
 * When no new contacts are found, keep the existing contact fields from the sheet
 * and only update the ATTOM enrichment columns.
 */
function buildRowKeepingExistingContact(
  enriched: EnrichedPropertyLead,
  existingRow: Record<string, string>
): Tier1ContactRow {
  return {
    property_id: enriched.property_id,
    property_address: enriched.property_address,
    city: enriched.city,
    state: enriched.state,
    zip_code: enriched.zip_code,
    land_use: enriched.land_use,
    year_built: enriched.year_built,
    square_feet: enriched.square_feet,
    owner_entity: enriched.owner_entity,
    source_platform: enriched.source_platform,
    source_search_area: enriched.source_search_area,
    source_run_date: enriched.source_run_date,
    source_notes: enriched.source_notes,
    // Preserve whatever contact info already existed in the sheet
    contact_name: existingRow.contact_name ?? "",
    contact_title: existingRow.contact_title ?? "",
    contact_email: existingRow.contact_email ?? "",
    contact_phone: existingRow.contact_phone ?? "",
    contact_source: existingRow.contact_source ?? "",
    contact_sources: existingRow.contact_sources ?? existingRow.contact_source ?? "",
    email_source: existingRow.email_source ?? "",
    phone_source: existingRow.phone_source ?? "",
    contact_confidence: parseFloat(existingRow.contact_confidence ?? "") || undefined,
    contact_enrichment_notes: existingRow.contact_enrichment_notes ?? "",
    sequence: (existingRow.sequence as Tier1ContactRow["sequence"]) || "Primary",
    extraction_status: enriched.extraction_status,
    enrichment_status: enriched.enrichment_status,
    verification_status: existingRow.contact_email ? "unverified" : "skipped",
    review_status: enriched.review_status,
    notes: enriched.reonomy_detail_notes || existingRow.notes || "",
    last_sale_date: enriched.last_sale_date || enriched.reonomy_last_acquisition_date,
    last_sale_price: enriched.last_sale_price,
    permit_summary: enriched.permit_summary,
    roof_permit_date: enriched.roof_permit_date,
    hvac_permit_date: enriched.hvac_permit_date,
    plumbing_permit_date: enriched.plumbing_permit_date,
    electrical_permit_date: enriched.electrical_permit_date,
    restoration_permit_date: enriched.restoration_permit_date,
    fire_water_permit_date: enriched.fire_water_permit_date,
    last_permit_date: enriched.last_permit_date,
    permit_contractor: enriched.permit_contractor,
    ownership_transfer_flag: enriched.ownership_transfer_flag,
    tax_or_distress_notes: enriched.tax_or_distress_notes,
    hazard_notes: enriched.hazard_notes,
    crime_notes: enriched.crime_notes,
    demographics_notes: enriched.demographics_notes,
    air_quality_notes: enriched.air_quality_notes,
    climate_notes: enriched.climate_notes,
    contact_linkedin: existingRow.contact_linkedin ?? "",
    // Preserve owner resolution fields — never blank them on re-enrich
    owner_resolution_status: existingRow.owner_resolution_status ?? "",
    owner_resolution_confidence: parseFloat(existingRow.owner_resolution_confidence ?? "") || undefined,
    resolved_company_name: existingRow.resolved_company_name ?? "",
    resolved_domain: existingRow.resolved_domain ?? "",
    owner_resolution_source: existingRow.owner_resolution_source ?? "",
    owner_resolution_notes: existingRow.owner_resolution_notes ?? "",
    registry_contact_name: existingRow.registry_contact_name ?? "",
    registry_contact_title: existingRow.registry_contact_title ?? "",
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();
  const { credentialsPath, spreadsheetId, tabName } = config.output.googleSheets;

  const outputTab = process.env.ENRICH_OUTPUT_TAB?.trim() || null;

  console.log("==============================================");
  console.log("  EVERYBUILDING — Offline Enrichment (Tier 1)");
  console.log("==============================================");
  console.log(`Spreadsheet : ${spreadsheetId}`);
  console.log(`Source tab  : ${tabName}`);
  if (outputTab) {
    console.log(`Output tab  : ${outputTab} (source tab will NOT be modified)`);
  } else {
    console.log(`Output mode : in-place (updates source tab directly)`);
  }
  console.log("----------------------------------------------");

  // ── 1. Read the sheet ─────────────────────────────────────────────────────
  console.log("\n[enrich] Reading sheet...");
  const sheets = buildSheetsClient();

  const sheetResponse = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: tabName,
  });

  const values = sheetResponse.data.values ?? [];
  if (values.length < 2) {
    console.log("[enrich] Sheet has no data rows. Nothing to enrich.");
    return;
  }

  const headers = (values[0] as string[]).map((h: string) => h.trim());
  const dataRows = values.slice(1) as string[][];

  // Each entry stores the 1-based sheet row number (row 1 = header, row 2 = first data row).
  type SheetRow = { sheetRowIndex: number; data: Record<string, string> };

  const allSheetRows: SheetRow[] = dataRows.map((row, i) => {
    const data: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      data[headers[j]] = row[j] ?? "";
    }
    return { sheetRowIndex: i + 2, data };
  });

  // ── 2. Filter rows to enrich ──────────────────────────────────────────────
  // ENRICH_ALL=true → process every data row regardless of enrichment_status.
  // Default behaviour: only rows where enrichment_status is blank or "skipped".
  const enrichAll = process.env.ENRICH_ALL === "true";
  const unenriched = enrichAll
    ? allSheetRows
    : allSheetRows.filter(
        (r) => r.data.enrichment_status === "skipped" || r.data.enrichment_status === ""
      );

  if (unenriched.length === 0) {
    console.log("[enrich] No rows to enrich. Set ENRICH_ALL=true to force-reprocess all rows.");
    return;
  }

  if (enrichAll) {
    console.log(`[enrich] ENRICH_ALL=true — processing all ${unenriched.length} row(s).`);
  } else {
    console.log(`[enrich] Found ${unenriched.length} unenriched row(s).`);
  }

  // ── 3. Group by property_id ───────────────────────────────────────────────
  const byProperty = new Map<string, SheetRow[]>();
  for (const row of unenriched) {
    const pid = row.data.property_id || row.data.property_address; // fallback key
    if (!byProperty.has(pid)) byProperty.set(pid, []);
    byProperty.get(pid)!.push(row);
  }

  const enrichLimit = parseInt(process.env.ENRICH_LIMIT ?? "0", 10);
  const propertyEntries = enrichLimit > 0
    ? Array.from(byProperty.entries()).slice(0, enrichLimit)
    : Array.from(byProperty.entries());

  console.log(
    `[enrich] ${byProperty.size} unique propert${byProperty.size === 1 ? "y" : "ies"} to enrich.`
    + (enrichLimit > 0 ? ` (capped at ${enrichLimit} by ENRICH_LIMIT)` : "")
  );

  // ── 4. Build API clients ──────────────────────────────────────────────────
  const clientOpts = {
    maxAttempts: config.run.stageMaxAttempts,
    baseDelayMs: config.run.stageRetryBaseDelayMs,
    maxDelayMs: config.run.stageRetryMaxDelayMs,
    circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
    circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
  };

  const attomClient = new AttomClient({
    ...clientOpts,
    apiKey: config.providers.attom.apiKey,
    baseUrl: config.providers.attom.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.attomPerSecond,
  });
  const apolloClient = new ApolloClient({
    ...clientOpts,
    apiKey: config.providers.apollo.apiKey,
    baseUrl: config.providers.apollo.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.apolloPerSecond,
  });
  const hunterClient = new HunterClient({
    ...clientOpts,
    apiKey: config.providers.hunter.apiKey,
    baseUrl: config.providers.hunter.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.hunterPerSecond,
  });
  const pdlClient = new PdlClient({
    ...clientOpts,
    apiKey: config.providers.pdl.apiKey,
    baseUrl: config.providers.pdl.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.pdlPerSecond,
    maxResultsPerSearch: config.providers.pdl.maxResultsPerSearch,
  });
  const batchdataSkipTraceClient = new BatchDataSkipTraceClient({
    ...clientOpts,
    apiKey: config.providers.batchdata.apiKey,
    baseUrl: config.providers.batchdata.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
  });
  const batchdataPropertyClient = new BatchDataPropertyClient({
    ...clientOpts,
    apiKey: config.providers.batchdata.apiKey,
    baseUrl: config.providers.batchdata.baseUrl,
    enabled: config.providers.batchdata.propertyEnrich,
    ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
  });
  const zeroBounceClient = new ZeroBounceClient({
    ...clientOpts,
    apiKey: config.providers.zerobounce.apiKey,
    baseUrl: config.providers.zerobounce.baseUrl,
    ratePerSecond: config.reliability.providerRateLimits.zerobouncePerSecond,
  });

  const idempotencyStore = new SqliteIdempotencyStore(config.localStore.sqlitePath);
  await idempotencyStore.initialize();

  const runId = randomUUID();

  // ── Owner Resolver (optional) ────────────────────────────────────────────
  const ownerResolver = config.ownerResolution.enabled
    ? new OwnerResolver(
        config.ownerResolution,
        config.providers.hunter.apiKey,
        config.providers.apollo.apiKey,
        config.ownerResolution.serperApiKey,
        config.ownerResolution.opencorporatesApiKey,
        config.ownerResolution.cobaltApiKey,
        config.ownerResolution.cobaltBaseUrl
      )
    : undefined;

  if (ownerResolver) {
    console.log("[enrich] Owner Resolution Layer: ENABLED");
  }
  // ────────────────────────────────────────────────────────────────────────

  // ── 5. Enrich each property concurrently ──────────────────────────────────
  // Accumulate batch write data — written in one API call at the end.
  const batchUpdateData: { range: string; values: (string | number)[][] }[] = [];
  const rowsToAppend: (string | number)[][] = [];
  const allOutputRows: Tier1ContactRow[] = [];
  const outputSeenEmails = new Set<string>();
  let updatedCount = 0;
  let appendedCount = 0;

  const enrichQueue = new PQueue({ concurrency: config.run.enrichmentConcurrency });
  const verifyQueue = new PQueue({ concurrency: config.run.verificationConcurrency });

  const tasks = propertyEntries.map(([, sheetRows]) =>
    enrichQueue.add(async () => {
      const firstRow = sheetRows[0];
      const lead = sheetRowToNormalizedLead(firstRow.data);

      console.log(
        `[enrich] → ${lead.property_id} | ${lead.property_address}, ${lead.city}`
      );

      // ATTOM enrichment (skip via SKIP_ATTOM=true in .env)
      // BatchData property enrichment can run after ATTOM or directly from the
      // lead when ATTOM is skipped (fills any still-empty property fields).
      let enriched: EnrichedPropertyLead = config.run.skipAttom
        ? ({ ...lead, enrichment_status: "skipped", permit_type: "" } as unknown as EnrichedPropertyLead)
        : await attomClient.enrichLead(lead);

      if (config.providers.batchdata.propertyEnrich) {
        enriched = await batchdataPropertyClient.enrichLead(enriched);
      }

      // ── Owner Resolution (optional) ──────────────────────────────────────
      let effectiveEnriched = enriched;
      let ownerResolutionResult: OwnerResolutionResult | null = null;

      // If the user has already manually set (or confirmed) a resolved_domain
      // in the sheet, respect it — don't re-run owner resolution and overwrite it.
      const existingResolvedDomain = firstRow.data.resolved_domain?.trim();

      // If no resolved_domain, check whether any existing row for this property
      // already has a contact email whose domain name-matches the owner entity.
      // e.g. owner="Whiteford Properties Inc", email="bret@whitefordtax.com"
      // → domain "whitefordtax" is a substring of "whiteford properties" → use it.
      // This is more reliable than a web-search resolution because it comes from
      // an actual real person's email.
      const GENERIC_EMAIL_DOMAINS = new Set([
        "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
        "aol.com", "icloud.com", "live.com", "msn.com", "me.com",
      ]);
      function domainMatchesOwner(domain: string, ownerEntity: string): boolean {
        if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) return false;
        const ownerNorm = ownerEntity.toLowerCase().replace(/[^a-z0-9]/g, "");
        const domainBase = domain.split(".")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
        if (domainBase.length < 4) return false;
        // Check if the domain stem appears in the owner name or vice versa
        return ownerNorm.includes(domainBase) || domainBase.includes(ownerNorm.slice(0, Math.max(4, ownerNorm.length - 3)));
      }
      const emailBasedDomain = !existingResolvedDomain
        ? sheetRows
            .map((r) => extractEmailDomain(r.data.contact_email ?? ""))
            .find((d) => domainMatchesOwner(d, lead.owner_entity))
        : undefined;

      const resolvedDomainToUse = existingResolvedDomain || emailBasedDomain;

      if (resolvedDomainToUse) {
        // Reconstruct result from existing sheet data so it gets preserved on write-back
        ownerResolutionResult = {
          property_id: lead.property_id,
          raw_owner_name: lead.owner_entity,
          normalized_owner_name: firstRow.data.resolved_company_name ?? lead.owner_entity,
          matched_signals: emailBasedDomain ? ["email_domain_owner_match"] : [],
          resolution_status: emailBasedDomain
            ? "resolved"
            : (firstRow.data.owner_resolution_status as OwnerResolutionResult["resolution_status"]) || "resolved",
          confidence_score: emailBasedDomain
            ? 90
            : parseFloat(firstRow.data.owner_resolution_confidence ?? "") || 0,
          candidate_company_name: firstRow.data.resolved_company_name ?? "",
          candidate_domain: resolvedDomainToUse,
          resolution_source: emailBasedDomain
            ? "email_domain"
            : (firstRow.data.owner_resolution_source as OwnerResolutionResult["resolution_source"]) || "manual",
          notes: emailBasedDomain
            ? `Domain inferred from existing contact email — matches owner entity name`
            : firstRow.data.owner_resolution_notes ?? "",
        };
        effectiveEnriched = { ...enriched, reonomy_company_domain: resolvedDomainToUse };
        console.log(`[enrich] Domain from ${emailBasedDomain ? "contact email" : "existing resolved_domain"}: ${resolvedDomainToUse}`);
      } else if (ownerResolver) {
        ownerResolutionResult = await resolveOwnerSafe(enriched, ownerResolver);
        if (
          ownerResolutionResult.resolution_status === "resolved" ||
          ownerResolutionResult.resolution_status === "needs_review"
        ) {
          effectiveEnriched = {
            ...enriched,
            owner_entity:
              ownerResolutionResult.candidate_company_name || enriched.owner_entity,
            reonomy_company_domain:
              ownerResolutionResult.candidate_domain || enriched.reonomy_company_domain,
          };
        }
      }
      // ─────────────────────────────────────────────────────────────────────

      // Contact enrichment — run BatchData first so any business-domain signal
      // it finds can feed the usual provider searches.
      const reonomyCandidates = buildReonomyCandidates(lead);
      const contactFlow = await enrichContactsForLead(
        effectiveEnriched,
        reonomyCandidates,
        { apolloClient, hunterClient, pdlClient, batchdataSkipTraceClient },
        (message) => console.log(`[enrich] -> ${message}`)
      );
      effectiveEnriched = contactFlow.effectiveLead;
      const merged = contactFlow.candidates;
      /*

      const batchdataBusinessDomain = batchdataCandidates
        .map((candidate) => extractEmailDomain(candidate.contact_email))
        .find((domain) => {
          if (!domain) return false;
          const genericDomains = new Set([
            "gmail.com", "yahoo.com", "hotmail.com", "outlook.com",
            "aol.com", "icloud.com", "live.com", "msn.com", "me.com",
            "proton.me", "protonmail.com",
          ]);
          return !genericDomains.has(domain);
        });

      if (!effectiveEnriched.reonomy_company_domain?.trim() && batchdataBusinessDomain) {
        effectiveEnriched = {
          ...effectiveEnriched,
          reonomy_company_domain: batchdataBusinessDomain,
        };
        console.log(`[enrich] Domain from BatchData: ${batchdataBusinessDomain}`);
      }

      const [apolloCandidates, hunterCandidates, pdlCandidates] = await Promise.all([
        apolloClient.findContacts(effectiveEnriched),
        hunterClient.findContacts(effectiveEnriched),
        pdlClient.findContacts(effectiveEnriched),
      ]);

      // ── Domain expansion — round 2 ───────────────────────────────────────
      // Collect any email domains returned by round 1 that differ from the
      // domain we already searched. For each new domain, fire Apollo +
      // Hunter + PDL domain-searches in parallel to discover sibling contacts.
      const searchedDomain = effectiveEnriched.reonomy_company_domain.trim().toLowerCase();
      const expansionDomains = new Set<string>();
      const GENERIC_DOMAIN_BLOCKLIST = new Set([
        "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
        "icloud.com", "live.com", "msn.com", "me.com", "proton.me", "protonmail.com",
      ]);
      for (const c of [...apolloCandidates, ...hunterCandidates, ...pdlCandidates, ...batchdataCandidates]) {
        const d = extractEmailDomain(c.contact_email);
        if (!d) continue;
        if (d === searchedDomain) continue;
        if (GENERIC_DOMAIN_BLOCKLIST.has(d)) continue;
        expansionDomains.add(d);
      }

      const allCandidates = [...reonomyCandidates, ...apolloCandidates, ...hunterCandidates, ...pdlCandidates, ...batchdataCandidates];

      if (expansionDomains.size > 0) {
        console.log(`[enrich] → domain expand: ${[...expansionDomains].join(", ")}`);
        const expansionResults = await Promise.all(
          [...expansionDomains].map((domain) =>
            Promise.all([
              apolloClient.findContactsByDomain(effectiveEnriched, domain),
              hunterClient.findContactsByDomain(effectiveEnriched, domain),
              pdlClient.findContactsByDomain(effectiveEnriched, domain),
            ]).then(([a, h, p]) => [...a, ...h, ...p])
          )
        );
        allCandidates.push(...expansionResults.flat());
      }
      // ──────────────────────────────────────────────────────────────────────

      const merged = mergeContactCandidates(allCandidates);
      */

      // Only process contacts that have an email — no cap on how many.
      const mergedWithEmail = merged.filter((c) => c.contact_email.trim());
      const candidatesToProcess = mergedWithEmail.length > 0 ? mergedWithEmail : merged.slice(0, 1);

      // ZeroBounce — verify each candidate's email
      const verifiedCandidates = await Promise.all(
        candidatesToProcess.map((candidate) =>
          verifyQueue.add(async () => {
            if (!candidate.contact_email) {
              return { candidate, verificationStatus: "unverified" };
            }
            const result = await zeroBounceClient.verify(candidate.contact_email);
            return { candidate, verificationStatus: result.status };
          })
        )
      ) as { candidate: ContactCandidate; verificationStatus: string }[];

      // Build new Tier1ContactRow list from enriched contacts
      const newRows: Tier1ContactRow[] = verifiedCandidates.map(
        ({ candidate, verificationStatus }, idx) =>
          buildRow(enriched, candidate, verificationStatus, idx, ownerResolutionResult)
      );

      if (outputTab) {
        // Output-tab mode: mirror the full in-place result set into a new tab.
        // That means existing Leads rows are included with updated property/contact
        // data, plus any extra discovered contacts as additional rows.
        for (let i = 0; i < sheetRows.length; i++) {
          const sheetRow = sheetRows[i];
          const outputRow: Tier1ContactRow =
            newRows[i] ?? buildRowKeepingExistingContact(enriched, sheetRow.data);
          const email = outputRow.contact_email.trim().toLowerCase();
          if (email && outputSeenEmails.has(email)) continue;
          if (email) outputSeenEmails.add(email);
          allOutputRows.push(outputRow);
          appendedCount++;
        }

        for (let i = sheetRows.length; i < newRows.length; i++) {
          const extraRow = newRows[i];
          const email = extraRow.contact_email.trim().toLowerCase();
          if (email && outputSeenEmails.has(email)) continue;
          if (email) outputSeenEmails.add(email);
          allOutputRows.push(extraRow);
          appendedCount++;
        }
      } else {
        // In-place mode: update existing rows, append extra contacts.
        // Row i in sheetRows gets newRows[i] if it exists, otherwise keeps the
        // existing contact fields and receives only the ATTOM enrichment data.
        for (let i = 0; i < sheetRows.length; i++) {
          const sheetRow = sheetRows[i];
          const updatedRow: Tier1ContactRow =
            newRows[i] ?? buildRowKeepingExistingContact(enriched, sheetRow.data);

          batchUpdateData.push({
            range: `${tabName}!A${sheetRow.sheetRowIndex}:${LAST_COL}${sheetRow.sheetRowIndex}`,
            values: [rowToValues(updatedRow)],
          });
          updatedCount++;
        }

        // Append extra contacts discovered by Apollo / Hunter / BatchData
        for (let i = sheetRows.length; i < newRows.length; i++) {
          const email = newRows[i].contact_email.trim().toLowerCase();
          if (email && (await idempotencyStore.hasSeenContactEmail(email))) continue;

          rowsToAppend.push(rowToValues(newRows[i]));
          if (email) {
            await idempotencyStore.markContactEmailSeen(email, newRows[i].property_id, runId);
          }
          appendedCount++;
        }
      }
    })
  );

  await Promise.all(tasks);

  // ── 6. Write results ──────────────────────────────────────────────────────
  if (outputTab) {
    // Output-tab mode: all enriched rows go to the new tab
    if (allOutputRows.length > 0) {
      console.log(`\n[enrich] Writing ${allOutputRows.length} row(s) to tab "${outputTab}"...`);
      const result = await saveToGoogleSheet(allOutputRows, {
        credentialsPath,
        spreadsheetId,
        tabName: outputTab,
        writeHeaderRow: true,
      });
      console.log(`[enrich] ✅ ${result.appendedCount} row(s) written to "${outputTab}".`);
      if (result.skippedExistingCount > 0) {
        console.log(`[enrich]    ${result.skippedExistingCount} duplicate email(s) skipped.`);
      }
    } else {
      console.log(`[enrich] No enriched rows produced — nothing to write.`);
    }
  } else {
    // In-place mode: update source tab rows, append extras
    if (batchUpdateData.length > 0) {
      console.log(`\n[enrich] Writing ${batchUpdateData.length} updated row(s) to sheet...`);
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: "RAW",
          data: batchUpdateData,
        },
      });
      console.log(`[enrich] ✅ ${updatedCount} row(s) updated in-place.`);
    }

    if (rowsToAppend.length > 0) {
      console.log(`[enrich] Appending ${rowsToAppend.length} new contact row(s)...`);
      await sheets.spreadsheets.values.append({
        spreadsheetId,
        range: `${tabName}!A1`,
        valueInputOption: "RAW",
        requestBody: { values: rowsToAppend },
      });
      console.log(`[enrich] ✅ ${appendedCount} new row(s) appended.`);
    }
  }

  await idempotencyStore.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log("\n==============================================");
  console.log("  ENRICHMENT COMPLETE");
  console.log("==============================================");
  console.log(`Properties enriched : ${byProperty.size}`);
  if (outputTab) {
    console.log(`Rows written        : ${appendedCount} → "${outputTab}"`);
  } else {
    console.log(`Rows updated        : ${updatedCount}`);
    console.log(`Rows appended       : ${appendedCount}`);
  }
  console.log(`Elapsed time        : ${elapsed}s`);
  console.log("==============================================");
}

main().catch((err) => {
  console.error("[enrich] Fatal error:", err);
  process.exitCode = 1;
});
