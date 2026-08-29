import { chromium, type Browser, type BrowserContext, type Locator, type Page, type Response } from "playwright";
import { performance } from "node:perf_hooks";
import { load } from "cheerio";

import type { LinkCandidate, NetworkResponseSnapshot, PageSnapshot } from "../domain/types.js";
import type { ScoutSettings } from "../domain/schemas.js";
import { directApplicationOverride } from "../config/directApplicationOverrides.js";
import { Semaphore, sleep } from "../utils/async.js";
import type { Logger } from "../utils/logger.js";
import { canonicalizeUrl, isAggregatorUrl, isJobrightJobUrl, isJobrightUrl, isLinkedInJobUrl, redactSensitiveText, redactSensitiveUrl, safeCanonicalizeUrl, sameSite } from "../utils/url.js";
import { classifyLinkResponse } from "../verification/linkStatus.js";
import { HostRateLimiter, HostRateLimitTimeoutError } from "./rateLimiter.js";
import { isEarlyCareerRadarSource } from "./publicSources.js";
import { earlyCareerRadarDetailUrl, parseEarlyCareerRadarJobs, selectEarlyCareerRadarJobs } from "./adapters/earlyCareerRadar.js";
import type { Profiler } from "../observability/profiler.js";
import { cancellationError, composeAbortSignals, currentSourceAbortSignal, throwIfAborted } from "../domain/cancellation.js";

const BLOCKED_RESOURCE_TYPES = new Set(["image", "media", "font"]);
const BLOCKED_HOSTS = /(?:google-analytics|googletagmanager|doubleclick|facebook\.net|hotjar|segment\.io|amplitude\.com|adservice)/i;
function isInternListPage(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./i, "") === "intern-list.com" && url.pathname === "/";
  } catch {
    return false;
  }
}

function isEarlyCareerRadarListingPage(value: string): boolean {
  return isEarlyCareerRadarSource(value);
}

/** Match the grouped-role labels used by Early Career Radar's listing UI. */
export const EARLY_CAREER_RADAR_ROLE_EXPANSION_PATTERN = /^(?:View \d+ roles|Show \d+ more roles|\d+ openings)/i;

export function isEarlyCareerRadarRoleExpansionLabel(value: string): boolean {
  return EARLY_CAREER_RADAR_ROLE_EXPANSION_PATTERN.test(value.trim());
}

/** Extract the exact employer/ATS href from Jobright's stable anchor label. */
export function extractJobrightOriginalPostHref(html: string, baseUrl: string): string | null {
  try {
    const document = load(html);
    const href = document("a[href]")
      .filter((_, element) => document(element).text().replace(/\s+/gu, " ").trim().toLocaleLowerCase() === "original job post")
      .first()
      .attr("href");
    return href?.trim() ? safeCanonicalizeUrl(href, baseUrl) : null;
  } catch {
    return null;
  }
}

/** Recover filtered Early Career Radar detail links from its embedded feed. */
export function extractEarlyCareerRadarEmbeddedLinks(html: string, sourceUrl: string): LinkCandidate[] {
  const prefix = "self.__next_f.push([1,";
  const marker = '"initialJobs":[';
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const script of scripts) {
    const text = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "").trim();
    if (!text.startsWith(prefix) || !text.endsWith("])")) continue;
    let payload: string;
    try {
      const parsed = JSON.parse(text.slice(prefix.length, -2)) as unknown;
      if (typeof parsed !== "string") continue;
      payload = parsed;
    } catch {
      continue;
    }
    const markerIndex = payload.indexOf(marker);
    if (markerIndex < 0) continue;
    const start = markerIndex + marker.length - 1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < payload.length; index += 1) {
      const character = payload[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "[") depth += 1;
      else if (character === "]") {
        depth -= 1;
        if (depth !== 0) continue;
        let rawJobs: unknown;
        try { rawJobs = JSON.parse(payload.slice(start, index + 1)) as unknown; } catch { break; }
        const jobs = parseEarlyCareerRadarJobs({ jobs: rawJobs });
        if (!jobs) return [];
        const selected = selectEarlyCareerRadarJobs(sourceUrl, jobs);
        const seen = new Set<string>();
        return selected.flatMap((job) => {
          if (seen.has(job.id)) return [];
          seen.add(job.id);
          return [{
            url: earlyCareerRadarDetailUrl(job.id),
            text: `${job.company} — ${job.title} internship opening`,
            rel: "early-career-radar-embedded-feed",
          }];
        });
      }
    }
  }
  return [];
}

function pathDepth(value: string): number {
  return new URL(value).pathname.split("/").filter(Boolean).length;
}

export function preferredApplicationDestination(target: string, finalUrl: string): string {
  const targetIsJobDetail = /\/(?:jobs?|positions?|requisitions?)\//i.test(new URL(target).pathname);
  const lostSpecificJobPath = sameSite(target, finalUrl)
    && targetIsJobDetail
    && pathDepth(target) >= pathDepth(finalUrl) + 2;
  return lostSpecificJobPath ? target : finalUrl;
}

export class PageFetchError extends Error {
  public constructor(
    message: string,
    public readonly statusCode: number | null,
    public readonly retryCount: number,
    public readonly errorType: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "PageFetchError";
  }
}

