import { describe, expect, it } from "vitest";

import { compareBenchmarks, formatBenchmarkComparison } from "../src/observability/benchmark.js";

describe("benchmark comparison", () => {
  it("computes signed deltas and explicit savings", () => {
    const comparison = compareBenchmarks(
      { totalRuntimeMs: 12_700, counters: { httpRequests: 20 } },
      { totalRuntimeMs: 10_000, counters: { httpRequests: 14 } },
    );
    expect(comparison.totalRuntime?.absoluteDelta).toBe(-2_700);
    expect(comparison.absoluteTimeSavedMs).toBe(2_700);
    expect(comparison.percentageTimeSaved).toBeCloseTo(21.2598, 3);
    expect(comparison.fields.httpRequests?.absoluteSavings).toBe(6);
    expect(comparison.fields.httpRequests?.percentageSavings).toBe(30);
  });

  it("handles a zero baseline deterministically", () => {
    const comparison = compareBenchmarks({ totalRuntimeMs: 0 }, { totalRuntimeMs: 10 });
    expect(comparison.percentageTimeSaved).toBeNull();
    expect(comparison.fields.totalRuntimeMs?.percentageSavings).toBeNull();
  });

  it("renders stable arithmetic without claiming a win", () => {
    const output = formatBenchmarkComparison(compareBenchmarks({ totalRuntimeMs: 100 }, { totalRuntimeMs: 90 }));
    expect(output).toContain("BENCHMARK COMPARISON");
    expect(output).toContain("totalRuntimeMs | 100 | 90 | -10 | 10 | 10.00%");
    expect(output).not.toContain("improvement");
  });
});

