import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { STATIC_CONFIGURED_SOURCES } from "../config/sourceCatalog.js";
import { RUNNING_SCAN_MAX_AGE_MS, activeRunMaxDurationMs } from "../config/runLock.js";
import { METRIC_REGISTRY, type CrawlMetricKey } from "./metrics.js";
import { safeCanonicalizeUrl } from "../utils/url.js";
import { sha256 } from "../utils/hash.js";

/** Versioned contract returned by the private operations endpoint. */
export const OPERATIONS_CONTRACT = "operations.v1" as const;
export const OPERATIONS_SCHEMA_VERSION = 1 as const;

export const OPERATIONS_ANOMALY_CODES = [
  "NO_DATA",
  "WARMUP",
  "STALE_DATABASE",
  "STALE_SOURCE",
  "REPEATED_FAILURES",
  "ZERO_YIELD",
  "LOW_YIELD",
  "RATE_LIMITED",
  "BROWSER_FALLBACK",
  "SLOW_SOURCE",
  "CLOSURE_SPIKE",
  "DEDUP_DRIFT",
  "DURATION_REGRESSION",
  "STUCK_RUN",
  "INVALID_TIMESTAMP",
] as const;

export type OperationsAnomalyCode = (typeof OPERATIONS_ANOMALY_CODES)[number];
export type OperationsSeverity = "info" | "warning" | "critical";
export type OperationsStatus = "healthy" | "degraded" | "unknown" | "unavailable";
export type OperationsDataState = "no_data" | "warmup" | "ready";
export type FreshnessState = "fresh" | "partial" | "stale" | "unknown";

/**
 * Operations keeps a snake_case wire shape, while the semantic definitions
 * come from the shared telemetry registry. This prevents units/descriptions
 * from drifting between producer, benchmark, and diagnostic consumers.
 */
const OPERATIONS_METRIC_KEYS = {
  crawl_duration_ms: "crawlDurationMs",
  source_duration_ms: "sourceDurationMs",
  sources_requested: "sourcesRequested",
  sources_settled: "sourcesSettled",
  sources_completed: "sourcesCompleted",
  roles_entered: "rolesEntered",
  roles_changed: "rolesChanged",
  roles_closed: "rolesClosed",
  roles_unchanged: "rolesUnchanged",
  roles_discovered: "rolesDiscovered",
  duplicate_listings_skipped: "duplicateListingsSkipped",
  detail_pages_fetched: "detailPagesFetched",
  http_requests: "httpRequests",
  browser_navigations: "browserNavigations",
  rate_limited_responses: "rateLimitedResponses",
  stale_responses: "staleResponses",
} as const satisfies Record<string, CrawlMetricKey>;

export const OPERATIONS_METRIC_REGISTRY = Object.freeze(
  Object.fromEntries(Object.entries(OPERATIONS_METRIC_KEYS).map(([wireName, canonicalName]) => [
    wireName,
    METRIC_REGISTRY[canonicalName],
  ])) as Record<keyof typeof OPERATIONS_METRIC_KEYS, (typeof METRIC_REGISTRY)[CrawlMetricKey]>,
);

export type OperationsMetricName = keyof typeof OPERATIONS_METRIC_REGISTRY;

export interface OperationsThresholds {
  staleAfterMs: number;
  repeatedFailureCount: number;
  minimumBaselineSamples: number;
  lowYieldRatio: number;
  minimumYieldBaseline: number;
  slowSourceMultiplier: number;
  slowSourceAbsoluteMs: number;
  closureSpikeMultiplier: number;
  closureSpikeAbsolute: number;
  dedupDriftDelta: number;
  dedupDriftMultiplier: number;
  durationRegressionMultiplier: number;
  /** Independent floor for a duration regression; the stuck-run budget is not a regression threshold. */
  durationRegressionAbsoluteMs: number;
  stuckRunAgeMs: number;
  stuckRunDurationMs: number;
}

export const DEFAULT_OPERATIONS_THRESHOLDS: Readonly<OperationsThresholds> = Object.freeze({
  staleAfterMs: 24 * 60 * 60 * 1_000,
  repeatedFailureCount: 3,
  minimumBaselineSamples: 3,
  lowYieldRatio: 0.25,
  minimumYieldBaseline: 1,
  slowSourceMultiplier: 2,
  slowSourceAbsoluteMs: 5 * 60 * 1_000,
  closureSpikeMultiplier: 3,
  closureSpikeAbsolute: 5,
  dedupDriftDelta: 0.2,
  dedupDriftMultiplier: 2,
  durationRegressionMultiplier: 2,
  durationRegressionAbsoluteMs: 5 * 60 * 1_000,
  stuckRunAgeMs: RUNNING_SCAN_MAX_AGE_MS,
  stuckRunDurationMs: activeRunMaxDurationMs(),
});

export interface OperationsReadOptions {
  /** Injectable clock for deterministic diagnostics and freshness tests. */
  now?: Date | string | number;
  runLimit?: number;
  sourceLimit?: number;
  sourceHistoryLimit?: number;
  /** Optional explicit configured set for isolated diagnostic fixtures. */
  configuredSourceUrls?: readonly string[];
  thresholds?: Partial<OperationsThresholds>;
}

export interface OperationsTimestamp {
  value: string | null;
  valid: boolean;
}

export interface OperationsFreshness {
  state: FreshnessState;
  /** Latest trusted source success, or the full crawl completion time. */
  lastSuccessfulCrawlAt: string | null;
  /** Age of the timestamp above. Future and malformed timestamps are unknown. */
  ageMs: number | null;
  expectedSources: number;
  trustedSources: number;
  staleSources: number;
  latestTrustedRunId: number | null;
  fullCoverage: boolean;
}

/** Deliberately small public projection. It contains no source IDs, URLs, or diagnostics. */
export interface PublicFreshness {
  state: FreshnessState;
  lastSuccessfulCrawlAt: string | null;
  ageMs: number | null;
  expectedSources: number;
  trustedSources: number;
  staleSources: number;
}

export interface OperationsAnomaly {
  code: OperationsAnomalyCode;
  severity: OperationsSeverity;
  scope: "database" | "run" | "source";
  runId: number | null;
  sourceId: number | null;
  sourceUrl: string | null;
  observed: number | string | null;
  baseline: number | string | null;
  threshold: number | string | null;
  unit: string;
  explanation: string;
  detectedAt: string;
}

export interface OperationsRunSummary {
  id: number;
  status: string;
  startedAt: string | null;
  heartbeatAt: string | null;
  finishedAt: string | null;
  cancelRequestedAt: string | null;
  durationMs: number | null;
  heartbeatAgeMs: number | null;
  sourcesRequested: number;
  sourcesSettled: number;
  sourcesCompleted: number;
  pagesVisited: number;
  potentialPostingsInspected: number;
  rolesDiscovered: number;
  rolesEntered: number;
  rolesChanged: number;
  rolesUnchanged: number;
  rolesClosed: number;
  duplicateListingsSkipped: number;
  detailPagesFetched: number;
  httpRequests: number;
  browserNavigations: number;
  retryableFailures: number;
  edition: "personal" | "public" | "unknown";
  sourceSetKey: string | null;
  comparable: boolean;
  error: string | null;
}

export interface OperationsSourceLatest {
  runId: number;
  status: string | null;
  completed: boolean;
  coverageComplete: boolean;
  stale: boolean;
  healthExcluded: boolean;
  settledAt: string | null;
  startedAt: string | null;
  durationMs: number | null;
  responseLatencyMs: number | null;
  inventoryCount: number | null;
  trustedInventory: boolean;
  suspiciousInventory: boolean;
  rateLimitCount: number;
  browserFallbacks: number;
  browserFallbackSuccesses: number;
  failureCount: number;
  httpStatus: number | null;
  error: string | null;
}

