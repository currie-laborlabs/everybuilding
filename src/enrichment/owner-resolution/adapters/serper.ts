/**
 * Serper / Google Search Resolver
 *
 * Queries Serper's Google Search API to infer a company's domain from
 * its name + location. Uses the SERPER_API_KEY env var.
 *
 * Search strategy:
 *   1. Prefer the knowledge graph website (high confidence).
 *   2. Fall back to first organic result not from a known directory.
 *
 * Skips cleanly when:
 *   - adapter is disabled
 *   - apiKey is missing
 *   - no non-directory result found
 *   - HTTP 401 / 403 / 429
 */

import type {
  OwnerResolutionInput,
  AdapterResult,
  OwnerResolutionAdapterConfig,
} from "../types";

/** Domains that are link aggregators / directories, not authoritative company sites. */
const DIRECTORY_DOMAINS = [
  "linkedin.com",
  "yellowpages.com",
  "yelp.com",
  "facebook.com",
  "whitepages.com",
  "manta.com",
  "bbb.org",
  "bizapedia.com",
  "zoominfo.com",
  "dnb.com",
];

function extractDomain(url: string): string {
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isDirectoryDomain(domain: string): boolean {
  return DIRECTORY_DOMAINS.some((d) => domain === d || domain.endsWith("." + d));
}

export class SerperSearchResolver {
  constructor(private readonly config: OwnerResolutionAdapterConfig) {}

  async resolve(input: OwnerResolutionInput): Promise<AdapterResult | null> {
    if (!this.config.enabled || !this.config.apiKey) return null;

    const companyName = (input.normalized_owner_name || input.raw_owner_name).trim();
    if (!companyName) return null;

    const location = [input.city, input.state].filter(Boolean).join(", ");
    const query =
      `"${companyName}" ${location} real estate OR property management`.trim();

    try {
      const baseUrl = this.config.baseUrl ?? "https://google.serper.dev/search";
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "X-API-KEY": this.config.apiKey,
        },
        body: JSON.stringify({ q: query, num: 5 }),
      });

      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) return null;
        throw new Error(`Serper search HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        organic?: Array<{ title?: string; link?: string; snippet?: string }>;
        knowledgeGraph?: { website?: string; title?: string };
      };

      // 1. Prefer knowledge graph — highest confidence
      if (payload.knowledgeGraph?.website) {
        const domain = extractDomain(payload.knowledgeGraph.website);
        if (domain && !isDirectoryDomain(domain)) {
          return {
            candidate_company_name:
              payload.knowledgeGraph.title?.trim() || companyName,
            candidate_domain: domain,
            source: "serper",
          };
        }
      }

      // 2. First organic result that isn't a directory
      for (const result of payload.organic ?? []) {
        if (!result.link) continue;
        const domain = extractDomain(result.link);
        if (!domain || isDirectoryDomain(domain)) continue;
        return {
          candidate_company_name: result.title?.trim() || companyName,
          candidate_domain: domain,
          source: "serper",
        };
      }

      return null;
    } catch {
      return null;
    }
  }
}
