import { describe, expect, it, vi } from "vitest";
import { INTERN_LIST_SOURCE_URL, internListSourceUrl, isInternListSource } from "../src/config/internListSource.js";
import { isRetiredInternListSource, RETIRED_JOBRIGHT_LIST_URL } from "../src/config/retiredSources.js";
import { discoverInternListTabs, InternListAdapter, parseInternListListing, parseInternListSitemap } from "../src/crawler/adapters/internList.js";
import { internListInventorySnapshot, parseInternListDetail, parseInternListTab } from "../src/extractors/internList.js";
import { extractJobs } from "../src/extractors/index.js";
import { Logger } from "../src/utils/logger.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { resolveSettings } from "../src/config/settings.js";
import type { BrowserManager } from "../src/crawler/browser.js";
import type { SourceStrategyPatch } from "../src/domain/types.js";

const root = '<button data-job-path="/us/swe">Software</button><button data-job-path="/ca/swe">Canada Software</button><button data-job-path="/us/swe">Duplicate</button>';
const detailA = `${INTERN_LIST_SOURCE_URL}swe-intern-list/alpha`;
const detailB = `${INTERN_LIST_SOURCE_URL}swe-intern-list/beta`;
const orphan = `${INTERN_LIST_SOURCE_URL}data-science-internships/gamma`;

