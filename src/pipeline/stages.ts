import type { StageName } from "../types";
import type { Logger } from "../infra/observability";
import { withRetry } from "../infra/retry";

export interface StageExecutionOptions {
  retries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export async function executeStage<T>(
  stage: StageName,
  logger: Logger,
  options: StageExecutionOptions,
  operation: () => Promise<T>
): Promise<T> {
  const start = Date.now();
  logger.info("stage.start", { stage });

  const result = await withRetry(operation, {
    maxAttempts: options.retries,
    baseDelayMs: options.baseDelayMs,
    maxDelayMs: options.maxDelayMs,
  });

  logger.info("stage.complete", {
    stage,
    elapsedMs: Date.now() - start,
  });

  return result;
}
