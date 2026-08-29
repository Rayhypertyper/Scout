import { performance } from "node:perf_hooks";
import { join } from "node:path";

import { analyzeRawJob, internshipContentHash, type AnalyzeResult } from "../classification/analyzeJob.js";
import { isExcludedJobTitle } from "../classification/titlePolicy.js";
import { directApplicationOverride, knownClosedAggregatorPosting } from "../config/directApplicationOverrides.js";
import { SOURCE_RETRY_MAX_DURATION_MS, SOURCE_MAX_DURATION_MS } from "../config/runLock.js";
import { isKnownNonProductionJobBoard } from "../config/nonProductionSources.js";
import { deduplicateJobs } from "../deduplication/deduplicate.js";
import type {
  AnalyzedJob,
  ClosedPage,
  CrawlMetrics,
  CrawlStateDecision,
  CrawlQueueItem,
  CrawlProgress,
  CrawlResult,
  FetchFailure,
  LightweightSighting,
  ListingIdentityHint,
  LinkCandidate,
  PageSnapshot,
  SourceCrawlResult,
  SourceStrategyState,
  SourceStatus,
  RawJob,
} from "../domain/types.js";
import { InternshipSchema, type ScoutSettings } from "../domain/schemas.js";
import { discoverPublicBoardLinks, extractJobs } from "../extractors/index.js";
import type { Logger } from "../utils/logger.js";
import { canonicalizeUrl, hostLabel, isAggregatorUrl, isAtsUrl, isGithubUrl, isJobrightJobUrl, isJobrightUrl, redactSensitiveUrl, safeCanonicalizeUrl, sameSite } from "../utils/url.js";
import { BrowserManager, PageFetchError } from "./browser.js";
import { GitHubSourceAdapter } from "./githubAdapter.js";
import { HttpClient, HttpRequestError } from "./http.js";
import { snapshotFromHttp, StaticHttpAdapter } from "./staticAdapters.js";
import { looksLikeRecruitingLink, scoreLink } from "./linkScorer.js";
import { PriorityQueue } from "./queue.js";
import { RobotsManager } from "./robots.js";
import { earlyCareerRadarSameSite, isCsJobsTorontoSource, isEarlyCareerRadarSource, isHiringCafeSource, largeListingSourcePageFloor, publicSourceFallbacks } from "./publicSources.js";
import { classifyPageContent } from "../verification/pageContent.js";
import { SourceAdapterRouter } from "./adapters/router.js";
import type { SourceAdapterResult } from "./adapters/types.js";
import { INTERN_LIST_API_URL, internListFeeds } from "./adapters/internList.js";
import { scoreListingRelevance } from "../classification/listingRelevance.js";
import { deduplicateListings, listingIdentityMatches, type ListingIdentityInput } from "../deduplication/deduplicate.js";
import { BoundedAsyncQueue } from "../utils/async.js";
import { Profiler } from "../observability/profiler.js";
import { isUsenoInternshipMasterlistUrl, isUsenoSummer2027Url, type UsenoMasterlistListing } from "../extractors/useno.js";
import { parseLocations } from "../parsing/locations.js";
import { collectUsenoInternshipMasterlist, collectUsenoSummer2027 } from "./useno.js";
import { cancellationError, currentSourceAbortSignal, isSourceStalledError, runWithSourceAbortSignal, SourceStalledError, throwIfAborted } from "../domain/cancellation.js";
import {
  GrindJobBoardClient,
  grindJobToAnalyzedJob,
  isGrindJobBoardSource,
} from "../integrations/grindJobBoard.js";

// A Radar browser crawl is an emergency fallback only. Its HTTP adapter is
// the complete-feed path, so never let the large-listing floor turn a failed
// source retrieval into thousands of rendered detail requests.
const EARLY_CAREER_RADAR_BROWSER_PAGE_CAP = 100;

// Keep malformed or unexpectedly broad feeds bounded before analysis and
// link discovery can consume unbounded memory for one source.
const MAX_ACCEPTED_JOBS_PER_SOURCE = 5_000;

let sourceStallMsOverride: number | null = null;
let sourceRetryStallMsOverride: number | null = null;

export function setSourceStallTimeoutsForTests(stallMs: number | null, retryStallMs: number | null = stallMs): void {
  sourceStallMsOverride = stallMs;
  sourceRetryStallMsOverride = retryStallMs;
}

function configuredSourceStallMs(): number {
  return sourceStallMsOverride ?? SOURCE_MAX_DURATION_MS;
}

function configuredSourceRetryStallMs(): number {
  return sourceRetryStallMsOverride ?? SOURCE_RETRY_MAX_DURATION_MS;
}

interface SourceTaskOptions {
  /** Inactivity budget for this attempt; progress resets the watchdog. */
  maxDurationMs?: number;
  /** Backwards-compatible alias for callers/tests using the old name. */
  stallMs?: number;
  retryOnStall?: boolean;
}

function isLikelyJobDetailUrl(value: string): boolean {
  const url = new URL(value);
  if (/\/(?:jobs?|positions?|requisitions?|job-postings?)\/[^/]+/i.test(url.pathname)) return true;
  if (/\/job\/[^/]+/i.test(url.pathname)) return true;
  return isAtsUrl(value) && url.pathname.split("/").filter(Boolean).length >= 2;
}

export function detectClosedPage(text: string, status: number, url: string, knownVerification = false, html = ""): string | null {
  if (status === 404) return "HTTP 404";
  if (status === 410) return "HTTP 410 Gone";
  if (knownVerification && isKnownNonProductionJobBoard(url)) return "Known non-production ATS integration sandbox";
  if (knownClosedAggregatorPosting(url)) return "Original company posting removed";
  const jobrightExpired = knownVerification
    && /(?:^|\.)jobright\.ai$/i.test(new URL(url).hostname)
    && primaryJobrightListingIsHidden(html);
  if (jobrightExpired && !directApplicationOverride(url)) return "Aggregator marks job expired";
  const candidateText = /(?:^|\.)csjobs\.ca$/i.test(hostname(url))
    // CSJobs includes its hidden report modal in body text. The modal's
    // "Job is no longer available" radio option is not a posting status.
    ? text.replace(/\bReport Job Listing\b[\s\S]*?\bSubmit Report\b/gi, "")
    : text;
  const contentStatus = classifyPageContent(candidateText);
  if (contentStatus?.state === "not-found") return contentStatus.reason;
  if (!knownVerification && !isLikelyJobDetailUrl(url)) return null;
  return contentStatus?.reason ?? null;
}


export function primaryJobrightListingIsHidden(html: string): boolean {
  const payload = /<script\b[^>]*\bid=["']jobright-helper-job-detail-info["'][^>]*>([\s\S]*?)<\/script>/i.exec(html)?.[1];
  if (!payload) return false;
  try {
    const parsed = JSON.parse(payload) as { jobResult?: { hiddenJob?: unknown } };
    return parsed.jobResult?.hiddenJob === true;
  } catch {
    return false;
  }
}

function hostname(value: string): string {
  return new URL(value).hostname;
}

function sourceLimitFailure(sourceUrl: string, url: string, kind: string, observed: number, limit = MAX_ACCEPTED_JOBS_PER_SOURCE): FetchFailure {
  return {
    sourceUrl,
    url,
    errorType: "source_limit",
    message: `${kind} exceeded the per-source safety limit of ${limit}; observed at least ${observed} and analyzed only the bounded prefix to protect crawler memory.`,
    statusCode: null,
    retryCount: 0,
    occurredAt: new Date().toISOString(),
  };
}

function earlyCareerRadarOwnerUrl(sourceUrl: string, targetUrl: string): boolean {
  return isEarlyCareerRadarSource(sourceUrl) && earlyCareerRadarSameSite(sourceUrl, targetUrl);
}

function hasDirectApplicationUrl(sourceUrl: string, applicationUrl: string): boolean {
  try {
    new URL(applicationUrl);
    return !sameSite(sourceUrl, applicationUrl);
  } catch {
    return false;
  }
}

function usenoCountryLabel(value: string): string | null {
  if (/^(?:ca|can|canada)$/iu.test(value.trim())) return "Canada";
  if (/^(?:us|usa|u\.?s\.?|united states)$/iu.test(value.trim())) return "United States";
  return null;
}

/**
 * The masterlist is a structured discovery source rather than an employer
 * detail page. Preserve its complete row-level identity as a valid listing,
 * and state explicitly that the public feed did not include the employer
 * description or qualifications.
 */
function usenoMasterlistJob(listing: UsenoMasterlistListing, sourceUrl: string, now: string): AnalyzedJob {
  const locationResult = parseLocations([listing.location, listing.region].filter(Boolean));
  const metadataCountry = usenoCountryLabel(listing.country);
  const normalizedLocations = locationResult.normalized.map((location) => (
    location.country || !metadataCountry
      ? location
      : { ...location, country: metadataCountry }
  ));
  const remoteStatus = /remote/i.test(listing.workModel)
    ? "remote"
    : /hybrid/i.test(listing.workModel)
      ? "hybrid"
      : /on[ -]?site|onsite/i.test(listing.workModel)
        ? "onsite"
        : locationResult.remoteStatus;
  const category = listing.categoryId === "data" ? "data" : "swe";
  const description = [
    "Useno masterlist snapshot.",
    `Employer description and qualifications were not included in the public masterlist for ${listing.company}'s ${listing.title} listing.`,
    `The source lists it under ${listing.category}, as ${listing.type || "an unspecified student role"}, at ${listing.location}, with a ${listing.workModel || "not stated"} work model.`,
    listing.postedAt ? `The source posted it on ${listing.postedAt}.` : "",
    `Review the employer posting for the complete role details: ${listing.applicationUrl}`,
  ].filter(Boolean).join(" ");
  const internship = InternshipSchema.parse({
    id: listing.id,
    jobId: listing.id,
    company: listing.company,
    title: listing.title,
    location: [listing.location],
    normalizedLocations,
    remoteStatus,
    applicationUrl: listing.applicationUrl,
    postingUrl: listing.applicationUrl,
    sourceUrl: canonicalizeUrl(sourceUrl),
    sources: [canonicalizeUrl(sourceUrl)],
    description,
    responsibilities: [],
    requiredQualifications: [],
    preferredQualifications: [],
    technologies: [],
    educationRequirements: [],
    graduationRequirements: [],
    experienceRequirements: [],
    workAuthorizationRequirements: [],
    sponsorshipInformation: null,
    internshipTerm: null,
    internshipYear: null,
    duration: null,
    salary: null,
    postingDate: listing.postedAt || null,
    deadline: null,
    categories: [category],
    relevanceScore: 100,
    relevanceReason: `Useno curated ${listing.category} tab listing with verified Canada/U.S. location evidence.`,
    lifecycleStatus: "NEW",
    availabilityStatus: "open",
    discoveredAt: now,
    lastVerifiedAt: now,
  });
  return { internship, contentHash: internshipContentHash(internship) };
}

export function sourceStatus(rootSucceeded: boolean, jobCount: number, failures: FetchFailure[]): SourceStatus {
  if (jobCount > 0 && rootSucceeded && failures.length === 0) return "success";
  const failureType = failures[0]?.errorType;
  if (failureType === "robots_disallowed") return rootSucceeded && jobCount > 0 ? "partial" : "robots_disallowed";
  if (failureType === "access_denied") return "access_denied";
  if (failureType === "rate_limited") return "rate_limited";
  if (failureType === "authentication_required") return "authentication_required";
  if (failureType === "browser_error" || failureType === "navigation_error" || failureType === "page_timeout") return jobCount > 0 ? "partial" : "browser_error";
  if (jobCount === 0 && rootSucceeded) return "no_internships_found";
  if (jobCount > 0) return "partial";
  return "source_unavailable";
}

/** Failure classes safe to retry on a later crawl. Permanent policy/access
 * denials and missing/closed pages must not poison indexed listing state. */
export function isRetryableFailure(failure: Pick<FetchFailure, "errorType" | "statusCode">): boolean {
  const errorType = failure.errorType.toLocaleLowerCase();
  if (["robots_disallowed", "access_denied", "authentication_required", "not_found", "closed", "source_unavailable"].includes(errorType)) return false;
  if (failure.statusCode === 404 || failure.statusCode === 401 || failure.statusCode === 403) return false;
  return [
    "http_error",
    "network_error",
    "timeout",
    "rate_limited",
    "page_timeout",
    "navigation_error",
    "browser_error",
    "circuit_open",
    "unexpected_error",
    "parse_error",
  ].includes(errorType);
}

/** Run every source to settlement so one rejection cannot abort sibling work. */
export async function settleSourceTasks<T>(
  tasks: Array<() => Promise<T>>,
  concurrency = tasks.length,
): Promise<PromiseSettledResult<T>[]> {
  const results: Array<PromiseSettledResult<T>> = Array.from({ length: tasks.length });
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      try {
        results[index] = { status: "fulfilled", value: await tasks[index]!() };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, tasks.length || 1)) }, () => worker()));
  return results;
}

interface SourceProgressSnapshot {
  pagesVisited: number;
  potentialPostingsInspected: number;
  internshipsDiscovered: number;
  completed: boolean;
  cacheHits?: number;
  unchangedSkips?: number;
  detailPagesFetched?: number;
  newListings?: number;
  changedListings?: number;
  duplicateListingsSkipped?: number;
  irrelevantListingsSkipped?: number;
}

type SourceProgressCallback = (progress: SourceProgressSnapshot) => Promise<void> | void;

/** Optional persistence hooks keep the crawler usable without SQLite while
 * allowing scout to route all writes through its single database writer. */
export interface CrawlPersistence {
  runId?: number;
  signal?: AbortSignal;
  classifyListing?: (source: string, hint: ListingIdentityHint) => CrawlStateDecision;
  /** Bulk cache for structured Jobright records; avoids one SQLite join per record. */
  getJobrightDestinations?: (source: string) => Map<string, string>;
  recordLightweightSightings?: (runId: number, sightings: LightweightSighting[]) => Promise<void> | void;
  recordCrawlMetrics?: (runId: number, metrics: CrawlMetrics) => Promise<void> | void;
  recordSourceStart?: (source: string, startedAt: string) => Promise<void> | void;
  recordSourceFetch?: (source: string, patch: {
    adapter?: string | null;
    requiresJs?: boolean;
    success?: boolean;
    latencyMs?: number | null;
    status?: string | null;
    httpStatus?: number | null;
    error?: string | null;
    metadata?: Record<string, unknown>;
  }) => Promise<void> | void;
  getSourceStrategy?: (source: string) => SourceStrategyState | null;
}

interface CrawlMetricsCounters extends CrawlMetrics {
  sources?: number;
}

function metricDelta(current: { httpRequests: number; cacheHits: number }, start: { httpRequests: number; cacheHits: number }): { httpRequests: number; cacheHits: number } {
  return {
    httpRequests: Math.max(0, current.httpRequests - start.httpRequests),
    cacheHits: Math.max(0, current.cacheHits - start.cacheHits),
  };
}