export interface OperationsSourceSummary {
  sourceId: number;
  url: string;
  configured: boolean;
  attempts: number;
  successes: number;
  failures: number;
  successRate: number | null;
  consecutiveFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  ageMs: number | null;
  stale: boolean;
  partialCount: number;
  partialRate: number | null;
  zeroYieldCount: number;
  yield: {
    observed: number | null;
    baseline: number | null;
    ratio: number | null;
    samples: number;
  };
  duration: {
    observedMs: number | null;
    baselineMs: number | null;
    samples: number;
  };
  latency: {
    observedMs: number | null;
    baselineMs: number | null;
    samples: number;
  };
  rateLimitCount: number;
  browserFallbacks: number;
  browserFallbackSuccesses: number;
  latest: OperationsSourceLatest | null;
  adapter: string | null;
  requiresJs: boolean;
  lastError: string | null;
  /** Number of settled source outcomes represented by this summary. */
  windowSize: number;
}

export interface OperationsMetricsSnapshot {
  latestRun: Record<OperationsMetricName, number | null> | null;
  durationTrend: "up" | "down" | "flat" | "unknown";
  durationBaselineMs: number | null;
  durationSamples: number;
}

export interface OperationsSnapshot {
  contract: typeof OPERATIONS_CONTRACT;
  schemaVersion: typeof OPERATIONS_SCHEMA_VERSION;
  metricRegistry: typeof OPERATIONS_METRIC_REGISTRY;
  generatedAt: string;
  status: OperationsStatus;
  dataState: OperationsDataState;
  database: {
    available: boolean;
    schemaReady: boolean;
  };
  freshness: OperationsFreshness;
  activeRun: OperationsRunSummary | null;
  latestRun: OperationsRunSummary | null;
  runs: OperationsRunSummary[];
  sources: OperationsSourceSummary[];
  anomalies: OperationsAnomaly[];
  metrics: OperationsMetricsSnapshot;
  failureSummary: Array<{
    errorType: string;
    statusCode: number | null;
    count: number;
    message: string | null;
  }>;
}

interface RawRun {
  id: number;
  started_at: string | null;
  heartbeat_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  status: string;
  sources_requested: number;
  sources_settled: number;
  sources_completed: number;
  pages_visited: number;
  potential_postings_inspected: number;
  internships_discovered: number;
  new_count: number;
  updated_count: number;
  unchanged_count: number;
  closed_count: number;
  cache_hits: number;
  unchanged_skips: number;
  new_listings: number;
  changed_listings: number;
  retryable_failures: number;
  detail_pages_fetched: number;
  duplicate_listings_skipped: number;
  irrelevant_listings_skipped: number;
  http_requests: number;
  browser_navigations: number;
  error_message: string | null;
  options_json: string | null;
}

interface RawSource {
  id: number;
  url: string;
  is_configured: number;
  adapter: string | null;
  requires_js: number;
  strategy_last_error: string | null;
}

interface RawSourceResult {
  run_id: number;
  source_id: number;
  settled: number;
  completed: number;
  coverage_complete: number;
  stale: number;
  health_excluded: number;
  started_at: string | null;
  settled_at: string | null;
  duration_ms: number | null;
  response_latency_ms: number | null;
  inventory_count: number | null;
  trusted_inventory: number;
  suspicious_inventory: number;
  rate_limit_count: number;
  browser_fallbacks: number;
  browser_fallback_successes: number;
  failure_count: number;
  status: string | null;
  http_status: number | null;
  last_error: string | null;
  edition: "personal" | "public" | "unknown";
  source_set_key: string | null;
}

interface SourceHistory {
  source: RawSource;
  results: RawSourceResult[];
  latestTrustedAt: string | null;
}

interface SchemaInfo {
  tables: Set<string>;
  columns: Map<string, Set<string>>;
}

function finiteNumber(value: unknown, fallback = 0): number {
  if (typeof value === "bigint") value = Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function nonNegative(value: unknown): number {
  return Math.max(0, finiteNumber(value));
}

function integer(value: unknown): number {
  return Math.max(0, Math.floor(nonNegative(value)));
}

function clampLimit(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.min(maximum, Math.floor(value)));
}

function nowDate(value: OperationsReadOptions["now"]): Date {
  const candidate = value instanceof Date
    ? value
    : typeof value === "number"
      ? new Date(value)
      : value
        ? new Date(value)
        : new Date();
  return Number.isFinite(candidate.getTime()) ? candidate : new Date();
}

function timestamp(value: unknown, nowMs: number): OperationsTimestamp {
  if (typeof value !== "string" || !value.trim()) return { value: null, valid: false };
  const parsed = Date.parse(value);
  // Future timestamps are unsafe for freshness and duration calculations. Keep
  // the invalid marker in the private diagnostics rather than echoing them.
  if (!Number.isFinite(parsed) || parsed > nowMs) return { value: null, valid: false };
  return { value: new Date(parsed).toISOString(), valid: true };
}

function ageMs(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed > nowMs) return null;
  return Math.max(0, nowMs - parsed);
}

function replaceControlCharacters(value: string): string {
  return Array.from(value, (character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? " " : character;
  }).join("");
}

function sanitiseDiagnostic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let message = replaceControlCharacters(value)
    .replace(/(?:bearer|authorization|cookie|set-cookie|token|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s)]+/gi, "[url]")
    .replace(/file:\/\/[^\s)]+/gi, "[path]")
    .replace(/(?:\/Users\/|\/home\/|[A-Z]:\\)[^\s)]+/g, "[path]")
    .replace(/\s+/g, " ")
    .trim();
  if (!message) return null;
  if (message.length > 240) message = `${message.slice(0, 237)}...`;
  return message;
}

function tableInfo(database: DatabaseSync): SchemaInfo {
  const tables = new Set<string>();
  const columns = new Map<string, Set<string>>();
  const tableRows = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as unknown as Array<{ name: string }>;
  for (const row of tableRows) {
    if (!row.name) continue;
    tables.add(row.name);
    const columnRows = database.prepare(`PRAGMA table_info(${row.name.replace(/[^a-zA-Z0-9_]/g, "")})`).all() as unknown as Array<{ name: string }>;
    columns.set(row.name, new Set(columnRows.map((column) => column.name)));
  }
  return { tables, columns };
}

function hasColumn(schema: SchemaInfo, table: string, column: string): boolean {
  return schema.columns.get(table)?.has(column) ?? false;
}

const REQUIRED_HEALTH_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["crawl_runs", "id"], ["crawl_runs", "started_at"], ["crawl_runs", "status"], ["crawl_runs", "options_json"],
  ["source_run_results", "run_id"], ["source_run_results", "source_id"], ["source_run_results", "settled"],
  ["source_run_results", "completed"], ["source_run_results", "coverage_complete"],
  ["source_run_results", "trusted_inventory"], ["source_run_results", "settled_at"],
];

function operationsSchemaReady(schema: SchemaInfo): boolean {
  return REQUIRED_HEALTH_COLUMNS.every(([table, column]) => hasColumn(schema, table, column));
}

function columnExpression(schema: SchemaInfo, table: string, column: string, alias = column): string {
  return hasColumn(schema, table, column) ? `${column} AS ${alias}` : `NULL AS ${alias}`;
}

function integerExpression(schema: SchemaInfo, table: string, column: string, alias = column): string {
  return hasColumn(schema, table, column) ? `COALESCE(${column}, 0) AS ${alias}` : `0 AS ${alias}`;
}

function rawNowIso(nowMs: number): string {
  return new Date(nowMs).toISOString();
}

function parseRunOptions(optionsJson: string | null): { edition: "personal" | "public" | "unknown"; sourceSetKey: string | null } {
  if (!optionsJson) return { edition: "unknown", sourceSetKey: null };
  try {
    const parsed = JSON.parse(optionsJson) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { edition: "unknown", sourceSetKey: null };
    const record = parsed as Record<string, unknown>;
    const settings = record.settings && typeof record.settings === "object" && !Array.isArray(record.settings)
      ? record.settings as Record<string, unknown>
      : null;
    const candidate = record.edition ?? settings?.edition;
    const edition = candidate === "personal" || candidate === "public" ? candidate : "unknown";
    const rawSources = Array.isArray(record.sources)
      ? record.sources
      : settings && Array.isArray(settings.sources)
        ? settings.sources
        : [];
    const sources = rawSources
      .filter((value): value is string => typeof value === "string")
      .flatMap((value) => {
        const canonical = safeCanonicalizeUrl(value);
        return canonical ? [canonical] : [];
      })
      .toSorted();
    return {
      edition,
      sourceSetKey: sources.length > 0 ? sha256(JSON.stringify([...new Set(sources)])).slice(0, 16) : null,
    };
  } catch {
    return { edition: "unknown", sourceSetKey: null };
  }
}

