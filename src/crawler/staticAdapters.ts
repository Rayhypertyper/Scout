import { load, type CheerioAPI } from "cheerio";

import type { FetchFailure, LinkCandidate, PageSnapshot } from "../domain/types.js";
import type { ScoutSettings } from "../domain/schemas.js";
import { discoverPublicBoardLinks } from "../extractors/publicBoards.js";
import { canonicalizeUrl, safeCanonicalizeUrl, sameSite } from "../utils/url.js";
import type { Logger } from "../utils/logger.js";
import { HttpClient, HttpRequestError, isTransientHttpRequestError, type HttpResponseSnapshot } from "./http.js";
import { publicSourceFallbacks } from "./publicSources.js";

export interface StaticAdapterResult {
  snapshots: PageSnapshot[];
  /** Listing pages are always returned separately for early filtering. */
  listingSnapshots?: PageSnapshot[];
  detailCandidates?: StaticDetailCandidate[];
  retrievalMethod: string;
  retrievalUrls: string[];
  attempts: number;
  httpStatus: number | null;
  notes: string[];
  failures: FetchFailure[];
}

export type StaticUrlPolicy = (url: string) => Promise<{ allowed: boolean; crawlDelayMs?: number | null }>;

export interface StaticDetailCandidate {
  url: string;
  title: string;
  snippet: string;
  sourceUrl: string;
  externalJobId?: string;
}

export interface StaticListingResult extends Omit<StaticAdapterResult, "snapshots"> {
  listingSnapshots: PageSnapshot[];
  detailCandidates: StaticDetailCandidate[];
}

interface AdapterProfile {
  name: string;
  host: RegExp;
  path: RegExp;
  detailPath: RegExp;
  maxDetails: number;
  maxListPages: number;
  sitemapIndexUrl?: string;
  maxSitemapShards?: number;
  candidatePattern: RegExp;
  listingLinkExtractor?: (snapshot: PageSnapshot) => LinkCandidate[];
}

/**
 * Resolve a finite batch with a bounded number of workers. This intentionally
 * avoids creating one promise per detail URL up front: large public boards can
 * expose several thousand links and an eager Promise.all would retain every
 * closure/body until the entire source settled.
 */
export async function mapBounded<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = Array.from({ length: values.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= values.length) return;
      try {
        results[index] = { status: "fulfilled", value: await operation(values[index] as T, index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, values.length || 1)) }, () => worker());
  await Promise.all(workers);
  return results;
}

const PROFILES: AdapterProfile[] = [
  {
    name: "ApplyBolt",
    host: /(?:^|\.)applybolt\.app$/i,
    path: /\/jobs\/2027(?:-all)?-internships$/i,
    detailPath: /^\/job\//i,
    maxDetails: 500,
    maxListPages: 30,
    candidatePattern: /(?:intern|internship|co-?op|student|software|developer|data|qa|automation|machine learning|\bai\b|cyber|embedded|computer science)/i,
  },
  {
    name: "HiringCafe",
    host: /(?:^|\.)hiringcafe\.com$/i,
    path: /^(?:\/|\/jobs\/(?:canada|united-states))$/i,
    detailPath: /^\/job\//i,
    maxDetails: 300,
    maxListPages: 1,
    sitemapIndexUrl: "https://hiringcafe.com/job-posting-sitemap.xml",
    maxSitemapShards: 3,
    candidatePattern: /(?:2027|intern|internship|co-?op|student|software|developer|data|qa|automation|machine learning|\bai\b|cyber|embedded|computer science)/i,
  },
  {
    name: "InternInsider",
    host: /(?:^|\.)interninsider\.me$/i,
    path: /^\/internships\/new$/i,
    detailPath: /^\/internships\/[^/]+\/[^/]+/i,
    maxDetails: 100,
    maxListPages: 1,
    candidatePattern: /(?:intern|internship|co-?op|student|software|developer|data|qa|automation|machine learning|\bai\b|cyber|embedded|computer science)/i,
  },
  {
    name: "Wellfound",
    host: /(?:^|\.)wellfound\.com$/i,
    path: /^\/location\/canada-startups$/i,
    detailPath: /^\/jobs\//i,
    maxDetails: 250,
    maxListPages: 1,
    candidatePattern: /(?:intern|internship|co-?op|student|software|developer|data|qa|automation|machine learning|\bai\b|cyber|embedded|computer science)/i,
  },
  {
    name: "CSJobs",
    host: /(?:^|\.)csjobs\.ca$/i,
    path: /^\/internships\/toronto$/i,
    detailPath: /^\/jobs\//i,
    maxDetails: 450,
    maxListPages: 1,
    candidatePattern: /(?:intern|internship|co-?op|student|software|developer|data|qa|automation|machine learning|\bai\b|cyber|embedded|computer science|new grad)/i,
    listingLinkExtractor: csJobsInternshipLinks,
  },
];

