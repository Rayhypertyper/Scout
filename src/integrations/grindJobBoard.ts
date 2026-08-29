import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { z } from "zod";

import { internshipContentHash } from "../classification/analyzeJob.js";
import { classifyRole } from "../classification/roleClassifier.js";
import type { AnalyzedJob } from "../domain/types.js";
import { InternshipSchema, type Internship } from "../domain/schemas.js";
import { parseLocations } from "../parsing/locations.js";
import { Semaphore, sleep } from "../utils/async.js";
import { canonicalizeUrl, safeCanonicalizeUrl } from "../utils/url.js";
import { composeAbortSignals, currentSourceAbortSignal, throwIfAborted } from "../domain/cancellation.js";

export const GRIND_JOB_BOARD_SOURCE_URL = "https://didtheboysgrindleetcodetoday.com/jobs";
export const DEFAULT_GRIND_JOB_BOARD_CONVEX_URL = "https://bright-shrimp-175.convex.cloud";
const GRIND_JOB_BOARD_USER_AGENT = "Internshipmatic/1.0";
const DEFAULT_GRIND_JOB_BOARD_RETRY_COUNT = 1;
const DEFAULT_GRIND_JOB_BOARD_RETRY_BACKOFF_MS = 100;

export interface GrindJobBoardFeed {
  company: string;
  moduleName: string;
}

export const GRIND_JOB_BOARD_FEEDS = [
  { company: "Garmin", moduleName: "garmin" },
  { company: "Amazon", moduleName: "amazon" },
  { company: "Microsoft", moduleName: "microsoft" },
  { company: "Atlassian", moduleName: "atlassian" },
  { company: "WellSky", moduleName: "wellsky" },
  { company: "T-Mobile", moduleName: "tmobile" },
  { company: "Google", moduleName: "google" },
  { company: "NVIDIA", moduleName: "nvidia" },
  { company: "Salesforce", moduleName: "salesforce" },
  { company: "Stripe", moduleName: "stripe_jobs" },
  { company: "Databricks", moduleName: "databricks" },
  { company: "Apple", moduleName: "apple" },
  { company: "OpenAI", moduleName: "openai" },
  { company: "Anthropic", moduleName: "anthropic" },
  { company: "OPPD", moduleName: "oppd" },
  { company: "H&R Block", moduleName: "hrblock" },
  { company: "Netsmart", moduleName: "netsmart" },
  { company: "GM", moduleName: "gm" },
  { company: "Pinterest", moduleName: "pinterest" },
  { company: "Airbnb", moduleName: "airbnb" },
  { company: "Datadog", moduleName: "datadog" },
  { company: "Duolingo", moduleName: "duolingo" },
  { company: "Discord", moduleName: "discord" },
  { company: "Uber", moduleName: "uber" },
  { company: "Adobe", moduleName: "adobe" },
  { company: "Netflix", moduleName: "netflix" },
  { company: "Roblox", moduleName: "roblox" },
  { company: "DoorDash", moduleName: "doordash" },
  { company: "Coinbase", moduleName: "coinbase" },
  { company: "Jane Street", moduleName: "janestreet" },
] as const;

export function isGrindJobBoardSource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.hostname.replace(/^www\./i, "") === "didtheboysgrindleetcodetoday.com"
      && ["", "/", "/jobs"].includes(url.pathname.replace(/\/+$/, ""));
  } catch {
    return false;
  }
}

const GrindJobSchema = z.object({
  id: z.string().min(1),
  company: z.string().min(1),
  title: z.string().min(1),
  location: z.string().nullable(),
  link: z.url(),
  firstSeen: z.iso.datetime(),
  jobId: z.string().min(1),
});

const RawGrindJobSchema = z.object({
  firstSeen: z.iso.datetime(),
  jobId: z.string().min(1),
  link: z.url(),
  location: z.string().nullable().optional(),
  title: z.string().min(1),
});

const QueryEnvelopeSchema = z.object({
  status: z.string(),
  value: z.unknown().optional(),
  errorMessage: z.string().optional(),
});

export interface GrindJob {
  id: string;
  company: string;
  title: string;
  location: string | null;
  link: string;
  firstSeen: string;
  jobId: string;
}

