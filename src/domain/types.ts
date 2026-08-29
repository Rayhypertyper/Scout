import type { Category, Internship, LifecycleStatus, ScoutSettings } from "./schemas.js";
import type { ProfilerSnapshot } from "../observability/profiler.js";

export interface LinkCandidate {
  url: string;
  text: string;
  rel: string;
}

export interface PageSnapshot {
  requestedUrl: string;
  url: string;
  status: number;
  contentType: string;
  title: string;
  html: string;
  text: string;
  links: LinkCandidate[];
  attempts?: number;
  browserContextId?: string;
  networkResponses?: NetworkResponseSnapshot[];
  /** HTTP validators retained for listing-stage incremental decisions. */
  cacheMetadata?: ListingCacheMetadata;
  fromCache?: boolean;
  /** True when a transient transport failure caused an expired cache entry to be used. */
  stale?: boolean;
  fetchedAt: string;
}

export interface NetworkResponseSnapshot {
  url: string;
  status: number;
  contentType: string;
  body: string;
}

export interface CrawlQueueItem {
  url: string;
  sourceUrl: string;
  referrerUrl: string | null;
  depth: number;
  priority: number;
  reason: string;
}

export interface RawJob {
  company?: string | undefined;
  title?: string | undefined;
  locations?: string[] | undefined;
  description?: string | undefined;
  responsibilities?: string[] | undefined;
  requiredQualifications?: string[] | undefined;
  preferredQualifications?: string[] | undefined;
  applicationUrl?: string | undefined;
  postingUrl: string;
  jobId?: string | undefined;
  salary?: string | undefined;
  postingDate?: string | undefined;
  deadline?: string | undefined;
  sourceProvider: string;
}

export interface AnalyzedJob {
  internship: Internship;
  contentHash: string;
  /** HTTP cache validators captured while retrieving the listing/detail page. */
  cacheMetadata?: ListingCacheMetadata;
}

/** Validators and retrieval hints that let a later crawl avoid detail parsing. */
export interface ListingCacheMetadata {
  etag?: string | null;
  lastModified?: string | null;
  canonicalUrl?: string | null;
  externalJobId?: string | null;
  providerIdentity?: string | null;
}

export type CrawlStateDisposition = "new" | "unchanged" | "possibly_changed" | "closed" | "retryable" | "failed";

/** Indexed, payload-free state returned to listing-stage fast paths. */
export interface CrawlStateRecord {
  sourceUrl: string;
  sourceId: number;
  internshipId: string;
  canonicalUrl: string;
  applicationUrl: string;
  postingUrl: string;
  externalJobId: string | null;
  providerIdentity: string | null;
  company: string;
  title: string;
  contentHash: string;
  firstSeenAt: string;
  lastSeenAt: string;
  lastCheckedAt: string;
  lastVerifiedAt: string;
  etag: string | null;
  lastModified: string | null;
  lifecycleStatus: LifecycleStatus;
  availabilityStatus: "open" | "closed" | "unknown";
  failureState: "none" | "retryable" | "permanent";
  failureCount: number;
  lastFailureAt: string | null;
  lastFailureMessage: string | null;
  missCount: number;
  /** Full payload is available when the caller needs to emit an unchanged job. */
  internship: Internship | null;
  sourceProvenance: string[];
}

export interface ListingIdentityHint {
  canonicalUrl?: string | null;
  applicationUrl?: string | null;
  postingUrl?: string | null;
  externalJobId?: string | null;
  providerIdentity?: string | null;
  contentHash?: string | null;
  etag?: string | null;
  lastModified?: string | null;
}

export interface CrawlStateDecision {
  disposition: CrawlStateDisposition;
  record: CrawlStateRecord | null;
  /** True when validators match and the detail payload may be safely skipped. */
  validatorsMatch: boolean;
  reason: string;
}

export interface LightweightSighting extends ListingIdentityHint {
  sourceUrl: string;
  state: CrawlStateDisposition;
  seenAt?: string;
  checkedAt?: string;
  observedOpen?: boolean;
  provenance?: Record<string, unknown>;
}

export interface SourceStrategyState {
  sourceUrl: string;
  sourceId: number;
  adapter: string | null;
  requiresJs: boolean;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  failureCount: number;
  consecutiveFailureCount: number;
  averageLatencyMs: number | null;
  latencySamples: number;
  lastStatus: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  metadata: Record<string, unknown>;
  updatedAt: string;
}

