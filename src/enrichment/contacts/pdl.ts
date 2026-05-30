import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
import { CircuitBreaker } from "../../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../../infra/rateLimiter";
import { withRetry } from "../../infra/retry";

export interface PdlClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
  /** Max person records to return per search call — each record costs 1 credit. */
  maxResultsPerSearch: number;
}

/**
 * PDL canonical job_title_levels that map to decision-makers.
 * See: https://docs.peopledatalabs.com/docs/job-title-levels
 */
const TARGET_TITLE_LEVELS = ["owner", "partner", "cxo", "vp", "director", "manager"];

interface PdlPersonRecord {
  full_name?: string;
  job_title?: string;
  job_title_levels?: string[];
  work_email?: string;
  mobile_phone?: string;
  linkedin_url?: string;
  job_company_name?: string;
}

interface PdlSearchResponse {
  status: number;
  data?: PdlPersonRecord[];
  total?: number;
  error?: { type: string; message: string };
}

export class PdlClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: PdlClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  async findContacts(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    if (!this.config.apiKey) return [];

    const ownerEntity = lead.owner_entity?.trim();
    const domain = lead.reonomy_company_domain?.trim().toLowerCase();
    if (!ownerEntity && !domain) return [];

    try {
      return await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchContacts(lead), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );
    } catch {
      return [];
    }
  }

  /**
   * Domain-expansion pass — called when round-1 results reveal a domain
   * we haven't searched yet. Consistent with Apollo + Hunter domain expansion.
   */
  async findContactsByDomain(lead: EnrichedPropertyLead, domain: string): Promise<ContactCandidate[]> {
    if (!this.config.apiKey || !domain) return [];
    try {
      return await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchContactsByDomain(lead, domain), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );
    } catch {
      return [];
    }
  }

  private async fetchContacts(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    const ownerEntity = lead.owner_entity?.trim();
    const domain = lead.reonomy_company_domain?.trim().toLowerCase();

    const mustClauses: object[] = [
      { terms: { job_title_levels: TARGET_TITLE_LEVELS } },
      { exists: { field: "work_email" } },
      // Only US contacts — commercial property owners operate domestically.
      { term: { location_country: "united states" } },
    ];

    if (domain) {
      // Domain is the highest-precision identifier — prefer it over name match.
      mustClauses.push({ term: { job_company_website: domain } });
    } else if (ownerEntity) {
      // Fuzzy name match for LLC / holding company names from Reonomy.
      mustClauses.push({ match: { job_company_name: ownerEntity } });
    }

    return this.executeSearch(lead, mustClauses);
  }

  private async fetchContactsByDomain(lead: EnrichedPropertyLead, domain: string): Promise<ContactCandidate[]> {
    const mustClauses: object[] = [
      { term: { job_company_website: domain } },
      { terms: { job_title_levels: TARGET_TITLE_LEVELS } },
      { exists: { field: "work_email" } },
      { term: { location_country: "united states" } },
    ];
    return this.executeSearch(lead, mustClauses);
  }

  private async executeSearch(lead: EnrichedPropertyLead, mustClauses: object[]): Promise<ContactCandidate[]> {
    const url = `${this.config.baseUrl}/person/search`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-api-key": this.config.apiKey ?? "",
      },
      body: JSON.stringify({
        query: { bool: { must: mustClauses } },
        size: this.config.maxResultsPerSearch,
        // dataset=resume gives the most accurate current-job records.
        dataset: "resume",
      }),
    });

    // 402 = out of credits — soft-fail so the rest of the pipeline continues.
    if (response.status === 402) {
      console.warn("[pdl] Out of credits (402). Skipping PDL for this lead.");
      return [];
    }

    if (!response.ok) {
      throw new Error(`PDL search ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as PdlSearchResponse;
    if (payload.status !== 200 || !payload.data) return [];

    return payload.data
      .filter((p) => p.work_email && p.full_name)
      .map((p) => ({
        property_id: lead.property_id,
        owner_entity: lead.owner_entity,
        contact_name: p.full_name ?? "",
        contact_title: p.job_title ?? "",
        contact_phone: p.mobile_phone ?? "",
        contact_email: (p.work_email ?? "").toLowerCase().trim(),
        contact_linkedin: p.linkedin_url ?? "",
        contact_source: "pdl" as const,
        confidence: 0.80,
      }));
  }
}
