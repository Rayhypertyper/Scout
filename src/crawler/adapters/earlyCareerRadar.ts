import type { LinkCandidate, PageSnapshot } from "../../domain/types.js";
import { canonicalizeUrl } from "../../utils/url.js";
import type { Logger } from "../../utils/logger.js";
import type { HttpClient, HttpResponseSnapshot } from "../http.js";
import { adapterFailure, type SourceAdapter, type SourceAdapterResult } from "./types.js";
import { isEarlyCareerRadarSource } from "../publicSources.js";
import { currentSourceAbortSignal } from "../../domain/cancellation.js";

/**
 * The public listing route is the source of truth for Radar's current client.
 * Its server response contains the complete `initialJobs` feed in a Next.js
 * React Server Components payload. The page's public API is robots-disallowed
 * for generic crawlers, so this adapter intentionally uses the page-native
 * server-rendered payload instead.
 */
export const EARLY_CAREER_RADAR_LISTING_URL = "https://earlycareerradar.com/summer-internships";

// Bound malformed or unexpectedly broad feeds before creating a synthetic
// listing snapshot or admitting detail work to the central crawler.
export const EARLY_CAREER_RADAR_MAX_FEED_JOBS = 5_000;

/** First-party data fallback used only when the listing markup changes. */
export const EARLY_CAREER_RADAR_API_URL = "https://earlycareerradar.com/api/jobs";

const EARLY_CAREER_RADAR_RSC_PREFIX = "self.__next_f.push([1,";
const EARLY_CAREER_RADAR_INITIAL_JOBS_MARKER = '"initialJobs":[';

export const EARLY_CAREER_RADAR_STUDENT_YEARS = [
  "1st year",
  "2nd year",
  "3rd year",
  "4th year",
  "Any undergraduate year",
  "Undergraduate — year not stated",
  "Graduate student",
  "New grad",
  "Not stated",
] as const;

type RadarStudentYear = typeof EARLY_CAREER_RADAR_STUDENT_YEARS[number];

const EARLY_CAREER_RADAR_COUNTRIES = [
  "Australia",
  "Austria",
  "Belgium",
  "Brazil",
  "Canada",
  "China",
  "Denmark",
  "France",
  "Germany",
  "Hong Kong",
  "India",
  "Ireland",
  "Israel",
  "Italy",
  "Japan",
  "Mexico",
  "Netherlands",
  "New Zealand",
  "Poland",
  "Portugal",
  "Singapore",
  "South Africa",
  "South Korea",
  "Spain",
  "Sweden",
  "Switzerland",
  "United Kingdom",
] as const;

const EARLY_CAREER_RADAR_US_STATE_NAMES = [
  "alabama",
  "alaska",
  "arizona",
  "arkansas",
  "california",
  "colorado",
  "connecticut",
  "delaware",
  "florida",
  "georgia",
  "hawaii",
  "idaho",
  "illinois",
  "indiana",
  "iowa",
  "kansas",
  "kentucky",
  "louisiana",
  "maine",
  "maryland",
  "massachusetts",
  "michigan",
  "minnesota",
  "mississippi",
  "missouri",
  "montana",
  "nebraska",
  "nevada",
  "new hampshire",
  "new jersey",
  "new mexico",
  "new york",
  "north carolina",
  "north dakota",
  "ohio",
  "oklahoma",
  "oregon",
  "pennsylvania",
  "rhode island",
  "south carolina",
  "south dakota",
  "tennessee",
  "texas",
  "utah",
  "vermont",
  "virginia",
  "washington",
  "west virginia",
  "wisconsin",
  "wyoming",
  "district of columbia",
] as const;

const EARLY_CAREER_RADAR_US_STATE_ABBREVIATIONS = /\b(?:al|ak|az|ar|ca|co|ct|de|fl|ga|hi|id|il|in|ia|ks|ky|la|me|md|ma|mi|mn|ms|mo|mt|ne|nv|nh|nj|nm|ny|nc|nd|oh|ok|or|pa|ri|sc|sd|tn|tx|ut|vt|va|wa|wv|wi|wy|dc)\b/i;

