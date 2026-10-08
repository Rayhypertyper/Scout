import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { resolveSettings } from "../src/config/settings.js";
import { extractUsenoInternshipMasterlist, isUsenoInternshipMasterlistUrl } from "../src/extractors/useno.js";
import { matchUsenoKnownApplication, UsenoApplicationResolver } from "../src/crawler/usenoApplications.js";
import { HttpClient } from "../src/crawler/http.js";
import { Logger } from "../src/utils/logger.js";

const SOURCE = "https://www.useno.app/resources/internship-masterlist";
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function row(id: string, url = "", company = "Maple Systems") {
  return ["Software Engineering Intern", company, "Toronto, ON", "Hybrid", url, "2026-10-06", "Internship", "CA", "Ontario", "software", 1, 0, id];
}
function html(roles: unknown[], live = false) {
  return `<html><head><title>Internship Index</title></head><body><main><h1>Internship Index</h1><script id="ml-data" type="application/json">${JSON.stringify({ roles })}</script>${live ? "<script>fetch('/data/internship-index.json')</script>" : ""}</main></body></html>`;
}
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "useno-pagination-"));
  directories.push(directory);
  const settings = resolveSettings({ databasePath: join(directory, "test.db"), outputDirectory: directory, perHostDelayMs: 0, retryCount: 0 });
  return { directory, settings, logger: new Logger("error") };
}

describe("Useno current public index", () => {
  it("accepts the resources route and never turns a blank URL into a masterlist link", () => {
    expect(isUsenoInternshipMasterlistUrl(SOURCE)).toBe(true);
    const page = extractUsenoInternshipMasterlist(html([row("greenhouse:maple:1234"), row("")]), SOURCE);
    expect(page.listings).toHaveLength(1);
    expect(page.skippedIncompleteCount).toBe(1);
    expect(page.listings[0]?.applicationUrl).toBe("https://www.useno.app/internship/greenhouse%3Amaple%3A1234");
  });

  it("matches the employer and exact requisition while rejecting ID collisions", () => {
    const listing = extractUsenoInternshipMasterlist(html([row("greenhouse:maple:1234")]), SOURCE).listings[0]!;
    const url = "https://job-boards.greenhouse.io/maple/jobs/1234";
    expect(matchUsenoKnownApplication(listing, [{ company: "Maple Systems", applicationUrl: url }])).toBe(url);
    expect(matchUsenoKnownApplication(listing, [{ company: "Other Employer", applicationUrl: url }])).toBeNull();
    expect(matchUsenoKnownApplication(listing, [{ company: "Maple Systems", applicationUrl: url.replace("1234", "12345") }])).toBeNull();
    expect(matchUsenoKnownApplication(listing, [{ company: "Maple Systems", applicationUrl: "https://jobs.lever.co/maple/1234" }])).toBeNull();
  });

  it("recovers a URL supplied by the public employer API rather than generating one", async () => {
    const { settings, logger } = setup();
    const url = "https://job-boards.greenhouse.io/maple/jobs/1234";
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jobs: [{ id: 1234, absolute_url: url }] }), { headers: { "content-type": "application/json" } }));
    const resolver = new UsenoApplicationResolver(new HttpClient(settings, logger));
    const listing = extractUsenoInternshipMasterlist(html([row("greenhouse:maple:1234")]), SOURCE).listings[0]!;
    expect((await resolver.resolve(listing)).applicationUrl).toBe(url);
  });

  it("collects every public page and preserves capped coverage and unresolved links", async () => {
    const { directory, settings, logger } = setup();
    const feed = (page: number) => ({ roles: [row(`custom_careers:maple:hash-${page}`, "", `Maple Systems ${page}`)], page, pageCount: 2, pageSize: 1, total: 10, previewCapped: true });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/robots.txt")) return new Response("User-agent: *\nDisallow: /data/\n");
      if (url === SOURCE) return new Response(html([row("", "")], true), { headers: { "content-type": "text/html" } });
      if (url === "https://www.useno.app/data/internship-index.json") return new Response(JSON.stringify(feed(1)), { headers: { "content-type": "application/json" } });
      if (url === "https://www.useno.app/data/internship-index.json?page=2") return new Response(JSON.stringify(feed(2)), { headers: { "content-type": "application/json" } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const result = await new InternshipCrawler(settings, logger).crawl([SOURCE]);
    expect(result.sourceResults[0]).toMatchObject({ status: "success", completed: true, coverageComplete: false, directApplicationLinks: 0 });
    expect(result.jobs).toHaveLength(2);
    expect(result.jobs.every(({ internship }) => internship.availabilityStatus === "open")).toBe(true);
    expect(result.completedSourceUrls).toEqual([]);
    const artifact = JSON.parse(readFileSync(join(directory, "useno-internship-masterlist.json"), "utf8")) as { inventory: Record<string, unknown> };
    expect(artifact.inventory).toMatchObject({ rawRoleCount: 2, declaredTotal: 10, feedPages: 2, previewCapped: true, unresolvedApplicationLinks: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("does not publish an incomplete feed when a later page fails", async () => {
    const { settings, logger } = setup();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/robots.txt")) return new Response("");
      if (url === SOURCE) return new Response(html([row("custom_careers:maple:old")], true), { headers: { "content-type": "text/html" } });
      if (url.endsWith("?page=2")) return new Response("{}", { status: 401 });
      return new Response(JSON.stringify({ roles: [row("custom_careers:maple:first")], page: 1, pageSize: 1, pageCount: 2, total: 2 }), { headers: { "content-type": "application/json" } });
    });
    const result = await new InternshipCrawler(settings, logger).crawl([SOURCE]);
    expect(result.jobs).toEqual([]);
    expect(result.sourceResults[0]).toMatchObject({ coverageComplete: false, completed: false });
    expect(result.completedSourceUrls).toEqual([]);
  });
});