function profileFor(sourceUrl: string): AdapterProfile | null {
  try {
    const url = new URL(sourceUrl);
    const host = url.hostname.replace(/^www\./i, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return PROFILES.find((profile) => profile.host.test(host) && profile.path.test(path)) ?? null;
  } catch {
    return null;
  }
}

/**
 * CSJobs' city landing page contains adjacent grids for internships/co-ops,
 * new-grad, and other role types. Collect every first-party job card so title
 * and internship-signal visibility reasons are decided by classification,
 * rather than by a source-specific product policy. Returning an empty array
 * intentionally lets the caller fall back to generic same-site discovery if
 * the page markup changes.
 */
function csJobsInternshipLinks(snapshot: PageSnapshot): LinkCandidate[] {
  const $ = load(snapshot.html);
  const heading = $("h2").filter((_index, element) => /internships\s*&\s*co-ops/i.test($(element).text())).first();
  const grids = heading.nextAll(".live-grid");
  if (grids.length === 0) return [];
  const links: LinkCandidate[] = [];
  grids.find("a.live-card[href], a[href*='/jobs/']").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = safeCanonicalizeUrl(href, snapshot.url);
    if (!url) return;
    const title = $(element).find(".live-card-title").clone().find(".company-avatar").remove().end().text().trim();
    links.push({
      url,
      text: title || $(element).text().trim(),
      rel: $(element).attr("rel") ?? "",
    });
  });
  return links;
}

function visibleText($: CheerioAPI): string {
  const root = $.root().clone();
  root.find("script,style,noscript,template").remove();
  root.find("br").replaceWith("\n");
  root.find("li").each((_index, element) => {
    $(element).prepend("\n• ").append("\n");
  });
  root.find("p,h1,h2,h3,h4,h5,h6,div,section,article,main,header,footer,aside,dt,dd,tr").each((_index, element) => {
    $(element).prepend("\n").append("\n");
  });
  const body = root.find("body");
  const value = body.length > 0 ? body.text() : root.text();
  return value.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function snapshotFromHttp(response: HttpResponseSnapshot): PageSnapshot {
  const html = /html|xml/i.test(response.contentType) || /<html\b|<main\b|<body\b/i.test(response.body)
    ? response.body
    : `<pre>${response.body.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`;
  const $ = load(html);
  const links: LinkCandidate[] = [];
  $("a[href]").each((_index, element) => {
    const href = $(element).attr("href");
    if (!href) return;
    const url = safeCanonicalizeUrl(href, response.url);
    if (!url) return;
    links.push({
      url,
      text: ($(element).text() || $(element).attr("aria-label") || $(element).attr("title") || "").trim(),
      rel: $(element).attr("rel") ?? "",
    });
  });
  const title = $("title").first().text().trim();
  const text = visibleText($);
  return {
    requestedUrl: response.requestedUrl,
    url: canonicalizeUrl(response.url),
    status: response.status,
    contentType: response.contentType,
    title,
    html,
    text,
    links: uniqueLinkCandidates(links),
    cacheMetadata: {
      etag: response.headers.etag ?? null,
      lastModified: response.headers["last-modified"] ?? null,
      canonicalUrl: canonicalizeUrl(response.url),
    },
    fromCache: response.fromCache,
    ...(response.stale === undefined ? {} : { stale: response.stale }),
    fetchedAt: new Date().toISOString(),
  };
}

function uniqueLinkCandidates(links: LinkCandidate[]): LinkCandidate[] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.url}\n${link.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function sitemapLocations(body: string): string[] {
  return [...body.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)]
    .map((match) => match[1]
      ?.replaceAll("&amp;", "&")
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .trim() ?? "")
    .filter(Boolean);
}

