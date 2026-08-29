import type { PageSnapshot } from "../../domain/types.js";
import { safeCanonicalizeUrl } from "../../utils/url.js";
import type { Logger } from "../../utils/logger.js";
import { HttpClient, type HttpResponseSnapshot } from "../http.js";
import { mapBounded } from "../staticAdapters.js";
import { snapshotFromStructuredJson } from "./static.js";
import { adapterFailure, type SourceAdapter, type SourceAdapterResult } from "./types.js";

interface GreenhouseJob {
  id?: unknown;
  absolute_url?: unknown;
  title?: unknown;
  content?: unknown;
  location?: unknown;
  updated_at?: unknown;
  metadata?: unknown;
}

interface GreenhouseResponse {
  jobs?: unknown;
  meta?: { total?: unknown; next?: unknown };
}

interface LeverPosting {
  id?: unknown;
  text?: unknown;
  description?: unknown;
  descriptionPlain?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  categories?: { location?: unknown; allLocations?: unknown };
  createdAt?: unknown;
  team?: unknown;
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function parseJsonBody(response: HttpResponseSnapshot): unknown {
  try { return JSON.parse(response.body) as unknown; } catch { return null; }
}

function sourceUrlForGreenhouse(sourceUrl: string): { board: string; jobId: string | null } | null {
  try {
    const url = new URL(sourceUrl);
    if (!/(?:^|\.)(?:boards|job-boards)\.greenhouse\.(?:io|com)$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    const boardIndex = parts.findIndex((part) => !/^(?:job-boards?|boards?)$/i.test(part));
    if (boardIndex < 0 || !parts[boardIndex]) return null;
    const board = parts[boardIndex];
    const jobIndex = parts.findIndex((part, index) => index > boardIndex && /^jobs?$/i.test(part));
    const jobId = jobIndex >= 0 ? stringValue(parts[jobIndex + 1]) : null;
    return { board, jobId };
  } catch {
    return null;
  }
}

function sourceUrlForLever(sourceUrl: string): { account: string; postingId: string | null } | null {
  try {
    const url = new URL(sourceUrl);
    if (!/(?:^|\.)jobs\.lever\.co$/i.test(url.hostname)) return null;
    const parts = url.pathname.split("/").filter(Boolean);
    if (!parts[0]) return null;
    return { account: parts[0], postingId: parts[1] ?? null };
  } catch {
    return null;
  }
}

function greenhouseSnapshot(response: HttpResponseSnapshot, job: GreenhouseJob, sourceUrl: string): PageSnapshot {
  const id = stringValue(job.id);
  const postingUrl = safeCanonicalizeUrl(stringValue(job.absolute_url) ?? (id ? `https://boards.greenhouse.io/${sourceUrlForGreenhouse(sourceUrl)?.board ?? ""}/jobs/${id}` : sourceUrl), sourceUrl) ?? sourceUrl;
  return snapshotFromStructuredJson(response, job, postingUrl);
}

function leverSnapshot(response: HttpResponseSnapshot, posting: LeverPosting, sourceUrl: string): PageSnapshot {
  const hosted = safeCanonicalizeUrl(stringValue(posting.hostedUrl) ?? sourceUrl, sourceUrl) ?? sourceUrl;
  return snapshotFromStructuredJson(response, posting, hosted);
}

function asGreenhouseJobs(value: unknown): GreenhouseJob[] {
  if (!value || typeof value !== "object") return [];
  const jobs = (value as GreenhouseResponse).jobs;
  return Array.isArray(jobs) ? jobs.filter((job): job is GreenhouseJob => Boolean(job && typeof job === "object")) : [];
}

function asLeverJobs(value: unknown): LeverPosting[] {
  return Array.isArray(value)
    ? value.filter((posting): posting is LeverPosting => Boolean(posting && typeof posting === "object"))
    : [];
}

export class GreenhouseAdapter implements SourceAdapter {
  public readonly name = "Greenhouse";
  public readonly strategy = "structured_endpoint" as const;

  public constructor(private readonly http: HttpClient, private readonly logger: Logger) {}

  public canHandle(sourceUrl: string): boolean {
    return sourceUrlForGreenhouse(sourceUrl) !== null;
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const parsed = sourceUrlForGreenhouse(sourceUrl);
    if (!parsed) return this.empty(sourceUrl, "Not a Greenhouse URL.");
    const base = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parsed.board)}/jobs`;
    const endpoint = parsed.jobId ? `${base}/${encodeURIComponent(parsed.jobId)}?content=true` : `${base}?content=true`;
    try {
      const response = await this.http.get(endpoint, { cache: true, headers: { accept: "application/json" } });
      const value = parseJsonBody(response);
      const jobs = parsed.jobId
        ? value && typeof value === "object" ? [value as GreenhouseJob] : []
        : asGreenhouseJobs(value);
      const snapshots = await mapBounded(jobs, 8, async (job) => greenhouseSnapshot(response, job, sourceUrl));
      const resolved = snapshots.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      this.logger.debug("ADAPTER", `Greenhouse ${parsed.board}: ${resolved.length} structured jobs`);
      return {
        snapshots: resolved,
        retrievalMethod: "Greenhouse public REST API",
        retrievalUrls: resolved.map(({ url }) => url),
        attempts: response.attempts,
        httpStatus: response.status,
        notes: [],
        failures: [],
        strategy: "structured_endpoint",
      };
    } catch (error) {
      return this.failure(sourceUrl, endpoint, error);
    }
  }

  private empty(sourceUrl: string, note: string): SourceAdapterResult {
    return { snapshots: [], retrievalMethod: "Greenhouse public REST API", retrievalUrls: [sourceUrl], attempts: 0, httpStatus: null, notes: [note], failures: [], strategy: "structured_endpoint" };
  }

  private failure(sourceUrl: string, endpoint: string, error: unknown): SourceAdapterResult {
    const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
    return { snapshots: [], retrievalMethod: "Greenhouse public REST API", retrievalUrls: [endpoint], attempts: error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0, httpStatus: statusCode, notes: [error instanceof Error ? error.message : String(error)], failures: [adapterFailure(sourceUrl, endpoint, error, statusCode)], strategy: "structured_endpoint" };
  }
}

export class LeverAdapter implements SourceAdapter {
  public readonly name = "Lever";
  public readonly strategy = "structured_endpoint" as const;

  public constructor(private readonly http: HttpClient, private readonly logger: Logger) {}

  public canHandle(sourceUrl: string): boolean {
    return sourceUrlForLever(sourceUrl) !== null;
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const parsed = sourceUrlForLever(sourceUrl);
    if (!parsed) return { snapshots: [], retrievalMethod: "Lever public postings API", retrievalUrls: [sourceUrl], attempts: 0, httpStatus: null, notes: ["Not a Lever URL."], failures: [], strategy: "structured_endpoint" };
    const base = `https://api.lever.co/v0/postings/${encodeURIComponent(parsed.account)}`;
    const endpoint = parsed.postingId ? `${base}/${encodeURIComponent(parsed.postingId)}?mode=json` : `${base}?mode=json`;
    try {
      const response = await this.http.get(endpoint, { cache: true, headers: { accept: "application/json" } });
      const value = parseJsonBody(response);
      const postings = parsed.postingId
        ? value && typeof value === "object" ? [value as LeverPosting] : []
        : asLeverJobs(value);
      const snapshots = postings.map((posting) => leverSnapshot(response, posting, sourceUrl));
      this.logger.debug("ADAPTER", `Lever ${parsed.account}: ${snapshots.length} structured jobs`);
      return {
        snapshots,
        retrievalMethod: "Lever public postings API",
        retrievalUrls: snapshots.map(({ url }) => url),
        attempts: response.attempts,
        httpStatus: response.status,
        notes: [],
        failures: [],
        strategy: "structured_endpoint",
      };
    } catch (error) {
      const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
      return { snapshots: [], retrievalMethod: "Lever public postings API", retrievalUrls: [endpoint], attempts: error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0, httpStatus: statusCode, notes: [error instanceof Error ? error.message : String(error)], failures: [adapterFailure(sourceUrl, endpoint, error, statusCode)], strategy: "structured_endpoint" };
    }
  }
}

