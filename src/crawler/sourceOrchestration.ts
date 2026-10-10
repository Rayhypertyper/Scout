import {
  cancellationError,
  isSourceStalledError,
  runWithSourceAbortSignal,
  SourceStalledError,
} from "../domain/cancellation.js";
import type { FetchFailure, SourceCrawlResult } from "../domain/types.js";
import { isApplyBoltNotFoundPage, isEarlyCareerRadarNotFoundPage } from "./publicSources.js";

/**
 * A small surface for source-level history.  The persistence implementation
 * owns the complete shape; orchestration only needs the fields that decide
 * whether an expensive source attempt is safe to start.
 */
export interface SourceHealthForOrchestration {
  cooldownUntil?: string | null;
  consecutiveFailures?: number;
  lastFailureAt?: string | null;
  /** Current durable field; browserFallbacks is retained for older snapshots. */
  browserFallbackCount?: number;
  browserFallbacks?: number;
  browserFallbackSuccesses?: number;
  /** Durable count of newest ineffective browser fallbacks; unlike the
   * aggregate counters this resets after a useful fallback succeeds. */
  consecutiveBrowserFallbackFailures?: number;
  lastBrowserFallbackAt?: string | null;
  updatedAt?: string | null;
}

export const DEFAULT_SOURCE_CIRCUIT_FAILURE_THRESHOLD = 3;
// Compatibility fallback for snapshots that predate an explicit cooldownUntil.
export const DEFAULT_SOURCE_CIRCUIT_COOLDOWN_MS = 5 * 60 * 1_000;
export const DEFAULT_BROWSER_SUPPRESSION_FAILURE_THRESHOLD = 3;
export const DEFAULT_BROWSER_SUPPRESSION_COOLDOWN_MS = 6 * 60 * 60 * 1_000;

/**
 * Return true only while a persisted source cooldown is active.  The derived
 * fallback is intentionally conservative for older snapshots which predate a
 * durable cooldownUntil field.
 */
export function isSourceCircuitOpen(
  health: SourceHealthForOrchestration | null | undefined,
  now = Date.now(),
  failureThreshold = DEFAULT_SOURCE_CIRCUIT_FAILURE_THRESHOLD,
): boolean {
  if (!health) return false;
  const persistedUntil = health.cooldownUntil ? Date.parse(health.cooldownUntil) : Number.NaN;
  if (Number.isFinite(persistedUntil)) return persistedUntil > now;
  const consecutiveFailures = health.consecutiveFailures ?? 0;
  const lastFailure = health.lastFailureAt ? Date.parse(health.lastFailureAt) : Number.NaN;
  return consecutiveFailures >= failureThreshold
    && Number.isFinite(lastFailure)
    && now - lastFailure < DEFAULT_SOURCE_CIRCUIT_COOLDOWN_MS;
}

/**
 * A browser fallback that has repeatedly produced no useful source result is
 * suppressed for a finite period.  Once the window expires the next crawl is
 * a normal probe, so the source is never permanently blacklisted.
 */
export function isBrowserFallbackSuppressed(
  health: SourceHealthForOrchestration | null | undefined,
  now = Date.now(),
  failureThreshold = DEFAULT_BROWSER_SUPPRESSION_FAILURE_THRESHOLD,
): boolean {
  if (!health) return false;
  const attempts = health.browserFallbackCount ?? health.browserFallbacks ?? 0;
  const successes = health.browserFallbackSuccesses ?? 0;
  const consecutiveFailures = health.consecutiveBrowserFallbackFailures;
  if (consecutiveFailures !== undefined) {
    if (consecutiveFailures < failureThreshold) return false;
  } else if (attempts < failureThreshold || successes > 0) {
    // Legacy snapshots have no ordering signal. Preserve their old
    // all-fallbacks-ineffective behavior until a fresh durable snapshot is
    // written with consecutiveBrowserFallbackFailures.
    return false;
  }
  // An HTTP failure must not extend the browser suppression window. The
  // health store supplies this timestamp from actual browser fallback work.
  const lastFallback = health.lastBrowserFallbackAt ? Date.parse(health.lastBrowserFallbackAt) : Number.NaN;
  return Number.isFinite(lastFallback)
    && now - lastFallback < DEFAULT_BROWSER_SUPPRESSION_COOLDOWN_MS;
}

