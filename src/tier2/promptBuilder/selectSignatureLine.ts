/**
 * Signature line selector — EveryBuilding Tier 2
 *
 * Picks the next SignatureBlurbType for a contact and formats it as a
 * single proof sentence inserted between the email body and the sign-off.
 *
 * Rotation rules:
 *   1. Never reuse a blurb type that appeared in the last 5 emails to this contact.
 *   2. Among eligible types, pick the first in canonical order (deterministic —
 *      same input always produces the same output, safe across retries).
 *   3. If all 7 types fall within the recent window (impossible with a 5-slot window
 *      and 7 types), fall back to the least-recently-used type.
 *
 * The formatted sentence is injected into the LLM prompt as a directive:
 *   "Use this exact Company Signature Line: '...'"
 * The LLM reproduces it verbatim — it does not compose the signature line.
 */

import type { SignatureBlurbType } from "../types/lead-row";
import type { SignatureLineContext, ResolvedSignatureLine } from "../types/prompt";
import type { SignatureLineData } from "../types/voice-profile";

// ─── Canonical rotation order ─────────────────────────────────────────────────

/**
 * The canonical order in which blurb types rotate.
 * Selection picks the first eligible type in this order so the output
 * is deterministic given the same `last_5_blurb_types` input.
 */
const BLURB_TYPE_ORDER: SignatureBlurbType[] = [
  "years_in_business",
  "certifications",
  "volume_scale",
  "signature_project",
  "review_themes",
  "service_area",
  "specialties",
];

// ─── Selector ─────────────────────────────────────────────────────────────────

/**
 * Resolves the next signature line for a contact send.
 *
 * @param context  Signature line source data + the contact's recent blurb history
 */
export function resolveSignatureLine(
  context: SignatureLineContext
): ResolvedSignatureLine {
  const recent = new Set(context.last_5_blurb_types);
  const eligible = BLURB_TYPE_ORDER.filter((t) => !recent.has(t));

  // Fallback: all eligible types are in the recent window (can't happen with
  // 7 types and a 5-slot window, but defensive nonetheless)
  const blurb_type: SignatureBlurbType =
    eligible.length > 0
      ? eligible[0]
      : (context.last_5_blurb_types[context.last_5_blurb_types.length - 1] ??
          "years_in_business");

  const text = formatBlurb(blurb_type, context.signature_line_data);
  return { blurb_type, text };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatBlurb(type: SignatureBlurbType, data: SignatureLineData): string {
  switch (type) {
    case "years_in_business":
      return `${data.years_in_business} years serving commercial properties in ${data.service_area}.`;

    case "service_area":
      return `Based in ${data.service_area}, with crews ready to mobilize quickly.`;

    case "specialties": {
      const list = joinList(data.core_specialties.slice(0, 3));
      return list
        ? `Specialists in ${list}.`
        : `Specialists in commercial property maintenance.`;
    }

    case "certifications": {
      const cert = data.certifications_and_awards[0];
      return cert ? `${cert}.` : `Licensed and insured for commercial work.`;
    }

    case "signature_project": {
      const summary = data.signature_projects_summary[0];
      return summary
        ? `${ensurePeriod(summary)}`
        : `Proven track record on commercial projects across the region.`;
    }

    case "review_themes": {
      const theme = data.top_review_themes[0];
      return theme
        ? `${ensurePeriod(theme)}`
        : `Trusted by property managers and owners across the region.`;
    }

    case "volume_scale": {
      const claim = data.volume_scale_claims[0];
      return claim
        ? `${ensurePeriod(claim)}`
        : `One of the region's most active commercial contractors.`;
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function joinList(items: string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function ensurePeriod(s: string): string {
  const trimmed = s.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}