function resultTrusted(result: RawSourceResult): boolean {
  return result.settled === 1
    && result.completed === 1
    && result.coverage_complete === 1
    && result.stale === 0
    && result.health_excluded === 0
    && result.trusted_inventory === 1;
}

function resultComparable(result: RawSourceResult): boolean {
  return resultTrusted(result) && result.edition !== "unknown" && result.source_set_key !== null;
}

function dedupeRateLimitCount(result: RawSourceResult): number {
  // A terminal status/HTTP 429 is one event. Do not add it to an explicit
  // counter when the producer already counted that same response.
  return Math.max(0, integer(result.rate_limit_count), result.status === "rate_limited" || result.http_status === 429 ? 1 : 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] ?? null : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

function average(values: number[]): number | null {
  return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function runDuration(run: RawRun, nowMs: number): number | null {
  const started = run.started_at ? Date.parse(run.started_at) : Number.NaN;
  if (!Number.isFinite(started) || started > nowMs) return null;
  const end = run.finished_at ? Date.parse(run.finished_at) : run.status === "RUNNING" ? nowMs : Number.NaN;
  if (!Number.isFinite(end) || end < started) return null;
  return Math.max(0, end - started);
}

function runSummary(run: RawRun, nowMs: number, comparable: boolean): OperationsRunSummary {
  const startedAt = timestamp(run.started_at, nowMs).value;
  const heartbeatAt = timestamp(run.heartbeat_at, nowMs).value;
  const finishedAt = timestamp(run.finished_at, nowMs).value;
  const cancelRequestedAt = timestamp(run.cancel_requested_at, nowMs).value;
  const options = parseRunOptions(run.options_json);
  return {
    id: integer(run.id),
    status: run.status,
    startedAt,
    heartbeatAt,
    finishedAt,
    cancelRequestedAt,
    durationMs: runDuration(run, nowMs),
    heartbeatAgeMs: ageMs(heartbeatAt ?? startedAt, nowMs),
    sourcesRequested: integer(run.sources_requested),
    sourcesSettled: integer(run.sources_settled),
    sourcesCompleted: integer(run.sources_completed),
    pagesVisited: integer(run.pages_visited),
    potentialPostingsInspected: integer(run.potential_postings_inspected),
    rolesDiscovered: integer(run.internships_discovered),
    rolesEntered: integer(run.new_count),
    rolesChanged: integer(run.updated_count),
    rolesUnchanged: integer(run.unchanged_count),
    rolesClosed: integer(run.closed_count),
    duplicateListingsSkipped: integer(run.duplicate_listings_skipped),
    detailPagesFetched: integer(run.detail_pages_fetched),
    httpRequests: integer(run.http_requests),
    browserNavigations: integer(run.browser_navigations),
    retryableFailures: integer(run.retryable_failures),
    edition: options.edition,
    sourceSetKey: options.sourceSetKey,
    comparable,
    error: sanitiseDiagnostic(run.error_message),
  };
}

function makeAnomaly(
  code: OperationsAnomalyCode,
  severity: OperationsSeverity,
  scope: OperationsAnomaly["scope"],
  nowMs: number,
  details: Omit<OperationsAnomaly, "code" | "severity" | "scope" | "detectedAt">,
): OperationsAnomaly {
  return { code, severity, scope, detectedAt: rawNowIso(nowMs), ...details };
}

function sourceFreshness(history: SourceHistory, nowMs: number, thresholds: OperationsThresholds): {
  lastSuccessAt: string | null;
  stale: boolean;
  age: number | null;
} {
  const latestSuccess = timestamp(history.latestTrustedAt, nowMs).value;
  const age = ageMs(latestSuccess, nowMs);
  const latestAttemptAt = history.results
    .filter((result) => result.settled === 1)
    .map((result) => timestamp(result.settled_at ?? result.started_at, nowMs).value)
    .filter((value): value is string => value !== null)
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const attemptAge = ageMs(latestAttemptAt, nowMs);
  const hasAttempt = latestAttemptAt !== null;
  return {
    lastSuccessAt: latestSuccess,
    // A run that failed a few minutes ago is an active failure, not a stale
    // database. With no success timestamp, staleness starts only after the
    // latest attempted source check itself is beyond the freshness window.
    stale: hasAttempt && ((latestSuccess !== null && age !== null && age > thresholds.staleAfterMs)
      || (latestSuccess === null && attemptAge !== null && attemptAge > thresholds.staleAfterMs)),
    age,
  };
}

function configuredSourceUrls(databaseSources: RawSource[], explicit: readonly string[] | undefined): Set<string> {
  const configured = new Set<string>();
  const staticSources = explicit ?? STATIC_CONFIGURED_SOURCES;
  for (const source of staticSources) {
    const canonical = safeCanonicalizeUrl(source);
    if (canonical) configured.add(canonical);
  }
  for (const source of databaseSources) {
    if (source.is_configured !== 1) continue;
    const canonical = safeCanonicalizeUrl(source.url);
    if (canonical) configured.add(canonical);
  }
  return configured;
}

function freshAggregate(
  runs: RawRun[],
  histories: SourceHistory[],
  configuredUrls: Set<string>,
  nowMs: number,
  thresholds: OperationsThresholds,
): OperationsFreshness {
  const expectedSources = configuredUrls.size;
  const sourceByUrl = new Map(histories.map((history) => [safeCanonicalizeUrl(history.source.url) ?? history.source.url, history]));
  const trustedAtBySource = new Map<string, string>();
  let staleSources = 0;
  let trustedSources = 0;
  for (const url of configuredUrls) {
    const history = sourceByUrl.get(url);
    const freshness = history ? sourceFreshness(history, nowMs, thresholds) : { lastSuccessAt: null, stale: false, age: null };
    if (freshness.stale) staleSources += 1;
    if (freshness.lastSuccessAt) {
      trustedSources += 1;
      trustedAtBySource.set(url, freshness.lastSuccessAt);
    }
  }

  // A full run is the only state that can be called fresh. Partial source
  // success remains visible as partial, even when its one source is recent.
  const runCandidates = runs.filter((run) => run.status === "COMPLETED"
    && !run.cancel_requested_at
    && run.sources_requested > 0
    && run.sources_settled >= run.sources_requested
    && run.sources_completed >= run.sources_requested);
  let latestTrustedRun: RawRun | null = null;
  if (expectedSources > 0) {
    for (const run of runCandidates) {
      const sourceResults = histories.flatMap((history) => history.results.filter((result) => result.run_id === run.id && result.source_set_key === parseRunOptions(run.options_json).sourceSetKey));
      const trustedUrls = new Set(sourceResults.filter(resultTrusted).map((result) => safeCanonicalizeUrl(histories.find((history) => history.source.id === result.source_id)?.source.url ?? "")));
      if (trustedUrls.size >= expectedSources && [...configuredUrls].every((url) => trustedUrls.has(url))) {
        latestTrustedRun = run;
        break;
      }
    }
  }

  const sourceTimes = [...trustedAtBySource.values()].filter((value) => timestamp(value, nowMs).valid);
  const latestSourceAt = sourceTimes.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const fullRunAt = latestTrustedRun
    ? timestamp(latestTrustedRun.finished_at ?? latestTrustedRun.started_at, nowMs).value
    : null;
  const lastSuccessfulCrawlAt = fullRunAt ?? latestSourceAt;
  const age = ageMs(lastSuccessfulCrawlAt, nowMs);
  const fullCoverage = latestTrustedRun !== null;
  let state: FreshnessState = "unknown";
  if (lastSuccessfulCrawlAt && age !== null && age > thresholds.staleAfterMs) state = "stale";
  else if (fullCoverage && trustedSources >= expectedSources) state = "fresh";
  else if (trustedSources > 0) state = "partial";
  return {
    state,
    lastSuccessfulCrawlAt,
    ageMs: age,
    expectedSources,
    trustedSources,
    staleSources,
    latestTrustedRunId: latestTrustedRun?.id ?? null,
    fullCoverage,
  };
}

function unavailablePublicFreshness(): PublicFreshness {
  return {
    state: "unknown",
    lastSuccessfulCrawlAt: null,
    ageMs: null,
    expectedSources: 0,
    trustedSources: 0,
    staleSources: 0,
  };
}

function namedParameters(prefix: string, values: readonly (string | number)[]): Record<string, string | number> {
  return Object.fromEntries(values.map((value, index) => [`${prefix}${index}`, value]));
}

function namedPlaceholders(prefix: string, values: readonly unknown[]): string {
  return values.map((_, index) => `@${prefix}${index}`).join(", ");
}

/**
 * Read only the aggregate fields needed by ordinary dashboard polling.
 * Keeping this path separate from the anomaly builder avoids parsing source
 * histories, failures, or role data on every /api/status request.
 */
function readCheapPublicFreshness(
  database: DatabaseSync,
  options: OperationsReadOptions,
  nowMs: number,
): PublicFreshness {
  const schema = tableInfo(database);
  if (!schema.tables.has("crawl_runs") || !schema.tables.has("sources") || !schema.tables.has("source_run_results")) {
    return unavailablePublicFreshness();
  }
  const schemaReady = operationsSchemaReady(schema);
  if (!schemaReady) return unavailablePublicFreshness();

  const staticSources = options.configuredSourceUrls ?? STATIC_CONFIGURED_SOURCES;
  const configuredUrls = new Set<string>();
  for (const source of staticSources) {
    const canonical = safeCanonicalizeUrl(source);
    if (canonical) configuredUrls.add(canonical);
  }
  // Keep the static catalog and explicitly configured database rows together;
  // arbitrary historical rows remain excluded from the public coverage set.
  const sourceUrlList = [...configuredUrls];
  const sourceRows = database.prepare(`
    SELECT id, url
    FROM sources
    WHERE ${sourceUrlList.length > 0 ? `url IN (${namedPlaceholders("url", sourceUrlList)})` : "0 = 1"}
      ${hasColumn(schema, "sources", "is_configured") ? "OR is_configured = 1" : ""}
    LIMIT 1000
  `).all(namedParameters("url", sourceUrlList)) as unknown as Array<{ id: number | bigint; url: string } & { is_configured?: number }>;
  for (const row of sourceRows) {
    if (!hasColumn(schema, "sources", "is_configured")) continue;
    // The query includes configured rows so they can extend the static
    // catalog; a malformed URL cannot become a public identity.
    const canonical = typeof row.url === "string" ? safeCanonicalizeUrl(row.url) : null;
    if (canonical) configuredUrls.add(canonical);
  }

  const sourceIdByUrl = new Map<string, number>();
  for (const row of sourceRows) {
    const canonical = typeof row.url === "string" ? safeCanonicalizeUrl(row.url) : null;
    if (canonical && configuredUrls.has(canonical)) sourceIdByUrl.set(canonical, integer(row.id));
  }
  const expectedSourceIds = [...new Set(sourceIdByUrl.values())].filter((id) => id > 0);
  const expectedSources = configuredUrls.size;
  const resultStartedAt = hasColumn(schema, "source_run_results", "started_at") ? "sr.started_at" : "NULL";
  const resultTimestamp = `COALESCE(sr.settled_at, ${resultStartedAt})`;
  const trustedBySource = new Map<number, string | null>();
  const attemptsBySource = new Map<number, string | null>();
  if (expectedSourceIds.length > 0) {
    const sourceParams = namedParameters("source", expectedSourceIds);
    const sourceFilter = namedPlaceholders("source", expectedSourceIds);
    const trustedRows = database.prepare(`
      SELECT sr.source_id, MAX(${resultTimestamp}) AS latest_at
      FROM source_run_results sr
      WHERE sr.settled = 1
        AND sr.completed = 1
        AND sr.coverage_complete = 1
        AND sr.stale = 0
        AND sr.health_excluded = 0
        AND sr.trusted_inventory = 1
        AND sr.source_id IN (${sourceFilter})
      GROUP BY sr.source_id
    `).all(sourceParams) as unknown as Array<{ source_id: number | bigint; latest_at: string | null }>;
    for (const row of trustedRows) trustedBySource.set(integer(row.source_id), row.latest_at);

    const attemptRows = database.prepare(`
      SELECT sr.source_id, MAX(${resultTimestamp}) AS latest_at
      FROM source_run_results sr
      WHERE sr.settled = 1
        AND sr.source_id IN (${sourceFilter})
      GROUP BY sr.source_id
    `).all(sourceParams) as unknown as Array<{ source_id: number | bigint; latest_at: string | null }>;
    for (const row of attemptRows) attemptsBySource.set(integer(row.source_id), row.latest_at);
  }

  let trustedSources = 0;
  let staleSources = 0;
  const trustedTimes: string[] = [];
  for (const url of configuredUrls) {
    const sourceId = sourceIdByUrl.get(url);
    const trustedAt = sourceId === undefined ? null : timestamp(trustedBySource.get(sourceId) ?? null, nowMs).value;
    const attemptAt = sourceId === undefined ? null : timestamp(attemptsBySource.get(sourceId) ?? null, nowMs).value;
    if (trustedAt !== null) {
      trustedSources += 1;
      trustedTimes.push(trustedAt);
      const sourceAge = ageMs(trustedAt, nowMs);
      if (sourceAge !== null && sourceAge > (options.thresholds?.staleAfterMs ?? DEFAULT_OPERATIONS_THRESHOLDS.staleAfterMs)) staleSources += 1;
    } else if (attemptAt !== null) {
      const attemptAge = ageMs(attemptAt, nowMs);
      if (attemptAge !== null && attemptAge > (options.thresholds?.staleAfterMs ?? DEFAULT_OPERATIONS_THRESHOLDS.staleAfterMs)) staleSources += 1;
    }
  }

  const hasRun = database.prepare("SELECT id FROM crawl_runs ORDER BY id DESC LIMIT 1").get() !== undefined;
  const hasResult = database.prepare("SELECT 1 AS present FROM source_run_results LIMIT 1").get() !== undefined;
  const runSourcesRequested = hasColumn(schema, "crawl_runs", "sources_requested") ? "COALESCE(cr.sources_requested, 0)" : "0";
  const runSourcesSettled = hasColumn(schema, "crawl_runs", "sources_settled") ? "COALESCE(cr.sources_settled, 0)" : "0";
  const runSourcesCompleted = hasColumn(schema, "crawl_runs", "sources_completed") ? "COALESCE(cr.sources_completed, 0)" : "0";
  const runFinishedAt = hasColumn(schema, "crawl_runs", "finished_at") ? "cr.finished_at" : "NULL";
  const runCancelPredicate = hasColumn(schema, "crawl_runs", "cancel_requested_at") ? "cr.cancel_requested_at IS NULL" : "1 = 1";
  let fullRunAt: string | null = null;
  if (expectedSourceIds.length > 0) {
    const sourceParams = namedParameters("fullSource", expectedSourceIds);
    const sourceFilter = namedPlaceholders("fullSource", expectedSourceIds);
    const fullRun = database.prepare(`
      SELECT cr.id, COALESCE(${runFinishedAt}, cr.started_at) AS completed_at
      FROM crawl_runs cr
      WHERE cr.status = 'COMPLETED'
        AND ${runCancelPredicate}
        AND ${runSourcesRequested} > 0
        AND ${runSourcesSettled} >= ${runSourcesRequested}
        AND ${runSourcesCompleted} >= ${runSourcesRequested}
        AND (
          SELECT COUNT(DISTINCT sr.source_id)
          FROM source_run_results sr
          WHERE sr.run_id = cr.id
            AND sr.settled = 1
            AND sr.completed = 1
            AND sr.coverage_complete = 1
            AND sr.stale = 0
            AND sr.health_excluded = 0
            AND sr.trusted_inventory = 1
            AND sr.source_id IN (${sourceFilter})
        ) >= @expectedSources
      ORDER BY cr.id DESC
      LIMIT 1
    `).get({ ...sourceParams, expectedSources }) as unknown as { id: number | bigint; completed_at: string | null } | undefined;
    fullRunAt = timestamp(fullRun?.completed_at ?? null, nowMs).value;
  }
  const sourceLatestAt = trustedTimes.sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
  const lastSuccessfulCrawlAt = fullRunAt ?? sourceLatestAt;
  const freshnessAge = ageMs(lastSuccessfulCrawlAt, nowMs);
  const staleAfterMs = options.thresholds?.staleAfterMs ?? DEFAULT_OPERATIONS_THRESHOLDS.staleAfterMs;
  let state: FreshnessState = "unknown";
  if (lastSuccessfulCrawlAt !== null && freshnessAge !== null && freshnessAge > staleAfterMs) state = "stale";
  else if (fullRunAt !== null && expectedSources > 0 && trustedSources >= expectedSources) state = "fresh";
  else if (trustedSources > 0) state = "partial";
  return {
    state: hasRun || hasResult ? state : "unknown",
    lastSuccessfulCrawlAt,
    ageMs: freshnessAge,
    expectedSources,
    trustedSources,
    staleSources,
  };
}

function metricRecord(run: OperationsRunSummary | null, histories: SourceHistory[]): Record<OperationsMetricName, number | null> | null {
  if (!run) return null;
  const currentResults = histories.flatMap((history) => history.results.filter((result) => result.run_id === run.id));
  return {
    crawl_duration_ms: run.durationMs,
    source_duration_ms: null,
    sources_requested: run.sourcesRequested,
    sources_settled: run.sourcesSettled,
    sources_completed: run.sourcesCompleted,
    roles_entered: run.rolesEntered,
    roles_changed: run.rolesChanged,
    roles_closed: run.rolesClosed,
    roles_unchanged: run.rolesUnchanged,
    roles_discovered: run.rolesDiscovered,
    duplicate_listings_skipped: run.duplicateListingsSkipped,
    detail_pages_fetched: run.detailPagesFetched,
    http_requests: run.httpRequests,
    browser_navigations: run.browserNavigations,
    rate_limited_responses: currentResults.reduce((sum, result) => sum + dedupeRateLimitCount(result), 0),
    stale_responses: currentResults.reduce((sum, result) => sum + (result.stale === 1 ? 1 : 0), 0),
  };
}

function sourceResultsQuery(schema: SchemaInfo, historyLimit: number): string {
  const columns = [
    "sr.run_id", "sr.source_id", integerExpression(schema, "source_run_results", "settled"),
    integerExpression(schema, "source_run_results", "completed"), integerExpression(schema, "source_run_results", "coverage_complete"),
    integerExpression(schema, "source_run_results", "stale"), integerExpression(schema, "source_run_results", "health_excluded"),
    columnExpression(schema, "source_run_results", "started_at"), columnExpression(schema, "source_run_results", "settled_at"),
    columnExpression(schema, "source_run_results", "duration_ms"), columnExpression(schema, "source_run_results", "response_latency_ms"),
    columnExpression(schema, "source_run_results", "inventory_count"), integerExpression(schema, "source_run_results", "trusted_inventory"),
    integerExpression(schema, "source_run_results", "suspicious_inventory"), integerExpression(schema, "source_run_results", "rate_limit_count"),
    integerExpression(schema, "source_run_results", "browser_fallbacks"), integerExpression(schema, "source_run_results", "browser_fallback_successes"),
    integerExpression(schema, "source_run_results", "failure_count"), columnExpression(schema, "source_run_results", "status"),
    columnExpression(schema, "source_run_results", "http_status"), columnExpression(schema, "source_run_results", "last_error"),
  ];
  return `
    SELECT ${columns.join(", ")}
    FROM (
      SELECT source_run_results.*, ROW_NUMBER() OVER (PARTITION BY source_id ORDER BY run_id DESC) AS health_row_number
      FROM source_run_results
    ) sr
    WHERE sr.health_row_number <= ${historyLimit}
    ORDER BY sr.source_id, sr.run_id DESC
  `;
}

function buildUnavailableSnapshot(nowMs: number): OperationsSnapshot {
  const freshness: OperationsFreshness = {
    state: "unknown", lastSuccessfulCrawlAt: null, ageMs: null, expectedSources: 0,
    trustedSources: 0, staleSources: 0, latestTrustedRunId: null, fullCoverage: false,
  };
  return {
    contract: OPERATIONS_CONTRACT,
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    metricRegistry: OPERATIONS_METRIC_REGISTRY,
    generatedAt: rawNowIso(nowMs),
    status: "unavailable",
    dataState: "no_data",
    database: { available: false, schemaReady: false },
    freshness,
    activeRun: null,
    latestRun: null,
    runs: [],
    sources: [],
    anomalies: [makeAnomaly("NO_DATA", "info", "database", nowMs, {
      runId: null, sourceId: null, sourceUrl: null, observed: null, baseline: null,
      threshold: null, unit: "state", explanation: "The operations database is unavailable or has not been initialized.",
    })],
    metrics: { latestRun: null, durationTrend: "unknown", durationBaselineMs: null, durationSamples: 0 },
    failureSummary: [],
  };
}

/** Build a read-only operations snapshot from an already-open SQLite reader. */
export function buildOperationsSnapshot(database: DatabaseSync, options: OperationsReadOptions = {}): OperationsSnapshot {
  const clock = nowDate(options.now);
  const nowMs = clock.getTime();
  const thresholds: OperationsThresholds = { ...DEFAULT_OPERATIONS_THRESHOLDS, ...options.thresholds };
  const runLimit = clampLimit(options.runLimit, 24, 100);
  const sourceLimit = clampLimit(options.sourceLimit, 100, 500);
  const sourceHistoryLimit = clampLimit(options.sourceHistoryLimit, Math.max(runLimit, thresholds.minimumBaselineSamples * 4), 100);
  const schema = tableInfo(database);
  if (!schema.tables.has("crawl_runs") || !schema.tables.has("sources") || !schema.tables.has("source_run_results")) {
    return buildUnavailableSnapshot(nowMs);
  }
  const schemaReady = operationsSchemaReady(schema);

  const runColumns = [
    "id", columnExpression(schema, "crawl_runs", "started_at"), columnExpression(schema, "crawl_runs", "heartbeat_at"),
    columnExpression(schema, "crawl_runs", "finished_at"), columnExpression(schema, "crawl_runs", "cancel_requested_at"),
    columnExpression(schema, "crawl_runs", "status"), integerExpression(schema, "crawl_runs", "sources_requested"),
    integerExpression(schema, "crawl_runs", "sources_settled"), integerExpression(schema, "crawl_runs", "sources_completed"),
    integerExpression(schema, "crawl_runs", "pages_visited"), integerExpression(schema, "crawl_runs", "potential_postings_inspected"),
    integerExpression(schema, "crawl_runs", "internships_discovered"), integerExpression(schema, "crawl_runs", "new_count"),
    integerExpression(schema, "crawl_runs", "updated_count"), integerExpression(schema, "crawl_runs", "unchanged_count"),
    integerExpression(schema, "crawl_runs", "closed_count"), integerExpression(schema, "crawl_runs", "cache_hits"),
    integerExpression(schema, "crawl_runs", "unchanged_skips"), integerExpression(schema, "crawl_runs", "new_listings"),
    integerExpression(schema, "crawl_runs", "changed_listings"), integerExpression(schema, "crawl_runs", "retryable_failures"),
    integerExpression(schema, "crawl_runs", "detail_pages_fetched"), integerExpression(schema, "crawl_runs", "duplicate_listings_skipped"),
    integerExpression(schema, "crawl_runs", "irrelevant_listings_skipped"), integerExpression(schema, "crawl_runs", "http_requests"),
    integerExpression(schema, "crawl_runs", "browser_navigations"), columnExpression(schema, "crawl_runs", "error_message"),
    columnExpression(schema, "crawl_runs", "options_json"),
  ];
  const rawRuns = database.prepare(`SELECT ${runColumns.join(", ")} FROM crawl_runs ORDER BY id DESC LIMIT ${runLimit}`).all() as unknown as RawRun[];
  const sourceColumns = [
    "s.id", "s.url", integerExpression(schema, "sources", "is_configured", "is_configured"),
    hasColumn(schema, "source_strategies", "adapter") ? "ss.adapter AS adapter" : "NULL AS adapter",
    integerExpression(schema, "source_strategies", "requires_js", "requires_js"),
    hasColumn(schema, "source_strategies", "last_error") ? "ss.last_error AS strategy_last_error" : "NULL AS strategy_last_error",
  ];
  const rawSources = database.prepare(`
    SELECT ${sourceColumns.join(", ")}
    FROM sources s
    ${schema.tables.has("source_strategies") ? "LEFT JOIN source_strategies ss ON ss.source_id = s.id" : ""}
    ORDER BY CASE WHEN COALESCE(s.is_configured, 0) = 1 THEN 0 ELSE 1 END, s.id DESC
    LIMIT ${sourceLimit}
  `).all() as unknown as RawSource[];
  let rawResults = database.prepare(sourceResultsQuery(schema, sourceHistoryLimit)).all() as unknown as RawSourceResult[];
  // Legacy stores can have more source rows than the bounded diagnostic set;
  // this aggregate query preserves the all-time last trusted success without
  // loading old results into memory.
  const latestTrustedRows = database.prepare(`
    SELECT source_id, MAX(COALESCE(
      ${hasColumn(schema, "source_run_results", "settled_at") ? "settled_at" : "NULL"},
      ${hasColumn(schema, "source_run_results", "started_at") ? "started_at" : "NULL"}
    )) AS latest_trusted_at
    FROM source_run_results
    WHERE ${hasColumn(schema, "source_run_results", "settled") ? "settled = 1" : "1 = 1"}
      AND ${hasColumn(schema, "source_run_results", "completed") ? "completed = 1" : "1 = 1"}
      AND ${hasColumn(schema, "source_run_results", "coverage_complete") ? "coverage_complete = 1" : "0 = 1"}
      AND ${hasColumn(schema, "source_run_results", "stale") ? "stale = 0" : "1 = 1"}
      AND ${hasColumn(schema, "source_run_results", "health_excluded") ? "health_excluded = 0" : "1 = 1"}
      AND ${hasColumn(schema, "source_run_results", "trusted_inventory") ? "trusted_inventory = 1" : "0 = 1"}
    GROUP BY source_id
  `).all() as unknown as Array<{ source_id: number; latest_trusted_at: string | null }>;
  const latestTrustedBySource = new Map(latestTrustedRows.map((row) => [integer(row.source_id), row.latest_trusted_at]));

  const runMeta = new Map(rawRuns.map((run) => {
    const parsed = parseRunOptions(run.options_json);
    return [run.id, parsed] as const;
  }));
  rawResults = rawResults.map((result) => {
    const parsed = runMeta.get(integer(result.run_id)) ?? { edition: "unknown" as const, sourceSetKey: null };
    return { ...result, edition: parsed.edition, source_set_key: parsed.sourceSetKey };
  });
  const histories: SourceHistory[] = rawSources.map((source) => ({
    source,
    results: rawResults.filter((result) => integer(result.source_id) === integer(source.id)),
    latestTrustedAt: latestTrustedBySource.get(integer(source.id)) ?? null,
  }));

  const configuredUrls = configuredSourceUrls(rawSources, options.configuredSourceUrls);
  const freshness = freshAggregate(rawRuns, histories, configuredUrls, nowMs, thresholds);
  const comparableRunIds = new Set<number>();
  const baselineRuns: OperationsRunSummary[] = [];
  for (const run of rawRuns) {
    const parsed = parseRunOptions(run.options_json);
    const summary = runSummary(run, nowMs, false);
    const complete = run.status === "COMPLETED"
      && run.cancel_requested_at === null
      && run.sources_requested > 0
      && run.sources_settled >= run.sources_requested
      && run.sources_completed >= run.sources_requested
      && parsed.edition !== "unknown"
      && parsed.sourceSetKey !== null;
    const sourceRows = rawResults.filter((result) => result.run_id === run.id);
    const trustedRows = sourceRows.filter(resultComparable);
    const sameSet = sourceRows.length >= run.sources_requested
      && trustedRows.length >= run.sources_requested
      && new Set(trustedRows.map((result) => result.source_id)).size >= run.sources_requested;
    if (complete && sameSet) {
      comparableRunIds.add(run.id);
      baselineRuns.push({ ...summary, comparable: true });
    }
  }
  const summaries = rawRuns.map((run) => runSummary(run, nowMs, comparableRunIds.has(run.id)));
  const latestRun = summaries[0] ?? null;
  const activeRawRun = rawRuns.find((run) => run.status === "RUNNING") ?? null;
  const activeRun = activeRawRun ? runSummary(activeRawRun, nowMs, comparableRunIds.has(activeRawRun.id)) : null;

  const anomalies: OperationsAnomaly[] = [];
  if (rawRuns.length === 0 && rawResults.length === 0) {
    anomalies.push(makeAnomaly("NO_DATA", "info", "database", nowMs, {
      runId: null, sourceId: null, sourceUrl: null, observed: null, baseline: null, threshold: null,
      unit: "state", explanation: "No crawl runs or source outcomes are available yet.",
    }));
  } else if (comparableRunIds.size < thresholds.minimumBaselineSamples) {
    anomalies.push(makeAnomaly("WARMUP", "info", "database", nowMs, {
      runId: latestRun?.id ?? null, sourceId: null, sourceUrl: null,
      observed: comparableRunIds.size, baseline: thresholds.minimumBaselineSamples,
      threshold: thresholds.minimumBaselineSamples, unit: "runs",
      explanation: `Only ${comparableRunIds.size} comparable complete runs are available; anomaly baselines need at least ${thresholds.minimumBaselineSamples}.`,
    }));
  }

  if (freshness.lastSuccessfulCrawlAt && freshness.ageMs !== null && freshness.ageMs > thresholds.staleAfterMs) {
    anomalies.push(makeAnomaly("STALE_DATABASE", "warning", "database", nowMs, {
      runId: freshness.latestTrustedRunId, sourceId: null, sourceUrl: null,
      observed: freshness.ageMs, baseline: thresholds.staleAfterMs, threshold: thresholds.staleAfterMs,
      unit: "ms", explanation: `The latest trusted crawl is ${Math.round(freshness.ageMs / 60_000)} minutes old, beyond the ${Math.round(thresholds.staleAfterMs / 60_000)} minute freshness window.`,
    }));
  }

  if (activeRun) {
    const heartbeatAge = activeRun.heartbeatAgeMs ?? activeRun.durationMs ?? null;
    const overHeartbeat = heartbeatAge !== null && heartbeatAge > thresholds.stuckRunAgeMs;
    const overDuration = activeRun.durationMs !== null && activeRun.durationMs > thresholds.stuckRunDurationMs;
    if (overHeartbeat || overDuration) {
      const reasons = [
        ...(overHeartbeat ? [`heartbeat age ${Math.round((heartbeatAge ?? 0) / 60_000)} minutes`] : []),
        ...(overDuration ? [`total duration ${Math.round((activeRun.durationMs ?? 0) / 60_000)} minutes`] : []),
      ];
      anomalies.push(makeAnomaly("STUCK_RUN", "critical", "run", nowMs, {
        runId: activeRun.id, sourceId: null, sourceUrl: null,
        observed: Math.max(heartbeatAge ?? 0, activeRun.durationMs ?? 0),
        baseline: null, threshold: Math.max(thresholds.stuckRunAgeMs, thresholds.stuckRunDurationMs), unit: "ms",
        explanation: `Run ${activeRun.id} is still marked RUNNING; ${reasons.join(" and ")} exceeded the configured budget.`,
      }));
    }
  }

  const latestComparable = baselineRuns[0] ?? null;
  const baselineComparable = baselineRuns.slice(1);
  const durationBaselineValues = baselineComparable.map((run) => run.durationMs).filter((value): value is number => value !== null);
  const durationBaselineMs = median(durationBaselineValues);
  let durationTrend: OperationsMetricsSnapshot["durationTrend"] = "unknown";
  if (latestComparable !== null && latestComparable.durationMs !== null && durationBaselineMs !== null && durationBaselineValues.length >= thresholds.minimumBaselineSamples) {
    const high = durationBaselineMs * 1.1;
    const low = durationBaselineMs * 0.9;
    durationTrend = latestComparable.durationMs > high ? "up" : latestComparable.durationMs < low ? "down" : "flat";
    const durationRegressionThreshold = Math.max(
      durationBaselineMs * thresholds.durationRegressionMultiplier,
      thresholds.durationRegressionAbsoluteMs,
    );
    if (latestComparable.durationMs > durationRegressionThreshold) {
      anomalies.push(makeAnomaly("DURATION_REGRESSION", "warning", "run", nowMs, {
        runId: latestComparable.id, sourceId: null, sourceUrl: null,
        observed: latestComparable.durationMs, baseline: durationBaselineMs,
        threshold: durationRegressionThreshold,
        unit: "ms", explanation: `Run ${latestComparable.id} took longer than the comparable run baseline.`,
      }));
    }
  }

  if (latestComparable !== null && baselineComparable.length >= thresholds.minimumBaselineSamples) {
    const closureBaseline = average(baselineComparable.map((run) => run.rolesClosed)) ?? 0;
    const closureThreshold = Math.max(thresholds.closureSpikeAbsolute, closureBaseline * thresholds.closureSpikeMultiplier);
    if (latestComparable.rolesClosed >= closureThreshold && latestComparable.rolesClosed > closureBaseline) {
      anomalies.push(makeAnomaly("CLOSURE_SPIKE", "warning", "run", nowMs, {
        runId: latestComparable.id, sourceId: null, sourceUrl: null,
        observed: latestComparable.rolesClosed, baseline: closureBaseline, threshold: closureThreshold,
        unit: "roles", explanation: `Run ${latestComparable.id} closed more roles than comparable history predicts.`,
      }));
    }
    const discoveryBaseline = average(baselineComparable.map((run) => run.rolesDiscovered)) ?? 0;
    const dedupRatios = baselineComparable.map((run) => run.rolesDiscovered > 0 ? run.duplicateListingsSkipped / run.rolesDiscovered : 0);
    const dedupBaseline = average(dedupRatios) ?? 0;
    const currentDedupRatio = latestComparable.rolesDiscovered > 0 ? latestComparable.duplicateListingsSkipped / latestComparable.rolesDiscovered : 0;
    const dedupThreshold = Math.max(dedupBaseline + thresholds.dedupDriftDelta, dedupBaseline * thresholds.dedupDriftMultiplier);
    if (currentDedupRatio > dedupThreshold && latestComparable.duplicateListingsSkipped > discoveryBaseline * 0.1) {
      anomalies.push(makeAnomaly("DEDUP_DRIFT", "warning", "run", nowMs, {
        runId: latestComparable.id, sourceId: null, sourceUrl: null,
        observed: currentDedupRatio, baseline: dedupBaseline, threshold: dedupThreshold,
        unit: "ratio", explanation: `Duplicate listing pressure rose above the comparable run baseline.`,
      }));
    }
  }

  const sourceSummaries: OperationsSourceSummary[] = [];
  for (const history of histories) {
    const source = history.source;
    const results = history.results.filter((result) => result.settled === 1);
    const trusted = results.filter(resultTrusted);
    const freshnessState = sourceFreshness(history, nowMs, thresholds);
    const newest = results[0] ?? null;
    const previousTrusted = trusted.slice(1);
    const yieldValues = previousTrusted.map((result) => result.inventory_count).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    const observedYield = trusted[0]?.inventory_count ?? null;
    const yieldBaseline = average(yieldValues);
    const durationValues = previousTrusted.map((result) => result.duration_ms).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    const latencyValues = previousTrusted.map((result) => result.response_latency_ms).filter((value): value is number => value !== null && Number.isFinite(value) && value >= 0);
    const durationObserved = newest?.duration_ms ?? null;
    const durationBaseline = median(durationValues);
    const latencyObserved = newest?.response_latency_ms ?? null;
    const latencyBaseline = median(latencyValues);
    const attempts = results.length;
    const successes = trusted.length;
    let consecutiveFailures = 0;
    for (const result of results) {
      if (resultTrusted(result)) break;
      consecutiveFailures += 1;
    }
    const partialCount = results.filter((result) => result.completed === 1 && result.coverage_complete !== 1).length;
    const rateLimitCount = results.reduce((sum, result) => sum + dedupeRateLimitCount(result), 0);
    const browserFallbacks = results.reduce((sum, result) => sum + integer(result.browser_fallbacks), 0);
    const browserFallbackSuccesses = results.reduce((sum, result) => sum + Math.min(integer(result.browser_fallbacks), integer(result.browser_fallback_successes)), 0);
    // Transport events are edge signals. Report an anomaly for the latest
    // settled outcome only so one old 429/browser fallback does not remain a
    // warning for the entire bounded history window. The summary still keeps
    // bounded totals for diagnosis and trend context.
    const latestRateLimitCount = newest ? dedupeRateLimitCount(newest) : 0;
    const latestBrowserFallbacks = newest ? integer(newest.browser_fallbacks) : 0;
    const latestBrowserFallbackSuccesses = newest
      ? Math.min(integer(newest.browser_fallbacks), integer(newest.browser_fallback_successes))
      : 0;
    const sourceUrl = safeCanonicalizeUrl(source.url) ?? source.url;
    const sourceSummary: OperationsSourceSummary = {
      sourceId: integer(source.id),
      url: sourceUrl,
      configured: configuredUrls.has(sourceUrl),
      attempts,
      successes,
      failures: Math.max(0, attempts - successes),
      successRate: attempts > 0 ? successes / attempts : null,
      consecutiveFailures,
      lastAttemptAt: timestamp(newest?.settled_at ?? newest?.started_at, nowMs).value,
      lastSuccessAt: freshnessState.lastSuccessAt,
      lastFailureAt: timestamp(results.find((result) => !resultTrusted(result))?.settled_at ?? null, nowMs).value,
      ageMs: freshnessState.age,
      stale: freshnessState.stale,
      partialCount,
      partialRate: attempts > 0 ? partialCount / attempts : null,
      zeroYieldCount: trusted.filter((result) => result.inventory_count === 0).length,
      yield: {
        observed: observedYield,
        baseline: yieldBaseline,
        ratio: observedYield !== null && yieldBaseline !== null && yieldBaseline > 0 ? observedYield / yieldBaseline : null,
        samples: yieldValues.length,
      },
      duration: { observedMs: durationObserved, baselineMs: durationBaseline, samples: durationValues.length },
      latency: { observedMs: latencyObserved, baselineMs: latencyBaseline, samples: latencyValues.length },
      rateLimitCount,
      browserFallbacks,
      browserFallbackSuccesses,
      latest: newest ? {
        runId: integer(newest.run_id), status: newest.status, completed: newest.completed === 1,
        coverageComplete: newest.coverage_complete === 1, stale: newest.stale === 1, healthExcluded: newest.health_excluded === 1,
        settledAt: timestamp(newest.settled_at, nowMs).value, startedAt: timestamp(newest.started_at, nowMs).value,
        durationMs: Number.isFinite(newest.duration_ms ?? Number.NaN) ? newest.duration_ms : null,
        responseLatencyMs: Number.isFinite(newest.response_latency_ms ?? Number.NaN) ? newest.response_latency_ms : null,
        inventoryCount: Number.isFinite(newest.inventory_count ?? Number.NaN) ? newest.inventory_count : null,
        trustedInventory: newest.trusted_inventory === 1, suspiciousInventory: newest.suspicious_inventory === 1,
        rateLimitCount: dedupeRateLimitCount(newest), browserFallbacks: integer(newest.browser_fallbacks),
        browserFallbackSuccesses: Math.min(integer(newest.browser_fallbacks), integer(newest.browser_fallback_successes)),
        failureCount: integer(newest.failure_count), httpStatus: Number.isFinite(newest.http_status ?? Number.NaN) ? newest.http_status : null,
        error: sanitiseDiagnostic(newest.last_error),
      } : null,
      adapter: source.adapter,
      requiresJs: source.requires_js === 1,
      lastError: sanitiseDiagnostic(newest?.last_error ?? source.strategy_last_error),
      windowSize: attempts,
    };
    sourceSummaries.push(sourceSummary);

    if (sourceSummary.stale && sourceSummary.configured) {
      anomalies.push(makeAnomaly("STALE_SOURCE", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: sourceSummary.ageMs, baseline: thresholds.staleAfterMs, threshold: thresholds.staleAfterMs,
        unit: "ms", explanation: `No trustworthy successful crawl for ${sourceUrl} is within the freshness window.`,
      }));
    }
    if (sourceSummary.configured && consecutiveFailures >= thresholds.repeatedFailureCount) {
      anomalies.push(makeAnomaly("REPEATED_FAILURES", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: consecutiveFailures, baseline: null, threshold: thresholds.repeatedFailureCount,
        unit: "failures", explanation: `${sourceUrl} has ${consecutiveFailures} consecutive non-trusted outcomes.`,
      }));
    }
    if (sourceSummary.configured && observedYield === 0 && yieldValues.length >= thresholds.minimumBaselineSamples && (yieldBaseline ?? 0) >= thresholds.minimumYieldBaseline) {
      anomalies.push(makeAnomaly("ZERO_YIELD", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: 0, baseline: yieldBaseline, threshold: 0, unit: "roles",
        explanation: `${sourceUrl} returned zero trusted listings against a non-zero historical inventory.`,
      }));
    } else if (sourceSummary.configured && observedYield !== null && yieldBaseline !== null && yieldValues.length >= thresholds.minimumBaselineSamples
      && yieldBaseline >= thresholds.minimumYieldBaseline && observedYield < yieldBaseline * thresholds.lowYieldRatio) {
      anomalies.push(makeAnomaly("LOW_YIELD", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: observedYield, baseline: yieldBaseline, threshold: yieldBaseline * thresholds.lowYieldRatio,
        unit: "roles", explanation: `${sourceUrl} inventory fell below the configured historical yield ratio.`,
      }));
    }
    if (sourceSummary.configured && latestRateLimitCount > 0) {
      anomalies.push(makeAnomaly("RATE_LIMITED", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: latestRateLimitCount, baseline: null, threshold: 1, unit: "responses",
        explanation: `${sourceUrl} recorded ${latestRateLimitCount} rate-limited response${latestRateLimitCount === 1 ? "" : "s"} in the latest settled outcome (event window: 1 outcome).`,
      }));
    }
    if (sourceSummary.configured && latestBrowserFallbacks > 0) {
      const severity: OperationsSeverity = latestBrowserFallbackSuccesses === 0 ? "warning" : "info";
      anomalies.push(makeAnomaly("BROWSER_FALLBACK", severity, "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: latestBrowserFallbacks, baseline: latestBrowserFallbackSuccesses, threshold: null, unit: "attempts",
        explanation: `${sourceUrl} used ${latestBrowserFallbacks} browser fallback attempt${latestBrowserFallbacks === 1 ? "" : "s"} in the latest settled outcome; ${latestBrowserFallbackSuccesses} produced a usable result (event window: 1 outcome).`,
      }));
    }
    if (sourceSummary.configured && durationObserved !== null && durationBaseline !== null && durationValues.length >= thresholds.minimumBaselineSamples
      && durationObserved > Math.max(durationBaseline * thresholds.slowSourceMultiplier, thresholds.slowSourceAbsoluteMs)) {
      anomalies.push(makeAnomaly("SLOW_SOURCE", "warning", "source", nowMs, {
        runId: sourceSummary.latest?.runId ?? null, sourceId: sourceSummary.sourceId, sourceUrl,
        observed: durationObserved, baseline: durationBaseline,
        threshold: Math.max(durationBaseline * thresholds.slowSourceMultiplier, thresholds.slowSourceAbsoluteMs), unit: "ms",
        explanation: `${sourceUrl} took longer than its comparable duration baseline.`,
      }));
    }
  }

  const failureSummary: OperationsSnapshot["failureSummary"] = [];
  if (schema.tables.has("failed_pages")) {
    const failureStatement = database.prepare(`
      SELECT error_type, status_code, COUNT(*) AS count, MAX(message) AS message
      FROM failed_pages
      ${latestRun ? "WHERE run_id = @runId" : ""}
      GROUP BY error_type, status_code
      ORDER BY count DESC, error_type
      LIMIT 100
    `);
    const failureRows = (latestRun ? failureStatement.all({ runId: latestRun.id }) : failureStatement.all()) as unknown as Array<{ error_type: string; status_code: number | null; count: number | bigint; message: string | null }>;
    failureSummary.push(...failureRows.map((row) => ({
      errorType: String(row.error_type || "unknown").slice(0, 80),
      statusCode: Number.isFinite(row.status_code ?? Number.NaN) ? row.status_code : null,
      count: integer(row.count),
      message: sanitiseDiagnostic(row.message),
    })));
  }

  if (!schemaReady) {
    anomalies.unshift(makeAnomaly("WARMUP", "info", "database", nowMs, {
      runId: latestRun?.id ?? null, sourceId: null, sourceUrl: null,
      observed: null, baseline: null, threshold: null, unit: "schema",
      explanation: "The database is readable but lacks one or more health telemetry columns; freshness and anomaly baselines are incomplete.",
    }));
  }
  const status: OperationsStatus = !schemaReady
    ? "unknown"
    : anomalies.some((anomaly) => anomaly.severity === "critical" || anomaly.severity === "warning")
    ? "degraded"
    : rawRuns.length === 0 && rawResults.length === 0
      ? "unknown"
      : "healthy";
  const dataState: OperationsDataState = rawRuns.length === 0 && rawResults.length === 0
    ? "no_data"
      : comparableRunIds.size < thresholds.minimumBaselineSamples
      ? "warmup"
      : "ready";
  return {
    contract: OPERATIONS_CONTRACT,
    schemaVersion: OPERATIONS_SCHEMA_VERSION,
    metricRegistry: OPERATIONS_METRIC_REGISTRY,
    generatedAt: rawNowIso(nowMs),
    status,
    dataState,
    database: { available: true, schemaReady },
    freshness,
    activeRun,
    latestRun,
    runs: summaries,
    sources: sourceSummaries.sort((left, right) => Number(right.configured) - Number(left.configured) || left.url.localeCompare(right.url)),
    anomalies,
    metrics: {
      latestRun: metricRecord(latestRun, histories),
      durationTrend,
      durationBaselineMs,
      durationSamples: durationBaselineValues.length,
    },
    failureSummary,
  };
}