function tab(category: string, ids: string[], total = ids.length): string {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: {
    initialActiveTab: category, initialTotal: total, initialJobs: ids.map((id) => ({ id, title: "Software Engineering Intern", company: "Acme", location: "Toronto, Canada", qualifications: "Python programming", postedDate: 1786803050000 })),
  } } })}</script>`;
}

function detail(id: string, closed = false): string {
  return `<html><head><script type="application/ld+json">${JSON.stringify({ "@type": "JobPosting", title: "Software Engineering Intern", identifier: { "@type": "PropertyValue", value: id }, hiringOrganization: { name: "Acme" }, datePosted: "2026-10-06", validThrough: "2026-10-06", jobLocation: { address: { addressLocality: "Toronto", addressCountry: "CA" } }, description: "<p>Full Python software internship description</p><p>Responsibilities</p><ul><li>Build software</li></ul><p>Skills</p><ul><li>Python</li></ul><p>Benefits</p><ul><li>Paid vacation</li></ul>" })}</script></head><body><div class="${closed ? "" : "w-condition-invisible"}">This job has closed.</div><h1>Software Engineering Intern</h1><a href="https://jobright.ai/jobs/info/${id}?utm_source=intern-list">Apply Now</a></body></html>`;
}

function listing(urls: string[], next?: string): string {
  return `<div class="w-dyn-list">${urls.length ? urls.map((url) => `<div class="w-dyn-item"><a href="${url}">Internship</a><a href="${url}">Logo</a></div>`).join("") : '<div class="w-dyn-empty">No items</div>'}</div>${next ? `<a class="w-pagination-next" href="${next}">Next</a>` : ""}`;
}

function fixture(overrides: Record<string, string | Error> = {}) {
  const bodies: Record<string, string | Error> = {
    [INTERN_LIST_SOURCE_URL]: root,
    [`${INTERN_LIST_SOURCE_URL}sitemap.xml`]: `<urlset><url><loc>${detailA}</loc></url><url><loc>${orphan}</loc></url></urlset>`,
    "https://jobright.ai/minisites-jobs/intern/us/swe?embed=true": tab("intern:us:swe", ["alpha"], 5702),
    "https://jobright.ai/minisites-jobs/intern/ca/swe?embed=true": tab("intern:ca:swe", ["beta"], 407),
    [`${INTERN_LIST_SOURCE_URL}swe-intern-list`]: listing([detailA], "?unknown_token_page=2"),
    [`${INTERN_LIST_SOURCE_URL}swe-intern-list?unknown_token_page=2`]: listing([detailB]),
    [detailA]: detail("alpha"), [detailB]: detail("beta", true), [orphan]: detail("gamma"),
    ...overrides,
  };
  const get = vi.fn(async (url: string) => {
    expect(isRetiredInternListSource(url)).toBe(false);
    const body = bodies[url] ?? listing([]);
    if (body instanceof Error) throw body;
    return { requestedUrl: url, url, status: 200, contentType: "text/html", body, headers: {}, attempts: 1, fromCache: false };
  });
  const postJson = vi.fn();
  return { get, postJson, adapter: new InternListAdapter({ get, postJson } as never, new Logger("error")) };
}

describe("Intern List public routes", () => {
  it("canonicalizes every root/category/embed alias while blocking only the dead API", () => {
    for (const url of [INTERN_LIST_SOURCE_URL, "https://intern-list.com/?k=aiml", "https://www.intern-list.com/?k=eng", "https://jobright.ai/minisites-jobs/intern/ca/swe?embed=true"]) {
      expect(isInternListSource(url)).toBe(true);
      expect(internListSourceUrl(url)).toBe(INTERN_LIST_SOURCE_URL);
      expect(isRetiredInternListSource(url)).toBe(false);
    }
    expect(isInternListSource("https://www.intern-list.com/job-search-guide")).toBe(false);
    expect(isRetiredInternListSource(`${RETIRED_JOBRIGHT_LIST_URL}?position=50`)).toBe(true);
  });

  it("discovers country/category pairs dynamically, including future categories", () => {
    const tabs = discoverInternListTabs(`${root}<button data-job-path="/ca/new_category">New</button><button data-job-path="https://evil.example/us/swe">Bad</button>`);
    expect(tabs.map((entry) => entry.category)).toEqual(["intern:us:swe", "intern:ca:swe", "intern:ca:new_category"]);
  });

  it("keeps sitemap-only detail pages, deduplicates URLs, and ignores external/non-job routes", () => {
    const result = parseInternListSitemap(`<urlset><url><loc>${orphan}</loc></url><url><loc>${orphan}</loc></url><url><loc>https://evil.example/swe-intern-list/job</loc></url><url><loc>${INTERN_LIST_SOURCE_URL}blog</loc></url></urlset>`, INTERN_LIST_SOURCE_URL);
    expect(result).toEqual({ valid: true, details: [orphan], sitemaps: [] });
    expect(parseInternListSitemap("<html>Challenge</html>", INTERN_LIST_SOURCE_URL).valid).toBe(false);
    expect(parseInternListSitemap(`<sitemapindex><sitemap><loc>${INTERN_LIST_SOURCE_URL}jobs.xml</loc></sitemap></sitemapindex>`, INTERN_LIST_SOURCE_URL).sitemaps).toEqual([`${INTERN_LIST_SOURCE_URL}jobs.xml`]);
  });

  it("uses the site's actual pagination token and rejects off-site next links", () => {
    expect(parseInternListListing(listing([detailA], "?token_page=2"), `${INTERN_LIST_SOURCE_URL}swe-intern-list`)).toMatchObject({ details: [detailA], next: `${INTERN_LIST_SOURCE_URL}swe-intern-list?token_page=2` });
    expect(parseInternListListing(listing([detailA], "https://evil.example/page2"), detailA)).toMatchObject({ next: null, valid: false });
    expect(parseInternListListing("<html>Sign in</html>", detailA).valid).toBe(false);
  });

  it("validates SSR category, counts, and records without executing any JavaScript", () => {
    expect(parseInternListTab(tab("intern:us:swe", ["alpha"], 5702), "intern:us:swe")).toMatchObject({ total: 5702, rowCount: 1, jobs: [expect.objectContaining({ jobId: "alpha", sourceProvider: "intern-list-public-tab", applicationUrl: "https://jobright.ai/jobs/info/alpha" })] });
    expect(parseInternListTab(tab("intern:ca:swe", ["alpha"]), "intern:us:swe")).toBeNull();
    expect(parseInternListTab(tab("intern:us:swe", ["alpha"], 0), "intern:us:swe")).toBeNull();
    expect(parseInternListTab("<html>Broken</html>", "intern:us:swe")).toBeNull();
  });

  it("ignores hidden closed banners and repeated validThrough dates, preserving full content and Apply links", () => {
    expect(parseInternListDetail(detail("alpha"), detailA)).toMatchObject({ closed: false, job: { jobId: "alpha", postingUrl: detailA, applicationUrl: "https://jobright.ai/jobs/info/alpha", sourceProvider: "intern-list-html", deadline: undefined } });
    expect(parseInternListDetail(detail("alpha"), detailA).job?.description).toContain("Paid vacation");
    expect(parseInternListDetail(detail("alpha"), detailA).job?.requiredQualifications).toEqual(["Python"]);
    expect(parseInternListDetail(detail("alpha"), detailA).job?.preferredQualifications).toEqual([]);
    expect(parseInternListDetail(detail("beta", true), detailB).closed).toBe(true);
    expect(parseInternListDetail(detail("alpha").replace('class="w-condition-invisible"', 'style="display: none"'), detailA).closed).toBe(false);
  });

  it("collects all tabs, paginated/orphan details and closures, enriching and deduplicating identities", async () => {
    const { adapter, get, postJson } = fixture();
    const onProgress = vi.fn().mockResolvedValue(undefined);
    const result = await adapter.collect("https://www.intern-list.com/?k=eng", { onProgress });
    const jobs = result.snapshots.flatMap(extractJobs);
    expect(jobs.map((job) => job.jobId).sort()).toEqual(["alpha", "gamma"]);
    expect(jobs.find((job) => job.jobId === "alpha")).toMatchObject({ sourceProvider: "intern-list-html", postingUrl: detailA });
    expect(result.closedPages).toEqual([expect.objectContaining({ url: detailB })]);
    expect(result).toMatchObject({ inventoryComplete: false, inventoryCount: 3, browserRequired: false, failures: [] });
    expect(result.inventoryParts?.find((part) => part.id === "intern:us:swe")).toMatchObject({ inventoryCount: 5702, retrievedCount: 1, complete: false });
    expect(result.inventoryParts?.find((part) => part.id === "details")).toMatchObject({ inventoryCount: 3, retrievedCount: 3, complete: true });
    expect(get).toHaveBeenCalledWith(`${INTERN_LIST_SOURCE_URL}swe-intern-list?unknown_token_page=2`, expect.anything());
    expect(postJson).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledTimes(get.mock.calls.length);
  });

  it("proves completeness only when every tab total and CMS inventory is exhausted", async () => {
    const { adapter } = fixture({
      "https://jobright.ai/minisites-jobs/intern/us/swe?embed=true": tab("intern:us:swe", ["alpha"]),
      "https://jobright.ai/minisites-jobs/intern/ca/swe?embed=true": tab("intern:ca:swe", ["beta"]),
    });
    expect((await adapter.collect(INTERN_LIST_SOURCE_URL)).inventoryComplete).toBe(true);
  });

  it("keeps other records when a detail fails and never reports complete coverage", async () => {
    const { adapter } = fixture({ [orphan]: new Error("HTTP 503") });
    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);
    expect(result.snapshots.flatMap(extractJobs)).toHaveLength(1);
    expect(result.inventoryParts?.find((part) => part.id === "details")).toMatchObject({ complete: false, retrievedCount: 2 });
    expect(result.failures).toHaveLength(1);
  });

  it("retains an expired cached detail while marking detail coverage incomplete", async () => {
    const { adapter, get } = fixture();
    const freshGet = get.getMockImplementation()!;
    get.mockImplementation(async (url: string) => url === detailA
      ? { requestedUrl: url, url, status: 200, contentType: "text/html", body: detail("alpha"), headers: {}, attempts: 2, fromCache: true, stale: true }
      : freshGet(url));

    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);

    expect(get).toHaveBeenCalledWith(detailA, expect.objectContaining({ staleIfError: true, retryCount: 1 }));
    expect(result.snapshots.flatMap(extractJobs).map((job) => job.jobId)).toContain("alpha");
    expect(result.failures).toContainEqual(expect.objectContaining({ url: detailA, errorType: "stale_cache" }));
    expect(result.inventoryParts?.find((part) => part.id === "details")).toMatchObject({ complete: false, retrievedCount: 3 });
    expect(result.inventoryComplete).toBe(false);
  });

  it("counts the initial request plus the exhausted retry as two attempts", async () => {
    const retryError = Object.assign(new Error("HTTP 503"), { attempts: 1 });
    const { adapter, get } = fixture({ [orphan]: retryError });

    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);

    expect(result.failures).toContainEqual(expect.objectContaining({ url: orphan, retryCount: 1 }));
    expect(result.attempts).toBe(get.mock.calls.length + 1);
  });

  it.each([
    [INTERN_LIST_SOURCE_URL, "tab_discovery"],
    ["https://jobright.ai/minisites-jobs/intern/us/swe?embed=true", "intern:us:swe"],
    [`${INTERN_LIST_SOURCE_URL}swe-intern-list`, "swe-intern-list"],
    [`${INTERN_LIST_SOURCE_URL}sitemap.xml`, "sitemap"],
  ])("retains stale data from %s without declaring its inventory part complete", async (url, partId) => {
    const { adapter, get } = fixture({
      "https://jobright.ai/minisites-jobs/intern/us/swe?embed=true": tab("intern:us:swe", ["alpha"], 1),
    });
    const freshGet = get.getMockImplementation()!;
    get.mockImplementation(async (requestedUrl: string) => ({
      ...await freshGet(requestedUrl), ...(requestedUrl === url ? { fromCache: true, stale: true } : {}),
    }));
    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);
    expect(result.inventoryParts?.find((part) => part.id === partId)?.complete).toBe(false);
    if (partId === "sitemap") expect(result.inventoryParts?.find((part) => part.id === "details")?.complete).toBe(false);
    expect(result.inventoryComplete).toBe(false);
    expect(result.snapshots.flatMap(extractJobs).map((job) => job.jobId)).toContain("alpha");
  });

  it("detects a repeated pagination window rather than silently treating it as exhaustion", async () => {
    const { adapter } = fixture({ [`${INTERN_LIST_SOURCE_URL}swe-intern-list?unknown_token_page=2`]: listing([detailA], "?unknown_token_page=3") });
    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);
    expect(result.inventoryParts?.find((part) => part.id === "swe-intern-list")?.complete).toBe(false);
  });

  it("preserves data-science content with missing title/application fields separately", async () => {
    const html = '<html><body><div class="text-block-66">Acme</div><div class="text-block-65">October 6, 2026</div><h1>Heading</h1><div class="text-block-47">Toronto, Canada</div><div class="rich-text-block-20">A full data science internship description.</div><a href="#">Apply Now</a><h2>Responsibilities</h2><div class="w-richtext"><ul><li>Build Python models</li></ul></div><h3>Required</h3><div class="w-richtext"><ul><li>Python</li></ul></div></body></html>';
    const { adapter } = fixture({ [orphan]: html });
    const result = await adapter.collect(INTERN_LIST_SOURCE_URL);
    expect(result.failures).toEqual([]);
    expect(result.incompleteJobs).toEqual([expect.objectContaining({ company: "Acme", postingUrl: orphan, responsibilities: ["Build Python models"], requiredQualifications: ["Python"] })]);
    expect(result.incompleteJobs?.[0]?.title).toBeUndefined();
    expect(result.incompleteJobs?.[0]?.applicationUrl).toBeUndefined();
    expect(result.snapshots.flatMap(extractJobs).map((job) => job.jobId)).toEqual(["alpha"]);
    expect(result.inventoryParts?.find((part) => part.id === "details")).toMatchObject({ complete: true, retrievedCount: 3 });
  });

  it("reports a configured detail bound without counting omitted pages as complete", async () => {
    const { get } = fixture();
    const result = await new InternListAdapter({ get } as never, new Logger("error"), { maxDetailPages: 1 }).collect(INTERN_LIST_SOURCE_URL);
    expect(result.inventoryParts?.find((part) => part.id === "details")).toMatchObject({ complete: false, inventoryCount: 3, retrievedCount: 1 });
    expect(result.inventoryComplete).toBe(false);
  });

  it("round-trips an empty compact inventory without inventing a generic job", () => {
    expect(extractJobs(internListInventorySnapshot(INTERN_LIST_SOURCE_URL, []))).toEqual([]);
  });

  it("preserves per-tab counts and closures through the central crawler without launching a browser", async () => {
    const collected = await fixture().adapter.collect(INTERN_LIST_SOURCE_URL);
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false, maxDepth: 0 }), new Logger("error"));
    (crawler as unknown as { adapterRouter: unknown }).adapterRouter = { collect: async () => collected };
    const browser = (crawler as unknown as { browser: BrowserManager }).browser;
    const fetchPage = vi.spyOn(browser, "fetchPage").mockRejectedValue(new Error("Browser must not run"));
    const recordSourceFetch = vi.fn<(source: string, patch: SourceStrategyPatch) => Promise<void>>().mockResolvedValue(undefined);
    const result = await crawler.crawl([INTERN_LIST_SOURCE_URL], new Map(), undefined, undefined, { getJobrightDestinations: () => new Map(), recordSourceFetch });
    expect(result.sourceResults[0]).toMatchObject({ status: "partial", completed: true, coverageComplete: false, inventoryCount: 3, inventoryStatus: "incomplete", trustedInventory: false, inventoryParts: collected.inventoryParts, closedPages: collected.closedPages });
    const patch = recordSourceFetch.mock.calls.at(-1)?.[1];
    expect(patch?.requiresJs).toBe(false);
    expect(patch?.metadata?.inventoryParts).toEqual(collected.inventoryParts);
    expect(patch?.metadata?.inventoryComplete).toBe(false);
    expect(fetchPage).not.toHaveBeenCalled();
  });
});
