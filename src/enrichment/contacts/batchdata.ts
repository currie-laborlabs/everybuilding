/**
 * src/enrichment/contacts/batchdata.ts
 *
 * BatchData Skip Trace client — finds phone numbers and email addresses for
 * property owners using BatchData's V3 Skip Trace API.
 *
 * Unlike Apollo/Hunter (which search professional contact databases by company
 * domain or job title), BatchData skip trace is ADDRESS-BASED: given a property
 * address it returns the people associated with that property as identified by
 * public records and identity data.
 *
 * This makes it complementary to Apollo/Hunter:
 *   - Apollo/Hunter excel at LLC principals with a professional web presence
 *   - BatchData excels at individual investors, absentee landlords, and entities
 *     with no indexed professional profile
 *
 * API: POST https://api.batchdata.com/api/v1/property/skip-trace
 * Auth: Authorization: Bearer <BATCHDATA_API_KEY>
 *
 * Results (up to 3 persons per property):
 *   - name (first, last)
 *   - phoneNumbers[]: number, type, carrier, reachable, dnc, tcpa, score
 *   - emails[]: email, tested
 *   - meta.matched, litigator, deceased
 *
 * TCPA/DNC compliance: phone numbers flagged with tcpa=true or dnc=true are
 * suppressed — they are never included in contact candidates returned by this
 * client. Only reachable numbers are included unless BATCHDATA_INCLUDE_UNREACHABLE
 * is set to true.
 */

import type { ContactCandidate, EnrichedPropertyLead } from "../../types";
import { CircuitBreaker } from "../../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../../infra/rateLimiter";
import { withRetry } from "../../infra/retry";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface BatchDataClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
  /** When false (default), suppresses phone numbers where reachable=false */
  includeUnreachable?: boolean;
}

interface BatchDataPhone {
  number?: string;
  type?: string;       // "Mobile" | "Landline"
  carrier?: string;
  reachable?: boolean;
  dnc?: boolean;       // Do Not Call registry
  tcpa?: boolean;      // TCPA litigator list
  score?: number;      // higher = more confident
  lastReportedDate?: string;
}

interface BatchDataEmail {
  email?: string;
  tested?: boolean;    // true = deliverable
}

interface BatchDataPerson {
  name?: {
    first?: string;
    middle?: string;
    last?: string;
  };
  phoneNumbers?: BatchDataPhone[];
  emails?: BatchDataEmail[];
  meta?: {
    matched?: boolean;
    error?: boolean;
    errorMessage?: string;
  };
  litigator?: boolean;
  death?: {
    deceased?: boolean;
  };
}

interface BatchDataSkipTraceResponse {
  status?: { code?: number; text?: string };
  results?: {
    persons?: BatchDataPerson[];
    meta?: {
      results?: { requestCount?: number; matchCount?: number; errorCount?: number };
      requestId?: string;
      apiVersion?: string;
    };
  };
  // Error fields
  message?: string;
  error?: string;
}

// ── Client ────────────────────────────────────────────────────────────────────

