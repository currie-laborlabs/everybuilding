/**
 * Raw property record as extracted from Reonomy results page.
 * Fields may be missing or malformed — normalization happens downstream.
 */
export interface RawReonomyRecord {
  property_address?: string;
  city?: string;
  state?: string;
  zip_code?: string;
  land_use?: string;
  square_feet?: string;
  year_built?: string;
  owner_entity?: string;
}

/**
 * A single person extracted from Reonomy's Owner tab or Contacts page.
 * Stored in reonomy_contacts_json (JSON array) on each NormalizedLead.
 */
export interface ReonomyContact {
  name: string;
  title: string;
  relationship: string; // "Principal", "Contact", etc.
  phones: string[];
  emails: string[];
}

/**
 * Normalized lead record ready for CSV output.
 * Every field has a defined value (even if null).
 */
export interface NormalizedLead {
  property_id: string;
  property_address: string;
  city: string;
  state: string;
  zip_code: string;
  land_use: string;
  square_feet: number | null;
  year_built: number | null;
  owner_entity: string;
  source_platform: "reonomy" | "attom";
  source_search_area: string;
  source_run_date: string;
  source_notes: string;
  extraction_status: "extracted" | "partial";
  reonomy_owner_name: string;
  reonomy_owner_phone: string;
  reonomy_owner_email: string;
  reonomy_contact_name: string;
  reonomy_contact_title: string;
  reonomy_contact_phone: string;
  reonomy_contact_email: string;
  reonomy_company_domain: string;
  reonomy_last_acquisition_date: string;
  reonomy_detail_status: "not_attempted" | "success" | "partial" | "failed";
  reonomy_detail_notes: string;
  /**
   * JSON-encoded ReonomyContact[] — ALL contacts extracted from the Owner
   * tab + "View All Contacts" page. Internal pipeline field; not written
   * to the sheet directly. Defaults to "[]".
   */
  reonomy_contacts_json: string;
  review_status: "pending";
  notes: string;
}

export type EnrichmentStatus = "success" | "partial" | "failed" | "skipped";

export interface EnrichedPropertyLead extends NormalizedLead {
  last_sale_date: string;
  last_sale_price: string;
  permit_summary: string;
  permit_type?: string;
  roof_permit_date: string;
  hvac_permit_date: string;
  plumbing_permit_date: string;
  electrical_permit_date: string;
  restoration_permit_date: string;
  fire_water_permit_date: string;
  last_permit_date: string;
  permit_contractor: string;
  ownership_transfer_flag: string;
  tax_or_distress_notes: string;
  hazard_notes: string;
  crime_notes: string;
  demographics_notes: string;
  air_quality_notes: string;
  climate_notes: string;
  enrichment_status: EnrichmentStatus;
}

export type ContactProviderSource = "reonomy" | "apollo" | "hunter" | "pdl" | "batchdata";
export type ContactSource = ContactProviderSource | "hybrid";

export interface ContactCandidate {
  property_id: string;
  owner_entity: string;
  contact_name: string;
  contact_title: string;
  contact_phone: string;
  contact_email: string;
  contact_linkedin?: string;
  contact_source: ContactSource;
  contact_sources?: ContactProviderSource[];
  email_source?: ContactSource;
  phone_source?: ContactSource;
  contact_enrichment_notes?: string;
  confidence: number;
}

/**
 * Configuration for a single scraper run.
 */
export interface ScrapeRunConfig {
  zipCode: string;
  maxPages: number;
}

export type StageName =
  | "login"
  | "search"
  | "extract"
  | "normalize"
  | "reonomy_detail"
  | "attom_discover"
  | "attom_enrich"
  | "contact_enrich"
  | "email_verify"
  | "save";

export type StageStatus = "pending" | "running" | "completed" | "failed";

export interface StageRunStatus {
  status: StageStatus;
  updatedAt: string;
  elapsedMs?: number;
  message?: string;
}

export interface RunStateSnapshot {
  runId: string;
  createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "failed";
  stageStatus: Partial<Record<StageName, StageRunStatus>>;
  metrics: {
    extractedRecords: number;
    normalizedRecords: number;
    attomEnrichedRecords: number;
    contactCandidates: number;
    verifiedContacts: number;
    rowsWithEmail: number;
    validEmails: number;
    invalidEmails: number;
    unknownEmails: number;
    unverifiedEmails: number;
    contactSourceCounts: Record<string, number>;
    skippedExistingContacts: number;
    appendedRows: number;
    partialRecords: number;
  };
  errors: string[];
}

/**
 * Tier 1 output row: one row per contact. Matches the 30-column Google Sheet spec.
 *
 * The six owner_resolution_* fields are optional and populated only when
 * OWNER_RESOLUTION_ENABLED=true. They append new columns to the right of the
 * sheet and do not affect existing column positions.
 */
export interface Tier1ContactRow {
  property_id: string;
  property_address: string;
  city: string;
  state: string;
  zip_code: string;
  land_use: string;
  year_built: number | null;
  square_feet: number | null;
  owner_entity: string;
  source_platform: string;
  source_search_area: string;
  source_run_date: string;
  source_notes: string;
  contact_name: string;
  contact_title: string;
  contact_email: string;
  contact_phone: string;
  contact_linkedin?: string;
  contact_source?: string;
  contact_sources?: string;
  email_source?: string;
  phone_source?: string;
  contact_confidence?: number | null;
  contact_enrichment_notes?: string;
  sequence: "Primary" | "Secondary" | "Tertiary";
  extraction_status: string;
  enrichment_status: string;
  verification_status: string;
  review_status: string;
  notes: string;
  last_sale_date: string;
  last_sale_price: string;
  permit_summary: string;
  roof_permit_date: string;
  hvac_permit_date: string;
  plumbing_permit_date: string;
  electrical_permit_date: string;
  restoration_permit_date: string;
  fire_water_permit_date: string;
  last_permit_date: string;
  permit_contractor: string;
  ownership_transfer_flag: string;
  tax_or_distress_notes: string;
  hazard_notes: string;
  crime_notes: string;
  demographics_notes: string;
  air_quality_notes: string;
  climate_notes: string;
  // ── Owner Resolution (optional, OWNER_RESOLUTION_ENABLED=true) ────────────
  owner_resolution_status?: string;
  owner_resolution_confidence?: number | null;
  resolved_company_name?: string;
  resolved_domain?: string;
  owner_resolution_source?: string;
  owner_resolution_notes?: string;
  registry_contact_name?: string;
  registry_contact_title?: string;
}

export type ReprocessMode = "partial" | "full" | "failed_only";

export interface PipelineCheckpoint {
  runId: string;
  stage: StageName;
  index: number;
  total: number;
  updatedAt: string;
}
