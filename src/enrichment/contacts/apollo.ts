import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
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
    const url = `${this.config.baseUrl}/mixed_people/search`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.config.apiKey ?? "",
      },
      body: JSON.stringify({
        q_organization_name: lead.owner_entity,
        // Narrow to a specific person when a name is already known from Reonomy.
        // If omitted, Apollo returns anyone at the org.
        ...(lead.reonomy_contact_name.trim() ? { name: lead.reonomy_contact_name.trim() } : {}),
        page: 1,
        per_page: 5,
      }),
    });

    if (!response.ok) {
      throw new Error(`Apollo ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      people?: Array<{
        name?: string;
        title?: string;
        email?: string;
      }>;
    };

    return (payload.people ?? [])
      .filter((person) => Boolean(person.email))
      .map((person) => ({
        property_id: lead.property_id,
        owner_entity: lead.owner_entity,
        contact_name: person.name?.trim() ?? "",
        contact_title: person.title?.trim() ?? "",
        contact_phone: "",
        contact_email: person.email?.trim().toLowerCase() ?? "",
        contact_source: "apollo" as const,
        confidence: 0.85,
      }));
  }
}
