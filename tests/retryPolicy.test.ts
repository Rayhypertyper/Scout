import { describe, expect, it } from "vitest";

import {
  decideRetry,
  isRetryableFailure,
  normalizeRetryFailure,
  parseRetryAfter,
  retryDelayMs,
} from "../src/crawler/retryPolicy.js";

describe("shared retry policy", () => {
  it("normalizes permanent HTTP statuses ahead of generic error labels", () => {
    expect(normalizeRetryFailure(new Error("bad request"), { errorType: "http_error", statusCode: 400 }).retryable).toBe(false);
    expect(normalizeRetryFailure(new Error("forbidden"), { errorType: "http_error", statusCode: 403 }).kind).toBe("access_denied");
    expect(normalizeRetryFailure(new Error("gone"), { errorType: "http_error", statusCode: 410 }).kind).toBe("gone");
    expect(isRetryableFailure({ errorType: "http_error", statusCode: 503 })).toBe(true);
    expect(isRetryableFailure({ errorType: "http_error", statusCode: 404 })).toBe(false);
  });

  it("rejects malformed, negative, and overflowing Retry-After values", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("-1")).toBeNull();
    expect(parseRetryAfter("1e999")).toBeNull();
    expect(parseRetryAfter("not-a-date")).toBeNull();
  });

  it("keeps normal jitter within the local cap while preserving a larger server delay", () => {
    expect(retryDelayMs(4, null, { baseDelayMs: 1_000, maxDelayMs: 5_000, jitterMs: 1_000, random: 1 })).toBe(5_000);
    expect(retryDelayMs(0, 2_000, { baseDelayMs: 1_000, maxDelayMs: 5_000, jitterMs: 500, random: 0 })).toBe(2_000);
    expect(retryDelayMs(0, 8_000, { baseDelayMs: 1_000, maxDelayMs: 5_000, jitterMs: 500, random: 1 })).toBe(8_000);
  });

  it("defers instead of retrying early when Retry-After exceeds the local budget", () => {
    const decision = decideRetry({
      attempt: 0,
      retryCount: 2,
      failure: { errorType: "http_error", statusCode: 503, retryAfterMs: 10_000 },
      baseDelayMs: 500,
      maxDelayMs: 5_000,
      random: 0,
    });
    expect(decision).toMatchObject({ retry: false, deferred: true, reason: "retry_after_exceeds_budget", delayMs: 10_000 });

    const budgeted = decideRetry({
      attempt: 0,
      retryCount: 2,
      failure: { errorType: "network_error" },
      baseDelayMs: 1_000,
      maxDelayMs: 5_000,
      random: 0,
      remainingBudgetMs: 500,
    });
    expect(budgeted).toMatchObject({ retry: false, deferred: true, reason: "retry_after_exceeds_budget" });
  });

  it("never retries cancellation or policy failures", () => {
    expect(decideRetry({
      attempt: 0,
      retryCount: 4,
      failure: { errorType: "cancelled" },
    })).toMatchObject({ retry: false, reason: "cancelled" });
    expect(decideRetry({
      attempt: 0,
      retryCount: 4,
      failure: { errorType: "robots_unavailable" },
    })).toMatchObject({ retry: false, reason: "permanent" });
  });
});
