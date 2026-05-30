/**
 * Owner Resolution Layer — Public API
 *
 * This is the only file that should be imported outside the owner-resolution
 * module. It exposes:
 *   - OwnerResolver class
 *   - buildResolutionInput() — converts EnrichedPropertyLead → OwnerResolutionInput
 *   - resolveOwnerSafe()    — failOpen wrapper (never throws)
 *   - makeSkippedResult()   — no-op result when feature is disabled
 *
 * HOW TO ENABLE:
 *   Set OWNER_RESOLUTION_ENABLED=true in .env
 *
 * HOW TO DISABLE (default):
 *   Set OWNER_RESOLUTION_ENABLED=false (or omit — defaults to false)
 *   When disabled, ownerResolver is undefined in index.ts and enrich.ts,
 *   and the resolution path is never entered.
 *
 * HOW TO REMOVE:
 *   1. Delete this directory (src/enrichment/owner-resolution/)
 *   2. Remove the ownerResolution block from src/config.ts
 *   3. Remove the owner_resolution_* fields from src/types.ts (Tier1ContactRow)
 *   4. Remove the 6 owner_resolution_* columns from SHEET_COLUMNS in saveCsv.ts
 *   5. Remove the ownerResolver creation and parameter from index.ts and enrich.ts
 *   All existing pipeline behavior is unaffected.
 */

export { OwnerResolver } from "./resolver";

export type {
  OwnerResolutionInput,
  OwnerResolutionResult,
  OwnerResolutionConfig,
  AdapterResult,
  ResolutionStatus,
} from "./types";

import type { EnrichedPropertyLead } from "../../types";
import type { OwnerResolutionInput, OwnerResolutionResult } from "./types";
import type { OwnerResolver } from "./resolver";

/**
 * Strip common legal suffixes and noise from owner entity names so that
 * Hunter, Apollo, and Serper adapters receive a cleaner company name signal.
 *
 * Examples:
 *   "SMITH FAMILY TRUST NJ"   → "SMITH FAMILY"
 *   "25 BROAD ST LLC"          → "25 BROAD ST"
 *   "PATEL J TRUSTEE"          → "PATEL J"
 *   "ACME ROOFING INC."        → "ACME ROOFING"
 *   "RIVERSIDE HOLDINGS L.P."  → "RIVERSIDE HOLDINGS"
 */
function normalizeOwnerName(name: string): string {
  if (!name) return name;
  const suffixes = [
    // Trust / individual patterns
    /\b(FAMILY\s+)?TRUST\b/i,
    /\bTRUSTEE\b/i,
    /\bTRUSTEES\b/i,
    // Legal entity suffixes
    /\bL\.?L\.?C\.?\b/i,
    /\bL\.?L\.?P\.?\b/i,
    /\bL\.?P\.?\b/i,
    /\bINC\.?\b/i,
    /\bCORP\.?\b/i,
    /\bCORPORATION\b/i,
    /\bCO\.?\b/i,
    /\bLTD\.?\b/i,
    // State abbreviations appended to names (e.g. "SMITH TRUST NJ")
    /\b[A-Z]{2}\b$/,
  ];
  let result = name;
  for (const pattern of suffixes) {
    result = result.replace(pattern, "");
  }
  // Collapse multiple spaces and trim
  return result.replace(/\s{2,}/g, " ").trim();
}

/**
 * Build an OwnerResolutionInput from an EnrichedPropertyLead.
 * Maps the existing pipeline model to the resolution layer's input contract.
 */
export function buildResolutionInput(
  lead: EnrichedPropertyLead
): OwnerResolutionInput {
  const rawOwner = lead.reonomy_owner_name || lead.owner_entity;
  return {
    property_id: lead.property_id,
    raw_owner_name: rawOwner,
    // Normalized name strips legal suffixes so Hunter/Apollo/Serper get a
    // cleaner signal — e.g. "SMITH FAMILY TRUST NJ" → "SMITH FAMILY".
    normalized_owner_name: normalizeOwnerName(lead.owner_entity),
    owner_type: "",
    owner_mailing_address: "",
    care_of_name: "",
    property_address: lead.property_address,
    city: lead.city,
    state: lead.state,
    zip: lead.zip_code,
    source_platform: lead.source_platform,
  };
}

/**
 * Runs owner resolution with failOpen behavior.
 * Always returns a result — never throws.
 * On unexpected errors, returns resolution_status="error" and continues.
 */
export async function resolveOwnerSafe(
  lead: EnrichedPropertyLead,
  resolver: OwnerResolver
): Promise<OwnerResolutionResult> {
  try {
    return await resolver.resolve(buildResolutionInput(lead));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[owner-resolution] Unexpected error for ${lead.property_id}: ${msg}`
    );
    return {
      property_id: lead.property_id,
      raw_owner_name: lead.reonomy_owner_name || lead.owner_entity,
      normalized_owner_name: lead.owner_entity,
      candidate_company_name: "",
      candidate_domain: "",
      confidence_score: 0,
      resolution_status: "error",
      resolution_source: "",
      matched_signals: [],
      notes: msg,
      registry_contact_name: "",
      registry_contact_title: "",
      error_message: msg,
    };
  }
}

/**
 * Returns a "skipped" result when the owner resolution feature is disabled.
 * Used to keep optional sheet columns consistent when feature is toggled off
 * mid-dataset (not needed in normal operation since columns are empty by default).
 */
export function makeSkippedResult(
  lead: EnrichedPropertyLead
): OwnerResolutionResult {
  return {
    property_id: lead.property_id,
    raw_owner_name: lead.reonomy_owner_name || lead.owner_entity,
    normalized_owner_name: lead.owner_entity,
    candidate_company_name: "",
    candidate_domain: "",
    confidence_score: 0,
    resolution_status: "skipped",
    resolution_source: "",
    matched_signals: [],
    notes: "Owner resolution disabled",
    registry_contact_name: "",
    registry_contact_title: "",
  };
}
