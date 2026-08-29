import type { Logger } from "../../utils/logger.js";
import { canonicalizeUrl } from "../../utils/url.js";
import type { PageSnapshot } from "../../domain/types.js";
import type { HttpClient, HttpResponseSnapshot } from "../http.js";
import { snapshotFromStructuredJson } from "./static.js";
import { adapterFailure, type SourceAdapter, type SourceAdapterResult } from "./types.js";
import { currentSourceAbortSignal } from "../../domain/cancellation.js";

export const INTERN_LIST_API_URL = "https://swan-api.jobright.ai/swan/mini-sites/list";
export const INTERN_LIST_PAGE_SIZE = 50;
export const INTERN_LIST_FALLBACK_PAGE_SIZE = 1_000;
// Exact-total requests stay below the old oversized-request timeout pattern while
// covering the largest currently configured Intern List category in one
// consistent response. The engineering feed already exceeds 5,000 rows; 15,000
// still returns in a few seconds and avoids mixing offset windows from a live
// list. Offset pages remain the recovery path if this fails.
export const INTERN_LIST_MAX_BULK_COUNT = 15_000;
export const INTERN_LIST_MAX_OFFSET_PAGES = 64;
export const INTERN_LIST_BULK_TIMEOUT_MS = 30_000;
export const INTERN_LIST_PAGE_TIMEOUT_MS = 15_000;
export const INTERN_LIST_RETRY_COUNT = 1;
// The adapter never retains more than one exact-total bulk response plus the
// bounded offset walk below. Expose that finite bound to the central crawler
// so a legitimate feed larger than the generic 5,000-row guard is not
// incorrectly reported as a source failure.
export const INTERN_LIST_MAX_RAW_LISTINGS = INTERN_LIST_MAX_BULK_COUNT
  + INTERN_LIST_MAX_OFFSET_PAGES * INTERN_LIST_FALLBACK_PAGE_SIZE;
export const INTERN_LIST_CANADA_TAB_CATEGORY = "intern:ca:engineering_development";
export const INTERN_LIST_CANADA_TAB_URL = "https://jobright.ai/minisites-jobs/intern/ca/engineering_development?embed=true";
export const INTERN_LIST_CANADA_SWE_CATEGORY = "intern:ca:swe";
export const INTERN_LIST_CANADA_SWE_URL = "https://jobright.ai/minisites-jobs/intern/ca/swe?embed=true";
export const INTERN_LIST_CANADA_AIML_CATEGORY = "intern:ca:ml_ai";
export const INTERN_LIST_CANADA_AIML_URL = "https://jobright.ai/minisites-jobs/intern/ca/ml_ai?embed=true";
export const INTERN_LIST_CANADA_ENG_CATEGORY = "intern:ca:engineering_development";
export const INTERN_LIST_CANADA_ENG_URL = "https://jobright.ai/minisites-jobs/intern/ca/engineering_development?embed=true";

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

/**
 * The visible Canada tab is a shared Canada engineering/development feed. It
 * does not change the parent page URL or preserve the selected US category;
 * the iframe switches to the fixed route below. Keep that behavior explicit
 * so the scheduled crawler mirrors the UI rather than guessing a URL query.
 */
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
  if (key === "swe" || key === "aiml") {
    feeds.push({
      category: INTERN_LIST_CANADA_TAB_CATEGORY,
      country: "ca",
      label: "Canada tab",
      embeddedUrl: INTERN_LIST_CANADA_TAB_URL,
    });
  }
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

function statusCodeOf(error: unknown): number | null {
  return error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
}

function internListJobId(job: InternListJobRecord): string {
  if (typeof job.jobId === "string") return job.jobId.trim();
  if (typeof job.jobId === "number" && Number.isFinite(job.jobId)) return String(job.jobId);
  return "";
}

function uniqueJobIdSet(jobs: InternListJobRecord[]): Set<string> {
  return new Set(jobs.map(internListJobId).filter(Boolean));
}

interface PageAttempt {
  endpoint: string;
  response: HttpResponseSnapshot | null;
  page: InternListPage | null;
  failure: ReturnType<typeof adapterFailure> | null;
}

interface FeedCollection {
  snapshots: PageSnapshot[];
  retrievalUrls: string[];
  attempts: number;
  httpStatus: number | null;
  notes: string[];
  failures: SourceAdapterResult["failures"];
}

interface CachedFeedCollection {
  promise: Promise<FeedCollection>;
  ownerSignal?: AbortSignal;
}

