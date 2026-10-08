import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { HttpClient } from "../src/crawler/http.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { snapshotFromHttp, StaticHttpAdapter } from "../src/crawler/staticAdapters.js";
import { extractPublicBoardJobs } from "../src/extractors/publicBoards.js";
import { Logger } from "../src/utils/logger.js";

const source = "https://www.applybolt.app/jobs/2027-all-internships";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function adapter(): StaticHttpAdapter {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-applybolt-"));
  directories.push(directory);
  const settings = resolveSettings({ outputDirectory: directory, retryCount: 0, perHostDelayMs: 0 });
  return new StaticHttpAdapter(settings, new Logger("error"), new HttpClient(settings, new Logger("error")));
}

function listingHtml(page: number, pages = 32): string {
  return `<main><p>${pages * 20} recent listings</p><table>${Array.from({ length: 20 }, (_, index) => {
    const id = (page - 1) * 20 + index;
    return `<tr><td><a href='/job/software-intern-${id}'><span class='jb-company-name'>Acme</span></a></td><td><a href='/job/software-intern-${id}'><span class='jb-job-title'>Software Intern ${id}</span></a></td><td class='jb-location-text'>Toronto, ON</td></tr>`;
  }).join("")}</table><p>Page ${page} of ${pages}</p>${page < pages ? `<a href='?page=${page + 1}'>Next</a>` : ""}</main>`;
}

describe("ApplyBolt complete inventory and employer links", () => {
  it("discovers beyond 30 pages and 500 postings without fetching details", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      return new Response(listingHtml(Number(new URL(url).searchParams.get("page") ?? 1)), { headers: { "content-type": "text/html" } });
    });
    const progress = vi.fn();
    const result = await adapter().collectListing(source, progress);
    expect(result.listingSnapshots).toHaveLength(32);
    expect(result.detailCandidates).toHaveLength(640);
    expect(result.coverageComplete).toBe(true);
    expect(result.detailCandidates.find(({ url }) => url.endsWith("software-intern-639"))?.title).toContain("Software Intern 639");
    expect(progress).toHaveBeenLastCalledWith(32);
    expect(requests.every((url) => new URL(url).pathname === "/jobs/2027-all-internships")).toBe(true);
  });

  it("marks coverage incomplete when a pagination request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return page === 2 ? new Response("unavailable", { status: 503 })
        : new Response(listingHtml(page, 3), { headers: { "content-type": "text/html" } });
    });
    const result = await adapter().collectListing(source);
    expect(result.listingSnapshots).toHaveLength(2);
    expect(result.coverageComplete).toBe(false);
    expect(result.failures).toHaveLength(1);
    expect(result.notes.join(" ")).toContain("must not be treated as closed");
  });

  it("prefers the employer's current direct link over the ApplyBolt signup funnel", () => {
    const url = "https://www.applybolt.app/job/software-intern-123";
    const snapshot = snapshotFromHttp({ requestedUrl: url, url, status: 200, contentType: "text/html", headers: {}, attempts: 1, fromCache: false,
      body: `<main><h1 class='job-title'>Software Engineer Intern</h1><div class='job-company-name'>Acme</div><div class='job-company-location'>Toronto, Canada</div><div class='job-description'>Build and test production software in TypeScript and Python alongside our engineering team. Learn through mentoring and ship reliable services.</div><a href='/start'>Apply</a><a class='job-direct-applylink' href='https://jobs.ashbyhq.com/acme/abc-123/application'>Or apply on Acme's site yourself</a></main>`,
    });
    expect(extractPublicBoardJobs(snapshot)[0]?.applicationUrl).toBe("https://jobs.ashbyhq.com/acme/abc-123/application");
  });

  it("publishes the extracted employer link without requesting the employer site", async () => {
    vi.stubEnv("SCOUT_LLM_FALLBACK", "0");
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push(url);
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
      if (url === source) return new Response("<main><p>1 recent listings</p><a href='/job/software-intern-123'>Software Engineer Intern</a><p>Page 1 of 1</p></main>", { headers: { "content-type": "text/html" } });
      if (url === "https://www.applybolt.app/job/software-intern-123") return new Response("<main><h1 class='job-title'>Software Engineer Intern</h1><div class='job-company-name'>Acme</div><div class='job-company-location'>SF</div><div class='job-description'>Build and test production software in TypeScript and Python alongside our engineering team. Learn through mentoring and ship reliable services.</div><a class='job-direct-applylink' href='https://jobs.ashbyhq.com/acme/abc-123/application'>Apply on company site</a></main>", { headers: { "content-type": "text/html" } });
      throw new Error(`Unexpected employer request: ${url}`);
    });
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-applybolt-publish-"));
    directories.push(directory);
    const settings = resolveSettings({ outputDirectory: directory, retryCount: 0, perHostDelayMs: 0 });
    const published = vi.fn();
    const result = await new InternshipCrawler(settings, new Logger("error")).crawl([source], new Map(), undefined, undefined, { runId: 1, recordReadyJobs: published });
    expect(result.sourceResults[0]).toMatchObject({ status: "success", coverageComplete: true, directApplicationLinks: 1 });
    expect(result.jobs[0]?.internship.applicationUrl).toBe("https://jobs.ashbyhq.com/acme/abc-123/application");
    expect(result.jobs[0]?.internship.normalizedLocations[0]).toMatchObject({ city: "San Francisco", country: "United States" });
    expect(published).toHaveBeenCalled();
    expect(requests).toHaveLength(3);
    expect(requests.every((url) => new URL(url).hostname === "www.applybolt.app")).toBe(true);
  });

  it("keeps coverage partial when a successful detail response cannot be parsed", async () => {
    vi.stubEnv("SCOUT_LLM_FALLBACK", "0");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nAllow: /");
      const body = url === source
        ? "<main><p>2 recent listings</p><a href='/job/software-intern-123'>Software Engineer Intern</a><a href='/job/software-intern-456'>Software Engineer Intern</a><p>Page 1 of 1</p></main>"
        : url.endsWith("456") ? "<main>Loading</main>"
          : "<main><h1 class='job-title'>Software Engineer Intern</h1><div class='job-company-name'>Acme</div><div class='job-company-location'>Toronto, Canada</div><div class='job-description'>Build and test production software in TypeScript and Python alongside our engineering team. Learn through mentoring and ship reliable services.</div><a class='job-direct-applylink' href='https://jobs.ashbyhq.com/acme/abc-123/application'>Apply on company site</a></main>";
      return new Response(body, { headers: { "content-type": "text/html" } });
    });
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-applybolt-incomplete-"));
    directories.push(directory);
    const settings = resolveSettings({ outputDirectory: directory, retryCount: 0, perHostDelayMs: 0 });
    const result = await new InternshipCrawler(settings, new Logger("error")).crawl([source]);
    expect(result.jobs).toHaveLength(1);
    expect(result.sourceResults[0]).toMatchObject({ status: "partial", coverageComplete: false });
    expect(result.failures).toEqual([expect.objectContaining({ errorType: "parse_error", url: "https://www.applybolt.app/job/software-intern-456" })]);
    expect(result.completedSourceUrls).toEqual([]);
  });
});