export interface EarlyCareerRadarJob {
  id: string;
  company: string;
  title: string;
  location: string;
  hub: string;
  studentYears?: string[];
  closed: boolean;
  applied: boolean;
  dismissed: boolean;
}

export interface EarlyCareerRadarFilters {
  locations: Set<string>;
  studentYears: Set<RadarStudentYear>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function locationValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(stringValue).filter((item): item is string => item !== null).join(" · ");
  return stringValue(value) ?? "";
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(stringValue).filter((item): item is string => item !== null);
}

function apiJob(value: unknown): EarlyCareerRadarJob | null {
  if (!isRecord(value)) return null;
  const id = stringValue(value.id);
  if (!id) return null;
  const studentYears = stringArray(value.studentYears);
  return {
    id,
    company: stringValue(value.company) ?? "Unknown company",
    title: stringValue(value.title) ?? "Internship opening",
    location: locationValue(value.location),
    hub: stringValue(value.hub) ?? "",
    ...(studentYears ? { studentYears } : {}),
    closed: value.closed === true,
    applied: value.applied === true,
    dismissed: value.dismissed === true,
  };
}

/** Parse normalized Radar job records without trusting arbitrary payloads. */
export function parseEarlyCareerRadarJobs(value: unknown): EarlyCareerRadarJob[] | null {
  if (!isRecord(value) || !Array.isArray(value.jobs)) return null;
  return value.jobs.map(apiJob).filter((job): job is EarlyCareerRadarJob => job !== null);
}

function bracketedJsonArray(payload: string, marker: string): unknown[] | null {
  const markerIndex = payload.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = markerIndex + marker.length - 1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < payload.length; index += 1) {
    const character = payload[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
      continue;
    }
    if (character === '"') quoted = true;
    else if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(payload.slice(start, index + 1)) as unknown;
        return Array.isArray(parsed) ? parsed : null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function nextFlightPayload(script: string): string | null {
  const text = script.trim();
  if (!text.startsWith(EARLY_CAREER_RADAR_RSC_PREFIX)) return null;
  const suffixLength = text.endsWith("]);") ? 3 : text.endsWith("])") ? 2 : 0;
  if (suffixLength === 0) return null;
  try {
    const encoded = JSON.parse(text.slice(EARLY_CAREER_RADAR_RSC_PREFIX.length, -suffixLength)) as unknown;
    return typeof encoded === "string" ? encoded : null;
  } catch {
    return null;
  }
}

/**
 * Extract the complete job feed embedded by the public Next.js page. This is
 * deliberately HTML-only: it does not execute the page or call undocumented
 * endpoints, and returns null when a browser-rendered path is required.
 */
export function parseEarlyCareerRadarEmbeddedJobs(html: string): EarlyCareerRadarJob[] | null {
  const scripts = html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? [];
  for (const script of scripts) {
    const content = script.replace(/^<script\b[^>]*>/i, "").replace(/<\/script>$/i, "");
    const payload = nextFlightPayload(content);
    if (!payload || !payload.includes(EARLY_CAREER_RADAR_INITIAL_JOBS_MARKER)) continue;
    const rawJobs = bracketedJsonArray(payload, EARLY_CAREER_RADAR_INITIAL_JOBS_MARKER);
    if (!rawJobs) continue;
    return parseEarlyCareerRadarJobs({ jobs: rawJobs });
  }
  return null;
}

function parseEarlyCareerRadarApiBody(body: string): EarlyCareerRadarJob[] | null {
  try {
    return parseEarlyCareerRadarJobs(JSON.parse(body) as unknown);
  } catch {
    return null;
  }
}

/** Match the location cleanup used by the page before any optional country filter. */
export function normalizeEarlyCareerRadarLocation(value: string): string {
  const text = value
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/<br\s*\/?\s*>/gi, " · ")
    .replace(/<[^>]+>/g, " ")
    .trim();
  if (!text || /^(?:n\/?a|unknown|not specified|-+)$/i.test(text)) return "Location not listed";

  const locations = new Map<string, string>();
  for (const segment of text.split(/\s+(?:·|\||;)\s+/)) {
    let location = segment.trim();
    if (!location) continue;
    location = location
      .replace(/\s+\+\s*(?:\d+\s*)?(?:more|locations?)?\.*$/i, "")
      .replace(/\bUnited States of America\b/gi, "United States")
      .replace(/\bU\.S\.A\.?\b|\bUSA\b/gi, "US")
      .replace(/\s*,\s*/g, ", ")
      .replace(/\s+/g, " ")
      .trim();
    const usLocation = location.match(/^(?:US|United States), ([^,]+), ([^,]+)$/i);
    if (usLocation) location = `${usLocation[2]}, ${usLocation[1]}, US`;
    const key = location.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (key && !locations.has(key)) locations.set(key, location);
  }
  return [...locations.values()].join(" · ") || "Location not listed";
}