function feedSnapshotUrl(endpoint: string, category: string): string {
  const url = new URL(endpoint);
  // The POST body carries category, so add a non-network identity parameter
  // to keep simultaneous US and Canada snapshots distinct in the crawler's
  // URL-indexed work queue.
  url.searchParams.set("feedCategory", category);
  return canonicalizeUrl(url.toString());
}

export class InternListAdapter implements SourceAdapter {
  public readonly name = "Intern List";
  public readonly strategy = "structured_endpoint" as const;
  private readonly feedCollections = new Map<string, CachedFeedCollection>();

  public constructor(private readonly http: HttpClient, private readonly logger: Logger) {}

  public canHandle(sourceUrl: string): boolean {
    return internListCategory(sourceUrl) !== null;
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const feeds = internListFeeds(sourceUrl);
    if (feeds.length === 0) {
      return {
        snapshots: [],
        retrievalMethod: "Intern List structured API",
        retrievalUrls: [sourceUrl],
        attempts: 0,
        httpStatus: null,
        notes: ["Not an Intern List root/category URL."],
        failures: [],
        strategy: "structured_endpoint",
      };
    }

    const collections: FeedCollection[] = [];
    for (const feed of feeds) collections.push(await this.collectFeedOnce(sourceUrl, feed));
    const retrievalUrls = collections.flatMap(({ retrievalUrls: urls }) => urls);
    const notes = collections.flatMap(({ notes: feedNotes }) => feedNotes);
    const failures = collections.flatMap(({ failures: feedFailures }) => feedFailures);
    return {
      snapshots: collections.flatMap(({ snapshots }) => snapshots),
      retrievalMethod: feeds.length > 1
        ? "Intern List / Jobright structured API (selected US feed + Canada tab feed)"
        : "Intern List / Jobright structured API (bulk snapshot)",
      retrievalUrls,
      attempts: collections.reduce((total, collection) => total + collection.attempts, 0),
      httpStatus: collections.map(({ httpStatus: status }) => status).find((status): status is number => status !== null) ?? null,
      notes,
      failures,
      strategy: "structured_endpoint",
      maxRawListings: feeds.length * INTERN_LIST_MAX_RAW_LISTINGS,
    };
  }

  /** Share a feed request when the configured root and category URLs overlap. */
  private collectFeedOnce(sourceUrl: string, feed: InternListFeed): Promise<FeedCollection> {
    const existing = this.feedCollections.get(feed.category);
    const ownerSignal = currentSourceAbortSignal();
    if (existing && !existing.ownerSignal?.aborted) {
      // A source-level timeout aborts the signal captured by the shared
      // request. A sibling may still be waiting on that same feed, so let it
      // discard the aborted collection and issue a fresh request under its own
      // signal instead of inheriting the timed-out source's failure.
      if (!existing.ownerSignal || existing.ownerSignal === ownerSignal) return existing.promise;
      return existing.promise.then(
        (collection) => {
          if (!existing.ownerSignal?.aborted) return collection;
          if (this.feedCollections.get(feed.category) === existing) this.feedCollections.delete(feed.category);
          return this.collectFeedOnce(sourceUrl, feed);
        },
        (error) => {
          if (!existing.ownerSignal?.aborted) throw error;
          if (this.feedCollections.get(feed.category) === existing) this.feedCollections.delete(feed.category);
          return this.collectFeedOnce(sourceUrl, feed);
        },
      );
    }
    if (existing && this.feedCollections.get(feed.category) === existing) this.feedCollections.delete(feed.category);
    const collection = this.collectFeed(sourceUrl, feed);
    const cached: CachedFeedCollection = { promise: collection, ...(ownerSignal ? { ownerSignal } : {}) };
    this.feedCollections.set(feed.category, cached);
    void collection.then(() => {
      if (cached.ownerSignal?.aborted && this.feedCollections.get(feed.category) === cached) this.feedCollections.delete(feed.category);
    }, () => {
      if (this.feedCollections.get(feed.category) === cached) this.feedCollections.delete(feed.category);
    });
    return collection;
  }

