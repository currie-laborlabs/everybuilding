import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
import { config } from "../../config";
import { CircuitBreaker } from "../../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../../infra/rateLimiter";
import { withRetry } from "../../infra/retry";

export interface ApolloClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

export class ApolloClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: ApolloClientConfig) {
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

  private async fetchContacts(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    const domain = lead.reonomy_company_domain?.trim() ?? "";

    // When we have no domain AND no owner name, there's nothing to search on.
    if (!domain && !lead.owner_entity?.trim()) return [];

    // Build a location string from the lead's city+state to constrain results
    // geographically when no domain is available. This prevents Apollo from
    // returning people at unrelated companies with a similar name in other states.
    const locationParts = [lead.city?.trim(), lead.state?.trim()].filter(Boolean);
    const locationFilter = locationParts.length > 0 ? locationParts.join(", ") : null;

    // Step 1: Search for people at this organization.
    // The new api_search endpoint returns obfuscated candidates — emails are
    // not included in the search response and must be revealed individually.
    const searchUrl = `${this.config.baseUrl}/mixed_people/api_search`;
    const searchResponse = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey ?? "",
      },
      body: JSON.stringify({
        q_organization_name: lead.owner_entity,
        // Domain takes priority — highest precision. When Owner Resolution
        // resolves a domain from an LLC name, use it.
        ...(domain ? { q_organization_domains: [domain] } : {}),
        // Without a domain, constrain by city+state so we don't pull contacts
        // from an unrelated company with the same name in another state.
        ...(!domain && locationFilter
          ? { organization_locations: [locationFilter] }
          : {}),
        // Narrow to a specific person when a name is already known from Reonomy.
        ...(lead.reonomy_contact_name.trim() ? { name: lead.reonomy_contact_name.trim() } : {}),
        // Target decision-maker titles only — owner, VP, director, property manager, etc.
        // Avoids wasting credits revealing emails for non-decision-maker staff.
        q_person_titles: config.run.apolloTargetTitles,
        page: 1,
        per_page: 10,
      }),
    });

    if (!searchResponse.ok) {
      throw new Error(`Apollo search ${searchResponse.status} ${searchResponse.statusText}`);
    }

    const payload = (await searchResponse.json()) as {
      people?: Array<{
        id?: string;
        first_name?: string;
        last_name?: string;
        title?: string;
        has_email?: boolean;
      }>;
    };

    // Only enrich people Apollo confirms have an email — avoids wasting credits.
    const candidates = (payload.people ?? []).filter((p) => p.has_email && p.id);
    if (candidates.length === 0) {
      // When no domain was available for the initial search, try to resolve one
      // via /organizations/search — converts LLC names to real domains, enabling
      // a full domain-based contact pass without burning name-match credits.
      if (!domain && lead.owner_entity?.trim()) {
        const resolvedDomain = await this.resolveOrgDomain(lead.owner_entity, locationFilter);
        if (resolvedDomain) {
          const domainResults = await this.fetchContactsByDomain(lead, resolvedDomain);
          if (domainResults.length > 0) return domainResults;
        }
      }
      // Final fallback: /people/match by name when a contact name is already known.
      if (lead.reonomy_contact_name.trim()) {
        return this.matchPersonByName(lead);
      }
      return [];
    }

    // Step 2: Reveal each candidate's email via /people/match (1 credit each).
    // Failures are silently skipped — a single person failing shouldn't abort
    // the rest of the candidates for this property.
    const results: ContactCandidate[] = [];
    for (const person of candidates) {
      const enriched = await this.enrichPerson(person.id!);
      if (enriched?.email) {
        results.push({
          property_id: lead.property_id,
          owner_entity: lead.owner_entity,
          contact_name: (enriched.name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`).trim(),
          contact_title: (enriched.title ?? person.title ?? "").trim(),
          contact_phone: enriched.direct_phone?.trim() || enriched.mobile_phone?.trim() || "",
          contact_email: enriched.email.trim().toLowerCase(),
          contact_linkedin: enriched.linkedin_url?.trim() ?? "",
          contact_source: "apollo" as const,
          confidence: 0.85,
        });
      }
    }
    return results;
  }

  /**
   * Reveal a person's full profile (including email) using their Apollo ID.
   * Uses the /people/match endpoint with an explicit ID — costs 1 credit.
   * Returns null on any failure so callers can skip gracefully.
   */
  private async enrichPerson(personId: string): Promise<{
    name?: string;
    title?: string;
    email?: string;
    direct_phone?: string;
    mobile_phone?: string;
    linkedin_url?: string;
  } | null> {
    try {
      const response = await fetch(`${this.config.baseUrl}/people/match`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey ?? "",
        },
        body: JSON.stringify({ id: personId, reveal_personal_emails: config.providers.apollo.revealPersonalEmails }),
      });
      if (!response.ok) return null;
      const data = (await response.json()) as {
        person?: { name?: string; title?: string; email?: string; direct_phone?: string; mobile_phone?: string; linkedin_url?: string };
      };
      return data.person ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Search for all decision-maker contacts at a given domain.
   * Used for domain-expansion after a contact email is first discovered.
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

  private async fetchContactsByDomain(lead: EnrichedPropertyLead, domain: string): Promise<ContactCandidate[]> {
    const searchUrl = `${this.config.baseUrl}/mixed_people/api_search`;
    const searchResponse = await fetch(searchUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey ?? "",
      },
      body: JSON.stringify({
        q_organization_domains: [domain],
        q_person_titles: config.run.apolloTargetTitles,
        page: 1,
        per_page: 10,
      }),
    });

    if (!searchResponse.ok) {
      throw new Error(`Apollo domain search ${searchResponse.status} ${searchResponse.statusText}`);
    }

    const payload = (await searchResponse.json()) as {
      people?: Array<{
        id?: string;
        first_name?: string;
        last_name?: string;
        title?: string;
        has_email?: boolean;
      }>;
    };

    const candidates = (payload.people ?? []).filter((p) => p.has_email && p.id);
    if (candidates.length === 0) return [];

    const results: ContactCandidate[] = [];
    for (const person of candidates) {
      const enriched = await this.enrichPerson(person.id!);
      if (enriched?.email) {
        results.push({
          property_id: lead.property_id,
          owner_entity: lead.owner_entity,
          contact_name: (enriched.name ?? `${person.first_name ?? ""} ${person.last_name ?? ""}`).trim(),
          contact_title: (enriched.title ?? person.title ?? "").trim(),
          contact_phone: enriched.direct_phone?.trim() || enriched.mobile_phone?.trim() || "",
          contact_email: enriched.email.trim().toLowerCase(),
          contact_linkedin: enriched.linkedin_url?.trim() ?? "",
          contact_source: "apollo" as const,
          confidence: 0.85,
        });
      }
    }
    return results;
  }

  /**
   * Resolve an organization name to its primary domain via Apollo /organizations/search.
   * Free — org search does not consume email reveal credits.
   * Returns "" on no match or any failure.
   */
  private async resolveOrgDomain(ownerEntity: string, locationFilter: string | null): Promise<string> {
    try {
      const response = await fetch(`${this.config.baseUrl}/organizations/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey ?? "",
        },
        body: JSON.stringify({
          q_organization_name: ownerEntity,
          ...(locationFilter ? { organization_locations: [locationFilter] } : {}),
          page: 1,
          per_page: 1,
        }),
      });
      if (!response.ok) return "";
      const data = (await response.json()) as {
        organizations?: Array<{ primary_domain?: string }>;
      };
      return data.organizations?.[0]?.primary_domain?.trim().toLowerCase() ?? "";
    } catch {
      return "";
    }
  }

  /**
   * Direct /people/match lookup by name + organization.
   * Fallback when the Apollo org search returns no results (e.g. LLC names).
   * Costs 1 credit. If reonomy_contact_email is known, passing it causes Apollo
   * to match on email first (returns profile without consuming an extra credit).
   */
  private async matchPersonByName(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    const nameParts = lead.reonomy_contact_name.trim().split(/\s+/);
    const firstName = nameParts[0] ?? "";
    const lastName = nameParts.slice(1).join(" ");
    if (!firstName) return [];

    const body: Record<string, unknown> = {
      first_name: firstName,
      organization_name: lead.owner_entity,
      reveal_personal_emails: config.providers.apollo.revealPersonalEmails,
    };
    if (lastName) body.last_name = lastName;
    if (lead.reonomy_contact_email.trim()) body.email = lead.reonomy_contact_email.trim();

    try {
      const response = await fetch(`${this.config.baseUrl}/people/match`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey ?? "",
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) return [];
      const data = (await response.json()) as {
        person?: { name?: string; title?: string; email?: string; direct_phone?: string; mobile_phone?: string; linkedin_url?: string };
      };
      const person = data.person;
      if (!person?.email) return [];
      return [{
        property_id: lead.property_id,
        owner_entity: lead.owner_entity,
        contact_name: (person.name ?? lead.reonomy_contact_name).trim(),
        contact_title: (person.title ?? lead.reonomy_contact_title ?? "").trim(),
        contact_phone: person.direct_phone?.trim() || person.mobile_phone?.trim() || lead.reonomy_contact_phone,
        contact_email: person.email.trim().toLowerCase(),
        contact_linkedin: person.linkedin_url?.trim() ?? "",
        contact_source: "apollo" as const,
        confidence: 0.9,
      }];
    } catch {
      return [];
    }
  }
}