/** Match the country classifier shipped in the public Radar page bundle. */
export function normalizeEarlyCareerRadarCountry(value: string): string {
  const location = normalizeEarlyCareerRadarLocation(value);
  const lower = location.toLowerCase();
  if (
    /united states|multiple us|multiple u\.s\.|\busa\b|\bu\.s\.\b/.test(lower)
    || EARLY_CAREER_RADAR_US_STATE_ABBREVIATIONS.test(location)
    || EARLY_CAREER_RADAR_US_STATE_NAMES.some((state) => lower.includes(state))
  ) return "United States";
  return EARLY_CAREER_RADAR_COUNTRIES.find((country) => lower.includes(country.toLowerCase())) ?? "Other / unspecified";
}

function isStudentYear(value: string): value is RadarStudentYear {
  return (EARLY_CAREER_RADAR_STUDENT_YEARS as readonly string[]).includes(value);
}

/** Decode the same `locations` and `years` query values used by the page. */
export function earlyCareerRadarFilters(sourceUrl: string): EarlyCareerRadarFilters {
  const url = new URL(sourceUrl);
  const locationsParam = url.searchParams.get("locations");
  const legacyCountry = url.searchParams.get("country");
  const locations = locationsParam === null
    // A bare source URL is the complete public feed. A country/location query
    // remains an explicit source-level selection, but US-only must never be
    // assumed by the adapter.
    ? legacyCountry ? new Set([`country:${legacyCountry}`]) : new Set(["all"])
    : new Set(locationsParam.split("|").filter(Boolean));
  const yearsParam = url.searchParams.get("years");
  const studentYears = new Set<RadarStudentYear>();
  const values = yearsParam === null ? EARLY_CAREER_RADAR_STUDENT_YEARS : yearsParam.split(",");
  for (const value of values) if (isStudentYear(value)) studentYears.add(value);
  return { locations, studentYears };
}

function locationMatches(job: EarlyCareerRadarJob, selectedLocations: Set<string>): boolean {
  if (selectedLocations.has("all")) return true;
  if (selectedLocations.size === 0) return false;
  const country = normalizeEarlyCareerRadarCountry(job.location);
  return [...selectedLocations].some((location) => {
    if (location === "us") return job.hub !== "International";
    if (location === "international") return job.hub === "International";
    if (location.startsWith("hub:")) return job.hub === location.slice(4);
    return location.startsWith("country:") && country === location.slice(8);
  });
}

/** Return the records that the requested Radar URL actually filters in. */
export function selectEarlyCareerRadarJobs(sourceUrl: string, jobs: readonly EarlyCareerRadarJob[]): EarlyCareerRadarJob[] {
  const filters = earlyCareerRadarFilters(sourceUrl);
  const yearsAreExplicit = new URL(sourceUrl).searchParams.has("years");
  return jobs.filter((job) => {
    const years = job.studentYears ?? ["Not stated"];
    return locationMatches(job, filters.locations)
      // With no explicit year query, the public feed is complete and unknown
      // student-year labels survive until normal analysis. A `years=` query
      // is a deliberate source-level filter with exact selected-year semantics.
      && (!yearsAreExplicit || years.some((year) => filters.studentYears.has(year as RadarStudentYear)));
  });
}

export function earlyCareerRadarDetailUrl(id: string): string {
  return canonicalizeUrl(`https://earlycareerradar.com/jobs/${encodeURIComponent(id)}`);
}

