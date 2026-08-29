import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { ScoutSettings } from "../domain/schemas.js";
import {
  extractUsenoInternshipMasterlist,
  extractUsenoSummer2027,
  isUsenoInternshipMasterlistUrl,
  isUsenoSummer2027Url,
  validateUsenoInternshipMasterlist,
  validateUsenoSummer2027,
  type UsenoInternshipMasterlistPage,
  type UsenoSummer2027Page,
} from "../extractors/useno.js";
import type { Logger } from "../utils/logger.js";
import { HttpClient, HttpRequestError, type HttpResponseSnapshot } from "./http.js";
import { RobotsManager } from "./robots.js";

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
 * Fetch and persist the complete public Useno masterlist in one HTTP pass.
 * The page's own row links are recorded as data only; this function never
 * requests employer application pages.
 */
export async function collectUsenoInternshipMasterlist(options: UsenoCrawlOptions): Promise<UsenoMasterlistCrawlResult> {
  if (!isUsenoInternshipMasterlistUrl(options.sourceUrl)) throw new Error(`Unexpected Useno masterlist source URL: ${options.sourceUrl}`);
  const policy = options.settings.respectRobotsTxt
    ? await options.robots.check(options.sourceUrl)
    : { allowed: true, crawlDelayMs: null };
  if (!policy.allowed) throw new HttpRequestError("Disallowed by robots.txt", null, 0, "robots_disallowed");

  const response = await options.http.get(options.sourceUrl, {
    cache: true,
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

  const page = extractUsenoInternshipMasterlist(response.body, options.sourceUrl);
  validateUsenoInternshipMasterlist(page);
  const artifact: UsenoMasterlistCrawlArtifact = {
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
  const outputPath = options.outputPath ?? join(options.settings.outputDirectory, "useno-internship-masterlist.json");
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  options.logger.debug("USENO", `Saved ${page.totalRecords} complete masterlist listings to ${outputPath}.`);
  return { artifact, outputPath, response };
}
