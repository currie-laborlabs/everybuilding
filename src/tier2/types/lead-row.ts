/**
 * Tier 2 lead row types — EveryBuilding
 *
 * Tier2ContactRow extends Tier1ContactRow with the outreach-tracking
 * columns Tier 2 needs to manage CTA rotation, cadence, and reply state.
 *
 * One row per contact. Building-level grouping is preserved via property_id.
 *
 * These columns are appended to the right of the existing Tier 1 columns
 * in the Google Sheet — no existing columns are renamed or removed.
 */

import type { Tier1ContactRow } from "../../types";
import type { CtaNumber, CtaName } from "./cta";

// ─── Reply / suppression state ────────────────────────────────────────────────

export type ReplyStatus =
  | "pending"           // no reply yet, eligible for next send
  | "interested"        // STOP — forward to client, remove from rotation
  | "not_now"           // re-queue after cadence_days_not_now
  | "not_interested"    // re-queue after cadence_days_not_interested
  | "out_of_office"     // re-queue after OOO date if parseable, else default
  | "unsubscribed";     // PERMANENT STOP — add to global suppression list

export type SkipReason =
  | "building_replied_interested"   // another contact at this building replied positively
  | "client_instruction"            // client told EveryBuilding to skip via OpenClaw
  | "unsubscribed"                  // contact unsubscribed
  | "not_interested_cooldown"       // inside the 180-day not_interested window
  | "not_now_cooldown"              // inside the 90-day not_now window
  | null;                           // not skipped

// ─── Signature line blurb rotation ───────────────────────────────────────────

/**
 * The Company Signature Line rotates through these categories.
 * The pipeline reads `last_5_signature_blurb_types` per contact to ensure
 * no angle is repeated within the last 5 emails to that building.
 */
export type SignatureBlurbType =
  | "years_in_business"
  | "service_area"
  | "specialties"
  | "certifications"
  | "signature_project"
  | "review_themes"
  | "volume_scale";

// ─── Tier 2 outreach tracking fields ─────────────────────────────────────────

/**
 * These fields are added to the Google Sheet after Tier 1 completes.
 * The Tier 2 pipeline reads and writes them on every send cycle.
 *
 * Required now (MVP):
 *   last_cta_number, last_cta_type, last_email_date, last_email_subject,
 *   next_cta_number, next_email_date, total_emails_sent,
 *   reply_status, skip_reason
 *
 * Required now (signature rotation):
 *   last_signature_blurb_type, last_5_signature_blurb_types
 */
export interface Tier2OutreachFields {
  // ── CTA tracking ──────────────────────────────────────────────────────────
  /** CTA number used in the most recent email. null before first send. */
  last_cta_number: CtaNumber | null;
  /** CTA name (human-readable) for logging / reports */
  last_cta_type: CtaName | null;
  /** ISO date of last sent email. null before first send. */
  last_email_date: string | null;
  /** Subject line of the last sent email */
  last_email_subject: string | null;
  /**
   * CTA number to use on the NEXT send.
   * Defaults to 1 (set at row creation by Tier 1 → Tier 2 handoff).
   * Advances after each send. Resets to 1 after #10.
   */
  next_cta_number: CtaNumber;
  /**
   * ISO date on or after which this contact is eligible for the next send.
   * null = eligible immediately (new contact, or first in sequence).
   */
  next_email_date: string | null;
  /** Running count of emails sent to this specific contact */
  total_emails_sent: number;

  // ── Reply / suppression tracking ─────────────────────────────────────────
  reply_status: ReplyStatus;
  /** Non-null means the pipeline will never send to this contact again (until cleared) */
  skip_reason: SkipReason;

  // ── Signature line rotation ───────────────────────────────────────────────
  /** Blurb type used in the last email — never repeat immediately */
  last_signature_blurb_type: SignatureBlurbType | null;
  /**
   * Last 5 blurb types used for this contact (most recent first).
   * Serialized as comma-separated string in Google Sheets.
   * Pipeline parses it before use.
   */
  last_5_signature_blurb_types: SignatureBlurbType[];
}

// ─── Full Tier 2 row ──────────────────────────────────────────────────────────

/**
 * The complete lead row as read/written by the Tier 2 pipeline.
 * Tier 1 fields are unchanged; Tier 2 fields are appended.
 *
 * When writing to Google Sheets, Tier 1 columns come first (preserving
 * existing column order), followed by the Tier 2 columns.
 */
export type Tier2ContactRow = Tier1ContactRow & Tier2OutreachFields;

// ─── Default values for new rows ─────────────────────────────────────────────

/**
 * Default Tier 2 field values applied when a Tier 1 row is promoted
 * into the Tier 2 tracking system (i.e., row is seen for the first time
 * by the outreach pipeline).
 */
export const TIER2_DEFAULTS: Tier2OutreachFields = {
  last_cta_number: null,
  last_cta_type: null,
  last_email_date: null,
  last_email_subject: null,
  next_cta_number: 1,
  next_email_date: null,
  total_emails_sent: 0,
  reply_status: "pending",
  skip_reason: null,
  last_signature_blurb_type: null,
  last_5_signature_blurb_types: [],
};

// ─── Sheet column order (Tier 2 columns only) ─────────────────────────────────

/**
 * The Tier 2 columns appended to the right of the Tier 1 columns.
 * Used by the sheet writer to maintain consistent column order.
 */
export const TIER2_SHEET_COLUMNS: (keyof Tier2OutreachFields)[] = [
  "last_cta_number",
  "last_cta_type",
  "last_email_date",
  "last_email_subject",
  "next_cta_number",
  "next_email_date",
  "total_emails_sent",
  "reply_status",
  "skip_reason",
  "last_signature_blurb_type",
  "last_5_signature_blurb_types",
];