/** Run every source to settlement so one rejection cannot abort sibling work. */
export async function settleSourceTasks<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = tasks.length,
): Promise<PromiseSettledResult<T>[]> {
  const results: Array<PromiseSettledResult<T>> = Array.from({ length: tasks.length });
  if (tasks.length === 0) return results;
  // Callers may pass an environment-derived value or a test double. Keep the
  // worker count finite and positive so NaN/Infinity cannot silently skip all
  // tasks (or produce an invalid Array length).
  const normalizedConcurrency = Number.isFinite(concurrency) && concurrency > 0
    ? Math.max(1, Math.floor(concurrency))
    : 1;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({
    length: Math.min(normalizedConcurrency, tasks.length),
  }, () => worker()));
  return results;
}

export interface SourceAttemptControl {
  /** Signal owned by this attempt, independent of sibling source signals. */
  signal: AbortSignal;
  /** Mark meaningful source progress and reset the inactivity watchdog. */
  markProgress: () => void;
  /** False after a timeout/cancellation won the attempt race. */
  isActive: () => boolean;
}

export interface SourceAttemptOptions {
  sourceUrl: string;
  maxDurationMs?: number;
  signal?: AbortSignal;
  /** Called synchronously when this source exceeds its inactivity budget. */
  onStall?: (error: SourceStalledError) => void;
  /** Injectable wall clock used by deterministic tests. */
  now?: () => number;
  /** Injectable timer functions used by deterministic tests. */
  setInterval?: (callback: () => void, delayMs: number) => ReturnType<typeof globalThis.setInterval> | number;
  clearInterval?: (timer: ReturnType<typeof globalThis.setInterval> | number) => void;
}

/**
 * Execute one source attempt with an isolated AbortController and watchdog.
 * A misbehaving adapter promise is deliberately detached after timeout, but
 * its rejection is observed immediately so it cannot become unhandled. The
 * caller can use control.isActive() before settling any result to prevent a
 * late first attempt from overwriting a deferred retry.
 */
export async function runIsolatedSourceAttempt<T>(
  options: SourceAttemptOptions,
  work: (control: SourceAttemptControl) => Promise<T>,
): Promise<T> {
  const sourceAbort = new AbortController();
  const now = options.now ?? Date.now;
  const setIntervalFn = options.setInterval ?? globalThis.setInterval;
  const clearIntervalFn = options.clearInterval ?? globalThis.clearInterval;
  let active = true;
  let lastProgressAt = now();
  let watchdogTimer: ReturnType<typeof globalThis.setInterval> | number | undefined;
  let removeRunAbortListener: (() => void) | undefined;
  const runSignal = options.signal;

  const abortForStall = (): SourceStalledError => {
    const stallMs = options.maxDurationMs ?? 0;
    const error = new SourceStalledError(
      options.sourceUrl,
      stallMs,
      `Source ${options.sourceUrl} stalled for ${stallMs}ms without progress.`,
    );
    active = false;
    if (!sourceAbort.signal.aborted) sourceAbort.abort(error);
    // A cleanup hook is part of the adapter boundary. If it throws, preserve
    // the watchdog's original stall outcome and reject the attempt rather
    // than allowing an exception to escape an interval callback.
    try {
      options.onStall?.(error);
    } catch {
      // The source attempt is already aborted; the caller still receives the
      // actionable SourceStalledError below.
    }
    return error;
  };

  const control: SourceAttemptControl = {
    signal: sourceAbort.signal,
    markProgress: () => {
      if (active && !sourceAbort.signal.aborted) lastProgressAt = now();
    },
    isActive: () => active && !sourceAbort.signal.aborted,
  };

  try {
    // Do not invoke an adapter after a run has already been cancelled. This
    // check also makes pre-aborted signals deterministic in tests.
    if (runSignal?.aborted) {
      active = false;
      const error = cancellationError(runSignal.reason);
      sourceAbort.abort(error);
      throw error;
    }
    const runCancellation = runSignal
      ? new Promise<never>((_resolve, reject) => {
        const onAbort = (): void => {
          active = false;
          const error = cancellationError(runSignal.reason);
          if (!sourceAbort.signal.aborted) sourceAbort.abort(error);
          reject(error);
        };
        runSignal.addEventListener("abort", onAbort, { once: true });
        removeRunAbortListener = () => runSignal.removeEventListener("abort", onAbort);
      })
      : null;
    // Keep adapter startup inside the cleanup boundary: a synchronous throw
    // from a malformed adapter must still detach the run listener/timer.
    const sourceWork = runWithSourceAbortSignal(sourceAbort.signal, () => work(control));
    // A timed-out third-party promise may resolve/reject after the race has
    // settled. Observe it immediately to keep process-wide rejection handling
    // deterministic.
    void sourceWork.catch(() => undefined);
    const timeoutPromise = options.maxDurationMs !== undefined && options.maxDurationMs > 0
      ? new Promise<never>((_resolve, reject) => {
        const intervalMs = Math.min(1_000, Math.max(10, Math.floor(options.maxDurationMs! / 4)));
        watchdogTimer = setIntervalFn(() => {
          if (!active || sourceAbort.signal.aborted || now() - lastProgressAt < options.maxDurationMs!) return;
          reject(abortForStall());
        }, intervalMs);
      })
      : null;
    const races: Array<Promise<unknown>> = [sourceWork];
    if (timeoutPromise) races.push(timeoutPromise);
    if (runCancellation) races.push(runCancellation);
    return await Promise.race(races) as T;
  } finally {
    active = false;
    if (watchdogTimer !== undefined) clearIntervalFn(watchdogTimer);
    removeRunAbortListener?.();
  }
}

