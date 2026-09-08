import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_BROWSER_SUPPRESSION_COOLDOWN_MS,
  isBrowserFallbackSuppressed,
  isSourceCircuitOpen,
  runIsolatedSourceAttempt,
  settleSourceTasks,
  sourceNeedsDeferredRetry,
} from "../src/crawler/sourceOrchestration.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { resolveSettings } from "../src/config/settings.js";
import { isRetryableFailure } from "../src/crawler/retryPolicy.js";
import { CrawlCancelledError, CrawlDeadlineExceededError, SourceStalledError } from "../src/domain/cancellation.js";
import type { PageSnapshot, SourceCrawlResult } from "../src/domain/types.js";
import { Logger } from "../src/utils/logger.js";

afterEach(() => {
  vi.useRealTimers();
});

function result(overrides: Partial<SourceCrawlResult> = {}): SourceCrawlResult {
  return {
    sourceUrl: "https://example.com/jobs",
    pagesVisited: 0,
    potentialPostingsInspected: 0,
    jobs: [],
    failures: [],
    closedPages: [],
    completed: false,
    coverageComplete: false,
    status: "source_unavailable",
    ...overrides,
  };
}

describe("isolated source orchestration", () => {
  it("does not start work for a pre-aborted run", async () => {
    const controller = new AbortController();
    const deadline = new CrawlDeadlineExceededError(1_000);
    controller.abort(deadline);
    let started = false;

    await expect(runIsolatedSourceAttempt({
      sourceUrl: "https://example.com/jobs",
      signal: controller.signal,
    }, (() => {
      started = true;
      return Promise.resolve("unexpected");
    }))).rejects.toBe(deadline);
    expect(started).toBe(false);
  });

  it("removes the run listener when adapter startup throws synchronously", async () => {
    const controller = new AbortController();
    const addListener = vi.spyOn(controller.signal, "addEventListener");
    const removeListener = vi.spyOn(controller.signal, "removeEventListener");
    const startupError = new Error("adapter startup failed");
    const syncStartup = (): Promise<never> => {
      throw startupError;
    };

    await expect(runIsolatedSourceAttempt({
      sourceUrl: "https://example.com/jobs",
      signal: controller.signal,
    }, syncStartup)).rejects.toBe(startupError);

    expect(addListener).toHaveBeenCalledTimes(1);
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it("keeps the stall error when source cleanup throws", async () => {
    vi.useFakeTimers();
    const attempt = runIsolatedSourceAttempt({
      sourceUrl: "https://example.com/jobs",
      maxDurationMs: 10,
      onStall: () => {
        throw new Error("browser cleanup failed");
      },
    }, () => new Promise<never>(() => undefined));

    const rejection = expect(attempt).rejects.toBeInstanceOf(SourceStalledError);
    await vi.advanceTimersByTimeAsync(10);
    await rejection;
  });

  it("settles every task with a finite worker count", async () => {
    const tasks = [
      async () => "first",
      async () => { throw new Error("second"); },
      async () => "third",
    ];

    const settled = await settleSourceTasks(tasks, Number.NaN);
    expect(settled[0]).toEqual({ status: "fulfilled", value: "first" });
    expect(settled[1]?.status).toBe("rejected");
    if (settled[1]?.status === "rejected") expect(settled[1].reason).toBeInstanceOf(Error);
    expect(settled[2]).toEqual({ status: "fulfilled", value: "third" });
    await expect(settleSourceTasks(tasks, Number.POSITIVE_INFINITY)).resolves.toHaveLength(3);
  });
});

describe("durable source decisions", () => {
  const now = Date.parse("2027-01-01T00:00:00.000Z");

  it("opens and then recovers a persisted source circuit", () => {
    expect(isSourceCircuitOpen({ cooldownUntil: "2027-01-01T00:01:00.000Z" }, now)).toBe(true);
    expect(isSourceCircuitOpen({ cooldownUntil: "2026-12-31T23:59:00.000Z" }, now)).toBe(false);
    expect(isSourceCircuitOpen({ consecutiveFailures: 3, lastFailureAt: "2026-12-31T23:59:00.000Z" }, now)).toBe(true);
  });

  it("suppresses only recently ineffective browser fallbacks and allows reprobe", () => {
    const fallbackAt = new Date(now - 1_000).toISOString();
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 3, browserFallbackSuccesses: 0, lastBrowserFallbackAt: fallbackAt }, now)).toBe(true);
    // A prior useful fallback must not exempt three newer ineffective
    // attempts once durable health provides their consecutive count.
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 4, browserFallbackSuccesses: 1, consecutiveBrowserFallbackFailures: 3, lastBrowserFallbackAt: fallbackAt }, now)).toBe(true);
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 4, browserFallbackSuccesses: 2, consecutiveBrowserFallbackFailures: 0, lastBrowserFallbackAt: fallbackAt }, now)).toBe(false);
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 3, browserFallbackSuccesses: 1, lastBrowserFallbackAt: fallbackAt }, now)).toBe(false);
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 3, browserFallbackSuccesses: 0 }, now)).toBe(false);
    expect(isBrowserFallbackSuppressed({ browserFallbackCount: 3, browserFallbackSuccesses: 0, lastBrowserFallbackAt: new Date(now - DEFAULT_BROWSER_SUPPRESSION_COOLDOWN_MS - 1).toISOString() }, now)).toBe(false);
  });

  it("defers transient source failures but never permanent denials", () => {
    expect(sourceNeedsDeferredRetry(result({
      failures: [{
        sourceUrl: "https://example.com/jobs",
        url: "https://example.com/jobs",
        errorType: "http_error",
        message: "temporary outage",
        statusCode: 503,
        retryCount: 0,
        occurredAt: new Date(now).toISOString(),
      }],
    }), isRetryableFailure)).toBe(true);
    expect(sourceNeedsDeferredRetry(result({
      status: "access_denied",
      failures: [{
        sourceUrl: "https://example.com/jobs",
        url: "https://example.com/jobs",
        errorType: "access_denied",
        message: "forbidden",
        statusCode: 403,
        retryCount: 0,
        occurredAt: new Date(now).toISOString(),
      }],
    }), isRetryableFailure)).toBe(false);
    expect(sourceNeedsDeferredRetry(result({ status: "no_internships_found", coverageComplete: true }), isRetryableFailure)).toBe(false);
  });

  it("maps generic run cancellation to an actionable cancellation error", async () => {
    const controller = new AbortController();
    const attempt = runIsolatedSourceAttempt({
      sourceUrl: "https://example.com/jobs",
      signal: controller.signal,
    }, () => new Promise<never>(() => undefined));
    controller.abort();
    await expect(attempt).rejects.toBeInstanceOf(CrawlCancelledError);
  });

  it("drives static browser fallback suppression and later reprobe in production crawl", async () => {
    const source = "https://example.com/careers";
    const listingSnapshot: PageSnapshot = {
      requestedUrl: source,
      url: source,
      status: 200,
      contentType: "text/html",
      title: "Example careers",
      html: "<main id=\"root\"></main>",
      text: "Load more jobs",
      links: [],
      fetchedAt: new Date().toISOString(),
    };
    const dynamicSnapshot: PageSnapshot = {
      ...listingSnapshot,
      links: [{ url: `${source}/job/123`, text: "Software Engineering Intern", rel: "" }],
      text: "Software Engineering Intern",
    };
    const staticAdapters = {
      profile: () => ({ name: "Test static", detailPath: /^\/careers\/job\//i }),
      collectListing: async () => ({
        listingSnapshots: [listingSnapshot],
        detailCandidates: [],
        retrievalMethod: "Test static HTTP",
        retrievalUrls: [source],
        attempts: 1,
        httpStatus: 200,
        notes: [],
        failures: [],
      }),
      fetchDetails: async () => ({
        snapshots: [],
        retrievalMethod: "Test static HTTP details",
        retrievalUrls: [],
        attempts: 0,
        httpStatus: null,
        notes: [],
        failures: [],
      }),
    };
    const browserCalls: string[] = [];
    const browser = {
      navigations: 0,
      fetchPage: async (url: string): Promise<PageSnapshot> => {
        browserCalls.push(url);
        return dynamicSnapshot;
      },
      releaseSource: async () => undefined,
      cancelSource: () => undefined,
      close: async () => undefined,
    };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    (crawler as unknown as { staticAdapters: unknown }).staticAdapters = staticAdapters;
    (crawler as unknown as { browser: unknown }).browser = browser;
    let suppressed = true;
    const healthReads: string[] = [];
    const persistence = {
      getSourceHealth: (value: string) => {
        healthReads.push(value);
        return suppressed
          ? {
            browserFallbackCount: 3,
            browserFallbackSuccesses: 0,
            lastBrowserFallbackAt: new Date().toISOString(),
          }
          : {
            browserFallbackCount: 3,
            browserFallbackSuccesses: 0,
            lastBrowserFallbackAt: new Date(Date.now() - DEFAULT_BROWSER_SUPPRESSION_COOLDOWN_MS - 1).toISOString(),
          };
      },
    };

    const skipped = await crawler.crawl([source], new Map(), undefined, undefined, persistence);
    expect(browserCalls).toEqual([]);
    expect(healthReads).toEqual([source]);
    expect(skipped.sourceResults[0]).toMatchObject({
      status: "source_unavailable",
      coverageComplete: false,
      retrievalMethod: "browser fallback suppression",
    });

    suppressed = false;
    const reprobed = await crawler.crawl([source], new Map(), undefined, undefined, persistence);
    expect(browserCalls).toEqual([source]);
    expect(reprobed.sourceResults[0]?.metrics).toMatchObject({
      browserFallbacks: 1,
      browserFallbackSuccesses: 1,
    });
  });

});
