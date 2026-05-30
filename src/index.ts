import { randomUUID } from "crypto";
import { Stagehand } from "@browserbasehq/stagehand";
import PQueue from "p-queue";
import { config } from "./config";
import { loginToReonomy } from "./reonomy/login";
import { searchByZipCode } from "./reonomy/search";
import { extractAllPages, extractResultsPage, goToNextPage } from "./reonomy/extractResults";
import { enrichLeadsWithReonomyDetails, enrichLeadWithReonomyDetail } from "./reonomy/extractDetail";
import { extractAllOwners, mergeOwnerRecordsIntoLeads } from "./reonomy/extractOwners";
import { normalizeAll } from "./reonomy/normalize";
import { saveToGoogleSheet } from "./output/saveCsv";
import { AttomClient } from "./enrichment/attom";
import { BatchDataPropertyClient } from "./enrichment/batchdata-property";
import { ApolloClient } from "./enrichment/contacts/apollo";
import { HunterClient } from "./enrichment/contacts/hunter";
import { PdlClient } from "./enrichment/contacts/pdl";
import { BatchDataSkipTraceClient } from "./enrichment/contacts/batchdata";
import { enrichContactsForLead } from "./enrichment/contacts/flow";
import { sequenceForIndex } from "./enrichment/contacts/merge";
import { ZeroBounceClient } from "./enrichment/verification/zerobounce";
import { createRunLogger } from "./infra/observability";
import {
  createInitialRunState,
  markStageStatus,
  RunStateStore,
} from "./infra/runstate";
import { writeRunReport } from "./infra/report";
import { executeStage } from "./pipeline/stages";
import { CheckpointStore } from "./pipeline/checkpoint";
import { SqliteIdempotencyStore } from "./pipeline/idempotency";
// ── Owner Resolution (optional, disabled by default) ──────────────────────────
import {
  OwnerResolver,
  resolveOwnerSafe,
} from "./enrichment/owner-resolution/index";
import type { OwnerResolutionResult } from "./enrichment/owner-resolution/index";
// ──────────────────────────────────────────────────────────────────────────────
import type {
  ContactCandidate,
  EnrichedPropertyLead,
  NormalizedLead,
  ReonomyContact,
  ReprocessMode,
  RunStateSnapshot,
  StageName,
  Tier1ContactRow,
} from "./types";

const STAGE_NUMBERS: Record<StageName, number> = {
  login: 1,
  search: 2,
  extract: 3,
  normalize: 4,
  reonomy_detail: 5,
  attom_discover: 1, // replaces Reonomy stages 1-5 when discoveryMode="attom"
  attom_enrich: 6,
  contact_enrich: 7,
  email_verify: 8,
  save: 9,
};

function logStepHeader(stepNumber: number, label: string): void {
  console.log("\n----------------------------------------------");
  console.log(`[main] STEP ${stepNumber}: ${label}`);
  console.log("----------------------------------------------");
}

function getBrowserbaseSessionInfo(stagehand: Stagehand): {
  sessionId: string;
  liveSessionUrl: string;
} {
  const stagehandWithSession = stagehand as unknown as {
    browserbaseSessionID?: string;
    browserbaseSessionId?: string;
    sessionId?: string;
    session?: {
      id?: string;
      sessionId?: string;
      liveUrl?: string;
    };
  };

  const sessionId =
    stagehandWithSession.browserbaseSessionID ??
    stagehandWithSession.browserbaseSessionId ??
    stagehandWithSession.sessionId ??
    stagehandWithSession.session?.id ??
    stagehandWithSession.session?.sessionId ??
    "unknown";

  const liveSessionUrl =
    stagehandWithSession.session?.liveUrl ??
    (sessionId === "unknown"
      ? "unavailable"
      : `https://www.browserbase.com/sessions/${sessionId}`);

  return { sessionId, liveSessionUrl };
}

function sourceCountKey(row: Tier1ContactRow): string {
  const sources = row.contact_sources?.trim();
  if (sources) return sources;
  const source = row.contact_source?.trim();
  return source || "<blank>";
}

function applyContactMetrics(runState: RunStateSnapshot, rows: Tier1ContactRow[]): void {
  const contactSourceCounts: Record<string, number> = {};
  let rowsWithEmail = 0;
  let validEmails = 0;
  let invalidEmails = 0;
  let unknownEmails = 0;
  let unverifiedEmails = 0;

  for (const row of rows) {
    const key = sourceCountKey(row);
    contactSourceCounts[key] = (contactSourceCounts[key] ?? 0) + 1;

    if (!row.contact_email.trim()) continue;
    rowsWithEmail += 1;
    const status = row.verification_status.trim().toLowerCase();
    if (status === "valid") {
      validEmails += 1;
    } else if (status === "invalid") {
      invalidEmails += 1;
    } else if (status === "unknown" || status === "risky") {
      unknownEmails += 1;
    } else {
      unverifiedEmails += 1;
    }
  }

  runState.metrics.rowsWithEmail = rowsWithEmail;
  runState.metrics.validEmails = validEmails;
  runState.metrics.invalidEmails = invalidEmails;
  runState.metrics.unknownEmails = unknownEmails;
  runState.metrics.unverifiedEmails = unverifiedEmails;
  runState.metrics.contactSourceCounts = contactSourceCounts;
}

