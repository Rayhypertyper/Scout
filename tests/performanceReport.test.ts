import { describe, expect, it } from "vitest";

import { Profiler } from "../src/observability/profiler.js";
import { formatPerformanceReport, printPerformanceReport } from "../src/output/performance.js";

describe("performance report", () => {
  it("formats counters and latency aggregates concisely", () => {
    const profiler = new Profiler({ now: () => 0 });
    profiler.increment("httpRequests", 3);
    profiler.increment("unchangedSkips", 2);
    profiler.recordSpan("http_fetch", 12, { url: "https://example.test/jobs/1" });
    profiler.recordSpan("http_fetch", 20, { url: "https://example.test/jobs/2" });
    const output = formatPerformanceReport(profiler.snapshot(42));
    expect(output).toContain("PERFORMANCE");
    expect(output).toContain("Total runtime: 42 ms");
    expect(output).toContain("HTTP requests: 3");
    expect(output).toContain("example.test: 2 | 12.0 ms | 20.0 ms");
  });

  it("supports metrics nested on a legacy crawl result", () => {
    const output = formatPerformanceReport({ pagesVisited: 2, metrics: { totalRuntimeMs: 1_250, counters: { retries: 1 } } });
    expect(output).toContain("Total runtime: 1.3 s");
    expect(output).toContain("Retries: 1");
  });

  it("keeps a top-level runtime when counters are nested", () => {
    const output = formatPerformanceReport({ runtimeMs: 1_234, metrics: { counters: { httpRequests: 2 } } });
    expect(output).toContain("Total runtime: 1.2 s");
    expect(output).toContain("HTTP requests: 2");
  });

  it("does not alter output when metrics are absent", () => {
    expect(formatPerformanceReport({ pagesVisited: 2, jobs: [] })).toBe("");
    const lines: string[] = [];
    printPerformanceReport(undefined, (line) => { if (line) lines.push(line); });
    expect(lines).toEqual([]);
  });
});