function feedSnapshot(
  response: HttpResponseSnapshot,
  sourceUrl: string,
  jobs: readonly EarlyCareerRadarJob[],
  html = response.body,
): PageSnapshot {
  const links = [...new Map(jobs.map((job) => {
    const url = earlyCareerRadarDetailUrl(job.id);
    return [url, {
      url,
      text: `${job.company} — ${job.title} internship opening`,
      rel: "early-career-radar-embedded-feed",
    } satisfies LinkCandidate];
  })).values()];
  const summary = jobs.map((job) => `${job.company} — ${job.title} — ${job.location}`).join("\n");
  const text = `Early Career Radar summer internship feed. ${jobs.length} retained internship openings.\n${summary}`;
  return {
    requestedUrl: sourceUrl,
    url: canonicalizeUrl(response.url),
    status: response.status,
    contentType: response.contentType || "text/html",
    title: "2027 Summer Internships | Internship Radar",
    html,
    text,
    links,
    attempts: response.attempts,
    fromCache: response.fromCache,
    fetchedAt: new Date().toISOString(),
  };
}

function browserRequiredResult(
  sourceUrl: string,
  listingUrl: string,
  response: HttpResponseSnapshot | null,
  error: unknown,
): SourceAdapterResult {
  const statusCode = response?.status ?? (error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null);
  return {
    snapshots: [],
    retrievalMethod: "Early Career Radar server-rendered HTML feed",
    retrievalUrls: [listingUrl],
    attempts: response?.attempts ?? (error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0),
    httpStatus: statusCode,
    notes: [error instanceof Error ? error.message : String(error)],
    failures: [adapterFailure(sourceUrl, listingUrl, error, statusCode)],
    strategy: "browser_required",
    browserRequired: true,
  };
}

function feedResult(
  sourceUrl: string,
  response: HttpResponseSnapshot,
  allJobs: readonly EarlyCareerRadarJob[],
  retrievalMethod: string,
  feedLabel: string,
): SourceAdapterResult {
  const selectedJobs = selectEarlyCareerRadarJobs(sourceUrl, allJobs);
  const limited = selectedJobs.length > EARLY_CAREER_RADAR_MAX_FEED_JOBS;
  const retainedJobs = selectedJobs.slice(0, EARLY_CAREER_RADAR_MAX_FEED_JOBS);
  const limitNote = `${feedLabel} matched ${selectedJobs.length} jobs, exceeding the safety limit of ${EARLY_CAREER_RADAR_MAX_FEED_JOBS}; only the bounded prefix was retained.`;
  const snapshot = feedSnapshot(
    response,
    sourceUrl,
    retainedJobs,
    limited ? `<html><body><h1>Early Career Radar internship feed</h1><p>${limitNote}</p></body></html>` : response.body,
  );
  return {
    snapshots: [snapshot],
    retrievalMethod,
    retrievalUrls: [snapshot.url],
    attempts: response.attempts,
    httpStatus: response.status,
    notes: [
      `${feedLabel} contained ${allJobs.length} jobs; ${selectedJobs.length} matched the source URL filters.`,
      ...(limited ? [limitNote] : []),
    ],
    failures: limited
      ? [{ ...adapterFailure(sourceUrl, response.url, new Error(limitNote), response.status), errorType: "source_limit" }]
      : [],
    strategy: "static_html",
  };
}

interface EarlyCareerRadarFeed {
  response: HttpResponseSnapshot;
  jobs: EarlyCareerRadarJob[];
}

/**
 * Early Career Radar's page is a slow client-side grouped view, but its
 * server-rendered HTML contains the complete `initialJobs` feed. Fetching and
 * parsing that first-party payload avoids sequential UI expansion while
 * preserving the page's own filter semantics.
 */
export class EarlyCareerRadarAdapter implements SourceAdapter {
  public readonly name = "Early Career Radar";
  public readonly strategy = "static_html" as const;

  // Share only in-flight first-party feed requests. Each caller still applies
  // its own URL filters, but an older schedule containing both the redirect
  // and canonical URLs cannot create a burst that provokes transient 403s.
  private listingFeedPromise: Promise<EarlyCareerRadarFeed> | null = null;
  private listingFeedSignal: AbortSignal | undefined;
  private apiFeedPromise: Promise<EarlyCareerRadarFeed> | null = null;
  private apiFeedSignal: AbortSignal | undefined;

  public constructor(private readonly http: HttpClient, private readonly logger: Logger) {}

