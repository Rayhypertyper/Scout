import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";

import { resolveSettings } from "../src/config/settings.js";
import { EarlyCareerRadarAdapter, EARLY_CAREER_RADAR_API_URL } from "../src/crawler/adapters/earlyCareerRadar.js";
import { BrowserManager } from "../src/crawler/browser.js";
import { InternshipCrawler, isRetryableFailure } from "../src/crawler/crawler.js";
import { HttpClient } from "../src/crawler/http.js";
import { sourceNeedsDeferredRetry } from "../src/crawler/sourceOrchestration.js";
import { Logger } from "../src/utils/logger.js";

const sourceUrl = "https://earlycareerradar.com/summer-internships?locations=all";
const missingUrl = "https://earlycareerradar.com/jobs/missing-role";
const notFoundHtml = "<html><body><h1>404</h1><h2>This page could not be found.</h2></body></html>";
const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function settings() {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-radar-not-found-"));
  temporaryDirectories.push(directory);
  return resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "test.db"),
    respectRobotsTxt: false,
    perHostDelayMs: 0,
    maxDepth: 1,
    maxPagesPerSource: 4,
    retryCount: 3,
  });
}

function htmlResponse(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

describe("Early Career Radar not-found skips", () => {
  it.each([404, 200])("skips an HTTP %i listing not-found page without alternate retrieval, browser work, or source retry", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => htmlResponse(notFoundHtml, status));
    const browserStart = vi.spyOn(BrowserManager.prototype, "start").mockRejectedValue(new Error("A missing Radar page must not start Chromium"));
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");
    const result = await new InternshipCrawler(settings(), logger).crawl([sourceUrl]);
    const source = result.sourceResults[0]!;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browserStart).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(source).toMatchObject({
      failures: [], closedPages: [], jobs: [], httpStatus: 404,
      completed: false, coverageComplete: false, healthExcluded: true,
      inventoryStatus: "excluded", attempts: 1,
    });
    expect(sourceNeedsDeferredRetry(source, isRetryableFailure)).toBe(false);
    expect(source.coverageNotes?.join(" ")).toContain("skipped without retry");
  });

  it("also skips a missing arbitrary Radar route before the generic browser fallback", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => htmlResponse(notFoundHtml));
    const browserStart = vi.spyOn(BrowserManager.prototype, "start").mockRejectedValue(new Error("No browser fallback expected"));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl([missingUrl]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browserStart).not.toHaveBeenCalled();
    expect(result.sourceResults[0]).toMatchObject({ failures: [], closedPages: [], httpStatus: 404, healthExcluded: true });
  });

  it.each([404, 200])("stops after an HTTP %i API not-found response when the listing markup changed", async (status) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => requestUrl(input) === EARLY_CAREER_RADAR_API_URL
      ? htmlResponse(notFoundHtml, status)
      : htmlResponse("<html><body>Changed listing markup</body></html>"));
    const adapter = new EarlyCareerRadarAdapter(new HttpClient(settings(), new Logger("error")), new Logger("error"));
    const result = await adapter.collect(sourceUrl);

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ snapshots: [], failures: [], httpStatus: 404, browserRequired: false });
  });

  it.each([404, 200])("keeps the feed record and source success when an optional detail returns HTTP %i with a not-found screen", async (status) => {
    const record = {
      id: "missing-role", company: "Example Analytics", title: "Software Engineering Intern - Summer 2027",
      location: "Toronto, ON", hub: "International", closed: false,
      applyUrl: "https://employer.example/jobs/missing-role",
    };
    const payload = `5:["$","$L16",null,{"initialJobs":${JSON.stringify([record])}}]`;
    const listingHtml = `<html><head><script>self.__next_f.push([1,${JSON.stringify(payload)}])</script></head><body>Early Career Radar</body></html>`;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => requestUrl(input) === sourceUrl
      ? htmlResponse(listingHtml)
      : htmlResponse(notFoundHtml, status));
    const browserStart = vi.spyOn(BrowserManager.prototype, "start").mockRejectedValue(new Error("No browser expected"));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl([sourceUrl]);
    const source = result.sourceResults[0]!;

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(browserStart).not.toHaveBeenCalled();
    expect(source).toMatchObject({ failures: [], closedPages: [], status: "success", completed: true, coverageComplete: true });
    expect(source.jobs).toHaveLength(1);
    expect(source.jobs[0]?.internship).toMatchObject({ postingUrl: missingUrl, applicationUrl: record.applyUrl, availabilityStatus: "unknown" });
    expect(source.coverageNotes?.join(" ")).toContain("1 Early Career Radar not-found page(s) skipped without retry");
  });

  it.each([404, 200])("stops browser navigation on an HTTP %i Radar not-found screen before rendering, expansion, or retries", async (status) => {
    const goto = vi.fn(async () => ({ status: () => status, headers: () => ({ "content-type": "text/html" }) }));
    const page = {
      on: () => undefined, off: () => undefined, goto,
      url: () => missingUrl,
      locator: () => ({ innerText: async () => "404\nThis page could not be found." }),
      close: async () => undefined,
    };
    const context = {
      route: async () => undefined, on: () => undefined,
      newPage: async () => page, close: async () => undefined,
    };
    const browser = {
      isConnected: () => true, newContext: async () => context, close: async () => undefined,
    };
    const logger = new Logger("error");
    const warn = vi.spyOn(logger, "warn");
    const manager = new BrowserManager(settings(), logger, async () => browser as unknown as Browser);
    try {
      await expect(manager.fetchPage(missingUrl)).rejects.toMatchObject({ errorType: "not_found", statusCode: 404, retryCount: 0 });
      expect(goto).toHaveBeenCalledTimes(1);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await manager.close();
    }
  });

  it("preserves ordinary missing-page handling for other domains", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => htmlResponse(notFoundHtml, 404));
    const source = "https://other.example/jobs/missing";
    const adapter = new EarlyCareerRadarAdapter(new HttpClient(settings(), new Logger("error")), new Logger("error"));
    expect(adapter.canHandle(source)).toBe(false);
    await expect(new HttpClient(settings(), new Logger("error")).get(source)).rejects.toMatchObject({ errorType: "not_found", statusCode: 404 });
  });
});
