import { load } from "cheerio";
import type { Logger } from "../../utils/logger.js";
import { canonicalizeUrl, safeCanonicalizeUrl } from "../../utils/url.js";
import type { HttpClient, HttpResponseSnapshot } from "../http.js";
import type { ClosedPage, FetchFailure, RawJob, SourceInventoryPart } from "../../domain/types.js";
import { CrawlCancelledError, CrawlDeadlineExceededError, SourceStalledError, currentSourceAbortSignal, throwIfAborted } from "../../domain/cancellation.js";
import { INTERN_LIST_SOURCE_URL, isInternListSource } from "../../config/internListSource.js";
import { internListInventorySnapshot, parseInternListDetail, parseInternListTab } from "../../extractors/internList.js";
import { isRetiredInternListSource, RETIRED_INTERN_LIST_MESSAGE, RETIRED_JOBRIGHT_LIST_URL } from "../../config/retiredSources.js";
import { adapterFailure, type AdapterCollectOptions, type SourceAdapter, type SourceAdapterResult } from "./types.js";

// Legacy snapshot identities remain available for saved payloads only.
export const INTERN_LIST_API_URL = RETIRED_JOBRIGHT_LIST_URL;
export const INTERN_LIST_MAX_RAW_LISTINGS = 94_000;
export const INTERN_LIST_CANADA_TAB_CATEGORY = "intern:ca:engineering_development";
export const INTERN_LIST_CANADA_TAB_URL = "https://jobright.ai/minisites-jobs/intern/ca/engineering_development?embed=true";

export type InternListCountry = "us" | "ca";

export interface InternListJobProperties {
  title?: unknown;
  company?: unknown;
  location?: unknown;
  salary?: unknown;
  workModel?: unknown;
  industry?: unknown;
  companySize?: unknown;
  qualifications?: unknown;
  expLevel?: unknown;
  jobFunction?: unknown;
  h1bSponsored?: unknown;
  isNewGrad?: unknown;
  roleType?: unknown;
  hireTime?: unknown;
  graduateTime?: unknown;
}

export interface InternListJobRecord {
  jobId?: unknown;
  tabCategory?: unknown;
  properties?: InternListJobProperties;
  postedAt?: unknown;
}

export interface InternListPage {
  total: number;
  jobList: InternListJobRecord[];
}

export interface InternListFeed {
  category: string;
  country: InternListCountry;
  label: string;
  embeddedUrl: string;
}

const CATEGORY_BY_QUERY: Record<string, string> = {
  swe: "intern:us:swe",
  aiml: "intern:us:ml_ai",
  ml: "intern:us:ml_ai",
  eng: "intern:us:engineering_development",
};

export function internListCategory(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.replace(/^www\./i, "") !== "intern-list.com" || url.pathname !== "/") return null;
    return CATEGORY_BY_QUERY[url.searchParams.get("k")?.trim().toLocaleLowerCase() ?? "swe"] ?? "intern:us:swe";
  } catch {
    return null;
  }
}

function selectedQueryKey(sourceUrl: string): string | null {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname.replace(/^www\./i, "") !== "intern-list.com" || url.pathname !== "/") return null;
    return url.searchParams.get("k")?.trim().toLocaleLowerCase() ?? "swe";
  } catch {
    return null;
  }
}

function embeddedFeedUrl(category: string): string {
  const [, country, path] = category.split(":");
  return `https://jobright.ai/minisites-jobs/intern/${country ?? "us"}/${path ?? "swe"}?embed=true`;
}

/** Archived category mapping. Live collection discovers every tab from HTML. */
export function internListFeeds(sourceUrl: string): InternListFeed[] {
  const category = internListCategory(sourceUrl);
  const key = selectedQueryKey(sourceUrl);
  if (!category || !key) return [];
  const feeds: InternListFeed[] = [{
    category,
    country: "us",
    label: "United States selected category",
    embeddedUrl: embeddedFeedUrl(category),
  }];
  feeds.push({
    category: INTERN_LIST_CANADA_TAB_CATEGORY,
    country: "ca",
    label: "Canada tab",
    embeddedUrl: INTERN_LIST_CANADA_TAB_URL,
  });
  return feeds;
}

export function internListEndpoint(position: number, count: number): string {
  const url = new URL(INTERN_LIST_API_URL);
  url.searchParams.set("position", String(position));
  url.searchParams.set("count", String(count));
  return canonicalizeUrl(url.toString());
}

export function parseInternListResponse(value: unknown): InternListPage | null {
  if (!value || typeof value !== "object") return null;
  const response = value as { success?: unknown; result?: unknown };
  if (response.success !== true || !response.result || typeof response.result !== "object") return null;
  const result = response.result as { total?: unknown; jobList?: unknown };
  if (!Number.isInteger(result.total) || Number(result.total) < 0 || !Array.isArray(result.jobList)) return null;
  const jobList = result.jobList.filter((job): job is InternListJobRecord => Boolean(job && typeof job === "object"));
  return { total: Number(result.total), jobList };
}