export interface SourceStrategyPatch {
  adapter?: string | null;
  requiresJs?: boolean;
  success?: boolean;
  latencyMs?: number | null;
  status?: string | null;
  httpStatus?: number | null;
  error?: string | null;
  metadata?: Record<string, unknown>;
  occurredAt?: string;
}

export interface CrawlMetrics {
  cacheHits?: number;
  unchangedSkips?: number;
  newListings?: number;
  changedListings?: number;
  retryableFailures?: number;
  detailPagesFetched?: number;
  duplicateListingsSkipped?: number;
  irrelevantListingsSkipped?: number;
  httpRequests?: number;
  browserNavigations?: number;
  [metric: string]: number | undefined;
}

export interface FetchFailure {
  sourceUrl: string;
  url: string;
  errorType: string;
  message: string;
  statusCode: number | null;
  retryCount: number;
  occurredAt: string;
}

export interface ClosedPage {
  url: string;
  reason: string;
  statusCode: number | null;
}

export type SourceStatus =
  | "success"
  | "partial"
  | "rate_limited"
  | "access_denied"
  | "robots_disallowed"
  | "authentication_required"
  | "browser_error"
  | "parse_error"
  | "source_unavailable"
  | "no_internships_found";

export interface SourceCrawlResult {
  sourceUrl: string;
  /** Wall-clock timestamp when this source's crawl began. */
  startedAt?: string;
  /** Wall-clock time from starting this source until its crawl work settles. */
  durationMs?: number;
  pagesVisited: number;
  potentialPostingsInspected: number;
  /** Count retained after incremental persistence releases the full payload. */
  jobsDiscovered?: number;
  jobs: AnalyzedJob[];
  failures: FetchFailure[];
  closedPages: ClosedPage[];
  completed: boolean;
  coverageComplete: boolean;
  status?: SourceStatus;
  retrievalMethod?: string;
  attempts?: number;
  httpStatus?: number | null;
  directApplicationLinks?: number;
  retrievalMode?: "configured_url" | "public_alternate";
  retrievalUrls?: string[];
  coverageNotes?: string[];
  metrics?: CrawlMetrics;
}

export interface CrawlProgress {
  sourcesSettled: number;
  sourcesCompleted: number;
  pagesVisited: number;
  potentialPostingsInspected: number;
  internshipsDiscovered: number;
  cacheHits?: number;
  unchangedSkips?: number;
  detailPagesFetched?: number;
  newListings?: number;
  changedListings?: number;
  duplicateListingsSkipped?: number;
  irrelevantListingsSkipped?: number;
}

export interface CrawlResult {
  sourcesRequested: number;
  sourcesCompleted: number;
  sourcesSuccessful: number;
  sourcesPartiallyCompleted: number;
  sourcesFailed: number;
  pagesVisited: number;
  potentialPostingsInspected: number;
  /** Count retained after incremental persistence releases the full payload. */
  jobsDiscovered?: number;
  jobs: AnalyzedJob[];
  failures: FetchFailure[];
  closedPages: ClosedPage[];
  completedSourceUrls: string[];
  sourceResults: SourceCrawlResult[];
  runtimeMs?: number;
  metrics?: CrawlMetrics;
  profiling?: ProfilerSnapshot;
}

export interface PersistedRunResult {
  runId: number;
  internships: Internship[];
  counts: Record<LifecycleStatus, number>;
}

export interface ScoutRunOptions {
  sources: string[];
  settings: ScoutSettings;
  /** Optional owner-controlled signal used by the dashboard to stop a local crawl immediately. */
  cancellationSignal?: AbortSignal;
  /** Called as soon as the crawl_runs row exists, before sources start. */
  onRunStarted?: (runId: number) => void;
  /** Called when an individual source begins, before its durable start row commits. */
  onSourceStarted?: (sourceUrl: string, startedAt: string) => void;
  /** Called after a source result has been durably persisted. */
  onSourceSettled?: (sourceUrl: string) => void;
  /** Called after the crawl's durable completion transaction commits. */
  onRunCommitted?: (runId: number) => void;
  filters: {
    location?: string | undefined;
    categories: Category[];
    newOnly: boolean;
    minScore: number;
  };
}
