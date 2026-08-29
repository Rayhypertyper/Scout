import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import {
  extractUsenoInternshipMasterlist,
  extractUsenoSummer2027,
  validateUsenoInternshipMasterlist,
  validateUsenoSummer2027,
} from "../src/extractors/useno.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const fixture = `<!doctype html>
<html><head><title>Summer 2027 Internships</title></head><body>
<main>
  <h1>Summer 2027 Internships</h1>
  <p>A running list of Summer 2027 internships.</p>
  <div id="live-count">2 internships currently tracked</div>
  <div>Last updated August 12, 2026</div>
  <select id="location-filter"><option value="all">All locations</option><option value="remote">Remote</option></select>
  <section class="jsec" id="software"><h2>Software Engineering &amp; Technology</h2><div class="jsec-count">2 internships</div>
    <div class="row" data-region="us" data-search="acme software intern toronto">
      <div class="row-main"><div class="row-company">Acme</div><div class="row-title">Software Engineering Intern</div>
      <div class="row-meta"><span>Toronto, Canada</span><span class="dot">·</span><span>Added Aug 12</span></div></div>
      <a class="row-apply" href="https://jobs.example.com/acme/1">Apply →</a>
    </div>
    <div class="row" data-region="remote" data-search="beta data intern remote">
      <div class="row-main"><div class="row-company">Beta</div><div class="row-title">Data Intern</div>
      <div class="row-meta"><span>USA | Remote</span><span class="dot">·</span><span>Added Aug 11</span></div></div>
      <a class="row-apply" href="/jobs/beta-2">Apply →</a>
    </div>
  </section>