const DETAIL_PATH = /^\/(swe-intern-list|da-intern-list|mkt-intern-list|accounting-and-finance-intern-list|pm-intern-list|data-science-internships)\/[^/]+\/?$/u;
const LISTING_PATHS = ["swe-intern-list", "da-intern-list", "mkt-intern-list", "accounting-and-finance-intern-list", "pm-intern-list"];

function siteUrl(value: string, base = INTERN_LIST_SOURCE_URL): string | null {
  const url = safeCanonicalizeUrl(value, base);
  if (!url) return null;
  const parsed = new URL(url);
  return parsed.protocol === "https:" && parsed.hostname.replace(/^www\./u, "") === "intern-list.com"
    ? `${new URL(INTERN_LIST_SOURCE_URL).origin}${parsed.pathname}${parsed.search}` : null;
}

export function discoverInternListTabs(html: string): InternListFeed[] {
  const $ = load(html);
  const tabs = new Map<string, InternListFeed>();
  $("[data-job-path]").each((_index, element) => {
    const match = /^\/(us|ca)\/([a-z_]+)\/?$/u.exec($(element).attr("data-job-path") ?? "");
    if (!match) return;
    const country = match[1] as InternListCountry;
    const category = `intern:${country}:${match[2]}`;
    tabs.set(category, { country, category, label: $(element).text().replace(/\s+/gu, " ").trim() || category, embeddedUrl: embeddedFeedUrl(category) });
  });
  return [...tabs.values()];
}

export function parseInternListSitemap(xml: string, base: string): { valid: boolean; details: string[]; sitemaps: string[] } {
  const $ = load(xml, { xmlMode: true });
  const urls = $("urlset > url > loc").toArray().map((element) => siteUrl($(element).text(), base)).filter((url): url is string => Boolean(url));
  const sitemaps = $("sitemapindex > sitemap > loc").toArray().map((element) => siteUrl($(element).text(), base)).filter((url): url is string => Boolean(url));
  return { valid: $("urlset, sitemapindex").length === 1, details: [...new Set(urls.filter((url) => DETAIL_PATH.test(new URL(url).pathname)))], sitemaps };
}

export function parseInternListListing(html: string, url: string): { valid: boolean; details: string[]; next: string | null } {
  const $ = load(html);
  const details = [...new Set($(".w-dyn-item a[href]").toArray()
    .map((element) => siteUrl($(element).attr("href") ?? "", url))
    .filter((href): href is string => Boolean(href && DETAIL_PATH.test(new URL(href).pathname))))];
  const href = $("a.w-pagination-next:not(.w-condition-invisible):not([hidden])").first().attr("href");
  const next = href ? siteUrl(href, url) : null;
  const sameCollection = Boolean(next && new URL(next).pathname === new URL(url).pathname);
  return { valid: $(".w-dyn-list").length > 0 && (details.length > 0 || $(".w-dyn-empty").length > 0) && (!href || sameCollection), details,
    next: sameCollection ? next : null };
}

export interface InternListCollectLimits {
  maxDetailPages?: number;
  maxListingPages?: number;
  concurrency?: number;
}

/** HTTP-only collection of first-party CMS pages and public SSR tab records. */
export class InternListAdapter implements SourceAdapter {
  public readonly name = "Intern List";
  public readonly strategy = "structured_endpoint" as const;

  public constructor(private readonly http: HttpClient, private readonly logger: Logger, private readonly limits: InternListCollectLimits = {}) {}

  public canHandle(sourceUrl: string): boolean {
    return isInternListSource(sourceUrl) || isRetiredInternListSource(sourceUrl);
  }

