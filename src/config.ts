import dotenv from "dotenv";
dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return val;
}

function optionalEnv(key: string): string | undefined {
  const val = process.env[key];
  if (!val) return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) return defaultValue;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function parseIntWithDefault(value: string | undefined, defaultValue: number): number {
  if (!value) return defaultValue;
  const parsed = parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

export const config = {
  browserbase: {
    apiKey: requireEnv("BROWSERBASE_API_KEY"),
    projectId: requireEnv("BROWSERBASE_PROJECT_ID"),
  },
  reonomy: {
    email: requireEnv("REONOMY_EMAIL"),
    password: requireEnv("REONOMY_PASSWORD"),
    baseUrl: "https://app.reonomy.com",
  },
  stagehand: {
    /** Model used by Stagehand for act/extract/observe */
    modelName: (process.env.STAGEHAND_MODEL ?? "claude-haiku-4-5") as "gpt-4o" | "gpt-4o-mini" | "claude-3-5-sonnet-latest" | "claude-haiku-4-5",
    /** API key for the LLM provider Stagehand uses */
    modelApiKey: requireEnv("STAGEHAND_MODEL_API_KEY"),
  },
  run: {
    /** ZIP code to search in Reonomy */
    zipCode: process.env.REONOMY_ZIP_CODE ?? "28202",
    /** Max results pages to scrape (start with 1 for MVP) */
    maxPages: parseIntWithDefault(process.env.MAX_PAGES, 1),
    /** Max properties to process after extraction; 0 means no cap */
    maxResults: parseIntWithDefault(process.env.MAX_RESULTS, 0),
    /** Milliseconds to wait for page transitions */
    pageLoadTimeout: parseIntWithDefault(process.env.PAGE_LOAD_TIMEOUT, 15000),
    /** Milliseconds to wait between actions (human-like delay) */
    actionDelay: parseIntWithDefault(process.env.ACTION_DELAY, 2000),
    /** Retry attempts for stage execution wrappers */
    stageMaxAttempts: parseIntWithDefault(process.env.STAGE_MAX_ATTEMPTS, 3),
    /** Base retry delay in milliseconds */
    stageRetryBaseDelayMs: parseIntWithDefault(process.env.STAGE_RETRY_BASE_DELAY_MS, 1000),
    /** Max retry delay in milliseconds */
    stageRetryMaxDelayMs: parseIntWithDefault(process.env.STAGE_RETRY_MAX_DELAY_MS, 8000),
    /** Enable checkpoint persistence for run-state snapshots */
    runStateEnabled: parseBoolean(process.env.RUN_STATE_ENABLED, true),
    /** Directory where run-state JSON snapshots are stored */
    runStateDir: process.env.RUN_STATE_DIR ?? "./tmp",
    /** Reprocessing mode for local resumability and dedupe */
    reprocessMode: (process.env.REPROCESS_MODE ?? "partial") as
      | "partial"
      | "full"
      | "failed_only",
    /** When true, skip ATTOM / Apollo / Hunter / ZeroBounce and save Reonomy data directly */
    reonomyOnly: parseBoolean(process.env.REONOMY_ONLY, false),
    /** "attom" = skip Reonomy/Stagehand, use ATTOM /property/snapshot for lead discovery */
    discoveryMode: (process.env.DISCOVERY_MODE ?? "reonomy") as "reonomy" | "attom",
    /**
     * When true, use the top-level Owners tab (bulk table) instead of clicking
     * each individual property card to get owner/contact data. Much faster for
     * large ZIP codes — one table pass gets ALL owners instead of N card clicks.
     */
    useOwnersTab: parseBoolean(process.env.REONOMY_USE_OWNERS_TAB, false),
    /** Concurrency for property-level enrichment tasks */
    enrichmentConcurrency: parseIntWithDefault(process.env.ENRICHMENT_CONCURRENCY, 4),
    /** Concurrency for ZeroBounce verification tasks */
    verificationConcurrency: parseIntWithDefault(process.env.VERIFICATION_CONCURRENCY, 5),
    /**
     * When true, skip properties whose land_use is in the residential skip list
     * before running ATTOM / Apollo / Hunter. Prevents wasting credits on
     * individual homeowners who have no presence in business contact databases.
     * Set COMMERCIAL_ONLY=false to process all land use types.
     */
    commercialOnly: parseBoolean(process.env.COMMERCIAL_ONLY, true),
    /**
     * Whitelist: keep a property ONLY if its land_use contains at least one of
     * these substrings (case-insensitive). Anything that matches none is dropped
     * before API enrichment. Override with COMMERCIAL_LAND_USE_TYPES=t1|t2 in .env
     */
    commercialLandUseTypes: (process.env.COMMERCIAL_LAND_USE_TYPES ??
      "office|retail|industrial|warehouse|commercial|restaurant|hotel|motel|medical|mixed use|general industrial|light industrial|research|flex|strip|shopping|mall|bank|auto|service|storage|data center|manufacturing|distribution"
    ).split("|").map((s) => s.trim().toLowerCase()).filter(Boolean),
    /**
     * Apollo people search title filter — only fetch contacts whose title
     * matches one of these. Targets decision-makers, not all staff.
     * Override with APOLLO_TARGET_TITLES=title1|title2|... in .env
     */
    apolloTargetTitles: (process.env.APOLLO_TARGET_TITLES ??
      "owner|partner|president|ceo|coo|vp|vice president|director|asset manager|property manager|facilities|building manager|operations manager|maintenance"
    ).split("|").map((s) => s.trim()).filter(Boolean),
    /** When true, bypass ATTOM HTTP enrichment and go straight to Apollo/Hunter */
    skipAttom: parseBoolean(process.env.SKIP_ATTOM, false),
    /** When true, skip Apollo entirely (subscription inactive) */
    skipApollo: parseBoolean(process.env.SKIP_APOLLO, false),
    /** When true, bypass Apollo/Hunter if Reonomy already has a contact name */
    skipApolloIfName: parseBoolean(process.env.SKIP_APOLLO_IF_NAME, false),
  },
  reliability: {
    circuitBreaker: {
      failureThreshold: parseIntWithDefault(process.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD, 5),
      resetTimeoutMs: parseIntWithDefault(process.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS, 300000),
    },
    providerRateLimits: {
      attomPerSecond: parseIntWithDefault(process.env.ATTOM_RATE_LIMIT_PER_SECOND, 1),
      apolloPerSecond: parseIntWithDefault(process.env.APOLLO_RATE_LIMIT_PER_SECOND, 3),
      hunterPerSecond: parseIntWithDefault(process.env.HUNTER_RATE_LIMIT_PER_SECOND, 2),
      pdlPerSecond: parseIntWithDefault(process.env.PDL_RATE_LIMIT_PER_SECOND, 2),
      zerobouncePerSecond: parseIntWithDefault(process.env.ZEROBOUNCE_RATE_LIMIT_PER_SECOND, 3),
      batchdataPerSecond: parseIntWithDefault(process.env.BATCHDATA_RATE_LIMIT_PER_SECOND, 2),
    },
  },
  providers: {
    attom: {
      apiKey: optionalEnv("ATTOM_API_KEY"),
      baseUrl: process.env.ATTOM_BASE_URL ?? "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
      /** ATTOM propertyType codes for geographic discovery. Verify exact codes via GET /enumerations/detail on activation. */
      targetPropertyTypes: (process.env.ATTOM_PROPERTY_TYPES ?? "commercial|office|industrial|retail|warehouse").split("|"),
    },
    apollo: {
      apiKey: optionalEnv("APOLLO_API_KEY"),
      baseUrl: process.env.APOLLO_BASE_URL ?? "https://api.apollo.io/api/v1",
      // When true, Apollo /people/match also returns personal emails (Gmail etc.).
      // Useful for individual landlords who don't have a work email.
      revealPersonalEmails: parseBoolean(process.env.APOLLO_REVEAL_PERSONAL_EMAILS, false),
    },
    hunter: {
      apiKey: optionalEnv("HUNTER_API_KEY"),
      baseUrl: process.env.HUNTER_BASE_URL ?? "https://api.hunter.io/v2",
    },
    pdl: {
      apiKey: optionalEnv("PDL_API_KEY"),
      baseUrl: process.env.PDL_BASE_URL ?? "https://api.peopledatalabs.com/v5",
      /** Max records to return per Person Search call (1 credit per record). */
      maxResultsPerSearch: parseIntWithDefault(process.env.PDL_MAX_RESULTS_PER_SEARCH, 5),
    },
    zerobounce: {
      apiKey: optionalEnv("ZEROBOUNCE_API_KEY"),
      baseUrl: process.env.ZEROBOUNCE_BASE_URL ?? "https://api.zerobounce.net/v2",
    },
    batchdata: {
      apiKey: optionalEnv("BATCHDATA_API_KEY"),
      baseUrl: process.env.BATCHDATA_BASE_URL ?? "https://api.batchdata.com",
      /** Set BATCHDATA_PROPERTY_ENRICH=true to run BatchData property lookup after ATTOM enrichment. */
      propertyEnrich: parseBoolean(process.env.BATCHDATA_PROPERTY_ENRICH, false),
    },
  },
  localStore: {
    sqlitePath: process.env.SQLITE_PATH ?? "./tmp/tier1-runtime.db",
    checkpointFile: process.env.CHECKPOINT_FILE ?? "./tmp/tier1-checkpoint.json",
  },
  output: {
    googleSheets: {
      credentialsPath: requireEnv("GOOGLE_SHEETS_CREDENTIALS_PATH"),
      spreadsheetId: requireEnv("GOOGLE_SHEETS_SPREADSHEET_ID"),
      tabName: requireEnv("GOOGLE_SHEETS_TAB_NAME"),
      writeHeaderRow: parseBoolean(process.env.GOOGLE_SHEETS_HEADER_ROW, true),
    },
  },
  /**
   * Owner Resolution Layer — feature-flagged, disabled by default.
   * Set OWNER_RESOLUTION_ENABLED=true to activate.
   * See src/enrichment/owner-resolution/index.ts for removal instructions.
   */
  ownerResolution: {
    enabled: parseBoolean(process.env.OWNER_RESOLUTION_ENABLED, false),
    minResolvedScore: parseIntWithDefault(
      process.env.OWNER_RESOLUTION_MIN_RESOLVED_SCORE,
      75
    ),
    minReviewScore: parseIntWithDefault(
      process.env.OWNER_RESOLUTION_MIN_REVIEW_SCORE,
      50
    ),
    adapters: {
      cobalt: parseBoolean(process.env.OWNER_RESOLUTION_ADAPTER_COBALT, true),
      hunter: parseBoolean(process.env.OWNER_RESOLUTION_ADAPTER_HUNTER, true),
      apollo: parseBoolean(process.env.OWNER_RESOLUTION_ADAPTER_APOLLO, true),
      serper: parseBoolean(process.env.OWNER_RESOLUTION_ADAPTER_SERPER, true),
      opencorporates: parseBoolean(
        process.env.OWNER_RESOLUTION_ADAPTER_OPENCORPORATES,
        true
      ),
    },
    failOpen: parseBoolean(process.env.OWNER_RESOLUTION_FAIL_OPEN, true),
    writeDebugOutput: parseBoolean(process.env.OWNER_RESOLUTION_DEBUG, false),
    /** New API key — only required when serper adapter is enabled */
    serperApiKey: optionalEnv("SERPER_API_KEY"),
    /** Optional — public OpenCorporates endpoint works without a key */
    opencorporatesApiKey: optionalEnv("OPENCORPORATES_API_KEY"),
    cobaltApiKey: optionalEnv("COBALT_API_KEY"),
    cobaltBaseUrl: optionalEnv("COBALT_BASE_URL"),
  },
} as const;
