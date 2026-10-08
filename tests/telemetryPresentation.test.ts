import { describe, expect, it, vi } from "vitest";

import {
  BENCHMARK_STABLE_FIELDS,
  compareBenchmarks,
} from "../src/observability/benchmark.js";
import {
  canonicalMetricKey,
  CRAWL_METRIC_KEYS,
  METRIC_REGISTRY,
  isKnownMetric,
  metricUnit,
  normalizeMetricKey,
} from "../src/observability/metrics.js";
import { Profiler } from "../src/observability/profiler.js";
import { Logger, redactDiagnostic, redactDiagnosticUrl } from "../src/utils/logger.js";

describe("telemetry presentation contracts", () => {
  it("normalizes stable metric aliases without changing their units", () => {
    expect(normalizeMetricKey("duplicate_listings_skipped")).toBe("duplicateListingsSkipped");
    expect(normalizeMetricKey("response_latency_ms")).toBe("responseLatencyMs");
    expect(canonicalMetricKey("roles_entered")).toBe("rolesEntered");
    expect(canonicalMetricKey("not_a_metric")).toBeNull();
    expect(isKnownMetric("roles_entered")).toBe(true);
    expect(METRIC_REGISTRY.responseLatencyMs?.unit).toBe("ms");
    expect(METRIC_REGISTRY.duplicateListingsSkipped?.unit).toBe("count");
    expect(CRAWL_METRIC_KEYS).toContain("canonicalRolesCreated");
  });

  it("registers every stable metric with a matching canonical unit", () => {
    expect(new Set(CRAWL_METRIC_KEYS).size).toBe(CRAWL_METRIC_KEYS.length);
    for (const key of CRAWL_METRIC_KEYS) {
      expect(isKnownMetric(key)).toBe(true);
      expect(METRIC_REGISTRY[key]?.unit).toBe(metricUnit(key));
      expect(METRIC_REGISTRY[key]?.description.length).toBeGreaterThan(0);
    }
  });

  it("keeps legacy profiler counters and exposes stable aliases", () => {
    const profiler = new Profiler({ now: () => 100 });
    profiler.increment("urlsDiscovered", 3);
    profiler.increment("detailPages", 2);
    profiler.increment("successfulJobs", 1);

    const snapshot = profiler.finish(150);
    expect(snapshot.counters.urlsDiscovered).toBe(3);
    expect(snapshot.counters.discovered).toBe(3);
    expect(snapshot.counters.detailFetched).toBe(2);
    expect(snapshot.counters.canonicalRolesCreated).toBe(1);
    expect(snapshot.counters.runtimeMs).toBe(50);
  });

  it("reads stable metrics in opt-in benchmark comparisons", () => {
    const comparison = compareBenchmarks(
      { metrics: { discovered: 10, responseLatencyMs: 100 } },
      { metrics: { discovered: 8, responseLatencyMs: 80 } },
      BENCHMARK_STABLE_FIELDS,
    );
    expect(comparison.fields.discovered?.absoluteDelta).toBe(-2);
    expect(comparison.fields.responseLatencyMs?.absoluteSavings).toBe(20);
  });

  it("emits bounded structured JSON with redacted URL and error material", () => {
    const lines: string[] = [];
    const logger = new Logger("debug", {
      now: () => "2026-08-31T00:00:00.000Z",
      sink: (line) => lines.push(line),
    });
    logger.event("warn", "source.failed", {
      runId: 12,
      sourceId: 4,
      sourceUrl: "https://example.test/jobs?token=do-not-log#fragment",
      timestamp: "caller cannot override timestamp",
      level: "error",
      event: "caller cannot override event",
      query: "private search terms",
      error: new Error("Bearer top-secret https://example.test/error?api_key=also-secret"),
      details: "x".repeat(2_000),
    });

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      timestamp: "2026-08-31T00:00:00.000Z",
      level: "warn",
      event: "source.failed",
      runId: 12,
      sourceId: 4,
      sourceUrl: "https://example.test/jobs",
      query: "[REDACTED]",
    });
    expect(lines[0]).not.toContain("do-not-log");
    expect(lines[0]).not.toContain("top-secret");
    expect(lines[0]).not.toContain("private search terms");
    expect(String(parsed.details)).toHaveLength(512);
  });

  it("redacts camelCase URL fields and keeps shared diagnostics usable", () => {
    const shared = { label: "same object" };
    const safe = redactDiagnostic({
      sourceUrl: "https://example.test/jobs?session=private",
      first: shared,
      second: shared,
    }) as Record<string, unknown>;
    expect(safe.sourceUrl).toBe("https://example.test/jobs");
    expect(safe.first).toEqual({ label: "same object" });
    expect(safe.second).toEqual({ label: "same object" });
    expect(redactDiagnosticUrl("https://user:pass@example.test/jobs?token=private#fragment"))
      .toBe("https://example.test/jobs");
    expect(redactDiagnosticUrl("https://%zz?access_token=private")).toBe("[Invalid URL]");
    const malformed = redactDiagnostic({ url: "https://%zz?access_token=private" }) as Record<string, unknown>;
    expect(malformed.url).toBe("[Invalid URL]");
    expect(JSON.stringify(malformed)).not.toContain("private");
  });

  it("redacts normalized credential field names and bounds diagnostic traversal", () => {
    const safe = redactDiagnostic({
      refreshToken: "refresh-value",
      clientSecret: "client-value",
      authToken: "auth-value",
      passwordHash: "password-value",
      supabaseKey: "supabase-value",
    }) as Record<string, unknown>;
    expect(Object.values(safe)).toEqual(Array(5).fill("[REDACTED]"));

    const secretText = `access_token=${"sensitive-value".repeat(10_000)}`;
    const boundedString = redactDiagnostic({ details: secretText }) as Record<string, unknown>;
    expect(boundedString.details).toBe("access_token=[REDACTED]");

    const deep: Record<string, unknown> = {};
    let cursor = deep;
    for (let index = 0; index < 20; index += 1) {
      const child: Record<string, unknown> = {};
      cursor.child = child;
      cursor = child;
    }
    const boundedTree = redactDiagnostic({ deep, values: Array.from({ length: 100 }, (_, index) => index) }) as Record<string, unknown>;
    const values = boundedTree.values as unknown[];
    expect(values.length).toBeLessThanOrEqual(33);
    expect(values.at(-1)).toBe("[Truncated]");

    const lines: string[] = [];
    new Logger("debug", { sink: (line) => lines.push(line) }).event("info", "large.event", {
      fields: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`field${index}`, "x".repeat(512)])),
      deep,
      secretText,
    });
    expect(lines[0]!.length).toBeLessThanOrEqual(8_192);
    expect(lines[0]).toContain('"diagnostics":"[Truncated]"');
    expect(lines[0]).not.toContain("sensitive-value");
  });

  it("routes structured and legacy warning/error output to their severity streams", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let warnLines: string[];
    let errorLines: string[];
    try {
      const logger = new Logger("debug");
      logger.event("warn", "source.failed", { sourceUrl: "https://example.test/jobs?token=private" });
      logger.event("error", "source.failed", { error: "password: private" });
      logger.warn("SOURCE", "https://example.test/jobs?query=private token=private");
      logger.error("SOURCE", "authorization: private");
    } finally {
      warnLines = warn.mock.calls.map(([line]) => String(line));
      errorLines = error.mock.calls.map(([line]) => String(line));
      warn.mockRestore();
      error.mockRestore();
    }
    expect(warnLines).toEqual(expect.arrayContaining([
      expect.stringContaining('"level":"warn"'),
      expect.stringMatching(/\[SOURCE\] \[[^\]]+\] https:\/\/example\.test\/jobs/),
    ]));
    expect(errorLines).toEqual(expect.arrayContaining([
      expect.stringContaining('"level":"error"'),
      expect.stringMatching(/\[SOURCE\] \[[^\]]+\] authorization: \[REDACTED\]/),
    ]));
    expect(warnLines.join(" ")).not.toContain("private");
    expect(errorLines.join(" ")).not.toContain("private");
  });
});
