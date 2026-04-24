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
  source_platform: "reonomy";
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
  review_status: "pending";
  notes: string;
}

export type EnrichmentStatus = "success" | "partial" | "failed" | "skipped";

export interface EnrichedPropertyLead extends NormalizedLead {
  last_sale_date: string;
  last_sale_price: string;
  permit_summary: string;
  roof_permit_date: string;
  hvac_permit_date: string;
  ownership_transfer_flag: string;
  tax_or_distress_notes: string;
  enrichment_status: EnrichmentStatus;
}

export interface ContactCandidate {
  property_id: string;
  owner_entity: string;
  contact_name: string;
  contact_title: string;
  contact_phone: string;
  contact_email: string;
  contact_source: "reonomy" | "apollo" | "hunter" | "hybrid";
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
    skippedExistingContacts: number;
    appendedRows: number;
    partialRecords: number;
  };
  errors: string[];
}

/**
 * Tier 1 output row: one row per contact. Matches the 30-column Google Sheet spec.
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
  ownership_transfer_flag: string;
  tax_or_distress_notes: string;
}

export type ReprocessMode = "partial" | "full" | "failed_only";

export interface PipelineCheckpoint {
  runId: string;
  stage: StageName;
  index: number;
  total: number;
  updatedAt: string;
}
