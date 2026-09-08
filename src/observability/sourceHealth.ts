/**
 * Source-level health is deliberately summarized from a bounded set of
 * terminal source outcomes. Transport retries are represented by one final
 * source_run_results row, so retry attempts cannot inflate these values.
 */

export interface SourceHealthPolicy {
  /** Number of newest terminal outcomes included in the summary. */
  historyLimit: number;
  /** Consecutive failed outcomes before a cooldown is suggested. */
  cooldownFailureThreshold: number;
  /** Suggested cooldown duration after the most recent failure. */
  cooldownMs: number;
  /** Upper bound for exponential backoff after repeated source failures. */
  maxCooldownMs: number;
  /** Minimum trusted inventory size before a 95% collapse is quarantined. */
  minimumTrustedInventory: number;
  /** A current inventory at or below this fraction is suspicious. */
  suspiciousCollapseRatio: number;
  /** A source with no trusted success this long is reported stale. */
  staleAfterMs: number;
}

export const DEFAULT_SOURCE_HEALTH_POLICY: Readonly<SourceHealthPolicy> = Object.freeze({
  historyLimit: 24,
  cooldownFailureThreshold: 3,
  cooldownMs: 15 * 60 * 1_000,
  maxCooldownMs: 24 * 60 * 60 * 1_000,
  minimumTrustedInventory: 10,
  suspiciousCollapseRatio: 0.05,
  staleAfterMs: 24 * 60 * 60 * 1_000,
});

export interface SourceHealthOutcome {
  runId: number;
  sourceId: number;
  startedAt: string | null;
  settledAt: string | null;
  completed: boolean;
  coverageComplete: boolean;
  status: string | null;
  httpStatus: number | null;
  durationMs: number | null;
  inventoryCount: number | null;
  trustedInventory: boolean;
  suspiciousInventory: boolean;
  inventoryStatus: string | null;
  stale: boolean;
  healthExcluded: boolean;
  rateLimitCount: number;
  browserFallbacks: number;
  browserFallbackSuccesses: number;
  lastError: string | null;
}

export interface SourceHealthState {
  sourceUrl: string;
  sourceId: number;
  /** Number of eligible terminal source outcomes in the bounded window. */
  attempts: number;
  successes: number;
  failures: number;
  successRate: number | null;
  consecutiveFailures: number;
  /** Alias matching SourceStrategyState for callers migrating gradually. */
  consecutiveFailureCount: number;
  cooldownUntil: string | null;
  isCoolingDown: boolean;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  listingYield: number | null;
  latencyMs: number | null;
  latencySamples: number;
  rateLimitCount: number;
  browserFallbackCount: number;
  browserFallbackSuccesses: number;
  browserFallbackRate: number | null;
  browserFallbackSuccessRate: number | null;
  /** Alias used by orchestration telemetry consumers. */
  browserFallbacks: number;
  /** Newest browser fallback attempts since the last useful fallback result. */
  consecutiveBrowserFallbackFailures: number;
  /** Most recent source outcome that attempted a browser fallback. */
  lastBrowserFallbackAt: string | null;
  partialCount: number;
  partialRate: number | null;
  staleCount: number;
  staleRate: number | null;
  isStale: boolean;
  completeInventoryCount: number;
  lastInventoryCount: number | null;
  trustedInventoryCount: number | null;
  suspiciousSnapshotCount: number;
  lastInventoryStatus: string | null;
  lastStatus: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  windowSize: number;
  updatedAt: string;
}