export function isTargetClosedError(error: unknown): boolean {
  return /(?:browser|context|page) (?:has been )?closed|target page.*closed/i.test(error instanceof Error ? error.message : String(error));
}

interface BrowserSession {
  key: string;
  id: string;
  browser: Browser;
  context: BrowserContext;
  invalidated: boolean;
}

export type BrowserLauncher = (headless: boolean) => Promise<Browser>;

export class BrowserManager {
  private browser: Browser | null = null;
  private readonly browsers = new Set<Browser>();
  private readonly contexts = new Set<BrowserContext>();
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly sessionPromises = new Map<string, Promise<BrowserSession>>();
  private readonly domainSemaphores = new Map<string, Semaphore>();
  private startPromise: Promise<void> | null = null;
  /**
   * Browser startup is shared by every browser-required source. If Chromium
   * cannot start in the current launchd/session environment, retrying it for
   * every source only multiplies native process failures and wastes the run's
   * time budget. Remember the diagnostic and let each source settle cleanly.
   */
  private browserStartError: Error | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly semaphore: Semaphore;
  private readonly rateLimiter = new HostRateLimiter();
  private cancelled = false;
  private forceClosePending = false;
  private readonly sourceActivity = new Map<string, number>();
  private readonly sourceIdleWaiters = new Map<string, Array<() => void>>();
  private sequence = 0;
  private activeOperations = 0;
  private navigationCount = 0;
  private idleWaiters: Array<() => void> = [];

  public constructor(
    private readonly settings: ScoutSettings,
    private readonly logger: Logger,
    private readonly launchBrowser: BrowserLauncher = (headless) => chromium.launch({ headless }),
    private readonly profiler?: Profiler,
    private readonly cancellationSignal?: AbortSignal,
  ) {
    this.semaphore = new Semaphore(settings.browserConcurrency);
    this.cancellationSignal?.addEventListener("abort", () => this.cancel(), { once: true });
  }

  private activeSignal(): AbortSignal | undefined {
    return composeAbortSignals(this.cancellationSignal, currentSourceAbortSignal());
  }

  private throwIfCrawlAborted(): void {
    throwIfAborted(this.activeSignal());
    if (this.cancelled) throw cancellationError(this.cancellationSignal?.reason);
  }

  public async start(): Promise<void> {
    throwIfAborted(this.activeSignal());
    await this.ensureBrowser();
  }

  /** Number of successful/attempted page navigations in this browser lane. */
  public get navigations(): number { return this.navigationCount; }

  public async fetchPage(url: string, robotsDelayMs: number | null = null, sourceKey = url): Promise<PageSnapshot> {
    return this.withSourceActivity(sourceKey, () => this.withOperation(async () => {
      throwIfAborted(this.activeSignal());
      await this.start();
      const domainSemaphore = this.domainSemaphore(url);
      return this.semaphore.use(() => domainSemaphore.use(async () => {
        let lastError: unknown;
        let recoveryAttempts = 0;
        for (let attempt = 0; attempt <= this.settings.retryCount; attempt += 1) {
          let session: BrowserSession | null = null;
          try {
            await this.rateLimiter.wait(url, this.settings.perHostDelayMs, robotsDelayMs, this.settings.pageTimeoutMs, this.activeSignal());
            session = await this.sessionFor(sourceKey);
            const snapshot = await this.fetchOnce(url, session.context);
            return { ...snapshot, attempts: attempt + 1, browserContextId: session.id };
          } catch (error) {
            this.throwIfCrawlAborted();
            lastError = error;
            const targetClosed = isTargetClosedError(error);
            if (targetClosed) {
              recoveryAttempts += 1;
              this.logger.warn("BROWSER", `Discarding dead page/context for ${redactSensitiveUrl(url)} (recovery ${recoveryAttempts}).`);
              if (session) this.discardSession(sourceKey, session);
              if (!this.browser?.isConnected()) await this.replaceDeadBrowser();
            }
            const pageError = error instanceof PageFetchError
              ? error
              : error instanceof HostRateLimitTimeoutError
                ? new PageFetchError(error.message, null, attempt, "page_timeout")
                : new PageFetchError(
                  redactSensitiveText(error instanceof Error ? error.message : String(error)),
                  null,
                  attempt,
                  targetClosed ? "browser_error" : "browser_error",
                );
            if (pageError.errorType === "page_timeout") {
              this.logger.warn("TIMEOUT", `Skipped ${redactSensitiveUrl(url)} after ${this.settings.pageTimeoutMs}ms on one page operation.`);
            }
            const status = pageError.statusCode;
            const transient = targetClosed
              || pageError.errorType === "navigation_error"
              || pageError.errorType === "browser_error"
              || status === 408
              || status === 425
              || status === 429
              || (status !== null && status >= 500);
            const canRecover = targetClosed ? recoveryAttempts <= 2 : true;
            if (!transient || !canRecover || attempt >= this.settings.retryCount) {
              throw new PageFetchError(pageError.message, pageError.statusCode, attempt, pageError.errorType, pageError.retryAfterMs);
            }
            const retryAfter = pageError.retryAfterMs ?? 0;
            const backoff = 500 * (2 ** attempt);
            const delay = Math.min(59_500, Math.max(backoff, retryAfter)) + Math.floor(Math.random() * 250);
            this.logger.debug("RETRY", `${redactSensitiveUrl(url)} after ${delay}ms (${attempt + 1}/${this.settings.retryCount})`);
            await sleep(delay, this.activeSignal());
          }
        }
        throw new PageFetchError(lastError instanceof Error ? lastError.message : "Unknown browser failure", null, this.settings.retryCount, "browser_error");
      }, this.activeSignal()), this.activeSignal());
    }));
  }

