import { sleep } from "../utils";

export type RetryDecision = "retry" | "fail";

export interface RetryContext {
  attempt: number;
  maxAttempts: number;
  error: unknown;
}

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (context: RetryContext) => RetryDecision;
}

export function defaultShouldRetry(context: RetryContext): RetryDecision {
  if (context.attempt >= context.maxAttempts) {
    return "fail";
  }

  if (context.error instanceof Error) {
    const message = context.error.message.toLowerCase();
    if (message.includes("401") || message.includes("403")) {
      return "fail";
    }
  }

  return "retry";
}

function computeBackoffMs(attempt: number, baseDelayMs: number, maxDelayMs: number): number {
  const next = baseDelayMs * 2 ** (attempt - 1);
  return Math.min(next, maxDelayMs);
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const maxDelayMs = options.maxDelayMs ?? 8000;
  const shouldRetry = options.shouldRetry ?? defaultShouldRetry;

  let attempt = 0;
  while (attempt < options.maxAttempts) {
    attempt += 1;

    try {
      return await operation();
    } catch (error) {
      const decision = shouldRetry({ attempt, maxAttempts: options.maxAttempts, error });
      if (decision === "fail" || attempt >= options.maxAttempts) {
        throw error;
      }

      const backoffMs = computeBackoffMs(attempt, baseDelayMs, maxDelayMs);
      await sleep(backoffMs);
    }
  }

  throw new Error("Retry loop exited unexpectedly.");
}