export interface GrindJobBoardFailure {
  company: string;
  moduleName: string;
  message: string;
  statusCode?: number | null;
}

export type GrindJobBoardStatus = "ready" | "partial" | "stale" | "unavailable";

export interface GrindJobBoardSnapshot {
  sourceUrl: string;
  status: GrindJobBoardStatus;
  jobs: GrindJob[];
  jobCount: number;
  freshCount: number;
  companyCount: number;
  companiesSynced: number;
  companiesRefreshed: number;
  lastAttemptAt: string | null;
  lastSuccessfulSyncAt: string | null;
  cacheTtlMinutes: number;
  attempts: number;
  retrievalUrl: string;
  failures: GrindJobBoardFailure[];
}

export interface GrindJobBoardClientOptions {
  cacheTtlMs?: number;
  cachePath?: string;
  concurrency?: number;
  convexUrl?: string;
  fetchImpl?: typeof fetch;
  retryBackoffMs?: number;
  retryCount?: number;
  now?: () => number;
  requestTimeoutMs?: number;
  cancellationSignal?: AbortSignal;
}

const GrindJobBoardCacheSchema = z.object({
  version: z.literal(1),
  convexUrl: z.url().optional(),
  lastSuccessfulSyncAt: z.iso.datetime().nullable().optional(),
  jobsByCompany: z.record(z.string(), z.array(GrindJobSchema)),
});

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").trim().slice(0, 300) || "Unknown feed error";
}

export class GrindJobBoardClient {
  private readonly cacheTtlMs: number;
  private readonly cachePath: string | null;
  private readonly concurrency: number;
  private readonly retryBackoffMs: number;
  private readonly retryCount: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly cancellationSignal: AbortSignal | undefined;
  private readonly jobsByCompany = new Map<string, GrindJob[]>();
  private convexUrl: string;
  private cacheExpiresAt = 0;
  private inFlight: Promise<GrindJobBoardSnapshot> | null = null;
  private inFlightSignal: AbortSignal | undefined;
  private lastAttemptAt: string | null = null;
  private lastSuccessfulSyncAt: string | null = null;
  private lastStatus: GrindJobBoardStatus = "unavailable";
  private companiesRefreshed = 0;
  private attempts = 0;
  private failures: GrindJobBoardFailure[] = [];

  public constructor(options: GrindJobBoardClientOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.cachePath = options.cachePath ?? null;
    this.concurrency = options.concurrency ?? 6;
    this.retryBackoffMs = Math.max(0, options.retryBackoffMs ?? DEFAULT_GRIND_JOB_BOARD_RETRY_BACKOFF_MS);
    this.retryCount = Math.max(0, options.retryCount ?? DEFAULT_GRIND_JOB_BOARD_RETRY_COUNT);
    this.convexUrl = normalizeConvexUrl(
      options.convexUrl?.trim()
        || process.env.GRIND_JOB_BOARD_CONVEX_URL?.trim()
        || DEFAULT_GRIND_JOB_BOARD_CONVEX_URL,
    );
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
    this.cancellationSignal = options.cancellationSignal;
    this.loadCache();
  }

  private activeSignal(): AbortSignal | undefined {
    return composeAbortSignals(this.cancellationSignal, currentSourceAbortSignal());
  }

  private requestSignal(): AbortSignal {
    const crawl = this.activeSignal();
    return crawl
      ? AbortSignal.any([AbortSignal.timeout(this.requestTimeoutMs), crawl])
      : AbortSignal.timeout(this.requestTimeoutMs);
  }

  private throwIfCrawlAborted(): void {
    throwIfAborted(this.activeSignal());
  }

  public async getSnapshot(forceRefresh = false): Promise<GrindJobBoardSnapshot> {
    if (!forceRefresh && this.now() < this.cacheExpiresAt && this.lastAttemptAt !== null) {
      return this.buildSnapshot();
    }
    const ownerSignal = currentSourceAbortSignal();
    if (this.inFlight !== null && this.inFlightSignal === ownerSignal && !this.inFlightSignal?.aborted) {
      return this.inFlight;
    }
    if (this.inFlightSignal?.aborted) {
      this.inFlight = null;
      this.inFlightSignal = undefined;
    }
    // A separate source must not inherit an in-flight refresh owned by a
    // source that can be aborted independently. It gets its own bounded
    // request batch instead.

    const refresh: Promise<GrindJobBoardSnapshot> = this.refresh();
    const shared = refresh.finally(() => {
      if (this.inFlight === shared) {
        this.inFlight = null;
        this.inFlightSignal = undefined;
      }
    });
    this.inFlight = shared;
    this.inFlightSignal = ownerSignal;
    return shared;
  }

