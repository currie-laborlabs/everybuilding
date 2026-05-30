/**
 * src/enrichment/batchdata-property.ts
 *
 * BatchData Property Enrichment client — supplements ATTOM data with
 * BatchData's property intelligence (sale history, permits, owner info, AVM).
 *
 * This client follows a "fill the gaps" strategy:
 *   - ATTOM data always takes precedence on any field it has populated.
 *   - BatchData only populates fields that ATTOM left empty ("").
 *
 * Activation: this client is a no-op unless the env var
 * BATCHDATA_PROPERTY_ENRICH=true is set. Without that flag the function
 * returns the lead unchanged so the pipeline remains unaffected.
 *
 * API: POST https://api.batchdata.com/api/v1/property/lookup/all-attributes
 * Auth: Authorization: Bearer <BATCHDATA_API_KEY>
 *
 * Returns comprehensive property data including:
 *   - Sale history (last sale date, price, grantor/grantee)
 *   - Permit summaries (type, contractor, date)
 *   - Assessment / AVM values
 *   - Building characteristics, lot details
 */

import type { EnrichedPropertyLead } from "../types";
import { CircuitBreaker } from "../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../infra/rateLimiter";
import { withRetry } from "../infra/retry";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BatchDataPropertyClientConfig {
  apiKey?: string;
  baseUrl: string;
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

interface BatchDataSaleRecord {
  saleDate?: string;
  salePrice?: number;
  grantor?: string;
  grantee?: string;
  documentType?: string;
}

interface BatchDataPermitRecord {
  permitType?: string;
  issueDate?: string;
  contractor?: string;
  description?: string;
  status?: string;
}

interface BatchDataPropertyDetail {
  saleHistory?: BatchDataSaleRecord[];
  lastSale?: {
    saleDate?: string;
    salePrice?: number;
  };
  /**
   * The real lookup/all-attributes response currently returns permit data under
   * `permit` (singular). Keep `permits` for older/defensive shapes.
   */
  permit?: unknown;
  permits?: unknown;
  ownerProfile?: {
    ownershipTransferDate?: string;
    ownershipLength?: number;
  };
  propertyOwnerProfile?: {
    ownershipTransferDate?: string;
    ownershipLength?: number;
  };
  assessment?: {
    marketValue?: number;
    assessedValue?: number;
  };
  address?: {
    street?: string;
    city?: string;
    state?: string;
    zip?: string;
  };
}

interface BatchDataPropertyLookupResponse {
  status?: {
    code?: number;
    text?: string;
    message?: string;
  };
  // Common v1 shape for lookup all-attributes
  properties?: BatchDataPropertyDetail[];
  // Some responses are wrapped under results.*
  results?: {
    properties?: BatchDataPropertyDetail[];
  };
  // Legacy/defensive shapes
  data?: {
    property?: BatchDataPropertyDetail;
    results?: BatchDataPropertyDetail[];
  };
  property?: BatchDataPropertyDetail;
  message?: string;
  error?: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class BatchDataPropertyClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: BatchDataPropertyClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  /**
   * Enrich an already-enriched lead with BatchData property data.
   * Returns the lead unchanged when:
   *   - BATCHDATA_PROPERTY_ENRICH is false
   *   - No API key is configured
   *   - BatchData returns no data for this address
   */
  async enrichLead(lead: EnrichedPropertyLead): Promise<EnrichedPropertyLead> {
    if (!this.config.enabled || !this.config.apiKey) return lead;
    if (!lead.property_address?.trim()) return lead;

    try {
      const detail = await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchPropertyDetail(lead), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );

      if (!detail) {
        console.log(`[batchdata-property] ${lead.property_address} — no property detail returned by API`);
        return lead;
      }
      return this.mergeIntoLead(lead, detail);
    } catch (error) {
      // BatchData is supplemental — never fail a lead because of it
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[batchdata-property] ${lead.property_address} — lookup failed: ${message}`);
      return lead;
    }
  }

  private async fetchPropertyDetail(lead: EnrichedPropertyLead): Promise<BatchDataPropertyDetail | null> {
    const url = `${this.config.baseUrl}/api/v1/property/lookup/all-attributes`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        requests: [
          {
            address: {
              street: lead.property_address.trim(),
              city: lead.city.trim(),
              state: lead.state.trim(),
              zip: lead.zip_code.trim(),
            },
          },
        ],
        options: {
          datasets: ["permit", "owner", "deed", "valuation"],
        },
      }),
    });

    if (response.status === 402) {
      console.warn("[batchdata-property] Out of credits (402).");
      return null;
    }

    if (!response.ok) {
      throw new Error(`BatchData property lookup ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as BatchDataPropertyLookupResponse;

    // Normalize response shape
    const detail: BatchDataPropertyDetail | undefined =
      payload?.properties?.[0] ??
      payload?.results?.properties?.[0] ??
      payload?.data?.property ??
      payload?.data?.results?.[0] ??
      payload?.property ??
      undefined;

    return detail ?? null;
  }

  /**
   * Merge BatchData property detail into an EnrichedPropertyLead.
   * ATTOM fields take precedence: only populate fields that are empty strings.
   */
  private mergeIntoLead(
    lead: EnrichedPropertyLead,
    detail: BatchDataPropertyDetail
  ): EnrichedPropertyLead {
    const updated = { ...lead };
    const filled: string[] = [];

    // ── Sale data ─────────────────────────────────────────────────────────
    const lastSale = detail.lastSale ?? detail.saleHistory?.[0];

    if (!updated.last_sale_date && lastSale?.saleDate) {
      updated.last_sale_date = formatDate(lastSale.saleDate);
      filled.push(`last_sale_date=${updated.last_sale_date}`);
    }

    if (!updated.last_sale_price && lastSale?.salePrice && lastSale.salePrice > 0) {
      updated.last_sale_price = `$${lastSale.salePrice.toLocaleString()}`;
      filled.push(`last_sale_price=${updated.last_sale_price}`);
    }

    // ── Permit data ───────────────────────────────────────────────────────
    const permits = normalizeBatchDataPermits(detail);
    if (permits.length === 0) {
      console.log(`[batchdata-property] ${lead.property_address} — no permits returned by API`);
    }

    if (permits.length > 0 && !updated.permit_summary) {
      updated.permit_summary = permits
        .map((p) => [p.permitType, p.description].filter(Boolean).join(": "))
        .filter(Boolean)
        .join("; ");
      filled.push(`permit_summary`);
    }

    if (!updated.permit_type && permits[0]?.permitType) {
      updated.permit_type = permits[0].permitType;
      filled.push(`permit_type=${updated.permit_type}`);
    }

    if (!updated.permit_contractor) {
      const contractorPermit = permits.find((p) => p.contractor?.trim());
      if (contractorPermit?.contractor) {
        updated.permit_contractor = contractorPermit.contractor;
        filled.push(`permit_contractor=${updated.permit_contractor}`);
      }
    }

    if (!updated.last_permit_date) {
      const lastPermit = permits
        .filter((p) => p.issueDate)
        .sort((a, b) => (b.issueDate ?? "") > (a.issueDate ?? "") ? 1 : -1)[0];
      if (lastPermit?.issueDate) {
        updated.last_permit_date = formatDate(lastPermit.issueDate);
        filled.push(`last_permit_date=${updated.last_permit_date}`);
      }
    }

    // Populate individual permit type dates
    for (const permit of permits) {
      const type = permit.permitType?.toLowerCase() ?? "";
      const date = permit.issueDate ? formatDate(permit.issueDate) : "";
      if (!date) continue;

      if (!updated.roof_permit_date && (type.includes("roof") || type.includes("roofing"))) {
        updated.roof_permit_date = date;
        filled.push(`roof_permit_date=${date}`);
      }
      if (!updated.hvac_permit_date && (type.includes("hvac") || type.includes("mechanical") || type.includes("ac") || type.includes("heating"))) {
        updated.hvac_permit_date = date;
        filled.push(`hvac_permit_date=${date}`);
      }
      if (!updated.plumbing_permit_date && type.includes("plumbing")) {
        updated.plumbing_permit_date = date;
        filled.push(`plumbing_permit_date=${date}`);
      }
      if (!updated.electrical_permit_date && type.includes("electrical")) {
        updated.electrical_permit_date = date;
        filled.push(`electrical_permit_date=${date}`);
      }
      if (!updated.restoration_permit_date && (type.includes("restoration") || type.includes("renovation") || type.includes("remodel"))) {
        updated.restoration_permit_date = date;
        filled.push(`restoration_permit_date=${date}`);
      }
      if (!updated.fire_water_permit_date && (type.includes("fire") || type.includes("sprinkler") || type.includes("water"))) {
        updated.fire_water_permit_date = date;
        filled.push(`fire_water_permit_date=${date}`);
      }
    }

    // ── Ownership transfer ────────────────────────────────────────────────
    const ownerProfile = detail.ownerProfile ?? detail.propertyOwnerProfile;
    if (!updated.ownership_transfer_flag && ownerProfile?.ownershipTransferDate) {
      updated.ownership_transfer_flag = formatDate(ownerProfile.ownershipTransferDate);
      filled.push(`ownership_transfer_flag=${updated.ownership_transfer_flag}`);
    }

    if (filled.length > 0) {
      console.log(`[batchdata-property] ${lead.property_address} — filled: ${filled.join(", ")}`);
    } else {
      console.log(`[batchdata-property] ${lead.property_address} — no new fields filled (API returned data but all fields already populated)`);
    }

    return updated;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Normalize a date string to YYYY-MM-DD format for consistency with ATTOM.
 * Passes through strings that already look like ISO dates.
 */
function formatDate(raw: string): string {
  if (!raw) return "";
  // Already ISO-like (YYYY-MM-DD or YYYY-MM-DDThh:mm:ss)
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  // Try to parse other formats
  try {
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  } catch {
    // ignore
  }
  return raw;
}

export function normalizeBatchDataPermits(detail: BatchDataPropertyDetail): BatchDataPermitRecord[] {
  const rawRecords = [
    ...extractPermitRecords(detail.permits),
    ...extractPermitRecords(detail.permit),
  ];

  const permits = rawRecords
    .map(mapPermitRecord)
    .filter((p) => Boolean(p.permitType || p.issueDate || p.contractor || p.description || p.status));

  return permits.sort((a, b) => comparePermitDatesDesc(a.issueDate, b.issueDate));
}

function extractPermitRecords(raw: unknown, depth = 0): Record<string, unknown>[] {
  if (!raw || depth > 6) return [];

  if (Array.isArray(raw)) {
    return raw.flatMap((item) => extractPermitRecords(item, depth + 1));
  }

  if (!isRecord(raw)) return [];

  if (looksLikePermitRecord(raw)) {
    return [raw];
  }

  return Object.values(raw).flatMap((value) => extractPermitRecords(value, depth + 1));
}

function looksLikePermitRecord(record: Record<string, unknown>): boolean {
  const keys = new Set(Object.keys(record).map((key) => key.toLowerCase()));
  return [
    "permittype",
    "permit_type",
    "permitnumber",
    "permit_number",
    "issuedate",
    "issue_date",
    "issued_date",
    "dateissued",
    "contractor",
    "contractorname",
    "contractor_name",
    "workdescription",
    "work_description",
    "permitdescription",
    "permit_description",
  ].some((key) => keys.has(key));
}

function mapPermitRecord(record: Record<string, unknown>): BatchDataPermitRecord {
  return {
    permitType: firstString(record, [
      "permitType",
      "permit_type",
      "type",
      "subType",
      "sub_type",
      "workType",
      "work_type",
      "projectType",
      "project_type",
      "category",
      "tag",
      "tags",
      "permitClass",
      "permit_class",
    ]),
    issueDate: firstString(record, [
      "issueDate",
      "issue_date",
      "issuedDate",
      "issued_date",
      "dateIssued",
      "date_issued",
      "permitIssueDate",
      "permit_issue_date",
      "effectiveDate",
      "effective_date",
      "filedDate",
      "filed_date",
      "applicationDate",
      "application_date",
      "appliedDate",
      "applied_date",
      "permitDate",
      "permit_date",
      "date",
    ]),
    contractor:
      firstString(record, [
        "contractor",
        "contractorName",
        "contractor_name",
        "companyName",
        "company_name",
        "businessName",
        "business_name",
        "contractorCompanyName",
        "contractor_company_name",
        "applicant",
        "applicantName",
        "applicant_name",
      ]) || firstNestedString(record, ["contractor", "applicant"], ["name", "companyName", "company_name"]),
    description: firstString(record, [
      "description",
      "jobDescription",
      "job_description",
      "workDescription",
      "work_description",
      "projectDescription",
      "project_description",
      "scope",
      "scopeOfWork",
      "scope_of_work",
      "permitDescription",
      "permit_description",
    ]),
    status: firstString(record, ["status", "permitStatus", "permit_status"]),
  };
}

function firstString(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    const normalized = normalizeStringValue(value);
    if (normalized) return normalized;
  }
  return "";
}

function firstNestedString(
  record: Record<string, unknown>,
  parentKeys: string[],
  childKeys: string[]
): string {
  for (const parentKey of parentKeys) {
    const value = record[parentKey];
    if (!isRecord(value)) continue;
    const normalized = firstString(value, childKeys);
    if (normalized) return normalized;
  }
  return "";
}

function normalizeStringValue(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (Array.isArray(value)) {
    return value
      .map((item) => normalizeStringValue(item))
      .filter(Boolean)
      .join(", ");
  }
  return "";
}

function comparePermitDatesDesc(a?: string, b?: string): number {
  const aTime = dateTime(a);
  const bTime = dateTime(b);
  return bTime - aTime;
}

function dateTime(raw?: string): number {
  if (!raw) return 0;
  const parsed = new Date(raw).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
