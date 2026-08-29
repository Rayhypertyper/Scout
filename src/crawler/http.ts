import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { ScoutSettings } from "../domain/schemas.js";
import { sha256 } from "../utils/hash.js";
import { redactSensitiveText, redactSensitiveUrl, canonicalizeUrl } from "../utils/url.js";
import { Semaphore, sleep } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";
import { HostRateLimiter } from "./rateLimiter.js";
import type { Profiler } from "../observability/profiler.js";
import { composeAbortSignals, currentSourceAbortSignal, throwIfAborted } from "../domain/cancellation.js";

const RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const MAX_CACHE_BODY_BYTES = 12_000_000;
const MAX_CIRCUIT_STATE_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_REDIRECTS = 10;
/** Public boards whose HTML/XML responses routinely exceed the default
 * connect+read budget. A 10s abort looks like a dead origin when Cloudflare
 * or a large sitemap is still streaming the first byte. */
const SLOW_PUBLIC_BOARD_HOST = /(?:^|\.)(?:csjobs\.ca|hiringcafe\.com)$/i;
const SLOW_PUBLIC_BOARD_REQUEST_TIMEOUT_MS = 30_000;
const SLOW_PUBLIC_BOARD_RETRY_COUNT = 3;

export interface RobotsPolicySnapshot {
  allowed: boolean;
  crawlDelayMs: number | null;
}

export type RobotsPolicyChecker = (url: string) => Promise<RobotsPolicySnapshot>;

export interface HttpResponseSnapshot {
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  attempts: number;
  fromCache: boolean;
  /** True when a transient transport failure caused an expired cache entry to be served. */
  stale?: boolean;
}

export class HttpRequestError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly attempts: number,
    public readonly errorType: string,
    public readonly retryAfterMs: number | null = null,
    public readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "HttpRequestError";
  }
}

/** Detects AbortSignal/undici timeout errors without treating crawl cancellation as a timeout. */
export function isTimeoutError(error: unknown): boolean {
  const name = error instanceof Error ? error.name : "";
  const message = error instanceof Error ? error.message : String(error);
  return name === "TimeoutError" || /(?:aborted due to timeout|timed out|timeout)/i.test(message);
}

/** Whether a failed HTTP attempt may safely fall back to a previously cached representation. */
export function isTransientHttpRequestError(error: unknown): boolean {
  if (!(error instanceof HttpRequestError)) return isTimeoutError(error);
  return error.errorType === "timeout"
    || error.errorType === "network_error"
    || error.errorType === "rate_limited"
    || (error.statusCode !== null && RETRYABLE_STATUS_CODES.has(error.statusCode));
}

interface CacheEntry {
  url: string;
  status: number;
  contentType: string;
  body: string;
  headers: Record<string, string>;
  storedAt: number;
}

interface CircuitEntry {
  consecutiveFailures: number;
  openUntil: number;
  reason: string;
  updatedAt: number;
}

