import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { BrowserManager, PageFetchError } from "../src/crawler/browser.js";
import { InternshipCrawler, isRetryableFailure } from "../src/crawler/crawler.js";
import { isApplyBoltNotFoundPage } from "../src/crawler/publicSources.js";
import { sourceNeedsDeferredRetry } from "../src/crawler/sourceOrchestration.js";
import { Logger } from "../src/utils/logger.js";

const source = "https://www.applybolt.app/jobs/2027-all-internships";
const missingPage = `${source}?page=273`;
const directories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function settings() {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-applybolt-not-found-"));
  directories.push(directory);
  return resolveSettings({
    outputDirectory: directory, respectRobotsTxt: false, perHostDelayMs: 0,
    retryCount: 3, httpConcurrency: 2, perDomainConcurrency: 2,
  });
}

function requestUrl(input: Parameters<typeof globalThis.fetch>[0]): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

function html(body: string, status = 200) {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

describe("ApplyBolt 404 skips", () => {
  it.each([source, missingPage, "https://applybolt.app/jobs/unknown"])("skips %s after one request without browser work or source retry", async (url) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(html("not found", 404));
    const browserStart = vi.spyOn(BrowserManager.prototype, "start").mockRejectedValue(new Error("No browser expected"));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl([url]);
    const skipped = result.sourceResults[0]!;

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browserStart).not.toHaveBeenCalled();
    expect(result.failures).toEqual([]);
    expect(result.completedSourceUrls).toEqual([]);
    expect(skipped).toMatchObject({
      jobs: [], closedPages: [], completed: false, coverageComplete: false,
      httpStatus: 404, healthExcluded: true, inventoryStatus: "excluded", attempts: 1,
    });
    expect(skipped.coverageNotes?.join(" ")).toContain("ApplyBolt returned a 404");
    expect(sourceNeedsDeferredRetry(skipped, isRetryableFailure)).toBe(false);
  });

  it("cancels pending pagination on a 404 and continues crawling another source", async () => {
    const otherSource = "https://other.example/jobs";
    const requests: string[] = [];
    let siblingAborted = false;
    let startSibling!: () => void;
    const siblingStarted = new Promise<void>((resolve) => { startSibling = resolve; });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = requestUrl(input);
      requests.push(url);
      if (url === source) return html("<main><p>10,000 recent listings</p><a href='/job/software-intern-123'>Software Intern</a><a href='?page=273'>Next</a><p>Page 1 of 500</p></main>");
      if (url === otherSource) return html("<main>Software Engineering Intern roles. No open positions.</main>");
      if (url === missingPage) {
        await siblingStarted;
        return html("not found", 404);
      }
      if (url === `${source}?page=2`) {
        startSibling();
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            siblingAborted = true;
            reject(new Error("ApplyBolt pagination cancelled"));
          }, { once: true });
        });
      }
      throw new Error(`Unexpected request after ApplyBolt 404: ${url}`);
    });
    const browserStart = vi.spyOn(BrowserManager.prototype, "start").mockRejectedValue(new Error("No browser expected"));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl([source, otherSource]);

    expect(siblingAborted).toBe(true);
    expect(requests).toHaveLength(4);
    expect(requests).toContain(otherSource);
    expect(result.failures).toEqual([]);
    expect(result.sourceResults[0]).toMatchObject({ httpStatus: 404, coverageComplete: false, closedPages: [] });
    expect(result.sourceResults[1]).toMatchObject({ sourceUrl: otherSource, completed: true });
    expect(browserStart).not.toHaveBeenCalled();
  });

  it("skips a 404 during optional browser listing expansion", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(html("<main><a href='/job/software-intern-123'>Software Intern</a><p>Page 1 of 1</p><button>Load more jobs</button></main>"));
    const browserFetch = vi.spyOn(BrowserManager.prototype, "fetchPage").mockRejectedValue(new PageFetchError("HTTP 404", 404, 0, "not_found"));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl([source]);

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
    expect(result.failures).toEqual([]);
    expect(result.sourceResults[0]).toMatchObject({ httpStatus: 404, healthExcluded: true, closedPages: [] });
  });

  it("stops browser navigation before rendering or retries on an ApplyBolt 404", async () => {
    const goto = vi.fn(async () => ({ status: () => 404, headers: () => ({ "content-type": "text/html" }) }));
    const page = {
      on: () => undefined, off: () => undefined, goto,
      url: () => missingPage, close: async () => undefined,
    };
    const context = {
      route: async () => undefined, on: () => undefined,
      newPage: async () => page, close: async () => undefined,
    };
    const browser = {
      isConnected: () => true, newContext: async () => context, close: async () => undefined,
    };
    const manager = new BrowserManager(settings(), new Logger("error"), async () => browser as unknown as Browser);
    try {
      await expect(manager.fetchPage(missingPage)).rejects.toMatchObject({ errorType: "not_found", statusCode: 404, retryCount: 0 });
      expect(goto).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
    }
  });

  it("keeps the skip rule limited to ApplyBolt HTTP 404s", async () => {
    expect(isApplyBoltNotFoundPage(missingPage, 404)).toBe(true);
    expect(isApplyBoltNotFoundPage("https://applybolt.app/job/missing", 404)).toBe(true);
    expect(isApplyBoltNotFoundPage("https://applybolt.app.other.example/jobs", 404)).toBe(false);
    expect(isApplyBoltNotFoundPage("https://other.example/jobs", 404)).toBe(false);
    expect(isApplyBoltNotFoundPage(missingPage, 503)).toBe(false);
    expect(isApplyBoltNotFoundPage("invalid", 404)).toBe(false);

    vi.spyOn(globalThis, "fetch").mockResolvedValue(html("not found", 404));
    const result = await new InternshipCrawler(settings(), new Logger("error")).crawl(["https://csjobs.ca/internships/toronto"]);
    expect(result.failures).toEqual([expect.objectContaining({ errorType: "not_found", statusCode: 404 })]);
    expect(result.sourceResults[0]?.healthExcluded).not.toBe(true);
  });
});