  private async collectFeed(sourceUrl: string, feed: InternListFeed): Promise<FeedCollection> {
    const { category } = feed;
    const retrievalUrls: string[] = [];
    const notes: string[] = [`${feed.label}: Jobright category: ${category}`];
    const failures: SourceAdapterResult["failures"] = [];
    let attempts = 0;
    const probe = await this.fetchPage(sourceUrl, category, 0, INTERN_LIST_PAGE_SIZE, {
      timeoutMs: INTERN_LIST_PAGE_TIMEOUT_MS,
      retryCount: INTERN_LIST_RETRY_COUNT,
    });
    retrievalUrls.push(probe.endpoint);
    attempts += probe.response?.attempts ?? 0;
    let httpStatus: number | null = probe.response?.status ?? probe.failure?.statusCode ?? null;
    if (!probe.page || !probe.response) {
      notes.push("The initial structured page could not be retrieved.");
      return {
        snapshots: [],
        retrievalUrls,
        attempts,
        httpStatus,
        notes,
        failures: probe.failure ? [probe.failure] : failures,
      };
    }

   let first = probe;
   let total = probe.page.total;
   if (probe.page.jobList.length < total) {
     if (total <= INTERN_LIST_MAX_BULK_COUNT) {
        let requestedTotal = total;
        let exactBulkComplete = false;
        for (let bulkAttempt = 0; bulkAttempt < 2; bulkAttempt += 1) {
          const bulk = await this.fetchPage(sourceUrl, category, 0, requestedTotal, {
            timeoutMs: INTERN_LIST_BULK_TIMEOUT_MS,
            retryCount: INTERN_LIST_RETRY_COUNT,
          });
          retrievalUrls.push(bulk.endpoint);
          attempts += bulk.response?.attempts ?? 0;
          httpStatus = bulk.response?.status ?? httpStatus ?? bulk.failure?.statusCode ?? null;
          if (!bulk.page || !bulk.response || (bulk.page.jobList.length === 0 && bulk.page.total !== 0)) break;
          if (bulk.page.total !== requestedTotal) notes.push(`Feed total changed from ${requestedTotal} to ${bulk.page.total} during retrieval.`);
          total = bulk.page.total;
          first = bulk;
         if (bulk.page.jobList.length >= total) {
           exactBulkComplete = true;
           break;
         }
         if (total > INTERN_LIST_MAX_BULK_COUNT) break;
          if (total === requestedTotal) break;
         requestedTotal = total;
        }
        if (!exactBulkComplete) {
          notes.push("The exact-total structured request was incomplete or unavailable; continuing with bounded offset pages.");
       }
     } else {
        notes.push(`The feed has ${total} records; using bounded ${INTERN_LIST_FALLBACK_PAGE_SIZE}-record offsets instead of one oversized request.`);
      }
    }

    if (!first.page || !first.response) {
      return { snapshots: [], retrievalUrls, attempts, httpStatus, notes, failures };
    }
    const firstPage = { ...first.page, total };
    const firstResponse = first.response;
    const firstUnique = uniqueJobIdSet(firstPage.jobList);
    if (firstPage.jobList.length >= total) {
      const duplicateRows = Math.max(0, firstPage.jobList.length - firstUnique.size);
      notes.push(duplicateRows > 0
        ? `Retrieved ${firstUnique.size}/${total} unique records in one complete structured snapshot (${duplicateRows} duplicate rows in the source payload).`
        : `Retrieved ${total}/${total} records in one complete structured snapshot.`);
      this.logger.debug("ADAPTER", `Intern List ${category}: ${firstUnique.size} records in bulk response`);
      return {
        snapshots: [snapshotFromStructuredJson(firstResponse, { success: true, result: firstPage }, feedSnapshotUrl(first.endpoint, category))],
        retrievalUrls,
        attempts,
        httpStatus,
        notes,
        failures,
      };
    }

    notes.push(`Structured response returned ${firstUnique.size}/${total} unique records; falling back to up to ${INTERN_LIST_FALLBACK_PAGE_SIZE}-record offsets.`);

    const pages: Array<{ response: HttpResponseSnapshot; page: InternListPage; endpoint: string }> = [{ response: firstResponse, page: firstPage, endpoint: first.endpoint }];
    const seen = new Set(firstUnique);
    let position = firstPage.jobList.length;
    let latestTotal = total;
    let repeatedWindow = false;
    let noNewUniqueAfterCoveredRange = false;
    while (pages.length < INTERN_LIST_MAX_OFFSET_PAGES) {
      if (seen.size >= latestTotal) break;
      if (position >= latestTotal && noNewUniqueAfterCoveredRange) break;
      const attempt = await this.fetchPage(sourceUrl, category, position, INTERN_LIST_FALLBACK_PAGE_SIZE, {
        timeoutMs: INTERN_LIST_PAGE_TIMEOUT_MS,
        retryCount: INTERN_LIST_RETRY_COUNT,
        cache: false,
      });
      retrievalUrls.push(attempt.endpoint);
      attempts += attempt.response?.attempts ?? 0;
      httpStatus = attempt.response?.status ?? httpStatus ?? attempt.failure?.statusCode ?? null;
      if (!attempt.page || !attempt.response) {
        if (attempt.failure) failures.push(attempt.failure);
        position += INTERN_LIST_FALLBACK_PAGE_SIZE;
        if (position >= latestTotal) noNewUniqueAfterCoveredRange = true;
        continue;
      }
      latestTotal = attempt.page.total;
      const uniqueBefore = seen.size;
      for (const job of attempt.page.jobList) {
        const id = internListJobId(job);
        if (id) seen.add(id);
      }
      const newUnique = seen.size - uniqueBefore;
      if (attempt.page.jobList.length === 0) {
        if (position >= latestTotal) noNewUniqueAfterCoveredRange = true;
        break;
      }
      if (newUnique === 0) {
        if (position >= latestTotal) {
          noNewUniqueAfterCoveredRange = true;
          break;
        }
        if (attempt.page.jobList.length >= INTERN_LIST_PAGE_SIZE) repeatedWindow = true;
      }
      pages.push({
        response: attempt.response,
        page: { ...attempt.page, total: latestTotal },
        endpoint: attempt.endpoint,
      });
      // Advance by what the service actually returned. This remains complete
      // if Jobright temporarily caps a requested 1,000-row page to a smaller
      // server-side limit. Duplicate windows from a live list are recovered by
      // continuing past the original total until unique IDs catch up.
      position += Math.max(1, attempt.page.jobList.length);
      if (newUnique === 0 && position >= latestTotal) {
        noNewUniqueAfterCoveredRange = true;
        break;
      }
    }

    const records = pages.flatMap(({ page }) => page.jobList);
    const ids = uniqueJobIdSet(records);
    const duplicateRows = Math.max(0, records.length - ids.size);
    const coveredRange = position >= latestTotal || records.length >= latestTotal || noNewUniqueAfterCoveredRange;
    if (ids.size >= latestTotal) {
      notes.push(`Retrieved ${ids.size}/${latestTotal} unique records across ${pages.length} structured pages${duplicateRows > 0 ? ` (${duplicateRows} duplicate boundary rows deduplicated downstream)` : ""}.`);
    } else if (coveredRange && !repeatedWindow && failures.length === 0) {
      notes.push(`Retrieved ${ids.size}/${latestTotal} unique records across ${pages.length} structured pages (${duplicateRows} duplicate rows in the live feed; remaining advertised total is not a coverage gap).`);
    } else {
      failures.push(adapterFailure(sourceUrl, INTERN_LIST_API_URL, new Error(`Structured coverage is incomplete: ${ids.size} unique IDs across ${records.length} rows; expected ${latestTotal}.`), httpStatus));
      notes.push(`Coverage validation failed: ${ids.size}/${latestTotal} unique records.`);
    }
    this.logger.debug("ADAPTER", `Intern List ${category}: ${ids.size}/${latestTotal} records`);
    return {
      snapshots: pages.map(({ response, page, endpoint }) => snapshotFromStructuredJson(response, { success: true, result: page }, feedSnapshotUrl(endpoint, category))),
      retrievalUrls,
      attempts,
      httpStatus,
      notes,
      failures,
    };
  }

  private async fetchPage(
    sourceUrl: string,
    category: string,
    position: number,
    count: number,
    options: { timeoutMs: number; retryCount: number; cache?: boolean },
  ): Promise<PageAttempt> {
    const endpoint = internListEndpoint(position, count);
    try {
      const response = await this.http.postJson(endpoint, {
        category,
        excludeTitle: [],
        excludedTitle: [],
      }, { cache: options.cache ?? true, headers: { accept: "application/json" }, timeoutMs: options.timeoutMs, retryCount: options.retryCount });
      const value: unknown = JSON.parse(response.body);
      const page = parseInternListResponse(value);
      if (!page) throw new Error("Intern List API returned an invalid response shape.");
      // The API is expected to honor `count`, but keep the adapter's retained
      // payload bounded if a provider regression returns a larger window.
      return {
        endpoint,
        response,
        page: page.jobList.length > count ? { ...page, jobList: page.jobList.slice(0, count) } : page,
        failure: null,
      };
    } catch (error) {
      return {
        endpoint,
        response: null,
        page: null,
        failure: adapterFailure(sourceUrl, endpoint, error, statusCodeOf(error)),
      };
    }
  }
}
