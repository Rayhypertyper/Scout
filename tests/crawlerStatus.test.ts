import { describe, expect, it, vi } from "vitest";

import { InternshipCrawler, isRetryableFailure, sourceStatus } from "../src/crawler/crawler.js";
import type { PageSnapshot, RawJob, SourceCrawlResult } from "../src/domain/types.js";
import type { HttpClient } from "../src/crawler/http.js";
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

  it("treats a static detail 404 as a closed posting instead of a source failure", async () => {
    const source = "https://interninsider.me/internships/new";
    const detail = "https://interninsider.me/internships/acme/software-engineering-intern-123";
    const staticAdapters = {
      profile: () => ({ name: "InternInsider", detailPath: /^\/internships\/[^/]+\/[^/]+/i }),
      collectListing: async () => ({
        listingSnapshots: [{
          requestedUrl: source,
          url: source,
          status: 200,
          contentType: "text/html",
          title: "New internships",
          html: "<main>New internships</main>",
          text: "New internships",
          links: [],
          fetchedAt: new Date().toISOString(),
        }],
        detailCandidates: [{ url: detail, title: "Software Engineering Intern", snippet: "Software Engineering Intern", sourceUrl: source }],
        retrievalMethod: "InternInsider static HTTP",
        retrievalUrls: [source],
        attempts: 1,
        httpStatus: 200,
        notes: [],
        failures: [],
      }),
      fetchDetails: async () => ({
        snapshots: [],
        retrievalMethod: "InternInsider static HTTP details",
        retrievalUrls: [],
        attempts: 1,
        httpStatus: null,
        notes: ["A detail page could not be retrieved: HTTP 404 not found"],
        failures: [{
          sourceUrl: source,
          url: detail,
          errorType: "not_found",
          message: "HTTP 404 not found",
          statusCode: 404,
          retryCount: 0,
          occurredAt: new Date().toISOString(),
        }],
      }),
    };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    (crawler as unknown as { staticAdapters: unknown }).staticAdapters = staticAdapters;

    const crawl = await crawler.crawl([source]);

    expect(crawl.sourceResults[0]).toMatchObject({
      status: "no_internships_found",
      completed: true,
      failures: [],
      closedPages: [{ url: detail, reason: "HTTP 404", statusCode: 404 }],
      coverageNotes: ["1 detail listing URL(s) returned HTTP 404 and were treated as closed postings."],
    });
  });
});

