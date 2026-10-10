import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ScoutSettings } from "../domain/schemas.js";
import {
  extractUsenoInternshipMasterlist,
  extractUsenoSummer2027,
  isUsenoInternshipMasterlistUrl,
  isUsenoSummer2027Url,
  readUsenoMasterlistPayload,
  validateUsenoInternshipMasterlist,
  validateUsenoSummer2027,
  type UsenoInternshipMasterlistPage,
  type UsenoSummer2027Page,
  type UsenoMasterlistPayload,
} from "../extractors/useno.js";
import type { Logger } from "../utils/logger.js";
import { HttpClient, HttpRequestError, type HttpResponseSnapshot } from "./http.js";
import { RobotsManager } from "./robots.js";
import { UsenoApplicationResolver, type UsenoApplicationCandidate } from "./usenoApplications.js";
import { currentSourceAbortSignal, throwIfAborted } from "../domain/cancellation.js";

export interface UsenoCrawlArtifact extends UsenoSummer2027Page {
  retrieval: {
    requestedUrl: string;
    finalUrl: string;
    httpStatus: number;
    contentType: string;
    attempts: number;
    fromCache: boolean;
    etag: string | null;
    lastModified: string | null;
    contentLength: string | null;
  };
}

export interface UsenoCrawlResult {
  artifact: UsenoCrawlArtifact;
  outputPath: string;
  response: HttpResponseSnapshot;
}

export interface UsenoMasterlistCrawlArtifact extends UsenoInternshipMasterlistPage {
  retrieval: UsenoCrawlArtifact["retrieval"];
  rawSnapshotPath?: string;
  inventory?: {
    rawRoleCount: number;
    declaredTotal: number;
    previewCapped: boolean;
    coverageComplete: boolean;
    feedPages: number;
    directApplicationLinks: number;
    unresolvedApplicationLinks: number;
    retrievalUrls: string[];
  };
}

export interface UsenoMasterlistCrawlResult {
  artifact: UsenoMasterlistCrawlArtifact;
  outputPath: string;
  response: HttpResponseSnapshot;
}

export interface UsenoCrawlOptions {
  sourceUrl: string;
  settings: ScoutSettings;
  http: HttpClient;
  robots: RobotsManager;
  logger: Logger;
  outputPath?: string;
  knownApplications?: UsenoApplicationCandidate[];
  onProgress?: () => Promise<void> | void;
}

