import fs from "fs";
import path from "path";
import type { RunStateSnapshot, StageName, StageStatus } from "../types";

function ensureDirectory(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export class RunStateStore {
  private readonly filePath: string;

  constructor(private readonly runId: string, outputDir: string) {
    ensureDirectory(outputDir);
    this.filePath = path.resolve(outputDir, `run-state-${runId}.json`);
  }

  getPath(): string {
    return this.filePath;
  }

  load(): RunStateSnapshot | null {
    if (!fs.existsSync(this.filePath)) {
      return null;
    }

    const content = fs.readFileSync(this.filePath, "utf-8");
    return JSON.parse(content) as RunStateSnapshot;
  }

  save(snapshot: RunStateSnapshot): void {
    fs.writeFileSync(this.filePath, JSON.stringify(snapshot, null, 2), "utf-8");
  }
}

export function createInitialRunState(runId: string): RunStateSnapshot {
  return {
    runId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    stageStatus: {},
    metrics: {
      extractedRecords: 0,
      normalizedRecords: 0,
      attomEnrichedRecords: 0,
      contactCandidates: 0,
      verifiedContacts: 0,
      skippedExistingContacts: 0,
      appendedRows: 0,
      partialRecords: 0,
    },
    errors: [],
  };
}

export function markStageStatus(
  state: RunStateSnapshot,
  stage: StageName,
  status: StageStatus,
  metadata?: { elapsedMs?: number; message?: string }
): RunStateSnapshot {
  state.stageStatus[stage] = {
    status,
    updatedAt: new Date().toISOString(),
    elapsedMs: metadata?.elapsedMs,
    message: metadata?.message,
  };
  state.updatedAt = new Date().toISOString();
  return state;
}
