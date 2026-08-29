import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { GreenhouseAdapter, LeverAdapter } from "../src/crawler/adapters/ats.js";
import { StaticHTMLAdapter } from "../src/crawler/adapters/static.js";
import { StaticHttpAdapter } from "../src/crawler/staticAdapters.js";
import { HttpClient } from "../src/crawler/http.js";
import { extractJobs } from "../src/extractors/index.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function httpClient(): HttpClient {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-adapters-"));
  temporaryDirectories.push(directory);
  return new HttpClient(resolveSettings({ outputDirectory: directory, databasePath: join(directory, "test.db"), retryCount: 0, perHostDelayMs: 0 }), new Logger("error"));
}

describe("HTTP-first source adapters", () => {
  it("routes Greenhouse's public board API into the existing deterministic extractor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ jobs: [{
      id: 42,
      title: "Software Engineering Intern",
      content: "<p>Build reliable software with Python and TypeScript. Work with experienced engineers and ship tested services.</p><h3>Requirements</h3><p>Computer Science student.</p>",
      location: { name: "Toronto, Canada" },
      absolute_url: "https://boards.greenhouse.io/acme/jobs/42",
    }] }), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await new GreenhouseAdapter(httpClient(), new Logger("error")).collect("https://boards.greenhouse.io/acme/jobs");
    expect(result.strategy).toBe("structured_endpoint");
    expect(extractJobs(result.snapshots[0]!)[0]).toMatchObject({ company: "Acme", title: "Software Engineering Intern", jobId: "42" });
  });

  it("routes Lever's public postings API into the existing deterministic extractor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([{
      id: "abc-1",
      text: "Data Engineering Co-op",
      descriptionPlain: "Build data pipelines with Python and SQL. Collaborate with data engineers and improve production reliability.",
      hostedUrl: "https://jobs.lever.co/acme/abc-1",
      applyUrl: "https://jobs.lever.co/acme/abc-1/apply",
      categories: { location: "Remote Canada" },
    }]), { status: 200, headers: { "content-type": "application/json" } }));
    const result = await new LeverAdapter(httpClient(), new Logger("error")).collect("https://jobs.lever.co/acme");
    expect(extractJobs(result.snapshots[0]!)[0]).toMatchObject({ company: "Acme", title: "Data Engineering Co-op", jobId: "abc-1" });
  });

  it("defers static detail requests until the caller selects candidates", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://www.applybolt.app/jobs/2027-internships") {
        return new Response("<main><a href='/job/software-engineering-intern'>Software Engineering Intern</a></main>", { status: 200, headers: { "content-type": "text/html" } });
      }
      return new Response("<main><h1>Software Engineering Intern</h1><p>Build reliable software services with Python and TypeScript while learning from experienced engineers.</p></main>", { status: 200, headers: { "content-type": "text/html" } });
    });
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-static-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({ outputDirectory: directory, databasePath: join(directory, "test.db"), retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), new HttpClient(settings, new Logger("error")));
    const listing = await adapter.collectListing("https://www.applybolt.app/jobs/2027-internships");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listing.detailCandidates).toHaveLength(1);
    const details = await adapter.fetchDetails("https://www.applybolt.app/jobs/2027-internships", listing.detailCandidates);
    expect(details.snapshots).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("collects relevant CSJobs city discovery grids", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(`
      <main>
        <h2>Internships &amp; Co-ops</h2>
        <div class="live-grid">
          <a class="live-card" href="/jobs/101/software-engineering-intern">
            <div class="live-card-title"><span class="company-avatar">S</span>Software Engineering Intern</div>
            <div class="live-card-meta">Acme · Toronto, ON · 2026-08-15</div>
          </a>
        </div>
        <h2>New Grad &amp; Full-Time Roles in Toronto</h2>
        <div class="live-grid">
          <a class="live-card" href="/jobs/202/junior-software-engineer">
            <div class="live-card-title"><span class="company-avatar">J</span>Junior Software Engineer</div>
            <div class="live-card-meta">Acme · Toronto, ON · 2026-08-15</div>
          </a>
        </div>
      </main>
    `, { status: 200, headers: { "content-type": "text/html" } }));
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), httpClient());

    const listing = await adapter.collectListing("https://csjobs.ca/internships/toronto");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(listing.detailCandidates).toHaveLength(2);
    expect(listing.detailCandidates.map(({ url, title }) => ({ url, title }))).toEqual([
      {
        url: "https://csjobs.ca/jobs/101/software-engineering-intern",
        title: "Software Engineering Intern",
      },
      {
        url: "https://csjobs.ca/jobs/202/junior-software-engineer",
        title: "Junior Software Engineer",
      },
    ]);
  });

  it("uses CSJobs' public all-jobs route after a transient Toronto-page timeout", async () => {
    const source = "https://csjobs.ca/internships/toronto";
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === source) throw new Error("The operation was aborted due to timeout");
      return new Response("<main><a href='/jobs/101/software-engineering-intern'>Software Engineering Intern</a></main>", {
        status: 200,
        headers: { "content-type": "text/html" },
      });
    });
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), httpClient());

    const listing = await adapter.collectListing(source);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests).toEqual([source, "https://csjobs.ca/jobs"]);
    expect(listing.retrievalUrls).toEqual(["https://csjobs.ca/jobs"]);
    expect(listing.notes).toContain("CSJobs' configured Toronto route was temporarily unavailable; used the public all-jobs route instead.");
    expect(listing.detailCandidates[0]?.url).toBe("https://csjobs.ca/jobs/101/software-engineering-intern");
  });

  it("uses HiringCafe's public Canada listing after a homepage timeout", async () => {
    const source = "https://hiringcafe.com/";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === source) throw new Error("The operation was aborted due to timeout");
      if (url === "https://hiringcafe.com/jobs/canada") {
        return new Response("<main><a href='/job/software-engineering-intern-acme-toronto-abc123'>Software Engineering Intern</a></main>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.includes("sitemap")) {
        return new Response("<sitemapindex></sitemapindex>", { status: 200, headers: { "content-type": "application/xml" } });
      }
      return new Response("not found", { status: 404 });
    });
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), httpClient());

    const listing = await adapter.collectListing(source);

    expect(requests).toContain("https://hiringcafe.com/jobs/canada");
    expect(listing.retrievalUrls).toContain("https://hiringcafe.com/jobs/canada");
    expect(listing.notes.some((note) => note.includes("HiringCafe's public Canada search route"))).toBe(true);
    expect(listing.detailCandidates[0]?.url).toBe("https://hiringcafe.com/job/software-engineering-intern-acme-toronto-abc123");
  });

  it("still reads HiringCafe's public sitemap after listing pages time out", async () => {
    const source = "https://hiringcafe.com/";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (
        url === source
        || url === "https://hiringcafe.com/jobs/canada"
        || url === "https://hiringcafe.com/jobs/united-states"
      ) {
        throw new Error("The operation was aborted due to timeout");
      }
      if (url === "https://hiringcafe.com/job-posting-sitemap.xml") {
        return new Response(
          "<sitemapindex><sitemap><loc>https://hiringcafe.com/job-posting-sitemap/1/shard-0/chunk-1.xml</loc></sitemap></sitemapindex>",
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      if (url === "https://hiringcafe.com/job-posting-sitemap/1/shard-0/chunk-1.xml") {
        return new Response(
          "<urlset><url><loc>https://hiringcafe.com/job/software-engineering-intern-acme-toronto-abc123</loc></url></urlset>",
          { status: 200, headers: { "content-type": "application/xml" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), httpClient());

    const listing = await adapter.collectListing(source);

    expect(listing.detailCandidates[0]?.url).toBe("https://hiringcafe.com/job/software-engineering-intern-acme-toronto-abc123");
    expect(listing.notes.some((note) => note.includes("continuing from the public sitemap"))).toBe(true);
  });

  it("does not fetch a static detail URL denied by the per-target robots policy", async () => {
    const get = vi.fn();
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const policy = vi.fn(async (url: string) => ({ allowed: !url.includes("/job/"), crawlDelayMs: null }));
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), { get } as unknown as HttpClient, policy);
    const result = await adapter.fetchDetails("https://www.applybolt.app/jobs/2027-internships", [{
      url: "https://www.applybolt.app/job/blocked-intern",
      title: "Software Engineering Intern",
      snippet: "Software Engineering Intern",
      sourceUrl: "https://www.applybolt.app/jobs/2027-internships",
    }]);
    expect(get).not.toHaveBeenCalled();
    expect(policy).toHaveBeenCalledWith("https://www.applybolt.app/job/blocked-intern");
    expect(result.failures[0]).toMatchObject({ errorType: "robots_disallowed" });
  });

  it("stops before the static root when robots denies the configured source", async () => {
    const get = vi.fn();
    const settings = resolveSettings({ retryCount: 0, perHostDelayMs: 0 });
    const adapter = new StaticHttpAdapter(settings, new Logger("error"), { get } as unknown as HttpClient, async () => ({ allowed: false, crawlDelayMs: null }));
    await expect(adapter.collectListing("https://www.applybolt.app/jobs/2027-internships")).rejects.toMatchObject({ errorType: "robots_disallowed" });
    expect(get).not.toHaveBeenCalled();
  });

  it("marks an empty JavaScript shell as browser-required instead of pretending static extraction succeeded", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("<html><body><div id='root'></div><script>window.__next_f=[]</script></body></html>", { status: 200, headers: { "content-type": "text/html" } }));
    const result = await new StaticHTMLAdapter(httpClient(), new Logger("error")).collect("https://dynamic.example/jobs");
    expect(result.browserRequired).toBe(true);
    expect(result.strategy).toBe("browser_required");
  });
});