</main></body></html>`;

describe("Useno Summer 2027 extractor", () => {
  it("extracts metadata and row-level application links without following them", () => {
    const page = extractUsenoSummer2027(fixture, "https://www.useno.app/summer-2027-internships", "2026-08-15T00:00:00.000Z");
    expect(page.trackedCount).toBe(2);
    expect(page.totalRecords).toBe(2);
    expect(page.lastUpdated).toBe("August 12, 2026");
    expect(page.parserVersion).toBe("useno-summer-2027-v1");
    expect(page.bodySha256).toHaveLength(64);
    expect(page.locationOptions).toEqual([
      { value: "all", label: "All locations" },
      { value: "remote", label: "Remote" },
    ]);
    expect(page.categories[0]?.internships).toEqual([
      expect.objectContaining({
        id: "software-1",
        categoryOrder: 1,
        rowOrder: 1,
        company: "Acme",
        title: "Software Engineering Intern",
        location: "Toronto, Canada",
        added: "Aug 12",
        addedLabel: "Added Aug 12",
        applicationUrl: "https://jobs.example.com/acme/1",
        region: "us",
      }),
      expect.objectContaining({
        id: "software-2",
        categoryOrder: 1,
        rowOrder: 2,
        company: "Beta",
        title: "Data Intern",
        applicationUrl: "https://www.useno.app/jobs/beta-2",
        region: "remote",
      }),
    ]);
    expect(() => validateUsenoSummer2027(page)).not.toThrow();
  });

  it("fails closed when the page count and row count diverge", () => {
    const page = extractUsenoSummer2027(fixture.replace("2 internships currently tracked", "3 internships currently tracked"));
    expect(() => validateUsenoSummer2027(page)).toThrow(/count mismatch/iu);
  });

  it("is collected automatically through the normal crawler path", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-useno-"));
    temporaryDirectories.push(directory);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://www.useno.app/robots.txt") return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      if (url === "https://www.useno.app/summer-2027-internships") return new Response(fixture, { status: 200, headers: { "content-type": "text/html", etag: '"fixture"' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      retryCount: 0,
      perHostDelayMs: 0,
    });
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    const result = await crawler.crawl(["https://www.useno.app/summer-2027-internships"]);
    const artifact = JSON.parse(readFileSync(join(directory, "useno-summer-2027-internships.json"), "utf8")) as { totalRecords: number };
    const requestedUrls = fetchMock.mock.calls.map(([input]) => typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    expect(result.sourceResults[0]).toMatchObject({ completed: true, status: "success", potentialPostingsInspected: 2 });
    expect(artifact.totalRecords).toBe(2);
    expect(requestedUrls).toEqual(expect.arrayContaining([
      "https://www.useno.app/robots.txt",
      "https://www.useno.app/summer-2027-internships",
    ]));
    expect(requestedUrls.some((url) => url.includes("jobs.example.com"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("Useno internship masterlist extractor", () => {
  const masterlistFixture = `<!doctype html>
  <html><head><title>Internship Masterlist</title></head><body><main><h1>Internship Masterlist</h1>
  <script id="ml-data" type="application/json">${JSON.stringify({
    roles: [
      ["Software Engineering Intern", "Maple Systems", "Toronto, ON", "Hybrid", "https://jobs.example.com/maple/1", "2026-08-19", "Internship", "CA", "Ontario", "software", 1, 0],
      ["Data Analyst Intern", "Acme Data", "Austin, Texas", "On-site", "https://jobs.example.com/acme/2", "2026-08-18", "Internship", "US", "Texas", "data", 0, 0],
      ["Data Intern", "Paris Data", "Paris, France", "On-site", "https://jobs.example.com/paris/3", "2026-08-17", "Internship", "FR", "Ile-de-France", "data", 0, 0],
      ["Software Engineer Intern", "Unknown Remote", "Remote", "Remote", "https://jobs.example.com/remote/4", "2026-08-16", "Internship", "", "", "software", 0, 0],
      ["Software Engineer", "New Grad Co", "New York, NY", "On-site", "https://jobs.example.com/new-grad/5", "2026-08-15", "New grad", "US", "New York", "software", 1, 1],
      ["Marketing Intern", "Other Team", "New York, NY", "On-site", "https://jobs.example.com/marketing/6", "2026-08-14", "Internship", "US", "New York", "marketing", 0, 0],
    ],
    sections: [
      { id: "software", title: "Software Engineering & Technology" },
      { id: "data", title: "Data, AI & Analytics" },
      { id: "marketing", title: "Marketing, Sales & Communications" },
    ],
  })}</script></main></body></html>`;

  it("reads both requested tabs, hides early-career rows, and keeps only Canada/U.S. locations", () => {
    const page = extractUsenoInternshipMasterlist(masterlistFixture, "https://www.useno.app/internship-masterlist", "2026-08-20T00:00:00.000Z");
    expect(page.defaultVisibleCount).toBe(4);
    expect(page.skippedLocationCount).toBe(2);
    expect(page.totalRecords).toBe(2);
    expect(page.selectedCategories).toEqual([
      { id: "software", name: "Software Engineering & Technology", defaultVisibleCount: 2, eligibleCount: 1 },
      { id: "data", name: "Data, AI & Analytics", defaultVisibleCount: 2, eligibleCount: 1 },
    ]);
    expect(page.listings).toEqual([
      expect.objectContaining({ title: "Software Engineering Intern", country: "CA", categoryId: "software", location: "Toronto, ON" }),
      expect.objectContaining({ title: "Data Analyst Intern", country: "US", categoryId: "data", location: "Austin, Texas" }),
    ]);
    expect(() => validateUsenoInternshipMasterlist(page)).not.toThrow();
  });

  it("feeds eligible masterlist rows through the normal crawler result without opening employer links", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-useno-masterlist-"));
    temporaryDirectories.push(directory);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://www.useno.app/robots.txt") return new Response("", { status: 200, headers: { "content-type": "text/plain" } });
      if (url === "https://www.useno.app/internship-masterlist") return new Response(masterlistFixture, { status: 200, headers: { "content-type": "text/html", etag: '"fixture"' } });
      throw new Error(`Unexpected request: ${url}`);
    });
    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      retryCount: 0,
      perHostDelayMs: 0,
    });
    const crawler = new InternshipCrawler(settings, new Logger("error"));
    const result = await crawler.crawl(["https://www.useno.app/internship-masterlist"]);
    const artifact = JSON.parse(readFileSync(join(directory, "useno-internship-masterlist.json"), "utf8")) as { totalRecords: number };
    const requestedUrls = fetchMock.mock.calls.map(([input]) => typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);

    expect(result.sourceResults[0]).toMatchObject({ completed: true, status: "success", potentialPostingsInspected: 2 });
    expect(result.sourceResults[0]?.jobs).toHaveLength(2);
    expect(artifact.totalRecords).toBe(2);
    expect(requestedUrls).toEqual(expect.arrayContaining([
      "https://www.useno.app/robots.txt",
      "https://www.useno.app/internship-masterlist",
    ]));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("accepts a trailing slash on the masterlist URL", () => {
    const page = extractUsenoInternshipMasterlist(masterlistFixture, "https://www.useno.app/internship-masterlist/", "2026-08-20T00:00:00.000Z");
    expect(() => validateUsenoInternshipMasterlist(page)).not.toThrow();
  });
});
