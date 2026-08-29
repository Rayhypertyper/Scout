import { describe, expect, it } from "vitest";

import { MetricsCollector, Profiler, mergeProfilerSnapshots, percentile } from "../src/observability/profiler.js";

describe("Profiler", () => {
  it("records deterministic spans, counters, and nearest-rank percentiles", () => {
    let now = 100;
    const profiler = new Profiler({ now: () => now });
    profiler.increment("urlsDiscovered", 2);
    profiler.increment("httpRequests");
    profiler.recordSpan("http_fetch", 10, { url: "https://Example.test/jobs/1", source: "source-a" });
    profiler.recordSpan("http_fetch", 20, { url: "https://example.test/jobs/2", source: "source-a" });
    profiler.recordSpan("http_fetch", 30, { url: "https://example.test/jobs/3", source: "source-a" });
    now = 200;
    const snapshot = profiler.finish();

    expect(snapshot.counters.urlsDiscovered).toBe(2);
    expect(snapshot.operations.http_fetch?.count).toBe(3);
    expect(snapshot.operations.http_fetch?.p50Ms).toBe(20);
    expect(snapshot.operations.http_fetch?.p95Ms).toBe(30);
    expect(snapshot.domains["example.test"]?.count).toBe(3);
    expect(snapshot.domains["example.test"]?.p50Ms).toBe(20);
    expect(snapshot.sources["source-a"]?.count).toBe(3);
    expect(snapshot.spansByUrl["https://Example.test/jobs/1"]?.length).toBe(1);
    expect(snapshot.totalRuntimeMs).toBe(100);
  });

  it("supports idempotent handles and error status", () => {
    let now = 0;
    const profiler = new MetricsCollector({ now: () => now });
    const span = profiler.start("parse", { url: "https://example.test/job" });
    now = 12;
    expect(span.end()?.durationMs).toBe(12);
    expect(span.end()).toBeUndefined();
    const failed = profiler.startSpan("database");
    now = 20;
    failed.end({ error: new Error("offline") });
    expect(profiler.snapshot().spans.find(({ operation }) => operation === "database")?.status).toBe("error");
  });

  it("bounds retained spans and aggregate samples", () => {
    const profiler = new Profiler({ maxSpans: 3, maxSamplesPerAggregate: 2, maxDomains: 2, now: () => 1 });
    for (let index = 0; index < 10; index += 1) {
      profiler.recordSpan("total", index + 1, { url: `https://domain-${index}.test/job` });
    }
    const snapshot = profiler.snapshot();
    expect(snapshot.spans).toHaveLength(3);
    expect(snapshot.droppedSpans).toBeGreaterThan(0);
    expect(Object.keys(snapshot.domains).length).toBeLessThanOrEqual(2);
    expect(snapshot.operations.total?.samplesRetained).toBe(2);
    expect(snapshot.operations.total?.sampled).toBe(true);
  });

  it("merges worker snapshots without double-counting", () => {
    const first = new Profiler({ now: () => 0 });
    first.recordSpan("parsing", 10);
    const second = new Profiler({ now: () => 0 });
    second.recordSpan("parsing", 30);
    const merged = mergeProfilerSnapshots([first.snapshot(), second.snapshot()]);
    expect(merged.operations.parsing?.count).toBe(2);
    expect(merged.operations.parsing?.sumMs).toBe(40);
    expect(merged.operations.parsing?.meanMs).toBe(20);
    expect(merged.spans).toHaveLength(2);
  });

  it("advances every slot when merging capped sample rings", () => {
    const first = new Profiler({ now: () => 0, maxSamplesPerAggregate: 2 });
    for (const duration of [1, 2, 3]) first.recordSpan("http_fetch", duration);
    const second = new Profiler({ now: () => 0, maxSamplesPerAggregate: 2 });
    for (const duration of [4, 5, 6]) second.recordSpan("http_fetch", duration);

    const merged = Profiler.merge([first.snapshot(), second.snapshot()], { maxSamplesPerAggregate: 2 });
    const aggregate = merged.operations.http_fetch;
    expect(aggregate?.count).toBe(6);
    expect(aggregate?.samples).toEqual([6, 5]);
    expect(aggregate?.samplesRetained).toBe(2);
    expect(aggregate?.p50Ms).toBe(5);
    expect(aggregate?.p95Ms).toBe(6);
  });

  it("handles empty percentile input", () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2);
    expect(percentile([1, 2, 3, 4], 0.95)).toBe(4);
  });

  it("applies sampleRate to aggregate reservoirs while retaining complete counts", () => {
    const profiler = new Profiler({ now: () => 0, sampleRate: 0 });
    profiler.recordSpan("http_fetch", 10);
    profiler.recordSpan("http_fetch", 20);
    const aggregate = profiler.snapshot().operations.http_fetch;
    expect(aggregate?.count).toBe(2);
    expect(aggregate?.samplesRetained).toBe(0);
    expect(aggregate?.p50Ms).toBeNull();
    expect(aggregate?.sampled).toBe(true);
  });
});
