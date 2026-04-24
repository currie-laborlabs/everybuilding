/**
 * Client Voice Profile types for Tier 2 — EveryBuilding
 *
 * Each client has two files per their Google Drive folder:
 *   Client_Voice_Profile.docx  ← Mary edits (human-readable)
 *   Client_Voice_Profile.json  ← Pipeline reads (this schema)
 *
 * Built from two sources:
 *   1. Service Audit Call (1-hour Zoom, 36 structured questions)
 *   2. AI Web Scrape (website About/Services, Google reviews, YouTube, BBB)
 *
 * Mary fills the .docx from those sources.
 * Jemuel's convert script produces the .json.
 *
 * IMPORTANT: Reload JSON at the start of each daily run.
 * Do NOT cache permanently — clients may update their profile.
 */

// ─── Section identifiers ──────────────────────────────────────────────────────

/**
 * Named sections of the Voice Profile.
 * CTA entries in the Playbook declare which sections they need injected.
 * The prompt builder uses this to assemble a minimal, targeted prompt.
 */
export type VoiceProfileSection =
  | "company_basics"
  | "usps"
  | "signature_projects"
  | "brand_voice"
  | "customer_praise"
  | "market_positioning"
  | "targeting_preferences"
  | "assets_available"
  | "sender_identity"
  | "signature_line_data";

// ─── Section types ────────────────────────────────────────────────────────────

export interface CompanyBasics {
  company_name: string;
  primary_trade: string;               // e.g. "commercial roofing"
  years_in_business: number;
  service_area: string;                // e.g. "Raleigh-Durham metro, 60-mile radius"
  team_size: string;                   // e.g. "30 field employees"
  licenses_and_certs: string[];        // e.g. ["GAF Master Elite", "NC Gen Contractor #45123"]
}

export interface Usp {
  headline: string;                    // short phrase used in emails
  supporting_detail: string;           // longer context for the LLM to draw from
}

export interface SignatureProject {
  building_type: string;               // e.g. "distribution warehouse"
  square_feet: number | null;
  location: string;                    // city or area, NOT full address
  dollar_amount: string | null;        // e.g. "$420K" — null if client prefers not to share
  outcome_summary: string;             // e.g. "zero callbacks, completed 3 days early"
}

export interface BrandVoice {
  tone: string;                        // e.g. "direct, no-nonsense, blue-collar professional"
  phrases_to_use: string[];            // LLM encouraged to weave these in
  phrases_to_avoid: string[];          // LLM hard-blocked from using these
}

export interface CustomerPraiseTheme {
  theme: string;                       // e.g. "shows up on time, every time"
  frequency: "high" | "medium" | "low";
  example_quote: string | null;        // sourced from Google reviews (anonymized)
}

export interface MarketPositioning {
  desired_reputation: string;          // e.g. "the roofing company big landlords call first"
  price_positioning: "premium" | "mid-market" | "value" | null;
  /** Names the LLM must never mention in generated emails */
  competitors_to_avoid_mentioning: string[];
}

export interface TargetingPreferences {
  target_zip_codes: string[];
  excluded_zip_codes: string[];
  target_building_types: string[];     // e.g. ["industrial", "warehouse", "retail strip"]
  excluded_building_types: string[];
  min_project_size_sqft: number | null;
}

export interface AssetsAvailable {
  website_url: string | null;
  google_reviews_url: string | null;
  youtube_channel_url: string | null;
  case_study_urls: string[];
  has_drone_footage: boolean;
  has_video_testimonials: boolean;
}

/**
 * The real person whose name and email appear on every outgoing email.
 * NEVER a fabricated persona.
 * The email address is EveryBuilding-controlled — the client never has inbox access.
 * Replies are routed through the classification system before the client sees them.
 */
export interface SenderIdentity {
  sender_full_name: string;            // e.g. "Michael Torres"
  sender_title: string;               // e.g. "Project Estimator"
  sender_sign_off_name: string;       // e.g. "Mike" (used in sign-off line)
  sender_email: string;               // e.g. "mike@torresco-roofing.com" (EveryBuilding domain)
}

/**
 * Source data for the rotating Company Signature Line.
 * One sentence inserted between email body and sender name.
 * The pipeline rotates through blurb types, never repeating the same
 * angle in the last 5 emails to that building. See `last_5_signature_blurb_types`
 * on the lead row.
 */
export interface SignatureLineData {
  years_in_business: number;
  service_area: string;
  core_specialties: string[];
  certifications_and_awards: string[];
  /** Short proof phrases for use in signature line — e.g. "300K+ sqft reroofed since 2019" */
  signature_projects_summary: string[];
  /** Top themes from Google reviews — phrased as proof claims */
  top_review_themes: string[];
  /** Scale/volume statements — e.g. "50+ commercial roofs per year" */
  volume_scale_claims: string[];
}

// ─── Full profile ─────────────────────────────────────────────────────────────

export interface ClientVoiceProfile {
  /** Matches the client_id used in CampaignConfig and the Google Sheet */
  client_id: string;
  /** Semver for change tracking */
  version: string;
  updated_at: string;

  // ── Required sections (MVP) ──
  company_basics: CompanyBasics;
  primary_usp: Usp;
  brand_voice: BrandVoice;
  sender_identity: SenderIdentity;
  signature_line_data: SignatureLineData;

  // ── Required sections (needed for most CTAs) ──
  additional_usps: Usp[];
  signature_projects: SignatureProject[];
  customer_praise_themes: CustomerPraiseTheme[];
  market_positioning: MarketPositioning;

  // ── Optional sections (used by specific CTAs only) ──
  targeting_preferences: TargetingPreferences | null;
  assets_available: AssetsAvailable | null;
}

// ─── Partial profile for selective injection ──────────────────────────────────

/**
 * A subset of the voice profile — only the sections a specific CTA needs.
 * The prompt builder constructs this from the full profile using
 * the `voice_profile_sections` list on the CtaEntry.
 *
 * Keeps LLM context window lean. Never inject the full profile on every send.
 */
export type SelectiveVoiceProfile = Partial<
  Pick<
    ClientVoiceProfile,
    | "company_basics"
    | "primary_usp"
    | "additional_usps"
    | "signature_projects"
    | "brand_voice"
    | "customer_praise_themes"
    | "market_positioning"
    | "targeting_preferences"
    | "assets_available"
    | "sender_identity"
    | "signature_line_data"
  >
>;
