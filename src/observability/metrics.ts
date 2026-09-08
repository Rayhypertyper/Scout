/**
 * Stable names shared by crawl producers, durable persistence, benchmark
 * output, and the operations read side. Keep this list small: a metric is
 * useful only when its meaning remains stable across crawler editions.
 */
export const CRAWL_METRIC_KEYS = [
  "discovered",
  "rolesDiscovered",
  "detailFetched",
  "earlyRejected",
  "canonicalRolesCreated",
  "cacheHits",
  "unchangedSkips",
  "newListings",
  "changedListings",
  "retryableFailures",
  "detailPagesFetched",
  "duplicateListingsSkipped",
  "irrelevantListingsSkipped",
  "httpRequests",
  "browserNavigations",
  "browserFallbacks",
  "browserFallbackSuccesses",
  "rateLimitedResponses",
  "responseLatencyMs",
  "staleResponses",
  "runtimeMs",
  "crawlDurationMs",
  "sourceDurationMs",
  "sourcesRequested",
  "sourcesSettled",
  "sourcesCompleted",
  /** Lifecycle counts are canonical run outcomes, distinct from pipeline dispositions. */
  "rolesEntered",
  "rolesChanged",
  "rolesClosed",
  "rolesUnchanged",
] as const;

export type CrawlMetricKey = (typeof CRAWL_METRIC_KEYS)[number];

/** Alias for integrations that call the dictionary telemetry metrics. */
export const TELEMETRY_METRIC_KEYS = CRAWL_METRIC_KEYS;
export const METRIC_NAMES = CRAWL_METRIC_KEYS;

/** Stable event names emitted by the lightweight structured logger. */
export const TELEMETRY_EVENT_NAMES = [
  "crawl.started",
  "crawl.progress",
  "crawl.completed",
  "crawl.failed",
  "source.started",
  "source.progress",
  "source.completed",
  "source.failed",
] as const;

export type TelemetryEventName = (typeof TELEMETRY_EVENT_NAMES)[number] | (string & {});

const METRIC_ALIASES: Record<string, CrawlMetricKey> = {
  urls_discovered: "discovered",
  jobs_discovered: "discovered",
  roles_discovered: "rolesDiscovered",
  detail_fetched: "detailFetched",
  detail_pages_fetched: "detailPagesFetched",
  early_rejected: "earlyRejected",
  canonical_roles_created: "canonicalRolesCreated",
  cache_hits: "cacheHits",
  unchanged_skips: "unchangedSkips",
  new_listings: "newListings",
  changed_listings: "changedListings",
  retryable_failures: "retryableFailures",
  duplicate_listings_skipped: "duplicateListingsSkipped",
  irrelevant_listings_skipped: "irrelevantListingsSkipped",
  http_requests: "httpRequests",
  browser_navigations: "browserNavigations",
  browser_fallbacks: "browserFallbacks",
  browser_fallback_successes: "browserFallbackSuccesses",
  rate_limited_responses: "rateLimitedResponses",
  response_latency_ms: "responseLatencyMs",
  stale_responses: "staleResponses",
  runtime_ms: "runtimeMs",
  crawl_duration_ms: "crawlDurationMs",
  source_duration_ms: "sourceDurationMs",
  sources_requested: "sourcesRequested",
  sources_settled: "sourcesSettled",
  sources_completed: "sourcesCompleted",
  roles_entered: "rolesEntered",
  roles_changed: "rolesChanged",
  roles_closed: "rolesClosed",
  roles_unchanged: "rolesUnchanged",
};

/** Normalize common persisted/benchmark spellings to the stable camel case. */
export function normalizeMetricKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "unknown";
  const snake = trimmed
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[\s-]+/gu, "_")
    .toLocaleLowerCase();
  return METRIC_ALIASES[snake]
    ?? ((CRAWL_METRIC_KEYS as readonly string[]).includes(trimmed) ? trimmed : snake);
}

/** Return the canonical unit for a known metric, defaulting to a count. */
export function metricUnit(metric: string): "count" | "ms" | "bytes" {
  const normalized = normalizeMetricKey(metric).toLocaleLowerCase();
  if (normalized.endsWith("ms") || normalized.includes("latency")) return "ms";
  if (normalized.includes("bytes")) return "bytes";
  return "count";
}

/** Resolve either a canonical or common persisted alias to its stable key. */
export function canonicalMetricKey(metric: string): CrawlMetricKey | null {
  const normalized = normalizeMetricKey(metric);
  return (CRAWL_METRIC_KEYS as readonly string[]).includes(normalized)
    ? normalized as CrawlMetricKey
    : null;
}

export function isKnownMetric(metric: string): boolean {
  return canonicalMetricKey(metric) !== null;
}

/** A frozen registry is convenient for consumers that need names at runtime. */
const METRIC_DESCRIPTIONS: Partial<Record<CrawlMetricKey, string>> = {
  discovered: "Listing identities observed before canonical detail classification.",
  rolesDiscovered: "Listings retained from source results before lifecycle reconciliation.",
  newListings: "Pipeline listings classified as new before durable lifecycle reconciliation.",
  changedListings: "Pipeline listings classified as changed before durable lifecycle reconciliation.",
  rolesEntered: "Roles first entered the canonical store in a completed run.",
  rolesChanged: "Canonical roles updated in a completed run.",
  rolesClosed: "Canonical roles marked closed or removed in a completed run.",
  rolesUnchanged: "Canonical roles retained unchanged in a completed run.",
  sourceDurationMs: "Wall clock duration from source start through final settlement.",
  responseLatencyMs: "Sum of bounded transport response latency samples.",
};

export const METRIC_REGISTRY: Readonly<Record<CrawlMetricKey, { unit: "count" | "ms" | "bytes"; description: string }>> = Object.freeze(
  Object.fromEntries(CRAWL_METRIC_KEYS.map((key) => [key, {
    unit: metricUnit(key),
    description: METRIC_DESCRIPTIONS[key] ?? `${key} crawl telemetry value.`,
  }])) as Record<CrawlMetricKey, { unit: "count" | "ms" | "bytes"; description: string }>,
);

export const STABLE_METRIC_REGISTRY = METRIC_REGISTRY;
