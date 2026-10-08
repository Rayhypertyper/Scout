import { afterEach, describe, expect, it, vi } from "vitest";

import { ZSHAH_DASHBOARD_URL, ZSHAH_JOBS_URL, ZSHAH_README_URL, ZSHAH_REPOSITORY_URL } from "../src/config/zshahSource.js";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { GitHubSourceAdapter } from "../src/crawler/githubAdapter.js";
import { HttpClient, HttpRequestError, type HttpResponseSnapshot } from "../src/crawler/http.js";
import { snapshotFromStructuredJson } from "../src/crawler/adapters/static.js";
import { extractJobs } from "../src/extractors/index.js";
import { extractZshahDashboardInventory } from "../src/extractors/zshah.js";
import { Logger } from "../src/utils/logger.js";

afterEach(() => vi.restoreAllMocks());

function response(url: string, body: string): HttpResponseSnapshot {
  return { requestedUrl: url, url, status: 200, attempts: 1, fromCache: false, contentType: "application/json", headers: {}, body };
}

function listing(overrides: Record<string, unknown> = {}) {
  return {
    id: "greenhouse:acme:123", company: "Acme", title: "Software Engineering Intern",
    season: "Summer 2027", season_inferred: false, location: "San Francisco, CA",
    url: "https://boards.greenhouse.io/acme/jobs/123", posted_at: "2026-10-06T15:54:27Z",
    skills: ["Python", "TypeScript"], salary: "$48 per hour", sponsorship: "unknown",
    ...overrides,
  };
}

function feed(jobs = [listing()], count = jobs.length) {
  return snapshotFromStructuredJson(response(ZSHAH_JOBS_URL, ""), { count, jobs });
}

describe("zshah published source", () => {
  it.each([ZSHAH_DASHBOARD_URL, ZSHAH_README_URL, ZSHAH_REPOSITORY_URL])("reads only the dashboard export for %s", async (sourceUrl) => {
    const get = vi.fn(async (url: string) => response(url, feed().text));
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    expect(adapter.canHandle(sourceUrl)).toBe(true);
    const result = await adapter.collect(sourceUrl);

    expect(get.mock.calls.map(([url]) => url)).toEqual([ZSHAH_JOBS_URL]);
    expect(result).toMatchObject({ inventoryComplete: true, retrievalUrls: [ZSHAH_JOBS_URL], failures: [] });
    expect(extractJobs(result.snapshots[0]!)).toHaveLength(1);
  });

  it("keeps each requisition and the source metadata without inferring a missing cycle", () => {
    const snapshot = feed([
      listing({ sponsorship: "citizens-only" }),
      listing({ id: "greenhouse:acme:124", url: "https://boards.greenhouse.io/acme/jobs/124", season: "Summer 2027", season_inferred: true }),
    ]);
    const inventory = extractZshahDashboardInventory(snapshot);
    expect(inventory.complete).toBe(true);
    expect(inventory.jobs.map(({ jobId }) => jobId)).toEqual(["greenhouse:acme:123", "greenhouse:acme:124"]);
    expect(new Set(inventory.jobs.map(({ applicationUrl }) => applicationUrl)).size).toBe(2);
    expect(inventory.jobs[0]).toMatchObject({ company: "Acme", salary: "$48 per hour", postingDate: "2026-10-06T15:54:27Z" });
    expect(inventory.jobs[0]?.description).toContain("List section: Summer 2027");
    expect(inventory.jobs[0]?.description).toContain("Requires U.S. citizenship");
    expect(inventory.jobs[1]?.description).not.toContain("Summer 2027");
  });

  it("validates the published count and rejects malformed rows as incomplete", () => {
    expect(extractZshahDashboardInventory(feed([], 0))).toEqual({ jobs: [], complete: true });
    expect(extractZshahDashboardInventory(feed([listing()], 2)).complete).toBe(false);
    expect(extractZshahDashboardInventory(feed([listing({ url: "" })])).complete).toBe(false);
    expect(extractZshahDashboardInventory(feed([listing({ title: "" })])).complete).toBe(false);
    expect(extractZshahDashboardInventory({ ...feed(), text: "not JSON" }).complete).toBe(false);
  });

  it("does not claim complete coverage for a stale cached export", async () => {
    const get = vi.fn(async (url: string) => ({ ...response(url, feed().text), stale: true }));
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    const result = await adapter.collect(ZSHAH_DASHBOARD_URL);
    expect(result.inventoryComplete).toBe(false);
    expect(result.notes.join(" ")).toContain("stale");
  });

  it("tries only the raw README when both the dashboard and GitHub API fail", async () => {
    const get = vi.fn(async (url: string): Promise<HttpResponseSnapshot> => {
      throw new HttpRequestError(`fetch failed for ${url}`, null, 0, "network_error");
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    const result = await adapter.collect(ZSHAH_DASHBOARD_URL);
    const apiBase = ZSHAH_REPOSITORY_URL.replace("https://github.com/", "https://api.github.com/repos/");
    const rawReadme = `${ZSHAH_REPOSITORY_URL.replace("https://github.com/", "https://raw.githubusercontent.com/")}/main/README.md`;
    expect(get.mock.calls.map(([url]) => url)).toEqual([ZSHAH_JOBS_URL, apiBase, rawReadme]);
    expect(result.snapshots).toEqual([]);
    expect(result.failures).toMatchObject([{ sourceUrl: ZSHAH_DASHBOARD_URL, url: rawReadme }]);
  });

  it.each(["unavailable", "truncated"])("falls back to just README.md when the dashboard is %s", async (failureMode) => {
    const markdown = "| Company | Role | Apply | Location |\n| --- | --- | --- | --- |\n| Acme | Software Engineering Intern - Summer 2027 | [Apply](https://boards.greenhouse.io/acme/jobs/123) | San Francisco, CA |";
    const apiBase = ZSHAH_REPOSITORY_URL.replace("https://github.com/", "https://api.github.com/repos/");
    const get = vi.fn(async (url: string) => {
      if (url === ZSHAH_JOBS_URL) {
        if (failureMode === "unavailable") throw new HttpRequestError("fetch failed", null, 0, "network_error");
        return response(url, feed([listing()], 2).text);
      }
      if (url === apiBase) return response(url, JSON.stringify({ default_branch: "main" }));
      if (url === `${apiBase}/contents/README.md?ref=main`) {
        return response(url, JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    const result = await adapter.collect(ZSHAH_REPOSITORY_URL);

    expect(get.mock.calls.map(([url]) => url)).toEqual([ZSHAH_JOBS_URL, apiBase, `${apiBase}/contents/README.md?ref=main`]);
    expect(result).toMatchObject({ inventoryComplete: false, failures: [] });
    expect(extractJobs(result.snapshots[0]!)).toHaveLength(1);

    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"));
    const internals = crawler as unknown as { github: GitHubSourceAdapter };
    vi.spyOn(internals.github, "collect").mockResolvedValue(result);
    const crawl = await crawler.crawl([ZSHAH_DASHBOARD_URL]);
    expect(crawl.sourceResults[0]).toMatchObject({ completed: true, coverageComplete: false });
    expect(crawl.completedSourceUrls).toEqual([]);
  });
});
