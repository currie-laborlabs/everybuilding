/**
 * Campaign configuration — EveryBuilding Tier 2
 *
 * One CampaignConfig per client. Lives in Google Drive at:
 *   Client — [Client Name] / Campaign_Config.json
 *
 * Contains the Instantly campaign ID, sending domain, cadence overrides,
 * and the report recipient email. Loaded once at pipeline startup.
 */

export interface CampaignConfig {
  /** Matches ClientVoiceProfile.client_id and the Google Sheet tab name */
  client_id: string;
  /** Human-readable label for logs and reports */
  client_name: string;

  // ── Instantly ─────────────────────────────────────────────────────────────
  /** Instantly campaign ID for this client — never shared across clients */
  instantly_campaign_id: string;
  /** Sending domain for this client's outreach emails */
  sending_domain: string;

  // ── Cadence (days between emails) ─────────────────────────────────────────
  /** Days to wait after no reply before next email. Default: 60 */
  cadence_days_default: number;
  /** Days to wait after a "not now" reply. Default: 90 */
  cadence_days_not_now: number;
  /** Days to wait after a "not interested" reply. Default: 180 */
  cadence_days_not_interested: number;

  // ── Reporting ─────────────────────────────────────────────────────────────
  /** Email address that receives daily/weekly/monthly reports for this client */
  reports_recipient_email: string;
  /**
   * Timezone string for report delivery timing.
   * Reports are sent at 7:00 AM client local time.
   * e.g. "America/New_York"
   */
  reports_timezone: string;

  // ── Google Sheets ─────────────────────────────────────────────────────────
  /** Google Sheets spreadsheet ID for this client's lead sheet */
  spreadsheet_id: string;
  /** Sheet tab name within the spreadsheet */
  sheet_tab_name: string;
}

// ─── Defaults ─────────────────────────────────────────────────────────────────

export const CAMPAIGN_CADENCE_DEFAULTS = {
  cadence_days_default: 60,
  cadence_days_not_now: 90,
  cadence_days_not_interested: 180,
} as const;
