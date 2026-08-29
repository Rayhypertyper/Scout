/**
 * A run whose last heartbeat is older than this is treated as abandoned: the
 * next start (or the dashboard watcher) closes it as failed so a dead worker
 * cannot block later crawls. Live crawls refresh the lease every
 * `RUN_HEARTBEAT_INTERVAL_MS`.
 */
export const RUNNING_SCAN_MAX_AGE_MS = 20 * 60 * 1_000;

/**
 * Absolute wall-clock limit for one crawl. Heartbeats deliberately do not
 * extend this limit: a busy or pathological source must never keep a run
 * alive indefinitely just because the worker is still emitting heartbeats.
 */
export const RUN_MAX_DURATION_MS = 45 * 60 * 1_000;

/** The cache refresher is independent of a crawl and gets its own shorter cap. */
export const JOBRIGHT_RESOLVER_MAX_DURATION_MS = 20 * 60 * 1_000;

/**
 * Keep the lease alive well inside the abandoned-run window. A heartbeat lets
 * a legitimate crawl survive past its original start time while still
 * allowing a dead process to be recovered later.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 60_000;

/**
 * Maximum inactivity window for one source on the normal pass. A source is
 * aborted and deferred when it stops emitting progress for this long.
 */
export const SOURCE_MAX_DURATION_MS = 5 * 60 * 1_000;

/** Maximum inactivity window for a source's one deferred retry at run end. */
export const SOURCE_RETRY_MAX_DURATION_MS = 15 * 60 * 1_000;

// Keep the old names for callers compiled against the initial stall guard.
export const SOURCE_STALL_MS = SOURCE_MAX_DURATION_MS;
export const SOURCE_RETRY_STALL_MS = SOURCE_RETRY_MAX_DURATION_MS;

let runMaxDurationMsOverride: number | null = null;

/** Test-only clock override; production callers always use RUN_MAX_DURATION_MS. */
export function activeRunMaxDurationMs(): number {
  return runMaxDurationMsOverride ?? RUN_MAX_DURATION_MS;
}

export function setRunMaxDurationForTests(durationMs: number | null): void {
  runMaxDurationMsOverride = durationMs;
}