export class BatchDataSkipTraceClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: BatchDataClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  async findContacts(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    if (!this.config.apiKey) return [];

    // Need at minimum a property address to skip trace
    if (!lead.property_address?.trim()) return [];

    try {
      return await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchSkipTrace(lead), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );
    } catch (err) {
      console.warn(`[batchdata] skip trace failed for "${lead.property_address}": ${(err as Error).message}`);
      return [];
    }
  }

  private async fetchSkipTrace(lead: EnrichedPropertyLead): Promise<ContactCandidate[]> {
    const url = `${this.config.baseUrl}/api/v1/property/skip-trace`;

    // Parse owner name — only pass to the API when it looks like a real person
    // (not an LLC/Corp/Trust), since skip trace expects a human name.
    const { firstName, lastName } = parseOwnerName(lead.owner_entity);

    const requestBody = {
      requests: [
        {
          propertyAddress: {
            street: lead.property_address.trim(),
            city: lead.city.trim(),
            state: lead.state.trim(),
            zip: lead.zip_code.trim(),
          },
          // Only include name fields when we have a plausible individual name
          ...(firstName ? { firstName } : {}),
          ...(lastName ? { lastName } : {}),
        },
      ],
    };

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    if (response.status === 402) {
      console.warn("[batchdata] Out of credits (402). Skipping BatchData for this lead.");
      return [];
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`BatchData skip trace ${response.status} ${response.statusText} — ${body.slice(0, 300)}`);
    }

    const payload = (await response.json()) as BatchDataSkipTraceResponse;

    // Actual response shape: payload.results.persons[]
    const persons: BatchDataPerson[] = payload?.results?.persons ?? [];

    if (persons.length === 0) return [];

    // Filter out error/unmatched entries before mapping
    const validPersons = persons.filter((p) => !p.meta?.error && p.meta?.matched !== false);
    if (validPersons.length === 0) return [];

    return this.mapPersons(lead, validPersons);
  }

  private mapPersons(
    lead: EnrichedPropertyLead,
    persons: BatchDataPerson[]
  ): ContactCandidate[] {
    const candidates: ContactCandidate[] = [];

    for (const person of persons) {
      // Skip deceased owners
      if (person.death?.deceased) continue;
      // Skip matched=false (no identity found)
      if (person.meta?.matched === false) continue;

      const firstName = person.name?.first?.trim() ?? "";
      const lastName = person.name?.last?.trim() ?? "";
      const fullName = [firstName, lastName].filter(Boolean).join(" ");

      // ── Phones ────────────────────────────────────────────────────────────
      // Filter: exclude DNC/TCPA flagged numbers (compliance)
      // Optionally exclude non-reachable numbers (default: exclude)
      const validPhones = (person.phoneNumbers ?? []).filter((ph) => {
        if (!ph.number) return false;
        if (ph.dnc) return false;   // Do Not Call — never include
        if (ph.tcpa) return false;  // TCPA litigator — never include
        if (!this.config.includeUnreachable && ph.reachable === false) return false;
        return true;
      });

      // Sort by score descending (higher = more confident)
      validPhones.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

      // ── Emails ────────────────────────────────────────────────────────────
      // Prefer tested (verified-deliverable) emails first
      const validEmails = (person.emails ?? [])
        .filter((em) => em.email?.trim())
        .sort((a, b) => (b.tested ? 1 : 0) - (a.tested ? 1 : 0));

      // Build one candidate per email (zip with best phones), or one candidate
      // per phone when no emails are available — matches the existing multi-row
      // expansion pattern used by Reonomy contacts.
      const rowCount = Math.max(validEmails.length, validPhones.length > 0 ? 1 : 0, 0);

      if (rowCount === 0 && !fullName) continue;

      if (rowCount === 0) {
        // Person found but no contactable info after compliance filtering
        candidates.push({
          property_id: lead.property_id,
          owner_entity: lead.owner_entity,
          contact_name: fullName,
          contact_title: "",
          contact_phone: "",
          contact_email: "",
          contact_source: "batchdata",
          confidence: 0.4,
        });
        continue;
      }

      for (let i = 0; i < rowCount; i++) {
        const email = validEmails[i]?.email?.trim().toLowerCase() ?? "";
        const phone = validPhones[i]?.number?.trim() ?? (i === 0 ? validPhones[0]?.number?.trim() ?? "" : "");
        const phoneType = validPhones[i]?.type ?? validPhones[0]?.type ?? "";
        const phoneScore = validPhones[i]?.score ?? validPhones[0]?.score ?? 0;

        // Confidence: higher when email is tested-deliverable + mobile phone + high score
        const emailBonus = email && validEmails[i]?.tested ? 0.1 : 0;
        const phoneBonus = phoneType.toLowerCase() === "mobile" ? 0.05 : 0;
        const scoreBonus = phoneScore > 75 ? 0.05 : 0;
        const confidence = Math.min(0.95, 0.70 + emailBonus + phoneBonus + scoreBonus);

        candidates.push({
          property_id: lead.property_id,
          owner_entity: lead.owner_entity,
          contact_name: fullName,
          contact_title: "",
          contact_phone: phone,
          contact_email: email,
          contact_source: "batchdata",
          confidence,
        });
      }
    }

    return candidates;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Legal entity suffixes — when present, the owner is a business entity, not
 * an individual. Skip trace works best with real person names.
 */
const ENTITY_SUFFIXES = /\b(LLC|L\.L\.C|LLP|L\.L\.P|LP|L\.P|INC|CORP|CO|LTD|TRUST|TRUSTEE|ASSOCIATION|ASSOC|FOUNDATION|FUND|GROUP|HOLDINGS|PROPERTIES|REALTY|PARTNERS|PARTNERSHIP|MANAGEMENT|MGMT|ENTERPRISES|VENTURES)\b\.?/i;

/**
 * Attempt to split an owner entity into first/last name for skip trace.
 * Returns empty strings when the entity looks like a business (not a person).
 *
 * Examples:
 *   "Ziman Development LLC"  → { firstName: "", lastName: "" }  (entity)
 *   "SMITH JOHN"              → { firstName: "JOHN", lastName: "SMITH" }
 *   "Jane Doe"                → { firstName: "Jane", lastName: "Doe" }
 */
function parseOwnerName(ownerEntity: string): { firstName: string; lastName: string } {
  const empty = { firstName: "", lastName: "" };
  if (!ownerEntity?.trim()) return empty;

  // Strip legal entity suffixes — if what remains looks like an entity word,
  // this is a company, not a person
  const stripped = ownerEntity.trim().replace(ENTITY_SUFFIXES, "").trim();
  if (ENTITY_SUFFIXES.test(ownerEntity)) return empty;

  const words = stripped.split(/\s+/).filter(Boolean);

  // Must look like a 2-word name (first + last, or last + first)
  if (words.length < 2 || words.length > 4) return empty;

  // Assessor databases often list names as "LAST FIRST" in all-caps
  // We can't reliably detect order, so just pass both and let BatchData sort it
  const [first, ...rest] = words;
  return {
    firstName: first,
    lastName: rest.join(" "),
  };
}
