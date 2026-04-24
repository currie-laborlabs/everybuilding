import { CircuitBreaker } from "../../infra/circuitBreaker";
import { TokenBucketRateLimiter } from "../../infra/rateLimiter";
import { withRetry } from "../../infra/retry";

export type VerificationStatus = "valid" | "invalid" | "risky" | "unknown" | "unverified";

export interface VerificationResult {
  status: VerificationStatus;
  subStatus: string;
}

export interface ZeroBounceClientConfig {
  apiKey?: string;
  baseUrl: string;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  ratePerSecond: number;
  circuitFailureThreshold: number;
  circuitResetTimeoutMs: number;
}

export class ZeroBounceClient {
  private readonly breaker: CircuitBreaker;
  private readonly limiter: TokenBucketRateLimiter;

  constructor(private readonly config: ZeroBounceClientConfig) {
    this.breaker = new CircuitBreaker({
      failureThreshold: config.circuitFailureThreshold,
      resetTimeoutMs: config.circuitResetTimeoutMs,
    });
    this.limiter = new TokenBucketRateLimiter({
      maxTokens: Math.max(config.ratePerSecond, 1),
      refillPerSecond: Math.max(config.ratePerSecond, 1),
    });
  }

  async verify(email: string): Promise<VerificationResult> {
    if (!email.trim()) {
      return { status: "unknown", subStatus: "empty_email" };
    }

    if (!this.config.apiKey) {
      return { status: "unverified", subStatus: "ZEROBOUNCE_API_KEY not configured" };
    }

    try {
      return await this.limiter.schedule(() =>
        this.breaker.execute(() =>
          withRetry(() => this.fetchVerification(email), {
            maxAttempts: this.config.maxAttempts,
            baseDelayMs: this.config.baseDelayMs,
            maxDelayMs: this.config.maxDelayMs,
          })
        )
      );
    } catch {
      return { status: "unknown", subStatus: "verification_error" };
    }
  }

  private async fetchVerification(email: string): Promise<VerificationResult> {
    const url = new URL(`${this.config.baseUrl}/validate`);
    url.searchParams.set("api_key", this.config.apiKey ?? "");
    url.searchParams.set("email", email.trim().toLowerCase());

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`ZeroBounce ${response.status} ${response.statusText}`);
    }

    const payload = (await response.json()) as {
      status?: string;
      sub_status?: string;
    };

    const status = (payload.status ?? "unknown").toLowerCase();
    if (
      status === "valid" ||
      status === "invalid" ||
      status === "risky" ||
      status === "unknown"
    ) {
      return { status, subStatus: payload.sub_status ?? "" };
    }

    return { status: "unknown", subStatus: payload.sub_status ?? status };
  }
}