export type SourceRetryability = (failure: Pick<FetchFailure, "errorType" | "statusCode">) => boolean;

/**
 * Decide whether a settled source deserves the single end-of-pass retry. A
 * source-level denial, missing page, cancellation, or open circuit is final
 * for this crawl. Mixed partial results may retry when at least one failure is
 * explicitly transport-retryable.
 */
export function sourceNeedsDeferredRetry(
  result: SourceCrawlResult,
  isRetryableFailure: SourceRetryability,
): boolean {
  if (isEarlyCareerRadarNotFoundPage(result.sourceUrl, result.httpStatus ?? null)) return false;
  if (isApplyBoltNotFoundPage(result.sourceUrl, result.httpStatus ?? null)) return false;
  if (result.coverageComplete || result.status === "no_internships_found") return false;
  if (["robots_disallowed", "access_denied", "authentication_required", "circuit_open"].includes(result.status ?? "")) return false;
  if (result.failures.length > 0) return result.failures.some((failure) => isRetryableFailure(failure));
  return ["partial", "rate_limited", "browser_error", "parse_error", "source_unavailable"].includes(result.status ?? "");
}

export function sourceCircuitOpenResult(sourceUrl: string, cooldownUntil: string | null = null): SourceCrawlResult {
  const suffix = cooldownUntil ? ` until ${cooldownUntil}` : " for this crawl";
  return {
    sourceUrl,
    pagesVisited: 0,
    potentialPostingsInspected: 0,
    jobs: [],
    failures: [{
      sourceUrl,
      url: sourceUrl,
      errorType: "circuit_open",
      message: `Source circuit is open${suffix}; probe deferred to a later crawl.`,
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    }],
    closedPages: [],
    completed: false,
    coverageComplete: false,
    status: "source_unavailable",
    retrievalMethod: "circuit breaker",
    attempts: 0,
    httpStatus: null,
    directApplicationLinks: 0,
    retrievalMode: "configured_url",
    retrievalUrls: [sourceUrl],
    coverageNotes: [`The source was skipped because its durable circuit is open${suffix}. No listings were treated as closed.`],
  };
}

/** Same settlement shape as an open circuit, with a diagnostic that explains
 * the adaptive browser decision while keeping the source outside coverage. */
export function browserFallbackSuppressedResult(sourceUrl: string): SourceCrawlResult {
  const result = sourceCircuitOpenResult(sourceUrl);
  return {
    ...result,
    retrievalMethod: "browser fallback suppression",
    failures: result.failures.map((failure) => ({
      ...failure,
      message: `Browser fallback is temporarily suppressed for ${sourceUrl} after repeated ineffective attempts; a later crawl will probe it again.`,
    })),
    coverageNotes: ["The HTTP/API strategy was retained, but repeated browser fallbacks yielded no useful source result; no listings were treated as closed."],
  };
}

export function invalidSourceResult(sourceUrl: string, reason = "Source URL is not a valid HTTP(S) URL."): SourceCrawlResult {
  return {
    sourceUrl,
    pagesVisited: 0,
    potentialPostingsInspected: 0,
    jobs: [],
    failures: [{
      sourceUrl,
      url: sourceUrl,
      errorType: "invalid_source",
      message: reason,
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    }],
    closedPages: [],
    completed: false,
    coverageComplete: false,
    status: "source_unavailable",
    retrievalMethod: "configuration",
    attempts: 0,
    httpStatus: null,
    directApplicationLinks: 0,
    retrievalMode: "configured_url",
    retrievalUrls: [sourceUrl],
    coverageNotes: ["The invalid source was isolated; healthy sibling sources continued."],
  };
}

export function isSourceAttemptStall(error: unknown): error is SourceStalledError {
  return isSourceStalledError(error);
}