async function main(): Promise<void> {
  const startTime = Date.now();
  const { zipCode, maxPages, maxResults, reonomyOnly, discoveryMode } = config.run;
  const runId = randomUUID();
  const logger = createRunLogger("main", runId);
  const runStateStore = new RunStateStore(runId, config.run.runStateDir);
  const checkpointStore = new CheckpointStore(config.localStore.checkpointFile);
  const idempotencyStore = new SqliteIdempotencyStore(config.localStore.sqlitePath);
  let runState: RunStateSnapshot = createInitialRunState(runId);
  let reportPaths: { jsonPath: string; textPath: string } | null = null;

  function saveRunState(): void {
    if (!config.run.runStateEnabled) return;
    runStateStore.save(runState);
  }

  async function runStage<T>(
    stage: StageName,
    label: string,
    operation: () => Promise<T>
  ): Promise<T> {
    logStepHeader(
      STAGE_NUMBERS[stage],
      label
    );

    const stageStartedAt = Date.now();
    runState = markStageStatus(runState, stage, "running");
    saveRunState();

    try {
      const result = await executeStage(
        stage,
        logger,
        {
          retries: config.run.stageMaxAttempts,
          baseDelayMs: config.run.stageRetryBaseDelayMs,
          maxDelayMs: config.run.stageRetryMaxDelayMs,
        },
        operation
      );

      runState = markStageStatus(runState, stage, "completed", {
        elapsedMs: Date.now() - stageStartedAt,
      });
      saveRunState();
      return result;
    } catch (error) {
      runState = markStageStatus(runState, stage, "failed", {
        elapsedMs: Date.now() - stageStartedAt,
        message: error instanceof Error ? error.message : "Unknown stage failure",
      });
      runState.errors.push(
        `[${stage}] ${error instanceof Error ? error.message : "Unknown error"}`
      );
      saveRunState();
      throw error;
    }
  }

  saveRunState();

  await idempotencyStore.initialize();

  // ── Owner Resolver (optional) ────────────────────────────────────────────
  // Created once here; passed as an optional parameter to buildContactRows().
  // When OWNER_RESOLUTION_ENABLED=false (default), ownerResolver is undefined
  // and the resolution path is never entered — zero performance impact.
  const ownerResolver = config.ownerResolution.enabled
    ? new OwnerResolver(
        config.ownerResolution,
        config.providers.hunter.apiKey,
        config.providers.apollo.apiKey,
        config.ownerResolution.serperApiKey,
        config.ownerResolution.opencorporatesApiKey,
        config.ownerResolution.cobaltApiKey,
        config.ownerResolution.cobaltBaseUrl
      )
    : undefined;

  if (ownerResolver) {
    console.log("[main] Owner Resolution Layer: ENABLED");
    console.log(
      `[main]   Adapters: cobalt=${config.ownerResolution.adapters.cobalt} hunter=${config.ownerResolution.adapters.hunter} apollo=${config.ownerResolution.adapters.apollo} serper=${config.ownerResolution.adapters.serper} opencorporates=${config.ownerResolution.adapters.opencorporates}`
    );
    console.log(
      `[main]   Thresholds: resolved>=${config.ownerResolution.minResolvedScore} review>=${config.ownerResolution.minReviewScore}`
    );
  }
  // ────────────────────────────────────────────────────────────────────────

  console.log("==============================================");
  console.log("  EVERYBUILDING — Reonomy Scraper (Tier 1 MVP)");
  console.log("==============================================");
  console.log(`Run ID     : ${runId}`);
  console.log(`ZIP Code   : ${zipCode}`);
  console.log(`Max Pages  : ${maxPages}`);
  console.log(`Max Results: ${maxResults > 0 ? maxResults : "unlimited"}`);
  console.log(`Mode       : ${discoveryMode === "attom" ? "ATTOM Discovery (Reonomy skipped)" : reonomyOnly ? "REONOMY-ONLY (enrichment skipped)" : "Full pipeline"}`);
  console.log(
    `Output     : Google Sheets (${config.output.googleSheets.spreadsheetId}/${config.output.googleSheets.tabName})`
  );
  console.log("----------------------------------------------");

  // ── ATTOM DISCOVERY MODE ─────────────────────────────────────────────────
  // When DISCOVERY_MODE=attom, skip Stagehand/Browserbase entirely.
  // ATTOM's /property/snapshot endpoint discovers commercial properties by ZIP.
  if (discoveryMode === "attom") {
    const attomClientDiscover = new AttomClient({
      apiKey: config.providers.attom.apiKey,
      baseUrl: config.providers.attom.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.attomPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });
    const batchdataPropertyClientDiscover = new BatchDataPropertyClient({
      apiKey: config.providers.batchdata.apiKey,
      baseUrl: config.providers.batchdata.baseUrl,
      enabled: config.providers.batchdata.propertyEnrich,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });

    try {
      const discoveredLeads = await runStage(
        "attom_discover",
        "ATTOM DISCOVER",
        async () =>
          attomClientDiscover.searchByPostalCode(
            zipCode,
            config.providers.attom.targetPropertyTypes
          )
      );

      const cappedLeads =
        maxResults > 0 ? discoveredLeads.slice(0, maxResults) : discoveredLeads;
      if (maxResults > 0 && discoveredLeads.length > maxResults) {
        console.log(
          `[main] Limiting to first ${maxResults} properties (from ${discoveredLeads.length} discovered).`
        );
      }

      runState.metrics.extractedRecords = cappedLeads.length;
      runState.metrics.normalizedRecords = cappedLeads.length;
      runState.metrics.partialRecords = cappedLeads.filter(
        (l) => l.extraction_status === "partial"
      ).length;
      saveRunState();
      console.log(`[main] STEP 1 complete: ${cappedLeads.length} properties discovered.`);

      if (cappedLeads.length === 0) {
        console.error(
          "[main] No properties discovered by ATTOM. Check ATTOM_API_KEY, ATTOM_PROPERTY_TYPES, and your plan tier."
        );
        process.exitCode = 1;
        return;
      }

      const enrichedLeads = await runStage(
        "attom_enrich",
        "ATTOM ENRICH",
        async () =>
          enrichPropertiesWithAttom(
            cappedLeads,
            attomClientDiscover,
            batchdataPropertyClientDiscover,
            config.run.enrichmentConcurrency,
            runId,
            checkpointStore,
            idempotencyStore,
            config.run.reprocessMode
          )
      );
      runState.metrics.attomEnrichedRecords = enrichedLeads.length;
      saveRunState();
      console.log("[main] STEP 6 complete.");

      const apolloClientDiscover = new ApolloClient({
        apiKey: config.providers.apollo.apiKey,
        baseUrl: config.providers.apollo.baseUrl,
        maxAttempts: config.run.stageMaxAttempts,
        baseDelayMs: config.run.stageRetryBaseDelayMs,
        maxDelayMs: config.run.stageRetryMaxDelayMs,
        ratePerSecond: config.reliability.providerRateLimits.apolloPerSecond,
        circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
        circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
      });
      const hunterClientDiscover = new HunterClient({
        apiKey: config.providers.hunter.apiKey,
        baseUrl: config.providers.hunter.baseUrl,
        maxAttempts: config.run.stageMaxAttempts,
        baseDelayMs: config.run.stageRetryBaseDelayMs,
        maxDelayMs: config.run.stageRetryMaxDelayMs,
        ratePerSecond: config.reliability.providerRateLimits.hunterPerSecond,
        circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
        circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
      });
      const pdlClientDiscover = new PdlClient({
        apiKey: config.providers.pdl.apiKey,
        baseUrl: config.providers.pdl.baseUrl,
        maxAttempts: config.run.stageMaxAttempts,
        baseDelayMs: config.run.stageRetryBaseDelayMs,
        maxDelayMs: config.run.stageRetryMaxDelayMs,
        ratePerSecond: config.reliability.providerRateLimits.pdlPerSecond,
        circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
        circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
        maxResultsPerSearch: config.providers.pdl.maxResultsPerSearch,
      });
      const batchdataSkipTraceClientDiscover = new BatchDataSkipTraceClient({
        apiKey: config.providers.batchdata.apiKey,
        baseUrl: config.providers.batchdata.baseUrl,
        maxAttempts: config.run.stageMaxAttempts,
        baseDelayMs: config.run.stageRetryBaseDelayMs,
        maxDelayMs: config.run.stageRetryMaxDelayMs,
        ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
        circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
        circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
      });

      const contactRowsDiscover = await runStage(
        "contact_enrich",
        "CONTACT ENRICH",
        async () =>
          buildContactRows(
            enrichedLeads,
            apolloClientDiscover,
            hunterClientDiscover,
            pdlClientDiscover,
            batchdataSkipTraceClientDiscover,
            config.run.enrichmentConcurrency,
            runId,
            checkpointStore,
            ownerResolver
          )
      );
      runState.metrics.contactCandidates = contactRowsDiscover.length;
      saveRunState();
      console.log("[main] STEP 7 complete.");

      const zeroBounceClientDiscover = new ZeroBounceClient({
        apiKey: config.providers.zerobounce.apiKey,
        baseUrl: config.providers.zerobounce.baseUrl,
        maxAttempts: config.run.stageMaxAttempts,
        baseDelayMs: config.run.stageRetryBaseDelayMs,
        maxDelayMs: config.run.stageRetryMaxDelayMs,
        ratePerSecond: config.reliability.providerRateLimits.zerobouncePerSecond,
        circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
        circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
      });

      const verifiedRowsDiscover = await runStage(
        "email_verify",
        "ZEROBOUNCE VERIFY",
        async () =>
          verifyContactRows(
            contactRowsDiscover,
            zeroBounceClientDiscover,
            config.run.verificationConcurrency,
            runId,
            checkpointStore
          )
      );
      runState.metrics.verifiedContacts = verifiedRowsDiscover.length;
      applyContactMetrics(runState, verifiedRowsDiscover);
      saveRunState();
      console.log("[main] STEP 8 complete.");

      const dedupedRowsDiscover: Tier1ContactRow[] = [];
      let skippedLocalDiscover = 0;
      for (const row of verifiedRowsDiscover) {
        const email = row.contact_email.trim().toLowerCase();
        if (email && (await idempotencyStore.hasSeenContactEmail(email))) {
          skippedLocalDiscover += 1;
          continue;
        }
        dedupedRowsDiscover.push(row);
      }
      runState.metrics.skippedExistingContacts = skippedLocalDiscover;
      saveRunState();

      const outputResultDiscover = await runStage(
        "save",
        "SAVE CONTACT ROWS",
        async () => saveToGoogleSheet(dedupedRowsDiscover, config.output.googleSheets)
      );
      for (const email of outputResultDiscover.appendedEmails) {
        const row = dedupedRowsDiscover.find(
          (r) => r.contact_email.trim().toLowerCase() === email
        );
        await idempotencyStore.markContactEmailSeen(
          email,
          row?.property_id ?? "unknown",
          runId
        );
      }
      runState.metrics.appendedRows = outputResultDiscover.appendedCount;
      runState.metrics.skippedExistingContacts +=
        outputResultDiscover.skippedExistingCount;
      runState.status = "completed";
      saveRunState();
      checkpointStore.clear();
      console.log("[main] STEP 9 complete.");

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log("\n==============================================");
      console.log("  RUN COMPLETE (ATTOM Discovery)");
      console.log("==============================================");
      console.log(`Properties discovered : ${cappedLeads.length}`);
      console.log(`ATTOM enriched        : ${enrichedLeads.length}`);
      console.log(`Contact rows built    : ${contactRowsDiscover.length}`);
      console.log(`Verified contacts     : ${verifiedRowsDiscover.length}`);
      console.log(`Partial records       : ${runState.metrics.partialRecords}`);
      console.log(`Rows appended         : ${outputResultDiscover.appendedCount}`);
      console.log(`Rows skipped (dedup)  : ${runState.metrics.skippedExistingContacts}`);
      console.log(`Spreadsheet ID        : ${outputResultDiscover.spreadsheetId}`);
      console.log(`Sheet tab             : ${outputResultDiscover.tabName}`);
      if (config.run.runStateEnabled) {
        console.log(`Run-state file        : ${runStateStore.getPath()}`);
      }
      reportPaths = writeRunReport({
        outputDir: config.run.runStateDir,
        runId,
        status: "completed",
        zipCode,
        maxPages,
        maxResults,
        elapsedSeconds: Number(elapsed),
        runState,
        spreadsheetId: outputResultDiscover.spreadsheetId,
        tabName: outputResultDiscover.tabName,
        checkpointFile: checkpointStore.getPath(),
        sqlitePath: config.localStore.sqlitePath,
        runStatePath: config.run.runStateEnabled ? runStateStore.getPath() : undefined,
      });
      console.log(`Run report (txt)      : ${reportPaths.textPath}`);
      console.log(`Run report (json)     : ${reportPaths.jsonPath}`);
      console.log(`Elapsed time          : ${elapsed}s`);
      console.log("==============================================");
    } catch (error) {
      runState.status = "failed";
      saveRunState();
      reportPaths = writeRunReport({
        outputDir: config.run.runStateDir,
        runId,
        status: "failed",
        zipCode,
        maxPages,
        maxResults,
        elapsedSeconds: (Date.now() - startTime) / 1000,
        runState,
        checkpointFile: checkpointStore.getPath(),
        sqlitePath: config.localStore.sqlitePath,
        runStatePath: config.run.runStateEnabled ? runStateStore.getPath() : undefined,
        errorMessage: error instanceof Error ? error.message : "Unknown error",
      });
      console.error("\n[main] FATAL ERROR during ATTOM discovery run:");
      console.error(error);
      console.error(`[main] Run report (txt): ${reportPaths.textPath}`);
      console.error(`[main] Run report (json): ${reportPaths.jsonPath}`);
      process.exitCode = 1;
    } finally {
      await idempotencyStore.close();
    }
    return;
  }
  // ─────────────────────────────────────────────────────────────────────────

  // --- Initialize Stagehand with Browserbase ---
  console.log("[main] Initializing Stagehand + Browserbase session...");
  const stagehand = new Stagehand({
    env: "BROWSERBASE",
    apiKey: config.browserbase.apiKey,
    projectId: config.browserbase.projectId,
    modelName: config.stagehand.modelName,
    modelClientOptions: {
      apiKey: config.stagehand.modelApiKey,
    },
    useAPI: false,
    enableCaching: true,
    verbose: 1,
    browserbaseSessionCreateParams: {
      // Allow up to 3 hours per session (in seconds). Browserbase free/starter
      // plans cap at 1 hour; paid plans support longer. Adjust as needed.
      timeout: 10800,
    },
  });

  await stagehand.init();
  console.log("[main] Browserbase session started.");

  const { sessionId, liveSessionUrl } = getBrowserbaseSessionInfo(stagehand);
  console.log(`[main] Browserbase session ID  : ${sessionId}`);
  console.log(`[main] Browserbase live URL    : ${liveSessionUrl}`);

  try {
    await runStage("login", "LOGIN", async () => {
      await loginToReonomy(stagehand);
    });
    console.log("[main] STEP 1 complete.");

    await runStage("search", "SEARCH", async () => {
      await searchByZipCode(stagehand, zipCode);
    });
    console.log("[main] STEP 2 complete.");

    // ── STEPS 3-5: Interleaved per-page extract + detail ─────────────────────
    // For each results page:
    //   a. Read the card list (addresses + owner names)
    //   b. For every card on that page: click it → Owner sub-tab → extract ALL
    //      contacts + phones/emails (including "View All Contacts") → go back
    //   c. Advance to the next page and repeat
    // This guarantees we always click cards on the page they appear on.
    const leadsWithReonomyDetail = await runStage(
      "extract",
      "EXTRACT + OWNER DETAIL (per page, interleaved)",
      async () => {
        // ── Owners-tab fast path (optional) ────────────────────────────────
        if (config.run.useOwnersTab) {
          console.log("[main] Using Owners tab bulk strategy (REONOMY_USE_OWNERS_TAB=true).");
          const rawRecords = await extractAllPages(stagehand, maxPages);
          const leads = normalizeAll(rawRecords, zipCode);
          const ownerRecords = await extractAllOwners(stagehand, maxPages);
          return mergeOwnerRecordsIntoLeads(leads, ownerRecords);
        }

        // ── Interleaved per-card approach (default) ─────────────────────────
        const allEnrichedLeads: NormalizedLead[] = [];
        let totalCards = 0;
        let totalWithContacts = 0;

        for (let pageNum = 1; pageNum <= maxPages; pageNum++) {
          logStepHeader(3, `PAGE ${pageNum} of ${maxPages} — EXTRACT CARDS`);
          // Capture URL BEFORE clicking any card so returnToResults knows the
          // current page (page 2's URL differs from page 1's).
          const pageUrl = stagehand.page.url();

          // 1. Extract the card list for this page (no clicking yet)
          const rawRecords = await extractResultsPage(stagehand);
          console.log(`[main] Page ${pageNum}: ${rawRecords.length} raw cards found.`);

          if (rawRecords.length === 0) {
            console.warn(`[main] Page ${pageNum}: zero cards — skipping.`);
          } else {
            // 2. Normalize
            const pageLeads = normalizeAll(rawRecords, zipCode);

            // 3. Apply commercial-only filter
            const filteredPageLeads = config.run.commercialOnly
              ? pageLeads.filter((l) => {
                  const lu = (l.land_use ?? "").toLowerCase();
                  if (!lu) return true; // Unknown land use: keep it
                  return config.run.commercialLandUseTypes.some((p) => lu.includes(p));
                })
              : pageLeads;

            if (config.run.commercialOnly && filteredPageLeads.length < pageLeads.length) {
              console.log(
                `[main] Page ${pageNum}: ${filteredPageLeads.length} commercial kept, ` +
                `${pageLeads.length - filteredPageLeads.length} non-commercial dropped.`
              );
            }

            // 4. Click each card, extract contacts, return to list
            logStepHeader(5, `PAGE ${pageNum} — OWNER DETAIL (${filteredPageLeads.length} cards)`);
            for (let i = 0; i < filteredPageLeads.length; i++) {
              // Respect MAX_RESULTS cap
              if (maxResults > 0 && allEnrichedLeads.length >= maxResults) {
                console.log(`[main] Reached MAX_RESULTS=${maxResults}. Stopping.`);
                break;
              }

              const lead = filteredPageLeads[i];
              console.log(
                `[main] Page ${pageNum}, card ${i + 1}/${filteredPageLeads.length}: ` +
                `"${lead.property_address}"`
              );

              const enrichedLead = await enrichLeadWithReonomyDetail(stagehand, lead, pageUrl);
              allEnrichedLeads.push(enrichedLead);
              totalCards += 1;
              if (enrichedLead.reonomy_detail_status === "success") totalWithContacts += 1;

              // Save progress after each card
              runState.metrics.extractedRecords = allEnrichedLeads.length;
              saveRunState();
            }
          }

          // 5. Respect MAX_RESULTS cap before paginating
          if (maxResults > 0 && allEnrichedLeads.length >= maxResults) break;

          // 6. Advance to next page (skip on last page)
          if (pageNum < maxPages) {
            const hasNext = await goToNextPage(stagehand);
            if (!hasNext) {
              console.log("[main] No more pages — finished pagination early.");
              break;
            }
          }
        }

        console.log(
          `[main] All pages done. Total cards clicked: ${totalCards}, ` +
          `with contacts: ${totalWithContacts}.`
        );
        return allEnrichedLeads;
      }
    );

    if (leadsWithReonomyDetail.length === 0) {
      console.error("[main] No records extracted. Exiting.");
      process.exitCode = 1;
      return;
    }

    // Update run state metrics
    runState.metrics.normalizedRecords = leadsWithReonomyDetail.length;
    runState.metrics.partialRecords = leadsWithReonomyDetail.filter(
      (l) => l.extraction_status === "partial"
    ).length;
    saveRunState();
    console.log("[main] STEPS 3-5 complete.");

    // The "cappedLeads" variable is kept for compatibility with REONOMY_ONLY
    // and the downstream enrichment path — the cap was already applied inside
    // the loop above, so this is effectively a no-op.
    const cappedLeads = leadsWithReonomyDetail;
    console.log("[main] STEP 4 complete.");
    console.log("[main] STEP 5 complete.");

    // ── REONOMY-ONLY MODE ────────────────────────────────────────────────────
    // When REONOMY_ONLY=true, skip all external enrichment APIs and save the
    // Reonomy property + contact data directly to Google Sheets.
    if (reonomyOnly) {
      logStepHeader(6, "REONOMY-ONLY — skipping ATTOM / Apollo / Hunter / ZeroBounce");
      const reonomyRows = buildReonomyOnlyRows(leadsWithReonomyDetail);

      const dedupedRows: Tier1ContactRow[] = [];
      let skippedLocal = 0;
      for (const row of reonomyRows) {
        const email = row.contact_email.trim().toLowerCase();
        if (email && (await idempotencyStore.hasSeenContactEmail(email))) {
          skippedLocal += 1;
          continue;
        }
        dedupedRows.push(row);
      }
      runState.metrics.skippedExistingContacts = skippedLocal;
      runState.metrics.contactCandidates = reonomyRows.length;
      applyContactMetrics(runState, reonomyRows);
      saveRunState();

      const outputResult = await runStage("save", "SAVE REONOMY ROWS", async () =>
        saveToGoogleSheet(dedupedRows, config.output.googleSheets)
      );
      for (const email of outputResult.appendedEmails) {
        const row = dedupedRows.find(
          (candidate) => candidate.contact_email.trim().toLowerCase() === email
        );
        await idempotencyStore.markContactEmailSeen(
          email,
          row?.property_id ?? "unknown",
          runId
        );
      }
      runState.metrics.appendedRows = outputResult.appendedCount;
      runState.metrics.skippedExistingContacts += outputResult.skippedExistingCount;
      runState.status = "completed";
      saveRunState();
      checkpointStore.clear();

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log("\n==============================================");
      console.log("  RUN COMPLETE (Reonomy-only)");
      console.log("==============================================");
      console.log(`Properties extracted  : ${leadsWithReonomyDetail.length}`);
      console.log(`Normalized leads      : ${leadsWithReonomyDetail.length}`);
      console.log(`Rows built            : ${reonomyRows.length}`);
      console.log(`Rows appended         : ${outputResult.appendedCount}`);
      console.log(`Rows skipped (dedup)  : ${runState.metrics.skippedExistingContacts}`);
      console.log(`Spreadsheet ID        : ${outputResult.spreadsheetId}`);
      console.log(`Sheet tab             : ${outputResult.tabName}`);
      reportPaths = writeRunReport({
        outputDir: config.run.runStateDir,
        runId,
        status: "completed",
        zipCode,
        maxPages,
        maxResults,
        elapsedSeconds: Number(elapsed),
        runState,
        spreadsheetId: outputResult.spreadsheetId,
        tabName: outputResult.tabName,
        checkpointFile: checkpointStore.getPath(),
        sqlitePath: config.localStore.sqlitePath,
        runStatePath: config.run.runStateEnabled ? runStateStore.getPath() : undefined,
      });
      console.log(`Run report (txt)      : ${reportPaths.textPath}`);
      console.log(`Run report (json)     : ${reportPaths.jsonPath}`);
      console.log(`Elapsed time          : ${elapsed}s`);
      console.log("==============================================");
      return;
    }
    // ────────────────────────────────────────────────────────────────────────

    const attomClient = new AttomClient({
      apiKey: config.providers.attom.apiKey,
      baseUrl: config.providers.attom.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.attomPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });
    const batchdataPropertyClient = new BatchDataPropertyClient({
      apiKey: config.providers.batchdata.apiKey,
      baseUrl: config.providers.batchdata.baseUrl,
      enabled: config.providers.batchdata.propertyEnrich,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });

    const enrichedLeads = await runStage(
      "attom_enrich",
      "ATTOM ENRICH",
      async () => {
        if (config.run.skipAttom) {
          console.log("[main] SKIP_ATTOM=true — bypassing ATTOM, keeping all Reonomy contacts.");
          return leadsWithReonomyDetail.map((lead) =>
            buildSkippedAttomLead(lead, "SKIP_ATTOM=true")
          );
        }
        return enrichPropertiesWithAttom(
          leadsWithReonomyDetail,
          attomClient,
          batchdataPropertyClient,
          config.run.enrichmentConcurrency,
          runId,
          checkpointStore,
          idempotencyStore,
          config.run.reprocessMode
        );
      }
    );
    runState.metrics.attomEnrichedRecords = enrichedLeads.length;
    saveRunState();
    console.log("[main] STEP 6 complete.");

    const apolloClient = new ApolloClient({
      apiKey: config.providers.apollo.apiKey,
      baseUrl: config.providers.apollo.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.apolloPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });
    const hunterClient = new HunterClient({
      apiKey: config.providers.hunter.apiKey,
      baseUrl: config.providers.hunter.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.hunterPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });
    const pdlClient = new PdlClient({
      apiKey: config.providers.pdl.apiKey,
      baseUrl: config.providers.pdl.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.pdlPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
      maxResultsPerSearch: config.providers.pdl.maxResultsPerSearch,
    });
    const batchdataSkipTraceClient = new BatchDataSkipTraceClient({
      apiKey: config.providers.batchdata.apiKey,
      baseUrl: config.providers.batchdata.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.batchdataPerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });

    const contactRows = await runStage(
      "contact_enrich",
      "CONTACT ENRICH",
      async () =>
        buildContactRows(
          enrichedLeads,
          apolloClient,
          hunterClient,
          pdlClient,
          batchdataSkipTraceClient,
          config.run.enrichmentConcurrency,
          runId,
          checkpointStore,
          ownerResolver
        )
    );
    runState.metrics.contactCandidates = contactRows.length;
    saveRunState();
    console.log("[main] STEP 7 complete.");

    const zeroBounceClient = new ZeroBounceClient({
      apiKey: config.providers.zerobounce.apiKey,
      baseUrl: config.providers.zerobounce.baseUrl,
      maxAttempts: config.run.stageMaxAttempts,
      baseDelayMs: config.run.stageRetryBaseDelayMs,
      maxDelayMs: config.run.stageRetryMaxDelayMs,
      ratePerSecond: config.reliability.providerRateLimits.zerobouncePerSecond,
      circuitFailureThreshold: config.reliability.circuitBreaker.failureThreshold,
      circuitResetTimeoutMs: config.reliability.circuitBreaker.resetTimeoutMs,
    });

    const verifiedRows = await runStage(
      "email_verify",
      "ZEROBOUNCE VERIFY",
      async () =>
        verifyContactRows(
          contactRows,
          zeroBounceClient,
          config.run.verificationConcurrency,
          runId,
          checkpointStore
        )
    );
    runState.metrics.verifiedContacts = verifiedRows.length;
    applyContactMetrics(runState, verifiedRows);
    saveRunState();
    console.log("[main] STEP 8 complete.");

    const dedupedRows: Tier1ContactRow[] = [];
    let skippedLocal = 0;
    for (const row of verifiedRows) {
      const email = row.contact_email.trim().toLowerCase();
      if (email && (await idempotencyStore.hasSeenContactEmail(email))) {
        skippedLocal += 1;
        continue;
      }
      dedupedRows.push(row);
    }
    runState.metrics.skippedExistingContacts = skippedLocal;
    saveRunState();

    const outputResult = await runStage("save", "SAVE CONTACT ROWS", async () =>
      saveToGoogleSheet(dedupedRows, config.output.googleSheets)
    );
    for (const email of outputResult.appendedEmails) {
      const row = dedupedRows.find(
        (candidate) => candidate.contact_email.trim().toLowerCase() === email
      );
      await idempotencyStore.markContactEmailSeen(
        email,
        row?.property_id ?? "unknown",
        runId
      );
    }
    runState.metrics.appendedRows = outputResult.appendedCount;
    runState.metrics.skippedExistingContacts += outputResult.skippedExistingCount;
    runState.status = "completed";
    saveRunState();
    checkpointStore.clear();
    console.log("[main] STEP 9 complete.");

    // --- Summary ---
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("\n==============================================");
    console.log("  RUN COMPLETE");
    console.log("==============================================");
    console.log(`Raw records extracted : ${leadsWithReonomyDetail.length}`);
    console.log(`Normalized leads      : ${leadsWithReonomyDetail.length}`);
    console.log(`ATTOM enriched        : ${enrichedLeads.length}`);
    console.log(`Contact rows built    : ${contactRows.length}`);
    console.log(`Verified contacts     : ${verifiedRows.length}`);
    console.log(`Partial records       : ${runState.metrics.partialRecords}`);
    console.log(`Rows appended         : ${outputResult.appendedCount}`);
    console.log(`Rows skipped          : ${runState.metrics.skippedExistingContacts}`);
    console.log(`Spreadsheet ID        : ${outputResult.spreadsheetId}`);
    console.log(`Sheet tab             : ${outputResult.tabName}`);
    if (config.run.runStateEnabled) {
      console.log(`Run-state file        : ${runStateStore.getPath()}`);
    }
    console.log(`Checkpoint file       : ${checkpointStore.getPath()}`);
    console.log(`Local SQLite          : ${config.localStore.sqlitePath}`);
    reportPaths = writeRunReport({
      outputDir: config.run.runStateDir,
      runId,
      status: "completed",
      zipCode,
      maxPages,
      maxResults,
      elapsedSeconds: Number(elapsed),
      runState,
      spreadsheetId: outputResult.spreadsheetId,
      tabName: outputResult.tabName,
      checkpointFile: checkpointStore.getPath(),
      sqlitePath: config.localStore.sqlitePath,
      runStatePath: config.run.runStateEnabled ? runStateStore.getPath() : undefined,
    });
    console.log(`Run report (txt)      : ${reportPaths.textPath}`);
    console.log(`Run report (json)     : ${reportPaths.jsonPath}`);
    console.log(`Elapsed time          : ${elapsed}s`);
    console.log("==============================================");
  } catch (error) {
    runState.status = "failed";
    saveRunState();
    reportPaths = writeRunReport({
      outputDir: config.run.runStateDir,
      runId,
      status: "failed",
      zipCode,
      maxPages,
      maxResults,
      elapsedSeconds: (Date.now() - startTime) / 1000,
      runState,
      checkpointFile: checkpointStore.getPath(),
      sqlitePath: config.localStore.sqlitePath,
      runStatePath: config.run.runStateEnabled ? runStateStore.getPath() : undefined,
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    console.error("\n[main] FATAL ERROR during scrape run:");
    console.error(error);
    console.error(`[main] Run report (txt): ${reportPaths.textPath}`);
    console.error(`[main] Run report (json): ${reportPaths.jsonPath}`);
    process.exitCode = 1;
  } finally {
    // Always close the browser session
    console.log("[main] Closing Browserbase session...");
    await stagehand.close();
    await idempotencyStore.close();
    console.log("[main] Session closed.");
  }
}

main();

function buildSkippedAttomLead(lead: EnrichedPropertyLead | any, note: string): EnrichedPropertyLead {
  return {
    ...lead,
    last_sale_date: lead.last_sale_date ?? "",
    last_sale_price: lead.last_sale_price ?? "",
    permit_summary: lead.permit_summary ?? "",
    roof_permit_date: lead.roof_permit_date ?? "",
    hvac_permit_date: lead.hvac_permit_date ?? "",
    plumbing_permit_date: lead.plumbing_permit_date ?? "",
    electrical_permit_date: lead.electrical_permit_date ?? "",
    restoration_permit_date: lead.restoration_permit_date ?? "",
    fire_water_permit_date: lead.fire_water_permit_date ?? "",
    last_permit_date: lead.last_permit_date ?? "",
    permit_contractor: lead.permit_contractor ?? "",
    ownership_transfer_flag: lead.ownership_transfer_flag ?? "",
    tax_or_distress_notes: lead.tax_or_distress_notes ?? "",
    hazard_notes: lead.hazard_notes ?? "",
    crime_notes: lead.crime_notes ?? "",
    demographics_notes: lead.demographics_notes ?? "",
    air_quality_notes: lead.air_quality_notes ?? "",
    climate_notes: lead.climate_notes ?? "",
    enrichment_status: "skipped",
  };
}

function buildReonomyOnlyRows(leads: NormalizedLead[]): Tier1ContactRow[] {
  const rows: Tier1ContactRow[] = [];

  for (const lead of leads) {
    const baseRow = {
      property_id: lead.property_id,
      property_address: lead.property_address,
      city: lead.city,
      state: lead.state,
      zip_code: lead.zip_code,
      land_use: lead.land_use,
      year_built: lead.year_built,
      square_feet: lead.square_feet,
      owner_entity: lead.owner_entity,
      source_platform: lead.source_platform,
      source_search_area: lead.source_search_area,
      source_run_date: lead.source_run_date,
      source_notes: lead.source_notes,
      extraction_status: lead.extraction_status,
      enrichment_status: "skipped" as const,
      verification_status: "skipped" as const,
      review_status: lead.review_status,
      last_sale_date: lead.reonomy_last_acquisition_date,
      last_sale_price: "",
      permit_summary: "",
      roof_permit_date: "",
      hvac_permit_date: "",
      plumbing_permit_date: "",
      electrical_permit_date: "",
      restoration_permit_date: "",
      fire_water_permit_date: "",
      last_permit_date: "",
      permit_contractor: "",
      ownership_transfer_flag: "",
      tax_or_distress_notes: "",
      hazard_notes: "",
      crime_notes: "",
      demographics_notes: "",
      air_quality_notes: "",
      climate_notes: "",
    };

    // Try multi-contact JSON first (new format from per-card scraping)
    let contacts: ReonomyContact[] = [];
    try {
      if (lead.reonomy_contacts_json && lead.reonomy_contacts_json !== "[]") {
        contacts = JSON.parse(lead.reonomy_contacts_json) as ReonomyContact[];
      }
    } catch { /* fall through to legacy */ }

    if (contacts.length > 0) {
      // One row per person × max(phones, emails) — same logic as buildReonomyCandidates
      let rowIndex = 0;
      for (const c of contacts) {
        const rowCount = Math.max(c.emails.length, c.phones.length, 1);
        for (let j = 0; j < rowCount; j++) {
          rows.push({
            ...baseRow,
            contact_name: c.name,
            contact_title: c.title,
            contact_email: (c.emails[j] ?? "").toLowerCase().trim(),
            contact_phone: (c.phones[j] ?? "").trim(),
            contact_source: "reonomy",
            contact_sources: "reonomy",
            email_source: c.emails[j] ? "reonomy" : "",
            phone_source: c.phones[j] ? "reonomy" : "",
            contact_confidence: c.emails[j] ? 0.95 : c.phones[j] ? 0.75 : 0.5,
            contact_enrichment_notes: "",
            sequence: sequenceForIndex(rowIndex),
            notes: lead.reonomy_detail_notes || "",
          });
          rowIndex++;
        }
      }
    } else {
      // Legacy single-contact fallback (or placeholder row when nothing was found)
      rows.push({
        ...baseRow,
        contact_name: lead.reonomy_contact_name,
        contact_title: lead.reonomy_contact_title,
        contact_email: lead.reonomy_contact_email,
        contact_phone: lead.reonomy_contact_phone,
        contact_source:
          lead.reonomy_contact_name || lead.reonomy_contact_email || lead.reonomy_contact_phone
            ? "reonomy"
            : "",
        contact_sources:
          lead.reonomy_contact_name || lead.reonomy_contact_email || lead.reonomy_contact_phone
            ? "reonomy"
            : "",
        email_source: lead.reonomy_contact_email ? "reonomy" : "",
        phone_source: lead.reonomy_contact_phone ? "reonomy" : "",
        contact_confidence: lead.reonomy_contact_email
          ? 0.95
          : lead.reonomy_contact_phone
            ? 0.75
            : lead.reonomy_contact_name
              ? 0.5
              : null,
        contact_enrichment_notes: "",
        sequence: "Primary" as const,
        notes: lead.reonomy_detail_notes ||
          (lead.reonomy_contact_name || lead.reonomy_contact_email
            ? ""
            : "No contact found on Reonomy"),
      });
    }
  }

  return rows;
}

function buildReonomyContactCandidates(lead: EnrichedPropertyLead): ContactCandidate[] {
  const candidates: ContactCandidate[] = [];

  // 1. Multi-contact JSON (new format from per-card scraping)
  if (lead.reonomy_contacts_json && lead.reonomy_contacts_json !== "[]") {
    try {
      const contacts = JSON.parse(lead.reonomy_contacts_json) as ReonomyContact[];
      for (const c of contacts) {
        if (!c.name) continue;
        const rowCount = Math.max(c.emails.length, c.phones.length, 1);
        for (let j = 0; j < rowCount; j++) {
          candidates.push({
            property_id: lead.property_id,
            owner_entity: lead.owner_entity,
            contact_name: c.name,
            contact_title: c.title,
            contact_phone: (c.phones[j] ?? "").trim(),
            contact_email: (c.emails[j] ?? "").toLowerCase().trim(),
            contact_source: "reonomy",
            confidence: c.emails[j] ? 0.95 : c.phones[j] ? 0.75 : 0.5,
          });
        }
      }
      if (candidates.length > 0) return candidates;
    } catch { /* fall through to legacy */ }
  }

  // 2. Legacy single-contact fallback
  if (lead.reonomy_contact_name || lead.reonomy_contact_title || lead.reonomy_contact_email) {
    candidates.push({
      property_id: lead.property_id,
      owner_entity: lead.owner_entity,
      contact_name: lead.reonomy_contact_name,
      contact_title: lead.reonomy_contact_title,
      contact_phone: lead.reonomy_contact_phone,
      contact_email: lead.reonomy_contact_email,
      contact_source: "reonomy",
      confidence: lead.reonomy_contact_email ? 0.95 : 0.75,
    });
  }

  return candidates;
}

async function enrichPropertiesWithAttom(
  leads: any[],
  attomClient: AttomClient,
  batchdataPropertyClient: BatchDataPropertyClient,
  concurrency: number,
  runId: string,
  checkpointStore: CheckpointStore,
  idempotencyStore: SqliteIdempotencyStore,
  reprocessMode: ReprocessMode
): Promise<EnrichedPropertyLead[]> {
  const queue = new PQueue({ concurrency: Math.max(1, concurrency) });
  const output: EnrichedPropertyLead[] = new Array(leads.length);
  let completed = 0;

  await Promise.all(
    leads.map((lead, index) =>
      queue.add(async () => {
        if (reprocessMode !== "full" && (await idempotencyStore.hasSeenProperty(lead.property_id))) {
          output[index] = buildSkippedAttomLead(lead, "skipped by local SQLite dedupe");
        } else {
          const attomEnriched = await attomClient.enrichLead(lead);
          // BatchData property enrichment — fills fields ATTOM left empty.
          // No-op when BATCHDATA_PROPERTY_ENRICH=false or no API key.
          const enriched = await batchdataPropertyClient.enrichLead(attomEnriched);
          output[index] = enriched;
          await idempotencyStore.markPropertySeen(lead.property_id, runId);
        }

        completed += 1;
        checkpointStore.save(runId, "attom_enrich", completed, leads.length);
      })
    )
  );

  return output;
}

async function buildContactRows(
  leads: EnrichedPropertyLead[],
  apolloClient: ApolloClient,
  hunterClient: HunterClient,
  pdlClient: PdlClient,
  batchdataSkipTraceClient: BatchDataSkipTraceClient,
  concurrency: number,
  runId: string,
  checkpointStore: CheckpointStore,
  ownerResolver?: OwnerResolver  // Optional — undefined when OWNER_RESOLUTION_ENABLED=false
): Promise<Tier1ContactRow[]> {
  const queue = new PQueue({ concurrency: Math.max(1, concurrency) });
  const rowsByProperty: Tier1ContactRow[][] = new Array(leads.length);
  let completed = 0;

  await Promise.all(
    leads.map((lead, index) =>
      queue.add(async () => {
        const reonomy = buildReonomyContactCandidates(lead);

        // ── Owner Resolution (optional) ────────────────────────────────────
        // Runs BEFORE Apollo/Hunter to supply a better company name / domain.
        // When disabled (ownerResolver is undefined) this block is never entered
        // and the pipeline behaves exactly as before.
        let effectiveLead = lead;
        let ownerResolutionResult: OwnerResolutionResult | null = null;

        if (ownerResolver) {
          ownerResolutionResult = await resolveOwnerSafe(lead, ownerResolver);
          if (
            ownerResolutionResult.resolution_status === "resolved" ||
            ownerResolutionResult.resolution_status === "needs_review"
          ) {
            // Clone lead with resolved values — does NOT mutate original
            effectiveLead = {
              ...lead,
              owner_entity:
                ownerResolutionResult.candidate_company_name || lead.owner_entity,
              reonomy_company_domain:
                ownerResolutionResult.candidate_domain ||
                lead.reonomy_company_domain,
            };
          }
        }
        // ──────────────────────────────────────────────────────────────────

        // Collect optional owner-resolution metadata to attach to output rows
        const ownerMeta: Partial<Tier1ContactRow> = ownerResolutionResult
          ? {
              owner_resolution_status: ownerResolutionResult.resolution_status,
              owner_resolution_confidence: ownerResolutionResult.confidence_score,
              resolved_company_name: ownerResolutionResult.candidate_company_name,
              resolved_domain: ownerResolutionResult.candidate_domain,
              owner_resolution_source: ownerResolutionResult.resolution_source,
              owner_resolution_notes: ownerResolutionResult.notes,
              registry_contact_name: ownerResolutionResult.registry_contact_name ?? "",
              registry_contact_title: ownerResolutionResult.registry_contact_title ?? "",
            }
          : {};

        // Apollo: one call per property — searches by org, may return multiple people
        const contactFlow = await enrichContactsForLead(
          effectiveLead,
          reonomy,
          { apolloClient, hunterClient, pdlClient, batchdataSkipTraceClient }
        );
        effectiveLead = contactFlow.effectiveLead;
        const merged = contactFlow.candidates;
        // BatchData: address-based skip trace — complements Apollo/Hunter for
        if (merged.length === 0) {
          // No contacts found — still write the property row so it appears in Sheets.
          rowsByProperty[index] = [{
            property_id: lead.property_id,
            property_address: lead.property_address,
            city: lead.city,
            state: lead.state,
            zip_code: lead.zip_code,
            land_use: lead.land_use,
            year_built: lead.year_built,
            square_feet: lead.square_feet,
            owner_entity: lead.owner_entity,
            source_platform: lead.source_platform,
            source_search_area: lead.source_search_area,
            source_run_date: lead.source_run_date,
            source_notes: lead.source_notes,
            contact_name: "",
            contact_title: "",
            contact_email: "",
            contact_phone: "",
            contact_source: "",
            contact_sources: "",
            email_source: "",
            phone_source: "",
            contact_confidence: null,
            contact_enrichment_notes: "No provider returned a usable contact",
            sequence: sequenceForIndex(0),
            extraction_status: lead.extraction_status,
            enrichment_status: lead.enrichment_status,
            verification_status: "unverified",
            review_status: lead.review_status,
            notes: "No contact found — manual outreach required",
            last_sale_date: lead.last_sale_date || lead.reonomy_last_acquisition_date,
            last_sale_price: lead.last_sale_price,
            permit_summary: lead.permit_summary,
            roof_permit_date: lead.roof_permit_date,
            hvac_permit_date: lead.hvac_permit_date,
            plumbing_permit_date: lead.plumbing_permit_date,
            electrical_permit_date: lead.electrical_permit_date,
            restoration_permit_date: lead.restoration_permit_date,
            fire_water_permit_date: lead.fire_water_permit_date,
            last_permit_date: lead.last_permit_date,
            permit_contractor: lead.permit_contractor,
            ownership_transfer_flag: lead.ownership_transfer_flag,
            tax_or_distress_notes: lead.tax_or_distress_notes,
            hazard_notes: lead.hazard_notes,
            crime_notes: lead.crime_notes,
            demographics_notes: lead.demographics_notes,
            air_quality_notes: lead.air_quality_notes,
            climate_notes: lead.climate_notes,
            ...ownerMeta,
          }];
        } else {
          // Only write contacts that have an email — no cap on how many.
          const emailContacts = merged.filter((c) => c.contact_email.trim());
          const contactsToWrite = emailContacts.length > 0 ? emailContacts : merged.slice(0, 1);
          rowsByProperty[index] = contactsToWrite.map((contact, contactIndex) => ({
            property_id: lead.property_id,
            property_address: lead.property_address,
            city: lead.city,
            state: lead.state,
            zip_code: lead.zip_code,
            land_use: lead.land_use,
            year_built: lead.year_built,
            square_feet: lead.square_feet,
            owner_entity: lead.owner_entity,
            source_platform: lead.source_platform,
            source_search_area: lead.source_search_area,
            source_run_date: lead.source_run_date,
            source_notes: lead.source_notes,
            contact_name: contact.contact_name,
            contact_title: contact.contact_title,
            contact_email: contact.contact_email,
            contact_phone: contact.contact_phone,
            contact_source: contact.contact_source,
            contact_sources: (contact.contact_sources ?? [contact.contact_source])
              .filter((source) => source !== "hybrid")
              .join(","),
            email_source: contact.email_source ?? (contact.contact_email ? contact.contact_source : ""),
            phone_source: contact.phone_source ?? (contact.contact_phone ? contact.contact_source : ""),
            contact_confidence: contact.confidence,
            contact_enrichment_notes: contact.contact_enrichment_notes ?? "",
            sequence: sequenceForIndex(contactIndex),
            extraction_status: lead.extraction_status,
            enrichment_status: lead.enrichment_status,
            verification_status: "unverified",
            review_status: lead.review_status,
            notes: contact.contact_email
              ? (lead.reonomy_detail_notes || "")
              : `${lead.reonomy_detail_notes}${lead.reonomy_detail_notes ? "; " : ""}Missing email`,
            last_sale_date: lead.last_sale_date || lead.reonomy_last_acquisition_date,
            last_sale_price: lead.last_sale_price,
            permit_summary: lead.permit_summary,
            roof_permit_date: lead.roof_permit_date,
            hvac_permit_date: lead.hvac_permit_date,
            plumbing_permit_date: lead.plumbing_permit_date,
            electrical_permit_date: lead.electrical_permit_date,
            restoration_permit_date: lead.restoration_permit_date,
            fire_water_permit_date: lead.fire_water_permit_date,
            last_permit_date: lead.last_permit_date,
            permit_contractor: lead.permit_contractor,
            ownership_transfer_flag: lead.ownership_transfer_flag,
            tax_or_distress_notes: lead.tax_or_distress_notes,
            hazard_notes: lead.hazard_notes,
            crime_notes: lead.crime_notes,
            demographics_notes: lead.demographics_notes,
            air_quality_notes: lead.air_quality_notes,
            climate_notes: lead.climate_notes,
            ...ownerMeta,
          }));
        }

        completed += 1;
        checkpointStore.save(runId, "contact_enrich", completed, leads.length);
      })
    )
  );

  return rowsByProperty.flat();
}

async function verifyContactRows(
  rows: Tier1ContactRow[],
  zeroBounceClient: ZeroBounceClient,
  concurrency: number,
  runId: string,
  checkpointStore: CheckpointStore
): Promise<Tier1ContactRow[]> {
  const queue = new PQueue({ concurrency: Math.max(1, concurrency) });
  const output: Tier1ContactRow[] = new Array(rows.length);
  let completed = 0;

  await Promise.all(
    rows.map((row, index) =>
      queue.add(async () => {
        const result = await zeroBounceClient.verify(row.contact_email);
        output[index] = {
          ...row,
          verification_status: result.status,
          notes:
            result.status === "invalid"
              ? `${row.notes}${row.notes ? "; " : ""}email invalid (${result.subStatus || "invalid"})`
              : row.notes,
        };

        completed += 1;
        checkpointStore.save(runId, "email_verify", completed, rows.length);
      })
    )
  );

  return output;
}
