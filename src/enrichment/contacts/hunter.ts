import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
import { CircuitBreaker } from "../../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../../infra/rateLimiter";
import { withRetry } from "../../infra/retry";

export interface HunterClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

function resolveExplicitDomain(lead: EnrichedPropertyLead): string {
  // Only use a domain that was explicitly extracted from the page.
  // Guessing a domain from an LLC name (e.g. "w29owner.com") wastes credits
  // on a domain that almost certainly doesn't exist.
  return lead.reonomy_company_domain.trim().toLowerCase();
}

export class HunterClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: HunterClientConfig) {
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

    const name = lead.reonomy_contact_name.trim();
    const domain = resolveExplicitDomain(lead);

    try {
      // When both a name and domain are known, run targeted lookup AND
      // domain-search in parallel — dedup happens downstream in mergeContactCandidates.
      // This yields up to 6 candidates (1 targeted + 5 domain) per property.
      if (name && domain) {
        const [targeted, domainContacts] = await Promise.all([
          this.limiter.schedule(() =>
            this.breaker.execute(() =>
              withRetry(() => this.fetchEmailForPerson(lead), {
                maxAttempts: this.config.maxAttempts,
                baseDelayMs: this.config.baseDelayMs,
                maxDelayMs: this.config.maxDelayMs,
              })
            )
          ),
          this.limiter.schedule(() =>
            this.breaker.execute(() =>
              withRetry(() => this.fetchDomainContacts(lead, domain), {
                maxAttempts: this.config.maxAttempts,
                baseDelayMs: this.config.baseDelayMs,
                maxDelayMs: this.config.maxDelayMs,
              })
            )
          ),
        ]);
        return [...targeted, ...domainContacts];
      }

      // Name only — targeted lookup costs 0 credits on no-match.
      if (name) {
        return await this.limiter.schedule(() =>
          this.breaker.execute(() =>
            withRetry(() => this.fetchEmailForPerson(lead), {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
            })
          )
        );
      }

      // Domain only — anonymous domain-search.
      if (domain) {
        return await this.limiter.schedule(() =>
          this.breaker.execute(() =>
            withRetry(() => this.fetchDomainContacts(lead, domain), {
              maxAttempts: this.config.maxAttempts,
              baseDelayMs: this.config.baseDelayMs,
              maxDelayMs: this.config.maxDelayMs,
            })
          )
        );
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Search for all decision-maker contacts at a given domain.
   * Used for domain-expansion after a contact email is first discovered.
   * Delegates to fetchDomainContacts with the full rate-limiter + circuit-breaker stack.
   */
  async findContactsByDomain(lead: EnrichedPropertyLead, domain: string): Promise<ContactCandidate[]> {
    if (!this.config.apiKey || !domain) return [];
    try {
      return await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchDomainContacts(lead, domain), {
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
   * Targeted lookup: /email-finder with full_name + company.
   * Hunter resolves the company → domain internally.
   * Zero credits charged when no email is found.
   */
  private async fetchEmailForPerson(
    lead: EnrichedPropertyLead
  ): Promise<ContactCandidate[]> {
    const url = new URL(`${this.config.baseUrl}/email-finder`);
    url.searchParams.set("api_key", this.config.apiKey ?? "");
    url.searchParams.set("full_name", lead.reonomy_contact_name.trim());
    url.searchParams.set("company", lead.owner_entity.trim());
    // Supply explicit domain when available — Hunter uses it as the primary
    // lookup key rather than inferring domain from company name.
    const domain = resolveExplicitDomain(lead);
    if (domain) url.searchParams.set("domain", domain);

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Hunter email-finder ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: {
        email?: string;
        score?: number;
        position?: string;
      };
    };

    const email = payload.data?.email?.trim().toLowerCase();
    if (!email) return [];

    return [{
      property_id: lead.property_id,
      owner_entity: lead.owner_entity,
      // Preserve the Reonomy name — it's higher fidelity than Hunter's guess.
      contact_name: lead.reonomy_contact_name,
      contact_title: lead.reonomy_contact_title || payload.data?.position?.trim() || "",
      contact_phone: lead.reonomy_contact_phone,
      contact_email: email,
      contact_source: "hunter" as const,
      confidence: typeof payload.data?.score === "number" ? payload.data.score / 100 : 0.7,
    }];
  }

  /**
   * Anonymous fallback: /domain-search for a confirmed explicit domain.
   */
  private async fetchDomainContacts(
    lead: EnrichedPropertyLead,
    domain: string
  ): Promise<ContactCandidate[]> {
    const url = new URL(`${this.config.baseUrl}/domain-search`);
    url.searchParams.set("api_key", this.config.apiKey ?? "");
    url.searchParams.set("domain", domain);
    url.searchParams.set("limit", "15");

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Hunter ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      data?: {
        emails?: Array<{
          value?: string;
          first_name?: string;
          last_name?: string;
          position?: string;
          confidence?: number;
        }>;
      };
    };

    return (payload.data?.emails ?? [])
      .filter((item) => Boolean(item.value))
      .map((item) => ({
        property_id: lead.property_id,
        owner_entity: lead.owner_entity,
        contact_name: `${item.first_name ?? ""} ${item.last_name ?? ""}`.trim(),
        contact_title: item.position?.trim() ?? "",
        contact_phone: "",
        contact_email: item.value?.trim().toLowerCase() ?? "",
        contact_source: "hunter" as const,
        confidence: typeof item.confidence === "number" ? item.confidence / 100 : 0.6,
      }));
  }
}