function detailLinkCandidates(profile: AdapterProfile, roots: PageSnapshot[], sourceUrl: string, extraUrls: string[] = []): StaticDetailCandidate[] {
  const genericLinks = roots.flatMap((root) => [...root.links, ...discoverPublicBoardLinks(root)]);
  const extractedLinks = profile.listingLinkExtractor
    ? roots.flatMap((root) => profile.listingLinkExtractor?.(root) ?? [])
    : [];
  const listingLinks = extractedLinks.length > 0 ? extractedLinks : genericLinks;
  const candidates = [
    ...listingLinks,
    ...extraUrls.map((url) => ({ url, text: "", rel: "" })),
  ];
  const links = candidates
    .map((link) => ({ link, url: safeCanonicalizeUrl(link.url) }))
    .filter((candidate): candidate is { link: LinkCandidate; url: string } => Boolean(candidate.url))
    .filter(({ url }) => {
      try {
        return sameSite(sourceUrl, url) && profile.detailPath.test(new URL(url).pathname);
      } catch {
        return false;
      }
    });
  const evidenceByUrl = new Map(candidates.map((link) => [safeCanonicalizeUrl(link.url) ?? link.url, link.text]));
  // Collect first, then let the normalized parser decide whether a posting is
  // an internship. Candidate order is the source's deterministic document or
  // sitemap order; title/category evidence must not decide which detail pages
  // survive discovery.
  const unique = new Map<string, StaticDetailCandidate>();
  for (const { link, url } of links) {
    if (!unique.has(url)) {
      const title = link.text.trim();
      const externalJobId = extractExternalId(url);
      const candidate: StaticDetailCandidate = {
        url,
        title,
        snippet: title,
        sourceUrl,
        ...(externalJobId ? { externalJobId } : {}),
      };
      unique.set(url, candidate);
    }
  }
  return [...unique.values()]
    .toSorted((left, right) => {
      const leftRelevant = profile.candidatePattern.test(`${left.url} ${evidenceByUrl.get(left.url) ?? left.title}`) ? 1 : 0;
      const rightRelevant = profile.candidatePattern.test(`${right.url} ${evidenceByUrl.get(right.url) ?? right.title}`) ? 1 : 0;
      return rightRelevant - leftRelevant;
    })
    .slice(0, profile.maxDetails);
}