describe("source timing", () => {
  it("keeps a complete empty Intern List feed on HTTP and marks its inventory complete", async () => {
    const source = "https://www.intern-list.com/?k=eng";
    const payload = JSON.stringify({ success: true, result: { total: 0, jobList: [] } });
    const emptyFeedUrl = "https://swan-api.jobright.ai/swan/mini-sites/list?count=50&position=0&feedCategory=intern%3Aus%3Aengineering_development";
    const emptyFeed: PageSnapshot = {
      requestedUrl: emptyFeedUrl,
      url: emptyFeedUrl,
      status: 200,
      contentType: "application/json",
      title: "Intern List feed",
      html: "",
      text: payload,
      links: [],
      fetchedAt: new Date().toISOString(),
    };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = {
      collect: async (): Promise<SourceAdapterResult> => ({
        snapshots: [emptyFeed],
        retrievalMethod: "Intern List structured API",
        retrievalUrls: [emptyFeedUrl],
        attempts: 1,
        httpStatus: 200,
        notes: ["Retrieved 0 rows (0 unique job IDs) against advertised total 0 in one complete structured snapshot."],
        failures: [],
        strategy: "structured_endpoint",
        inventoryComplete: true,
      }),
    };
    const browser = (crawler as unknown as { browser: { fetchPage: (...args: unknown[]) => Promise<PageSnapshot> } }).browser;
    const browserFetch = vi.spyOn(browser, "fetchPage").mockRejectedValue(new Error("unexpected browser fallback"));

    const result = await crawler.crawl([source]);

    expect(browserFetch).not.toHaveBeenCalled();
    expect(result.sourceResults[0]).toMatchObject({
      completed: true,
      coverageComplete: true,
      status: "no_internships_found",
      jobs: [],
      failures: [],
    });
  });

  it("keeps a nonempty result partial when an adapter reports incomplete inventory", async () => {
    const source = "https://www.intern-list.com/?k=eng";
    const root: PageSnapshot = { requestedUrl: source, url: source, status: 200, contentType: "application/json", title: "Internships", html: "", text: "Software Engineering Intern", links: [], fetchedAt: new Date().toISOString() };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = {
      collect: async (): Promise<SourceAdapterResult> => ({ snapshots: [root], retrievalMethod: "Intern List feed", retrievalUrls: [source], attempts: 1, httpStatus: 200, notes: [], failures: [], strategy: "structured_endpoint", inventoryComplete: false }),
    };
    (crawler as unknown as { extractJobsWithFallback: unknown }).extractJobsWithFallback = async (): Promise<RawJob[]> => [{ company: "Acme", title: "Software Engineering Intern", postingUrl: "https://jobright.ai/jobs/info/987654", locations: ["Toronto, Canada"], description: "Software internship", sourceProvider: "jobright-intern-list" }];
    (crawler as unknown as { analyzeJobWithProfile: unknown }).analyzeJobWithProfile = async () => ({ accepted: true, value: analyzed(makeInternship({ sourceUrl: source, sources: [source], jobId: "987654" })) });

    const result = await crawler.crawl([source]);

    expect(result.sourceResults[0]).toMatchObject({ completed: true, coverageComplete: false, status: "partial" });
  });

  it("reports qualifying Jobright roles without cached employer destinations as incomplete coverage", async () => {
    const source = "https://www.intern-list.com/?k=swe";
    const root: PageSnapshot = { requestedUrl: source, url: source, status: 200, contentType: "application/json", title: "Internships", html: "", text: "Software Engineering Intern", links: [], fetchedAt: new Date().toISOString() };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = {
      collect: async (): Promise<SourceAdapterResult> => ({ snapshots: [root], retrievalMethod: "Intern List feed", retrievalUrls: [source], attempts: 1, httpStatus: 200, notes: [], failures: [], strategy: "structured_endpoint" }),
    };
    (crawler as unknown as { extractJobsWithFallback: unknown }).extractJobsWithFallback = async (): Promise<RawJob[]> => [{ company: "Acme", title: "Software Engineering Intern", postingUrl: "https://jobright.ai/jobs/info/123", locations: ["Toronto, Canada"], description: "Software internship", sourceProvider: "jobright-intern-list" }];
    (crawler as unknown as { analyzeJobWithProfile: unknown }).analyzeJobWithProfile = async () => ({ accepted: false, reason: "Jobright's Original job post could not be resolved to an employer or ATS posting." });
    const result = await crawler.crawl([source], new Map(), undefined, undefined, { getJobrightDestinations: () => new Map() });
    expect(result.sourceResults[0]).toMatchObject({ completed: true, coverageComplete: false, status: "partial", jobs: [] });
    expect(result.sourceResults[0]?.coverageNotes?.join(" ")).toContain("1 qualifying Jobright listing(s)");
  });

  it("retains Radar detail links beyond the former 5000-listing and 2000-page ceilings", async () => {
    const source = "https://earlycareerradar.com/summer-internships";
    const links = Array.from({ length: 5100 }, (_, index) => ({ url: `${source.replace('/summer-internships', '')}/jobs/job-${index}`, text: "Software Engineering Intern", rel: "" }));
    const root: PageSnapshot = { requestedUrl: source, url: source, status: 200, contentType: "text/html", title: "Internships", html: "", text: "", links, fetchedAt: new Date().toISOString() };
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false, maxPagesPerSource: 100, maxDepth: 1 }), new Logger("error"));
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = {
      collect: async (): Promise<SourceAdapterResult> => ({ snapshots: [root], retrievalMethod: "Radar HTML", retrievalUrls: [source], attempts: 1, httpStatus: 200, notes: [], failures: [], strategy: "static_html", maxRawListings: 10_000 }),
    };
    (crawler as unknown as { extractJobsWithFallback: unknown }).extractJobsWithFallback = async () => [];
    const http = (crawler as unknown as { http: HttpClient }).http;
    const get = vi.spyOn(http, "get").mockImplementation(async (url) => ({ requestedUrl: url, url, status: 200, contentType: "text/html", body: "", headers: {}, attempts: 1, fromCache: false }));
    try {
      const result = await crawler.crawl([source]);
      expect(get).toHaveBeenCalledTimes(5100);
      expect(result.sourceResults[0]).toMatchObject({ completed: true, pagesVisited: 5101, failures: [] });
    } finally { get.mockRestore(); }
  });

  it("stops Radar discovery after parsing a role while preserving its employer Apply URL", async () => {
    const source = "https://earlycareerradar.com/summer-internships";
    const detail = "https://earlycareerradar.com/jobs/job-1";
    const employer = "https://careers.example.com/jobs/software-intern-1";
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false, maxDepth: 4 }), new Logger("error"));
    const root: PageSnapshot = { requestedUrl: source, url: source, status: 200, contentType: "text/html", title: "Internships", html: "", text: "", links: [{ url: detail, text: "Software Engineering Intern", rel: "" }], fetchedAt: new Date().toISOString() };
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = {
      collect: async (): Promise<SourceAdapterResult> => ({ snapshots: [root], retrievalMethod: "Radar HTML", retrievalUrls: [source], attempts: 1, httpStatus: 200, notes: [], failures: [], strategy: "static_html", maxRawListings: 10_000 }),
    };
    (crawler as unknown as { extractJobsWithFallback: unknown }).extractJobsWithFallback = async (snapshot: PageSnapshot): Promise<RawJob[]> => snapshot.url === detail ? [{ company: "Acme", title: "Software Engineering Intern", applicationUrl: employer, postingUrl: detail, locations: ["Toronto, Canada"], description: "Software engineering internship", sourceProvider: "generic" }] : [];
    (crawler as unknown as { analyzeJobWithProfile: unknown }).analyzeJobWithProfile = async () => ({ accepted: true, value: analyzed(makeInternship({ applicationUrl: employer, postingUrl: detail, sourceUrl: source, sources: [source] })) });
    const http = (crawler as unknown as { http: HttpClient }).http;
    const get = vi.spyOn(http, "get").mockImplementation(async (url) => ({ requestedUrl: url, url, status: 200, contentType: "text/html", body: `<a href="${employer}">Software Engineering Intern Apply</a>`, headers: {}, attempts: 1, fromCache: false }));
    try {
      const result = await crawler.crawl([source]);
      expect(get.mock.calls.map(([url]) => url)).toEqual([detail]);
      expect(result.sourceResults[0]?.jobs[0]?.internship.applicationUrl).toBe(employer);
    } finally { get.mockRestore(); }
  });

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
    expect(result.sourceResults[0]).toMatchObject({
      completed: true,
      coverageComplete: false,
      trustedInventory: false,
      inventoryStatus: "unknown",
      status: "partial",
    });
  });
});
