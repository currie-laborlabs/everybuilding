/**
 * Owner Resolution Layer — Deterministic Scoring
 *
 * Scores an AdapterResult against an OwnerResolutionInput.
 * All scoring is deterministic — no LLM, no randomness.
 *
 * Weight table:
 *   +30  exact name match (normalized)
 *   +20  partial name match (normalized)
 *   +15  city match
 *   +10  state match
 *   +15  domain found
 *   +10  real estate / PM / holdings industry signal
 *   +10  raw owner name fallback match
 *   +15  domain confirmed by 2+ adapters (applied in resolver, not here)
 *   -15  state mismatch
 *   -20  name mismatch (company name present but doesn't match)
 *
 * Thresholds (configurable, defaults set in config.ts):
 *   >= 75  → resolved
 *   50–74  → needs_review
 *   < 50   → unresolved
 */

import type { OwnerResolutionInput, AdapterResult } from "./types";

export interface ScoreResult {
  score: number;
  signals: string[];
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .trim();
}

function isNameMatch(a: string, b: string): "exact" | "partial" | "none" {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return "none";
  if (na === nb) return "exact";
  if (na.includes(nb) || nb.includes(na)) return "partial";
  // Share at least one meaningful word (>3 chars)
  const wordsA = na.split(/\s+/);
  const wordsB = nb.split(/\s+/);
  const shared = wordsA.filter((w) => w.length > 3 && wordsB.includes(w));
  if (shared.length >= 1) return "partial";
  return "none";
}

const RE_KEYWORDS = [
  "real estate",
  "property",
  "realty",
  "properties",
  "holdings",
  "capital",
  "management",
  "investments",
  "assets",
  "group",
  "ventures",
  "commercial",
  "industrial",
  "partners",
  "development",
  "portfolio",
];

function hasRealEstateSignal(industry: string | undefined, name: string): boolean {
  const combined = ((industry ?? "") + " " + name).toLowerCase();
  return RE_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * Score a single adapter result against the resolution input.
 * Does NOT apply the multi-source domain bonus — that is applied by the resolver.
 */
export function scoreAdapterResult(
  input: OwnerResolutionInput,
  result: AdapterResult
): ScoreResult {
  let score = 0;
  const signals: string[] = [];

  // Name match
  const nameMatch = isNameMatch(input.normalized_owner_name, result.candidate_company_name);
  if (nameMatch === "exact") {
    score += 30;
    signals.push("name_exact_match");
  } else if (nameMatch === "partial") {
    score += 20;
    signals.push("name_partial_match");
  } else if (result.candidate_company_name.trim()) {
    score -= 20;
    signals.push("name_mismatch");
  }

  // State match / mismatch
  if (input.state && result.matched_state) {
    if (input.state.toUpperCase() === result.matched_state.toUpperCase()) {
      score += 10;
      signals.push("state_match");
    } else {
      score -= 15;
      signals.push("state_mismatch");
    }
  }

  // City match
  if (input.city && result.matched_city) {
    if (normalizeText(input.city) === normalizeText(result.matched_city)) {
      score += 15;
      signals.push("city_match");
    }
  }

  // Real estate / PM / holdings industry signal
  if (hasRealEstateSignal(result.industry, result.candidate_company_name)) {
    score += 10;
    signals.push("re_industry_signal");
  }

  // Domain found
  if (result.candidate_domain.trim()) {
    score += 15;
    signals.push("domain_found");
  }

  // Raw owner name fallback — if normalized_owner_name already matched, skip
  if (
    input.raw_owner_name &&
    input.raw_owner_name !== input.normalized_owner_name
  ) {
    const rawMatch = isNameMatch(input.raw_owner_name, result.candidate_company_name);
    if (
      rawMatch !== "none" &&
      !signals.includes("name_exact_match") &&
      !signals.includes("name_partial_match")
    ) {
      score += 10;
      signals.push("raw_name_match");
    }
  }

  return { score, signals };
}

/**
 * Map a final numeric score to a resolution status string.
 * Thresholds are passed from config (not hardcoded here).
 */
export function applyThresholds(
  score: number,
  minResolvedScore: number,
  minReviewScore: number
): "resolved" | "needs_review" | "unresolved" {
  if (score >= minResolvedScore) return "resolved";
  if (score >= minReviewScore) return "needs_review";
  return "unresolved";
}