function extractExternalId(url: string): string | null {
  try {
    const pathParts = new URL(url).pathname.split("/").filter(Boolean);
    const candidate = pathParts.at(-1)?.replace(/\.(?:html?|php)$/i, "") ?? "";
    return /\d{3,}|[A-Za-z]{2,}[\w-]*\d/.test(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

function failureType(error: unknown): string {
  return error instanceof HttpRequestError ? error.errorType : "http_error";
}

function failureRetryCount(error: unknown): number {
  return error instanceof HttpRequestError ? error.attempts : 0;
}

function resilientBoardRequestOptions(profile: AdapterProfile): { staleIfError?: boolean } {
  return profile.name === "CSJobs" || profile.name === "HiringCafe" ? { staleIfError: true } : {};
}

export class StaticHttpAdapter {
  public constructor(
    private readonly settings: ScoutSettings,
    private readonly logger: Logger,
    private readonly http: HttpClient,
    private readonly urlPolicy?: StaticUrlPolicy,
  ) {}

  public profile(sourceUrl: string): AdapterProfile | null {
    return profileFor(sourceUrl);
  }

  /** Compatibility convenience: list first, then fetch every selected detail. */
  public async collect(sourceUrl: string): Promise<StaticAdapterResult> {
    const listing = await this.collectListing(sourceUrl);
    const details = await this.fetchDetails(sourceUrl, listing.detailCandidates);
    return {
      ...listing,
      snapshots: [...listing.listingSnapshots, ...details.snapshots],
      listingSnapshots: listing.listingSnapshots,
      detailCandidates: listing.detailCandidates,
      retrievalUrls: [...listing.listingSnapshots, ...details.snapshots].map(({ url }) => url),
      attempts: listing.attempts + details.attempts,
      httpStatus: details.httpStatus ?? listing.httpStatus,
      notes: [...listing.notes, ...details.notes],
      failures: [...listing.failures, ...details.failures],
    };
  }

  /** Fetch only listing/sitemap pages; no expensive detail-page I/O occurs. */
  public async collectListing(sourceUrl: string): Promise<StaticListingResult> {
    const profile = profileFor(sourceUrl);
    if (!profile) throw new Error(`No static adapter profile for ${sourceUrl}`);
    const rootPolicy = this.urlPolicy ? await this.urlPolicy(sourceUrl) : { allowed: true, crawlDelayMs: null };
    if (!rootPolicy.allowed) throw new HttpRequestError("Source disallowed by robots.txt", null, 0, "robots_disallowed");
    const notes: string[] = [];
    const failures: FetchFailure[] = [];
    const extraDetailUrls: string[] = [];
    const rootResponse = await this.fetchListingRoot(sourceUrl, profile, rootPolicy, notes, failures);
    const listSnapshots: PageSnapshot[] = [];
    let attempts = 0;
    let httpStatus: number | null = null;
    if (rootResponse) {
      const root = snapshotFromHttp(rootResponse);
      if (root.fromCache && root.stale) notes.push(`${profile.name} used its last successful cached page after a transient transport failure.`);
      listSnapshots.push(root);
      attempts = rootResponse.attempts;
      httpStatus = rootResponse.status;
    }
    if (profile.maxListPages > 1 && listSnapshots[0]) {
      const listingRoot = listSnapshots[0];
      const paginationQueue = listingRoot.links
        .map(({ url }) => safeCanonicalizeUrl(url, listingRoot.url))
        .filter((url): url is string => Boolean(url));
      const seenPagination = new Set<string>();
      while (paginationQueue.length > 0 && listSnapshots.length < profile.maxListPages) {
        const batch: string[] = [];
        const batchDelays = new Map<string, number>();
        while (paginationQueue.length > 0 && batch.length < Math.max(1, Math.min(this.settings.httpConcurrency, 6)) && listSnapshots.length + batch.length < profile.maxListPages) {
          const url = paginationQueue.shift();
          if (!url || seenPagination.has(url)) continue;
          seenPagination.add(url);
          try {
            const parsed = new URL(url);
            if (sameSite(sourceUrl, url) && profile.path.test(parsed.pathname) && parsed.searchParams.has("page")) {
              const policy = this.urlPolicy ? await this.urlPolicy(url) : { allowed: true, crawlDelayMs: null };
              if (policy.allowed) {
                batch.push(url);
                if (policy.crawlDelayMs !== null && policy.crawlDelayMs !== undefined) batchDelays.set(url, policy.crawlDelayMs);
              } else failures.push({ sourceUrl, url, errorType: "robots_disallowed", message: "Disallowed by robots.txt", statusCode: null, retryCount: 0, occurredAt: new Date().toISOString() });
            }
          } catch {
            // Ignore malformed pagination links.
          }
        }
        const pageResults = await mapBounded(batch, Math.max(1, Math.min(this.settings.httpConcurrency, 6)), async (url) => this.http.get(url, {
          cache: true,
          perHostDelayMs: Math.max(Math.min(this.settings.perHostDelayMs, 150), batchDelays.get(url) ?? 0),
          ...resilientBoardRequestOptions(profile),
        }));
        for (const [index, result] of pageResults.entries()) {
          const url = batch[index];
          if (!url) continue;
          if (result.status === "fulfilled") {
            attempts += result.value.attempts;
            httpStatus = result.value.status;
            const snapshot = snapshotFromHttp(result.value);
            listSnapshots.push(snapshot);
            for (const link of snapshot.links) {
              const next = safeCanonicalizeUrl(link.url, snapshot.url);
              if (next && !seenPagination.has(next)) paginationQueue.push(next);
            }
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            notes.push(`Could not retrieve pagination page ${url}: ${message}`);
            failures.push({
              sourceUrl,
              url,
              errorType: result.reason instanceof HttpRequestError && result.reason.errorType === "robots_disallowed" ? "robots_disallowed" : failureType(result.reason),
              message,
              statusCode: result.reason instanceof HttpRequestError ? result.reason.statusCode : null,
              retryCount: failureRetryCount(result.reason),
              occurredAt: new Date().toISOString(),
            });
          }
        }
      }
    }
    if (profile.sitemapIndexUrl) {
      try {
        const sitemapPolicy = this.urlPolicy ? await this.urlPolicy(profile.sitemapIndexUrl) : { allowed: true, crawlDelayMs: null };
        if (!sitemapPolicy.allowed) throw new HttpRequestError("Sitemap disallowed by robots.txt", null, 0, "robots_disallowed");
        const sitemapIndex = await this.http.get(profile.sitemapIndexUrl, {
          cache: true,
          perHostDelayMs: Math.max(Math.min(this.settings.perHostDelayMs, 150), sitemapPolicy.crawlDelayMs ?? 0),
          ...resilientBoardRequestOptions(profile),
        });
        if (listSnapshots.length === 0) listSnapshots.push(snapshotFromHttp(sitemapIndex));
        attempts += sitemapIndex.attempts;
        httpStatus = sitemapIndex.status;
        const shardUrls = sitemapLocations(sitemapIndex.body)
          .map((url) => safeCanonicalizeUrl(url))
          .filter((url): url is string => Boolean(url))
          .filter((url) => sameSite(sourceUrl, url))
          .slice(0, profile.maxSitemapShards ?? 0);
        const allowedShardUrls: string[] = [];
        const shardDelays = new Map<string, number>();
        for (const shardUrl of shardUrls) {
          const policy = this.urlPolicy ? await this.urlPolicy(shardUrl) : { allowed: true, crawlDelayMs: null };
          if (policy.allowed) {
            allowedShardUrls.push(shardUrl);
            if (policy.crawlDelayMs !== null && policy.crawlDelayMs !== undefined) shardDelays.set(shardUrl, policy.crawlDelayMs);
          } else failures.push({ sourceUrl, url: shardUrl, errorType: "robots_disallowed", message: "Disallowed by robots.txt", statusCode: null, retryCount: 0, occurredAt: new Date().toISOString() });
        }
        const shardResults = await mapBounded(allowedShardUrls, Math.max(1, Math.min(this.settings.httpConcurrency, 8)), async (shardUrl) => this.http.get(shardUrl, {
          cache: true,
          perHostDelayMs: Math.max(Math.min(this.settings.perHostDelayMs, 150), shardDelays.get(shardUrl) ?? 0),
          ...resilientBoardRequestOptions(profile),
        }));
        for (const [index, result] of shardResults.entries()) {
          const shardUrl = allowedShardUrls[index];
          if (!shardUrl) continue;
          if (result.status === "fulfilled") {
            attempts += result.value.attempts;
            httpStatus = result.value.status;
            extraDetailUrls.push(...sitemapLocations(result.value.body));
          } else {
            const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
            notes.push(`Could not retrieve sitemap shard ${shardUrl}: ${message}`);
            failures.push({
              sourceUrl,
              url: shardUrl,
              errorType: result.reason instanceof HttpRequestError && result.reason.errorType === "robots_disallowed"
                ? "robots_disallowed"
                : failureType(result.reason),
              message,
              statusCode: result.reason instanceof HttpRequestError ? result.reason.statusCode : null,
              retryCount: failureRetryCount(result.reason),
              occurredAt: new Date().toISOString(),
            });
          }
        }
        if (shardUrls.length > 0) notes.push(`${profile.name} inspected ${shardUrls.length} public sitemap shard(s) before selecting detail pages.`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        notes.push(`Could not retrieve the public ${profile.name} sitemap index: ${message}`);
        failures.push({
          sourceUrl,
          url: profile.sitemapIndexUrl,
          errorType: error instanceof HttpRequestError && error.errorType === "robots_disallowed"
            ? "robots_disallowed"
            : failureType(error),
          message,
          statusCode: error instanceof HttpRequestError ? error.statusCode : null,
          retryCount: failureRetryCount(error),
          occurredAt: new Date().toISOString(),
        });
      }
    }
    const detailCandidates = detailLinkCandidates(profile, listSnapshots, sourceUrl, extraDetailUrls);
    if (listSnapshots.length > 1 || listSnapshots[0]?.links.length !== detailCandidates.length) {
      notes.push(`${profile.name} selected ${detailCandidates.length} relevant detail URLs across ${listSnapshots.length} list page(s).`);
    }
    this.logger.debug("HTTP", `${profile.name}: retrieved ${listSnapshots.length} listing pages with ${detailCandidates.length} detail candidates (details deferred).`);
    return {
      listingSnapshots: listSnapshots,
      detailCandidates,
      retrievalMethod: `${profile.name} static HTTP`,
      retrievalUrls: listSnapshots.map(({ url }) => url),
      attempts,
      httpStatus,
      notes,
      failures,
    };
  }

  /** Fetch a caller-selected subset of detail candidates after early filtering. */
  public async fetchDetails(sourceUrl: string, candidates: readonly StaticDetailCandidate[]): Promise<StaticAdapterResult> {
    const profile = profileFor(sourceUrl);
    if (!profile) throw new Error(`No static adapter profile for ${sourceUrl}`);
    const details: PageSnapshot[] = [];
    const notes: string[] = [];
    const failures: FetchFailure[] = [];
    let attempts = 0;
    let httpStatus: number | null = null;
    const allowedCandidates: StaticDetailCandidate[] = [];
    const candidateDelays = new Map<string, number>();
    for (const candidate of candidates) {
      const policy = this.urlPolicy ? await this.urlPolicy(candidate.url) : { allowed: true, crawlDelayMs: null };
      if (policy.allowed) {
        allowedCandidates.push(candidate);
        if (policy.crawlDelayMs !== null && policy.crawlDelayMs !== undefined) candidateDelays.set(candidate.url, policy.crawlDelayMs);
      } else failures.push({ sourceUrl, url: candidate.url, errorType: "robots_disallowed", message: "Disallowed by robots.txt", statusCode: null, retryCount: 0, occurredAt: new Date().toISOString() });
    }
    const detailResults = await mapBounded(allowedCandidates, Math.max(1, Math.min(this.settings.httpConcurrency, 8)), async ({ url }) => this.http.get(url, {
      cache: true,
      // The HTTP client still enforces one request at a time per origin; this
      // lower delay avoids making a large public feed take an hour.
      perHostDelayMs: Math.max(Math.min(this.settings.perHostDelayMs, 150), candidateDelays.get(url) ?? 0),
      ...resilientBoardRequestOptions(profile),
    }));
    for (const [index, result] of detailResults.entries()) {
      const url = allowedCandidates[index]?.url ?? sourceUrl;
      if (result.status === "fulfilled") {
        attempts += result.value.attempts;
        httpStatus = result.value.status;
        details.push(snapshotFromHttp(result.value));
      } else {
        const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
        notes.push(`A detail page could not be retrieved: ${message}`);
        failures.push({
          sourceUrl,
          url,
          errorType: result.reason instanceof HttpRequestError && result.reason.errorType === "robots_disallowed"
            ? "robots_disallowed"
            : failureType(result.reason),
          message,
          statusCode: result.reason instanceof HttpRequestError ? result.reason.statusCode : null,
          retryCount: failureRetryCount(result.reason),
          occurredAt: new Date().toISOString(),
        });
      }
    }
    return {
      snapshots: details,
      retrievalMethod: `${profile.name} static HTTP details`,
      retrievalUrls: details.map(({ url }) => url),
      attempts,
      httpStatus,
      notes,
      failures,
    };
  }

  /**
   * Fetch the configured listing page, then any public equivalent after a
   * transient timeout. Boards with a sitemap can continue without a listing
   * snapshot rather than failing the whole source.
   */
  private async fetchListingRoot(
    sourceUrl: string,
    profile: AdapterProfile,
    rootPolicy: { allowed: boolean; crawlDelayMs?: number | null },
    notes: string[],
    failures: FetchFailure[],
  ): Promise<HttpResponseSnapshot | null> {
    const requestOptions = {
      cache: true,
      perHostDelayMs: Math.max(this.settings.perHostDelayMs, rootPolicy.crawlDelayMs ?? 0),
      ...resilientBoardRequestOptions(profile),
    };
    try {
      return await this.http.get(sourceUrl, requestOptions);
    } catch (error) {
      if (!isTransientHttpRequestError(error)) throw error;
      for (const fallback of publicSourceFallbacks(sourceUrl)) {
        const policy = this.urlPolicy ? await this.urlPolicy(fallback.url) : { allowed: true, crawlDelayMs: null };
        if (!policy.allowed) continue;
        try {
          const response = await this.http.get(fallback.url, {
            cache: true,
            perHostDelayMs: Math.max(this.settings.perHostDelayMs, policy.crawlDelayMs ?? 0),
            ...resilientBoardRequestOptions(profile),
          });
          notes.push(
            profile.name === "CSJobs"
              ? "CSJobs' configured Toronto route was temporarily unavailable; used the public all-jobs route instead."
              : `${profile.name}'s configured route was temporarily unavailable; used ${fallback.reason} instead.`,
          );
          return response;
        } catch (fallbackError) {
          if (!isTransientHttpRequestError(fallbackError)) throw fallbackError;
        }
      }
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        sourceUrl,
        url: sourceUrl,
        errorType: failureType(error),
        message,
        statusCode: error instanceof HttpRequestError ? error.statusCode : null,
        retryCount: failureRetryCount(error),
        occurredAt: new Date().toISOString(),
      });
      if (profile.sitemapIndexUrl) {
        notes.push(`Could not retrieve ${profile.name}'s listing page (${message}); continuing from the public sitemap.`);
        return null;
      }
      throw error;
    }
  }
}