/** Workday has no stable anonymous public JSON contract; keep it HTTP-first. */
export class WorkdayAdapter implements SourceAdapter {
  public readonly name = "Workday";
  public readonly strategy = "direct_http" as const;
  public constructor(private readonly http: HttpClient, private readonly logger: Logger) {}
  public canHandle(sourceUrl: string): boolean {
    try { return /myworkdayjobs\.com$/i.test(new URL(sourceUrl).hostname); } catch { return false; }
  }
  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    try {
      const response = await this.http.get(sourceUrl, { cache: true, headers: { accept: "text/html,application/xhtml+xml" } });
      this.logger.debug("ADAPTER", `Workday direct HTTP fetched ${sourceUrl}`);
      const { snapshotFromHttp } = await import("../staticAdapters.js");
      const snapshot = snapshotFromHttp(response);
      return { snapshots: [snapshot], retrievalMethod: "Workday direct HTTP", retrievalUrls: [snapshot.url], attempts: response.attempts, httpStatus: response.status, notes: [], failures: [], strategy: "direct_http" };
    } catch (error) {
      const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
      return { snapshots: [], retrievalMethod: "Workday direct HTTP", retrievalUrls: [sourceUrl], attempts: error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0, httpStatus: statusCode, notes: [error instanceof Error ? error.message : String(error)], failures: [adapterFailure(sourceUrl, sourceUrl, error, statusCode)], strategy: "direct_http" };
    }
  }
}