  /**
   * Return the last-known board without starting network work.
   *
   * The dashboard uses this for stale-while-revalidate responses so a slow or
   * unavailable board never blocks an otherwise local dashboard load.
   */
  public getCachedSnapshot(): GrindJobBoardSnapshot {
    return this.buildSnapshot();
  }

  public isSnapshotFresh(): boolean {
    return this.lastAttemptAt !== null && this.now() < this.cacheExpiresAt;
  }

  private async refresh(): Promise<GrindJobBoardSnapshot> {
    throwIfAborted(this.activeSignal());
    this.attempts = 0;
    const semaphore = new Semaphore(this.concurrency);
    let results = await this.fetchFeeds(semaphore, GRIND_JOB_BOARD_FEEDS);
    // The board is a Next.js app and keeps its Convex host in a first-party
    // bundle. If the configured host ever rotates, rediscover it from that
    // bundle and retry the same bounded feed batch once. Normal runs stay at
    // one batch of 30 API requests.
    if (results.every(({ jobs }) => jobs === null)) {
      const discoveredConvexUrl = await this.discoverConvexUrl();
      if (discoveredConvexUrl && discoveredConvexUrl !== this.convexUrl) {
        this.convexUrl = discoveredConvexUrl;
        results = await this.fetchFeeds(semaphore, GRIND_JOB_BOARD_FEEDS);
      }
    }

    const failures: GrindJobBoardFailure[] = [];
    let companiesRefreshed = 0;
    for (const result of results) {
      throwIfAborted(this.activeSignal());
      if (result.jobs === null) {
        failures.push({
          company: result.feed.company,
          moduleName: result.feed.moduleName,
          message: result.error ?? "Unknown feed error",
          statusCode: result.statusCode,
        });
        continue;
      }
      companiesRefreshed += 1;
      this.jobsByCompany.set(result.feed.company, result.jobs);
    }

    const now = this.now();
    this.lastAttemptAt = new Date(now).toISOString();
    if (companiesRefreshed > 0) this.lastSuccessfulSyncAt = this.lastAttemptAt;
    this.cacheExpiresAt = now + this.cacheTtlMs;
    this.companiesRefreshed = companiesRefreshed;
    this.failures = failures;
    this.lastStatus = failures.length === 0
      ? "ready"
      : companiesRefreshed > 0
        ? "partial"
        : this.jobsByCompany.size > 0
          ? "stale"
          : "unavailable";
    if (companiesRefreshed > 0) await this.persistCache();
    return this.buildSnapshot();
  }

  private async fetchFeeds(
    semaphore: Semaphore,
    feeds: readonly GrindJobBoardFeed[],
  ): Promise<Array<{ feed: GrindJobBoardFeed; jobs: GrindJob[] | null; error: string | null; statusCode: number | null }>> {
    return Promise.all(feeds.map(async (feed) => (
      semaphore.use(async () => {
        try {
          throwIfAborted(this.activeSignal());
          return { feed, jobs: await this.fetchFeed(feed.company, feed.moduleName), error: null, statusCode: null };
        } catch (error) {
          this.throwIfCrawlAborted();

          return {
            feed,
            jobs: null,
            error: errorMessage(error),
            statusCode: errorStatusCode(error),
          };
        }
      }, this.activeSignal())
    )));
  }

