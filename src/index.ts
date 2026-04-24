import { randomUUID } from "crypto";
import { Stagehand } from "@browserbasehq/stagehand";
import PQueue from "p-queue";
import { config } from "./config";
import { loginToReonomy } from "./reonomy/login";
import { searchByZipCode } from "./reonomy/search";
import { extractAllPages } from "./reonomy/extractResults";
import { enrichLeadsWithReonomyDetails } from "./reonomy/extractDetail";
import { normalizeAll } from "./reonomy/normalize";
import { saveToGoogleSheet } from "./output/saveCsv";
import { AttomClient } from "./enrichment/attom";
import { ApolloClient } from "./enrichment/contacts/apollo";
import { HunterClient } from "./enrichment/contacts/hunter";
import { mergeContactCandidates, sequenceForIndex } from "./enrichment/contacts/merge";
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
import type {
  ContactCandidate,
  EnrichedPropertyLead,
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

async function main(): Promise<void> {
  const startTime = Date.now();
  const { zipCode, maxPages, maxResults } = config.run;
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

  console.log("==============================================");
  console.log("  EVERYBUILDING — Reonomy Scraper (Tier 1 MVP)");
  console.log("==============================================");
  console.log(`Run ID     : ${runId}`);
  console.log(`ZIP Code   : ${zipCode}`);
  console.log(`Max Pages  : ${maxPages}`);
  console.log(`Max Results: ${maxResults > 0 ? maxResults : "unlimited"}`);
  console.log(
    `Output     : Google Sheets (${config.output.googleSheets.spreadsheetId}/${config.output.googleSheets.tabName})`
  );
  console.log("----------------------------------------------");

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
    enableCaching: true,
    verbose: 1,
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

    const rawRecords = await runStage("extract", "EXTRACT", async () =>
      extractAllPages(stagehand, maxPages)
    );
    runState.metrics.extractedRecords = rawRecords.length;
    saveRunState();
    console.log("[main] STEP 3 complete.");

    if (rawRecords.length === 0) {
      console.error("[main] No records extracted. Exiting.");
      process.exitCode = 1;
      return;
    }

    const leads = await runStage("normalize", "NORMALIZE", async () =>
      normalizeAll(rawRecords, zipCode)
    );
    const cappedLeads = maxResults > 0 ? leads.slice(0, maxResults) : leads;
    if (maxResults > 0 && leads.length > maxResults) {
      console.log(
        `[main] Limiting downstream processing to first ${maxResults} normalized propert${maxResults === 1 ? "y" : "ies"} (from ${leads.length} extracted).`
      );
    }

    runState.metrics.normalizedRecords = cappedLeads.length;
    runState.metrics.partialRecords = cappedLeads.filter(
      (lead) => lead.extraction_status === "partial"
    ).length;
    saveRunState();
    console.log("[main] STEP 4 complete.");

    const leadsWithReonomyDetail = await runStage(
      "reonomy_detail",
      "REONOMY DETAIL",
      async () => enrichLeadsWithReonomyDetails(stagehand, cappedLeads)
    );
    console.log("[main] STEP 5 complete.");

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

    const enrichedLeads = await runStage(
      "attom_enrich",
      "ATTOM ENRICH",
      async () =>
        enrichPropertiesWithAttom(
          leadsWithReonomyDetail,
          attomClient,
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

    const contactRows = await runStage(
      "contact_enrich",
      "CONTACT ENRICH",
      async () =>
        buildContactRows(
          enrichedLeads,
          apolloClient,
          hunterClient,
          config.run.enrichmentConcurrency,
          runId,
          checkpointStore
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
    console.log(`Raw records extracted : ${rawRecords.length}`);
    console.log(`Normalized leads      : ${leads.length}`);
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
    ownership_transfer_flag: lead.ownership_transfer_flag ?? "",
    tax_or_distress_notes: lead.tax_or_distress_notes ?? "",
    enrichment_status: "skipped",
  };
}

function buildReonomyContactCandidates(lead: EnrichedPropertyLead): ContactCandidate[] {
  // Only the INDIVIDUAL person on the Owner tab creates a contact candidate.
  // The owner entity (LLC/Corp) is already stored in lead.owner_entity and
  // must not become a separate row.
  if (
    lead.reonomy_contact_name ||
    lead.reonomy_contact_title ||
    lead.reonomy_contact_email
  ) {
    return [{
      property_id: lead.property_id,
      owner_entity: lead.owner_entity,
      contact_name: lead.reonomy_contact_name,
      contact_title: lead.reonomy_contact_title,
      contact_phone: lead.reonomy_contact_phone,
      contact_email: lead.reonomy_contact_email,
      contact_source: "reonomy",
      confidence: lead.reonomy_contact_email ? 0.95 : 0.75,
    }];
  }

  return [];
}

async function enrichPropertiesWithAttom(
  leads: any[],
  attomClient: AttomClient,
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
          const enriched = await attomClient.enrichLead(lead);
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
  concurrency: number,
  runId: string,
  checkpointStore: CheckpointStore
): Promise<Tier1ContactRow[]> {
  const queue = new PQueue({ concurrency: Math.max(1, concurrency) });
  const rowsByProperty: Tier1ContactRow[][] = new Array(leads.length);
  let completed = 0;

  await Promise.all(
    leads.map((lead, index) =>
      queue.add(async () => {
        const reonomy = buildReonomyContactCandidates(lead);
        const [apollo, hunter] = await Promise.all([
          apolloClient.findContacts(lead),
          hunterClient.findContacts(lead),
        ]);
        const merged = mergeContactCandidates(reonomy, apollo, hunter);

        if (merged.length === 0) {
          rowsByProperty[index] = [];
        } else {
          rowsByProperty[index] = merged.map((contact, contactIndex) => ({
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
            ownership_transfer_flag: lead.ownership_transfer_flag,
            tax_or_distress_notes: lead.tax_or_distress_notes,
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
