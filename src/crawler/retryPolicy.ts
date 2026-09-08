import { sleep } from "../utils/async.js";
import {
  CrawlCancelledError,
  CrawlDeadlineExceededError,
  SourceStalledError,
  throwIfAborted,
} from "../domain/cancellation.js";

/** Status codes for which another transport attempt can be useful. */
export const RETRYABLE_HTTP_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);

/** A bounded, actionable vocabulary shared by HTTP, browser, and source runs. */
export type RetryFailureKind =
  | "timeout"
  | "network_error"
  | "rate_limited"
  | "http_error"
  | "browser_error"
  | "navigation_error"
  | "page_timeout"
  | "access_denied"
  | "not_found"
  | "gone"
  | "robots_disallowed"
  | "robots_unavailable"
  | "circuit_open"
  | "cancelled"
  | "parse_error"
  | "unknown";

export interface RetryFailureInput {
  errorType?: string | null;
  statusCode?: number | null;
  retryAfterMs?: number | null;
  message?: string;
}

export interface NormalizedRetryFailure {
  kind: RetryFailureKind;
  statusCode: number | null;
  retryAfterMs: number | null;
  message: string;
  retryable: boolean;
}

export interface RetryBackoffOptions {
  /** Local base delay before jitter. Defaults to one second. */
  baseDelayMs?: number;
  /** Local maximum delay. A server delay above this is returned uncapped. */
  maxDelayMs?: number;
  /** Maximum additive jitter. Defaults to 250ms. */
  jitterMs?: number;
  /** Deterministic value in [0, 1] for tests and controlled callers. */
  random?: number;
}

export interface RetryDecisionOptions extends RetryBackoffOptions {
  /** Zero based attempt currently being evaluated. */
  attempt: number;
  /** Number of additional attempts permitted, preserving settings.retryCount semantics. */
  retryCount: number;
  failure: RetryFailureInput | NormalizedRetryFailure;
  /** Remaining source/run budget available for a new attempt, when known. */
  remainingBudgetMs?: number;
}

export type RetryDecisionReason =
  | "retryable"
  | "permanent"
  | "exhausted"
  | "retry_after_exceeds_budget"
  | "cancelled";

export interface RetryDecision {
  retry: boolean;
  /** True when a later source/run boundary should defer this failure. */
  deferred: boolean;
  reason: RetryDecisionReason;
  delayMs: number;
  retryAfterMs: number | null;
  attempt: number;
  retryCount: number;
}

export interface ExecuteWithRetryOptions extends RetryBackoffOptions {
  retryCount: number;
  signal?: AbortSignal;
  operation: (attempt: number) => Promise<unknown>;
  /** Optional explicit failure fields when an operation throws an untyped error. */
  classify?: (error: unknown) => RetryFailureInput;
  remainingBudgetMs?: number | (() => number);
  onRetry?: (decision: RetryDecision, failure: NormalizedRetryFailure) => void | Promise<void>;
}

const RETRYABLE_KINDS = new Set<RetryFailureKind>([
  "timeout",
  "network_error",
  "rate_limited",
  "http_error",
  "browser_error",
  "navigation_error",
  "page_timeout",
  "parse_error",
]);

const PERMANENT_KINDS = new Set<RetryFailureKind>([
  "access_denied",
  "not_found",
  "gone",
  "robots_disallowed",
  "robots_unavailable",
  "cancelled",
]);