/** Open a read-only SQLite connection and build the bounded operations snapshot. */
export function readOperationsSnapshot(databasePath: string, options: OperationsReadOptions = {}): OperationsSnapshot {
  const nowMs = nowDate(options.now).getTime();
  if (!existsSync(databasePath)) return buildUnavailableSnapshot(nowMs);
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 1000");
    return buildOperationsSnapshot(database, options);
  } catch {
    return buildUnavailableSnapshot(nowMs);
  } finally {
    database?.close();
  }
}

/** Safe projection for ordinary dashboard callers. */
export function publicFreshnessFromOperations(snapshot: OperationsSnapshot): PublicFreshness {
  return {
    state: snapshot.freshness.state,
    lastSuccessfulCrawlAt: snapshot.freshness.lastSuccessfulCrawlAt,
    ageMs: snapshot.freshness.ageMs,
    expectedSources: snapshot.freshness.expectedSources,
    trustedSources: snapshot.freshness.trustedSources,
    staleSources: snapshot.freshness.staleSources,
  };
}

export function readPublicFreshness(databasePath: string, options: OperationsReadOptions = {}): PublicFreshness {
  const nowMs = nowDate(options.now).getTime();
  if (!existsSync(databasePath)) return unavailablePublicFreshness();
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 1000");
    return readCheapPublicFreshness(database, options, nowMs);
  } catch {
    return unavailablePublicFreshness();
  } finally {
    database?.close();
  }
}

// Descriptive aliases for consumers migrating from the source-health module.
export const buildOperationsHealth = buildOperationsSnapshot;
export const readOperationsHealth = readOperationsSnapshot;
export const readDashboardFreshness = readPublicFreshness;

/** Return a stable time bucket for public cache validators. */
export function publicFreshnessCacheBucket(freshness: PublicFreshness, bucketMs = 5 * 60 * 1_000): string {
  if (!Number.isFinite(freshness.ageMs) || freshness.ageMs === null || bucketMs <= 0) return `${freshness.state}:unknown`;
  return `${freshness.state}:${Math.floor(freshness.ageMs / bucketMs)}`;
}
