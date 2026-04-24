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
    modelName: (process.env.STAGEHAND_MODEL ?? "gpt-4o") as "gpt-4o" | "gpt-4o-mini" | "claude-3-5-sonnet-latest",
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
    /** Concurrency for property-level enrichment tasks */
    enrichmentConcurrency: parseIntWithDefault(process.env.ENRICHMENT_CONCURRENCY, 4),
    /** Concurrency for ZeroBounce verification tasks */
    verificationConcurrency: parseIntWithDefault(process.env.VERIFICATION_CONCURRENCY, 5),
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
      zerobouncePerSecond: parseIntWithDefault(process.env.ZEROBOUNCE_RATE_LIMIT_PER_SECOND, 3),
    },
  },
  providers: {
    attom: {
      apiKey: optionalEnv("ATTOM_API_KEY"),
      baseUrl: process.env.ATTOM_BASE_URL ?? "https://api.gateway.attomdata.com/propertyapi/v1.0.0",
    },
    apollo: {
      apiKey: optionalEnv("APOLLO_API_KEY"),
      baseUrl: process.env.APOLLO_BASE_URL ?? "https://api.apollo.io/api/v1",
    },
    hunter: {
      apiKey: optionalEnv("HUNTER_API_KEY"),
      baseUrl: process.env.HUNTER_BASE_URL ?? "https://api.hunter.io/v2",
    },
    zerobounce: {
      apiKey: optionalEnv("ZEROBOUNCE_API_KEY"),
      baseUrl: process.env.ZEROBOUNCE_BASE_URL ?? "https://api.zerobounce.net/v2",
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
} as const;