function headerMap(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

interface HttpRequestOptions {
  headers?: HeadersInit;
  cache?: boolean;
  perHostDelayMs?: number;
  method?: "GET" | "POST";
  body?: string;
  cacheKey?: string;
  /** Optional per-request deadline for feeds whose response is larger than a normal page. */
  timeoutMs?: number;
  /** Optional per-request retry budget for a feed-specific recovery policy. */
  retryCount?: number;
  /** Serve an expired successful cache entry after a transient transport failure. */
  staleIfError?: boolean;
  /** Explicit owner-authorized source exception; all ordinary requests keep robots enforcement. */
  respectRobots?: boolean;
}

interface AuthorizedFetchResult {
  response: Response;
  url: string;
}

type InFlightRequestMap = Map<AbortSignal | undefined, Promise<HttpResponseSnapshot>>;

function isRobotsTxtUrl(value: string): boolean {
  try {
    const pathname = new URL(value).pathname;
    return pathname === "/robots.txt" || pathname === "/robots.txt/";
  } catch {
    return false;
  }
}

export function parseRetryAfterHeader(value: string | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(300_000, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(300_000, Math.max(0, timestamp - now));
}

export function retryDelayMs(attempt: number, retryAfterMs: number | null, baseDelayMs = 1_000, random = Math.random()): number {
  const exponential = Math.min(300_000, baseDelayMs * (2 ** attempt));
  const jitter = Math.floor(Math.max(0, Math.min(999, random * 1_000)));
  return Math.min(300_000, Math.max(exponential, retryAfterMs ?? 0) + jitter);
}

export class HttpClient {
  private readonly globalSemaphore: Semaphore;
  private readonly domainSemaphores = new Map<string, Semaphore>();
  private readonly rateLimiter = new HostRateLimiter();
  private readonly circuits = new Map<string, CircuitEntry>();
  private readonly pressure = new Map<string, { delayMs: number; strikes: number }>();
  private readonly cacheEntries = new Map<string, CacheEntry>();
  /** Share duplicate requests within one source, but never make one source's
   * abort signal cancel a sibling source's copy of the same request. */
  private readonly inFlight = new Map<string, InFlightRequestMap>();
  private readonly cacheDirectory: string;
  private readonly circuitStatePath: string;
  private readonly ready: Promise<void>;
  private circuitPersistence: Promise<void> = Promise.resolve();
  private robotsPolicyChecker: RobotsPolicyChecker | null = null;
  private requestCount = 0;
  private cacheHitCount = 0;

  public constructor(
    private readonly settings: ScoutSettings,
    private readonly logger: Logger,
    private readonly profiler?: Profiler,
    private readonly cancellationSignal?: AbortSignal,
  ) {
    // Node 24's native fetch is backed by undici and keeps connections pooled
    // by origin. The semaphore bounds application-level pressure while still
    // allowing the HTTP lane to be materially wider than the browser lane.
    this.globalSemaphore = new Semaphore(Math.max(1, settings.httpConcurrency));
    this.cacheDirectory = join(settings.outputDirectory, "source-cache", "http");
    this.circuitStatePath = join(settings.outputDirectory, "source-cache", "circuit-breakers.json");
    this.ready = this.initialize();
  }

  public async get(url: string, options: Pick<HttpRequestOptions, "headers" | "cache" | "perHostDelayMs" | "timeoutMs" | "retryCount" | "staleIfError" | "respectRobots"> = {}): Promise<HttpResponseSnapshot> {
    throwIfAborted(this.activeSignal());
    await this.ready;
    throwIfAborted(this.activeSignal());
    const requestedUrl = canonicalizeUrl(url);
    const requestHeaders = new Headers(options.headers);
    // Include caller-provided header values in the de-duplication key. This
    // prevents an authenticated GitHub request from sharing a public request
    // already in flight for the same URL.
    const requestKey = `GET\n${requestedUrl}\nrobots=${options.respectRobots === false ? "off" : "on"}\n${[...requestHeaders.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join("\n")}`;
    const ownerSignal = currentSourceAbortSignal();
    const previous = this.inFlight.get(requestKey)?.get(ownerSignal);
    if (previous && !ownerSignal?.aborted) return previous;
    if (previous) this.inFlight.get(requestKey)?.delete(ownerSignal);
    const operation = this.requestWithRobots(requestedUrl, options, requestHeaders);
    const shared = operation.finally(() => {
      const owners = this.inFlight.get(requestKey);
      if (owners?.get(ownerSignal) === shared) {
        owners.delete(ownerSignal);
        if (owners.size === 0) this.inFlight.delete(requestKey);
      }
    });
    const owners = this.inFlight.get(requestKey) ?? new Map<AbortSignal | undefined, Promise<HttpResponseSnapshot>>();
    owners.set(ownerSignal, shared);
    this.inFlight.set(requestKey, owners);
    return shared;
  }

  /** POST JSON through the same bounded, cached, retrying transport as GET. */
  public async postJson(url: string, body: unknown, options: Pick<HttpRequestOptions, "headers" | "cache" | "perHostDelayMs" | "timeoutMs" | "retryCount" | "respectRobots"> = {}): Promise<HttpResponseSnapshot> {
    throwIfAborted(this.activeSignal());
    await this.ready;
    throwIfAborted(this.activeSignal());
    const requestedUrl = canonicalizeUrl(url);
    const serializedBody = JSON.stringify(body);
    const requestHeaders = new Headers(options.headers);
    requestHeaders.set("content-type", requestHeaders.get("content-type") ?? "application/json");
    const requestKey = `POST\n${requestedUrl}\nrobots=${options.respectRobots === false ? "off" : "on"}\n${serializedBody}\n${[...requestHeaders.entries()].toSorted(([left], [right]) => left.localeCompare(right)).map(([key, value]) => `${key}:${value}`).join("\n")}`;
    const ownerSignal = currentSourceAbortSignal();
    const previous = this.inFlight.get(requestKey)?.get(ownerSignal);
    if (previous && !ownerSignal?.aborted) return previous;
    if (previous) this.inFlight.get(requestKey)?.delete(ownerSignal);
    const operation = this.requestWithRobots(requestedUrl, {
      ...options,
      method: "POST",
      body: serializedBody,
      cacheKey: `${requestedUrl}\n${serializedBody}`,
    }, requestHeaders);
    const shared = operation.finally(() => {
      const owners = this.inFlight.get(requestKey);
      if (owners?.get(ownerSignal) === shared) {
        owners.delete(ownerSignal);
        if (owners.size === 0) this.inFlight.delete(requestKey);
      }
    });
    const owners = this.inFlight.get(requestKey) ?? new Map<AbortSignal | undefined, Promise<HttpResponseSnapshot>>();
    owners.set(ownerSignal, shared);
    this.inFlight.set(requestKey, owners);
    return shared;
  }

  public get metrics(): { httpRequests: number; cacheHits: number } {
    return { httpRequests: this.requestCount, cacheHits: this.cacheHitCount };
  }

  /**
   * Attach the crawl-wide robots policy after the client is constructed.
   *
   * The crawler creates HttpClient before RobotsManager, so this small
   * callback boundary keeps policy enforcement in the transport without
   * introducing a module cycle. Standalone HttpClient users remain unchanged
   * until a policy checker is attached.
   */
  public attachRobotsPolicy(checker: RobotsPolicyChecker): void {
    this.robotsPolicyChecker = checker;
  }

  /** Run-level cancellation composed with the current source stall abort. */
  private activeSignal(): AbortSignal | undefined {
    return composeAbortSignals(this.cancellationSignal, currentSourceAbortSignal());
  }

  private fetchSignal(timeoutMs: number): AbortSignal {
    const crawl = this.activeSignal();
    return crawl ? AbortSignal.any([AbortSignal.timeout(timeoutMs), crawl]) : AbortSignal.timeout(timeoutMs);
  }

  private async requestWithRobots(
    requestedUrl: string,
    options: HttpRequestOptions,
    callerHeaders: Headers,
  ): Promise<HttpResponseSnapshot> {
    const respectRobots = options.respectRobots !== false;
    const policy = respectRobots ? await this.policyFor(requestedUrl) : null;
    return this.requestInternal(requestedUrl, options, callerHeaders, policy?.crawlDelayMs ?? null, respectRobots);
  }

  private async policyFor(value: string): Promise<RobotsPolicySnapshot | null> {
    if (!this.settings.respectRobotsTxt || !this.robotsPolicyChecker || isRobotsTxtUrl(value)) return null;
    let policy: RobotsPolicySnapshot;
    try {
      policy = await this.robotsPolicyChecker(value);
    } catch (error) {
      throw new HttpRequestError(
        `Could not verify robots.txt for ${redactSensitiveUrl(value)}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`,
        null,
        0,
        "robots_unavailable",
      );
    }
    if (!policy.allowed) throw new HttpRequestError("Disallowed by robots.txt", null, 0, "robots_disallowed");
    return policy;
  }

  private async requestInternal(
    requestedUrl: string,
    options: HttpRequestOptions,
    callerHeaders: Headers,
    robotsDelayMs: number | null,
    respectRobots: boolean,
  ): Promise<HttpResponseSnapshot> {
    const domain = new URL(requestedUrl).hostname.toLocaleLowerCase();
    const domainSemaphore = this.domainSemaphores.get(domain) ?? new Semaphore(this.domainConcurrency(domain));
    this.domainSemaphores.set(domain, domainSemaphore);
    return this.globalSemaphore.use(() => domainSemaphore.use(async () => {
      throwIfAborted(this.activeSignal());
      // Never persist credential-scoped responses in the URL-only cache. A
      // token-bearing GitHub request must not poison the anonymous response
      // for the same endpoint (and credentials must never enter cache paths).
      const credentialed = callerHeaders.has("authorization") || callerHeaders.has("cookie");
      const cacheEnabled = (options.cache ?? true) && !credentialed;
      const method = options.method ?? "GET";
      const cachePath = join(this.cacheDirectory, `${sha256(options.cacheKey ?? requestedUrl)}.json`);
      const cacheEntry = cacheEnabled ? await this.readCache(cachePath) : null;
      if (cacheEntry && this.settings.cacheTtlMs > 0 && Date.now() - cacheEntry.storedAt <= this.settings.cacheTtlMs) {
        this.cacheHitCount += 1;
        return {
          requestedUrl,
          url: cacheEntry.url,
          status: cacheEntry.status,
          contentType: cacheEntry.contentType,
          body: cacheEntry.body,
          headers: cacheEntry.headers,
          attempts: 0,
          fromCache: true,
        };
      }

      const circuit = this.circuits.get(domain);
      if (circuit && circuit.openUntil > Date.now()) {
        throw new HttpRequestError(
          `Circuit open for ${domain} until ${new Date(circuit.openUntil).toISOString()} (${circuit.reason})`,
          null,
          0,
          "circuit_open",
        );
      }

      const headers = callerHeaders;
      headers.set("user-agent", this.settings.userAgent);
      headers.set("accept", headers.get("accept") ?? "text/html,application/xhtml+xml,application/json,text/plain;q=0.8");
      if (method === "GET") {
        if (cacheEntry?.headers.etag) headers.set("if-none-match", cacheEntry.headers.etag);
        if (cacheEntry?.headers["last-modified"]) headers.set("if-modified-since", cacheEntry.headers["last-modified"]);
      }

      let lastError: HttpRequestError | null = null;
      const defaultTimeoutMs = SLOW_PUBLIC_BOARD_HOST.test(domain)
        ? Math.max(SLOW_PUBLIC_BOARD_REQUEST_TIMEOUT_MS, this.settings.timeoutMs)
        : Math.min(this.settings.timeoutMs, this.settings.connectTimeoutMs + this.settings.readTimeoutMs);
      const requestTimeoutMs = Math.min(300_000, Math.max(1_000, options.timeoutMs ?? defaultTimeoutMs));
      const slowBoardRetryCount = this.settings.retryCount > 0 ? Math.max(this.settings.retryCount, SLOW_PUBLIC_BOARD_RETRY_COUNT) : this.settings.retryCount;
      const retryCount = Math.max(0, options.retryCount ?? (SLOW_PUBLIC_BOARD_HOST.test(domain) ? slowBoardRetryCount : this.settings.retryCount));
      for (let attempt = 0; attempt <= retryCount; attempt += 1) {
        if (attempt > 0) this.profiler?.increment("retries");
        await this.rateLimiter.wait(
          requestedUrl,
          this.effectiveHostDelay(domain, options.perHostDelayMs ?? this.settings.perHostDelayMs),
          robotsDelayMs,
          Number.POSITIVE_INFINITY,
          this.activeSignal(),
        );
        throwIfAborted(this.activeSignal());
        const fetchStartedAt = performance.now();
        try {
          const fetched = await this.fetchWithAuthorizedRedirects(requestedUrl, {
            method,
            headers,
            ...(options.body && method !== "GET" ? { body: options.body } : {}),
            // Native fetch does not expose a portable connect/read split. The
            // sum remains bounded by the staged budgets and is short enough
            // to isolate a stalled origin from unrelated queue workers.
            signal: this.fetchSignal(requestTimeoutMs),
          }, attempt, options.perHostDelayMs ?? this.settings.perHostDelayMs, respectRobots);
          const response = fetched.response;
          const responseHeaders = headerMap(response.headers);
          const retryAfterMs = parseRetryAfterHeader(responseHeaders["retry-after"]);
          if (method === "GET" && response.status === 304 && cacheEntry) {
            this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain });
            this.cacheHitCount += 1;
            const refreshed: CacheEntry = { ...cacheEntry, storedAt: Date.now(), headers: { ...cacheEntry.headers, ...responseHeaders } };
            await this.writeCache(cachePath, refreshed);
            this.recordSuccess(domain);
            return {
              requestedUrl,
              url: refreshed.url,
              status: refreshed.status,
              contentType: refreshed.contentType,
              body: refreshed.body,
              headers: refreshed.headers,
              attempts: attempt + 1,
              fromCache: true,
            };
          }

          if (response.status === 401 || response.status === 403) {
            const message = `HTTP ${response.status} access denied`;
            this.recordCircuitFailure(domain, response.status, message);
            this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain, status: "error" }, "error");
            throw new HttpRequestError(message, response.status, attempt, "access_denied", null, responseHeaders);
          }
          if (response.status === 404) {
            const message = "HTTP 404 not found";
            this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain, status: "error" }, "error");
            throw new HttpRequestError(message, response.status, attempt, "not_found", null, responseHeaders);
          }

          const body = (await response.text()).slice(0, MAX_CACHE_BODY_BYTES);
          if (!response.ok) {
            this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain, status: "error" }, "error");
            const message = `HTTP ${response.status}`;
            this.notePressure(domain, response.status);
            if (!RETRYABLE_STATUS_CODES.has(response.status) || attempt >= retryCount) {
              if (response.status === 429) this.recordCircuitFailure(domain, response.status, message);
              throw new HttpRequestError(message, response.status, attempt, response.status === 429 ? "rate_limited" : "http_error", retryAfterMs, responseHeaders);
            }
            lastError = new HttpRequestError(message, response.status, attempt, response.status === 429 ? "rate_limited" : "http_error", retryAfterMs, responseHeaders);
            const delay = retryDelayMs(attempt, retryAfterMs, this.isWellfound(domain) ? 30_000 : 1_000);
            this.logger.warn("RETRY", `${redactSensitiveUrl(requestedUrl)} after ${delay}ms (${attempt + 1}/${retryCount}) for HTTP ${response.status}`);
            await sleep(delay, this.activeSignal());
            continue;
          }

          this.recordSuccess(domain);
          this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain });
          const snapshot: HttpResponseSnapshot = {
            requestedUrl,
            url: response.url || fetched.url || requestedUrl,
            status: response.status,
            contentType: responseHeaders["content-type"] ?? "",
            body,
            headers: responseHeaders,
            attempts: attempt + 1,
            fromCache: false,
          };
          if (cacheEnabled && response.status >= 200 && response.status < 300 && body.length <= MAX_CACHE_BODY_BYTES) {
            await this.writeCache(cachePath, {
              url: snapshot.url,
              status: snapshot.status,
              contentType: snapshot.contentType,
              body: snapshot.body,
              headers: responseHeaders,
              storedAt: Date.now(),
            });
          }
          return snapshot;
        } catch (error) {
          throwIfAborted(this.activeSignal());
          if (!(error instanceof HttpRequestError)) this.profiler?.recordSpan("http_fetch", performance.now() - fetchStartedAt, { url: requestedUrl, domain, status: "error" }, "error");
          if (error instanceof HttpRequestError) {
            lastError = error;
            if (
              error.errorType === "access_denied"
              || error.errorType === "not_found"
              || error.errorType === "circuit_open"
              || error.errorType === "robots_disallowed"
              || error.errorType === "robots_unavailable"
              || error.errorType === "redirect_error"
            ) throw error;
            if (cacheEntry && this.shouldServeStaleCache(error, options, cacheEntry, attempt, retryCount)) {
              return this.staleCacheSnapshot(requestedUrl, cacheEntry, attempt, domain);
            }
            if (attempt >= retryCount) throw new HttpRequestError(error.message, error.statusCode, attempt, error.errorType, error.retryAfterMs, error.headers);
            const delay = retryDelayMs(attempt, error.retryAfterMs, this.isWellfound(domain) ? 30_000 : 1_000);
            this.logger.warn("RETRY", `${redactSensitiveUrl(requestedUrl)} after ${delay}ms (${attempt + 1}/${retryCount}): ${error.message}`);
            await sleep(delay, this.activeSignal());
            continue;
          }
          const message = error instanceof Error ? error.message : String(error);
          lastError = new HttpRequestError(redactSensitiveText(message), null, attempt, isTimeoutError(error) ? "timeout" : "network_error");
          if (cacheEntry && this.shouldServeStaleCache(lastError, options, cacheEntry, attempt, retryCount)) {
            return this.staleCacheSnapshot(requestedUrl, cacheEntry, attempt, domain);
          }
          if (attempt >= retryCount) throw lastError;
          const delay = retryDelayMs(attempt, null, this.isWellfound(domain) ? 30_000 : 1_000);
          this.logger.warn("RETRY", `${redactSensitiveUrl(requestedUrl)} after ${delay}ms (${attempt + 1}/${retryCount}): ${redactSensitiveText(message)}`);
          await sleep(delay, this.activeSignal());
        }
      }
      throw lastError ?? new HttpRequestError("HTTP request failed", null, retryCount, "network_error");
    }, this.activeSignal()), this.activeSignal());
  }

  /**
   * Follow redirects one hop at a time so a redirect cannot move the crawl
   * onto an origin or path that robots.txt disallows. Native fetch's
   * "follow" mode hides that boundary and can also carry caller credentials
   * across origins.
   */
  private async fetchWithAuthorizedRedirects(
    initialUrl: string,
    init: RequestInit,
    attempt: number,
    configuredDelayMs: number,
    respectRobots: boolean,
  ): Promise<AuthorizedFetchResult> {
    let currentUrl = initialUrl;
    let currentMethod = init.method ?? "GET";
    let currentBody = init.body;
    const currentHeaders = new Headers(init.headers);
    const robotsResource = isRobotsTxtUrl(initialUrl);

    for (let redirectCount = 0; ; redirectCount += 1) {
      this.requestCount += 1;
      const response = await fetch(currentUrl, {
        ...init,
        method: currentMethod,
        headers: currentHeaders,
        ...(currentBody === undefined ? {} : { body: currentBody }),
        redirect: "manual",
      });
      if (!REDIRECT_STATUS_CODES.has(response.status)) return { response, url: currentUrl };

      const location = response.headers.get("location");
      if (!location) return { response, url: currentUrl };
      if (redirectCount >= MAX_REDIRECTS) {
        throw new HttpRequestError(
          `HTTP redirect limit exceeded for ${redactSensitiveUrl(initialUrl)}`,
          response.status,
          attempt,
          "redirect_error",
          null,
          headerMap(response.headers),
        );
      }

      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch {
        throw new HttpRequestError(
          `HTTP ${response.status} returned an invalid redirect location`,
          response.status,
          attempt,
          "redirect_error",
          null,
          headerMap(response.headers),
        );
      }

      // A robots.txt request may be redirected to the canonical host's
      // robots.txt. It must not recursively ask the in-flight policy promise
      // to authorize itself, and a redirect to a non-robots document is not a
      // valid policy document.
      if (robotsResource && !isRobotsTxtUrl(nextUrl)) {
        throw new HttpRequestError(
          "robots.txt redirected to a non-robots document",
          response.status,
          attempt,
          "robots_unavailable",
          null,
          headerMap(response.headers),
        );
      }
      const policy = robotsResource || !respectRobots ? null : await this.policyFor(nextUrl);
      const nextDomain = new URL(nextUrl).hostname.toLocaleLowerCase();
      await this.rateLimiter.wait(
        nextUrl,
        this.effectiveHostDelay(nextDomain, configuredDelayMs),
        policy?.crawlDelayMs ?? null,
        Number.POSITIVE_INFINITY,
        this.activeSignal(),
      );

      const currentOrigin = new URL(currentUrl).origin;
      const nextOrigin = new URL(nextUrl).origin;
      if (currentOrigin !== nextOrigin) {
        currentHeaders.delete("authorization");
        currentHeaders.delete("cookie");
        currentHeaders.delete("proxy-authorization");
      }
      if ([301, 302, 303].includes(response.status) && currentMethod !== "GET" && currentMethod !== "HEAD") {
        currentMethod = "GET";
        currentBody = undefined;
        currentHeaders.delete("content-type");
      }
      currentHeaders.delete("if-none-match");
      currentHeaders.delete("if-modified-since");
      currentUrl = nextUrl;
    }
  }

  public circuitSnapshot(): Record<string, CircuitEntry> {
    return Object.fromEntries([...this.circuits.entries()].map(([domain, entry]) => [domain, { ...entry }]));
  }

  private domainConcurrency(domain: string): number {
    // These boards sit behind a shared edge. Keeping the origin lane narrow
    // prevents detail fan-out from starving the listing/sitemap request or
    // triggering edge-side connection resets during a full multi-source crawl.
    return SLOW_PUBLIC_BOARD_HOST.test(domain) ? Math.min(2, this.settings.perDomainConcurrency) : this.settings.perDomainConcurrency;
  }

  private shouldServeStaleCache(
    error: HttpRequestError,
    options: HttpRequestOptions,
    cacheEntry: CacheEntry | null,
    attempt: number,
    retryCount: number,
  ): boolean {
    if (!options.staleIfError || !cacheEntry || !isTransientHttpRequestError(error)) return false;
    // Give a cached source one refresh attempt, then fail over quickly instead
    // of waiting through a long retry storm while the rest of the crawl runs.
    return attempt >= Math.min(1, retryCount);
  }

  private staleCacheSnapshot(requestedUrl: string, cacheEntry: CacheEntry, attempt: number, domain: string): HttpResponseSnapshot {
    this.cacheHitCount += 1;
    this.logger.warn("STALE_CACHE", `Serving the last successful ${redactSensitiveUrl(requestedUrl)} response after a transient ${domain} transport failure.`);
    return {
      requestedUrl,
      url: cacheEntry.url,
      status: cacheEntry.status,
      contentType: cacheEntry.contentType,
      body: cacheEntry.body,
      headers: cacheEntry.headers,
      attempts: attempt + 1,
      fromCache: true,
      stale: true,
    };
  }

  private isWellfound(domain: string): boolean {
    return /(?:^|\.)wellfound\.com$/i.test(domain);
  }

  private recordSuccess(domain: string): void {
    if (this.circuits.has(domain)) {
      this.circuits.delete(domain);
      this.persistCircuitState();
    }
    const previous = this.pressure.get(domain);
    if (!previous) return;
    if (previous.strikes <= 1) this.pressure.delete(domain);
    else this.pressure.set(domain, { strikes: previous.strikes - 1, delayMs: Math.floor(previous.delayMs / 2) });
  }

  private recordCircuitFailure(domain: string, status: number, reason: string): void {
    if (status !== 403 && status !== 429) return;
    const previous = this.circuits.get(domain);
    const consecutiveFailures = (previous?.consecutiveFailures ?? 0) + 1;
    const openUntil = consecutiveFailures >= this.settings.circuitBreakerFailureThreshold
      ? Date.now() + this.settings.circuitBreakerCooldownMs
      : 0;
    this.circuits.set(domain, { consecutiveFailures, openUntil, reason, updatedAt: Date.now() });
    this.persistCircuitState();
    if (openUntil > 0) {
      this.logger.warn("CIRCUIT", `Opened ${domain} for ${this.settings.circuitBreakerCooldownMs}ms after ${consecutiveFailures} consecutive HTTP ${status} failures.`);
    }
  }

  private effectiveHostDelay(domain: string, configuredDelayMs: number): number {
    return Math.max(configuredDelayMs, this.pressure.get(domain)?.delayMs ?? 0);
  }

  private notePressure(domain: string, status: number): void {
    if (status !== 429 && status !== 503 && status !== 504) return;
    const previous = this.pressure.get(domain);
    const strikes = (previous?.strikes ?? 0) + 1;
    const delayMs = Math.min(15_000, Math.max(500, (previous?.delayMs ?? 0) * 2 || 500));
    this.pressure.set(domain, { strikes, delayMs });
  }

  private async initialize(): Promise<void> {
    await mkdir(this.cacheDirectory, { recursive: true });
    await this.loadCircuitState();
  }

  private async readCache(path: string): Promise<CacheEntry | null> {
    const inMemory = this.cacheEntries.get(path);
    if (inMemory) return inMemory;
    try {
      const value = JSON.parse(await readFile(path, "utf8")) as CacheEntry;
      if (!value.url || typeof value.body !== "string" || !value.storedAt) return null;
      // Redirects are valid cache entries, but a malformed entry must never be
      // reused for a different request key.
      new URL(value.url);
      this.cacheEntries.set(path, value);
      return value;
    } catch {
      return null;
    }
  }

  private async writeCache(path: string, value: CacheEntry): Promise<void> {
    this.cacheEntries.set(path, value);
    try {
      await writeFile(path, JSON.stringify(value), "utf8");
    } catch (error) {
      this.logger.debug("CACHE", `Could not write HTTP cache entry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async loadCircuitState(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.circuitStatePath, "utf8")) as Record<string, CircuitEntry>;
      for (const [domain, value] of Object.entries(parsed)) {
        if (Date.now() - value.updatedAt <= MAX_CIRCUIT_STATE_AGE_MS) this.circuits.set(domain, value);
      }
    } catch {
      // A missing or corrupt state file is equivalent to a closed circuit.
    }
  }

  private persistCircuitState(): void {
    const snapshot = JSON.stringify(this.circuitSnapshot());
    // Serialize writes so simultaneous 403/429 responses cannot interleave
    // truncated JSON. The write itself remains asynchronous and never blocks a
    // request's event loop.
    this.circuitPersistence = this.circuitPersistence.then(async () => {
      try {
        await writeFile(this.circuitStatePath, snapshot, "utf8");
      } catch (error) {
        this.logger.debug("CACHE", `Could not persist circuit state: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
