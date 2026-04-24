/**
 * src/tier2/instantly/pushToInstantly.ts
 *
 * Thin wrapper around the Instantly API v2 to add a lead + pre-composed email
 * to a client's campaign.
 *
 * Integration contract:
 *   The Instantly campaign template MUST use these variable names:
 *     Subject field : {{eb_subject}}
 *     Body field    : {{eb_body}}
 *
 *   Do NOT set a static subject/body in the Instantly campaign UI — leave them
 *   as variable references only. EveryBuilding owns all content.
 *
 * API reference: https://developer.instantly.ai/v2
 */

import type { GeneratedEmail } from "../types/index.js";
import type { CampaignConfig } from "../types/campaign.js";
import type { Tier2ContactRow } from "../types/index.js";

export interface InstantlyPushOptions {
  apiKey: string;
  /** Override base URL for testing. Default: https://api.instantly.ai/api/v2 */
  baseUrl?: string;
}

export interface InstantlyPushResult {
  success: boolean;
  lead_id?: string;
  error?: string;
}

const INSTANTLY_BASE_URL = "https://api.instantly.ai/api/v2";

/**
 * Formats a GeneratedEmail into the Instantly body variable.
 * Combines body + signature line + sign-off into a single plain-text block.
 */
function formatEmailBody(email: GeneratedEmail): string {
  return [
    email.body,
    "",
    email.signature_line,
    "",
    `${email.sender_sign_off},`,
    email.sender_full_name,
    email.sender_title,
  ]
    .join("\n")
    .trim();
}

/**
 * Splits a full name into first and last name.
 * Falls back gracefully if no space is present.
 */
function splitName(fullName: string): { first: string; last: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length <= 1) return { first: parts[0] ?? "", last: "" };
  const last = parts[parts.length - 1];
  const first = parts.slice(0, -1).join(" ");
  return { first, last };
}

/**
 * Adds a lead with a pre-composed email to the client's Instantly campaign.
 *
 * @param row      The contact row being processed
 * @param email    The validated GeneratedEmail to send
 * @param campaign Campaign config (contains Instantly campaign ID)
 * @param options  API key and optional overrides
 */
export async function pushToInstantly(
  row: Tier2ContactRow,
  email: GeneratedEmail,
  campaign: CampaignConfig,
  options: InstantlyPushOptions
): Promise<InstantlyPushResult> {
  const baseUrl = options.baseUrl ?? INSTANTLY_BASE_URL;
  const url = `${baseUrl}/leads`;

  const { first, last } = splitName(row.contact_name ?? "");

  const payload = {
    campaign_id: campaign.instantly_campaign_id,
    email: row.contact_email,
    first_name: first,
    last_name: last,
    company_name: row.owner_entity,
    variables: {
      eb_subject: email.subject,
      eb_body: formatEmailBody(email),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let errorText = "(no response body)";
    try {
      errorText = await response.text();
    } catch {
      // ignore
    }
    return {
      success: false,
      error: `Instantly API ${response.status}: ${errorText}`,
    };
  }

  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // Some 2xx responses may have an empty body
  }

  return {
    success: true,
    lead_id: typeof data["id"] === "string" ? data["id"] : undefined,
  };
}