  public async collect(sourceUrl: string, options: AdapterCollectOptions = {}): Promise<SourceAdapterResult> {
    if (isRetiredInternListSource(sourceUrl)) return {
      snapshots: [], retrievalMethod: "Intern List retired endpoint", retrievalUrls: [], attempts: 0, httpStatus: null,
      notes: [RETIRED_INTERN_LIST_MESSAGE], failures: [{ ...adapterFailure(sourceUrl, sourceUrl, new Error(RETIRED_INTERN_LIST_MESSAGE)), errorType: "source_retired" }],
      strategy: this.strategy, inventoryComplete: false, browserRequired: false,
    };
    const parts: SourceInventoryPart[] = [];
    const failures: FetchFailure[] = [];
    const retrievalUrls = new Set<string>();
    const jobs = new Map<string, RawJob>();
    const details = new Set<string>();
    const closedPages: ClosedPage[] = [];
    const incompleteJobs: RawJob[] = [];
    const closedIds = new Set<string>();
    const tabIds = new Map<string, Set<string>>();
    const detailIds = new Set<string>();
    let pages = 0;
    let attempts = 0;
    const parseFailure = (url: string, message: string): void => {
      failures.push({ ...adapterFailure(sourceUrl, url, new Error(message), 200), errorType: "parse_error" });
    };
    const get = async (url: string): Promise<HttpResponseSnapshot | null> => {
      throwIfAborted(currentSourceAbortSignal());
      retrievalUrls.add(url);
      try {
        const response = await this.http.get(url, { cache: true, timeoutMs: 30_000, retryCount: 1,
          allowedRedirectOrigins: ["https://www.intern-list.com", "https://intern-list.com", "https://jobright.ai"] });
        attempts += response.attempts;
        pages += 1;
        if (response.stale) failures.push({ ...adapterFailure(sourceUrl, url, new Error("Using an expired HTTP cache after a transport failure."), response.status), errorType: "stale_cache" });
        await options.onProgress?.(pages);
        return response;
      } catch (error) {
        throwIfAborted(currentSourceAbortSignal());
        if (error instanceof CrawlCancelledError || error instanceof CrawlDeadlineExceededError || error instanceof SourceStalledError) throw error;
        const failure = adapterFailure(sourceUrl, url, error, (error as { statusCode?: number }).statusCode ?? null);
        attempts += Math.max(1, failure.retryCount);
        failures.push(failure);
        await options.onProgress?.(pages);
        return null;
      }
    };
    const map = async <T>(values: T[], action: (value: T) => Promise<void>): Promise<void> => {
      let cursor = 0;
      await Promise.all(Array.from({ length: Math.min(values.length, Math.max(1, this.limits.concurrency ?? 6)) }, async () => {
        while (cursor < values.length) { const value = values[cursor++]; if (value !== undefined) await action(value); }
      }));
    };
    const addJob = (job: RawJob): void => {
      const key = job.jobId || job.postingUrl;
      const prior = jobs.get(key);
      if (!prior || job.sourceProvider === "intern-list-html") jobs.set(key, job);
    };
    const root = await get(INTERN_LIST_SOURCE_URL);
    const tabs = root ? discoverInternListTabs(root.body) : [];
    parts.push({ id: "tab_discovery", kind: "listing_pages", url: INTERN_LIST_SOURCE_URL, inventoryCount: null,
      retrievedCount: tabs.length, complete: Boolean(root && tabs.some((tab) => tab.country === "us") && tabs.some((tab) => tab.country === "ca")), notes: [`Discovered ${tabs.length} country/category tabs from data-job-path attributes.`] });
    if (root && tabs.length === 0) parseFailure(INTERN_LIST_SOURCE_URL, "No country/category tabs were found in the public root page.");
    await map(tabs, async (tab) => {
      const response = await get(tab.embeddedUrl);
      const parsed = response ? parseInternListTab(response.body, tab.category) : null;
      const ids = new Set(parsed?.jobs.map((job) => job.jobId!) ?? []);
      tabIds.set(tab.category, ids);
      for (const job of parsed?.jobs ?? []) addJob(job);
      const complete = Boolean(parsed && ids.size === parsed.total && parsed.jobs.length === parsed.rowCount);
      parts.push({ id: tab.category, kind: "tab", url: tab.embeddedUrl, country: tab.country, category: tab.category,
        inventoryCount: parsed?.total ?? null, retrievedCount: ids.size, complete,
        notes: parsed ? [complete ? "The SSR page exposed the entire advertised tab inventory." : "Only the server-rendered first page is available; Load More depends on the retired endpoint."] : ["The public tab payload could not be retrieved or validated."] });
      if (response && !parsed) parseFailure(tab.embeddedUrl, `Invalid SSR tab payload for ${tab.category}.`);
    });
    const sitemapQueue = [`${INTERN_LIST_SOURCE_URL}sitemap.xml`];
    const seenSitemaps = new Set<string>();
    let sitemapComplete = true;
    while (sitemapQueue.length > 0 && seenSitemaps.size < 16) {
      const url = sitemapQueue.shift()!;
      if (seenSitemaps.has(url)) continue;
      seenSitemaps.add(url);
      const response = await get(url);
      const parsed = response ? parseInternListSitemap(response.body, url) : null;
      if (!parsed?.valid) { sitemapComplete = false; if (response) parseFailure(url, "Invalid Intern List sitemap XML."); continue; }
      for (const detail of parsed.details) details.add(detail);
      for (const child of parsed.sitemaps) if (!seenSitemaps.has(child)) sitemapQueue.push(child);
    }
    if (sitemapQueue.length > 0) sitemapComplete = false;
    parts.push({ id: "sitemap", kind: "sitemap", url: `${INTERN_LIST_SOURCE_URL}sitemap.xml`, inventoryCount: details.size,
      retrievedCount: details.size, complete: sitemapComplete, notes: [`Parsed ${seenSitemaps.size} sitemap document(s); non-job and external URLs were excluded.`] });
    await map(LISTING_PATHS, async (path) => {
      const first = `${INTERN_LIST_SOURCE_URL}${path}`;
      let url: string | null = first;
      const seen = new Set<string>();
      const found = new Set<string>();
      let complete = true;
      while (url && seen.size < (this.limits.maxListingPages ?? 100)) {
        if (seen.has(url)) { complete = false; break; }
        seen.add(url);
        const response = await get(url);
        const parsed: ReturnType<typeof parseInternListListing> | null = response ? parseInternListListing(response.body, url) : null;
        if (!parsed?.valid) { complete = false; if (response) parseFailure(url, "Public listing page did not contain a valid CMS inventory."); break; }
        const before = found.size;
        for (const detail of parsed.details) { details.add(detail); found.add(detail); }
        if (parsed.next && found.size === before) { complete = false; break; }
        url = parsed.next;
      }
      if (url) complete = false;
      parts.push({ id: path, kind: "listing_pages", url: first, inventoryCount: found.size, retrievedCount: found.size, complete,
        notes: [`Followed ${seen.size} public listing page(s) using the site's pagination links.${complete ? "" : " Pagination was interrupted, repeated, or exceeded its safety bound."}`] });
    });
    const maxDetails = Math.max(0, this.limits.maxDetailPages ?? 10_000);
    const selectedDetails = [...details].sort().slice(0, maxDetails);
    let parsedDetails = 0;
    this.logger.info("INTERNLIST", `Discovered ${tabs.length} tabs and ${details.size} CMS detail pages; fetching ${selectedDetails.length} details through HTTP.`);
    await map(selectedDetails, async (url) => {
      const response = await get(url);
      if (!response) return;
      const parsed = parseInternListDetail(response.body, url);
      if (!parsed.job && !parsed.incompleteJob && !parsed.closed) { parseFailure(url, "CMS detail page did not expose a valid public record or an explicit closed banner."); return; }
      parsedDetails += 1;
      if (parsed.job?.jobId) detailIds.add(parsed.job.jobId);
      if (parsed.closed) {
        closedPages.push({ url, reason: "Intern List explicitly displays 'This job has closed'.", statusCode: response.status });
        if (parsed.job?.jobId) closedIds.add(parsed.job.jobId);
      } else if (parsed.job) addJob(parsed.job);
      else if (parsed.incompleteJob) incompleteJobs.push(parsed.incompleteJob);
      if (parsedDetails % 100 === 0) this.logger.info("INTERNLIST", `Parsed ${parsedDetails}/${selectedDetails.length} CMS details.`);
    });
    for (const id of closedIds) jobs.delete(id);
    parts.push({ id: "details", kind: "detail_pages", url: INTERN_LIST_SOURCE_URL, inventoryCount: details.size, retrievedCount: parsedDetails,
      complete: sitemapComplete && parsedDetails === details.size,
      notes: [`${closedPages.length} explicitly closed pages; ${Math.max(0, details.size - parsedDetails)} detail pages unavailable or outside the configured bound.`,
        `${incompleteJobs.length} data-science pages expose content but have placeholder titles and broken Apply links; saved separately without inventing missing fields.`] });
    for (const part of parts.filter((part) => part.kind === "tab")) {
      const matched = [...(tabIds.get(part.id) ?? [])].filter((id) => detailIds.has(id)).length;
      part.notes.push(`${matched} first-page job identities also had a full CMS detail page. Other CMS jobs are retained independently; they do not prove coverage of this tab's remaining feed.`);
    }
    parts.sort((a, b) => a.id.localeCompare(b.id));
    const inventoryComplete = parts.every((part) => part.complete) && failures.length === 0 && incompleteJobs.length === 0;
    const records = [...jobs.values()];
    return {
      snapshots: pages > 0 && (records.length > 0 || tabs.length > 0) ? [internListInventorySnapshot(INTERN_LIST_SOURCE_URL, records)] : [],
      retrievalMethod: "Intern List public HTML, sitemap and SSR tabs", retrievalUrls: [...retrievalUrls], attempts,
      httpStatus: root?.status ?? null, notes: parts.map((part) => `${part.id}: ${part.retrievedCount}/${part.inventoryCount ?? "unknown"}; ${part.complete ? "complete" : "incomplete"}. ${part.notes.join(" ")}`),
      failures, strategy: this.strategy, inventoryComplete, inventoryCount: records.length + closedIds.size + incompleteJobs.length,
      inventoryParts: parts, retrievedPages: pages, detailPagesFetched: selectedDetails.length, closedPages,
      maxRawListings: INTERN_LIST_MAX_RAW_LISTINGS, browserRequired: false,
      incompleteJobs,
    };
  }
}