function finiteNonNegative(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function terminalSuccess(outcome: SourceHealthOutcome): boolean {
  return outcome.completed
    && outcome.coverageComplete
    && !outcome.stale
    && outcome.trustedInventory
    && !outcome.suspiciousInventory
    && outcome.inventoryStatus !== "quarantined"
    && outcome.inventoryStatus !== "stale"
    && outcome.inventoryStatus !== "incomplete"
    && outcome.inventoryStatus !== "excluded"
    && !["partial", "rate_limited", "access_denied", "robots_disallowed", "authentication_required", "browser_error", "parse_error", "source_unavailable"]
      .includes(outcome.status ?? "");
}

function trustedSuccess(outcome: SourceHealthOutcome): boolean {
  return terminalSuccess(outcome) && outcome.trustedInventory;
}

function terminalFailure(outcome: SourceHealthOutcome): boolean {
  return !terminalSuccess(outcome);
}

export function summarizeSourceHealth(
  sourceUrl: string,
  sourceId: number,
  outcomes: readonly SourceHealthOutcome[],
  now: Date | string = new Date(),
  policy: Partial<SourceHealthPolicy> = {},
): SourceHealthState {
  const resolvedPolicy: SourceHealthPolicy = { ...DEFAULT_SOURCE_HEALTH_POLICY, ...policy };
  const eligible = outcomes
    .filter((outcome) => !outcome.healthExcluded)
    .toSorted((left, right) => right.runId - left.runId);
  const bounded = eligible
    .slice(0, Math.max(1, Math.floor(resolvedPolicy.historyLimit)));
  const attempts = bounded.length;
  const successes = bounded.filter(terminalSuccess).length;
  const failures = bounded.filter(terminalFailure).length;
  const successRate = attempts > 0 ? successes / attempts : null;
  let newestFailureStreak = 0;
  for (const outcome of bounded) {
    if (!terminalFailure(outcome)) break;
    newestFailureStreak += 1;
  }
  const consecutive = newestFailureStreak;
  const latestEligible = bounded[0] ?? null;
  const latestSuccess = eligible.find(trustedSuccess) ?? null;
  const latestFailure = eligible.find(terminalFailure) ?? null;
  const latestFallback = eligible.find((outcome) => finiteNonNegative(outcome.browserFallbacks) > 0) ?? null;
  let consecutiveBrowserFallbackFailures = 0;
  for (const outcome of eligible) {
    const fallbackAttempts = finiteNonNegative(outcome.browserFallbacks);
    if (fallbackAttempts <= 0) continue;
    const usefulFallbacks = Math.min(fallbackAttempts, finiteNonNegative(outcome.browserFallbackSuccesses));
    if (usefulFallbacks > 0) break;
    consecutiveBrowserFallbackFailures += fallbackAttempts;
  }
  const lastFailureAt = latestFailure?.settledAt ?? latestFailure?.startedAt ?? null;
  const failureAtMs = lastFailureAt ? Date.parse(lastFailureAt) : Number.NaN;
  const cooldownDuration = Math.min(
    resolvedPolicy.maxCooldownMs,
    resolvedPolicy.cooldownMs * 2 ** Math.max(0, consecutive - resolvedPolicy.cooldownFailureThreshold),
  );
  const cooldownUntil = consecutive >= resolvedPolicy.cooldownFailureThreshold && Number.isFinite(failureAtMs)
    ? new Date(failureAtMs + cooldownDuration).toISOString()
    : null;
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const successfulInventories = bounded.filter(trustedSuccess);
  const allSuccessfulInventories = eligible.filter(trustedSuccess);
  const inventorySamples = successfulInventories
    .map((outcome) => outcome.inventoryCount)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const latencySamples = bounded
    .map((outcome) => outcome.durationMs)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  const browserFallbackCount = bounded.reduce((sum, outcome) => sum + finiteNonNegative(outcome.browserFallbacks), 0);
  const browserFallbackSuccesses = bounded.reduce((sum, outcome) => sum + Math.min(
    finiteNonNegative(outcome.browserFallbacks),
    finiteNonNegative(outcome.browserFallbackSuccesses),
  ), 0);
  const rateLimitCount = bounded.reduce((sum, outcome) => sum + Math.max(
    finiteNonNegative(outcome.rateLimitCount),
    outcome.status === "rate_limited" || outcome.httpStatus === 429 ? 1 : 0,
  ), 0);
  const partialCount = bounded.filter((outcome) => !terminalSuccess(outcome)
    && (outcome.status === "partial"
      || (outcome.completed && !outcome.coverageComplete)
      || outcome.suspiciousInventory
      || outcome.inventoryStatus === "quarantined")).length;
  const staleCount = bounded.filter((outcome) => outcome.stale).length;
  const suspiciousSnapshotCount = bounded.filter((outcome) => outcome.suspiciousInventory).length;
  const updatedAt = latestEligible?.settledAt ?? latestEligible?.startedAt ?? new Date(0).toISOString();
  const latestSuccessAt = latestSuccess?.settledAt ?? latestSuccess?.startedAt ?? null;
  const successAgeMs = latestSuccessAt ? nowMs - Date.parse(latestSuccessAt) : Number.POSITIVE_INFINITY;
  const isStale = (latestEligible?.stale ?? false)
    || (latestSuccessAt !== null && Number.isFinite(successAgeMs) && successAgeMs > resolvedPolicy.staleAfterMs)
    || (latestSuccessAt === null && attempts > 0);

  return {
    sourceUrl,
    sourceId,
    attempts,
    successes,
    failures,
    successRate,
    consecutiveFailures: consecutive,
    consecutiveFailureCount: consecutive,
    cooldownUntil,
    isCoolingDown: cooldownUntil !== null && Number.isFinite(nowMs) && nowMs < Date.parse(cooldownUntil),
    lastAttemptAt: latestEligible?.settledAt ?? latestEligible?.startedAt ?? null,
    lastSuccessAt: latestSuccessAt,
    lastFailureAt,
    listingYield: inventorySamples.length > 0
      ? inventorySamples.reduce((sum, value) => sum + value, 0) / inventorySamples.length
      : null,
    latencyMs: latencySamples.length > 0
      ? latencySamples.reduce((sum, value) => sum + value, 0) / latencySamples.length
      : null,
    latencySamples: latencySamples.length,
    rateLimitCount,
    browserFallbackCount,
    browserFallbackSuccesses,
    browserFallbackRate: attempts > 0 ? browserFallbackCount / attempts : null,
    browserFallbackSuccessRate: browserFallbackCount > 0 ? browserFallbackSuccesses / browserFallbackCount : null,
    browserFallbacks: browserFallbackCount,
    consecutiveBrowserFallbackFailures,
    lastBrowserFallbackAt: latestFallback?.settledAt ?? latestFallback?.startedAt ?? null,
    partialCount,
    partialRate: attempts > 0 ? partialCount / attempts : null,
    staleCount,
    staleRate: attempts > 0 ? staleCount / attempts : null,
    isStale,
    completeInventoryCount: successfulInventories.length,
    lastInventoryCount: latestEligible?.inventoryCount ?? null,
    trustedInventoryCount: allSuccessfulInventories[0]?.inventoryCount ?? null,
    suspiciousSnapshotCount,
    lastInventoryStatus: latestEligible?.inventoryStatus ?? null,
    lastStatus: latestEligible?.status ?? null,
    lastHttpStatus: latestEligible?.httpStatus ?? null,
    lastError: latestEligible?.lastError ?? null,
    windowSize: attempts,
    updatedAt,
  };
}
