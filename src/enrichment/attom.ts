import type { EnrichedPropertyLead, NormalizedLead } from "../types";
import { CircuitBreaker } from "../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../infra/rateLimiter";
import { withRetry } from "../infra/retry";

export interface AttomClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

export class AttomClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: AttomClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  async enrichLead(lead: NormalizedLead): Promise<EnrichedPropertyLead> {
    if (!this.config.apiKey) {
      return {
        ...lead,
        last_sale_date: "",
        last_sale_price: "",
        permit_summary: "",
        roof_permit_date: "",
        hvac_permit_date: "",
        ownership_transfer_flag: "",
        tax_or_distress_notes: "",
        enrichment_status: "skipped",
      };
    }

    try {
      const response = await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchAttomPayload(lead), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );

      return this.mapPayload(lead, response);
    } catch (error) {
      return {
        ...lead,
        last_sale_date: "",
        last_sale_price: "",
        permit_summary: "",
        roof_permit_date: "",
        hvac_permit_date: "",
        ownership_transfer_flag: "",
        tax_or_distress_notes: "",
        enrichment_status: "failed",
      };
    }
  }

  private async fetchAttomPayload(lead: NormalizedLead): Promise<unknown> {
    const url = new URL(`${this.config.baseUrl}/property/detail`);
    // ATTOM requires address1 (street) + address2 (city state zip).
    // address1+postalcode alone is an invalid parameter combination (-4).
    url.searchParams.set("address1", lead.property_address);
    url.searchParams.set(
      "address2",
      `${lead.city} ${lead.state} ${lead.zip_code}`.trim()
    );

    const response = await fetch(url, {
      headers: {
        apikey: this.config.apiKey ?? "",
        accept: "application/json",
      },
    });

    if (!response.ok) {
      throw new Error(`ATTOM ${response.status} ${response.statusText}`);
    }

    return response.json();
  }

  private mapPayload(lead: NormalizedLead, payload: unknown): EnrichedPropertyLead {
    const data = payload as {
      property?: Array<{
        sale?: { amount?: number; saleTransDate?: string };
        building?: { size?: { universalsize?: number }; construction?: { yearBuilt?: number } };
        owner?: { name?: string };
        assessment?: { tax?: { taxAmt?: number } };
      }>;
    };

    const first = data.property?.[0];
    const saleAmount = first?.sale?.amount;
    const saleDate = first?.sale?.saleTransDate;
    const taxAmount = first?.assessment?.tax?.taxAmt;

    return {
      ...lead,
      last_sale_date: saleDate ?? "",
      last_sale_price: saleAmount ? String(saleAmount) : "",
      permit_summary: "",
      roof_permit_date: "",
      hvac_permit_date: "",
      ownership_transfer_flag: "",
      tax_or_distress_notes: taxAmount ? `tax: $${taxAmount}` : "",
      enrichment_status: first ? "success" : "partial",
    };
  }
}