  public async resolveApplicationUrl(value: string, sourceKey = value): Promise<string | null> {
    return this.withSourceActivity(sourceKey, () => this.withOperation(async () => {
      throwIfAborted(this.activeSignal());
      await this.start();
      const domainSemaphore = this.domainSemaphore(value);
      return this.semaphore.use(() => domainSemaphore.use(async () => {
        const session = await this.sessionFor(sourceKey);
        const context = session.context;
        // Jobright is never a valid application fallback. Resolve its
        // rendered Original job post control and leave the wrapper URL
        // unresolved if that control cannot produce an employer/ATS destination.
        if (isJobrightUrl(value)) return this.resolveJobrightOriginalPostInContext(value, context);
        const override = directApplicationOverride(value);
        const target = override ?? value;
        try {
          const response = await context.request.get(target, {
            timeout: Math.min(this.settings.timeoutMs, 15_000),
            failOnStatusCode: false,
            maxRedirects: 10,
            headers: { accept: "text/html,application/xhtml+xml" },
          });
          const contentType = response.headers()["content-type"] ?? "";
          const shouldInspectLinkedIn = isLinkedInJobUrl(target) || isLinkedInJobUrl(response.url());
          const body = (shouldInspectLinkedIn || /(?:html|json|text)/i.test(contentType))
            ? (await response.text()).slice(0, 500_000)
            : "";
          const linkState = classifyLinkResponse(response.status(), response.url(), body);
          if (linkState === "closed") {
            this.logger.debug("APPLY", `Could not promote unavailable application destination ${redactSensitiveUrl(target)}`);
            return null;
          }
          // A LinkedIn URL is only promoted after its page has been fetched and
          // classified as reachable. When verification is unavailable, null is
          // an explicit signal and the analyzer retains the original URL for
          // optional unverified-link visibility filtering.
          if (shouldInspectLinkedIn && linkState !== "reachable") {
            this.logger.debug("APPLY", `Rejected unverified LinkedIn application destination ${redactSensitiveUrl(target)} (${linkState})`);
            return null;
          }
          const resolvedUrl = safeCanonicalizeUrl(response.url()) ?? target;
          const finalUrl = preferredApplicationDestination(target, resolvedUrl);
          const suspiciousRedirect = /\b(?:login|sign-?in|signup|captcha|auth)\b/i.test(new URL(finalUrl).pathname);
          if (!suspiciousRedirect && (!isAggregatorUrl(value) || !sameSite(value, finalUrl))) {
            if (override) this.logger.debug("APPLY", `Verified direct override ${redactSensitiveUrl(value)} to ${redactSensitiveUrl(finalUrl)}`);
            return finalUrl;
          }
          const interactiveUrl = await this.resolvePublicAggregatorApply(value, context);
          if (interactiveUrl && await this.isUnavailableDestination(interactiveUrl, context)) {
            this.logger.debug("APPLY", `Rejected unavailable interactive application destination ${redactSensitiveUrl(interactiveUrl)}`);
            return null;
          }
          return interactiveUrl ?? (suspiciousRedirect ? value : finalUrl);
        } catch (error) {
          this.throwIfCrawlAborted();
          this.logger.debug("APPLY", `Could not resolve redirect for ${redactSensitiveUrl(target)}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
          if (isLinkedInJobUrl(value) || isLinkedInJobUrl(target)) return null;
          return value;
        }
      }, this.activeSignal()), this.activeSignal());
    }));
  }

  /**
   * Resolve Jobright's rendered "Original job post" control and return the
   * employer/ATS destination it opens. This is separate from redirect
   * resolution so structured Jobright feeds can use the same behavior as
   * browser-crawled Jobright pages.
   */
  public async resolveOriginalJobPostUrl(value: string, sourceKey = value): Promise<string | null> {
    if (!isJobrightJobUrl(value)) return null;
    return this.withSourceActivity(sourceKey, () => this.withOperation(async () => {
      throwIfAborted(this.activeSignal());
      await this.start();
      const domainSemaphore = this.domainSemaphore(value);
      return this.semaphore.use(() => domainSemaphore.use(async () => {
        const session = await this.sessionFor(sourceKey);
        return this.resolveJobrightOriginalPostInContext(value, session.context);
      }, this.activeSignal()), this.activeSignal());
    }));
  }

  /**
   * Release a completed source's browser context while retaining the single
   * Chromium generation. Source crawls call this after their result has been
   * persisted; active operations for the same source are allowed to settle
   * first so a context cannot be closed underneath a redirect or page read.
   */
  public async releaseSource(sourceKey: string): Promise<void> {
    const active = this.sourceActivity.get(sourceKey) ?? 0;
    if (active > 0) {
      await new Promise<void>((resolve) => {
        const waiters = this.sourceIdleWaiters.get(sourceKey) ?? [];
        waiters.push(resolve);
        this.sourceIdleWaiters.set(sourceKey, waiters);
      });
    }
    const session = this.sessions.get(sourceKey);
    if (!session) return;
    this.sessions.delete(sourceKey);
    session.invalidated = true;
    await session.context.close().catch(() => undefined);
    this.contexts.delete(session.context);
  }

  private async isUnavailableDestination(value: string, context: BrowserContext): Promise<boolean> {
    try {
      const response = await context.request.get(value, {
        timeout: Math.min(this.settings.timeoutMs, 15_000),
        failOnStatusCode: false,
        maxRedirects: 10,
        headers: { accept: "text/html,application/xhtml+xml,application/json" },
      });
      const contentType = response.headers()["content-type"] ?? "";
      const body = /(?:html|json|text)/i.test(contentType) ? (await response.text()).slice(0, 500_000) : "";
      return classifyLinkResponse(response.status(), response.url(), body) === "closed";
    } catch {
      this.throwIfCrawlAborted();
      return false;
    }
  }

  private async resolvePublicAggregatorApply(value: string, context: BrowserContext): Promise<string | null> {
    const host = new URL(value).hostname;
    if (!/(?:^|\.)(?:hiringcafe\.com|simplify\.jobs)$/i.test(host)) return null;
    const page = await context.newPage();
    try {
      await page.goto(value, { waitUntil: "domcontentloaded", timeout: Math.min(this.settings.timeoutMs, 20_000) });
      await page.waitForTimeout(500);
      let destination: string | null = null;
      if (/(?:^|\.)hiringcafe\.com$/i.test(host)) {
        const control = page.locator("[data-testid='job-page-apply']").filter({ hasText: /apply/i }).first();
        destination = await this.clickAndCaptureDestination(page, control);
      } else if (/(?:^|\.)simplify\.jobs$/i.test(host)) {
        const apply = page.getByRole("button", { name: /^apply$/i }).first();
        await this.clickAndCaptureDestination(page, apply);
        const manual = page.getByText(/I['’]ll Apply Manually/i).last();
        await manual.waitFor({ state: "visible", timeout: 5_000 }).catch(() => undefined);
        destination = await this.clickAndCaptureDestination(page, manual);
      }
      const normalized = destination ? safeCanonicalizeUrl(destination) : null;
      if (!normalized || sameSite(value, normalized) || /\b(?:login|sign-?in|signup|captcha|auth)\b/i.test(new URL(normalized).pathname)) {
        return null;
      }
      this.logger.debug("APPLY", `Public Apply control resolved ${value} to ${normalized}`);
      return normalized;
    } catch (error) {
      this.throwIfCrawlAborted();
      this.logger.debug("APPLY", `Could not inspect public Apply control for ${value}: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async resolveJobrightOriginalPostInContext(value: string, context: BrowserContext): Promise<string | null> {
    const page = await context.newPage();
    const pageDeadlineMs = Math.min(this.settings.navigationTimeoutMs, this.settings.pageTimeoutMs);
    try {
      this.navigationCount += 1;
      await this.withPageDeadline(page.goto(value, {
        waitUntil: "domcontentloaded",
        timeout: pageDeadlineMs,
      }), `Loading Jobright detail ${redactSensitiveUrl(value)}`, pageDeadlineMs);
      await this.withPageDeadline(page.waitForTimeout(750), `Waiting for Jobright detail ${redactSensitiveUrl(value)}`, pageDeadlineMs);
      let href: string | null = null;
      if (typeof (page as Page & { content?: unknown }).content === "function") {
        const html = await this.withPageDeadline(page.content(), `Reading Jobright detail ${redactSensitiveUrl(value)}`, pageDeadlineMs);
        href = extractJobrightOriginalPostHref(html, page.url());
      }
      // Keep a DOM fallback for environments where page.content() is not
      // available. It uses the same exact anchor lookup and never clicks.
      if (!href) {
        const control = page
          .locator("a[href]")
          .filter({ hasText: /^\s*original\s+job\s+post\s*$/i })
          .first();
        await this.withPageDeadline(
          control.waitFor({ state: "attached", timeout: Math.min(5_000, pageDeadlineMs) }),
          `Waiting for Jobright Original job post anchor ${redactSensitiveUrl(value)}`,
          Math.min(5_000, pageDeadlineMs),
        ).catch(() => undefined);
        href = await control.getAttribute("href").catch(() => null);
      }
      const normalized = href?.trim() ? safeCanonicalizeUrl(href, page.url()) : null;
      if (!normalized || sameSite(value, normalized) || isAggregatorUrl(normalized)) return null;
      if (/\b(?:login|sign-?in|signup|captcha|auth)\b/i.test(new URL(normalized).pathname)) return null;
      this.logger.debug("ORIGINAL", `Jobright Original job post resolved ${redactSensitiveUrl(value)} to ${redactSensitiveUrl(normalized)}`);
      return normalized;
    } catch (error) {
      this.throwIfCrawlAborted();
      this.logger.debug("ORIGINAL", `Could not read Jobright Original job post href for ${redactSensitiveUrl(value)}: ${redactSensitiveText(error instanceof Error ? error.message : String(error))}`);
      return null;
    } finally {
      await this.closePage(page);
    }
  }

  private async clickAndCaptureDestination(page: Page, control: Locator, timeoutMs = 4_000): Promise<string | null> {
    await control.waitFor({ state: "visible", timeout: timeoutMs }).catch(() => undefined);
    if (!(await control.isVisible().catch(() => false))) return null;
    const before = page.url();
    const popupPromise = page.waitForEvent("popup", { timeout: timeoutMs }).catch(() => null);
    await control.click({ timeout: timeoutMs });
    const popup = await Promise.race([popupPromise, sleep(Math.min(2_500, timeoutMs)).then(() => null)]);
    if (popup) {
      await popup.waitForLoadState("domcontentloaded", { timeout: 5_000 }).catch(() => undefined);
      const destination = popup.url();
      await popup.close().catch(() => undefined);
      return destination;
    }
    await page.waitForTimeout(250);
    return page.url() !== before ? page.url() : null;
  }

  public async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = (async () => {
      if (this.activeOperations > 0 && !this.cancelled && !this.forceClosePending) {
        await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
      }
      // Cleanup is deliberately only reached by the outer crawl owner, after
      // all source tasks have settled. No recovery path calls this method.
      for (const context of this.contexts) await context.close().catch(() => undefined);
      for (const browser of this.browsers) await browser.close().catch(() => undefined);
      this.sessions.clear();
      this.sessionPromises.clear();
      this.contexts.clear();
      this.browsers.clear();
      this.browser = null;
    })();
    await this.closePromise;
  }

  /** Interrupt in-flight Playwright work when a crawl is terminated. */
  public cancel(): void {
    if (this.cancelled) return;
    this.cancelled = true;
    for (const context of this.contexts) void context.close().catch(() => undefined);
    for (const browser of this.browsers) void browser.close().catch(() => undefined);
  }

  /**
   * Interrupt one timed-out source without taking down browser work owned by
   * sibling sources. The source task's AbortSignal handles normal protocol
   * cancellation; closing the context is the escape hatch for a Playwright
   * operation that does not promptly observe that signal.
   */
  public cancelSource(sourceKey: string): void {
    // A timed-out source may have left a third-party protocol promise that
    // does not react to context.close(). Do not make final browser teardown
    // wait for that detached operation after sibling sources have settled.
    this.forceClosePending = true;
    const pending = this.sessionPromises.get(sourceKey);
    if (pending) {
      this.sessionPromises.delete(sourceKey);
      // Session creation itself may be inside a Playwright protocol call that
      // ignores AbortSignal. If it eventually completes after the source has
      // moved on, close that late context instead of letting the retry reuse
      // or leak it.
      void pending.then((session) => {
        if (this.sessions.get(sourceKey) === session) this.sessions.delete(sourceKey);
        session.invalidated = true;
        this.contexts.delete(session.context);
        void session.context.close().catch(() => undefined);
      }).catch(() => undefined);
    }
    const session = this.sessions.get(sourceKey);
    if (!session) return;
    this.sessions.delete(sourceKey);
    session.invalidated = true;
    this.contexts.delete(session.context);
    void session.context.close().catch(() => undefined);
  }

  private async ensureBrowser(): Promise<void> {
    throwIfAborted(this.activeSignal());
    if (this.browser?.isConnected()) return;
    if (this.browserStartError) throw this.browserStartError;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      try {
        const browser = await this.launchBrowser(this.settings.headless);
        this.browser = browser;
        this.browsers.add(browser);
        this.logger.debug("BROWSER", `Started browser generation ${this.browsers.size}.`);
      } catch (error) {
        const launchError = new Error(
          `Chromium could not start. Run "npx playwright install chromium" first. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
        this.browserStartError = launchError;
        throw launchError;
      } finally {
        this.startPromise = null;
      }
    })();
    return this.startPromise;
  }

  private domainSemaphore(value: string): Semaphore {
    const domain = new URL(value).hostname.toLocaleLowerCase();
    const existing = this.domainSemaphores.get(domain);
    if (existing) return existing;
    const created = new Semaphore(this.settings.perDomainConcurrency);
    this.domainSemaphores.set(domain, created);
    return created;
  }

  private async replaceDeadBrowser(): Promise<void> {
    if (this.browser?.isConnected()) return;
    for (const session of this.sessions.values()) session.invalidated = true;
    this.sessions.clear();
    this.sessionPromises.clear();
    this.browser = null;
    await this.ensureBrowser();
  }

  private async sessionFor(key: string): Promise<BrowserSession> {
    await this.ensureBrowser();
    const existing = this.sessions.get(key);
    if (existing && !existing.invalidated && existing.browser.isConnected()) return existing;
    const pending = this.sessionPromises.get(key);
    if (pending) return pending;
    if (!this.browser?.isConnected()) {
      await this.replaceDeadBrowser();
    }
    const creation = (async (): Promise<BrowserSession> => {
      const browser = this.browser;
      if (!browser) throw new Error("Browser is not initialized");
      const context = await this.createContext(browser);
      const session: BrowserSession = {
        key,
        id: `context-${++this.sequence}`,
        browser,
        context,
        invalidated: false,
      };
      context.on("close", () => { session.invalidated = true; });
      this.sessions.set(key, session);
      this.logger.debug("BROWSER", `Using ${session.id} for ${redactSensitiveUrl(key)}.`);
      return session;
    })();
    this.sessionPromises.set(key, creation);
    try {
      return await creation;
    } finally {
      if (this.sessionPromises.get(key) === creation) this.sessionPromises.delete(key);
    }
  }

  private async createContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext({
      userAgent: this.settings.userAgent,
      javaScriptEnabled: true,
      serviceWorkers: "block",
      viewport: { width: 1365, height: 900 },
    });
    // Keep Playwright's own locator defaults bounded as a second line of
    // defense. The fetchOnce deadline below also covers protocol calls that do
    // not honor Playwright's per-operation timeout options.
    context.setDefaultTimeout?.(this.settings.pageTimeoutMs);
    context.setDefaultNavigationTimeout?.(this.settings.navigationTimeoutMs);
    this.contexts.add(context);
    await context.route("**/*", async (route) => {
      const request = route.request();
      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType()) || BLOCKED_HOSTS.test(request.url())) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    return context;
  }

  private discardSession(key: string, session: BrowserSession): void {
    session.invalidated = true;
    if (this.sessions.get(key) === session) this.sessions.delete(key);
  }

  private async withOperation<T>(operation: () => Promise<T>): Promise<T> {
    throwIfAborted(this.activeSignal());
    this.activeOperations += 1;
    try {
      return await operation();
    } finally {
      this.activeOperations -= 1;
      if (this.activeOperations === 0) {
        for (const resolve of this.idleWaiters.splice(0)) resolve();
      }
    }
  }

  private async withSourceActivity<T>(sourceKey: string, operation: () => Promise<T>): Promise<T> {
    this.sourceActivity.set(sourceKey, (this.sourceActivity.get(sourceKey) ?? 0) + 1);
    try {
      return await operation();
    } finally {
      const remaining = Math.max(0, (this.sourceActivity.get(sourceKey) ?? 1) - 1);
      if (remaining > 0) {
        this.sourceActivity.set(sourceKey, remaining);
      } else {
        this.sourceActivity.delete(sourceKey);
        for (const resolve of this.sourceIdleWaiters.get(sourceKey) ?? []) resolve();
        this.sourceIdleWaiters.delete(sourceKey);
      }
    }
  }

  private async fetchOnce(requestedUrl: string, context: BrowserContext): Promise<PageSnapshot> {
    let page: Page | null = null;
    const pageDeadlineMs = isEarlyCareerRadarListingPage(requestedUrl)
      ? Math.max(this.settings.pageTimeoutMs, 120_000)
      : this.settings.pageTimeoutMs;
    try {
      page = await this.withPageDeadline(context.newPage(), "Creating a browser page", pageDeadlineMs);
      return await this.withPageDeadline(this.readPage(page, requestedUrl), `Processing ${redactSensitiveUrl(requestedUrl)}`, pageDeadlineMs);
    } catch (error) {
      // If page creation itself wedged, there is no page handle to close. A
      // context close releases the stuck protocol call and invalidates only
      // this source session; the next source request can create a fresh one.
      if (!page && error instanceof PageFetchError && error.errorType === "page_timeout") await this.closeContext(context);
      throw error;
    } finally {
      if (page) await this.closePage(page);
    }
  }

  private async readPage(page: Page, requestedUrl: string): Promise<PageSnapshot> {
    const networkResponses = new Map<string, NetworkResponseSnapshot>();
    const pendingResponses = new Set<Promise<void>>();
    const onResponse = (response: Response): void => {
      const contentType = response.headers()["content-type"] ?? "";
      if (!/(?:application\/json|text\/json|graphql)/i.test(contentType) && !/(?:\/api\/|graphql|jobs?|search)/i.test(response.url())) return;
      const task = response.text().then((body) => {
        if (body.length <= 1_000_000 && response.status() >= 200 && response.status() < 300) {
          networkResponses.set(response.url(), { url: response.url(), status: response.status(), contentType, body });
        }
      }).catch(() => undefined).finally(() => { pendingResponses.delete(task); });
      pendingResponses.add(task);
    };
    page.on("response", onResponse);
    try {
      let response: Response | null;
      try {
        const navigationStartedAt = performance.now();
        this.navigationCount += 1;
        response = await page.goto(requestedUrl, {
          waitUntil: "domcontentloaded",
          timeout: Math.min(this.settings.navigationTimeoutMs, this.settings.pageTimeoutMs),
        });
        this.profiler?.recordSpan("browser_navigation", performance.now() - navigationStartedAt, { url: requestedUrl });
      } catch (error) {
        this.profiler?.recordSpan("browser_navigation", 0, { url: requestedUrl, status: "error" }, "error");
        throw new PageFetchError(error instanceof Error ? error.message : String(error), null, 0, "navigation_error");
      }
      const status = response?.status() ?? 200;
      if ([401, 403, 407, 451].includes(status)) throw new PageFetchError(`HTTP ${status} access denied`, status, 0, "access_denied");
      if (status === 429 || status >= 500) {
        const retryAfterMs = status === 429 ? parseRetryAfter(response?.headers()["retry-after"]) : null;
        throw new PageFetchError(`HTTP ${status}`, status, 0, "http_error", retryAfterMs);
      }

      const renderStartedAt = performance.now();
      await this.waitForKnownDynamicDetail(page);
      await this.waitForMeaningfulContent(page);
      const internListLinks = await this.inspectInternListTabs(page);
      // Early Career Radar embeds its complete feed in the initial HTML. Keep
      // browser fallback bounded by reading that payload instead of repeatedly
      // expanding grouped controls.
      const earlyCareerRadarListing = isEarlyCareerRadarListingPage(page.url());
      if (!earlyCareerRadarListing) await this.expandLazyListings(page);
      this.profiler?.recordSpan("browser_render", performance.now() - renderStartedAt, { url: requestedUrl });
      // Some Next.js/RSC responses remain open after the usable DOM is ready.
      // They are telemetry only here; never let one stream hold the whole page
      // past the source deadline.
      if (pendingResponses.size > 0) {
        await Promise.race([
          Promise.allSettled([...pendingResponses]),
          sleep(5_000),
        ]);
      }
      const [html, text, title, currentLinks] = await Promise.all([
        page.content(),
        page.locator("body").innerText({ timeout: 5_000 }).catch(() => ""),
        page.title().catch(() => ""),
        this.collectLinks(page),
      ]);
      const embeddedLinks = earlyCareerRadarListing ? extractEarlyCareerRadarEmbeddedLinks(html, requestedUrl) : [];
      const links = [...new Map(
        [...internListLinks, ...currentLinks, ...embeddedLinks].map((link) => [link.url, link]),
      ).values()];
      const finalUrl = safeCanonicalizeUrl(page.url()) ?? canonicalizeUrl(requestedUrl);
      return {
        requestedUrl: canonicalizeUrl(requestedUrl),
        url: finalUrl,
        status,
        contentType: response?.headers()["content-type"] ?? "text/html",
        title,
        html,
        text,
        links,
        ...(networkResponses.size > 0 ? { networkResponses: [...networkResponses.values()] } : {}),
        fetchedAt: new Date().toISOString(),
      };
    } finally {
      page.off("response", onResponse);
    }
  }

  private withPageDeadline<T>(operation: Promise<T>, label: string, timeoutMs = this.settings.pageTimeoutMs): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new PageFetchError(
        `${label} exceeded the ${timeoutMs}ms page limit.`,
        null,
        0,
        "page_timeout",
      )), timeoutMs);
    });
    return Promise.race([operation, deadline]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }

  private async closePage(page: Page): Promise<void> {
    await Promise.race([page.close().catch(() => undefined), sleep(5_000)]);
  }

  private async closeContext(context: BrowserContext): Promise<void> {
    await Promise.race([context.close().catch(() => undefined), sleep(5_000)]);
  }

  private async waitForMeaningfulContent(page: Page): Promise<void> {
    const parsed = (() => {
      try { return new URL(page.url()); } catch { return null; }
    })();
    const host = parsed?.hostname.replace(/^www\./i, "") ?? "";
    const selector = host === "applybolt.app"
      ? "main, article, [data-testid*='job'], [class*='job'], [class*='listing']"
      : host === "hiringcafe.com"
        ? "#__NEXT_DATA__, main, article, [data-testid*='job'], [class*='job']"
        : "body";
    await page.locator(selector).first().waitFor({ state: "attached", timeout: Math.min(this.settings.selectorTimeoutMs, this.settings.pageTimeoutMs) }).catch(() => undefined);
    if (host === "applybolt.app" || host === "hiringcafe.com") {
      await page.waitForFunction(
        () => (document.body?.innerText ?? "").trim().length > 120 || Boolean(document.querySelector("#__NEXT_DATA__")),
        { timeout: Math.min(this.settings.selectorTimeoutMs, this.settings.pageTimeoutMs) },
      ).catch(() => undefined);
    }
  }

  private async waitForKnownDynamicDetail(page: Page): Promise<void> {
    const url = safeCanonicalizeUrl(page.url());
    if (!url) return;
    const parsed = new URL(url);
    if (/(?:^|\.)oraclecloud\.com$/i.test(parsed.hostname)
      && /\/hcmUI\/CandidateExperience\/[^?#]+\/job\/[^/]+/i.test(parsed.pathname)) {
      await page.getByText(/^JOB DESCRIPTION$/i).first()
        .waitFor({ state: "visible", timeout: Math.min(this.settings.selectorTimeoutMs, this.settings.pageTimeoutMs) })
        .catch(() => undefined);
      return;
    }
    if (/(?:^|\.)careers\.ibm\.com$/i.test(parsed.hostname)
      && /\/careers\/JobDetail$/i.test(parsed.pathname)) {
      await page.getByText(/^Introduction$/i).first()
        .waitFor({ state: "visible", timeout: Math.min(this.settings.selectorTimeoutMs, this.settings.pageTimeoutMs) })
        .catch(() => undefined);
      return;
    }
    if (/(?:^|\.)careers\.tiktokusds\.com$/i.test(parsed.hostname)
      && /\/position\/\d+\/detail\/?$/i.test(parsed.pathname)) {
      await page.getByText(/^Responsibilities$/i).first()
        .waitFor({ state: "visible", timeout: Math.min(this.settings.selectorTimeoutMs, this.settings.pageTimeoutMs) })
        .catch(() => undefined);
    }
  }

  private async expandLazyListings(page: Page): Promise<void> {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    await page.waitForTimeout(200).catch(() => undefined);
    for (let click = 0; click < this.settings.maxLoadMoreClicks; click += 1) {
      await this.expandEarlyCareerRadarGroups(page);
      const control = page.getByRole("button", { name: /^(?:load|show|view) more(?: jobs?| positions?| openings?)?$|^view all jobs?$/i }).first();
      if (!(await control.isVisible().catch(() => false))) break;
      await control.click({ timeout: 2_000 }).catch(() => undefined);
      await page.waitForTimeout(350).catch(() => undefined);
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => undefined);
    }
    await this.expandEarlyCareerRadarGroups(page);
  }

  private async expandEarlyCareerRadarGroups(page: Page): Promise<void> {
    if (!isEarlyCareerRadarListingPage(page.url())) return;
    for (let click = 0; click < 400; click += 1) {
      const controls = page.getByRole("button", { name: EARLY_CAREER_RADAR_ROLE_EXPANSION_PATTERN });
      const count = await controls.count().catch(() => 0);
      if (count === 0) break;
      let clicked = false;
      for (let index = 0; index < count; index += 1) {
        const control = controls.nth(index);
        if (!(await control.isVisible().catch(() => false))) continue;
        let expanded: string | null = null;
        try {
          expanded = await control.getAttribute("aria-expanded");
        } catch {
          // Test doubles and unusual controls may not expose the attribute.
        }
        if (expanded === "true") continue;
        await control.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
        try {
          await control.click({ timeout: 2_000 });
          clicked = true;
        } catch {
          // Try another visible copy from a responsive layout.
        }
        if (clicked) break;
      }
      if (!clicked) break;
      await page.waitForTimeout(50).catch(() => undefined);
    }
  }

  private async inspectInternListTabs(page: Page): Promise<LinkCandidate[]> {
    if (!isInternListPage(page.url())) return [];

    const links: LinkCandidate[] = [];
    const canadaClicked = await this.clickVisibleControl(
      page.getByText(/^\s*Canada\s*$/i),
      "Canada",
    );
    if (!canadaClicked) {
      this.logger.debug("PAGE", "Intern List Canada control was not found or could not be clicked");
      return links;
    }
    await this.waitForInternListTabUpdate(page);
    links.push(...await this.collectLinks(page));
    return links;
  }

  private async clickVisibleControl(controls: Locator, label: string): Promise<boolean> {
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      if (!(await control.isVisible().catch(() => false))) continue;
      try {
        await control.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => undefined);
        await control.click({ timeout: 5_000 });
        this.logger.debug("PAGE", `Intern List selected ${label}`);
        return true;
      } catch {
        // Try the next visible matching control when a responsive layout has duplicates.
      }
    }
    return false;
  }

  private async waitForInternListTabUpdate(page: Page): Promise<void> {
    await page.waitForTimeout(750);
  }

  private async collectLinks(page: Page): Promise<LinkCandidate[]> {
    const links: LinkCandidate[] = [];
    for (const frame of page.frames()) {
      const frameLinks = await frame.evaluate<LinkCandidate[]>(() => {
        const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>("a[href]"), (anchor) => ({
          url: anchor.href,
          text: (anchor.innerText || anchor.getAttribute("aria-label") || anchor.title || "").trim(),
          rel: anchor.rel || "",
        }));
        const iframes = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe[src]"), (iframe) => ({
          url: iframe.src,
          text: (iframe.title || iframe.getAttribute("aria-label") || "internship jobs embedded listing").trim(),
          rel: "embedded-frame",
        }));
        const internListCategories = Array.from(document.querySelectorAll<HTMLElement>("[data-job-path]"))
          .filter((element) => /^\/(?:[a-z0-9_-]+\/)?[a-z0-9_-]+$/i.test(element.dataset.jobPath ?? ""))
          .map((element) => ({
            url: `https://jobright.ai/minisites-jobs/intern${element.dataset.jobPath ?? ""}?embed=true`,
            text: `internship jobs ${element.innerText}`.trim(),
            rel: "intern-list-category",
          }));
        return [...anchors, ...iframes, ...internListCategories];
      }).catch(() => []);
      links.push(...frameLinks);
    }
    const seen = new Set<string>();
    return links.filter((link) => {
      const key = `${link.url}\n${link.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}

export function parseRetryAfter(value: string | undefined): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(59_500, Math.round(seconds * 1_000));
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.min(59_500, Math.max(0, timestamp - Date.now()));
}
