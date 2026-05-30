/**
 * Owner Resolution Layer — Orchestrating Resolver
 *
 * Runs all enabled adapters in parallel, scores each result, picks the best,
 * applies a multi-source domain bonus, then maps to a resolution status.
 *
 * This class never throws. All adapter errors are swallowed at the adapter
 * level via Promise.allSettled().
 */

import type {
  OwnerResolutionInput,
  OwnerResolutionResult,
  AdapterResult,
  OwnerResolutionConfig,
} from "./types";
import { scoreAdapterResult, applyThresholds } from "./scoring";
import { HunterCompanyResolver } from "./adapters/hunter";
import { ApolloOrganizationResolver } from "./adapters/apollo";
import { SerperSearchResolver } from "./adapters/serper";
import { OpenCorporatesResolver } from "./adapters/opencorporates";
import { CobaltSosResolver } from "./adapters/cobalt";

interface AdapterLike {
  resolve(input: OwnerResolutionInput): Promise<AdapterResult | null>;
}

export class OwnerResolver {
  private readonly adapters: AdapterLike[];

  constructor(
    private readonly resolverConfig: OwnerResolutionConfig,
    /** Reuse the existing HUNTER_API_KEY */
    hunterApiKey: string | undefined,
    /** Reuse the existing APOLLO_API_KEY */
    apolloApiKey: string | undefined,
    /** Requires SERPER_API_KEY */
    serperApiKey: string | undefined,
    /** Optional OPENCORPORATES_API_KEY (public endpoint works without it) */
    opencorporatesApiKey: string | undefined,
    /** Requires COBALT_API_KEY */
    cobaltApiKey?: string | undefined,
    cobaltBaseUrl?: string | undefined
  ) {
    this.adapters = [
      new CobaltSosResolver({
        enabled: resolverConfig.adapters.cobalt,
        apiKey: cobaltApiKey,
        baseUrl: cobaltBaseUrl,
      }),
      new HunterCompanyResolver({
        enabled: resolverConfig.adapters.hunter,
        apiKey: hunterApiKey,
      }),
      new ApolloOrganizationResolver({
        enabled: resolverConfig.adapters.apollo,
        apiKey: apolloApiKey,
      }),
      new SerperSearchResolver({
        enabled: resolverConfig.adapters.serper,
        apiKey: serperApiKey,
      }),
      new OpenCorporatesResolver({
        enabled: resolverConfig.adapters.opencorporates,
        apiKey: opencorporatesApiKey,
      }),
    ];
  }

  async resolve(input: OwnerResolutionInput): Promise<OwnerResolutionResult> {
    // Run all adapters concurrently; swallow individual failures
    const settled = await Promise.allSettled(
      this.adapters.map((a) => a.resolve(input))
    );

    // Collect and score successful, non-null results
    const scored: Array<{
      result: AdapterResult;
      score: number;
      signals: string[];
    }> = [];

    for (const s of settled) {
      if (s.status === "fulfilled" && s.value !== null) {
        const { score, signals } = scoreAdapterResult(input, s.value);
        scored.push({ result: s.value, score, signals });
      }
    }

    if (scored.length === 0) {
      return this.buildEmptyResult(input, "No adapter returned a result");
    }

    // Sort best first
    scored.sort((a, b) => b.score - a.score);
    const best = scored[0];

    // Multi-source domain bonus: same domain confirmed by ≥ 2 adapters
    const domainCounts = new Map<string, number>();
    for (const s of scored) {
      if (s.result.candidate_domain) {
        domainCounts.set(
          s.result.candidate_domain,
          (domainCounts.get(s.result.candidate_domain) ?? 0) + 1
        );
      }
    }

    let bonus = 0;
    if (best.result.candidate_domain) {
      const count = domainCounts.get(best.result.candidate_domain) ?? 0;
      if (count >= 2) {
        bonus = 15;
        best.signals.push("domain_multi_source");
      }
    }

    const finalScore = Math.max(0, Math.min(100, best.score + bonus));
    const status = applyThresholds(
      finalScore,
      this.resolverConfig.minResolvedScore,
      this.resolverConfig.minReviewScore
    );

    return {
      property_id: input.property_id,
      raw_owner_name: input.raw_owner_name,
      normalized_owner_name: input.normalized_owner_name,
      candidate_company_name: best.result.candidate_company_name,
      candidate_domain: best.result.candidate_domain,
      confidence_score: finalScore,
      resolution_status: status,
      resolution_source: best.result.source,
      matched_signals: best.signals,
      notes: best.signals.join(", "),
      registry_contact_name: best.result.matched_name,
      registry_contact_title: best.result.matched_name ? "Registered agent / officer" : "",
    };
  }

  private buildEmptyResult(
    input: OwnerResolutionInput,
    notes: string
  ): OwnerResolutionResult {
    return {
      property_id: input.property_id,
      raw_owner_name: input.raw_owner_name,
      normalized_owner_name: input.normalized_owner_name,
      candidate_company_name: "",
      candidate_domain: "",
      confidence_score: 0,
      resolution_status: "unresolved",
      resolution_source: "",
      matched_signals: [],
      notes,
      registry_contact_name: "",
      registry_contact_title: "",
    };
  }
}
