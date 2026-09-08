/* global document, fetch, setTimeout, clearTimeout */

export const OPERATIONS_ENDPOINT = "/api/admin/operations";
export const OPERATIONS_REFRESH_MS = 30_000;
const OPERATIONS_CONTRACT = "operations.v1";
const MAX_ANOMALIES = 60;
const MAX_SOURCES = 250;
const MAX_RUNS = 40;
const MAX_FAILURES = 60;
const FRESHNESS_STATES = new Set(["fresh", "partial", "stale", "unknown"]);
const DATA_STATES = new Set(["no_data", "warmup", "ready"]);
const STATUS_VALUES = new Set(["healthy", "degraded", "unknown", "unavailable"]);
const SEVERITY_RANK = { critical: 0, warning: 1, info: 2 };

export class OperationsAccessError extends Error {
  constructor(message = "You do not have access to operations data.") {
    super(message);
    this.name = "OperationsAccessError";
    this.code = "OPERATIONS_ACCESS_DENIED";
  }
}

export class OperationsRequestError extends Error {
  constructor(message = "Operations data is temporarily unavailable.") {
    super(message);
    this.name = "OperationsRequestError";
    this.code = "OPERATIONS_REQUEST_FAILED";
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function recordValue(record, ...keys) {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function numberValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function nonNegative(value) {
  const number = numberValue(value);
  return number !== null && number >= 0 ? number : null;
}

function integerValue(value) {
  const number = nonNegative(value);
  return number === null ? null : Math.floor(number);
}

function boundedString(value, max = 320) {
  if (typeof value !== "string") return "";
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function hostFromUrl(value) {
  const raw = boundedString(value, 800);
  if (!raw) return "Unknown source";
  try {
    const parsed = new URL(raw);
    return parsed.hostname || "Unknown source";
  } catch {
    return raw.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").split(/[/?#\s]/, 1)[0] || "Unknown source";
  }
}

/** Remove URL paths, credentials, and query strings from admin diagnostics. */
export function diagnosticText(value) {
  const text = boundedString(value);
  if (!text) return "";
  return text.replace(/https?:\/\/[^\s<>'")]+/gi, (candidate) => hostFromUrl(candidate));
}

function validIsoTime(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= Date.now() ? new Date(parsed).toISOString() : null;
}

function boundedArray(value, limit) {
  return Array.isArray(value) ? value.filter(isRecord).slice(0, limit) : [];
}

function normalizeRun(value) {
  if (!isRecord(value)) return null;
  const run = { ...value };
  for (const key of ["id", "sourcesRequested", "sourcesSettled", "sourcesCompleted", "pagesVisited", "potentialPostingsInspected", "rolesDiscovered", "rolesEntered", "rolesChanged", "rolesUnchanged", "rolesClosed", "duplicateListingsSkipped", "detailPagesFetched", "httpRequests", "browserNavigations", "retryableFailures", "durationMs", "heartbeatAgeMs"]) {
    if (run[key] !== undefined) run[key] = nonNegative(run[key]);
  }
  return run;
}

function normalizeSource(value) {
  if (!isRecord(value)) return null;
  const source = { ...value };
  source.sourceId = integerValue(recordValue(source, "sourceId", "id"));
  source.url = typeof source.url === "string" ? source.url : "";
  for (const key of ["attempts", "successes", "failures", "consecutiveFailures", "partialCount", "zeroYieldCount", "rateLimitCount", "browserFallbacks", "browserFallbackSuccesses", "windowSize"]) {
    if (source[key] !== undefined) source[key] = nonNegative(source[key]);
  }
  return source;
}

function normalizeAnomaly(value) {
  if (!isRecord(value)) return null;
  const anomaly = { ...value };
  anomaly.code = boundedString(anomaly.code, 80) || "UNKNOWN";
  anomaly.severity = ["critical", "warning", "info"].includes(anomaly.severity) ? anomaly.severity : "info";
  anomaly.sourceUrl = typeof anomaly.sourceUrl === "string" ? anomaly.sourceUrl : null;
  anomaly.explanation = diagnosticText(anomaly.explanation);
  anomaly.unit = boundedString(anomaly.unit, 40);
  anomaly.runId = integerValue(anomaly.runId);
  anomaly.sourceId = integerValue(anomaly.sourceId);
  return anomaly;
}

/** Accept only the versioned private projection and bound every collection. */
export function normalizeOperationsPayload(payload) {
  if (!isRecord(payload) || payload.contract !== OPERATIONS_CONTRACT) return null;
  const freshness = isRecord(payload.freshness) ? { ...payload.freshness } : {};
  freshness.state = FRESHNESS_STATES.has(freshness.state) ? freshness.state : "unknown";
  freshness.lastSuccessfulCrawlAt = validIsoTime(freshness.lastSuccessfulCrawlAt);
  freshness.ageMs = nonNegative(freshness.ageMs);
  freshness.expectedSources = nonNegative(freshness.expectedSources);
  freshness.trustedSources = nonNegative(freshness.trustedSources);
  freshness.staleSources = nonNegative(freshness.staleSources);
  freshness.fullCoverage = freshness.fullCoverage === true;
  const database = isRecord(payload.database) ? payload.database : {};
  const metrics = isRecord(payload.metrics) ? payload.metrics : {};
  const normalized = {
    ...payload,
    generatedAt: validIsoTime(payload.generatedAt),
    status: STATUS_VALUES.has(payload.status) ? payload.status : "unknown",
    dataState: DATA_STATES.has(payload.dataState) ? payload.dataState : "no_data",
    database: { available: database.available === true, schemaReady: database.schemaReady === true },
    freshness,
    activeRun: normalizeRun(payload.activeRun),
    latestRun: normalizeRun(payload.latestRun),
    runs: boundedArray(payload.runs, MAX_RUNS).map(normalizeRun).filter(Boolean),
    sources: boundedArray(payload.sources, MAX_SOURCES).map(normalizeSource).filter(Boolean),
    anomalies: boundedArray(payload.anomalies, MAX_ANOMALIES).map(normalizeAnomaly).filter(Boolean),
    metrics: {
      ...metrics,
      latestRun: isRecord(metrics.latestRun) ? { ...metrics.latestRun } : null,
      durationTrend: ["up", "down", "flat", "unknown"].includes(metrics.durationTrend) ? metrics.durationTrend : "unknown",
      durationBaselineMs: nonNegative(metrics.durationBaselineMs),
      durationSamples: integerValue(metrics.durationSamples) ?? 0,
    },
    failureSummary: boundedArray(payload.failureSummary, MAX_FAILURES).map((failure) => ({
      ...failure,
      errorType: boundedString(failure.errorType, 100) || "Unknown failure",
      statusCode: integerValue(failure.statusCode),
      count: integerValue(failure.count) ?? 0,
      message: diagnosticText(failure.message),
    })),
  };
  if (normalized.generatedAt === null) normalized.generatedAt = null;
  return normalized;
}

function resolveFetch(fetchImpl) {
  if (typeof fetchImpl === "function") return fetchImpl;
  if (typeof fetch === "function") return fetch;
  throw new OperationsRequestError("Operations data is unavailable because fetch is not supported.");
}

export async function readOperations(fetchImpl) {
  let response;
  try {
    response = await resolveFetch(fetchImpl)(OPERATIONS_ENDPOINT, {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new OperationsRequestError();
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new OperationsAccessError();
  }
  if (!response.ok) throw new OperationsRequestError();
  const normalized = normalizeOperationsPayload(payload);
  if (!normalized) throw new OperationsRequestError("Operations data is unavailable or out of date.");
  return normalized;
}

function formatNumber(value) {
  const number = nonNegative(value);
  return number === null ? "No data" : new Intl.NumberFormat("en-CA", { maximumFractionDigits: 1 }).format(number);
}

export function formatDuration(value) {
  const number = nonNegative(value);
  if (number === null) return "No data";
  if (number < 1_000) return `${Math.round(number)} ms`;
  const seconds = number / 1_000;
  if (seconds < 60) return `${seconds.toFixed(seconds >= 10 ? 0 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m${remainder ? ` ${remainder}s` : ""}`;
}

function exactTime(value) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed)) return "Time unavailable";
  return new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short" }).format(new Date(parsed));
}

export function formatRelativeTime(value, now = Date.now()) {
  const parsed = Date.parse(value || "");
  if (!Number.isFinite(parsed) || parsed > now) return "Time unavailable";
  const minutes = Math.floor(Math.max(0, now - parsed) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function renderTime(value, { now = Date.now(), exact = false } = {}) {
  const iso = validIsoTime(value);
  if (!iso) return `<span class="operations-no-data">Not reported</span>`;
  const absolute = exactTime(iso);
  const label = exact ? absolute : formatRelativeTime(iso, now);
  return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(absolute)}" aria-label="${escapeHtml(absolute)}">${escapeHtml(label)}</time>`;
}

function statusLabel(status) {
  return String(status || "unknown").replaceAll("_", " ").toLowerCase().replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function stateClass(value) {
  return ["healthy", "degraded", "unknown", "unavailable", "warmup", "fresh", "partial", "stale", "critical", "warning", "info"].includes(value)
    ? value
    : "unknown";
}

function dataStateCopy(dataState) {
  if (dataState === "no_data") return { label: "No crawl data", detail: "The database has not reported a crawl or source outcome yet." };
  if (dataState === "warmup") return { label: "Baselines warming", detail: "Recent data is available, but comparisons need more complete runs." };
  return { label: "Baseline ready", detail: "Comparable crawl history is available for anomaly checks." };
}

function overallState(payload) {
  if (!payload.database.available || payload.status === "unavailable") return { state: "unavailable", label: "Database unavailable", detail: "Scout cannot read the operations database right now." };
  if (payload.dataState === "no_data" || payload.status === "unknown") return { state: "unknown", label: "Waiting for data", detail: "No crawl outcome is available to call healthy." };
  if (payload.status === "degraded") return { state: "degraded", label: "Needs attention", detail: "One or more source, run, or freshness checks need review." };
  if (payload.dataState === "warmup") return { state: "warmup", label: "Baselines warming", detail: "Operations are running, but comparison history is still building." };
  return { state: "healthy", label: "Operating normally", detail: "The latest available operations snapshot has no warning or critical anomaly." };
}

function metricDisplay(value, unit = "") {
  if (value === null || value === undefined || value === "") return "No data";
  if (unit === "ms") return formatDuration(value);
  if (unit === "ratio") {
    const ratio = numberValue(value);
    return ratio === null ? "No data" : `${(ratio * 100).toFixed(1)}%`;
  }
  return typeof value === "number" ? formatNumber(value) : diagnosticText(value) || "No data";
}

function sourceStatus(source) {
  if (source.stale === true) return { state: "stale", label: "Stale" };
  const latest = isRecord(source.latest) ? source.latest : null;
  if (!latest && (source.attempts ?? 0) === 0) return { state: "unknown", label: "No attempts" };
  if (source.consecutiveFailures > 0 || latest?.completed === false) return { state: "degraded", label: "Needs attention" };
  if (source.successes > 0) return { state: "healthy", label: "Healthy" };
  return { state: "unknown", label: "Unknown" };
}

function sourceYield(source) {
  const yieldValue = isRecord(source.yield) ? source.yield : {};
  const observed = metricDisplay(yieldValue.observed, "count");
  const baseline = metricDisplay(yieldValue.baseline, "count");
  const ratio = numberValue(yieldValue.ratio);
  const trend = ratio === null ? "No baseline" : ratio > 1.05 ? "Above baseline" : ratio < .95 ? "Below baseline" : "Near baseline";
  return `<strong>${escapeHtml(observed)}</strong><small>${escapeHtml(trend)} · baseline ${escapeHtml(baseline)}</small>`;
}

function sourceDuration(source) {
  const duration = isRecord(source.duration) ? source.duration : {};
  return `<strong>${escapeHtml(formatDuration(duration.observedMs))}</strong><small>${escapeHtml(duration.baselineMs === null || duration.baselineMs === undefined ? "Baseline unavailable" : `baseline ${formatDuration(duration.baselineMs)}`)}</small>`;
}

function sourceReliability(source) {
  const rate = numberValue(source.successRate);
  const rateLabel = rate === null ? "Success rate unavailable" : `${(rate * 100).toFixed(0)}% trusted`;
  const failures = formatNumber(source.failures);
  const consecutive = source.consecutiveFailures > 0 ? ` · ${formatNumber(source.consecutiveFailures)} consecutive` : "";
  return `<strong>${escapeHtml(rateLabel)}</strong><small>${escapeHtml(failures)} failures${escapeHtml(consecutive)}</small>`;
}

function sourceTransport(source) {
  const rateLimits = formatNumber(source.rateLimitCount);
  const fallbacks = formatNumber(source.browserFallbacks);
  const latest = isRecord(source.latest) ? source.latest : null;
  const latestStatus = latest?.status ? statusLabel(latest.status) : "No latest outcome";
  return `<strong>${escapeHtml(latestStatus)}</strong><small>${escapeHtml(rateLimits)} rate limited · ${escapeHtml(fallbacks)} browser fallback</small>`;
}

const ANOMALY_TITLES = {
  NO_DATA: "No operations data",
  WARMUP: "Baseline history is warming up",
  STALE_DATABASE: "Database freshness is stale",
  STALE_SOURCE: "Source freshness is stale",
  REPEATED_FAILURES: "Repeated source failures",
  ZERO_YIELD: "Source returned zero listings",
  LOW_YIELD: "Source yield is below baseline",
  RATE_LIMITED: "Source is being rate limited",
  BROWSER_FALLBACK: "Browser fallback activity",
  SLOW_SOURCE: "Source is slower than baseline",
  CLOSURE_SPIKE: "Unusual role closures",
  DEDUP_DRIFT: "Duplicate listing pressure changed",
  DURATION_REGRESSION: "Run duration regressed",
  STUCK_RUN: "Run may be stuck",
  INVALID_TIMESTAMP: "Invalid timestamp observed",
};

function anomalyContext(anomaly) {
  const values = [];
  if (anomaly.observed !== null && anomaly.observed !== undefined) values.push(`Observed ${metricDisplay(anomaly.observed, anomaly.unit)}`);
  if (anomaly.baseline !== null && anomaly.baseline !== undefined) values.push(`Baseline ${metricDisplay(anomaly.baseline, anomaly.unit)}`);
  if (anomaly.threshold !== null && anomaly.threshold !== undefined) values.push(`Threshold ${metricDisplay(anomaly.threshold, anomaly.unit)}`);
  return values.length ? values.join(" · ") : "No comparison values reported";
}

function anomalyRows(payload, { now, exact }) {
  return [...payload.anomalies]
    .sort((left, right) => (SEVERITY_RANK[left.severity] ?? 2) - (SEVERITY_RANK[right.severity] ?? 2))
    .map((anomaly) => {
      const title = ANOMALY_TITLES[anomaly.code] || statusLabel(anomaly.code);
      const scope = anomaly.scope ? statusLabel(anomaly.scope) : "Operations";
      const source = anomaly.sourceUrl ? ` · ${hostFromUrl(anomaly.sourceUrl)}` : "";
      const run = anomaly.runId !== null && anomaly.runId !== undefined ? `Run #${anomaly.runId}` : "No run correlation";
      return `<li class="operations-anomaly" data-severity="${escapeHtml(stateClass(anomaly.severity))}">
        <div class="operations-anomaly-heading"><span class="operations-severity">${escapeHtml(statusLabel(anomaly.severity))}</span><strong>${escapeHtml(title)}</strong><code>${escapeHtml(anomaly.code)}</code></div>
        <p>${escapeHtml(anomaly.explanation || "No diagnostic explanation was reported.")}</p>
        <div class="operations-anomaly-meta"><span>${escapeHtml(scope)}${escapeHtml(source)}</span><span>${escapeHtml(run)}</span><span>${escapeHtml(anomalyContext(anomaly))}</span><time datetime="${escapeHtml(validIsoTime(anomaly.detectedAt) || "")}" title="${escapeHtml(exactTime(anomaly.detectedAt))}" aria-label="Detected ${escapeHtml(exactTime(anomaly.detectedAt))}">${escapeHtml(formatRelativeTime(anomaly.detectedAt, now))}</time></div>
      </li>`;
    }).join("");
}

function summaryMetric(label, value, detail = "") {
  return `<div class="operations-summary-metric"><dt>${escapeHtml(label)}</dt><dd>${value}</dd>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}</div>`;
}

function latestRunMetric(metrics, run, ...keys) {
  const metricRun = isRecord(metrics.latestRun) ? metrics.latestRun : {};
  const value = recordValue(run, ...keys) ?? recordValue(metricRun, ...keys);
  return value === undefined ? null : value;
}

function renderSummary(payload, { now, exact }) {
  const overall = overallState(payload);
  const dataCopy = dataStateCopy(payload.dataState);
  const freshness = payload.freshness;
  const expected = freshness.expectedSources;
  const trusted = freshness.trustedSources;
  const coverage = expected !== null && trusted !== null ? `${formatNumber(trusted)} / ${formatNumber(expected)}` : "No data";
  const stale = freshness.staleSources !== null ? `${formatNumber(freshness.staleSources)} stale` : "Stale count unavailable";
  const active = payload.activeRun;
  const activeLabel = active ? `Run #${formatNumber(active.id)} · ${statusLabel(active.status)}` : payload.dataState === "no_data" ? "No run data" : "No run in progress";
  const activeDetail = active
    ? `${formatNumber(active.sourcesSettled)} / ${formatNumber(active.sourcesRequested)} sources settled · ${formatNumber(active.pagesVisited)} pages visited`
    : dataCopy.detail;
  const latest = payload.latestRun;
  return `<section class="operations-panel operations-overview-panel" aria-labelledby="operations-overview-heading">
    <div class="operations-panel-heading">
      <div><h2 id="operations-overview-heading">Operations overview</h2><p>Evidence from the latest bounded snapshot, with missing data called out.</p></div>
      <span class="operations-state-badge" data-state="${escapeHtml(stateClass(overall.state))}">${escapeHtml(overall.label)}</span>
    </div>
    <div class="operations-overview-state" data-state="${escapeHtml(stateClass(overall.state))}">
      <span class="operations-state-mark" aria-hidden="true"></span><div><strong>${escapeHtml(overall.detail)}</strong><span>${escapeHtml(dataCopy.label)} · Snapshot ${escapeHtml(payload.generatedAt ? formatRelativeTime(payload.generatedAt, now) : "not reported")}</span></div>
    </div>
    <dl class="operations-summary-grid">
      ${summaryMetric("Database freshness", `<strong>${escapeHtml(statusLabel(freshness.state))}</strong><small>${renderTime(freshness.lastSuccessfulCrawlAt, { now, exact })}</small>`)}
      ${summaryMetric("Trusted coverage", `<strong>${escapeHtml(coverage)}</strong><small>${escapeHtml(stale)}</small>`)}
      ${summaryMetric("Active run", `<strong>${escapeHtml(activeLabel)}</strong><small>${escapeHtml(activeDetail)}</small>`)}
      ${summaryMetric("Latest run", latest ? `<strong>Run #${escapeHtml(formatNumber(latest.id))}</strong><small>${escapeHtml(statusLabel(latest.status))} · ${escapeHtml(formatDuration(latest.durationMs))}</small>` : `<strong>No data</strong><small>Last run is not reported.</small>`)}
    </dl>
  </section>`;
}

function renderFlow(payload) {
  const run = payload.latestRun;
  const metrics = payload.metrics;
  const entered = latestRunMetric(metrics, run, "rolesEntered", "roles_entered");
  const changed = latestRunMetric(metrics, run, "rolesChanged", "roles_changed");
  const closed = latestRunMetric(metrics, run, "rolesClosed", "roles_closed");
  const unchanged = latestRunMetric(metrics, run, "rolesUnchanged", "roles_unchanged");
  const discovered = latestRunMetric(metrics, run, "rolesDiscovered", "roles_discovered");
  const duplicates = latestRunMetric(metrics, run, "duplicateListingsSkipped", "duplicate_listings_skipped");
  const trend = metrics.durationTrend === "up" ? "Longer than baseline" : metrics.durationTrend === "down" ? "Faster than baseline" : metrics.durationTrend === "flat" ? "Near baseline" : "Baseline unavailable";
  return `<section class="operations-panel operations-flow-panel" aria-labelledby="operations-flow-heading">
    <div class="operations-panel-heading"><div><h2 id="operations-flow-heading">Role flow and run shape</h2><p>Lifecycle movement and duplicate pressure from the latest run.</p></div><span class="operations-panel-note">${escapeHtml(trend)}</span></div>
    <dl class="operations-flow-grid">
      ${summaryMetric("Entered", `<strong>${escapeHtml(formatNumber(entered))}</strong>`, "New canonical roles")}
      ${summaryMetric("Changed", `<strong>${escapeHtml(formatNumber(changed))}</strong>`, "Updated roles")}
      ${summaryMetric("Closed", `<strong>${escapeHtml(formatNumber(closed))}</strong>`, "Roles closed")}
      ${summaryMetric("Unchanged", `<strong>${escapeHtml(formatNumber(unchanged))}</strong>`, "Retained roles")}
      ${summaryMetric("Discovered", `<strong>${escapeHtml(formatNumber(discovered))}</strong>`, "Before reconciliation")}
      ${summaryMetric("Duplicates skipped", `<strong>${escapeHtml(formatNumber(duplicates))}</strong>`, "Dedup signal")}
    </dl>
  </section>`;
}

function renderAnomalies(payload, options) {
  const rows = anomalyRows(payload, options);
  const empty = payload.dataState === "no_data"
    ? "Waiting for a first crawl outcome before anomaly checks can run."
    : payload.dataState === "warmup"
      ? "No actionable anomaly is reported yet. Baselines are still warming."
      : "No active anomalies reported in this snapshot.";
  return `<section class="operations-panel operations-anomalies-panel" aria-labelledby="operations-anomalies-heading">
    <div class="operations-panel-heading"><div><h2 id="operations-anomalies-heading">Needs attention</h2><p>Warnings are ordered before informational conditions. Each row keeps its run and baseline context.</p></div><span class="operations-panel-note">${escapeHtml(`${payload.anomalies.length} reported`)}</span></div>
    ${rows ? `<ol class="operations-anomaly-list">${rows}</ol>` : `<div class="operations-empty"><strong>${escapeHtml(empty)}</strong><span>The view does not infer health when telemetry is missing.</span></div>`}
  </section>`;
}

function renderSources(payload, options) {
  const rows = payload.sources.map((source) => {
    const status = sourceStatus(source);
    const host = source.url ? hostFromUrl(source.url) : `Source #${formatNumber(source.sourceId)}`;
    const latest = isRecord(source.latest) ? source.latest : null;
    const failure = diagnosticText(source.lastError || latest?.error);
    const statusLabelText = status.label;
    return `<tr data-state="${escapeHtml(stateClass(status.state))}">
      <th scope="row" data-label="Source"><span class="operations-source-host" title="${escapeHtml(host)}">${escapeHtml(host)}</span><small>${escapeHtml(source.configured === false ? "Unconfigured" : "Configured")}${source.adapter ? ` · ${escapeHtml(boundedString(source.adapter, 80))}` : ""}${source.requiresJs === true ? " · Browser capable" : ""}</small></th>
      <td data-label="Status"><span class="operations-inline-state" data-state="${escapeHtml(stateClass(status.state))}">${escapeHtml(statusLabelText)}</span><small>${escapeHtml(latest?.status ? statusLabel(latest.status) : "No latest outcome")}</small></td>
      <td data-label="Last success">${renderTime(source.lastSuccessAt, options)}<small>${escapeHtml(source.stale === true ? "Outside freshness window" : source.lastSuccessAt ? "Trusted outcome" : "No trusted outcome")}</small></td>
      <td data-label="Yield" class="operations-measure">${sourceYield(source)}</td>
      <td data-label="Duration" class="operations-measure">${sourceDuration(source)}</td>
      <td data-label="Failures" class="operations-measure">${sourceReliability(source)}</td>
      <td data-label="Rate limited / browser fallback" class="operations-measure">${sourceTransport(source)}</td>
      <td data-label="Latest failure">${failure ? `<details class="operations-diagnostic"><summary>Show detail</summary><p>${escapeHtml(failure)}</p></details>` : `<span class="operations-no-data">No failure detail</span>`}</td>
    </tr>`;
  }).join("");
  const empty = payload.dataState === "no_data" ? "No source attempts are available yet." : "No source rows were reported in this snapshot.";
  return `<section class="operations-panel operations-sources-panel" aria-labelledby="operations-sources-heading">
    <div class="operations-panel-heading"><div><h2 id="operations-sources-heading">Source health</h2><p>Bounded source outcomes show last success, yield, duration, failures, rate limiting, and browser fallback activity.</p></div><span class="operations-panel-note">${escapeHtml(`${payload.sources.length} sources`)}</span></div>
    ${rows ? `<div class="operations-table-wrap"><table class="operations-table operations-sources-table"><caption class="sr-only">Source health diagnostics</caption><thead><tr><th scope="col">Source</th><th scope="col">Status</th><th scope="col">Last success</th><th scope="col">Yield</th><th scope="col">Duration</th><th scope="col">Failures</th><th scope="col">Rate limited / fallback</th><th scope="col">Latest failure</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="operations-empty"><strong>${escapeHtml(empty)}</strong><span>Source identity and diagnostics appear only in this private owner view.</span></div>`}
  </section>`;
}

function renderFailureSummary(payload) {
  const rows = payload.failureSummary.map((failure) => `<li><div><strong>${escapeHtml(failure.errorType)}</strong><span>${failure.statusCode === null ? "Status unavailable" : `HTTP ${failure.statusCode}`}</span></div><p>${escapeHtml(failure.message || "No sanitized message reported.")}</p><small>${escapeHtml(`${formatNumber(failure.count)} occurrence${failure.count === 1 ? "" : "s"}`)}</small></li>`).join("");
  return `<section class="operations-panel operations-failures-panel" aria-labelledby="operations-failures-heading">
    <div class="operations-panel-heading"><div><h2 id="operations-failures-heading">Failure details</h2><p>Sanitized failure groups from the latest available run, without requiring SQLite access.</p></div><span class="operations-panel-note">${escapeHtml(`${payload.failureSummary.length} groups`)}</span></div>
    ${rows ? `<ul class="operations-failure-list">${rows}</ul>` : `<div class="operations-empty"><strong>No grouped failures reported.</strong><span>Failure details will appear when a run records them.</span></div>`}
  </section>`;
}

function renderRuns(payload, options) {
  const rows = payload.runs.map((run) => {
    const requested = nonNegative(run.sourcesRequested);
    const settled = nonNegative(run.sourcesSettled);
    const completed = nonNegative(run.sourcesCompleted);
    const coverage = requested !== null && requested > 0 ? `${formatNumber(settled)} / ${formatNumber(requested)} settled · ${formatNumber(completed)} covered` : "No source outcomes";
    const movement = `+${formatNumber(run.rolesEntered)} · ${formatNumber(run.rolesChanged)} changed · ${formatNumber(run.rolesClosed)} closed`;
    const rowState = run.id === payload.activeRun?.id ? "active" : String(run.status || "").toLowerCase();
    return `<tr data-state="${escapeHtml(stateClass(rowState === "active" ? "degraded" : rowState))}">
      <th scope="row" data-label="Run"><strong>Run #${escapeHtml(formatNumber(run.id))}</strong><small>${escapeHtml(statusLabel(run.status))}</small></th>
      <td data-label="Started">${renderTime(run.startedAt || run.started_at, options)}</td>
      <td data-label="Duration">${escapeHtml(formatDuration(run.durationMs))}</td>
      <td data-label="Coverage">${escapeHtml(coverage)}</td>
      <td data-label="Role flow">${escapeHtml(movement)}</td>
      <td data-label="Dedup / pages">${escapeHtml(`${formatNumber(run.duplicateListingsSkipped)} duplicates · ${formatNumber(run.pagesVisited)} pages`)}</td>
      <td data-label="Run error">${run.error ? `<details class="operations-diagnostic"><summary>Show detail</summary><p>${escapeHtml(diagnosticText(run.error))}</p></details>` : `<span class="operations-no-data">No run error</span>`}</td>
    </tr>`;
  }).join("");
  return `<section class="operations-panel operations-runs-panel" aria-labelledby="operations-runs-heading">
    <div class="operations-panel-heading"><div><h2 id="operations-runs-heading">Recent runs</h2><p>Recent lifecycle, coverage, role movement, dedup, and duration records.</p></div><span class="operations-panel-note">${escapeHtml(`${payload.runs.length} shown`)}</span></div>
    ${rows ? `<div class="operations-table-wrap"><table class="operations-table operations-runs-table"><caption class="sr-only">Recent crawl run history</caption><thead><tr><th scope="col">Run</th><th scope="col">Started</th><th scope="col">Duration</th><th scope="col">Coverage</th><th scope="col">Role flow</th><th scope="col">Dedup / pages</th><th scope="col">Run error</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<div class="operations-empty"><strong>No runs reported.</strong><span>Run history will appear after the first operation.</span></div>`}
  </section>`;
}

export function renderOperationsMarkup(payload, options = {}) {
  const normalized = normalizeOperationsPayload(payload);
  if (!normalized) return `<div class="operations-state operations-state-error" role="alert"><strong>Operations data is unavailable.</strong><span>The response did not match the operations.v1 contract.</span></div>`;
  const renderOptions = { now: options.now ?? Date.now(), exact: options.exact === true };
  return `<div class="operations-layout">
    ${renderSummary(normalized, renderOptions)}
    ${renderFlow(normalized)}
    ${renderAnomalies(normalized, renderOptions)}
    ${renderSources(normalized, renderOptions)}
    ${renderFailureSummary(normalized)}
    ${renderRuns(normalized, renderOptions)}
    <p class="operations-generated">Snapshot generated ${renderTime(normalized.generatedAt, renderOptions)}. Data is read-only and bounded for triage.</p>
  </div>`;
}

export function renderOperationsLoadingMarkup() {
  return `<div class="operations-layout operations-layout-loading" aria-hidden="true"><section class="operations-panel operations-skeleton-panel"><span class="operations-skeleton operations-skeleton-wide"></span><span class="operations-skeleton"></span><span class="operations-skeleton operations-skeleton-short"></span></section><section class="operations-panel operations-skeleton-panel"><span class="operations-skeleton operations-skeleton-wide"></span><span class="operations-skeleton"></span><span class="operations-skeleton operations-skeleton-short"></span></section></div>`;
}

function setOperationsState(kind, title, detail, { retry = false } = {}) {
  const node = document.querySelector("#operations-status");
  if (!node) return;
  node.className = `operations-state operations-state-${kind}`;
  node.setAttribute("role", kind === "error" || kind === "denied" ? "alert" : "status");
  node.innerHTML = `<span class="operations-state-mark" aria-hidden="true"></span><div><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${retry ? '<button class="operations-inline-retry" type="button" data-operations-retry>Try again</button>' : ""}</div>`;
  node.hidden = false;
}

function setLoadingState() {
  const content = document.querySelector("#operations-content");
  if (content) {
    content.innerHTML = renderOperationsLoadingMarkup();
    content.hidden = false;
  }
  setOperationsState("loading", "Loading operations data", "Reading the private operations snapshot.");
}

function setSuccessState(payload, exactTimes) {
  const content = document.querySelector("#operations-content");
  if (!content) return;
  content.innerHTML = renderOperationsMarkup(payload, { exact: exactTimes });
  content.hidden = false;
  const status = document.querySelector("#operations-status");
  if (status) status.hidden = true;
  const live = document.querySelector("#operations-live-region");
  if (live) live.textContent = `Operations updated${payload.generatedAt ? ` ${exactTime(payload.generatedAt)}` : ""}.`;
}

function setErrorState(error) {
  const content = document.querySelector("#operations-content");
  if (content) {
    content.innerHTML = "";
    content.hidden = true;
  }
  if (error instanceof OperationsAccessError) {
    setOperationsState("denied", "Operations access is restricted", "This private view is available to Scout owners.");
  } else {
    setOperationsState("error", "Operations data could not be loaded", "Check the connection and try again.", { retry: true });
  }
}

function bootOperationsPage() {
  const refresh = document.querySelector("#operations-refresh");
  const timeMode = document.querySelector("#operations-time-mode");
  const state = { exactTimes: false, payload: null, inFlight: false, timer: null };

  const schedule = () => {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
    if (document.visibilityState === "hidden") return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void load();
    }, OPERATIONS_REFRESH_MS);
  };

  async function load() {
    if (state.inFlight || document.visibilityState === "hidden") return;
    state.inFlight = true;
    if (refresh) {
      refresh.disabled = true;
      refresh.setAttribute("aria-busy", "true");
    }
    if (!state.payload) setLoadingState();
    try {
      const payload = await readOperations();
      state.payload = payload;
      setSuccessState(payload, state.exactTimes);
    } catch (error) {
      setErrorState(error);
    } finally {
      state.inFlight = false;
      if (refresh) {
        refresh.disabled = false;
        refresh.removeAttribute("aria-busy");
      }
      schedule();
    }
  }

  refresh?.addEventListener("click", () => {
    if (state.payload) setOperationsState("loading", "Refreshing operations data", "Reading the latest private snapshot.");
    void load();
  });
  timeMode?.addEventListener("click", () => {
    state.exactTimes = !state.exactTimes;
    timeMode.setAttribute("aria-pressed", String(state.exactTimes));
    timeMode.textContent = state.exactTimes ? "Use relative times" : "Use exact times";
    if (state.payload) setSuccessState(state.payload, state.exactTimes);
  });
  document.querySelector("#operations-status")?.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest("[data-operations-retry]")) void load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      if (state.timer !== null) clearTimeout(state.timer);
      state.timer = null;
    } else {
      void load();
    }
  });
  void load();
}

if (typeof document !== "undefined") bootOperationsPage();
