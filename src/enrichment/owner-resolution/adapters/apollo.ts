/**
 * Apollo Organization Resolver
 *
 * Uses Apollo's POST /organizations/search endpoint to find an organization's
 * domain and metadata from its name. Reuses the existing APOLLO_API_KEY.
 *
 * Skips cleanly when:
 *   - adapter is disabled
 *   - apiKey is missing
 *   - Apollo returns no organizations
 *   - HTTP 401 / 403 / 429
 */

import type {
  OwnerResolutionInput,
  AdapterResult,
  OwnerResolutionAdapterConfig,
} from "../types";

function extractDomain(url?: string): string {
  if (!url) return "";
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export class ApolloOrganizationResolver {
  constructor(private readonly config: OwnerResolutionAdapterConfig) {}

  async resolve(input: OwnerResolutionInput): Promise<AdapterResult | null> {
    if (!this.config.enabled || !this.config.apiKey) return null;

    const companyName = (input.normalized_owner_name || input.raw_owner_name).trim();
    if (!companyName) return null;

    try {
      const baseUrl = this.config.baseUrl ?? "https://api.apollo.io/api/v1";
      const response = await fetch(`${baseUrl}/organizations/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": this.config.apiKey,
        },
        body: JSON.stringify({
          q_organization_name: companyName,
          page: 1,
          per_page: 3,
        }),
      });

      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) return null;
        throw new Error(`Apollo organizations/search HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        organizations?: Array<{
          name?: string;
          website_url?: string;
          primary_domain?: string;
          city?: string;
          state?: string;
          industry?: string;
        }>;
      };

      const org = payload.organizations?.[0];
      if (!org) return null;

      const domain =
        org.primary_domain?.trim().toLowerCase() || extractDomain(org.website_url);

      if (!domain && !org.name) return null;

      return {
        candidate_company_name: org.name?.trim() || companyName,
        candidate_domain: domain,
        matched_city: org.city,
        matched_state: org.state,
        industry: org.industry,
        source: "apollo",
      };
    } catch {
      return null;
    }
  }
}
