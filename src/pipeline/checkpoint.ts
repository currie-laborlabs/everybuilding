import fs from "fs";
import path from "path";
import type { PipelineCheckpoint, StageName } from "../types";

export class CheckpointStore {
  private readonly resolvedPath: string;

  constructor(filePath: string) {
    this.resolvedPath = path.resolve(filePath);
    const dir = path.dirname(this.resolvedPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  load(): PipelineCheckpoint | null {
    if (!fs.existsSync(this.resolvedPath)) return null;
    const content = fs.readFileSync(this.resolvedPath, "utf-8");
    return JSON.parse(content) as PipelineCheckpoint;
  }

  save(runId: string, stage: StageName, index: number, total: number): PipelineCheckpoint {
    const checkpoint: PipelineCheckpoint = {
      runId,
      stage,
      index,
      total,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(this.resolvedPath, JSON.stringify(checkpoint, null, 2), "utf-8");
    return checkpoint;
  }

  clear(): void {
    if (fs.existsSync(this.resolvedPath)) {
      fs.unlinkSync(this.resolvedPath);
    }
  }

  getPath(): string {
    return this.resolvedPath;
  }
}