function feedPayload(response: HttpResponseSnapshot): UsenoMasterlistPayload {
  if (response.status !== 200 || response.stale) throw new Error(`Useno feed returned an incomplete or stale response (HTTP ${response.status}).`);
  const value: unknown = JSON.parse(response.body);
  if (!value || typeof value !== "object" || !Array.isArray((value as UsenoMasterlistPayload).roles)) {
    throw new Error("Useno live feed did not contain a roles array.");
  }
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid Useno feed ${label}.`);
  return value;
}

/**
 * Fetch and persist the complete Useno listing in one HTTP pass. Application
 * URLs are recorded as data only; this function never requests them.
 */
export async function collectUsenoSummer2027(options: UsenoCrawlOptions): Promise<UsenoCrawlResult> {
  if (!isUsenoSummer2027Url(options.sourceUrl)) throw new Error(`Unexpected Useno source URL: ${options.sourceUrl}`);
  const policy = options.settings.respectRobotsTxt
    ? await options.robots.check(options.sourceUrl)
    : { allowed: true, crawlDelayMs: null };
  if (!policy.allowed) throw new HttpRequestError("Disallowed by robots.txt", null, 0, "robots_disallowed");

  const response = await options.http.get(options.sourceUrl, {
    cache: true,
    timeoutMs: 30_000,
    perHostDelayMs: policy.crawlDelayMs ?? 0,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpRequestError(
      `Useno returned HTTP ${response.status}`,
      response.status,
      response.attempts,
      response.status === 429 ? "rate_limited" : "http_error",
      null,
      response.headers,
    );
  }

  const page = extractUsenoSummer2027(response.body, options.sourceUrl);
  validateUsenoSummer2027(page);
  const artifact: UsenoCrawlArtifact = {
    ...page,
    retrieval: {
      requestedUrl: response.requestedUrl,
      finalUrl: response.url,
      httpStatus: response.status,
      contentType: response.contentType,
      attempts: response.attempts,
      fromCache: response.fromCache,
      etag: response.headers.etag ?? null,
      lastModified: response.headers["last-modified"] ?? null,
      contentLength: response.headers["content-length"] ?? null,
    },
  };
  const outputPath = options.outputPath ?? join(options.settings.outputDirectory, "useno-summer-2027-internships.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  options.logger.debug("USENO", `Saved ${page.totalRecords} listings to ${outputPath}.`);
  return { artifact, outputPath, response };
}

/**
 * Fetch every page of the public index, keeping account-limited coverage
 * explicit. The user's source-specific crawl authorization covers the page's
 * first-party /data feed despite its advisory robots disallow; no credentials
 * or authenticated routes are used. Employer links come from exact saved
 * identities or anonymous public ATS responses.
 */
export async function collectUsenoInternshipMasterlist(options: UsenoCrawlOptions): Promise<UsenoMasterlistCrawlResult> {
  if (!isUsenoInternshipMasterlistUrl(options.sourceUrl)) throw new Error(`Unexpected Useno masterlist source URL: ${options.sourceUrl}`);
  const policy = options.settings.respectRobotsTxt
    ? await options.robots.check(options.sourceUrl)
    : { allowed: true, crawlDelayMs: null };
  if (!policy.allowed) throw new HttpRequestError("Disallowed by robots.txt", null, 0, "robots_disallowed");

  const response = await options.http.get(options.sourceUrl, {
    cache: true,
    timeoutMs: 30_000,
    perHostDelayMs: policy.crawlDelayMs ?? 0,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new HttpRequestError(
      `Useno masterlist returned HTTP ${response.status}`,
      response.status,
      response.attempts,
      response.status === 429 ? "rate_limited" : "http_error",
      null,
      response.headers,
    );
  }

  let payload = readUsenoMasterlistPayload(response.body);
  const retrievalUrls = [response.url];
  let feedPages = 0;
  if (response.body.includes("/data/internship-index.json")) {
    const endpoint = new URL("/data/internship-index.json", response.url);
    // This exception is deliberately scoped to the feed linked by this page.
    const feedOptions = { cache: true, timeoutMs: 30_000, respectRobots: false, allowedRedirectOrigins: [endpoint.origin], headers: { accept: "application/json" } };
    const firstResponse = await options.http.get(endpoint.href, feedOptions);
    payload = feedPayload(firstResponse);
    retrievalUrls.push(firstResponse.url);
    const pageCount = positiveInteger(payload.pageCount, "page count");
    const pageSize = positiveInteger(payload.pageSize, "page size");
    const declaredTotal = positiveInteger(payload.total, "total");
    if (pageCount > 32 || pageSize > 5_000 || positiveInteger(payload.page, "page") !== 1) throw new Error("Useno feed exceeded bounded pagination or returned the wrong first page.");
    const roles = [...payload.roles as unknown[]];
    feedPages = 1;
    await options.onProgress?.();
    for (let pageNumber = 2; pageNumber <= pageCount; pageNumber += 1) {
      throwIfAborted(currentSourceAbortSignal());
      if (roles.length !== (pageNumber - 1) * pageSize) throw new Error("Useno feed ended before its advertised last page.");
      endpoint.searchParams.set("page", String(pageNumber));
      const nextResponse = await options.http.get(endpoint.href, feedOptions);
      const next = feedPayload(nextResponse);
      if (next.page !== pageNumber || next.pageCount !== pageCount || next.pageSize !== pageSize || next.total !== declaredTotal
        || next.previewCapped !== payload.previewCapped || !(next.roles as unknown[]).length) {
        throw new Error("Useno feed pagination changed or returned an incomplete page; previous listings must be retained.");
      }
      roles.push(...next.roles as unknown[]);
      if (roles.length > 100_000) throw new Error("Useno feed exceeded the bounded row limit.");
      retrievalUrls.push(nextResponse.url);
      feedPages += 1;
      await options.onProgress?.();
    }
    const ids = roles.map((value) => Array.isArray(value) ? String(value[12] ?? "") : "");
    if (ids.some((id) => !id) || new Set(ids).size !== roles.length) throw new Error("Useno feed repeated or omitted job identifiers across pages.");
    payload = { ...payload, roles };
  }
  const page = extractUsenoInternshipMasterlist(response.body, options.sourceUrl, new Date().toISOString(), payload);
  validateUsenoInternshipMasterlist(page);
  const resolver = new UsenoApplicationResolver(options.http, options.knownApplications);
  let resolvedCount = 0;
  page.listings = await Promise.all(page.listings.map(async (listing) => {
    const resolved = await resolver.resolve(listing);
    resolvedCount += 1;
    if (resolvedCount % 25 === 0) await options.onProgress?.();
    return resolved;
  }));
  const directApplicationLinks = page.listings.filter((listing) => new URL(listing.applicationUrl).hostname.replace(/^www\./, "") !== "useno.app").length;
  const rawRoleCount = (payload.roles as unknown[]).length;
  const declaredTotal = typeof payload.total === "number" ? payload.total : rawRoleCount;
  const previewCapped = payload.previewCapped === true;
  const artifact: UsenoMasterlistCrawlArtifact = {
    ...page,
    inventory: {
      rawRoleCount, declaredTotal, previewCapped,
      coverageComplete: !previewCapped && rawRoleCount === declaredTotal && page.skippedIncompleteCount === 0,
      feedPages, directApplicationLinks, unresolvedApplicationLinks: page.totalRecords - directApplicationLinks,
      retrievalUrls,
    },
    retrieval: {
      requestedUrl: response.requestedUrl,
      finalUrl: response.url,
      httpStatus: response.status,
      contentType: response.contentType,
      attempts: response.attempts,
      fromCache: response.fromCache,
      etag: response.headers.etag ?? null,
      lastModified: response.headers["last-modified"] ?? null,
      contentLength: response.headers["content-length"] ?? null,
    },
  };
  const outputPath = options.outputPath ?? join(options.settings.outputDirectory, "useno-internship-masterlist.json");
  await mkdir(dirname(outputPath), { recursive: true });
  artifact.rawSnapshotPath = outputPath.replace(/\.json$/i, "") + ".feed.json";
  await writeFile(artifact.rawSnapshotPath, `${JSON.stringify({ retrievedAt: page.retrievedAt, retrievalUrls, payload }, null, 2)}\n`, "utf8");
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  options.logger.debug("USENO", `Saved ${page.totalRecords} complete masterlist listings to ${outputPath}.`);
  return { artifact, outputPath, response };
}
