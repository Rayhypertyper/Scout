import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InternshipCrawler } from "../src/crawler/crawler.js";
import { INTERN_LIST_API_URL } from "../src/crawler/adapters/internList.js";
import type { CrawlStateDecision, CrawlStateRecord } from "../src/domain/types.js";
import { resolveSettings } from "../src/config/settings.js";
import { Logger } from "../src/utils/logger.js";
import { makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("generic HTTP incremental pipeline", () => {
  it("uses the public Intern List feed origin when the page shell is robots-disallowed", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-intern-list-pipeline-"));
    temporaryDirectories.push(directory);
    const source = "https://www.intern-list.com/?k=swe";
    const requests: Array<{ url: string; method: string; category?: string }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
      const body = typeof init?.body === "string" ? init.body : "";
      const category = body ? (JSON.parse(body) as { category?: string }).category : undefined;
      requests.push({ url, method, ...(category ? { category } : {}) });
      if (url === "https://swan-api.jobright.ai/robots.txt") return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      if (url.startsWith("https://swan-api.jobright.ai/swan/mini-sites/list?")) {
        const jobId = category === "intern:ca:engineering_development" ? "canada-job" : "us-job";
        return new Response(JSON.stringify({
          success: true,
          result: {
            total: 1,
            jobList: [{
              jobId,
              tabCategory: [category],
              properties: {
                title: "Software Engineering Intern",
                company: "Example Robotics",
                location: "Toronto, ON",
                workModel: "Hybrid",
                industry: ["Software"],
                qualifications: "1. Pursuing Computer Science. 2. Experience with Python.",
              },
              postedAt: 1786803050000,
            }],
          },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      respectRobotsTxt: true,
      retryCount: 0,
      perHostDelayMs: 0,
      maxDepth: 0,
      maxPagesPerSource: 8,
      httpConcurrency: 2,
      browserConcurrency: 1,
    });
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    const originalPostCalls: string[] = [];
    const fakeBrowser = {
      navigations: 0,
      resolveOriginalJobPostUrl: async (url: string) => {
        originalPostCalls.push(url);
        return `https://employer.example/jobs/${new URL(url).pathname.split("/").filter(Boolean).at(-1)}`;
      },
      resolveApplicationUrl: async (url: string) => `https://employer.example/jobs/${new URL(url).pathname.split("/").filter(Boolean).at(-1)}`,
      releaseSource: async () => undefined,
      close: async () => undefined,
    };
    (crawler as unknown as { browser: typeof fakeBrowser }).browser = fakeBrowser;
    const result = await crawler.crawl([source]);

    expect(result.sourceResults[0]?.status).toBe("success");
    expect(result.sourceResults[0]?.jobs.length).toBe(2);
    expect(result.jobs.every(({ internship }) => internship.postingUrl.startsWith("https://employer.example/jobs/"))).toBe(true);
    expect(result.jobs.every(({ internship }) => internship.applicationUrl === internship.postingUrl)).toBe(true);
    expect(new Set(originalPostCalls).size).toBe(2);
    const postCategories = requests.filter(({ method }) => method === "POST").map(({ category }) => category);
    expect(postCategories).toEqual(expect.arrayContaining([
      "intern:us:swe",
      "intern:ca:engineering_development",
    ]));
    expect(new Set(postCategories).size).toBe(2);
    expect(requests.map(({ url }) => url)).not.toContain(source);
  });

  it("settles a failed Intern List target without browser fallback or sibling cancellation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-intern-list-failure-"));
    temporaryDirectories.push(directory);
    const source = "https://www.intern-list.com/?k=eng";
    const sibling = "https://sibling.example/careers";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? (typeof input !== "string" && !(input instanceof URL) ? input.method : "GET");
      requests.push(`${method} ${url}`);
      if (url === "https://swan-api.jobright.ai/robots.txt" || url === "https://sibling.example/robots.txt") {
        return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (url.startsWith(`${INTERN_LIST_API_URL}?`)) {
        return new Response("temporarily unavailable", { status: 404, headers: { "content-type": "text/plain" } });
      }
      if (url === sibling) {
        return new Response("<main><h1>Software Engineering Intern</h1></main>", { status: 200, headers: { "content-type": "text/html" } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      respectRobotsTxt: true,
      retryCount: 0,
      perHostDelayMs: 0,
      maxDepth: 0,
      maxPagesPerSource: 2,
      httpConcurrency: 2,
      browserConcurrency: 1,
    });
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    const browserCalls: string[] = [];
    const fakeBrowser = {
      navigations: 0,
      fetchPage: async (url: string) => {
        browserCalls.push(url);
        throw new Error(`browser fallback should not run for this test: ${url}`);
      },
      releaseSource: async () => undefined,
      close: async () => undefined,
    };
    (crawler as unknown as { browser: typeof fakeBrowser }).browser = fakeBrowser;

    const result = await crawler.crawl([source, sibling]);

    expect(result.sourceResults).toHaveLength(2);
    expect(result.sourceResults[0]).toMatchObject({ sourceUrl: source, status: "source_unavailable", completed: false });
    expect(result.sourceResults[1]?.sourceUrl).toBe(sibling);
    expect(browserCalls).toEqual([]);
    expect(requests.some((request) => request.includes(`GET ${source}`))).toBe(false);
  });

  it("classifies a repeated listing identity once before detail fetch", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-pipeline-"));
    temporaryDirectories.push(directory);
    const source = "https://example.test/careers";
    const detail = "https://example.test/jobs/1";
    const pageTwo = "https://example.test/careers?page=2";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === source) return new Response(`<main><a href="${pageTwo}">Jobs page 2</a><a href="${detail}">Software Engineering Intern</a></main>`, { status: 200, headers: { "content-type": "text/html" } });
      if (url === pageTwo) return new Response(`<main><a href="${detail}">Software Engineering Intern</a></main>`, { status: 200, headers: { "content-type": "text/html" } });
      throw new Error(`detail should be skipped: ${url}`);
    });

    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      respectRobotsTxt: false,
      retryCount: 0,
      perHostDelayMs: 0,
      cacheTtlMs: 0,
      maxDepth: 2,
      maxPagesPerSource: 4,
      httpConcurrency: 2,
    });
    const record = {
      availabilityStatus: "open",
      failureState: "none",
      lastCheckedAt: new Date().toISOString(),
      internship: makeInternship({ postingUrl: detail, sourceUrl: source }),
      contentHash: "content-hash",
    } as unknown as CrawlStateRecord;
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    const result = await crawler.crawl([source], new Map(), undefined, undefined, {
      classifyListing: (_source, hint) => {
        if (hint.canonicalUrl !== detail) return { disposition: "possibly_changed", record: null, validatorsMatch: false, reason: "new identity" } satisfies CrawlStateDecision;
        return { disposition: "unchanged", record, validatorsMatch: true, reason: "matching validator" } satisfies CrawlStateDecision;
      },
    });

    expect(requests).toEqual(expect.arrayContaining([source, pageTwo]));
    expect(requests).not.toContain(detail);
    expect(result.jobs).toHaveLength(1);
    expect(result.metrics?.unchangedSkips).toBe(1);
    expect(result.metrics?.duplicateListingsSkipped).toBeGreaterThanOrEqual(1);
  });
});
