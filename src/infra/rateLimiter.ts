import { sleep } from "../utils";

export interface RateLimiterOptions {
  maxTokens: number;
  refillPerSecond: number;
}

export class TokenBucketRateLimiter {
  private tokens: number;
  private lastRefillMs: number;

  constructor(private readonly options: RateLimiterOptions) {
    this.tokens = options.maxTokens;
    this.lastRefillMs = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefillMs) / 1000;
    if (elapsedSeconds <= 0) return;

    this.tokens = Math.min(
      this.options.maxTokens,
      this.tokens + elapsedSeconds * this.options.refillPerSecond
    );
    this.lastRefillMs = now;
  }

  async waitForToken(): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }

      await sleep(100);
    }
  }

  async schedule<T>(operation: () => Promise<T>): Promise<T> {
    await this.waitForToken();
    return operation();
  }
}
