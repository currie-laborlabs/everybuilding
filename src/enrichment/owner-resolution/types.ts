/**
 * Owner Resolution Layer — Type Definitions
 *
 * These types are internal to the owner-resolution module.
 * They deliberately do NOT extend or modify existing pipeline types.
 */

/** Input collected from an EnrichedPropertyLead for the resolution layer. */
export interface OwnerResolutionInput {
  property_id: string;
  raw_owner_name: string;
  normalized_owner_name: string;
  owner_type: string;
  owner_mailing_address: string;
  care_of_name: string;
  property_address: string;
  city: string;
  state: string;
  zip: string;
  source_platform: string;
}

export type ResolutionStatus =
  | "resolved"
  | "needs_review"
  | "unresolved"
  | "skipped"
  | "error";

/** Raw result returned by a single adapter. */
export interface AdapterResult {
  candidate_company_name: string;
  candidate_domain: string;
  matched_city?: string;
  matched_state?: string;
  matched_name?: string;
  industry?: string;
  source: string;
}

/** Final output of the resolution layer for one property. */
export interface OwnerResolutionResult {
  property_id: string;
  raw_owner_name: string;
  normalized_owner_name: string;
  candidate_company_name: string;
  candidate_domain: string;
  confidence_score: number;
  resolution_status: ResolutionStatus;
  resolution_source: string;
  matched_signals: string[];
  notes: string;
  registry_contact_name?: string;
  registry_contact_title?: string;
  error_message?: string;
}

/** Per-adapter enable/disable config. */
export interface OwnerResolutionAdapterConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Full config for the owner resolution layer.
 * Matches the shape added to config.ts under config.ownerResolution.
 */
export interface OwnerResolutionConfig {
  enabled: boolean;
  minResolvedScore: number;
  minReviewScore: number;
  adapters: {
    cobalt: boolean;
    hunter: boolean;
    apollo: boolean;
    serper: boolean;
    opencorporates: boolean;
  };
  failOpen: boolean;
  writeDebugOutput: boolean;
  serperApiKey?: string;
  opencorporatesApiKey?: string;
  cobaltApiKey?: string;
  cobaltBaseUrl?: string;
}