  private async fetchFeed(company: string, moduleName: string): Promise<GrindJob[]> {
    let lastError: unknown = new Error(`${company} feed failed without a response`);
    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      throwIfAborted(this.activeSignal());
      this.attempts += 1;
      try {
        const response = await this.fetchImpl(`${this.convexUrl}/api/query`, {
          method: "POST",
          headers: {
            "Accept": "application/json",
            "Content-Type": "application/json",
            "User-Agent": GRIND_JOB_BOARD_USER_AGENT,
          },
          body: JSON.stringify({ path: `${moduleName}:getJobs`, args: {}, format: "json" }),
          signal: this.requestSignal(),
        });
        if (!response.ok) throw feedError(`${company} feed returned HTTP ${response.status}`, response.status);

        const payload = (await response.json()) as unknown;
        const envelope = QueryEnvelopeSchema.parse(payload);
        if (envelope.status !== "success") {
          throw new Error(envelope.errorMessage ?? `${company} feed returned ${envelope.status}`);
        }
        const jobs = z.array(RawGrindJobSchema).nullable().parse(envelope.value) ?? [];
        return jobs.map((job) => ({
          id: `${moduleName}:${job.jobId}`,
          company,
          title: job.title.trim(),
          location: job.location?.trim() || null,
          link: safeCanonicalizeUrl(job.link) ?? job.link,
          firstSeen: job.firstSeen,
          jobId: job.jobId,
        }));
      } catch (error) {
        this.throwIfCrawlAborted();
        lastError = error;
        if (!isRetryableFeedError(error) || attempt >= this.retryCount) break;
        await sleep(this.retryBackoffMs * (2 ** attempt), this.activeSignal());
      }
    }
    throw lastError;
  }

  private async discoverConvexUrl(): Promise<string | null> {
    throwIfAborted(this.activeSignal());
    try {
      const response = await this.fetchImpl(GRIND_JOB_BOARD_SOURCE_URL, {
        headers: { Accept: "text/html", "User-Agent": GRIND_JOB_BOARD_USER_AGENT },
        signal: this.requestSignal(),
      });
      if (!response.ok) return null;
      const html = await response.text();
      const scripts = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)]
        .map((match) => match[1])
        .filter((value): value is string => Boolean(value))
        .map((value) => new URL(value, GRIND_JOB_BOARD_SOURCE_URL).toString());
      const orderedScripts = [
        ...scripts.filter((script) => /(?:^|\/)layout(?:[-./]|$)/i.test(script)),
        ...scripts.filter((script) => !/(?:^|\/)layout(?:[-./]|$)/i.test(script)),
      ].slice(0, 16);
      const semaphore = new Semaphore(4);
      const scriptBodies = await Promise.all(orderedScripts.map((script) => semaphore.use(async () => {
        try {
          throwIfAborted(this.activeSignal());
          const scriptResponse = await this.fetchImpl(script, {
            headers: { Accept: "text/javascript", "User-Agent": GRIND_JOB_BOARD_USER_AGENT },
            signal: this.requestSignal(),
          });
          return scriptResponse.ok ? await scriptResponse.text() : "";
        } catch {
          this.throwIfCrawlAborted();

          return "";
        }
      }, this.activeSignal())));
      const candidates = [...new Set([html, ...scriptBodies].flatMap((body) => [
        ...body.matchAll(/https:\/\/[a-z0-9.-]+\.convex\.cloud/gi),
      ].map((match) => match[0])))].map(normalizeConvexUrl);
      return candidates.find((candidate) => !/docs\.convex\.cloud$/i.test(candidate)) ?? null;
    } catch {
      this.throwIfCrawlAborted();
      return null;
    }
  }

  private loadCache(): void {
    if (!this.cachePath) return;
    try {
      const payload = GrindJobBoardCacheSchema.parse(JSON.parse(readFileSync(this.cachePath, "utf8")) as unknown);
      for (const [company, jobs] of Object.entries(payload.jobsByCompany)) this.jobsByCompany.set(company, jobs);
      if (payload.convexUrl) this.convexUrl = normalizeConvexUrl(payload.convexUrl);
      this.lastSuccessfulSyncAt = payload.lastSuccessfulSyncAt ?? null;
      if (this.jobsByCompany.size > 0) this.lastStatus = "stale";
    } catch {
      // A corrupt or partial cache must never prevent a fresh board sync.
    }
  }

  private async persistCache(): Promise<void> {
    if (!this.cachePath) return;
    const temporaryPath = `${this.cachePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(temporaryPath, JSON.stringify({
        version: 1,
        convexUrl: this.convexUrl,
        lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
        jobsByCompany: Object.fromEntries(this.jobsByCompany),
      }), "utf8");
      await rename(temporaryPath, this.cachePath);
    } catch {
      // Cache persistence is best effort; the live response remains valid.
    }
  }

  private buildSnapshot(): GrindJobBoardSnapshot {
    const byLink = new Map<string, GrindJob>();
    for (const jobs of this.jobsByCompany.values()) {
      for (const job of jobs) {
        const current = byLink.get(job.link);
        if (current === undefined || Date.parse(job.firstSeen) > Date.parse(current.firstSeen)) {
          byLink.set(job.link, job);
        }
      }
    }
    const jobs = [...byLink.values()].sort((left, right) => (
      Date.parse(right.firstSeen) - Date.parse(left.firstSeen)
      || left.company.localeCompare(right.company)
      || left.title.localeCompare(right.title)
    ));
    const freshThreshold = this.now() - 48 * 60 * 60_000;
    return {
      sourceUrl: GRIND_JOB_BOARD_SOURCE_URL,
      status: this.lastStatus,
      jobs,
      jobCount: jobs.length,
      freshCount: jobs.filter((job) => Date.parse(job.firstSeen) >= freshThreshold).length,
      companyCount: GRIND_JOB_BOARD_FEEDS.length,
      companiesSynced: this.jobsByCompany.size,
      companiesRefreshed: this.companiesRefreshed,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      cacheTtlMinutes: Math.max(1, Math.round(this.cacheTtlMs / 60_000)),
      attempts: this.attempts,
      retrievalUrl: `${this.convexUrl}/api/query`,
      failures: this.failures,
    };
  }
}

function normalizeConvexUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function feedError(message: string, statusCode: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = statusCode;
  return error;
}

function errorStatusCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("statusCode" in error)) return null;
  const statusCode = (error as { statusCode?: unknown }).statusCode;
  return typeof statusCode === "number" ? statusCode : null;
}

function isRetryableFeedError(error: unknown): boolean {
  const statusCode = errorStatusCode(error);
  if (statusCode !== null) return statusCode === 408 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
  return /(?:fetch failed|timeout|timed out|econnreset|eai_again|socket|network)/i.test(errorMessage(error));
}

export function grindJobToInternship(
  job: GrindJob,
  sourceUrl = GRIND_JOB_BOARD_SOURCE_URL,
  verifiedAt = new Date().toISOString(),
): Internship {
  const locations = parseLocations(job.location ? [job.location] : []);
  const classification = classifyRole(job.title, "", "", job.location ?? "");
  const canonicalLink = safeCanonicalizeUrl(job.link) ?? job.link;
  return InternshipSchema.parse({
    id: `grind:${job.id}`,
    jobId: job.jobId,
    company: job.company,
    title: job.title,
    location: locations.raw,
    normalizedLocations: locations.normalized,
    remoteStatus: locations.remoteStatus,
    applicationUrl: canonicalLink,
    postingUrl: canonicalLink,
    sourceUrl,
    sources: [sourceUrl],
    description: "",
    responsibilities: [],
    requiredQualifications: [],
    preferredQualifications: [],
    technologies: classification.technologies,
    educationRequirements: [],
    graduationRequirements: [],
    experienceRequirements: [],
    workAuthorizationRequirements: [],
    sponsorshipInformation: null,
    internshipTerm: null,
    internshipYear: null,
    duration: null,
    salary: null,
    postingDate: null,
    deadline: null,
    categories: classification.categories.length > 0 ? classification.categories : ["other-code"],
    relevanceScore: classification.score,
    relevanceReason: `Live source board title match. ${classification.reason}`,
    lifecycleStatus: "NEW",
    availabilityStatus: "open",
    discoveredAt: job.firstSeen,
    lastVerifiedAt: verifiedAt,
  });
}

export function grindJobToAnalyzedJob(
  job: GrindJob,
  sourceUrl = GRIND_JOB_BOARD_SOURCE_URL,
  verifiedAt = new Date().toISOString(),
): AnalyzedJob {
  const internship = grindJobToInternship(job, sourceUrl, verifiedAt);
  return {
    internship,
    contentHash: internshipContentHash(internship),
    cacheMetadata: {
      canonicalUrl: canonicalizeUrl(job.link),
      externalJobId: job.jobId,
      providerIdentity: `grind:${job.company}`,
    },
  };
}
