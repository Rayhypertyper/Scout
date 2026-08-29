import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";

import { BrowserManager, extractEarlyCareerRadarEmbeddedLinks, extractJobrightOriginalPostHref, isEarlyCareerRadarRoleExpansionLabel, isTargetClosedError, PageFetchError, parseRetryAfter, preferredApplicationDestination } from "../src/crawler/browser.js";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipCrawler, settleSourceTasks } from "../src/crawler/crawler.js";
import type { CrawlStateRecord, PageSnapshot } from "../src/domain/types.js";
import { Logger } from "../src/utils/logger.js";
import { makeInternship } from "./helpers.js";

describe("application redirect selection", () => {
  it("extracts the exact Jobright Original Job Post anchor href without relying on hashed classes", () => {
    const originalUrl = "https://q-block-computing.breezy.hr/p/6d13d3d6cc7e-embedded-systems-developer-intern?jr_id=6a5333d4e726ec56126a6084";
    const html = `<div class="index_job-buttons-item__3G9QM"><a class="index_origin__e6tHu" href="${originalUrl}" target="_blank"><svg></svg><span>Original Job Post</span></a></div>`;
    expect(extractJobrightOriginalPostHref(html, "https://jobright.ai/jobs/info/abc123")).toBe(originalUrl);
    expect(extractJobrightOriginalPostHref("<a href=\"/jobs/company\"><span>Original Job Post</span></a>", "https://jobright.ai/jobs/info/abc123")).toBe("https://jobright.ai/jobs/company");
    expect(extractJobrightOriginalPostHref("<a href=\"https://example.com\">Apply</a>", "https://jobright.ai/jobs/info/abc123")).toBeNull();
  });

  it("recognizes both Early Career Radar grouped-role expansion labels", () => {
    expect(isEarlyCareerRadarRoleExpansionLabel("View 8 roles")).toBe(true);
    expect(isEarlyCareerRadarRoleExpansionLabel("Show 5 more roles")).toBe(true);
    expect(isEarlyCareerRadarRoleExpansionLabel("8 openings↓")).toBe(true);
    expect(isEarlyCareerRadarRoleExpansionLabel("8 openings↑")).toBe(true);
    expect(isEarlyCareerRadarRoleExpansionLabel("Hide all 8 roles")).toBe(false);
    expect(isEarlyCareerRadarRoleExpansionLabel("Load more jobs")).toBe(false);
  });

  it("recovers filtered Early Career Radar detail links from the embedded feed", () => {
    const source = "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus&years=3rd+year";
    const jobs = [
      { id: "us", company: "Acme", title: "Software Engineering Intern", location: "Austin, TX", hub: "Other U.S.", studentYears: ["3rd year"] },
      { id: "france", company: "Acme", title: "Software Engineering Intern", location: "Paris, France", hub: "International", studentYears: ["3rd year"] },
    ];
    const payload = JSON.stringify(`{"initialJobs":${JSON.stringify(jobs)}}`);
    const html = `<script>self.__next_f.push([1,${payload}])</script>`;
    expect(extractEarlyCareerRadarEmbeddedLinks(html, source).map(({ url }) => url)).toEqual([
      "https://earlycareerradar.com/jobs/us",
    ]);
  });

  it("keeps a specific job URL when a same-site request collapses to the career homepage", () => {
    expect(preferredApplicationDestination(
      "https://jobs.sap.com/job/Palo-Alto/Full-Stack-Developer/1425371233",
      "https://jobs.sap.com/",
    )).toBe("https://jobs.sap.com/job/Palo-Alto/Full-Stack-Developer/1425371233");
  });

  it("uses Jobright's Original job post href without clicking the control", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-original-"));
    const jobrightUrl = "https://jobright.ai/jobs/info/abc123";
    const originalUrl = "https://careers.example.com/jobs/software-intern-abc123";
    let href: string | null = originalUrl;
    let clickCount = 0;
    const control = {
      getAttribute: async () => href,
      waitFor: async () => undefined,
      isVisible: async () => true,
      click: async () => { clickCount += 1; },
    };
    const page = {
      goto: async () => undefined,
      waitForTimeout: async () => undefined,
      waitForEvent: async () => null,
      locator: () => ({ filter: () => ({ first: () => control }) }),
      url: () => jobrightUrl,
      close: async () => undefined,
    };
    const context = {
      route: async () => undefined,
      on: () => undefined,
      newPage: async () => page,
      close: async () => undefined,
    };
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => context,
      close: async () => undefined,
    };
    const manager = new BrowserManager(
      resolveSettings({
        outputDirectory: directory,
        databasePath: join(directory, "test.db"),
        retryCount: 0,
        perHostDelayMs: 0,
        selectorTimeoutMs: 250,
      }),
      new Logger("error"),
      async () => fakeBrowser as unknown as Browser,
    );
    try {
      await expect(manager.resolveApplicationUrl(jobrightUrl)).resolves.toBe(originalUrl);
      expect(clickCount).toBe(0);
      href = null;
      await expect(manager.resolveApplicationUrl(jobrightUrl)).resolves.toBeNull();
    } finally {
      await manager.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("accepts a redirect that remains at least as specific", () => {
    expect(preferredApplicationDestination(
      "https://boards.greenhouse.io/acme/jobs/123",
      "https://job-boards.greenhouse.io/acme/jobs/123",
    )).toBe("https://job-boards.greenhouse.io/acme/jobs/123");
  });

  it("honors a numeric Retry-After value while capping pathological waits", () => {
    expect(parseRetryAfter("2")).toBe(2_000);
    expect(parseRetryAfter("999999")).toBe(59_500);
    expect(parseRetryAfter("not-a-delay")).toBeNull();
  });

  it("classifies Playwright target loss separately from ordinary navigation errors", () => {
    expect(isTargetClosedError(new Error("browserContext.newPage: Target page, context or browser has been closed"))).toBe(true);
    expect(isTargetClosedError(new Error("page.goto: Timeout 30000ms exceeded"))).toBe(false);
  });

  it("settles sibling source tasks after one source rejects", async () => {
    const settled = await settleSourceTasks([
      async () => { throw new Error("one source failed"); },
      async () => "sibling completed",
    ]);
    expect(settled[0]?.status).toBe("rejected");
    expect(settled[1]).toEqual({ status: "fulfilled", value: "sibling completed" });
  });

  it("recreates only the dead context and waits to close the browser until sibling work settles", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-browser-lifecycle-"));
    let failNextNavigation = true;
    let launchCount = 0;
    let browserCloseCount = 0;
    let contextCloseCount = 0;
    const locator = {
      first: () => locator,
      waitFor: async () => undefined,
      innerText: async () => "Software Engineering Intern",
      isVisible: async () => false,
      count: async () => 0,
      nth: () => locator,
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
    };
    const makePage = () => {
      const page = {
        on: () => undefined,
        off: () => undefined,
        goto: async () => {
          if (failNextNavigation) {
            failNextNavigation = false;
            throw new Error("browserContext.newPage: Target page, context or browser has been closed");
          }
          return { status: () => 200, headers: () => ({ "content-type": "text/html" }) };
        },
        waitForTimeout: async () => undefined,
        waitForFunction: async () => undefined,
        locator: () => locator,
        getByRole: () => locator,
        content: async () => "<html><body>Software Engineering Intern</body></html>",
        url: () => "https://source.example/jobs/1",
        title: async () => "Internship",
        frames: () => [{ evaluate: async () => [] }],
        evaluate: async () => undefined,
        close: async () => undefined,
      };
      return page;
    };
    const makeContext = () => {
      const context = {
        route: async () => undefined,
        on: () => undefined,
        newPage: async () => makePage(),
        close: async () => { contextCloseCount += 1; },
      };
      return context;
    };
    let connected = true;
    const fakeBrowser = {
      isConnected: () => connected,
      newContext: async () => makeContext(),
      close: async () => { browserCloseCount += 1; connected = false; },
    };
    const manager = new BrowserManager(
      resolveSettings({
        outputDirectory: directory,
        databasePath: join(directory, "test.db"),
        retryCount: 1,
        browserConcurrency: 2,
        perDomainConcurrency: 1,
        perHostDelayMs: 0,
        maxLoadMoreClicks: 0,
      }),
      new Logger("error"),
      async () => { launchCount += 1; return fakeBrowser as unknown as Browser; },
    );
    try {
      const [first, second] = await Promise.all([
        manager.fetchPage("https://source-a.example/jobs"),
        manager.fetchPage("https://source-b.example/jobs"),
      ]);
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(launchCount).toBe(1);
      expect(browserCloseCount).toBe(0);
      expect(contextCloseCount).toBe(0);
      await manager.releaseSource("https://source-a.example/jobs");
      expect(contextCloseCount).toBe(1);
    } finally {
      await manager.close();
      rmSync(directory, { recursive: true, force: true });
    }
    expect(contextCloseCount).toBe(3);
    expect(browserCloseCount).toBe(1);
  });

  it("skips a browser page that exceeds the hard page deadline", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-browser-timeout-"));
    let pageCloseCount = 0;
    const page = {
      on: () => undefined,
      off: () => undefined,
      goto: async () => new Promise<never>(() => undefined),
      close: async () => { pageCloseCount += 1; },
    };
    const context = {
      route: async () => undefined,
      on: () => undefined,
      newPage: async () => page,
      close: async () => undefined,
    };
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => context,
      close: async () => undefined,
    };
    const manager = new BrowserManager(
      resolveSettings({
        outputDirectory: directory,
        databasePath: join(directory, "test.db"),
        pageTimeoutMs: 1_000,
        retryCount: 0,
        perHostDelayMs: 0,
      }),
      new Logger("error"),
      async () => fakeBrowser as unknown as Browser,
    );
    try {
      await expect(manager.fetchPage("https://slow.example/jobs")).rejects.toBeInstanceOf(PageFetchError);
      await expect(manager.fetchPage("https://slow.example/jobs/again")).rejects.toMatchObject({ errorType: "page_timeout" });
      expect(pageCloseCount).toBe(2);
    } finally {
      await manager.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not re-enqueue a known unchanged URL rediscovered by the browser listing", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-browser-incremental-"));
    const source = "https://dynamic.example/careers";
    const knownUrl = "https://dynamic.example/jobs/known-1";
    const knownJob = makeInternship({ sourceUrl: source, postingUrl: knownUrl, applicationUrl: knownUrl, jobId: "known-1" });
    const record = {
      sourceUrl: source,
      sourceId: 1,
      internshipId: "known-1",
      canonicalUrl: knownUrl,
      applicationUrl: knownUrl,
      postingUrl: knownUrl,
      externalJobId: "known-1",
      providerIdentity: "dynamic.example",
      company: knownJob.company,
      title: knownJob.title,
      contentHash: "known-hash",
      firstSeenAt: knownJob.discoveredAt,
      lastSeenAt: knownJob.lastVerifiedAt,
      lastCheckedAt: knownJob.lastVerifiedAt,
      lastVerifiedAt: knownJob.lastVerifiedAt,
      etag: null,
      lastModified: null,
      lifecycleStatus: "NEW",
      availabilityStatus: "open",
      failureState: "none",
      failureCount: 0,
      lastFailureAt: null,
      lastFailureMessage: null,
      missCount: 0,
      internship: knownJob,
      sourceProvenance: [source],
    } as unknown as CrawlStateRecord;
    const browserCalls: string[] = [];
    const listingSnapshot: PageSnapshot = {
      requestedUrl: source,
      url: source,
      status: 200,
      contentType: "text/html",
      title: "Careers",
      html: `<main><a href="${knownUrl}">Software Engineering Intern</a></main>`,
      text: "Software Engineering Intern",
      links: [{ url: knownUrl, text: "Software Engineering Intern", rel: "" }],
      fetchedAt: new Date().toISOString(),
    };
    const fakeBrowser = {
      navigations: 0,
      fetchPage: async (url: string): Promise<PageSnapshot> => {
        browserCalls.push(url);
        fakeBrowser.navigations += 1;
        return listingSnapshot;
      },
      releaseSource: async () => undefined,
      close: async () => undefined,
    };
    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      respectRobotsTxt: false,
      retryCount: 0,
      perHostDelayMs: 0,
      maxDepth: 2,
      maxPagesPerSource: 5,
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><div id='root'></div><script>window.__next_f=[]</script></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    (crawler as unknown as { browser: typeof fakeBrowser }).browser = fakeBrowser;
    const sightings: unknown[] = [];
    const result = await crawler.crawl([source], new Map([[source, [knownUrl]]]), undefined, undefined, {
      classifyListing: () => ({ disposition: "unchanged", record, validatorsMatch: true, reason: "matching validator" }),
      runId: 1,
      recordLightweightSightings: (_runId, entries) => { sightings.push(...entries); },
    });

    expect(browserCalls).toEqual([source]);
    expect(result.jobs).toHaveLength(1);
    expect(result.metrics?.unchangedSkips).toBe(1);
    expect(result.metrics?.detailPagesFetched).toBe(0);
    expect(result.metrics?.browserNavigations).toBe(1);
    expect(sightings).toHaveLength(1);
    rmSync(directory, { recursive: true, force: true });
  });
});
