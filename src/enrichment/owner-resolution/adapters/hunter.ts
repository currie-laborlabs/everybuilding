/**
 * Hunter Company/Domain Resolver
 *
 * Uses Hunter's GET /domain-search?company=<name> endpoint to find a company's
 * domain from its name. Reuses the existing HUNTER_API_KEY — no new key needed.
 *
 * Skips cleanly when:
 *   - adapter is disabled
 *   - apiKey is missing
 *   - Hunter returns no domain
 *   - HTTP 401 / 403 / 429
 */

import type {
  OwnerResolutionInput,
  AdapterResult,
  OwnerResolutionAdapterConfig,
} from "../types";

export class HunterCompanyResolver {
  constructor(private readonly config: OwnerResolutionAdapterConfig) {}

  async resolve(input: OwnerResolutionInput): Promise<AdapterResult | null> {
    if (!this.config.enabled || !this.config.apiKey) return null;

    const companyName = (input.normalized_owner_name || input.raw_owner_name).trim();
    if (!companyName) return null;

    try {
      const baseUrl = this.config.baseUrl ?? "https://api.hunter.io/v2";
      const url = new URL(`${baseUrl}/domain-search`);
      url.searchParams.set("api_key", this.config.apiKey);
      url.searchParams.set("company", companyName);
      url.searchParams.set("limit", "1");

      const response = await fetch(url.toString());

      // Treat auth / rate-limit errors as skip, not fatal
      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) return null;
        throw new Error(`Hunter domain-search HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        data?: { domain?: string; organization?: string };
        errors?: unknown[];
      };

      const domain = payload.data?.domain?.trim().toLowerCase();
      if (!domain) return null;

      return {
        candidate_company_name: payload.data?.organization?.trim() || companyName,
        candidate_domain: domain,
        source: "hunter",
      };
    } catch {
      return null;
    }
  }
}
