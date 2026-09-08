import { describe, expect, it } from "vitest";

import { summarizeSourceHealth, type SourceHealthOutcome } from "../src/observability/sourceHealth.js";

function outcome(overrides: Partial<SourceHealthOutcome> = {}): SourceHealthOutcome {
  return {
    runId: 1,
    sourceId: 1,
    startedAt: "2027-01-01T00:00:00.000Z",
    settledAt: "2027-01-01T00:00:01.000Z",
    completed: false,
    coverageComplete: false,
    status: "source_unavailable",
    httpStatus: null,
    durationMs: null,
    inventoryCount: 0,
    trustedInventory: false,
    suspiciousInventory: false,
    inventoryStatus: "incomplete",
    stale: false,
    healthExcluded: false,
    rateLimitCount: 0,
    browserFallbacks: 0,
    browserFallbackSuccesses: 0,
    lastError: null,
    ...overrides,
  };
}

describe("source health summaries", () => {
  it("anchors escalating cooldowns to settlement and ignores excluded skips", () => {
    const health = summarizeSourceHealth(
      "https://example.test/jobs",
      1,
      [
        outcome({ runId: 3, startedAt: "2027-01-01T00:02:00.000Z", settledAt: "2027-01-01T00:02:05.000Z" }),
        outcome({ runId: 2, startedAt: "2027-01-01T00:01:00.000Z", settledAt: "2027-01-01T00:01:05.000Z" }),
        outcome({ runId: 99, healthExcluded: true, settledAt: "2027-01-01T00:03:00.000Z" }),
      ],
      "2027-01-01T00:02:05.000Z",
      { cooldownFailureThreshold: 2, cooldownMs: 1_000, maxCooldownMs: 10_000 },
    );

    expect(health.attempts).toBe(2);
    expect(health.consecutiveFailures).toBe(2);
    expect(health.lastFailureAt).toBe("2027-01-01T00:02:05.000Z");
    expect(health.cooldownUntil).toBe("2027-01-01T00:02:06.000Z");
    expect(health.isCoolingDown).toBe(true);
  });

  it("reports age based staleness from the last trusted success", () => {
    const health = summarizeSourceHealth(
      "https://example.test/jobs",
      1,
      [outcome({
        runId: 1,
        completed: true,
        coverageComplete: true,
        status: "success",
        inventoryCount: 20,
        trustedInventory: true,
        inventoryStatus: "trusted",
        settledAt: "2027-01-01T00:00:01.000Z",
      })],
      "2027-01-03T00:00:00.000Z",
      { staleAfterMs: 24 * 60 * 60 * 1_000 },
    );

    expect(health.lastSuccessAt).toBe("2027-01-01T00:00:01.000Z");
    expect(health.trustedInventoryCount).toBe(20);
    expect(health.isStale).toBe(true);
  });

  it("does not double count an explicit rate-limit metric and HTTP 429", () => {
    const health = summarizeSourceHealth(
      "https://example.test/jobs",
      1,
      [outcome({ runId: 1, status: "rate_limited", httpStatus: 429, rateLimitCount: 1 })],
    );

    expect(health.rateLimitCount).toBe(1);
  });

  it("retains old trusted success and fallback timestamps outside the rate window", () => {
    const recentFailures = Array.from({ length: 30 }, (_, index) => outcome({ runId: 100 - index }));
    const health = summarizeSourceHealth(
      "https://example.test/jobs",
      1,
      [
        ...recentFailures,
        outcome({
          runId: 1,
          completed: true,
          coverageComplete: true,
          status: "success",
          inventoryCount: 100,
          trustedInventory: true,
          inventoryStatus: "trusted",
          browserFallbacks: 1,
          browserFallbackSuccesses: 1,
          settledAt: "2026-12-01T00:00:01.000Z",
        }),
      ],
      "2027-01-01T00:00:00.000Z",
    );

    expect(health.attempts).toBe(24);
    expect(health.lastSuccessAt).toBe("2026-12-01T00:00:01.000Z");
    expect(health.trustedInventoryCount).toBe(100);
    expect(health.lastBrowserFallbackAt).toBe("2026-12-01T00:00:01.000Z");
  });

  it("tracks consecutive ineffective browser fallbacks separately from HTTP outcomes", () => {
    const health = summarizeSourceHealth(
      "https://example.test/jobs",
      1,
      [
        outcome({ runId: 5, browserFallbacks: 1, browserFallbackSuccesses: 0 }),
        outcome({ runId: 4, browserFallbacks: 1, browserFallbackSuccesses: 0 }),
        outcome({ runId: 3, browserFallbacks: 0 }),
        outcome({ runId: 2, browserFallbacks: 1, browserFallbackSuccesses: 0 }),
        outcome({ runId: 1, browserFallbacks: 1, browserFallbackSuccesses: 1 }),
      ],
    );

    expect(health.consecutiveBrowserFallbackFailures).toBe(3);
  });
});
