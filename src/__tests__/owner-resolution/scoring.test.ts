/**
 * Tests for the scoring module.
 * All deterministic — no API calls, no mocking needed.
 */

import { describe, it, expect } from "vitest";
import {
  scoreAdapterResult,
  applyThresholds,
} from "../../enrichment/owner-resolution/scoring";
import type {
  OwnerResolutionInput,
  AdapterResult,
} from "../../enrichment/owner-resolution/types";

function makeInput(overrides?: Partial<OwnerResolutionInput>): OwnerResolutionInput {
  return {
    property_id: "test-001",
    raw_owner_name: "Acme Holdings LLC",
    normalized_owner_name: "Acme Holdings LLC",
    owner_type: "",
    owner_mailing_address: "",
    care_of_name: "",
    property_address: "123 Main St",
    city: "Los Angeles",
    state: "CA",
    zip: "90001",
    source_platform: "reonomy",
    ...overrides,
  };
}

function makeResult(overrides?: Partial<AdapterResult>): AdapterResult {
  return {
    candidate_company_name: "Acme Holdings LLC",
    candidate_domain: "acmeholdings.com",
    matched_city: "Los Angeles",
    matched_state: "CA",
    industry: "real estate",
    source: "apollo",
    ...overrides,
  };
}

describe("scoreAdapterResult", () => {
  it("awards points for exact name match + state + city + domain + industry", () => {
    const { score, signals } = scoreAdapterResult(makeInput(), makeResult());
    expect(signals).toContain("name_exact_match");
    expect(signals).toContain("state_match");
    expect(signals).toContain("city_match");
    expect(signals).toContain("domain_found");
    expect(signals).toContain("re_industry_signal");
    // 30 (name) + 10 (state) + 15 (city) + 15 (domain) + 10 (RE) = 80
    expect(score).toBe(80);
  });

  it("awards partial name match when owner name is contained in company name", () => {
    const input = makeInput({ normalized_owner_name: "Acme Holdings" });
    const result = makeResult({ candidate_company_name: "Acme Holdings LLC" });
    const { signals } = scoreAdapterResult(input, result);
    expect(signals).toContain("name_partial_match");
    expect(signals).not.toContain("name_exact_match");
  });

  it("applies name_mismatch penalty when names differ", () => {
    const input = makeInput({ normalized_owner_name: "Smith Family Trust" });
    // Use a result with no city/state/domain to isolate the name mismatch penalty
    const result = makeResult({
      candidate_company_name: "Zephyr Capital Corp",
      matched_city: undefined,
      matched_state: undefined,
      candidate_domain: "",
      industry: undefined,
    });
    const { score, signals } = scoreAdapterResult(input, result);
    expect(signals).toContain("name_mismatch");
    // -20 penalty, no positive signals → score < 0
    expect(score).toBeLessThan(0);
  });

  it("applies state_mismatch penalty when states differ", () => {
    const input = makeInput({ state: "CA" });
    const result = makeResult({ matched_state: "NY" });
    const { signals } = scoreAdapterResult(input, result);
    expect(signals).toContain("state_mismatch");
  });

  it("does not penalize when matched_state is missing", () => {
    const result = makeResult({ matched_state: undefined });
    const { signals } = scoreAdapterResult(makeInput(), result);
    expect(signals).not.toContain("state_match");
    expect(signals).not.toContain("state_mismatch");
  });

  it("does not award domain_found when domain is empty", () => {
    const result = makeResult({ candidate_domain: "" });
    const { signals } = scoreAdapterResult(makeInput(), result);
    expect(signals).not.toContain("domain_found");
  });

  it("awards raw_name_match when raw differs from normalized and matches result", () => {
    const input = makeInput({
      raw_owner_name: "ACME HOLDINGS LLC",
      normalized_owner_name: "Unknown Entity",
    });
    const result = makeResult({ candidate_company_name: "Acme Holdings LLC" });
    const { signals } = scoreAdapterResult(input, result);
    expect(signals).toContain("raw_name_match");
  });
});

describe("applyThresholds", () => {
  it("returns resolved when score >= minResolvedScore", () => {
    expect(applyThresholds(80, 75, 50)).toBe("resolved");
    expect(applyThresholds(75, 75, 50)).toBe("resolved");
  });

  it("returns needs_review when score is between thresholds", () => {
    expect(applyThresholds(60, 75, 50)).toBe("needs_review");
    expect(applyThresholds(50, 75, 50)).toBe("needs_review");
  });

  it("returns unresolved when score < minReviewScore", () => {
    expect(applyThresholds(49, 75, 50)).toBe("unresolved");
    expect(applyThresholds(0, 75, 50)).toBe("unresolved");
    expect(applyThresholds(-10, 75, 50)).toBe("unresolved");
  });

  it("respects custom thresholds", () => {
    expect(applyThresholds(60, 90, 60)).toBe("needs_review");
    expect(applyThresholds(59, 90, 60)).toBe("unresolved");
    expect(applyThresholds(91, 90, 60)).toBe("resolved");
  });
});