function uniqueUrls(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function sourceAdapterStatusCode(result: SourceAdapterResult): number | null {
  if (result.httpStatus !== null) return result.httpStatus;
  const failureStatus = result.failures.find(({ statusCode }) => statusCode !== null)?.statusCode;
  if (failureStatus !== undefined && failureStatus !== null) return failureStatus;
  const statusMatch = result.notes.join(" ").match(/\bHTTP\s+([1-5]\d{2})\b/i);
  return statusMatch ? Number(statusMatch[1]) : null;
}

function sourceAdapterAccessDenied(result: SourceAdapterResult): boolean {
  const statusCode = sourceAdapterStatusCode(result);
  return statusCode === 401
    || statusCode === 403
    || result.failures.some(({ errorType, message }) => errorType.toLocaleLowerCase() === "access_denied"
      || /\bHTTP\s+(?:401|403)\b|access denied|access_denied/i.test(message))
    || result.notes.some((note) => /\bHTTP\s+(?:401|403)\b|access denied|access_denied/i.test(note));
}

function externalLinkAllowed(
  link: LinkCandidate,
  score: number,
  sourceUrl: string,
  currentUrl: string,
  approvedHosts: Set<string>,
  depth: number,
): boolean {
  const candidateHost = hostname(link.url);
  if (approvedHosts.has(candidateHost) || sameSite(currentUrl, link.url) || sameSite(sourceUrl, link.url)) return true;
  if (isAtsUrl(link.url) && score >= 10) return true;
  if (isGithubUrl(currentUrl) && looksLikeRecruitingLink(link) && score >= 15) return true;
  return depth <= 2 && score >= 60 && looksLikeRecruitingLink(link);
}

export class InternshipCrawler {
  private readonly browser: BrowserManager;
  private readonly robots: RobotsManager;
  private readonly http: HttpClient;
  private readonly github: GitHubSourceAdapter;
  private readonly staticAdapters: StaticHttpAdapter;
  private readonly adapterRouter: SourceAdapterRouter;
  private readonly profiler: Profiler;
  private readonly grindJobBoardClient: GrindJobBoardClient;

  public constructor(
    private readonly settings: ScoutSettings,
    private readonly logger: Logger,
    dependencies: { grindJobBoardClient?: GrindJobBoardClient } = {},
    private readonly cancellationSignal?: AbortSignal,
  ) {
    this.profiler = new Profiler();
    this.http = new HttpClient(settings, logger, this.profiler, cancellationSignal);
    this.browser = new BrowserManager(settings, logger, undefined, this.profiler, cancellationSignal);
    this.robots = new RobotsManager(settings.userAgent, settings.timeoutMs, logger, this.http, this.profiler);
    this.http.attachRobotsPolicy((url) => this.robots.check(url));
    this.github = new GitHubSourceAdapter(logger, this.http);
    this.staticAdapters = new StaticHttpAdapter(settings, logger, this.http, async (url) => {
      if (!settings.respectRobotsTxt) return { allowed: true, crawlDelayMs: null };
      return this.robots.check(url);
    });
    this.adapterRouter = new SourceAdapterRouter(settings, logger, this.http);
    this.grindJobBoardClient = dependencies.grindJobBoardClient ?? new GrindJobBoardClient({
      cachePath: join(settings.outputDirectory, "source-cache", "grind-job-board.json"),
      concurrency: Math.min(8, settings.httpConcurrency),
      requestTimeoutMs: Math.min(settings.timeoutMs, 15_000),
      retryCount: settings.retryCount,
      ...(cancellationSignal ? { cancellationSignal } : {}),
    });
  }

  public cancel(): void {
    this.browser.cancel();
  }

  public async crawl(
    sources: string[],
    knownUrlsBySource: Map<string, string[]> = new Map(),
    onSourceResult?: (result: SourceCrawlResult) => Promise<void> | void,
    onProgress?: (progress: CrawlProgress) => Promise<void> | void,
    persistence?: CrawlPersistence,
  ): Promise<CrawlResult> {
    const crawlStartedAt = performance.now();
    this.profiler.reset();
    this.throwIfCancelled(persistence);
    const results: Array<SourceCrawlResult | undefined> = Array.from({ length: sources.length });
    const sourceProgress = new Map<string, SourceProgressSnapshot>();
    const emitProgress = async (sourceUrl: string, progress: SourceProgressSnapshot): Promise<void> => {
      sourceProgress.set(sourceUrl, progress);
      if (!onProgress) return;
      try {
        const snapshots = [...sourceProgress.values()];
        await onProgress({
          sourcesSettled: results.filter((result): result is SourceCrawlResult => result !== undefined).length,
          sourcesCompleted: snapshots.filter(({ completed }) => completed).length,
          pagesVisited: snapshots.reduce((total, snapshot) => total + snapshot.pagesVisited, 0),
          potentialPostingsInspected: snapshots.reduce((total, snapshot) => total + snapshot.potentialPostingsInspected, 0),
          internshipsDiscovered: snapshots.reduce((total, snapshot) => total + snapshot.internshipsDiscovered, 0),
          cacheHits: snapshots.reduce((total, snapshot) => total + (snapshot.cacheHits ?? 0), 0),
          unchangedSkips: snapshots.reduce((total, snapshot) => total + (snapshot.unchangedSkips ?? 0), 0),
          detailPagesFetched: snapshots.reduce((total, snapshot) => total + (snapshot.detailPagesFetched ?? 0), 0),
          newListings: snapshots.reduce((total, snapshot) => total + (snapshot.newListings ?? 0), 0),
          changedListings: snapshots.reduce((total, snapshot) => total + (snapshot.changedListings ?? 0), 0),
          duplicateListingsSkipped: snapshots.reduce((total, snapshot) => total + (snapshot.duplicateListingsSkipped ?? 0), 0),
          irrelevantListingsSkipped: snapshots.reduce((total, snapshot) => total + (snapshot.irrelevantListingsSkipped ?? 0), 0),
        });
      } catch (error) {
        this.logger.warn("PROGRESS", `Could not update crawl progress: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      const deferredRetries: Array<{ source: string; index: number }> = [];
      const settleSourceResult = async (
        canonicalSource: string,
        index: number,
        result: SourceCrawlResult,
        sourceStartedAt: number,
        sourceStartedAtIso: string,
        isAttemptActive: () => boolean = () => true,
      ): Promise<void> => {
        // A timed-out attempt may still resolve after its caller has moved on
        // to the retry pass. Never let that late result overwrite the retry.
        if (!isAttemptActive()) return;
        const durationMs = Math.max(0, Math.round(performance.now() - sourceStartedAt));
        const settled = { ...result, jobsDiscovered: result.jobsDiscovered ?? result.jobs.length, startedAt: sourceStartedAtIso, durationMs };
        const discoveredJobCount = settled.jobsDiscovered;
        this.logger.info("SOURCE", `Finished ${redactSensitiveUrl(canonicalSource)} in ${durationMs} ms (${settled.pagesVisited} pages, ${discoveredJobCount} roles)`);
        results[index] = settled;
        const finalMetrics = settled.metrics ?? {};
        const previousProgress = sourceProgress.get(canonicalSource);
        const completionCacheHits = finalMetrics.cacheHits ?? previousProgress?.cacheHits;
        const completionUnchangedSkips = finalMetrics.unchangedSkips ?? previousProgress?.unchangedSkips;
        const completionDetailPagesFetched = finalMetrics.detailPagesFetched ?? previousProgress?.detailPagesFetched;
        const completionNewListings = finalMetrics.newListings ?? previousProgress?.newListings;
        const completionChangedListings = finalMetrics.changedListings ?? previousProgress?.changedListings;
        const completionDuplicateListingsSkipped = finalMetrics.duplicateListingsSkipped ?? previousProgress?.duplicateListingsSkipped;
        const completionIrrelevantListingsSkipped = finalMetrics.irrelevantListingsSkipped ?? previousProgress?.irrelevantListingsSkipped;
        await emitProgress(canonicalSource, {
          pagesVisited: settled.pagesVisited,
          potentialPostingsInspected: settled.potentialPostingsInspected,
          internshipsDiscovered: discoveredJobCount,
          completed: settled.completed,
          ...(completionCacheHits === undefined ? {} : { cacheHits: completionCacheHits }),
          ...(completionUnchangedSkips === undefined ? {} : { unchangedSkips: completionUnchangedSkips }),
          ...(completionDetailPagesFetched === undefined ? {} : { detailPagesFetched: completionDetailPagesFetched }),
          ...(completionNewListings === undefined ? {} : { newListings: completionNewListings }),
          ...(completionChangedListings === undefined ? {} : { changedListings: completionChangedListings }),
          ...(completionDuplicateListingsSkipped === undefined ? {} : { duplicateListingsSkipped: completionDuplicateListingsSkipped }),
          ...(completionIrrelevantListingsSkipped === undefined ? {} : { irrelevantListingsSkipped: completionIrrelevantListingsSkipped }),
        });
        let incrementallyPersisted = false;
        if (onSourceResult && isAttemptActive()) {
          try {
            const persistStartedAt = performance.now();
            await onSourceResult(settled);
            incrementallyPersisted = true;
            this.profiler.recordSpan("database", performance.now() - persistStartedAt, { source: canonicalSource });
          } catch (error) {
            this.propagateIfAbort(error, persistence);
            this.logger.error("PERSIST", `Could not persist ${redactSensitiveUrl(canonicalSource)} incrementally: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
        // The source is durable before this point. Release its analyzed job
        // payload from the aggregate result; retaining every source's full
        // graph until the final transaction was the main driver of worker
        // heap growth on broad runs. If the callback failed, retain the jobs
        // so the final persistRun fallback can still recover them.
        if (incrementallyPersisted && persistence?.runId !== undefined) {
          results[index] = { ...settled, jobs: [] };
        }
      };
      const sourceTask = (source: string, index: number, options: SourceTaskOptions = {}): (() => Promise<void>) => async () => {
        this.throwIfCancelled(persistence);
        const sourceStartedAt = performance.now();
        const sourceStartedAtIso = new Date().toISOString();
        const canonicalSource = canonicalizeUrl(source);
        const sourceSpan = this.profiler.startSpan("total", { source: canonicalSource, url: canonicalSource });
        const sourceAbort = new AbortController();
        let attemptActive = true;
        let timedOut = false;
        const maxDurationMs = options.maxDurationMs ?? options.stallMs;
        let watchdogTimer: ReturnType<typeof setInterval> | null = null;
        let lastProgressAt = Date.now();
        const abortForTimeout = (message: string, durationMs: number): SourceStalledError => {
          const error = new SourceStalledError(canonicalSource, durationMs, message);
          timedOut = true;
          attemptActive = false;
          if (!sourceAbort.signal.aborted) sourceAbort.abort(error);
          // Closing only this source's browser context releases protocol calls
          // that do not react promptly to AbortSignal. HTTP work receives the
          // same source signal through HttpClient.activeSignal().
          this.browser.cancelSource(canonicalSource);
          return error;
        };
        const timeoutPromise = maxDurationMs !== undefined && maxDurationMs > 0
          ? new Promise<never>((_resolve, reject) => {
            // This is an inactivity watchdog, not a total source deadline.
            // Healthy sources can legitimately take longer than five minutes
            // when they continue reporting page/detail progress.
            watchdogTimer = setInterval(() => {
              if (!attemptActive || sourceAbort.signal.aborted || Date.now() - lastProgressAt < maxDurationMs) return;
              reject(abortForTimeout(
                `Source ${canonicalSource} stalled for ${maxDurationMs}ms without progress.`,
                maxDurationMs,
              ));
            }, Math.min(1_000, Math.max(10, Math.floor(maxDurationMs / 4))));
          })
          : null;
        try {
          const sourceWork = runWithSourceAbortSignal(sourceAbort.signal, async () => {
            let result: SourceCrawlResult;
            try {
              if (persistence?.recordSourceStart) await persistence.recordSourceStart(canonicalSource, sourceStartedAtIso);
              result = await this.crawlSource(
                canonicalSource,
                knownUrlsBySource.get(canonicalSource) ?? [],
                (progress) => {
                  if (!attemptActive) return;
                  lastProgressAt = Date.now();
                  return emitProgress(canonicalSource, progress);
                },
                persistence,
              );
            } catch (error) {
              if (isSourceStalledError(error)) throw error;
              this.propagateIfAbort(error, persistence);
              result = this.unexpectedSourceFailure(canonicalSource, error);
            }
            this.throwIfCancelled(persistence);
            if (!attemptActive) return;
            sourceSpan.end({ durationMs: Math.max(0, performance.now() - sourceStartedAt), status: result.completed ? "ok" : "error" });
            await settleSourceResult(canonicalSource, index, result, sourceStartedAt, sourceStartedAtIso, () => attemptActive);
          });
          // A source adapter is allowed to have a misbehaving third-party
          // promise. Attach a rejection handler immediately so detaching it at
          // the deadline cannot create an unhandled rejection.
          void sourceWork.catch(() => undefined);
          await (timeoutPromise ? Promise.race([sourceWork, timeoutPromise]) : sourceWork);
        } catch (error) {
          if (isSourceStalledError(error)) {
            const note = options.retryOnStall
              ? `Exceeded the ${error.stallMs}ms source budget; skipping now and retrying at the end.`
              : `Exceeded the ${error.stallMs}ms retry budget; recording the source as unavailable and continuing.`;
            this.logger.warn("SOURCE", `${redactSensitiveUrl(canonicalSource)}: ${note}`);
            sourceSpan.end({ durationMs: Math.max(0, performance.now() - sourceStartedAt), status: "error" });
            if (options.retryOnStall) {
              deferredRetries.push({ source, index });
              return;
            }
            await settleSourceResult(
              canonicalSource,
              index,
              this.stalledSourceFailure(canonicalSource, error),
              sourceStartedAt,
              sourceStartedAtIso,
            );
            return;
          }
          this.propagateIfAbort(error, persistence);
          throw error;
        } finally {
          attemptActive = false;
          if (watchdogTimer) clearInterval(watchdogTimer);
          if (!timedOut) {
            try {
              await this.browser.releaseSource(canonicalSource);
            } catch (error) {
              this.logger.debug("BROWSER", `Could not release ${redactSensitiveUrl(canonicalSource)} context: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      };
      // Structured Intern List feeds are complete API snapshots and should not
      // compete with browser-heavy sources for the event loop or HTTP lane.
      // Finish them first; the small phase boundary adds only their retrieval
      // time while preventing a large rendering source from making an API
      // source appear to hang or hit a page deadline.
      const sourceEntries = sources.map((source, index) => ({ source, index }));
      const internListEntries = sourceEntries.filter(({ source }) => internListFeeds(source).length > 0);
      // CSJobs and HiringCafe sit behind shared edges and time out when they
      // compete with the broad multi-source HTTP lane. Isolate each so a large
      // feed cannot make the listing/sitemap request look dead.
      const csJobsEntries = sourceEntries.filter(({ source }) => isCsJobsTorontoSource(source));
      const hiringCafeEntries = sourceEntries.filter(({ source }) => isHiringCafeSource(source));
      const remainingEntries = sourceEntries.filter(({ source }) => internListFeeds(source).length === 0 && !isCsJobsTorontoSource(source) && !isHiringCafeSource(source));
      // Every phase gets the same inactivity budget. A source that keeps
      // emitting progress is allowed to finish, while a source that stops
      // producing work is isolated and retried at the end.
      const runPhase = async (
        entries: Array<{ source: string; index: number }>,
      ): Promise<void> => {
        if (entries.length === 0) return;
        const tasks = entries.map(({ source, index }) => sourceTask(source, index, {
          maxDurationMs: configuredSourceStallMs(),
          retryOnStall: true,
        }));
        // Incremental persistence is a backpressure boundary. Keep only a
        // small number of complete source payloads in flight while the single
        // SQLite writer drains them; otherwise a broad phase can retain many
        // thousands of analyzed jobs waiting in the writer queue.
        const sourceConcurrency = persistence?.runId !== undefined && onSourceResult ? 2 : tasks.length;
        await settleSourceTasks(tasks, sourceConcurrency);
      };
      for (const entries of [internListEntries, csJobsEntries, hiringCafeEntries, remainingEntries]) {
        await runPhase(entries);
      }
      if (deferredRetries.length > 0) {
        this.logger.info("SOURCE", `Retrying ${deferredRetries.length} deferred source(s) at the end of the crawl`);
        const retryTasks = deferredRetries.map(({ source, index }) => sourceTask(source, index, {
          // Four sequential phases can otherwise spend 5m + 15m on each
          // phase and hit the run deadline before healthy sources settle.
          maxDurationMs: Math.min(configuredSourceRetryStallMs(), configuredSourceStallMs()),
          retryOnStall: false,
        }));
        await settleSourceTasks(retryTasks, persistence?.runId !== undefined && onSourceResult ? 2 : retryTasks.length);
      }
    } finally {
      await this.browser.close();
    }
    this.throwIfCancelled(persistence);
    const settledResults = results.filter((result): result is SourceCrawlResult => result !== undefined);
    const metrics: CrawlMetricsCounters = {};
    for (const result of settledResults) {
      for (const [key, value] of Object.entries(result.metrics ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) metrics[key] = (metrics[key] ?? 0) + value;
      }
    }
    metrics.httpRequests = Math.max(metrics.httpRequests ?? 0, this.http.metrics.httpRequests);
    metrics.cacheHits = Math.max(metrics.cacheHits ?? 0, this.http.metrics.cacheHits);
    metrics.browserNavigations = Math.max(metrics.browserNavigations ?? 0, this.browser.navigations);
    const runtimeMs = Math.max(0, Math.round(performance.now() - crawlStartedAt));
    this.profiler.increment("urlsFetched", metrics.httpRequests ?? 0);
    this.profiler.increment("httpRequests", metrics.httpRequests ?? 0);
    this.profiler.increment("cacheHits", metrics.cacheHits ?? 0);
    this.profiler.increment("unchangedSkips", metrics.unchangedSkips ?? 0);
    this.profiler.increment("duplicates", metrics.duplicateListingsSkipped ?? 0);
    this.profiler.increment("irrelevant", metrics.irrelevantListingsSkipped ?? 0);
    this.profiler.increment("detailPages", metrics.detailPagesFetched ?? 0);
    this.profiler.increment("browserNavigations", metrics.browserNavigations ?? 0);
    this.profiler.increment("failedSources", settledResults.filter(({ completed }) => !completed).length);
    this.profiler.recordSpan("total", runtimeMs);
    if (persistence?.runId !== undefined && persistence.recordCrawlMetrics) {
      this.throwIfCancelled(persistence);
      // Listing disposition counters are persisted by the lightweight
      // sighting transaction; persist only transport/coverage totals here so
      // they are not counted twice.
      const persistedMetrics: CrawlMetrics = {
        httpRequests: metrics.httpRequests,
        browserNavigations: metrics.browserNavigations,
        // Transport cache hits are owned here; validator/identity cache hits
        // are emitted by recordLightweightSightings and therefore must not be
        // added again from the aggregate CrawlResult.
        cacheHits: this.http.metrics.cacheHits,
        ...(metrics.newListings !== undefined ? { newListings: metrics.newListings } : {}),
        ...(metrics.changedListings !== undefined ? { changedListings: metrics.changedListings } : {}),
        ...(metrics.retryableFailures !== undefined ? { retryableFailures: metrics.retryableFailures } : {}),
        ...(metrics.detailPagesFetched !== undefined ? { detailPagesFetched: metrics.detailPagesFetched } : {}),
        ...(metrics.duplicateListingsSkipped !== undefined ? { duplicateListingsSkipped: metrics.duplicateListingsSkipped } : {}),
        ...(metrics.irrelevantListingsSkipped !== undefined ? { irrelevantListingsSkipped: metrics.irrelevantListingsSkipped } : {}),
        runtimeMs,
      };
      await persistence.recordCrawlMetrics(persistence.runId, persistedMetrics);
    }
    const finalJobs = this.deduplicateJobsWithProfile(settledResults.flatMap(({ jobs }) => jobs));
    const jobsDiscovered = settledResults.reduce((total, result) => total + (result.jobsDiscovered ?? result.jobs.length), 0);
    this.profiler.increment("successfulJobs", finalJobs.length);
    return {
      sourcesRequested: sources.length,
      sourcesCompleted: settledResults.filter(({ completed }) => completed).length,
      sourcesSuccessful: settledResults.filter(({ status }) => status === "success").length,
      sourcesPartiallyCompleted: settledResults.filter(({ status }) => status === "partial").length,
      sourcesFailed: settledResults.filter(({ completed }) => !completed).length,
      pagesVisited: settledResults.reduce((total, result) => total + result.pagesVisited, 0),
      potentialPostingsInspected: settledResults.reduce((total, result) => total + result.potentialPostingsInspected, 0),
      jobsDiscovered,
      jobs: finalJobs,
      failures: settledResults.flatMap(({ failures }) => failures),
      closedPages: settledResults.flatMap(({ closedPages }) => closedPages),
      completedSourceUrls: settledResults.filter(({ coverageComplete }) => coverageComplete).map(({ sourceUrl }) => sourceUrl),
      sourceResults: settledResults,
      runtimeMs,
      metrics,
      profiling: this.profiler.finish(),
    };
  }

  private isCancelled(persistence?: CrawlPersistence): boolean {
    return Boolean(persistence?.signal?.aborted || this.cancellationSignal?.aborted);
  }

  private propagateIfAbort(error: unknown, persistence?: CrawlPersistence): void {
    if (isSourceStalledError(error)) throw error;
    if (this.isCancelled(persistence)) throw cancellationError(persistence?.signal?.reason ?? this.cancellationSignal?.reason);
  }

  private throwIfCancelled(persistence?: CrawlPersistence): void {
    throwIfAborted(persistence?.signal ?? this.cancellationSignal);
    throwIfAborted(currentSourceAbortSignal());
  }

  private async crawlSource(sourceUrl: string, knownUrls: string[], onProgress?: SourceProgressCallback, persistence?: CrawlPersistence): Promise<SourceCrawlResult> {
    this.throwIfCancelled(persistence);
    this.logger.info("SOURCE", `Scanning ${redactSensitiveUrl(sourceUrl)}`);
    if (isGrindJobBoardSource(sourceUrl)) return this.crawlGrindJobBoardSource(sourceUrl, onProgress, persistence);
    if (isUsenoInternshipMasterlistUrl(sourceUrl)) return this.crawlUsenoMasterlistSource(sourceUrl, onProgress, persistence);
    if (isUsenoSummer2027Url(sourceUrl)) return this.crawlUsenoSource(sourceUrl, onProgress, persistence);
    if (this.github.canHandle(sourceUrl)) {
      const robots = this.settings.respectRobotsTxt ? await this.robots.check(sourceUrl) : { allowed: true, crawlDelayMs: null };
      if (!robots.allowed) return this.robotsDisallowedSource(sourceUrl);
      return this.crawlGithubSource(sourceUrl, onProgress, persistence);
    }
    const staticProfile = this.staticAdapters.profile(sourceUrl);
    if (staticProfile) {
      const robots = this.settings.respectRobotsTxt
        ? await this.robots.check(sourceUrl)
        : { allowed: true, crawlDelayMs: null };
      if (robots.allowed) return this.crawlStaticSource(sourceUrl, robots.crawlDelayMs, onProgress, persistence);
      // Static profiles have no declared alternate transport here; do not
      // silently route a denied root through the generic adapter.
      this.logger.warn("ROBOTS", `Configured ${redactSensitiveUrl(sourceUrl)} is disallowed; no static alternate was attempted.`);
      return this.robotsDisallowedSource(sourceUrl);
    }
    const internListSource = internListFeeds(sourceUrl).length > 0;
    // The owner-authorized Early Career Radar route is a first-party public
    // feed whose own page calls /api/jobs even though robots.txt disallows
    // generic crawlers there. Its source-specific adapter is the explicit
    // exception; all other sources continue through the normal robots gate.
    if (!staticProfile && this.settings.respectRobotsTxt && !internListSource && !isEarlyCareerRadarSource(sourceUrl)) {
      const robots = await this.robots.check(sourceUrl);
      if (!robots.allowed) return this.robotsDisallowedSource(sourceUrl);
    }
    // Generic sources still get one direct HTTP/structured attempt before the
    // browser lane. A browser is reserved for an explicit JS shell or an
    // unusable HTTP response; this keeps HTTP-only runs from starting Chromium.
    const httpStartedAt = performance.now();
    const browserNavigationsStart = this.browser.navigations;
    const knownStrategy = persistence?.getSourceStrategy?.(sourceUrl) ?? null;
    // Early Career Radar has a public structured feed. Do not let an older
    // browser-required strategy record force the slow grouped UI path before
    // the feed adapter gets a chance to run.
    const knownJsRequired = Boolean(
      !internListSource
      && !isEarlyCareerRadarSource(sourceUrl)
      && knownStrategy?.requiresJs
      && knownStrategy.lastSuccessAt
      && Date.now() - Date.parse(knownStrategy.lastSuccessAt) <= this.settings.cacheTtlMs,
    );
    let adapterResult: Awaited<ReturnType<SourceAdapterRouter["collect"]>> | null = null;
    try {
      // The Intern List page delegates its visible table to the public
      // Jobright API. Its HTML shell is disallowed by intern-list.com's
      // robots.txt, so check the actual structured feed origin and avoid
      // fetching the blocked shell. Other configured sources retain the normal
      // root robots gate above.
      if (internListSource && this.settings.respectRobotsTxt) {
        const apiRobots = await this.robots.check(INTERN_LIST_API_URL);
        if (!apiRobots.allowed) return this.robotsDisallowedSource(sourceUrl);
      }
      if (knownJsRequired) {
        this.logger.debug("STRATEGY", `Reusing persisted browser strategy for ${redactSensitiveUrl(sourceUrl)}.`);
      } else {
        adapterResult = await this.adapterRouter.collect(sourceUrl);
        this.throwIfCancelled(persistence);
        const terminalAdapterFailure = (internListSource && adapterResult.snapshots.length === 0 && adapterResult.failures.length > 0)
          || (isEarlyCareerRadarSource(sourceUrl) && adapterResult.snapshots.length === 0 && sourceAdapterAccessDenied(adapterResult));
        if (terminalAdapterFailure) {
          const runtimeMs = Math.max(0, Math.round(performance.now() - httpStartedAt));
          const result = this.structuredAdapterUnavailableSource(sourceUrl, adapterResult, runtimeMs);
          await this.recordStrategy(persistence, sourceUrl, {
            adapter: this.adapterName(adapterResult),
            requiresJs: false,
            success: false,
            latencyMs: runtimeMs,
            status: result.status ?? "source_unavailable",
            httpStatus: result.httpStatus ?? null,
            error: adapterResult.notes.join(" ") || null,
          });
          await onProgress?.({ pagesVisited: 0, potentialPostingsInspected: 0, internshipsDiscovered: 0, completed: false });
          return result;
        }
        const hasJobEvidence = adapterResult.snapshots.some((snapshot) => {
          const text = snapshot.text.replace(/\s+/gu, " ").trim();
          return /(?:intern|internship|co-?op|software engineer|developer|job description|apply now|requisition)/iu.test(text)
            || snapshot.links.some((link) => scoreLink(link, sourceUrl).score >= 18);
        });
        const httpUsable = adapterResult.snapshots.length > 0
          && adapterResult.strategy !== "browser_required"
          && hasJobEvidence;
        if (httpUsable) {
          let effectiveAdapterResult = adapterResult;
          const hasDynamicListingControl = adapterResult.snapshots.some((snapshot) => /\b(?:load|show|view)\s+more(?:\s+jobs?|\s+positions?)?|view all jobs?\b/i.test(snapshot.text));
          if (hasDynamicListingControl) {
            // Preserve dynamic load-more coverage without converting every
            // detail request to browser work: render the listing once, merge
            // discovered links, then keep the detail lane on shared HTTP.
            const dynamicSnapshot = await this.browser.fetchPage(sourceUrl, null, sourceUrl);
            effectiveAdapterResult = {
              ...adapterResult,
              snapshots: [...adapterResult.snapshots, dynamicSnapshot],
              retrievalUrls: uniqueUrls([...adapterResult.retrievalUrls, dynamicSnapshot.url]),
              retrievalMethod: `${adapterResult.retrievalMethod}; browser listing expansion`,
              attempts: adapterResult.attempts + (dynamicSnapshot.attempts ?? 1),
            };
          }
          const result = await this.crawlHttpSource(sourceUrl, effectiveAdapterResult, onProgress, persistence);
          await this.recordStrategy(persistence, sourceUrl, {
            adapter: this.adapterName(adapterResult),
            requiresJs: false,
            success: result.completed,
            latencyMs: Math.round(performance.now() - httpStartedAt),
            status: result.status ?? null,
            httpStatus: result.httpStatus ?? null,
          });
          return result;
        }
      }
    } catch (error) {
      this.propagateIfAbort(error, persistence);
      if (isEarlyCareerRadarSource(sourceUrl) && error instanceof HttpRequestError && error.statusCode === 403) {
        const runtimeMs = Math.max(0, Math.round(performance.now() - httpStartedAt));
        const result = this.restrictedHttpSource(sourceUrl, error);
        await this.recordStrategy(persistence, sourceUrl, {
          adapter: adapterResult ? this.adapterName(adapterResult) : "Early Career Radar",
          requiresJs: false,
          success: false,
          latencyMs: runtimeMs,
          status: result.status ?? "access_denied",
          httpStatus: result.httpStatus ?? 403,
          error: error.message,
        });
        await onProgress?.({ pagesVisited: 0, potentialPostingsInspected: 0, internshipsDiscovered: 0, completed: false });
        return result;
      }
      this.logger.warn("HTTP", `HTTP-first retrieval failed for ${redactSensitiveUrl(sourceUrl)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.throwIfCancelled(persistence);
    await this.recordStrategy(persistence, sourceUrl, {
      adapter: adapterResult ? this.adapterName(adapterResult) : null,
      requiresJs: true,
      success: false,
      latencyMs: Math.round(performance.now() - httpStartedAt),
      status: "browser_required",
      httpStatus: adapterResult?.httpStatus ?? null,
      error: adapterResult?.notes.join(" ") || null,
    });
    const pageLimit = isEarlyCareerRadarSource(sourceUrl)
      ? Math.min(this.settings.maxPagesPerSource, EARLY_CAREER_RADAR_BROWSER_PAGE_CAP)
      : Math.max(this.settings.maxPagesPerSource, largeListingSourcePageFloor(sourceUrl) ?? 0);
    const queue = new PriorityQueue();
    const visited = new Set<string>();
    const enqueued = new Set<string>();
    const skippedKnownUrls = new Set<string>();
    const approvedHosts = new Set<string>([hostname(sourceUrl)]);
    const jobs: AnalyzedJob[] = [];
    const failures: FetchFailure[] = [];
    const closedPages: ClosedPage[] = [];
    const browserSightings: LightweightSighting[] = [];
    let browserUnchangedSkips = 0;
    let browserCacheHits = 0;
    let browserDetailPagesFetched = 0;
    let pagesVisited = 0;
    let potentialPostingsInspected = 0;
    let rawListingsObserved = 0;
    let rawListingLimitReported = false;
    let candidateLimitReported = false;
    let rootSucceeded = false;
    let retrievalMode: "configured_url" | "public_alternate" = "configured_url";
    let retrievalUrls = [sourceUrl];
    const coverageNotes: string[] = [];
    const preloadedJobrightDestinations = persistence?.getJobrightDestinations?.(sourceUrl) ?? null;
    const knownJobrightDestinations = new Map<string, string | null>();

    const add = (item: CrawlQueueItem): void => {
      if (enqueued.size >= pageLimit * 20 || enqueued.has(item.url)) return;
      enqueued.add(item.url);
      approvedHosts.add(hostname(item.url));
      queue.push(item);
      this.profiler.increment("urlsDiscovered");
    };
    const fallbacks = publicSourceFallbacks(sourceUrl);
    const allowedFallbacks = [];
    for (const fallback of fallbacks) {
      const fallbackRobots = this.settings.respectRobotsTxt
        ? await this.robots.check(fallback.url)
        : { allowed: true, crawlDelayMs: null };
      if (fallbackRobots.allowed) allowedFallbacks.push(fallback);
    }
    let initialUrl = sourceUrl;
    if (allowedFallbacks.length > 0) {
      initialUrl = allowedFallbacks[0]?.url ?? sourceUrl;
      if (allowedFallbacks.length === 1) {
        retrievalMode = "public_alternate";
        retrievalUrls = allowedFallbacks.map(({ url }) => url);
        coverageNotes.push(`Retrieved through ${allowedFallbacks[0]?.reason}: ${initialUrl}`);
        coverageNotes.push(`The configured URL was not fetched when the public alternate was selected; robots.txt remains enforced.`);
        add({
          url: initialUrl,
          sourceUrl,
          referrerUrl: null,
          depth: 0,
          priority: 1_000,
          reason: "public alternate",
        });
      } else {
        retrievalMode = "public_alternate";
        retrievalUrls = allowedFallbacks.map(({ url }) => url);
        coverageNotes.push(`Retrieved through ${allowedFallbacks.map(({ reason, url }) => `${reason}: ${url}`).join("; ")}`);
        coverageNotes.push(`The configured URL was not fetched when public alternates were selected; robots.txt remains enforced.`);
        for (const [index, fallback] of allowedFallbacks.entries()) {
          add({
            url: fallback.url,
            sourceUrl,
            referrerUrl: null,
            depth: 0,
            priority: 1_000 - index,
            reason: "public alternate",
          });
        }
      }
    } else {
      if (fallbacks.length > 0) coverageNotes.push(`No public alternate passed robots.txt; the configured URL was attempted.`);
      add({ url: initialUrl, sourceUrl, referrerUrl: null, depth: 0, priority: 1_000, reason: "configured source" });
    }
    for (const knownUrl of knownUrls) {
      const canonical = safeCanonicalizeUrl(knownUrl);
      if (!canonical) continue;
      const hint: ListingIdentityHint = { canonicalUrl: canonical, postingUrl: canonical };
      const decision = persistence?.classifyListing?.(sourceUrl, hint);
      const requiresOriginalPost = isJobrightUrl(canonical);
      if (Boolean(persistence?.getJobrightDestinations) && requiresOriginalPost
        && !directApplicationOverride(canonical)
        && !preloadedJobrightDestinations?.has(canonical)) continue;
      const recentRecord = decision?.record
        && decision.record.availabilityStatus === "open"
        && decision.record.failureState === "none"
        && this.settings.detailRecheckTtlMs > 0
        && Date.now() - Date.parse(decision.record.lastCheckedAt) <= this.settings.detailRecheckTtlMs;
      if (!requiresOriginalPost && ((decision?.disposition === "unchanged" && decision.validatorsMatch) || recentRecord)) {
        if (decision?.record?.internship) jobs.push({ internship: { ...decision.record.internship, lifecycleStatus: "UNCHANGED" }, contentHash: decision.record.contentHash });
        browserUnchangedSkips += 1;
        if (decision?.validatorsMatch) browserCacheHits += 1;
        browserSightings.push({ sourceUrl, ...hint, state: "unchanged", observedOpen: true, provenance: { reason: recentRecord ? "recent_identity_recheck" : "validator_match" } });
        skippedKnownUrls.add(canonical);
        continue;
      }
      add({ url: canonical, sourceUrl, referrerUrl: sourceUrl, depth: 1, priority: 900, reason: "known job verification" });
    }

    while (queue.size > 0 && pagesVisited < pageLimit) {
      this.throwIfCancelled(persistence);
      const batch: CrawlQueueItem[] = [];
      while (batch.length < this.settings.browserConcurrency && pagesVisited + batch.length < pageLimit) {
        const item = queue.pop();
        if (!item) break;
        if (visited.has(item.url) || item.depth > this.settings.maxDepth) continue;
        visited.add(item.url);
        batch.push(item);
      }
      if (batch.length === 0) continue;
      pagesVisited += batch.length;
      await Promise.allSettled(batch.map(async (item) => {
        if (knownClosedAggregatorPosting(item.url)) {
          if (item.url === sourceUrl || retrievalUrls.includes(item.url)) rootSucceeded = true;
          const reason = "Original company posting removed";
          closedPages.push({ url: item.url, reason, statusCode: null });
          this.logger.info("CLOSED", `${redactSensitiveUrl(item.url)} — ${reason}`);
          return;
        }
        try {
          const robots = this.settings.respectRobotsTxt && !earlyCareerRadarOwnerUrl(sourceUrl, item.url)
            ? await this.robots.check(item.url)
            : { allowed: true, crawlDelayMs: null };
          if (!robots.allowed) {
            this.logger.warn("ROBOTS", `Skipped disallowed URL ${redactSensitiveUrl(item.url)}`);
            failures.push(this.failure(item, "robots_disallowed", "Disallowed by robots.txt", null, 0));
            return;
          }
          const snapshot = await this.browser.fetchPage(item.url, robots.crawlDelayMs, sourceUrl);
          if (item.depth > 0) browserDetailPagesFetched += 1;
          if (item.url === sourceUrl || retrievalUrls.includes(item.url)) rootSucceeded = true;
          this.logger.debug("PAGE", `${snapshot.status} attempt ${snapshot.attempts ?? 1} ${snapshot.browserContextId ?? ""} ${redactSensitiveUrl(snapshot.url)} (${snapshot.links.length} links)`);
          if (/\b(?:captcha|verify you are human|access denied|sign in to view this (?:job|page))\b/i.test(snapshot.text)) {
            throw new PageFetchError("Page is protected by a CAPTCHA, login wall, or access control", snapshot.status, 0, "access_controlled");
          }
          const closure = detectClosedPage(
            snapshot.text,
            snapshot.status,
            snapshot.url,
            item.reason === "known job verification",
            snapshot.html,
          );
          if (closure) {
            closedPages.push({ url: item.url, reason: closure, statusCode: snapshot.status });
            if (item.url !== snapshot.url) closedPages.push({ url: snapshot.url, reason: closure, statusCode: snapshot.status });
            this.logger.info("CLOSED", `${redactSensitiveUrl(snapshot.url)} — ${closure}`);
            return;
          }

          const rawJobs = extractJobs(snapshot);
          potentialPostingsInspected += rawJobs.length;
          rawListingsObserved += rawJobs.length;
          const rawJobBudget = Math.max(0, MAX_ACCEPTED_JOBS_PER_SOURCE - (rawListingsObserved - rawJobs.length));
          if (rawListingsObserved > MAX_ACCEPTED_JOBS_PER_SOURCE && !rawListingLimitReported) {
            failures.push(sourceLimitFailure(sourceUrl, snapshot.url, "Raw listings", rawListingsObserved));
            rawListingLimitReported = true;
          }
          for (const rawJob of rawJobs.slice(0, rawJobBudget)) {
            const knownJobrightDestination = this.cachedJobrightDestination(
              sourceUrl,
              rawJob,
              persistence,
              knownJobrightDestinations,
              preloadedJobrightDestinations,
            );
            const resolver = this.resolverForRawJob(
              rawJob,
              sourceUrl,
              (url: string) => this.browser.resolveApplicationUrl(url, sourceUrl),
              knownJobrightDestination,
              Boolean(persistence?.getJobrightDestinations),
            );
            const analyzed = await this.analyzeJobWithProfile(rawJob, sourceUrl, resolver, snapshot.fetchedAt);
            if (analyzed.accepted) {
              jobs.push(analyzed.value);
              this.logger.info("JOB", `${analyzed.value.internship.company} — ${analyzed.value.internship.title}`);
              if (analyzed.value.internship.applicationUrl !== analyzed.value.internship.postingUrl) {
                this.logger.debug("APPLY", `Resolved ${analyzed.value.internship.applicationUrl}`);
              }
            } else {
              if (analyzed.closedUrl) {
                closedPages.push({
                  url: analyzed.closedUrl,
                  reason: analyzed.reason,
                  statusCode: analyzed.closedStatusCode ?? null,
                });
                this.logger.info("CLOSED", `${redactSensitiveUrl(analyzed.closedUrl)} — ${analyzed.reason}`);
              }
              this.logger.debug("SKIP", `${analyzed.title}: ${analyzed.reason}`);
            }
          }

          if (item.depth >= this.settings.maxDepth) return;
          const publicBoardLinks = snapshot.links.length < MAX_ACCEPTED_JOBS_PER_SOURCE
            ? discoverPublicBoardLinks(snapshot)
            : [];
          const candidatePool = [
            ...snapshot.links.slice(0, MAX_ACCEPTED_JOBS_PER_SOURCE),
            ...publicBoardLinks.slice(0, Math.max(0, MAX_ACCEPTED_JOBS_PER_SOURCE - snapshot.links.length)),
          ];
          if (snapshot.links.length + publicBoardLinks.length > candidatePool.length && !candidateLimitReported) {
            failures.push(sourceLimitFailure(sourceUrl, snapshot.url, "Candidate links", snapshot.links.length + publicBoardLinks.length));
            candidateLimitReported = true;
          }
          const candidates = candidatePool
            .map((link) => {
              const url = safeCanonicalizeUrl(link.url, snapshot.url);
              if (!url) return null;
              const normalizedLink = { ...link, url };
              return { link: normalizedLink, ...scoreLink(normalizedLink, snapshot.url) };
            })
            .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
            .sort((left, right) => right.score - left.score);
          let relevantLinks = 0;
          for (const candidate of candidates) {
            if (candidate.score <= -1000 || visited.has(candidate.link.url) || enqueued.has(candidate.link.url) || skippedKnownUrls.has(candidate.link.url)) continue;
            if (Boolean(persistence?.getJobrightDestinations) && isJobrightJobUrl(candidate.link.url)
              && !directApplicationOverride(candidate.link.url)
              && !preloadedJobrightDestinations?.has(candidate.link.url)) continue;
            if (!externalLinkAllowed(candidate.link, candidate.score, sourceUrl, snapshot.url, approvedHosts, item.depth + 1)) continue;
            relevantLinks += 1;
            add({
              url: candidate.link.url,
              sourceUrl,
              referrerUrl: snapshot.url,
              depth: item.depth + 1,
              priority: candidate.score - item.depth * 3,
              reason: candidate.reason,
            });
          }
          this.logger.debug("PAGE", `Queued ${relevantLinks} relevant links from ${hostLabel(snapshot.url)}`);
        } catch (error) {
          this.propagateIfAbort(error, persistence);
          const fetchError = error instanceof PageFetchError
            ? error
            : new PageFetchError(error instanceof Error ? error.message : String(error), null, 0, "unexpected_error");
          failures.push(this.failure(item, fetchError.errorType, fetchError.message, fetchError.statusCode, fetchError.retryCount));
          this.logger.error("ERROR", `${redactSensitiveUrl(item.url)}: ${fetchError.message}`);
          if (item.url === sourceUrl || retrievalUrls.includes(item.url)) rootSucceeded = false;
        }
      }));
      this.throwIfCancelled(persistence);
      await onProgress?.({
        pagesVisited,
        potentialPostingsInspected,
        internshipsDiscovered: jobs.length,
        completed: false,
      });
    }
    if (persistence?.runId !== undefined && persistence.recordLightweightSightings && browserSightings.length > 0) {
      this.throwIfCancelled(persistence);
      await persistence.recordLightweightSightings(persistence.runId, browserSightings);
      this.throwIfCancelled(persistence);
    }
    const status = sourceStatus(rootSucceeded, jobs.length, failures);
    const browserMetrics: CrawlMetrics = {
      browserNavigations: Math.max(0, this.browser.navigations - browserNavigationsStart),
      detailPagesFetched: browserDetailPagesFetched,
      unchangedSkips: browserUnchangedSkips,
      cacheHits: browserCacheHits,
      retryableFailures: failures.filter(isRetryableFailure).length,
    };
    await this.recordStrategy(persistence, sourceUrl, {
      adapter: "Playwright browser",
      requiresJs: true,
      success: rootSucceeded,
      latencyMs: Math.round(performance.now() - httpStartedAt),
      status,
      httpStatus: failures.find(({ statusCode }) => statusCode !== null)?.statusCode ?? null,
    });
    return {
      sourceUrl,
      pagesVisited,
      potentialPostingsInspected,
      jobs: this.deduplicateJobsWithProfile(jobs, sourceUrl),
      failures,
      closedPages,
      completed: rootSucceeded,
      coverageComplete: status === "success",
      status,
      retrievalMethod: "Playwright browser",
      attempts: failures.reduce((total, failure) => total + failure.retryCount + 1, 0) + (rootSucceeded ? 1 : 0),
      httpStatus: failures.find(({ statusCode }) => statusCode !== null)?.statusCode ?? null,
      directApplicationLinks: jobs.filter(({ internship }) => hasDirectApplicationUrl(sourceUrl, internship.applicationUrl)).length,
      retrievalMode,
      retrievalUrls: uniqueUrls(retrievalUrls),
      ...(coverageNotes.length > 0 ? { coverageNotes } : {}),
      metrics: browserMetrics,
    };
  }

  private robotsDisallowedSource(sourceUrl: string): SourceCrawlResult {
    const failure: FetchFailure = {
      sourceUrl,
      url: sourceUrl,
      errorType: "robots_disallowed",
      message: "Disallowed by robots.txt",
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    };
    return {
      sourceUrl,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: [failure],
      closedPages: [],
      completed: false,
      coverageComplete: false,
      status: "robots_disallowed",
      retrievalMethod: "robots.txt",
      attempts: 0,
      httpStatus: null,
      directApplicationLinks: 0,
      retrievalMode: "configured_url",
      retrievalUrls: [sourceUrl],
    };
  }

  private structuredAdapterUnavailableSource(sourceUrl: string, result: SourceAdapterResult, durationMs: number): SourceCrawlResult {
    const httpStatus = sourceAdapterStatusCode(result);
    const status: SourceStatus = httpStatus === 429
      ? "rate_limited"
      : sourceAdapterAccessDenied(result)
        ? "access_denied"
        : "source_unavailable";
    return {
      sourceUrl,
      durationMs,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: result.failures,
      closedPages: [],
      completed: false,
      coverageComplete: false,
      status,
      retrievalMethod: result.retrievalMethod,
      attempts: result.attempts,
      httpStatus,
      directApplicationLinks: 0,
      retrievalMode: "configured_url",
      retrievalUrls: uniqueUrls(result.retrievalUrls.length > 0 ? result.retrievalUrls : [sourceUrl]),
      coverageNotes: ["Structured feed retrieval failed; the blocked page shell was not sent to the browser fallback.", ...result.notes],
      metrics: { retryableFailures: result.failures.filter(isRetryableFailure).length },
    };
  }

  private async crawlGrindJobBoardSource(
    sourceUrl: string,
    onProgress?: SourceProgressCallback,
    persistence?: CrawlPersistence,
  ): Promise<SourceCrawlResult> {
    const startedAt = performance.now();
    try {
      const snapshot = await this.grindJobBoardClient.getSnapshot(true);
      this.throwIfCancelled(persistence);
      const verifiedAt = snapshot.lastSuccessfulSyncAt ?? new Date().toISOString();
      const minimumScore = Math.max(this.settings.minRelevanceScore, 50);
      const jobs = snapshot.jobs
        .filter((job) => !isExcludedJobTitle(job.title))
        .map((job) => grindJobToAnalyzedJob(job, sourceUrl, verifiedAt))
        .filter(({ internship }) => internship.relevanceScore >= minimumScore && internship.categories.length > 0);
      const failures: FetchFailure[] = snapshot.failures.map((failure) => ({
        sourceUrl,
        url: snapshot.retrievalUrl,
        errorType: failure.statusCode === 429
          ? "rate_limited"
          : failure.statusCode === 401 || failure.statusCode === 403
            ? "access_denied"
            : "http_error",
        message: `${failure.company}: ${failure.message}`,
        statusCode: failure.statusCode ?? null,
        retryCount: Math.max(0, snapshot.attempts - snapshot.companyCount),
        occurredAt: new Date().toISOString(),
      }));
      const irrelevantListingsSkipped = Math.max(0, snapshot.jobs.length - jobs.length);
      const httpStatus = snapshot.failures.find(({ statusCode }) => statusCode !== null)?.statusCode
        ?? (snapshot.status === "ready" ? 200 : null);
      const status: SourceCrawlResult["status"] = snapshot.status === "ready"
        ? jobs.length > 0 ? "success" : "no_internships_found"
        : snapshot.status === "partial" || snapshot.status === "stale"
          ? "partial"
          : "source_unavailable";
      const completed = snapshot.status === "ready" || snapshot.status === "partial";
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      const result: SourceCrawlResult = {
        sourceUrl,
        pagesVisited: snapshot.companyCount,
        potentialPostingsInspected: snapshot.jobCount,
        jobs,
        failures,
        closedPages: [],
        completed,
        coverageComplete: snapshot.status === "ready",
        status,
        retrievalMethod: "Convex structured feed",
        attempts: snapshot.attempts,
        httpStatus,
        directApplicationLinks: jobs.length,
        retrievalMode: "configured_url",
        retrievalUrls: [snapshot.retrievalUrl],
        coverageNotes: [
          `Retrieved ${snapshot.jobCount} board listings from ${snapshot.companiesRefreshed} refreshed company feeds.`,
          ...(snapshot.status === "stale" ? ["Using the last-known durable board cache because no feed refreshed successfully."] : []),
          ...snapshot.failures.map(({ company, message }) => `${company}: ${message}`),
        ],
        metrics: {
          httpRequests: snapshot.attempts,
          detailPagesFetched: 0,
          retryableFailures: failures.filter(isRetryableFailure).length,
          irrelevantListingsSkipped,
          runtimeMs,
        },
      };
      await onProgress?.({
        pagesVisited: result.pagesVisited,
        potentialPostingsInspected: result.potentialPostingsInspected,
        internshipsDiscovered: result.jobs.length,
        completed: result.completed,
        detailPagesFetched: 0,
        irrelevantListingsSkipped,
      });
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Grind Convex feed",
        requiresJs: false,
        success: snapshot.status === "ready",
        latencyMs: runtimeMs,
        status,
        httpStatus,
        metadata: {
          companyCount: snapshot.companyCount,
          companiesRefreshed: snapshot.companiesRefreshed,
          jobCount: snapshot.jobCount,
          freshCount: snapshot.freshCount,
          retrievalUrl: snapshot.retrievalUrl,
        },
      });
      return result;
    } catch (error) {
      this.propagateIfAbort(error, persistence);
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      const message = error instanceof Error ? error.message : String(error);
      const failure: FetchFailure = {
        sourceUrl,
        url: sourceUrl,
        errorType: "source_unavailable",
        message,
        statusCode: null,
        retryCount: 0,
        occurredAt: new Date().toISOString(),
      };
      const result: SourceCrawlResult = {
        sourceUrl,
        pagesVisited: 0,
        potentialPostingsInspected: 0,
        jobs: [],
        failures: [failure],
        closedPages: [],
        completed: false,
        coverageComplete: false,
        status: "source_unavailable",
        retrievalMethod: "Convex structured feed",
        attempts: 0,
        httpStatus: null,
        directApplicationLinks: 0,
        retrievalMode: "configured_url",
        retrievalUrls: [sourceUrl],
        coverageNotes: ["The board feed could not be read; no listings were treated as closed."],
        metrics: { runtimeMs, retryableFailures: 1 },
      };
      await onProgress?.({ pagesVisited: 0, potentialPostingsInspected: 0, internshipsDiscovered: 0, completed: false });
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Grind Convex feed",
        requiresJs: false,
        success: false,
        latencyMs: runtimeMs,
        status: "source_unavailable",
        error: message,
      });
      return result;
    }
  }

  private adapterName(result: { retrievalMethod?: string }): string {
    return result.retrievalMethod?.split(/\s+/u).slice(0, 2).join(" ") || "HTTP adapter";
  }

  private async analyzeJobWithProfile(
    raw: RawJob,
    sourceUrl: string,
    resolver: (url: string) => Promise<string | null>,
    now: string,
  ): Promise<AnalyzeResult> {
    const startedAt = performance.now();
    const result = await analyzeRawJob(raw, sourceUrl, this.settings.minRelevanceScore, resolver, now);
    const duration = Math.max(0, performance.now() - startedAt);
    this.profiler.recordSpan("parsing", duration, { source: sourceUrl, url: raw.postingUrl });
    this.profiler.recordSpan("qualification", duration, { source: sourceUrl, url: raw.postingUrl });
    this.profiler.increment("relevance");
    return result;
  }

  private deduplicateJobsWithProfile(jobs: AnalyzedJob[], source?: string): AnalyzedJob[] {
    const startedAt = performance.now();
    const result = deduplicateJobs(jobs);
    this.profiler.recordSpan("dedupe", performance.now() - startedAt, source ? { source } : {});
    return result;
  }

  private async resolveApplicationUrlHttp(value: string): Promise<string | null> {
    try {
      const response = await this.http.get(value, { cache: true, perHostDelayMs: Math.min(this.settings.perHostDelayMs, 100) });
      if (response.status < 200 || response.status >= 400) return null;
      return safeCanonicalizeUrl(response.url) ?? value;
    } catch {
      // HTTP resolution is advisory. Preserve the extracted destination for
      // ordinary public pages; only an explicit non-2xx response closes it.
      return value;
    }
  }

  /**
   * Jobright is a discovery wrapper rather than an application destination.
   * The normal crawl is intentionally cache-only: opening thousands of
   * Jobright detail pages while analyzing a feed was the source of runaway
   * crawl times. The separate Jobright resolver fills this cache by reading
   * the rendered Original Job Post href. Other URLs retain the lane's normal
   * HTTP/browser/identity resolver.
   */
  private resolverForRawJob(
    rawJob: RawJob,
    _sourceUrl: string,
    fallback: (url: string) => Promise<string | null>,
    knownJobrightDestination: string | null = null,
    cacheOnlyJobright = false,
  ): (url: string) => Promise<string | null> {
    const jobrightUrl = [rawJob.postingUrl, rawJob.applicationUrl ?? ""].find(isJobrightUrl) ?? null;
    const cachedDestination = jobrightUrl
      ? knownJobrightDestination ?? directApplicationOverride(jobrightUrl)
      : null;
    return async (url: string) => {
      if (jobrightUrl || isJobrightUrl(url)) {
        if (cachedDestination || cacheOnlyJobright) return cachedDestination;
        // Direct crawler instances without persistence retain the historical
        // behavior for the standalone crawler API. The production scout
        // supplies persistence and therefore stays cache-only.
        return this.browser.resolveOriginalJobPostUrl(jobrightUrl ?? url, _sourceUrl);
      }
      return fallback(url);
    };
  }

  private cachedJobrightDestination(
    sourceUrl: string,
    rawJob: RawJob,
    persistence: CrawlPersistence | undefined,
    cache: Map<string, string | null>,
    preloadedDestinations: Map<string, string> | null = null,
  ): string | null {
    const jobrightUrl = [rawJob.postingUrl, rawJob.applicationUrl ?? ""].find(isJobrightUrl);
    if (!jobrightUrl) return null;
    const key = rawJob.jobId?.trim() || jobrightUrl;
    if (cache.has(key)) return cache.get(key) ?? null;
    if (preloadedDestinations) {
      const destination = preloadedDestinations.get(key) ?? null;
      cache.set(key, destination);
      return destination;
    }
    if (!persistence?.classifyListing) {
      const destination = directApplicationOverride(jobrightUrl);
      cache.set(key, destination);
      return destination;
    }
    const decision = persistence.classifyListing(sourceUrl, {
      canonicalUrl: jobrightUrl,
      postingUrl: jobrightUrl,
      ...(rawJob.jobId ? { externalJobId: rawJob.jobId } : {}),
      providerIdentity: rawJob.sourceProvider,
    });
    const prior = decision.record;
    const destination = prior
      && prior.availabilityStatus === "open"
      && prior.failureState === "none"
      && prior.internship
      ? [prior.internship.applicationUrl, prior.internship.postingUrl]
        .map((value) => safeCanonicalizeUrl(value))
        .find((value): value is string => value !== null && !isAggregatorUrl(value) && !isJobrightUrl(value)) ?? null
      : null;
    cache.set(key, destination);
    return destination;
  }

  private cachedJobrightUrlDestination(
    value: string,
    preloadedDestinations: Map<string, string> | null,
  ): string | null {
    const canonical = safeCanonicalizeUrl(value);
    if (!canonical || !isJobrightUrl(canonical)) return null;
    return directApplicationOverride(canonical) ?? preloadedDestinations?.get(canonical) ?? null;
  }

  private async recordStrategy(persistence: CrawlPersistence | undefined, sourceUrl: string, patch: Parameters<NonNullable<CrawlPersistence["recordSourceFetch"]>>[1]): Promise<void> {
    if (!persistence?.recordSourceFetch) return;
    this.throwIfCancelled(persistence);
    try {
      await persistence.recordSourceFetch(sourceUrl, patch);
      this.throwIfCancelled(persistence);
    } catch (error) {
      this.logger.debug("PERSIST", `Could not record source strategy for ${redactSensitiveUrl(sourceUrl)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Direct HTTP worker pipeline for generic sources. Listing/root snapshots
   * are consumed immediately and structurally admissible links are scheduled into a bounded
   * queue; one slow URL therefore cannot hold up unrelated ready work.
   */
  private async crawlHttpSource(
    sourceUrl: string,
    collected: Awaited<ReturnType<SourceAdapterRouter["collect"]>>,
    onProgress?: SourceProgressCallback,
    persistence?: CrawlPersistence,
  ): Promise<SourceCrawlResult> {
    const startedAt = performance.now();
    const httpMetricsStart = this.http.metrics;
    const structuredSnapshotFloor = collected.strategy === "structured_endpoint"
      ? collected.snapshots.length
      : 0;
    const structuredLinkFloor = collected.strategy === "structured_endpoint"
      ? collected.snapshots.reduce((largest, snapshot) => Math.max(largest, snapshot.links.length + 1), 0)
      : 0;
    const pageLimit = Math.max(
      1,
      this.settings.maxPagesPerSource,
      largeListingSourcePageFloor(sourceUrl) ?? 0,
      structuredSnapshotFloor,
      structuredLinkFloor,
    );
    // Capacity is bounded by the crawl's own admission ceiling. This avoids
    // a producer deadlock when every worker fans out links while retaining
    // backpressure for unusually large pages.
    const admissionLimit = pageLimit * 20;
    const work = new BoundedAsyncQueue<CrawlQueueItem>(
      Math.max(16, admissionLimit + this.settings.httpConcurrency),
      this.profiler,
      currentSourceAbortSignal(),
    );
    const jobs: AnalyzedJob[] = [];
    const failures: FetchFailure[] = [...collected.failures];
    const closedPages: ClosedPage[] = [];
    const visited = new Set<string>();
    const enqueued = new Set<string>();
    const approvedHosts = new Set<string>([hostname(sourceUrl)]);
    const snapshotsByUrl = new Map<string, PageSnapshot>();
    let pending = 0;
    let pagesVisited = 0;
    let potentialPostingsInspected = 0;
    const rawListingLimit = Number.isSafeInteger(collected.maxRawListings) && (collected.maxRawListings ?? 0) > 0
      ? collected.maxRawListings!
      : MAX_ACCEPTED_JOBS_PER_SOURCE;
    let rawListingsObserved = 0;
    let rawListingLimitReported = false;
    let candidateLimitReported = false;
    // Structured adapters return one snapshot per posting payload rather than
    // a listing page followed by detail requests. Count those payloads as
    // detail work up front; dynamic HTTP links below are counted when fetched.
    let detailPagesFetched = collected.strategy === "structured_endpoint"
      ? collected.snapshots.filter(({ status }) => status >= 200 && status < 400).length
      : 0;
    let duplicateListingsSkipped = 0;
    const irrelevantListingsSkipped = 0;
    let unchangedSkips = 0;
    let newListings = 0;
    let changedListings = 0;
    const acceptedDetailStates: Array<{ job: AnalyzedJob; disposition: "new" | "possibly_changed" | "retryable" }> = [];
    const cachedUnchangedJobs: AnalyzedJob[] = [];
    const sightings: LightweightSighting[] = [];
    // A listing can be present in more than one listing snapshot. Keep one
    // identity decision/sighting per crawl so duplicate links cannot inflate
    // unchanged/cache counters or touch lifecycle state repeatedly.
    const seenCandidateIdentities = new Set<string>();
    const scheduledHints = new Map<string, ListingIdentityHint>();
    const scheduledStates = new Map<string, "new" | "possibly_changed" | "retryable">();
    const knownJobrightDestinations = new Map<string, string | null>();
    const preloadedJobrightDestinations = persistence?.getJobrightDestinations?.(sourceUrl) ?? null;
    const jobrightCacheOnly = Boolean(persistence?.getJobrightDestinations);
    const failedDetailIdentities = new Set<string>();
    const retryableSightedIdentities = new Set<string>();
    let attempts = collected.attempts;
    let httpStatus = collected.httpStatus;
    let rootSucceeded = collected.snapshots.some(({ status }) => status >= 200 && status < 400);
    const add = async (item: CrawlQueueItem): Promise<boolean> => {
      this.throwIfCancelled(persistence);
      if (enqueued.has(item.url) || enqueued.size >= admissionLimit || item.depth > this.settings.maxDepth) return false;
      enqueued.add(item.url);
      approvedHosts.add(hostname(item.url));
      pending += 1;
      this.profiler.increment("urlsDiscovered");
      if (!work.tryPush(item)) {
        // The queue capacity includes one slot per active producer, so this
        // should only occur during cancellation/close. Undo admission rather
        // than awaiting while every worker is itself producing.
        enqueued.delete(item.url);
        pending -= 1;
        return false;
      }
      return true;
    };
    for (const snapshot of collected.snapshots.slice(0, pageLimit)) {
      snapshotsByUrl.set(snapshot.url, snapshot);
      await add({ url: snapshot.url, sourceUrl, referrerUrl: null, depth: 0, priority: 1_000, reason: "HTTP listing" });
    }

    const process = async (item: CrawlQueueItem): Promise<void> => {
      this.throwIfCancelled(persistence);
      if (visited.has(item.url) || pagesVisited >= pageLimit) return;
      visited.add(item.url);
      pagesVisited += 1;
      let snapshot = snapshotsByUrl.get(item.url);
      try {
        if (!snapshot) {
          const robots = this.settings.respectRobotsTxt && !earlyCareerRadarOwnerUrl(sourceUrl, item.url)
            ? await this.robots.check(item.url)
            : { allowed: true, crawlDelayMs: null };
          if (!robots.allowed) {
            failures.push(this.failure(item, "robots_disallowed", "Disallowed by robots.txt", null, 0));
            return;
          }
          const response = await this.http.get(item.url, {
            cache: true,
            perHostDelayMs: Math.max(Math.min(this.settings.perHostDelayMs, 150), robots.crawlDelayMs ?? 0),
            respectRobots: !earlyCareerRadarOwnerUrl(sourceUrl, item.url),
          });
          attempts += response.attempts;
          httpStatus = response.status;
          snapshot = snapshotFromHttp(response);
          snapshotsByUrl.set(snapshot.url, snapshot);
          if (item.depth > 0 && !response.fromCache) detailPagesFetched += 1;
        }
        if (item.depth === 0 && snapshot.status >= 200 && snapshot.status < 400) rootSucceeded = true;
        const closure = detectClosedPage(snapshot.text, snapshot.status, snapshot.url, item.reason === "known job verification", snapshot.html);
        if (closure) {
          closedPages.push({ url: item.url, reason: closure, statusCode: snapshot.status });
          return;
        }
        const rawJobs = extractJobs(snapshot);
        potentialPostingsInspected += rawJobs.length;
        rawListingsObserved += rawJobs.length;
        const rawJobBudget = Math.max(0, rawListingLimit - (rawListingsObserved - rawJobs.length));
        if (rawListingsObserved > rawListingLimit && !rawListingLimitReported) {
          failures.push(sourceLimitFailure(sourceUrl, snapshot.url, "Raw listings", rawListingsObserved, rawListingLimit));
          rawListingLimitReported = true;
        }
        for (const rawJob of rawJobs.slice(0, rawJobBudget)) {
          this.throwIfCancelled(persistence);
          const knownJobrightDestination = this.cachedJobrightDestination(
            sourceUrl,
            rawJob,
            persistence,
            knownJobrightDestinations,
            preloadedJobrightDestinations,
          );
          const resolver = this.resolverForRawJob(
            rawJob,
            sourceUrl,
            isEarlyCareerRadarSource(sourceUrl)
              ? async (url: string) => url
              : (url: string) => this.resolveApplicationUrlHttp(url),
            knownJobrightDestination,
            Boolean(persistence?.getJobrightDestinations),
          );
          const analyzed = await this.analyzeJobWithProfile(rawJob, sourceUrl, resolver, snapshot.fetchedAt);
          if (analyzed.accepted) {
            const enriched: AnalyzedJob = { ...analyzed.value };
            if (snapshot.cacheMetadata) enriched.cacheMetadata = snapshot.cacheMetadata;
            jobs.push(enriched);
            if (item.depth > 0) {
              const disposition = scheduledStates.get(item.url);
              if (disposition) acceptedDetailStates.push({ job: enriched, disposition });
            }
          }
        }
        if (item.depth >= this.settings.maxDepth) return;
        const publicBoardLinks = snapshot.links.length < MAX_ACCEPTED_JOBS_PER_SOURCE
          ? discoverPublicBoardLinks(snapshot)
          : [];
        const candidatePool = [
          ...snapshot.links.slice(0, MAX_ACCEPTED_JOBS_PER_SOURCE),
          ...publicBoardLinks.slice(0, Math.max(0, MAX_ACCEPTED_JOBS_PER_SOURCE - snapshot.links.length)),
        ];
        if (snapshot.links.length + publicBoardLinks.length > candidatePool.length && !candidateLimitReported) {
          failures.push(sourceLimitFailure(sourceUrl, snapshot.url, "Candidate links", snapshot.links.length + publicBoardLinks.length));
          candidateLimitReported = true;
        }
        const candidates = candidatePool
          .map((link) => {
            const url = safeCanonicalizeUrl(link.url, snapshot?.url);
            if (!url) return null;
            const normalizedLink = { ...link, url };
            return { link: normalizedLink, ...scoreLink(normalizedLink, snapshot?.url ?? sourceUrl) };
          })
          .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null)
          .sort((left, right) => right.score - left.score);
        const candidateRecords = candidates.map((candidate) => ({
          ...candidate.link,
          url: candidate.link.url,
          postingUrl: candidate.link.url,
          canonicalUrl: candidate.link.url,
          title: candidate.link.text,
          snippet: candidate.link.text,
          locations: [],
          provider: new URL(candidate.link.url).hostname,
        }));
        const uniqueCandidates = deduplicateListings(candidateRecords);
        duplicateListingsSkipped += Math.max(0, candidates.length - uniqueCandidates.length);
        for (const lightweight of uniqueCandidates) {
          this.throwIfCancelled(persistence);
          const candidate = candidates.find(({ link }) => link.url === lightweight.url);
          if (!candidate) continue;
          if (candidate.score <= -1000 || visited.has(candidate.link.url) || enqueued.has(candidate.link.url)) continue;
          if (jobrightCacheOnly
            && isJobrightJobUrl(candidate.link.url)
            && !this.cachedJobrightUrlDestination(candidate.link.url, preloadedJobrightDestinations)) continue;
          if (!externalLinkAllowed(candidate.link, candidate.score, sourceUrl, snapshot?.url ?? sourceUrl, approvedHosts, item.depth + 1)) continue;
          const hint: ListingIdentityHint = {
            canonicalUrl: candidate.link.url,
            postingUrl: candidate.link.url,
            providerIdentity: lightweight.provider ?? null,
          };
          const decision = persistence?.classifyListing?.(sourceUrl, hint);
          const candidateIdentity = candidate.link.url;
          if (seenCandidateIdentities.has(candidateIdentity)) {
            duplicateListingsSkipped += 1;
            continue;
          }
          seenCandidateIdentities.add(candidateIdentity);
          const relevance = scoreListingRelevance({ title: lightweight.title ?? candidate.link.text, snippet: candidate.link.text }, { minimumScore: Math.min(30, this.settings.minRelevanceScore) });
          const recentRecord = decision?.record
            && decision.record.availabilityStatus === "open"
            && decision.record.failureState === "none"
            && this.settings.detailRecheckTtlMs > 0
            && Date.now() - Date.parse(decision.record.lastCheckedAt) <= this.settings.detailRecheckTtlMs;
          const requiresOriginalPost = isJobrightUrl(candidate.link.url);
          if (!requiresOriginalPost && ((decision?.disposition === "unchanged" && decision.validatorsMatch) || recentRecord)) {
            if (decision?.record?.internship) {
              const cachedJob: AnalyzedJob = { internship: { ...decision.record.internship, lifecycleStatus: "UNCHANGED" }, contentHash: decision.record.contentHash };
              jobs.push(cachedJob);
              cachedUnchangedJobs.push(cachedJob);
            }
            unchangedSkips += 1;
            sightings.push({ sourceUrl, ...hint, state: "unchanged", observedOpen: true, provenance: { reason: recentRecord ? "recent_identity_recheck" : "validator_match", relevance: relevance.score } });
            continue;
          }
          const disposition = decision?.disposition === "retryable" || decision?.disposition === "failed"
            ? "retryable"
            : decision?.disposition === "possibly_changed" || decision?.disposition === "closed"
              ? "possibly_changed"
              : "new";
          const admitted = await add({
            url: candidate.link.url,
            sourceUrl,
            referrerUrl: snapshot?.url ?? sourceUrl,
            depth: item.depth + 1,
            priority: candidate.score - item.depth * 3,
            reason: candidate.reason,
          });
          if (admitted) {
            scheduledHints.set(candidateIdentity, hint);
            scheduledStates.set(candidateIdentity, disposition);
          }
        }
      } catch (error) {
        this.propagateIfAbort(error, persistence);
        const requestError = error instanceof HttpRequestError
          ? error
          : new HttpRequestError(error instanceof Error ? error.message : String(error), null, 0, "http_error");
        failures.push(this.failure(item, requestError.errorType, requestError.message, requestError.statusCode, requestError.attempts));
        const scheduledHint = scheduledHints.get(item.url);
        if (item.depth > 0 && scheduledHint && isRetryableFailure(requestError) && !failedDetailIdentities.has(item.url)) {
          failedDetailIdentities.add(item.url);
          retryableSightedIdentities.add(item.url);
          sightings.push({ sourceUrl, ...scheduledHint, canonicalUrl: scheduledHint.canonicalUrl ?? item.url, postingUrl: scheduledHint.postingUrl ?? item.url, state: "retryable", observedOpen: true, provenance: { reason: requestError.errorType } });
        }
        if (item.depth === 0) rootSucceeded = false;
      }
    };
    const worker = async (): Promise<void> => {
      while (true) {
        this.throwIfCancelled(persistence);
        const item = await work.pop();
        if (!item) return;
        try {
          await process(item);
        } finally {
          pending -= 1;
          if (pending === 0) work.close();
        }
        await onProgress?.({ pagesVisited, potentialPostingsInspected, internshipsDiscovered: jobs.length, completed: false, detailPagesFetched, unchangedSkips, newListings, changedListings, duplicateListingsSkipped, irrelevantListingsSkipped });
      }
    };
    const workerCount = Math.max(1, this.settings.httpConcurrency);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    const deduplicatedJobs = this.deduplicateJobsWithProfile(jobs, sourceUrl);
    const countedFinalJobs = new Set<AnalyzedJob>();
    newListings = 0;
    changedListings = 0;
    for (const finalJob of deduplicatedJobs) {
      if (finalJob.internship.lifecycleStatus === "UNCHANGED" || cachedUnchangedJobs.some(({ internship }) => listingIdentityMatches(internship, finalJob.internship))) continue;
      const accepted = acceptedDetailStates.find(({ job }) => listingIdentityMatches(job.internship, finalJob.internship) && !countedFinalJobs.has(job));
      if (!accepted) continue;
      countedFinalJobs.add(accepted.job);
      if (accepted.disposition === "new") newListings += 1;
      else changedListings += 1;
    }
    const status = sourceStatus(rootSucceeded, deduplicatedJobs.length, failures);
    const metrics: CrawlMetrics = {
      ...metricDelta(this.http.metrics, httpMetricsStart),
      detailPagesFetched,
      duplicateListingsSkipped: duplicateListingsSkipped + Math.max(0, jobs.length - deduplicatedJobs.length),
      irrelevantListingsSkipped,
      unchangedSkips,
      newListings,
      changedListings,
      retryableFailures: Math.max(0, failures.filter(isRetryableFailure).length - retryableSightedIdentities.size),
      runtimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
    };
    if (persistence?.runId !== undefined && persistence.recordLightweightSightings && sightings.length > 0) {
      this.throwIfCancelled(persistence);
      await persistence.recordLightweightSightings(persistence.runId, sightings);
      this.throwIfCancelled(persistence);
    }
    // The snapshots are only needed while the queue is being processed. Drop
    // every retained page before returning so a large source does not keep
    // HTML/text/link graphs alive while its result is handed to the writer.
    snapshotsByUrl.clear();
    return {
      sourceUrl,
      pagesVisited,
      potentialPostingsInspected,
      jobs: deduplicatedJobs,
      failures,
      closedPages,
      completed: rootSucceeded,
      coverageComplete: status === "success",
      status,
      retrievalMethod: collected.retrievalMethod,
      attempts,
      httpStatus,
      directApplicationLinks: deduplicatedJobs.filter(({ internship }) => hasDirectApplicationUrl(sourceUrl, internship.applicationUrl)).length,
      retrievalMode: "configured_url",
      retrievalUrls: uniqueUrls(collected.retrievalUrls),
      ...(collected.notes.length > 0 ? { coverageNotes: collected.notes } : {}),
      metrics,
    };
  }

  private async crawlUsenoSource(sourceUrl: string, onProgress?: SourceProgressCallback, persistence?: CrawlPersistence): Promise<SourceCrawlResult> {
    const startedAt = performance.now();
    const httpMetricsStart = this.http.metrics;
    try {
      const collected = await collectUsenoSummer2027({
        sourceUrl,
        settings: this.settings,
        http: this.http,
        robots: this.robots,
        logger: this.logger,
      });
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      const metrics: CrawlMetrics = {
        ...metricDelta(this.http.metrics, httpMetricsStart),
        detailPagesFetched: 0,
        runtimeMs,
      };
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Useno static listing",
        requiresJs: false,
        success: true,
        latencyMs: runtimeMs,
        status: "success",
        httpStatus: collected.response.status,
      });
      await onProgress?.({
        pagesVisited: 1,
        potentialPostingsInspected: collected.artifact.totalRecords,
        internshipsDiscovered: 0,
        completed: false,
        detailPagesFetched: 0,
      });
      return {
        sourceUrl,
        pagesVisited: 1,
        potentialPostingsInspected: collected.artifact.totalRecords,
        jobs: [],
        failures: [],
        closedPages: [],
        completed: true,
        coverageComplete: true,
        status: "success",
        retrievalMethod: "Useno static listing HTTP",
        attempts: collected.response.attempts,
        httpStatus: collected.response.status,
        directApplicationLinks: collected.artifact.totalRecords,
        retrievalMode: "configured_url",
        retrievalUrls: [collected.response.url],
        coverageNotes: [`Parsed ${collected.artifact.totalRecords} rows across ${collected.artifact.categories.length} categories. Raw snapshot saved to ${collected.outputPath}. Application URLs were recorded but not requested.`],
        metrics,
      };
    } catch (error) {
      this.propagateIfAbort(error, persistence);
      if (error instanceof HttpRequestError && error.errorType === "robots_disallowed") return this.robotsDisallowedSource(sourceUrl);
      const httpError = error instanceof HttpRequestError ? error : null;
      const failure: FetchFailure = httpError
        ? this.httpFailure(sourceUrl, httpError)
        : {
          sourceUrl,
          url: sourceUrl,
          errorType: "parse_error",
          message: error instanceof Error ? error.message : String(error),
          statusCode: null,
          retryCount: 0,
          occurredAt: new Date().toISOString(),
        };
      const status: SourceStatus = httpError?.statusCode === 429
        ? "rate_limited"
        : httpError?.statusCode === 403
          ? "access_denied"
          : httpError
            ? "source_unavailable"
            : "parse_error";
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Useno static listing",
        requiresJs: false,
        success: false,
        latencyMs: runtimeMs,
        status,
        httpStatus: failure.statusCode,
        error: failure.message,
      });
      return {
        sourceUrl,
        pagesVisited: 0,
        potentialPostingsInspected: 0,
        jobs: [],
        failures: [failure],
        closedPages: [],
        completed: false,
        coverageComplete: false,
        status,
        retrievalMethod: "Useno static listing HTTP",
        attempts: httpError?.attempts ?? 1,
        httpStatus: failure.statusCode,
        directApplicationLinks: 0,
        retrievalMode: "configured_url",
        retrievalUrls: [sourceUrl],
        coverageNotes: ["The dedicated Useno listing parser did not report a complete page; the last successful snapshot was retained if one existed."],
        metrics: { ...metricDelta(this.http.metrics, httpMetricsStart), runtimeMs },
      };
    }
  }

  private async crawlUsenoMasterlistSource(sourceUrl: string, onProgress?: SourceProgressCallback, persistence?: CrawlPersistence): Promise<SourceCrawlResult> {
    const startedAt = performance.now();
    const httpMetricsStart = this.http.metrics;
    try {
      const collected = await collectUsenoInternshipMasterlist({
        sourceUrl,
        settings: this.settings,
        http: this.http,
        robots: this.robots,
        logger: this.logger,
      });
      const now = new Date().toISOString();
      const jobs = collected.artifact.listings.map((listing) => usenoMasterlistJob(listing, sourceUrl, now));
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      const metrics: CrawlMetrics = {
        ...metricDelta(this.http.metrics, httpMetricsStart),
        detailPagesFetched: 0,
        runtimeMs,
      };
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Useno masterlist static listing",
        requiresJs: false,
        success: true,
        latencyMs: runtimeMs,
        status: "success",
        httpStatus: collected.response.status,
        metadata: {
          selectedCategories: collected.artifact.selectedCategories.map(({ id, eligibleCount }) => ({ id, eligibleCount })),
          skippedLocationCount: collected.artifact.skippedLocationCount,
        },
      });
      await onProgress?.({
        pagesVisited: 1,
        potentialPostingsInspected: collected.artifact.totalRecords,
        internshipsDiscovered: jobs.length,
        completed: false,
        detailPagesFetched: 0,
      });
      return {
        sourceUrl,
        pagesVisited: 1,
        potentialPostingsInspected: collected.artifact.totalRecords,
        jobs,
        failures: [],
        closedPages: [],
        completed: true,
        coverageComplete: true,
        status: "success",
        retrievalMethod: "Useno internship masterlist HTTP",
        attempts: collected.response.attempts,
        httpStatus: collected.response.status,
        directApplicationLinks: jobs.length,
        retrievalMode: "configured_url",
        retrievalUrls: [collected.response.url],
        coverageNotes: [
          `Parsed ${collected.artifact.totalRecords} eligible rows from the Software Engineering & Technology and Data, AI & Analytics tabs.`,
          `Skipped ${collected.artifact.skippedLocationCount} rows without Canada/U.S. location evidence.`,
          `Raw snapshot saved to ${collected.outputPath}. Employer detail pages were not requested; records explicitly retain unknown employer descriptions and qualifications.`,
        ],
        metrics,
      };
    } catch (error) {
      this.propagateIfAbort(error, persistence);
      if (error instanceof HttpRequestError && error.errorType === "robots_disallowed") return this.robotsDisallowedSource(sourceUrl);
      const httpError = error instanceof HttpRequestError ? error : null;
      const failure: FetchFailure = httpError
        ? this.httpFailure(sourceUrl, httpError)
        : {
          sourceUrl,
          url: sourceUrl,
          errorType: "parse_error",
          message: error instanceof Error ? error.message : String(error),
          statusCode: null,
          retryCount: 0,
          occurredAt: new Date().toISOString(),
        };
      const status: SourceStatus = httpError?.statusCode === 429
        ? "rate_limited"
        : httpError?.statusCode === 403
          ? "access_denied"
          : httpError
            ? "source_unavailable"
            : "parse_error";
      const runtimeMs = Math.max(0, Math.round(performance.now() - startedAt));
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: "Useno masterlist static listing",
        requiresJs: false,
        success: false,
        latencyMs: runtimeMs,
        status,
        httpStatus: failure.statusCode,
        error: failure.message,
      });
      return {
        sourceUrl,
        pagesVisited: 0,
        potentialPostingsInspected: 0,
        jobs: [],
        failures: [failure],
        closedPages: [],
        completed: false,
        coverageComplete: false,
        status,
        retrievalMethod: "Useno internship masterlist HTTP",
        attempts: httpError?.attempts ?? 1,
        httpStatus: failure.statusCode,
        directApplicationLinks: 0,
        retrievalMode: "configured_url",
        retrievalUrls: [sourceUrl],
        coverageNotes: ["The dedicated Useno masterlist parser did not report a complete page; no rows were treated as closed."],
        metrics: { ...metricDelta(this.http.metrics, httpMetricsStart), runtimeMs },
      };
    }
  }

  private async crawlGithubSource(sourceUrl: string, onProgress?: SourceProgressCallback, persistence?: CrawlPersistence): Promise<SourceCrawlResult> {
    const httpMetricsStart = this.http.metrics;
    const collected = await this.github.collect(sourceUrl);
    this.throwIfCancelled(persistence);
    const preloadedJobrightDestinations = persistence?.getJobrightDestinations?.(sourceUrl) ?? null;
    const knownJobrightDestinations = new Map<string, string | null>();
    const jobrightCacheOnly = Boolean(persistence?.getJobrightDestinations);
    const jobs: AnalyzedJob[] = [];
    const failures: FetchFailure[] = [...(collected.failures ?? [])];
    let potentialPostingsInspected = 0;
    for (const [index, snapshot] of collected.snapshots.entries()) {
      this.throwIfCancelled(persistence);
      try {
        const rawJobs = extractJobs(snapshot);
        potentialPostingsInspected += rawJobs.length;
        for (const rawJob of rawJobs) {
          const knownJobrightDestination = this.cachedJobrightDestination(
            sourceUrl,
            rawJob,
            persistence,
            knownJobrightDestinations,
            preloadedJobrightDestinations,
          );
          const resolver = this.resolverForRawJob(rawJob, sourceUrl, async (url: string) => url, knownJobrightDestination, jobrightCacheOnly);
          const analyzed = await this.analyzeJobWithProfile(
            rawJob,
            sourceUrl,
            // GitHub remains API/raw-content only for discovery. Jobright
            // destinations are read from the durable resolver cache.
            resolver,
            snapshot.fetchedAt,
          );
          if (analyzed.accepted) jobs.push(analyzed.value);
        }
      } catch (error) {
        this.propagateIfAbort(error, persistence);
        failures.push({
          sourceUrl,
          url: snapshot.url,
          errorType: "parse_error",
          message: error instanceof Error ? error.message : String(error),
          statusCode: snapshot.status,
          retryCount: 0,
          occurredAt: new Date().toISOString(),
        });
      }
      await onProgress?.({
        pagesVisited: index + 1,
        potentialPostingsInspected,
        internshipsDiscovered: jobs.length,
        completed: false,
      });
    }
    this.throwIfCancelled(persistence);
    if (collected.snapshots.length === 0) {
      const errorType = collected.httpStatus === 403 ? "access_denied"
        : collected.httpStatus === 429 ? "rate_limited"
          : "source_unavailable";
      failures.push({
        sourceUrl,
        url: sourceUrl,
        errorType,
        message: collected.notes.join(" ") || "No GitHub Markdown source file could be retrieved.",
        statusCode: collected.httpStatus,
        retryCount: Math.max(0, collected.attempts - 1),
        occurredAt: new Date().toISOString(),
      });
    }
    const deduplicatedJobs = this.deduplicateJobsWithProfile(jobs, sourceUrl);
    const status = collected.snapshots.length === 0
      ? sourceStatus(false, 0, failures)
      : deduplicatedJobs.length > 0 && failures.length === 0
        ? "success"
        : deduplicatedJobs.length > 0
          ? "partial"
          : failures.length > 0
            ? sourceStatus(true, 0, failures)
            : "no_internships_found";
    const metrics: CrawlMetrics = {
      ...metricDelta(this.http.metrics, httpMetricsStart),
      detailPagesFetched: collected.snapshots.length,
      duplicateListingsSkipped: Math.max(0, jobs.length - deduplicatedJobs.length),
      retryableFailures: failures.filter(isRetryableFailure).length,
    };
    await this.recordStrategy(persistence, sourceUrl, {
      adapter: "GitHub API/raw",
      requiresJs: false,
      success: collected.snapshots.length > 0,
      latencyMs: null,
      status,
      httpStatus: collected.httpStatus,
    });
    return {
      sourceUrl,
      pagesVisited: collected.snapshots.length,
      potentialPostingsInspected,
      jobs: deduplicatedJobs,
      failures,
      closedPages: [],
      completed: collected.snapshots.length > 0,
      coverageComplete: status === "success",
      status,
      retrievalMethod: collected.retrievalMethod,
      attempts: collected.attempts,
      httpStatus: collected.httpStatus,
      directApplicationLinks: deduplicatedJobs.filter(({ internship }) => hasDirectApplicationUrl(sourceUrl, internship.applicationUrl)).length,
      retrievalMode: "public_alternate",
      retrievalUrls: uniqueUrls(collected.retrievalUrls.length > 0 ? collected.retrievalUrls : [sourceUrl]),
      ...(collected.notes.length > 0 ? { coverageNotes: collected.notes } : {}),
      metrics,
    };
  }

  private async crawlStaticSource(
    sourceUrl: string,
    robotsDelayMs: number | null,
    onProgress?: SourceProgressCallback,
    persistence?: CrawlPersistence,
  ): Promise<SourceCrawlResult> {
    const startedAt = performance.now();
    const httpMetricsStart = this.http.metrics;
    try {
      // Deliberately stop after collectListing. Expensive detail requests are
      // scheduled only after global dedupe and indexed-state classification;
      // relevance is retained as a priority/diagnostic signal, not a gate.
      let listing = await this.staticAdapters.collectListing(sourceUrl);
      const staticProfile = this.staticAdapters.profile(sourceUrl);
      const needsBrowserListing = listing.listingSnapshots.some((snapshot) =>
        /\b(?:load|show|view)\s+more(?:\s+jobs?|\s+positions?)?|view all jobs?\b/i.test(snapshot.text)
        || (snapshot.links.length === 0 && snapshot.text.trim().length < 180 && /(?:__next|react-root|id=["']app["']|id=["']root["'])/i.test(snapshot.html)),
      );
      if (needsBrowserListing && staticProfile) {
        const dynamicSnapshot = await this.browser.fetchPage(sourceUrl, robotsDelayMs, sourceUrl);
        const dynamicCandidates = dynamicSnapshot.links.flatMap((link) => {
          const url = safeCanonicalizeUrl(link.url, dynamicSnapshot.url);
          if (!url || !sameSite(sourceUrl, url)) return [];
          try {
            if (!staticProfile.detailPath.test(new URL(url).pathname)) return [];
          } catch {
            return [];
          }
          const id = new URL(url).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.(?:html?|php)$/iu, "");
          return [{ url, title: link.text.trim(), snippet: link.text.trim(), sourceUrl, ...(id && /\d{3,}|[A-Za-z]{2,}[\w-]*\d/.test(id) ? { externalJobId: id } : {}) }];
        });
        listing = {
          ...listing,
          listingSnapshots: [...listing.listingSnapshots, dynamicSnapshot],
          detailCandidates: deduplicateListings([...listing.detailCandidates, ...dynamicCandidates]),
          retrievalMethod: `${listing.retrievalMethod}; browser listing expansion`,
          retrievalUrls: uniqueUrls([...listing.retrievalUrls, dynamicSnapshot.url]),
          attempts: listing.attempts + (dynamicSnapshot.attempts ?? 1),
        };
      }
      const failures: FetchFailure[] = [...listing.failures];
      const jobs: AnalyzedJob[] = [];
      const sightings: LightweightSighting[] = [];
      let potentialPostingsInspected = 0;
      let duplicateListingsSkipped = 0;
      const irrelevantListingsSkipped = 0;
      let unchangedSkips = 0;
      let cacheHits = 0;
      const acceptedDetailStates: Array<{ job: AnalyzedJob; disposition: "new" | "possibly_changed" | "retryable" }> = [];
      const retryableSightedIdentities = new Set<string>();
      const cachedUnchangedJobs: AnalyzedJob[] = [];
      const preloadedJobrightDestinations = persistence?.getJobrightDestinations?.(sourceUrl) ?? null;
      const knownJobrightDestinations = new Map<string, string | null>();
      const jobrightCacheOnly = Boolean(persistence?.getJobrightDestinations);
      const identityCandidates: Array<{ candidate: typeof listing.detailCandidates[number]; identity: ListingIdentityInput; hint: ListingIdentityHint; decision: CrawlStateDecision | null; relevance: ReturnType<typeof scoreListingRelevance> }> = [];
      const uniqueCandidates = deduplicateListings(listing.detailCandidates.map((candidate) => ({
        ...candidate,
        postingUrl: candidate.url,
        canonicalUrl: candidate.url,
        provider: this.staticAdapters.profile(sourceUrl)?.name ?? "static",
        title: candidate.title,
        locations: [],
        ...(candidate.externalJobId ? { externalJobId: candidate.externalJobId } : {}),
      })));
      duplicateListingsSkipped = Math.max(0, listing.detailCandidates.length - uniqueCandidates.length);
      const fetchableCandidates = uniqueCandidates.filter((candidate) =>
        !jobrightCacheOnly
        || !isJobrightJobUrl(candidate.url)
        || Boolean(this.cachedJobrightUrlDestination(candidate.url, preloadedJobrightDestinations)),
      );
      duplicateListingsSkipped += Math.max(0, uniqueCandidates.length - fetchableCandidates.length);
      for (const candidate of fetchableCandidates) {
        const hint: ListingIdentityHint = {
          canonicalUrl: candidate.url,
          postingUrl: candidate.url,
          ...(candidate.externalJobId ? { externalJobId: candidate.externalJobId } : {}),
          providerIdentity: this.staticAdapters.profile(sourceUrl)?.name ?? "static",
        };
        const decision = persistence?.classifyListing?.(sourceUrl, hint) ?? null;
        const relevance = scoreListingRelevance({ title: candidate.title, snippet: candidate.snippet }, { minimumScore: Math.min(30, this.settings.minRelevanceScore) });
        identityCandidates.push({ candidate, identity: candidate, hint, decision, relevance });
      }
      const selected: typeof listing.detailCandidates = [];
      const selectedStates = new Map<string, "new" | "possibly_changed" | "retryable">();
      for (const item of identityCandidates) {
        const decision = item.decision;
        const requiresOriginalPost = isJobrightUrl(item.candidate.url);
        const recentRecord = decision?.record
          && decision.record.availabilityStatus === "open"
          && decision.record.failureState === "none"
          && this.settings.detailRecheckTtlMs > 0
          && Date.now() - Date.parse(decision.record.lastCheckedAt) <= this.settings.detailRecheckTtlMs;
        if (!requiresOriginalPost && (decision?.disposition === "unchanged" && decision.validatorsMatch || recentRecord)) {
          const record = decision?.record;
          if (record?.internship) {
            const cachedJob: AnalyzedJob = { internship: { ...record.internship, lifecycleStatus: "UNCHANGED" }, contentHash: record.contentHash, cacheMetadata: { etag: record.etag, lastModified: record.lastModified, canonicalUrl: record.canonicalUrl, externalJobId: record.externalJobId, providerIdentity: record.providerIdentity } };
            jobs.push(cachedJob);
            cachedUnchangedJobs.push(cachedJob);
          }
          sightings.push({ sourceUrl, ...item.hint, state: "unchanged", observedOpen: true, provenance: { reason: recentRecord ? "recent_identity_recheck" : "validator_match", relevance: item.relevance.score } });
          unchangedSkips += 1;
          if (decision?.validatorsMatch) cacheHits += 1;
          continue;
        }
        const disposition = decision?.disposition === "retryable" || decision?.disposition === "failed"
          ? "retryable"
          : decision?.disposition === "possibly_changed" || decision?.disposition === "closed"
            ? "possibly_changed"
            : "new";
        selectedStates.set(item.candidate.url, disposition);
        selected.push(item.candidate);
      }
      const details = await this.staticAdapters.fetchDetails(sourceUrl, selected);
      const allSnapshots = details.snapshots;
      potentialPostingsInspected += allSnapshots.reduce((total, snapshot) => total + extractJobs(snapshot).length, 0);
      for (const snapshot of allSnapshots) {
        try {
          const rawJobs = extractJobs(snapshot);
          for (const rawJob of rawJobs) {
            const knownJobrightDestination = this.cachedJobrightDestination(
              sourceUrl,
              rawJob,
              persistence,
              knownJobrightDestinations,
              preloadedJobrightDestinations,
            );
            const resolver = this.resolverForRawJob(
              rawJob,
              sourceUrl,
            isEarlyCareerRadarSource(sourceUrl)
              ? async (url: string) => url
              : (url: string) => this.resolveApplicationUrlHttp(url),
            knownJobrightDestination,
            jobrightCacheOnly,
          );
            const analyzed = await this.analyzeJobWithProfile(rawJob, sourceUrl, resolver, snapshot.fetchedAt);
            if (analyzed.accepted) {
              const enriched: AnalyzedJob = { ...analyzed.value };
              if (snapshot.cacheMetadata) enriched.cacheMetadata = snapshot.cacheMetadata;
              jobs.push(enriched);
              this.logger.info("JOB", `${analyzed.value.internship.company} — ${analyzed.value.internship.title}`);
              const selectedIdentity = selected.find(({ url }) => url === snapshot.requestedUrl || url === snapshot.url)?.url;
              const disposition = selectedIdentity ? selectedStates.get(selectedIdentity) : undefined;
              if (disposition) acceptedDetailStates.push({ job: enriched, disposition });
            }
          }
        } catch (error) {
          failures.push({ sourceUrl, url: snapshot.url, errorType: "parse_error", message: error instanceof Error ? error.message : String(error), statusCode: snapshot.status, retryCount: 0, occurredAt: new Date().toISOString() });
        }
      }
      failures.push(...details.failures);
      for (const failure of details.failures) {
        const candidate = selected.find(({ url }) => url === failure.url);
        if (candidate && isRetryableFailure(failure)) {
          retryableSightedIdentities.add(candidate.url);
          sightings.push({ sourceUrl, canonicalUrl: candidate.url, postingUrl: candidate.url, ...(candidate.externalJobId ? { externalJobId: candidate.externalJobId } : {}), providerIdentity: this.staticAdapters.profile(sourceUrl)?.name ?? "static", state: "retryable", observedOpen: true, provenance: { reason: failure.errorType } });
        }
      }
      if (persistence?.runId !== undefined && persistence.recordLightweightSightings && sightings.length > 0) {
        this.throwIfCancelled(persistence);
        await persistence.recordLightweightSightings(persistence.runId, sightings);
        this.throwIfCancelled(persistence);
      }
      const deduplicatedJobs = this.deduplicateJobsWithProfile(jobs, sourceUrl);
      let successfulNewListings = 0;
      let successfulChangedListings = 0;
      const countedFinalJobs = new Set<AnalyzedJob>();
      for (const finalJob of deduplicatedJobs) {
        // Cached/unchanged payloads are already accounted for by the
        // lightweight sighting path. A duplicate detail candidate may merge
        // into that payload, but must not turn the final lifecycle back into
        // a new/changed metric.
        if (finalJob.internship.lifecycleStatus === "UNCHANGED" || cachedUnchangedJobs.some(({ internship }) => listingIdentityMatches(internship, finalJob.internship))) continue;
        const accepted = acceptedDetailStates.find(({ job }) => listingIdentityMatches(job.internship, finalJob.internship) && !countedFinalJobs.has(job));
        if (!accepted) continue;
        countedFinalJobs.add(accepted.job);
        if (accepted.disposition === "new") successfulNewListings += 1;
        else successfulChangedListings += 1;
      }
      const profile = this.staticAdapters.profile(sourceUrl);
      const authenticationRequired = profile?.name === "InternInsider" && deduplicatedJobs.length > 0 && deduplicatedJobs.every(({ internship }) => {
        try { return sameSite(sourceUrl, internship.applicationUrl) && /\/apply(?:\/|$)/i.test(new URL(internship.applicationUrl).pathname); } catch { return false; }
      });
      const status = authenticationRequired ? "authentication_required" : sourceStatus(listing.listingSnapshots.length > 0, deduplicatedJobs.length, failures);
      const metrics: CrawlMetrics = {
        ...metricDelta(this.http.metrics, httpMetricsStart),
        cacheHits: cacheHits + metricDelta(this.http.metrics, httpMetricsStart).cacheHits,
        unchangedSkips,
        detailPagesFetched: details.snapshots.filter((snapshot) => !snapshot.fromCache).length,
        duplicateListingsSkipped,
        irrelevantListingsSkipped,
        newListings: successfulNewListings,
        changedListings: successfulChangedListings,
        retryableFailures: Math.max(0, failures.filter(isRetryableFailure).length - retryableSightedIdentities.size),
        runtimeMs: Math.max(0, Math.round(performance.now() - startedAt)),
      };
      await this.recordStrategy(persistence, sourceUrl, {
        adapter: profile?.name ?? "static HTTP",
        requiresJs: false,
        success: listing.listingSnapshots.length > 0,
        latencyMs: metrics.runtimeMs ?? null,
        status,
        httpStatus: details.httpStatus ?? listing.httpStatus,
      });
      await onProgress?.({ pagesVisited: listing.listingSnapshots.length + details.snapshots.length, potentialPostingsInspected, internshipsDiscovered: deduplicatedJobs.length, completed: false, cacheHits, unchangedSkips, detailPagesFetched: details.snapshots.filter((snapshot) => !snapshot.fromCache).length, ...(metrics.newListings !== undefined ? { newListings: metrics.newListings } : {}), ...(metrics.changedListings !== undefined ? { changedListings: metrics.changedListings } : {}), duplicateListingsSkipped, irrelevantListingsSkipped });
      return {
        sourceUrl,
        pagesVisited: listing.listingSnapshots.length + details.snapshots.length,
        potentialPostingsInspected,
        jobs: deduplicatedJobs,
        failures,
        closedPages: [],
        completed: listing.listingSnapshots.length > 0,
        coverageComplete: status === "success",
        status,
        retrievalMethod: listing.retrievalMethod,
        attempts: listing.attempts + details.attempts,
        httpStatus: details.httpStatus ?? listing.httpStatus,
        directApplicationLinks: deduplicatedJobs.filter(({ internship }) => hasDirectApplicationUrl(sourceUrl, internship.applicationUrl)).length,
        retrievalMode: "configured_url",
        retrievalUrls: uniqueUrls([...listing.retrievalUrls, ...details.retrievalUrls]),
        ...(listing.notes.length > 0 || authenticationRequired ? { coverageNotes: [...listing.notes, ...(authenticationRequired ? ["Listings were retrieved, but the public application controls lead to InternInsider's /apply flow and require an account/session for direct submission."] : [])] } : {}),
        metrics,
      };
    } catch (error) {
      if (error instanceof HttpRequestError && error.statusCode === 403 && /wellfound\.com$/i.test(new URL(sourceUrl).hostname)) {
        try {
          const snapshot = await this.browser.fetchPage(sourceUrl, robotsDelayMs, sourceUrl);
          const jobs: AnalyzedJob[] = [];
          const rawJobs = extractJobs(snapshot);
          const preloadedJobrightDestinations = persistence?.getJobrightDestinations?.(sourceUrl) ?? null;
          const knownJobrightDestinations = new Map<string, string | null>();
          const jobrightCacheOnly = Boolean(persistence?.getJobrightDestinations);
          for (const rawJob of rawJobs) {
            const knownJobrightDestination = this.cachedJobrightDestination(
              sourceUrl,
              rawJob,
              persistence,
              knownJobrightDestinations,
              preloadedJobrightDestinations,
            );
            const resolver = this.resolverForRawJob(rawJob, sourceUrl, async (url: string) => url, knownJobrightDestination, jobrightCacheOnly);
            const analyzed = await this.analyzeJobWithProfile(rawJob, sourceUrl, resolver, snapshot.fetchedAt);
            if (analyzed.accepted) {
              const enriched: AnalyzedJob = { ...analyzed.value };
              if (snapshot.cacheMetadata) enriched.cacheMetadata = snapshot.cacheMetadata;
              jobs.push(enriched);
            }
          }
          const deduplicatedJobs = this.deduplicateJobsWithProfile(jobs, sourceUrl);
          const status = deduplicatedJobs.length > 0 ? "partial" : "access_denied";
          return {
            sourceUrl,
            pagesVisited: 1,
            potentialPostingsInspected: rawJobs.length,
            jobs: deduplicatedJobs,
            failures: deduplicatedJobs.length > 0 ? [] : [this.httpFailure(sourceUrl, error)],
            closedPages: [],
            completed: deduplicatedJobs.length > 0,
            coverageComplete: false,
            status,
            retrievalMethod: "normal browser fallback after HTTP 403",
            attempts: error.attempts + 1,
            httpStatus: error.statusCode,
            directApplicationLinks: deduplicatedJobs.filter(({ internship }) => hasDirectApplicationUrl(sourceUrl, internship.applicationUrl)).length,
            retrievalMode: "configured_url",
            retrievalUrls: [snapshot.url],
            coverageNotes: ["Wellfound returned HTTP 403 to HTTP retrieval; one normal browser attempt was made. No anti-bot evasion or repeated attack was attempted."],
            metrics: { browserNavigations: this.browser.navigations, detailPagesFetched: 1 },
          };
        } catch (browserError) {
          return this.restrictedHttpSource(sourceUrl, error, browserError);
        }
      }
      return this.restrictedHttpSource(sourceUrl, error);
    }
  }

  private restrictedHttpSource(sourceUrl: string, error: unknown, alternateError?: unknown): SourceCrawlResult {
    const httpError = error instanceof HttpRequestError ? error : null;
    const status = httpError?.statusCode === 429 ? "rate_limited"
      : httpError?.statusCode === 403 ? "access_denied"
        : "source_unavailable";
    const message = [
      httpError?.message ?? (error instanceof Error ? error.message : String(error)),
      alternateError
        ? `Normal browser fallback: ${alternateError instanceof Error ? alternateError.message : typeof alternateError === "string" ? alternateError : JSON.stringify(alternateError)}`
        : "",
    ].filter(Boolean).join(" ");
    const failureType = httpError?.errorType && !["robots_disallowed", "access_denied", "rate_limited"].includes(httpError.errorType)
      ? httpError.errorType
      : status === "access_denied" ? "access_denied" : status === "rate_limited" ? "rate_limited" : "http_error";
    return {
      sourceUrl,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: [{
        sourceUrl,
        url: sourceUrl,
        errorType: failureType,
        message,
        statusCode: httpError?.statusCode ?? null,
        retryCount: httpError?.attempts ?? 0,
        occurredAt: new Date().toISOString(),
      }],
      closedPages: [],
      completed: false,
      coverageComplete: false,
      status,
      retrievalMethod: "static HTTP unavailable",
      attempts: (httpError?.attempts ?? 0) + 1,
      httpStatus: httpError?.statusCode ?? null,
      directApplicationLinks: 0,
      retrievalMode: "configured_url",
      retrievalUrls: [sourceUrl],
      coverageNotes: ["The source was not interpreted as an empty job board because its content was unavailable."]
        .concat(status === "access_denied" ? ["Access was denied by the public endpoint; no CAPTCHA, proxy, TLS, or authentication bypass was attempted."] : []),
    };
  }

  private httpFailure(sourceUrl: string, error: HttpRequestError): FetchFailure {
    return {
      sourceUrl,
      url: sourceUrl,
      errorType: error.statusCode === 403 ? "access_denied" : error.statusCode === 429 ? "rate_limited" : error.errorType,
      message: error.message,
      statusCode: error.statusCode,
      retryCount: error.attempts,
      occurredAt: new Date().toISOString(),
    };
  }

  private stalledSourceFailure(sourceUrl: string, error: SourceStalledError): SourceCrawlResult {
    const failure: FetchFailure = {
      sourceUrl,
      url: sourceUrl,
      errorType: "timeout",
      message: error.message,
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    };
    return {
      sourceUrl,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: [failure],
      closedPages: [],
      completed: false,
      coverageComplete: false,
      status: "source_unavailable",
      retrievalMethod: "unavailable",
      attempts: 1,
      httpStatus: null,
      directApplicationLinks: 0,
      coverageNotes: [`The source stalled for ${error.stallMs}ms without progress; its deferred retry was exhausted, so the source was skipped and the crawl continued.`],
    };
  }

  private unexpectedSourceFailure(sourceUrl: string, error: unknown): SourceCrawlResult {
    const message = error instanceof Error ? error.message : String(error);
    const failure: FetchFailure = {
      sourceUrl,
      url: sourceUrl,
      errorType: "browser_error",
      message,
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    };
    return {
      sourceUrl,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: [failure],
      closedPages: [],
      completed: false,
      coverageComplete: false,
      status: "browser_error",
      retrievalMethod: "unavailable",
      attempts: 1,
      httpStatus: null,
      directApplicationLinks: 0,
    };
  }

  private failure(item: CrawlQueueItem, errorType: string, message: string, statusCode: number | null, retryCount: number): FetchFailure {
    return {
      sourceUrl: item.sourceUrl,
      url: item.url,
      errorType,
      message,
      statusCode,
      retryCount,
      occurredAt: new Date().toISOString(),
    };
  }
}
