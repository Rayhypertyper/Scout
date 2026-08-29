export const BENCHMARK_FIELDS = [
  "totalRuntimeMs",
  "urlsDiscovered",
  "urlsFetched",
  "httpRequests",
  "browserNavigations",
  "detailPagesFetched",
  "jobsDeeplyProcessed",
  "duplicateListingsSkipped",
  "unchangedJobsProcessed",
  "unchangedSkips",
  "failedSources",
  "retries",
] as const;

export type BenchmarkField = (typeof BENCHMARK_FIELDS)[number] | (string & {});

export type BenchmarkInput = Record<string, unknown> | null | undefined;

export interface BenchmarkValues {
  [field: string]: number;
}

export interface BenchmarkFieldComparison {
  before: number;
  after: number;
  /** Signed delta, after - before. Negative means the measured value fell. */
  absoluteDelta: number;
  /** Alias retained for consumers that call this a difference. */
  delta: number;
  /** before - after, useful for reporting savings without making a claim. */
  absoluteSavings: number;
  percentageChange: number | null;
  percentageSavings: number | null;
}

export interface BenchmarkComparison {
  before: BenchmarkValues;
  after: BenchmarkValues;
  fields: Record<string, BenchmarkFieldComparison>;
  totalRuntime: BenchmarkFieldComparison | null;
  absoluteTimeSavedMs: number | null;
  percentageTimeSaved: number | null;
  /** Explicit aliases for machine consumers. */
  absoluteSavingsMs: number | null;
  percentageSavings: number | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readField(input: BenchmarkInput, field: string): number {
  const record = asRecord(input);
  if (!record) return 0;
  const direct = finite(record[field]);
  if (direct !== null) return direct;
  const aliases: Record<string, string[]> = {
    totalRuntimeMs: ["durationMs", "runtimeMs", "total_runtime_ms"],
    urlsDiscovered: ["urls_discovered"],
    urlsFetched: ["urls_fetched"],
    httpRequests: ["http_requests"],
    browserNavigations: ["browser_navigations"],
    detailPagesFetched: ["detailPages", "detail_pages_fetched"],
    jobsDeeplyProcessed: ["successfulJobs", "jobs_deeply_processed", "jobsProcessed"],
    duplicateListingsSkipped: ["duplicates", "duplicatesSkipped", "duplicate_listings_skipped"],
    unchangedJobsProcessed: ["unchanged_jobs_processed", "unchangedProcessed"],
    unchangedSkips: ["unchanged_skipped", "unchanged_skips"],
    failedSources: ["failed_sources"],
    retries: ["retryCount", "retry_count"],
  };
  for (const alias of aliases[field] ?? []) {
    const value = finite(record[alias]);
    if (value !== null) return value;
  }
  const nestedKeys = ["counters", "metrics", "performance"];
  for (const key of nestedKeys) {
    const nested = asRecord(record[key]);
    if (!nested) continue;
    const value = readField(nested, field);
    if (value !== 0 || finite(nested[field]) !== null) return value;
  }
  return 0;
}

function compareField(before: number, after: number): BenchmarkFieldComparison {
  const absoluteDelta = after - before;
  const percentageChange = before === 0 ? null : (absoluteDelta / Math.abs(before)) * 100;
  return {
    before,
    after,
    absoluteDelta,
    delta: absoluteDelta,
    absoluteSavings: before - after,
    percentageChange,
    percentageSavings: percentageChange === null ? null : -percentageChange,
  };
}

/** Compare deterministic run inputs. This function reports arithmetic only. */
export function compareBenchmarks(beforeInput: BenchmarkInput, afterInput: BenchmarkInput, fields: readonly string[] = BENCHMARK_FIELDS): BenchmarkComparison {
  const before: BenchmarkValues = {};
  const after: BenchmarkValues = {};
  const comparisons: Record<string, BenchmarkFieldComparison> = {};
  for (const field of fields) {
    const beforeValue = readField(beforeInput, field);
    const afterValue = readField(afterInput, field);
    before[field] = beforeValue;
    after[field] = afterValue;
    comparisons[field] = compareField(beforeValue, afterValue);
  }
  const totalRuntime = comparisons.totalRuntimeMs ?? null;
  return {
    before,
    after,
    fields: comparisons,
    totalRuntime,
    absoluteTimeSavedMs: totalRuntime?.absoluteSavings ?? null,
    percentageTimeSaved: totalRuntime?.percentageSavings ?? null,
    absoluteSavingsMs: totalRuntime?.absoluteSavings ?? null,
    percentageSavings: totalRuntime?.percentageSavings ?? null,
  };
}

function value(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function percent(valueToFormat: number | null): string {
  return valueToFormat === null ? "n/a" : `${valueToFormat.toFixed(2)}%`;
}

/** Stable text output suitable for a local benchmark or CI artifact. */
export function formatBenchmarkComparison(comparison: BenchmarkComparison): string {
  const lines = [
    "BENCHMARK COMPARISON",
    "FIELD | BEFORE | AFTER | DELTA (AFTER-BEFORE) | SAVINGS (BEFORE-AFTER) | % SAVINGS",
  ];
  for (const field of Object.keys(comparison.fields).sort()) {
    const item = comparison.fields[field];
    if (!item) continue;
    lines.push(`${field} | ${value(item.before)} | ${value(item.after)} | ${value(item.absoluteDelta)} | ${value(item.absoluteSavings)} | ${percent(item.percentageSavings)}`);
  }
  return lines.join("\n");
}

export function benchmarkValues(input: BenchmarkInput, fields: readonly string[] = BENCHMARK_FIELDS): BenchmarkValues {
  return Object.fromEntries(fields.map((field) => [field, readField(input, field)]));
}
