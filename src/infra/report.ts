import fs from "fs";
import path from "path";
import type { RunStateSnapshot } from "../types";

type RunReportInput = {
  outputDir: string;
  runId: string;
  status: "completed" | "failed";
  zipCode: string;
  maxPages: number;
  maxResults: number;
  elapsedSeconds: number;
  runState: RunStateSnapshot;
  spreadsheetId?: string;
  tabName?: string;
  checkpointFile: string;
  sqlitePath: string;
  runStatePath?: string;
  errorMessage?: string;
};

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function writeRunReport(input: RunReportInput): {
  jsonPath: string;
  textPath: string;
} {
  ensureDirectory(input.outputDir);

  const jsonPath = path.resolve(input.outputDir, `run-report-${input.runId}.json`);
  const textPath = path.resolve(input.outputDir, `run-report-${input.runId}.txt`);

  const report = {
    runId: input.runId,
    status: input.status,
    zipCode: input.zipCode,
    maxPages: input.maxPages,
    maxResults: input.maxResults,
    elapsedSeconds: input.elapsedSeconds,
    output: {
      spreadsheetId: input.spreadsheetId ?? null,
      tabName: input.tabName ?? null,
    },
    files: {
      runState: input.runStatePath ?? null,
      checkpoint: input.checkpointFile,
      sqlite: input.sqlitePath,
    },
    metrics: input.runState.metrics,
    stageStatus: input.runState.stageStatus,
    errors: input.runState.errors,
    errorMessage: input.errorMessage ?? null,
    createdAt: new Date().toISOString(),
  };

  const text = [
    "==============================================",
    "  EVERYBUILDING RUN REPORT",
    "==============================================",
    `Run ID               : ${input.runId}`,
    `Status               : ${input.status}`,
    `ZIP Code             : ${input.zipCode}`,
    `Max Pages            : ${input.maxPages}`,
    `Max Results          : ${input.maxResults > 0 ? input.maxResults : "unlimited"}`,
    `Elapsed Time         : ${input.elapsedSeconds.toFixed(1)}s`,
    `Spreadsheet ID       : ${input.spreadsheetId ?? "n/a"}`,
    `Sheet Tab            : ${input.tabName ?? "n/a"}`,
    `Run-state File       : ${input.runStatePath ?? "n/a"}`,
    `Checkpoint File      : ${input.checkpointFile}`,
    `Local SQLite         : ${input.sqlitePath}`,
    "----------------------------------------------",
    `Raw records extracted: ${input.runState.metrics.extractedRecords}`,
    `Normalized leads     : ${input.runState.metrics.normalizedRecords}`,
    `ATTOM enriched       : ${input.runState.metrics.attomEnrichedRecords}`,
    `Contact candidates   : ${input.runState.metrics.contactCandidates}`,
    `Rows verified        : ${input.runState.metrics.verifiedContacts}`,
    `Rows with email      : ${input.runState.metrics.rowsWithEmail}`,
    `Valid emails         : ${input.runState.metrics.validEmails}`,
    `Invalid emails       : ${input.runState.metrics.invalidEmails}`,
    `Unknown emails       : ${input.runState.metrics.unknownEmails}`,
    `Unverified emails    : ${input.runState.metrics.unverifiedEmails}`,
    `Contact source counts: ${JSON.stringify(input.runState.metrics.contactSourceCounts)}`,
    `Rows appended        : ${input.runState.metrics.appendedRows}`,
    `Rows skipped         : ${input.runState.metrics.skippedExistingContacts}`,
    `Partial records      : ${input.runState.metrics.partialRecords}`,
    "----------------------------------------------",
    "Errors:",
    ...(input.runState.errors.length > 0 ? input.runState.errors : ["none"]),
    ...(input.errorMessage ? ["----------------------------------------------", `Fatal Error          : ${input.errorMessage}`] : []),
    "==============================================",
  ].join("\n");

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), "utf-8");
  fs.writeFileSync(textPath, text, "utf-8");

  return { jsonPath, textPath };
}