  public canHandle(sourceUrl: string): boolean {
    return isEarlyCareerRadarSource(sourceUrl);
  }

  private loadListingFeed(sourceUrl: string): Promise<EarlyCareerRadarFeed> {
    const ownerSignal = currentSourceAbortSignal();
    if (this.listingFeedPromise && this.listingFeedSignal === ownerSignal && !ownerSignal?.aborted) return this.listingFeedPromise;
    if (this.listingFeedSignal?.aborted) {
      this.listingFeedPromise = null;
      this.listingFeedSignal = undefined;
    }
    const request = this.http.get(sourceUrl, {
      cache: false,
      headers: { accept: "text/html,application/xhtml+xml" },
      // The page owner explicitly authorized this source route. Keep the
      // exception scoped to this adapter; ordinary sources still enforce
      // robots.txt in the transport and crawler layers.
      respectRobots: false,
    }).then((response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Early Career Radar listing returned HTTP ${response.status}`);
      }
      const jobs = parseEarlyCareerRadarEmbeddedJobs(response.body);
      if (!jobs) throw new Error("Early Career Radar HTML did not contain a valid Next.js initialJobs feed");
      return { response, jobs };
    });
    const shared = request.finally(() => {
      if (this.listingFeedPromise === shared) {
        this.listingFeedPromise = null;
        this.listingFeedSignal = undefined;
      }
    });
    this.listingFeedPromise = shared;
    this.listingFeedSignal = ownerSignal;
    return shared;
  }

  private loadApiFeed(): Promise<EarlyCareerRadarFeed> {
    const ownerSignal = currentSourceAbortSignal();
    if (this.apiFeedPromise && this.apiFeedSignal === ownerSignal && !ownerSignal?.aborted) return this.apiFeedPromise;
    if (this.apiFeedSignal?.aborted) {
      this.apiFeedPromise = null;
      this.apiFeedSignal = undefined;
    }
    const request = this.http.get(EARLY_CAREER_RADAR_API_URL, {
      cache: false,
      headers: { accept: "application/json" },
      respectRobots: false,
    }).then((response) => {
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Early Career Radar API fallback returned HTTP ${response.status}`);
      }
      const jobs = parseEarlyCareerRadarApiBody(response.body);
      if (!jobs) throw new Error("Early Career Radar API fallback did not contain a valid jobs feed");
      return { response, jobs };
    });
    const shared = request.finally(() => {
      if (this.apiFeedPromise === shared) {
        this.apiFeedPromise = null;
        this.apiFeedSignal = undefined;
      }
    });
    this.apiFeedPromise = shared;
    this.apiFeedSignal = ownerSignal;
    return shared;
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    let listingResponse: HttpResponseSnapshot | null = null;
    let listingError: unknown;
    try {
      const feed = await this.loadListingFeed(sourceUrl);
      listingResponse = feed.response;
      const result = feedResult(
        sourceUrl,
        listingResponse,
        feed.jobs,
        "Early Career Radar server-rendered HTML (Next RSC embedded feed)",
        "Embedded HTML feed",
      );
      this.logger.debug("ADAPTER", `Early Career Radar embedded HTML: ${feed.jobs.length} source jobs parsed`);
      return result;
    } catch (error) {
      listingError = error;
    }

    // The HTML route is preferred because it is the page's source of truth.
    // If its Next payload shape changes, use the same page's first-party data
    // feed before falling back to a browser; the owner authorization applies
    // to this narrow source adapter and its canonical first-party host only.
    try {
      const feed = await this.loadApiFeed();
      const result = feedResult(
        sourceUrl,
        feed.response,
        feed.jobs,
        "Early Career Radar first-party data fallback",
        "First-party API fallback feed",
      );
      this.logger.debug("ADAPTER", `Early Career Radar API fallback: ${feed.jobs.length} source jobs parsed`);
      return result;
    } catch (apiError) {
      const detail = [listingError, apiError]
        .filter((value): value is Error => value instanceof Error)
        .map((value) => value.message)
        .join("; ");
      return browserRequiredResult(sourceUrl, sourceUrl, listingResponse, new Error(detail || "Early Career Radar feed unavailable"));
    }
  }
}