function finiteOr(value: number | null | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function statusKind(statusCode: number | null): RetryFailureKind | null {
  if (statusCode === 401 || statusCode === 403) return "access_denied";
  if (statusCode === 404) return "not_found";
  if (statusCode === 410) return "gone";
  if (statusCode === 429) return "rate_limited";
  if (statusCode !== null && RETRYABLE_HTTP_STATUS_CODES.has(statusCode)) return "http_error";
  return null;
}

function normalizeKind(value: string | null | undefined): RetryFailureKind | null {
  const kind = value?.trim().toLocaleLowerCase();
  if (!kind) return null;
  if (kind === "abort" || kind === "aborted" || kind === "abort_error" || kind === "cancelled" || kind === "canceled") return "cancelled";
  if (kind === "timeout_error") return "timeout";
  if (kind === "network") return "network_error";
  if (kind === "rate_limit" || kind === "rate-limit" || kind === "too_many_requests") return "rate_limited";
  if (kind === "notfound" || kind === "not-found") return "not_found";
  if (kind === "http" || kind === "status_error") return "http_error";
  if (kind === "browser") return "browser_error";
  if (kind === "navigation") return "navigation_error";
  if (kind === "page-timeout") return "page_timeout";
  if (kind === "access-denied" || kind === "forbidden" || kind === "unauthorized") return "access_denied";
  if (kind === "authentication_required" || kind === "auth_required") return "access_denied";
  if (kind === "closed" || kind === "gone") return "gone";
  if (kind === "robots-disallowed") return "robots_disallowed";
  if (kind === "robots-unavailable") return "robots_unavailable";
  if (kind === "circuit-open") return "circuit_open";
  if (kind === "parse") return "parse_error";
  if (([...RETRYABLE_KINDS, ...PERMANENT_KINDS] as string[]).includes(kind)) return kind as RetryFailureKind;
  return "unknown";
}

function isNormalizedFailure(value: RetryFailureInput | NormalizedRetryFailure): value is NormalizedRetryFailure {
  return "kind" in value && typeof value.kind === "string" && "retryable" in value;
}

/** Parse Retry-After as seconds or an HTTP date without truncating server guidance. */
export function parseRetryAfter(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const normalized = value.trim();
  if (!normalized) return null;
  // Only parse a numeric Retry-After token as a delay. Date.parse accepts
  // surprising values such as "-1" and can turn malformed input into a
  // seemingly valid historical date.
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/iu.test(normalized)) {
    const seconds = Number(normalized);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1_000) : null;
  }
  const timestamp = Date.parse(normalized);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - now);
}

/**
 * Convert an arbitrary transport/source error into the shared failure
 * vocabulary. Explicit status codes always win over a generic error label so
 * 404/410 can never accidentally become retryable http_error values.
 */
export function normalizeRetryFailure(error: unknown, input: RetryFailureInput = {}): NormalizedRetryFailure {
  const record = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const statusValue = input.statusCode ?? (typeof record.statusCode === "number" ? record.statusCode : null);
  const statusCode = typeof statusValue === "number" && Number.isFinite(statusValue) ? statusValue : null;
  const retryAfterValue = input.retryAfterMs ?? (typeof record.retryAfterMs === "number" ? record.retryAfterMs : null);
  const retryAfterMs = typeof retryAfterValue === "number" && Number.isFinite(retryAfterValue) && retryAfterValue >= 0 ? retryAfterValue : null;
  const messageValue = input.message ?? (error instanceof Error ? error.message : typeof record.message === "string" ? record.message : null);
  const message = messageValue ?? "Unknown failure";
  const explicitKind = normalizeKind(input.errorType ?? (typeof record.errorType === "string" ? record.errorType : null));
  const statusFailure = statusKind(statusCode);
  const errorName = error instanceof Error ? error.name : "";
  const abortLike = error instanceof CrawlCancelledError
    || error instanceof CrawlDeadlineExceededError
    || error instanceof SourceStalledError
    || errorName === "AbortError"
    || errorName === "CanceledError";
  const kind = abortLike
    ? "cancelled"
    : statusFailure ?? explicitKind ?? (/(?:timeout|timed out|aborted due to timeout)/i.test(message) ? "timeout" : "unknown");
  const retryable = !PERMANENT_KINDS.has(kind)
    && (statusCode === null ? RETRYABLE_KINDS.has(kind) : RETRYABLE_HTTP_STATUS_CODES.has(statusCode));
  return { kind, statusCode, retryAfterMs, message, retryable };
}

/** Whether a failure is eligible for a bounded retry at some later boundary. */
export function isRetryableFailure(input: Pick<RetryFailureInput, "errorType" | "statusCode"> | NormalizedRetryFailure): boolean {
  const failure = isNormalizedFailure(input) ? input : normalizeRetryFailure(undefined, input);
  return failure.retryable;
}

