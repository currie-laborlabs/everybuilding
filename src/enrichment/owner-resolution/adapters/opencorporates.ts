/**
 * OpenCorporates Registry Resolver
 *
 * Uses the OpenCorporates public search API to look up LLC / entity records.
 * No API key required for low-volume public access.
 * Optional OPENCORPORATES_API_KEY for higher rate limits.
 *
 * Note: OpenCorporates does NOT return a company website/domain. This adapter
 * contributes the canonical company name to the scoring pipeline but leaves
 * candidate_domain empty. The scoring function awards name-match points only.
 *
 * Skips cleanly when:
 *   - adapter is disabled
 *   - no active companies found
 *   - HTTP 401 / 403 / 429
 */

import type {
  OwnerResolutionInput,
  AdapterResult,
  OwnerResolutionAdapterConfig,
} from "../types";

/** Maps US state abbreviations to OpenCorporates jurisdiction codes. */
const STATE_TO_JURISDICTION: Record<string, string> = {
  AL: "us_al", AK: "us_ak", AZ: "us_az", AR: "us_ar", CA: "us_ca",
  CO: "us_co", CT: "us_ct", DE: "us_de", FL: "us_fl", GA: "us_ga",
  HI: "us_hi", ID: "us_id", IL: "us_il", IN: "us_in", IA: "us_ia",
  KS: "us_ks", KY: "us_ky", LA: "us_la", ME: "us_me", MD: "us_md",
  MA: "us_ma", MI: "us_mi", MN: "us_mn", MS: "us_ms", MO: "us_mo",
  MT: "us_mt", NE: "us_ne", NV: "us_nv", NH: "us_nh", NJ: "us_nj",
  NM: "us_nm", NY: "us_ny", NC: "us_nc", ND: "us_nd", OH: "us_oh",
  OK: "us_ok", OR: "us_or", PA: "us_pa", RI: "us_ri", SC: "us_sc",
  SD: "us_sd", TN: "us_tn", TX: "us_tx", UT: "us_ut", VT: "us_vt",
  VA: "us_va", WA: "us_wa", WV: "us_wv", WI: "us_wi", WY: "us_wy",
};

export class OpenCorporatesResolver {
  constructor(private readonly config: OwnerResolutionAdapterConfig) {}

  async resolve(input: OwnerResolutionInput): Promise<AdapterResult | null> {
    if (!this.config.enabled) return null;

    const companyName = (input.normalized_owner_name || input.raw_owner_name).trim();
    if (!companyName) return null;

    try {
      const baseUrl =
        this.config.baseUrl ?? "https://api.opencorporates.com/v0.4";
      const url = new URL(`${baseUrl}/companies/search`);
      url.searchParams.set("q", companyName);

      const jurisdiction =
        input.state?.toUpperCase()
          ? STATE_TO_JURISDICTION[input.state.toUpperCase()]
          : undefined;
      if (jurisdiction) {
        url.searchParams.set("jurisdiction_code", jurisdiction);
      }

      // API token is optional — public endpoint works at low volume without it
      if (this.config.apiKey) {
        url.searchParams.set("api_token", this.config.apiKey);
      }

      const response = await fetch(url.toString(), {
        headers: { Accept: "application/json" },
      });

      if (!response.ok) {
        if ([401, 403, 429].includes(response.status)) return null;
        throw new Error(`OpenCorporates search HTTP ${response.status}`);
      }

      const payload = (await response.json()) as {
        results?: {
          companies?: Array<{
            company?: {
              name?: string;
              jurisdiction_code?: string;
              inactive?: boolean;
            };
          }>;
        };
      };

      // Only consider active entities
      const active = (payload.results?.companies ?? []).filter(
        (c) => !c.company?.inactive
      );

      const first = active[0]?.company;
      if (!first?.name) return null;

      return {
        candidate_company_name: first.name.trim(),
        candidate_domain: "", // OpenCorporates does not return a domain
        source: "opencorporates",
      };
    } catch {
      return null;
    }
  }
}
