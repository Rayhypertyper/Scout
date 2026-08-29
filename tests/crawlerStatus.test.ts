import { describe, expect, it } from "vitest";

import { InternshipCrawler, isRetryableFailure, sourceStatus } from "../src/crawler/crawler.js";
import type { PageSnapshot, SourceCrawlResult } from "../src/domain/types.js";
import { resolveSettings } from "../src/config/settings.js";
import { Logger } from "../src/utils/logger.js";
import type { SourceAdapterResult } from "../src/crawler/adapters/types.js";
import { analyzed, makeInternship } from "./helpers.js";

function failure(errorType: string) {
  return [{
    sourceUrl: "https://example.com/source",
    url: "https://example.com/source",
    errorType,
    message: "test",
    statusCode: null,
    retryCount: 0,
    occurredAt: "2027-01-01T00:00:00.000Z",
  }];
}

describe("source failure semantics", () => {
  it("does not turn robots denial into an empty successful source", () => {
    expect(sourceStatus(false, 0, failure("robots_disallowed"))).toBe("robots_disallowed");
    expect(sourceStatus(true, 0, [])).toBe("no_internships_found");
    expect(sourceStatus(false, 0, failure("access_denied"))).toBe("access_denied");
  });

  it("does not classify robots/access/closed failures as retryable detail work", () => {
    expect(isRetryableFailure({ errorType: "robots_disallowed", statusCode: null })).toBe(false);
    expect(isRetryableFailure({ errorType: "access_denied", statusCode: 403 })).toBe(false);
    expect(isRetryableFailure({ errorType: "not_found", statusCode: 404 })).toBe(false);
    expect(isRetryableFailure({ errorType: "http_error", statusCode: 503 })).toBe(true);
    expect(isRetryableFailure({ errorType: "page_timeout", statusCode: null })).toBe(true);
  });
});

describe("source timing", () => {
  it("attaches elapsed time to every settled source result", async () => {
    const sourceResult: SourceCrawlResult = {
      sourceUrl: "https://example.com/source",
      pagesVisited: 1,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: false,
      status: "no_internships_found",
    };
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    (crawler as unknown as { crawlSource: () => Promise<SourceCrawlResult> }).crawlSource = async () => sourceResult;

    const result = await crawler.crawl([sourceResult.sourceUrl]);

    expect(result.sourceResults[0]?.durationMs).toEqual(expect.any(Number));
    expect(result.sourceResults[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("releases source payloads after incremental persistence while retaining counts", async () => {
    const source = "https://example.com/source";
    const jobs = Array.from({ length: 3 }, (_, index) => analyzed(makeInternship({
      id: `memory-${index}`,
      jobId: `REQ-MEMORY-${index}`,
      postingUrl: `https://boards.greenhouse.io/northstar/jobs/${index + 100}`,
      applicationUrl: `https://boards.greenhouse.io/northstar/jobs/${index + 100}/apply`,
      sourceUrl: source,
      sources: [source],
    })));
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    (crawler as unknown as { crawlSource: () => Promise<SourceCrawlResult> }).crawlSource = async () => ({
      sourceUrl: source,
      pagesVisited: 1,
      potentialPostingsInspected: jobs.length,
      jobs,
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
      status: "success",
    });
    const persistedResults: SourceCrawlResult[] = [];

    const result = await crawler.crawl(
      [source],
      new Map(),
      (sourceResult) => { persistedResults.push(sourceResult); },
      undefined,
      { runId: 1 },
    );

    expect(persistedResults[0]?.jobs).toHaveLength(3);
    expect(result.sourceResults[0]?.jobs).toHaveLength(0);
    expect(result.sourceResults[0]?.jobsDiscovered).toBe(3);
    expect(result.jobs).toHaveLength(0);
    expect(result.jobsDiscovered).toBe(3);
  });

  it("does not launch browser fan-out after an Early Career Radar source-level 403", async () => {
    const source = "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus";
    const adapterResult: SourceAdapterResult = {
      snapshots: [],
      retrievalMethod: "Early Career Radar server-rendered HTML feed",
      retrievalUrls: [source],
      attempts: 2,
      httpStatus: null,
      notes: ["Early Career Radar listing returned HTTP 403 access denied; API fallback returned HTTP 403 access denied"],
      failures: [{
        sourceUrl: source,
        url: source,
        errorType: "http_error",
        message: "HTTP 403 access denied",
        statusCode: null,
        retryCount: 0,
        occurredAt: new Date().toISOString(),
      }],
      strategy: "browser_required",
      browserRequired: true,
    };
    const crawler = new InternshipCrawler(resolveSettings({ maxPagesPerSource: 10_000 }), new Logger("error"));
    (crawler as unknown as { adapterRouter: { collect: () => Promise<SourceAdapterResult> } }).adapterRouter = {
      collect: async () => adapterResult,
    };
    const browserCalls: string[] = [];
    const fakeBrowser = {
      navigations: 0,
      fetchPage: async (url: string): Promise<PageSnapshot> => {
        browserCalls.push(url);
        throw new Error(`browser fallback should not run: ${url}`);
      },
      releaseSource: async () => undefined,
      close: async () => undefined,
    };
    (crawler as unknown as { browser: typeof fakeBrowser }).browser = fakeBrowser;

    const result = await crawler.crawl([source]);

    expect(browserCalls).toEqual([]);
    expect(result.sourceResults[0]).toMatchObject({
      sourceUrl: source,
      status: "access_denied",
      httpStatus: 403,
      pagesVisited: 0,
      completed: false,
    });
  });

  it("keeps the Early Career Radar browser last-resort path within the page budget", async () => {
    const source = "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus";
    const adapterResult: SourceAdapterResult = {
      snapshots: [],
      retrievalMethod: "Early Career Radar server-rendered HTML feed",
      retrievalUrls: [source],
      attempts: 2,
      httpStatus: null,
      notes: ["Early Career Radar feed shape changed"],
      failures: [],
      strategy: "browser_required",
      browserRequired: true,
    };
    const crawler = new InternshipCrawler(resolveSettings({
      maxPagesPerSource: 10_000,
      maxDepth: 1,
      retryCount: 0,
      browserConcurrency: 4,
      perDomainConcurrency: 3,
    }), new Logger("error"));
    (crawler as unknown as { adapterRouter: { collect: () => Promise<SourceAdapterResult> } }).adapterRouter = {
      collect: async () => adapterResult,
    };
    const detailLinks = Array.from({ length: 250 }, (_, index) => ({
      url: `https://earlycareerradar.com/jobs/job-${index}`,
      text: `Software Engineering Intern ${index}`,
      rel: "",
    }));
    const browserCalls: string[] = [];
    const fakeBrowser = {
      navigations: 0,
      fetchPage: async (url: string): Promise<PageSnapshot> => {
        browserCalls.push(url);
        fakeBrowser.navigations += 1;
        return {
          requestedUrl: url,
          url,
          status: 200,
          contentType: "text/html",
          title: "Early Career Radar",
          html: "<main>Radar fallback</main>",
          text: "Radar fallback",
          links: url === source ? detailLinks : [],
          fetchedAt: new Date().toISOString(),
        };
      },
      releaseSource: async () => undefined,
      close: async () => undefined,
    };
    (crawler as unknown as { browser: typeof fakeBrowser }).browser = fakeBrowser;

    const result = await crawler.crawl([source]);

    expect(browserCalls).toHaveLength(100);
    expect(result.sourceResults[0]?.pagesVisited).toBe(100);
    expect(result.sourceResults[0]?.completed).toBe(true);
  });
});
