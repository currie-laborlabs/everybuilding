/**
 * CTA condition evaluator — EveryBuilding Tier 2
 *
 * Determines whether a given CTA is eligible to send for a contact.
 * When a condition is unmet and skip_when_unmet is true, the pipeline
 * advances to the next CTA number rather than blocking the cycle.
 *
 * Current Phase 2 stubs:
 *   CTA #8 (weather_trigger) — always evaluates as unmet until NOAA is integrated.
 *   CTA #9 (proximity)       — always eligible; nearby-job data improves quality but is not required.
 */

import type { CtaEntry, CtaNumber } from "../types/cta";
import { nextCtaNumber } from "../types/cta";

// ─── Result ───────────────────────────────────────────────────────────────────

export type CtaEvaluationResult =
  | { eligible: true }
  | { eligible: false; reason: string; advance_to: CtaNumber };

// ─── External condition data (placeholder for Phase 2) ───────────────────────

/**
 * Data from external sources used to evaluate CTA conditions.
 * All fields are optional — absent = condition cannot be checked = unmet.
 *
 * Phase 2: populate storm_within_50mi_30days from NOAA API.
 */
export interface CtaConditionData {
  /** Whether a qualifying storm event occurred within 50 miles in the last 30 days */
  storm_within_50mi_30days?: boolean;
  /** Whether a nearby completed job exists for this property's area */
  has_nearby_job?: boolean;
}

// ─── Evaluator ────────────────────────────────────────────────────────────────

/**
 * Evaluates whether a CTA entry is eligible for the current send cycle.
 *
 * Call this before building a prompt. If the result is `eligible: false`,
 * record `advance_to` as the new `next_cta_number` on the row and skip
 * this cycle — do not compose or send an email.
 *
 * @param cta          The CTA entry from the playbook
 * @param externalData Optional condition data from external sources
 */
export function evaluateCta(
  cta: CtaEntry,
  externalData: CtaConditionData = {}
): CtaEvaluationResult {
  if (cta.condition === null) {
    return { eligible: true };
  }

  const conditionMet = checkCondition(cta, externalData);

  if (conditionMet) {
    return { eligible: true };
  }

  // Condition not met — skip to next CTA
  return {
    eligible: false,
    reason: cta.condition.description,
    advance_to: nextCtaNumber(cta.cta_number),
  };
}

// ─── Internal condition checks ────────────────────────────────────────────────

function checkCondition(cta: CtaEntry, data: CtaConditionData): boolean {
  switch (cta.name) {
    case "weather_trigger":
      // Phase 2: evaluate data.storm_within_50mi_30days
      // Until NOAA integration is built, always skip CTA #8
      return data.storm_within_50mi_30days === true;

    case "proximity":
      // Soft condition — eligible even without nearby job data,
      // but the email quality is better when data.has_nearby_job is true.
      // Always eligible; no hard skip.
      return true;

    default:
      // All other CTAs have no conditions
      return true;
  }
}