function normalizedBackoffOptions(options: RetryBackoffOptions | undefined): Required<RetryBackoffOptions> {
  const baseDelayMs = Math.max(0, finiteOr(options?.baseDelayMs, 1_000));
  const maxDelayMs = Math.max(0, finiteOr(options?.maxDelayMs, 300_000));
  const jitterMs = Math.max(0, finiteOr(options?.jitterMs, 250));
  const random = Math.max(0, Math.min(1, finiteOr(options?.random, Math.random())));
  return { baseDelayMs, maxDelayMs, jitterMs, random };
}

/**
 * Calculate bounded exponential backoff with jitter. Retry-After is a floor;
 * when it exceeds the local maximum, the full server delay is returned so a
 * caller can defer instead of retrying early.
 */
export function retryDelayMs(attempt: number, retryAfterMs: number | null, options?: RetryBackoffOptions): number {
  const normalized = normalizedBackoffOptions(options);
  const safeAttempt = Math.max(0, Math.floor(finiteOr(attempt, 0)));
  const exponential = Math.min(normalized.maxDelayMs, normalized.baseDelayMs * (2 ** Math.min(safeAttempt, 30)));
  const serverDelay = retryAfterMs !== null && Number.isFinite(retryAfterMs) && retryAfterMs >= 0 ? retryAfterMs : 0;
  const floor = Math.max(exponential, serverDelay);
  if (serverDelay > normalized.maxDelayMs) return serverDelay;
  return Math.min(normalized.maxDelayMs, floor + Math.floor(normalized.random * normalized.jitterMs));
}

/** Decide whether the current failure can consume another bounded attempt. */
export function decideRetry(options: RetryDecisionOptions): RetryDecision {
  const failure = isNormalizedFailure(options.failure) ? options.failure : normalizeRetryFailure(undefined, options.failure);
  const attempt = Math.max(0, Math.floor(finiteOr(options.attempt, 0)));
  const retryCount = Math.max(0, Math.floor(finiteOr(options.retryCount, 0)));
  const delayMs = retryDelayMs(attempt, failure.retryAfterMs, options);
  const base = { delayMs, retryAfterMs: failure.retryAfterMs, attempt, retryCount };
  if (failure.kind === "cancelled") return { ...base, retry: false, deferred: false, reason: "cancelled" };
  if (!failure.retryable) return { ...base, retry: false, deferred: false, reason: "permanent" };
  if (attempt >= retryCount) return { ...base, retry: false, deferred: false, reason: "exhausted" };
  const maxDelayMs = Math.max(0, finiteOr(options.maxDelayMs, 300_000));
  const remainingBudgetMs = options.remainingBudgetMs === undefined
    ? null
    : Math.max(0, finiteOr(options.remainingBudgetMs, 0));
  if (delayMs > maxDelayMs || (remainingBudgetMs !== null && delayMs > remainingBudgetMs)) {
    return { ...base, retry: false, deferred: true, reason: "retry_after_exceeds_budget" };
  }
  return { ...base, retry: true, deferred: false, reason: "retryable" };
}

/**
 * Optional common loop for small adapters. Existing HTTP/browser loops keep
 * their wrappers and can adopt this incrementally without changing attempts
 * semantics.
 */
export async function executeWithRetry<T>(options: ExecuteWithRetryOptions): Promise<T> {
  const operation = options.operation as (attempt: number) => Promise<T>;
  const classify = options.classify ?? (() => ({}));
  const retryCount = Math.max(0, Math.floor(finiteOr(options.retryCount, 0)));
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    throwIfAborted(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      throwIfAborted(options.signal);
      const explicit = classify(error);
      const normalized = normalizeRetryFailure(error, explicit);
      const remaining = typeof options.remainingBudgetMs === "function" ? options.remainingBudgetMs() : options.remainingBudgetMs;
      const decision = decideRetry({
        attempt,
        retryCount,
        failure: normalized,
        ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
        ...(options.maxDelayMs === undefined ? {} : { maxDelayMs: options.maxDelayMs }),
        ...(options.jitterMs === undefined ? {} : { jitterMs: options.jitterMs }),
        ...(options.random === undefined ? {} : { random: options.random }),
        ...(remaining === undefined ? {} : { remainingBudgetMs: remaining }),
      });
      if (!decision.retry) throw error;
      await options.onRetry?.(decision, normalized);
      await sleep(decision.delayMs, options.signal);
    }
  }
  throw new Error("Retry loop exhausted without an operation result.");
}
