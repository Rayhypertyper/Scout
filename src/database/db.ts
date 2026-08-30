import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { internshipContentHash } from "../classification/analyzeJob.js";
import {
  conflictingDirectJobIds,
  internshipQuality,
  mergeInternships,
  providerJobIdentityKeys,
} from "../deduplication/deduplicate.js";
import {
  backfillListingActionIdentities,
  ensureListingActionSchema,
  listingActionKey,
  mergeListingActionContext,
  type ListingAction,
  type ListingActionContext,
  type ListingActionRecord,
  type ListingType,
  replaceListingActionIdentities,
} from "./actions.js";
import { activeRunMaxDurationMs, RUNNING_SCAN_MAX_AGE_MS } from "../config/runLock.js";
import { MIN_LISTING_SCORE } from "../config/thresholds.js";
import type {
  CrawlMetrics,
  CrawlProgress,
  CrawlResult,
  CrawlStateDecision,
  CrawlStateRecord,
  LightweightSighting,
  ListingCacheMetadata,
  ListingIdentityHint,
  PersistedRunResult,
  ScoutRunOptions,
  SourceStrategyPatch,
  SourceStrategyState,
} from "../domain/types.js";
import { InternshipSchema, normalizeCategory, type Internship, type LifecycleStatus } from "../domain/schemas.js";
import { normalizeCompanyIdentity, normalizeIdentity, normalizeRoleIdentity, uniqueStrings } from "../utils/text.js";
import { canonicalizeUrl, isAggregatorUrl, isCompanyLandingUrl, isJobrightUrl, normalizedJobUrl } from "../utils/url.js";
import { DATABASE_SCHEMA } from "./schema.js";
import { CrawlCancelledError } from "../domain/cancellation.js";

interface InternshipRow {
  id: string;
  job_id: string | null;
  company: string;
  normalized_company: string;
  title: string;
  normalized_title: string;
  location_key: string;
  application_url: string;
  posting_url: string;
  payload_json: string;
  content_hash: string;
  lifecycle_status: LifecycleStatus;
  availability_status: "open" | "closed" | "unknown";
  first_seen_at: string;
  last_seen_at: string;
  last_verified_at: string;
  last_seen_run_id: number;
  status_run_id: number;
  miss_count: number;
  canonical_url: string | null;
  canonical_application_url: string | null;
  canonical_posting_url: string | null;
  external_job_id: string | null;
  provider_identity: string | null;
  last_checked_at: string | null;
  etag: string | null;
  last_modified: string | null;
  failure_state: "none" | "retryable" | "permanent";
  failure_count: number;
  last_failure_at: string | null;
  last_failure_message: string | null;
}

interface CrawlStateRow extends InternshipRow {
  source_url: string;
  source_id: number;
  source_provenance?: string | null;
}

interface SourceRow {
  id: number;
  url: string;
}

export interface ConfiguredSourceRecord {
  url: string;
  createdAt: string;
  isConfigured: true;
  created: boolean;
}

interface ListingActionRow {
  listing_key: string;
  listing_type: ListingType;
  listing_id: string;
  action: ListingAction;
  company: string;
  title: string;
  created_at: string;
}

/** A second scheduler may legitimately observe an active crawl. */
export class ActiveCrawlRunError extends Error {
  public constructor(public readonly runId: number, public readonly startedAt: string) {
    super(`Cannot start crawl: run ${runId} is already running (started ${startedAt}).`);
    this.name = "ActiveCrawlRunError";
  }
}

function locationKey(internship: Internship): string {
  const normalized = internship.normalizedLocations.map((location) => [
    location.country,
    location.provinceState,
    location.city,
    location.remote ? location.remoteScope ?? "remote" : "onsite",
  ].map((value) => normalizeIdentity(value ?? "")).join("|")).filter(Boolean).sort();
  return normalized.length > 0 ? normalized.join(";") : internship.location.map(normalizeIdentity).sort().join("|");
}

function locationsOverlap(left: Internship, right: Internship): boolean {
  const key = (internship: Internship): Set<string> => new Set(internship.normalizedLocations
    .filter(({ country, provinceState, city }) => Boolean(country || provinceState || city))
    .map(({ country, provinceState, city }) => [country, provinceState, city]
      .map((value) => normalizeIdentity(value ?? ""))
      .join("|")));
  const leftKeys = key(left);
  const rightKeys = key(right);
  return leftKeys.size > 0 && rightKeys.size > 0 && [...leftKeys].some((value) => rightKeys.has(value));
}

function asNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
}

export class InternshipDatabase {
  private readonly database: DatabaseSync;
  private readonly incrementallyPersistedSources = new Map<number, Set<string>>();
  private readonly incrementallyPersistedClosedUrls = new Map<number, Set<string>>();

  public constructor(public readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    // A scout and one or more dashboard workers can open the same database
    // during startup.  SQLite serializes writers, but without a busy timeout
    // a second constructor can fail in the middle of the migration/backfill
    // sequence.  Hold one write reservation across the complete operation so
    // other starters observe either the old schema or the finished schema.
    // Crawl persistence and the out-of-band Jobright resolver are separate
    // processes. A short timeout made a harmless writer hand-off look like a
    // failed crawl, especially while a large source was being committed.
    this.database.exec("PRAGMA busy_timeout = 30000");
    this.database.exec("PRAGMA foreign_keys = ON");
    try {
      this.database.exec("PRAGMA journal_mode = WAL");
    } catch (error) {
      // Changing the journal mode briefly needs an exclusive lock and some
      // SQLite builds return SQLITE_BUSY before busy_timeout is consulted for
      // that PRAGMA. Another constructor will have set WAL; its write lock
      // below still provides the migration serialization we need.
      if (!(error instanceof Error) || !/locked|busy/i.test(error.message)) throw error;
    }
    this.database.exec("PRAGMA synchronous = NORMAL");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec(DATABASE_SCHEMA);
      this.migrateSchema();
      this.normalizeLegacyCategoryPayloads();
      ensureListingActionSchema(this.database);
      this.purgeBelowMinimumScore();
      backfillListingActionIdentities(this.database);
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the migration error if rollback itself cannot run.
      }
      try {
        this.database.close();
      } catch {
        // Preserve the original migration error if cleanup also fails.
      }
      throw error;
    }
  }

  public startRun(options: ScoutRunOptions): number {
    const startedAt = new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const runningRuns = this.database.prepare(`
        SELECT id, started_at, heartbeat_at, cancel_requested_at FROM crawl_runs
        WHERE status = 'RUNNING'
        ORDER BY id DESC
      `).all() as unknown as Array<{ id: number; started_at: string; heartbeat_at: string | null; cancel_requested_at: string | null }>;
      const activeRun = runningRuns.find((run) => {
        if (run.cancel_requested_at !== null) return false;
        const startedAt = Date.parse(run.started_at);
        if (Number.isFinite(startedAt) && Date.now() - startedAt >= activeRunMaxDurationMs()) return false;
        const leaseAt = Date.parse(run.heartbeat_at ?? run.started_at);
        return !Number.isFinite(leaseAt) || Date.now() - leaseAt < RUNNING_SCAN_MAX_AGE_MS;
      });
      if (activeRun) {
        throw new ActiveCrawlRunError(activeRun.id, activeRun.started_at);
      }

      if (runningRuns.length > 0) {
        const hardDeadline = new Date(Date.now() - activeRunMaxDurationMs()).toISOString();
        this.database.prepare(`
          UPDATE crawl_runs
          SET finished_at = @finishedAt, heartbeat_at = NULL, status = 'FAILED',
              cancel_requested_at = CASE
                WHEN started_at <= @hardDeadline THEN COALESCE(cancel_requested_at, @finishedAt)
                ELSE cancel_requested_at
              END,
              error_message = CASE
                WHEN cancel_requested_at IS NOT NULL THEN COALESCE(error_message, 'Terminated by user.')
                WHEN started_at <= @hardDeadline THEN 'Crawl exceeded the maximum wall-clock duration.'
                ELSE 'Marked stale after exceeding the maximum crawl duration.'
              END
          WHERE status = 'RUNNING'
        `).run({ finishedAt: startedAt, hardDeadline });
      }

      const result = this.database.prepare(`
        INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
        VALUES (@startedAt, @startedAt, 'RUNNING', @options, @sourceCount)
      `).run({
        startedAt,
        options: JSON.stringify({ sources: options.sources, settings: options.settings, filters: options.filters }),
        sourceCount: options.sources.length,
      });
      // The dashboard's durable catalog is managed separately through
      // configureSource. A one-off CLI --source should remain one-off, while
      // the static dashboard catalog is resolved from its source config.
      for (const source of options.sources) this.ensureSource(canonicalizeUrl(source));
      this.database.exec("COMMIT");
      return asNumber(result.lastInsertRowid);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** Add a URL to the durable dashboard crawl catalog without crawling it yet. */
  public configureSource(url: string): ConfiguredSourceRecord {
    const canonical = canonicalizeUrl(url);
    const now = new Date().toISOString();
    let created: boolean;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.database.prepare("SELECT is_configured FROM sources WHERE url = @url").get({ url: canonical }) as unknown as { is_configured: number } | undefined;
      created = existing?.is_configured !== 1;
      this.ensureSource(canonical, true);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return { url: canonical, createdAt: now, isConfigured: true, created };
  }

  public recordListingAction(
    listingType: ListingType,
    listingId: string,
    action: ListingAction,
    company: string,
    title: string,
    context: ListingActionContext = {},
  ): ListingActionRecord {
    const listingKey = listingActionKey(listingType, listingId);
    const createdAt = new Date().toISOString();
    const internship = listingType === "internship" ? this.getInternshipById(listingId) : null;
    const resolvedContext = mergeListingActionContext(context, internship);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO listing_actions (
          listing_key, listing_type, listing_id, action, company, normalized_company, title,
          application_url, posting_url, job_id, location, created_at
        ) VALUES (
          @listingKey, @listingType, @listingId, @action, @company, @normalizedCompany, @title,
          @applicationUrl, @postingUrl, @jobId, @location, @createdAt
        )
        -- Do not name the conflict target here. Some deployed databases use
        -- a legacy composite primary key (user_id, listing_key), while the
        -- current single-user schema keys the row by listing_key.
        ON CONFLICT DO UPDATE SET
          action = excluded.action,
          company = excluded.company,
          normalized_company = excluded.normalized_company,
          title = excluded.title,
          application_url = COALESCE(excluded.application_url, listing_actions.application_url),
          posting_url = COALESCE(excluded.posting_url, listing_actions.posting_url),
          job_id = COALESCE(excluded.job_id, listing_actions.job_id),
          location = COALESCE(excluded.location, listing_actions.location),
          application_status = CASE
            WHEN excluded.action = 'applied' AND listing_actions.action <> 'applied' THEN 'pending'
            ELSE listing_actions.application_status
          END,
          application_stage = CASE
            WHEN excluded.action = 'applied' AND listing_actions.action <> 'applied' THEN 'applied'
            ELSE listing_actions.application_stage
          END,
          created_at = excluded.created_at
      `).run({
        listingKey,
        listingType,
        listingId,
        action,
        company,
        normalizedCompany: normalizeCompanyIdentity(company),
        title,
        applicationUrl: resolvedContext.applicationUrl ?? null,
        postingUrl: resolvedContext.postingUrl ?? null,
        jobId: resolvedContext.jobId ?? null,
        location: resolvedContext.location ?? null,
        createdAt,
      });
      replaceListingActionIdentities(
        this.database,
        listingKey,
        listingType,
        listingId,
        company,
        title,
        internship,
        resolvedContext,
      );
      this.database.exec("COMMIT");
      return { listingKey, listingType, listingId, action, company, title, createdAt };
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public getListingActions(): ListingActionRecord[] {
    const rows = this.database.prepare(`
      SELECT listing_key, listing_type, listing_id, action, company, title, created_at
      FROM listing_actions
      ORDER BY created_at DESC, listing_key
    `).all() as unknown as ListingActionRow[];
    return rows.map((row) => ({
      listingKey: row.listing_key,
      listingType: row.listing_type,
      listingId: row.listing_id,
      action: row.action,
      company: row.company,
      title: row.title,
      createdAt: row.created_at,
    }));
  }

  public getAppliedRoleCount(): number {
    const row = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM listing_actions
      WHERE action = 'applied'
    `).get() as unknown as { count: number | bigint };
    return asNumber(row.count);
  }

  public markRunFailed(runId: number, error: unknown): void {
    this.database.prepare(`
      UPDATE crawl_runs
      SET finished_at = @finishedAt, heartbeat_at = NULL, status = 'FAILED', error_message = @message
      WHERE id = @runId AND status = 'RUNNING'
    `).run({
      finishedAt: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
      runId,
    });
  }

  public markRunCancelled(runId: number): void {
    const requestedAt = new Date().toISOString();
    this.database.prepare(`
      UPDATE crawl_runs
      SET finished_at = @finishedAt, heartbeat_at = NULL, status = 'FAILED',
          cancel_requested_at = COALESCE(cancel_requested_at, @requestedAt),
          error_message = COALESCE(error_message, 'Terminated by user.')
      WHERE id = @runId AND status = 'RUNNING'
    `).run({ finishedAt: requestedAt, requestedAt, runId });
  }

  public isRunCancellationRequested(runId: number): boolean {
    const row = this.database.prepare(`
      SELECT status, cancel_requested_at
      FROM crawl_runs
      WHERE id = @runId
    `).get({ runId }) as unknown as { status: string; cancel_requested_at: string | null } | undefined;
    return row?.cancel_requested_at !== null;
  }

  public heartbeatRun(runId: number): void {
    const result = this.database.prepare(`
      UPDATE crawl_runs
      SET heartbeat_at = @heartbeatAt
      WHERE id = @runId AND status = 'RUNNING'
    `).run({ heartbeatAt: new Date().toISOString(), runId });
    if (asNumber(result.changes) !== 1) {
      throw new Error(`Cannot heartbeat crawl run ${runId}: it is no longer running.`);
    }
  }

  public updateRunProgress(runId: number, progress: CrawlProgress): void {
    this.database.prepare(`
      UPDATE crawl_runs
      SET sources_settled = MAX(sources_settled, @sourcesSettled),
          sources_completed = MAX(sources_completed, @sourcesCompleted),
          pages_visited = MAX(pages_visited, @pagesVisited),
          potential_postings_inspected = MAX(potential_postings_inspected, @potentialPostingsInspected),
          internships_discovered = MAX(internships_discovered, @internshipsDiscovered),
          cache_hits = MAX(cache_hits, COALESCE(@cacheHits, cache_hits)),
          unchanged_skips = MAX(unchanged_skips, COALESCE(@unchangedSkips, unchanged_skips)),
          new_listings = MAX(new_listings, COALESCE(@newListings, new_listings)),
          changed_listings = MAX(changed_listings, COALESCE(@changedListings, changed_listings)),
          detail_pages_fetched = MAX(detail_pages_fetched, COALESCE(@detailPagesFetched, detail_pages_fetched)),
          duplicate_listings_skipped = MAX(duplicate_listings_skipped, COALESCE(@duplicateListingsSkipped, duplicate_listings_skipped)),
          irrelevant_listings_skipped = MAX(irrelevant_listings_skipped, COALESCE(@irrelevantListingsSkipped, irrelevant_listings_skipped))
      WHERE id = @runId AND status = 'RUNNING'
    `).run({
      runId,
      sourcesSettled: progress.sourcesSettled,
      sourcesCompleted: progress.sourcesCompleted,
      pagesVisited: progress.pagesVisited,
      potentialPostingsInspected: progress.potentialPostingsInspected,
      internshipsDiscovered: progress.internshipsDiscovered,
      cacheHits: progress.cacheHits ?? null,
      unchangedSkips: progress.unchangedSkips ?? null,
      newListings: progress.newListings ?? null,
      changedListings: progress.changedListings ?? null,
      detailPagesFetched: progress.detailPagesFetched ?? null,
      duplicateListingsSkipped: progress.duplicateListingsSkipped ?? null,
      irrelevantListingsSkipped: progress.irrelevantListingsSkipped ?? null,
    });
  }

  public getKnownUrlsBySource(sources: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    const statement = this.database.prepare(`
      SELECT DISTINCT s.url, i.application_url, i.posting_url
      FROM sources s
      JOIN internship_sources link ON link.source_id = s.id
      JOIN internships i ON i.id = link.internship_id
      WHERE s.url = @url
        AND i.availability_status != 'closed'
      ORDER BY i.last_seen_at DESC
    `);
    for (const source of sources.map((value) => canonicalizeUrl(value))) {
      const rows = statement.all({ url: source }) as unknown as Array<{
        url: string;
        application_url: string;
        posting_url: string;
      }>;
      // Action state is a downstream visibility concern. A handled listing is
      // still a known URL and must remain eligible for source revalidation.
      result.set(source, uniqueStrings(rows.map(({ application_url: applicationUrl, posting_url: postingUrl }) => (
        isAggregatorUrl(applicationUrl) ? postingUrl : applicationUrl
      ))));
    }
    return result;
  }

  /**
   * Return indexed listing state for a source without requiring the crawler to
   * parse every stored payload. Payloads are parsed only for rows that are
   * actually returned, keeping this suitable for listing-stage fast paths.
   */
  public getCrawlStateBySource(sources: string[], includeClosed = true): Map<string, CrawlStateRecord[]> {
    const result = new Map<string, CrawlStateRecord[]>();
    const statement = this.database.prepare(`
      SELECT s.id AS source_id, s.url AS source_url, i.*,
             GROUP_CONCAT(DISTINCT provenance.url) AS source_provenance
      FROM sources s
      JOIN internship_sources link ON link.source_id = s.id
      JOIN internships i ON i.id = link.internship_id
      LEFT JOIN internship_sources all_link ON all_link.internship_id = i.id
      LEFT JOIN sources provenance ON provenance.id = all_link.source_id
      WHERE s.url = @url
        AND (@includeClosed = 1 OR i.availability_status != 'closed')
      GROUP BY s.id, i.id
      ORDER BY i.last_seen_at DESC, i.id
    `);
    for (const source of sources.map((value) => canonicalizeUrl(value))) {
      const rows = statement.all({ url: source, includeClosed: includeClosed ? 1 : 0 }) as unknown as CrawlStateRow[];
      result.set(source, rows.map((row) => this.crawlStateRecordFromRow(row)));
    }
    return result;
  }

  /** Alias with a singular source for adapters that process one source at a time. */
  public getCrawlState(source: string, includeClosed = true): CrawlStateRecord[] {
    return this.getCrawlStateBySource([source], includeClosed).get(canonicalizeUrl(source)) ?? [];
  }

  /**
   * Load the reusable direct destinations for a structured Jobright source in
   * one indexed source join. The crawler can then resolve each fresh record by
   * job ID without repeating the full identity query thousands of times.
   */
  public getJobrightDestinations(source: string): Map<string, string> {
    const rows = this.database.prepare(`
      SELECT i.external_job_id, i.job_id, i.application_url, i.posting_url
      FROM sources s
      JOIN internship_sources link ON link.source_id = s.id
      JOIN internships i ON i.id = link.internship_id
      WHERE s.url = @source
    `).all({ source: canonicalizeUrl(source) }) as unknown as Array<{
      external_job_id: string | null;
      job_id: string | null;
      application_url: string;
      posting_url: string;
    }>;
    const destinations = new Map<string, string>();
    for (const row of rows) {
      const destination = [row.application_url, row.posting_url].map((value) => {
        try {
          const canonical = canonicalizeUrl(value);
          return !isJobrightUrl(canonical) && !isAggregatorUrl(canonical) ? canonical : null;
        } catch {
          return null;
        }
      }).find((value): value is string => value !== null) ?? null;
      if (!destination) continue;
      for (const key of [row.external_job_id, row.job_id, row.posting_url]) {
        const normalized = key?.trim();
        if (normalized && !destinations.has(normalized)) destinations.set(normalized, destination);
      }
    }
    const cachedRows = this.database.prepare(`
      SELECT jobright_url, job_id, destination_url
      FROM jobright_destinations
      WHERE destination_url IS NOT NULL
    `).all() as unknown as Array<{
      jobright_url: string;
      job_id: string | null;
      destination_url: string;
    }>; 
    for (const row of cachedRows) {
      const destination = (() => {
        try {
          const canonical = canonicalizeUrl(row.destination_url);
          return !isJobrightUrl(canonical) && !isAggregatorUrl(canonical) ? canonical : null;
        } catch {
          return null;
        }
      })();
      if (!destination) continue;
      for (const key of [row.jobright_url, row.job_id]) {
        const normalized = key?.trim();
        if (normalized && !destinations.has(normalized)) destinations.set(normalized, destination);
      }
    }
    return destinations;
  }

  /** Return recently attempted Jobright keys so failed pages do not starve newer links. */
  public getJobrightResolutionKeys(maxAgeMs = 6 * 60 * 60 * 1_000): Set<string> {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const rows = this.database.prepare(
      "SELECT jobright_url, job_id FROM jobright_destinations WHERE resolved_at >= @cutoff",
    ).all({ cutoff }) as unknown as Array<{ jobright_url: string; job_id: string | null }>;
    const keys = new Set<string>();
    for (const row of rows) {
      if (row.jobright_url?.trim()) keys.add(row.jobright_url.trim());
      if (row.job_id?.trim()) keys.add(row.job_id.trim());
    }
    return keys;
  }

  /** Persist one verified employer/ATS destination for the out-of-band resolver. */
  public recordJobrightDestination(jobrightUrl: string, destinationUrl: string | null, errorMessage: string | null = null): void {
    const canonicalJobrightUrl = canonicalizeUrl(jobrightUrl);
    if (!isJobrightUrl(canonicalJobrightUrl)) throw new Error(`Expected a Jobright URL, received ${jobrightUrl}`);
    let canonicalDestination: string | null = null;
    if (destinationUrl) {
      const candidate = canonicalizeUrl(destinationUrl, canonicalJobrightUrl);
      if (isJobrightUrl(candidate) || isAggregatorUrl(candidate)) {
        throw new Error(`Jobright destination must be an employer or ATS URL, received ${destinationUrl}`);
      }
      canonicalDestination = candidate;
    }
    const jobId = /\/jobs\/[^/]+\/([^/?#]+)/i.exec(new URL(canonicalJobrightUrl).pathname)?.[1] ?? null;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.prepare(`
        INSERT INTO jobright_destinations (jobright_url, job_id, destination_url, resolved_at, error_message)
        VALUES (@jobrightUrl, @jobId, @destinationUrl, @resolvedAt, @errorMessage)
        ON CONFLICT(jobright_url) DO UPDATE SET
          job_id = excluded.job_id,
          destination_url = excluded.destination_url,
          resolved_at = excluded.resolved_at,
          error_message = excluded.error_message
      `).run({
        jobrightUrl: canonicalJobrightUrl,
        jobId,
        destinationUrl: canonicalDestination,
        resolvedAt: new Date().toISOString(),
        errorMessage,
      });
      if (canonicalDestination) {
        this.promoteStoredJobrightDestination(canonicalJobrightUrl, jobId, canonicalDestination);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Apply a verified destination to records written before the resolver was
   * available. The dashboard also resolves from the cache at read time, but
   * promoting the durable row keeps exports and stored application context
   * from retaining an aggregator-only URL.
   */
  private promoteStoredJobrightDestination(
    canonicalJobrightUrl: string,
    jobId: string | null,
    destinationUrl: string,
  ): void {
    const normalizedSource = normalizedJobUrl(canonicalJobrightUrl);
    const internshipRows = this.database.prepare(`
      SELECT id, job_id, external_job_id, application_url, posting_url, payload_json
      FROM internships
      WHERE application_url = @jobrightUrl
         OR posting_url = @jobrightUrl
         OR canonical_application_url = @jobrightUrl
         OR canonical_posting_url = @jobrightUrl
         OR (@jobId IS NOT NULL AND (job_id = @jobId OR external_job_id = @jobId))
    `).all({ jobrightUrl: canonicalJobrightUrl, jobId }) as unknown as Array<{
      id: string;
      job_id: string | null;
      external_job_id: string | null;
      application_url: string;
      posting_url: string;
      payload_json: string;
    }>;

    const replaceUrl = (value: string | null, rowMatchesByJobId: boolean): string | null => {
      if (!value || !isJobrightUrl(value)) return value;
      try {
        return normalizedJobUrl(value) === normalizedSource || rowMatchesByJobId ? destinationUrl : value;
      } catch {
        return value;
      }
    };
    const updateInternship = this.database.prepare(`
      UPDATE internships
      SET application_url = @applicationUrl,
          posting_url = @postingUrl,
          payload_json = @payload,
          content_hash = @contentHash,
          canonical_url = @canonicalUrl,
          canonical_application_url = @canonicalApplicationUrl,
          canonical_posting_url = @canonicalPostingUrl,
          provider_identity = @providerIdentity
      WHERE id = @id
    `);
    let internshipsChanged = false;
    for (const row of internshipRows) {
      const rowMatchesByJobId = Boolean(jobId && (row.job_id === jobId || row.external_job_id === jobId));
      let existing: Internship;
      try {
        existing = InternshipSchema.parse(JSON.parse(row.payload_json));
      } catch {
        continue;
      }
      const applicationUrl = replaceUrl(existing.applicationUrl, rowMatchesByJobId) ?? existing.applicationUrl;
      const postingUrl = replaceUrl(existing.postingUrl, rowMatchesByJobId) ?? existing.postingUrl;
      const nestedApplicationUrl = replaceUrl(existing.qualificationDetails.applicationUrl, rowMatchesByJobId);
      if (applicationUrl === existing.applicationUrl
        && postingUrl === existing.postingUrl
        && nestedApplicationUrl === existing.qualificationDetails.applicationUrl) continue;
      const updated = InternshipSchema.parse({
        ...existing,
        applicationUrl,
        postingUrl,
        qualificationDetails: {
          ...existing.qualificationDetails,
          applicationUrl: nestedApplicationUrl,
        },
      });
      const canonicalApplicationUrl = normalizedJobUrl(updated.applicationUrl);
      const canonicalPostingUrl = normalizedJobUrl(updated.postingUrl);
      updateInternship.run({
        id: row.id,
        applicationUrl: updated.applicationUrl,
        postingUrl: updated.postingUrl,
        payload: JSON.stringify(updated),
        contentHash: internshipContentHash(updated),
        canonicalUrl: canonicalPostingUrl || canonicalApplicationUrl,
        canonicalApplicationUrl,
        canonicalPostingUrl,
        providerIdentity: providerJobIdentityKeys(updated)[0] ?? null,
      });
      internshipsChanged = true;
    }

    const actionRows = this.database.prepare(`
      SELECT listing_key, application_url, posting_url, job_id
      FROM listing_actions
      WHERE application_url = @jobrightUrl
         OR posting_url = @jobrightUrl
         OR (@jobId IS NOT NULL AND job_id = @jobId)
    `).all({ jobrightUrl: canonicalJobrightUrl, jobId }) as unknown as Array<{
      listing_key: string;
      application_url: string | null;
      posting_url: string | null;
      job_id: string | null;
    }>;
    const updateAction = this.database.prepare(`
      UPDATE listing_actions
      SET application_url = @applicationUrl,
          posting_url = @postingUrl
      WHERE listing_key = @listingKey
    `);
    let actionsChanged = false;
    for (const row of actionRows) {
      const rowMatchesByJobId = Boolean(jobId && row.job_id === jobId);
      const applicationUrl = replaceUrl(row.application_url, rowMatchesByJobId);
      const postingUrl = replaceUrl(row.posting_url, rowMatchesByJobId);
      if (applicationUrl === row.application_url && postingUrl === row.posting_url) continue;
      updateAction.run({
        listingKey: row.listing_key,
        applicationUrl,
        postingUrl,
      });
      actionsChanged = true;
    }
    if (internshipsChanged || actionsChanged) backfillListingActionIdentities(this.database);
  }

  /**
   * Classify a cheap listing identity. A content hash or HTTP validator match
   * is required before returning `unchanged`; an identity alone is only
   * `possibly_changed`, so stale cached content can never prove a posting is
   * still open.
   */
  public classifyListing(source: string, hint: ListingIdentityHint): CrawlStateDecision {
    const candidates = this.findCrawlStateCandidates(canonicalizeUrl(source), hint);
    const canonicalUrl = this.canonicalHint(hint);
    const canonicalMatches = canonicalUrl
      ? candidates.filter((candidate) => [candidate.canonicalUrl, candidate.applicationUrl, candidate.postingUrl]
        .some((value) => value === canonicalUrl))
      : [];
    const externalMatches = hint.externalJobId
      ? candidates.filter((candidate) => candidate.externalJobId === hint.externalJobId?.trim())
      : [];
    const comparableProviderMatches = hint.providerIdentity
      ? externalMatches.filter((candidate) => candidate.providerIdentity === hint.providerIdentity?.trim())
      : [];
    // Prefer an exact canonical URL. If an adapter only exposes an external
    // requisition ID, accept it only when it identifies one row (or one
    // comparable provider row); never pick an arbitrary payload from an
    // ambiguous ID collision.
    const record = canonicalMatches[0]
      ?? (comparableProviderMatches.length === 1 ? comparableProviderMatches[0] : externalMatches.length === 1 ? externalMatches[0] : null);
    if (!record) return { disposition: "new", record: null, validatorsMatch: false, reason: "No indexed listing identity matched." };
    if (record.failureState === "retryable") {
      return { disposition: "retryable", record, validatorsMatch: false, reason: "The previous detail retrieval failed and is retryable." };
    }
    const validatorsMatch = this.listingValidatorsMatch(record, hint);
    if (validatorsMatch && record.availabilityStatus === "open") {
      return { disposition: "unchanged", record, validatorsMatch: true, reason: "Content hash or HTTP cache validator matched." };
    }
    if (record.availabilityStatus === "closed") {
      return { disposition: "possibly_changed", record, validatorsMatch, reason: "A closed listing was rediscovered and needs verification before reopening." };
    }
    return { disposition: "possibly_changed", record, validatorsMatch, reason: "Identity matched but no safe unchanged validator was available." };
  }

  /** Persist listing-stage sightings and unchanged skips in one writer transaction. */
  public recordLightweightSightings(runId: number, sightings: LightweightSighting[]): void {
    if (sightings.length === 0) return;
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnership(runId);
      const metrics: CrawlMetrics = {};
      for (const sighting of sightings) {
        const sourceUrl = canonicalizeUrl(sighting.sourceUrl);
        const source = this.ensureSource(sourceUrl);
        const hint: ListingIdentityHint = sighting;
        const identityKey = this.listingIdentityKey(hint);
        // A source can expose one posting through several duplicate links, and
        // the crawler may also retry a persistence callback. Keep the first
        // sighting for a run/source/identity authoritative so lifecycle fields
        // and counters are not advanced multiple times for one observation.
        const existing = this.database.prepare(`
          SELECT 1 AS present
          FROM listing_sightings
          WHERE run_id = @runId AND source_id = @sourceId AND identity_key = @identityKey
          LIMIT 1
        `).get({ runId, sourceId: source.id, identityKey }) as unknown as { present: number } | undefined;
        if (existing) continue;
        const decision = this.classifyListing(sourceUrl, hint);
        const row = decision.record;
        const state = sighting.state === "failed" ? "failed" : sighting.state;
        const seenAt = sighting.seenAt ?? new Date().toISOString();
        const checkedAt = sighting.checkedAt ?? seenAt;
        this.database.prepare(`
          INSERT INTO listing_sightings (
            run_id, source_id, internship_id, identity_key, canonical_url, external_job_id,
            provider_identity, content_hash_hint, etag, last_modified, state, observed_open,
            seen_at, checked_at, provenance_json
          ) VALUES (
            @runId, @sourceId, @internshipId, @identityKey, @canonicalUrl, @externalJobId,
            @providerIdentity, @contentHash, @etag, @lastModified, @state, @observedOpen,
            @seenAt, @checkedAt, @provenance
          )
          ON CONFLICT(run_id, source_id, identity_key) DO UPDATE SET
            internship_id = excluded.internship_id, content_hash_hint = excluded.content_hash_hint,
            etag = excluded.etag, last_modified = excluded.last_modified, state = excluded.state,
            observed_open = excluded.observed_open, seen_at = excluded.seen_at,
            checked_at = excluded.checked_at, provenance_json = excluded.provenance_json
        `).run({
          runId,
          sourceId: source.id,
          internshipId: row?.internshipId ?? null,
          identityKey,
          canonicalUrl: this.canonicalHint(hint),
          externalJobId: hint.externalJobId ?? null,
          providerIdentity: hint.providerIdentity ?? null,
          contentHash: hint.contentHash ?? null,
          etag: hint.etag ?? null,
          lastModified: hint.lastModified ?? null,
          state,
          observedOpen: sighting.observedOpen === undefined ? null : sighting.observedOpen ? 1 : 0,
          seenAt,
          checkedAt,
          provenance: JSON.stringify(sighting.provenance ?? {}),
        });
        if (row) {
          this.touchInternshipFromSighting(runId, source.id, row, state, sighting, seenAt, checkedAt);
          if (state === "closed") this.markClosedFromState(runId, row, checkedAt);
        }
        if (state === "unchanged") {
          metrics.unchangedSkips = (metrics.unchangedSkips ?? 0) + 1;
          if (decision.validatorsMatch) metrics.cacheHits = (metrics.cacheHits ?? 0) + 1;
        } else if (state === "new") metrics.newListings = (metrics.newListings ?? 0) + 1;
        else if (state === "possibly_changed") metrics.changedListings = (metrics.changedListings ?? 0) + 1;
        else if (state === "retryable" || state === "failed") metrics.retryableFailures = (metrics.retryableFailures ?? 0) + 1;
      }
      this.recordCrawlMetricsInTransaction(runId, metrics);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /** More explicit alias for callers that use cache terminology. */
  public persistLightweightSightings(runId: number, sightings: LightweightSighting[]): void {
    this.recordLightweightSightings(runId, sightings);
  }

  public recordCrawlMetrics(runId: number, metrics: CrawlMetrics): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnership(runId);
      this.recordCrawlMetricsInTransaction(runId, metrics);
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public getCrawlMetrics(runId: number): CrawlMetrics {
    const rows = this.database.prepare(`SELECT metric_key, value FROM crawl_run_metrics WHERE run_id = @runId`).all({ runId }) as unknown as Array<{ metric_key: string; value: number }>;
    return Object.fromEntries(rows.map((row) => [row.metric_key, row.value]));
  }

  public getSourceStrategy(source: string): SourceStrategyState {
    const sourceRow = this.ensureSource(source);
    const row = this.database.prepare(`SELECT * FROM source_strategies WHERE source_id = @sourceId`).get({ sourceId: sourceRow.id }) as unknown as {
      adapter: string | null;
      requires_js: number;
      last_success_at: string | null;
      last_failure_at: string | null;
      failure_count: number;
      consecutive_failure_count: number;
      average_latency_ms: number | null;
      latency_samples: number;
      last_status: string | null;
      last_http_status: number | null;
      last_error: string | null;
      metadata_json: string;
      updated_at: string;
    } | undefined;
    if (!row) return {
      sourceUrl: sourceRow.url,
      sourceId: sourceRow.id,
      adapter: null,
      requiresJs: false,
      lastSuccessAt: null,
      lastFailureAt: null,
      failureCount: 0,
      consecutiveFailureCount: 0,
      averageLatencyMs: null,
      latencySamples: 0,
      lastStatus: null,
      lastHttpStatus: null,
      lastError: null,
      metadata: {},
      updatedAt: new Date(0).toISOString(),
    };
    return this.sourceStrategyFromRow(sourceRow.url, sourceRow.id, row);
  }

  public recordSourceStrategy(source: string, patch: SourceStrategyPatch): SourceStrategyState {
    const sourceRow = this.ensureSource(source);
    const now = patch.occurredAt ?? new Date().toISOString();
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.getSourceStrategy(sourceRow.url);
      const success = patch.success === true;
      const failure = patch.success === false;
      const latency = patch.latencyMs !== undefined && patch.latencyMs !== null && Number.isFinite(patch.latencyMs) ? patch.latencyMs : null;
      const samples = existing.latencySamples + (latency === null ? 0 : 1);
      const average = latency === null ? existing.averageLatencyMs : existing.averageLatencyMs === null
        ? latency
        : ((existing.averageLatencyMs * existing.latencySamples) + latency) / samples;
      const metadata = { ...existing.metadata, ...(patch.metadata ?? {}) };
      this.database.prepare(`
        INSERT INTO source_strategies (
          source_id, adapter, requires_js, last_success_at, last_failure_at, failure_count,
          consecutive_failure_count, average_latency_ms, latency_samples, last_status,
          last_http_status, last_error, metadata_json, updated_at
        ) VALUES (
          @sourceId, @adapter, @requiresJs, @lastSuccessAt, @lastFailureAt, @failureCount,
          @consecutiveFailures, @averageLatency, @latencySamples, @status,
          @httpStatus, @error, @metadata, @updatedAt
        )
        ON CONFLICT(source_id) DO UPDATE SET
          adapter = excluded.adapter, requires_js = excluded.requires_js,
          last_success_at = excluded.last_success_at, last_failure_at = excluded.last_failure_at,
          failure_count = excluded.failure_count, consecutive_failure_count = excluded.consecutive_failure_count,
          average_latency_ms = excluded.average_latency_ms, latency_samples = excluded.latency_samples,
          last_status = excluded.last_status, last_http_status = excluded.last_http_status,
          last_error = excluded.last_error, metadata_json = excluded.metadata_json, updated_at = excluded.updated_at
      `).run({
        sourceId: sourceRow.id,
        adapter: patch.adapter === undefined ? existing.adapter : patch.adapter,
        requiresJs: patch.requiresJs === undefined ? (existing.requiresJs ? 1 : 0) : patch.requiresJs ? 1 : 0,
        lastSuccessAt: success ? now : existing.lastSuccessAt,
        lastFailureAt: failure ? now : existing.lastFailureAt,
        failureCount: existing.failureCount + (failure ? 1 : 0),
        consecutiveFailures: success ? 0 : existing.consecutiveFailureCount + (failure ? 1 : 0),
        averageLatency: average,
        latencySamples: samples,
        status: patch.status === undefined ? existing.lastStatus : patch.status,
        httpStatus: patch.httpStatus === undefined ? existing.lastHttpStatus : patch.httpStatus,
        error: failure ? patch.error ?? existing.lastError : patch.error === null ? null : existing.lastError,
        metadata: JSON.stringify(metadata),
        updatedAt: now,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
    return this.getSourceStrategy(sourceRow.url);
  }

  /** Adapter-friendly name for recording one retrieval attempt. */
  public recordSourceFetch(source: string, patch: SourceStrategyPatch): SourceStrategyState {
    return this.recordSourceStrategy(source, patch);
  }

  private canonicalHint(hint: ListingIdentityHint): string | null {
    const value = hint.canonicalUrl ?? hint.applicationUrl ?? hint.postingUrl;
    if (!value) return null;
    try {
      return canonicalizeUrl(value);
    } catch {
      return value;
    }
  }

  private listingIdentityKey(hint: ListingIdentityHint): string {
    const canonicalUrl = this.canonicalHint(hint);
    const externalJobId = hint.externalJobId?.trim().toLocaleLowerCase() ?? "";
    const providerIdentity = hint.providerIdentity?.trim().toLocaleLowerCase() ?? "";
    return [canonicalUrl ?? "", externalJobId, providerIdentity].join("\u0000") || `anonymous:${JSON.stringify(hint)}`;
  }

  private listingValidatorsMatch(record: CrawlStateRecord, hint: ListingIdentityHint): boolean {
    if (hint.contentHash && hint.contentHash === record.contentHash) return true;
    if (hint.etag && record.etag && hint.etag === record.etag) return true;
    if (hint.lastModified && record.lastModified && hint.lastModified === record.lastModified) return true;
    return false;
  }

  private findCrawlStateCandidates(sourceUrl: string, hint: ListingIdentityHint): CrawlStateRecord[] {
    const canonicalUrl = this.canonicalHint(hint);
    const externalJobId = hint.externalJobId?.trim() || null;
    const rows = this.database.prepare(`
      SELECT s.id AS source_id, s.url AS source_url, i.*,
             GROUP_CONCAT(DISTINCT provenance.url) AS source_provenance
      FROM internships i
      JOIN internship_sources link ON link.internship_id = i.id
      JOIN sources s ON s.id = link.source_id
      LEFT JOIN internship_sources all_link ON all_link.internship_id = i.id
      LEFT JOIN sources provenance ON provenance.id = all_link.source_id
      WHERE s.url = @sourceUrl
        AND (
          (@canonicalUrl IS NOT NULL AND (i.canonical_url = @canonicalUrl OR i.canonical_application_url = @canonicalUrl OR i.canonical_posting_url = @canonicalUrl OR i.application_url = @canonicalUrl OR i.posting_url = @canonicalUrl))
          -- A provider/ATS label is not a posting identity: every listing
          -- from a source can legitimately share it.  Matching on that label
          -- alone can therefore return an unrelated posting (and the caller
          -- may emit its cached detail payload).  A provider can only
          -- participate in the lookup through a specific external requisition
          -- identity.  External IDs are scoped to the configured source here,
          -- so a provider label is deliberately optional for legacy rows and
          -- adapters whose persisted provider key has a different format.
          OR (@externalJobId IS NOT NULL AND i.external_job_id = @externalJobId)
        )
      GROUP BY s.id, i.id
      ORDER BY CASE
        WHEN @canonicalUrl IS NOT NULL AND (i.canonical_url = @canonicalUrl OR i.canonical_application_url = @canonicalUrl OR i.canonical_posting_url = @canonicalUrl OR i.application_url = @canonicalUrl OR i.posting_url = @canonicalUrl) THEN 0
        WHEN @externalJobId IS NOT NULL AND i.external_job_id = @externalJobId THEN 1
        ELSE 2
      END,
      CASE WHEN i.availability_status = 'open' THEN 0 ELSE 1 END,
      i.last_seen_at DESC
    `).all({ sourceUrl, canonicalUrl, externalJobId }) as unknown as CrawlStateRow[];
    return rows.map((row) => this.crawlStateRecordFromRow(row));
  }

  private crawlStateRecordFromRow(row: CrawlStateRow): CrawlStateRecord {
    let internship: Internship | null = null;
    try {
      internship = InternshipSchema.parse(JSON.parse(row.payload_json));
    } catch {
      // Preserve indexed state even when a legacy payload is malformed.
    }
    const sourceProvenance = row.source_provenance ? uniqueStrings(row.source_provenance.split(",")) : [row.source_url];
    return {
      sourceUrl: row.source_url,
      sourceId: row.source_id,
      internshipId: row.id,
      canonicalUrl: row.canonical_url ?? row.canonical_application_url ?? row.canonical_posting_url ?? row.application_url,
      applicationUrl: row.application_url,
      postingUrl: row.posting_url,
      externalJobId: row.external_job_id ?? row.job_id,
      providerIdentity: row.provider_identity,
      company: row.company,
      title: row.title,
      contentHash: row.content_hash,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      lastCheckedAt: row.last_checked_at ?? row.last_verified_at,
      lastVerifiedAt: row.last_verified_at,
      etag: row.etag,
      lastModified: row.last_modified,
      lifecycleStatus: row.lifecycle_status,
      availabilityStatus: row.availability_status,
      failureState: row.failure_state,
      failureCount: row.failure_count,
      lastFailureAt: row.last_failure_at,
      lastFailureMessage: row.last_failure_message,
      missCount: row.miss_count,
      internship,
      sourceProvenance,
    };
  }

  private touchInternshipFromSighting(
    runId: number,
    sourceId: number,
    row: CrawlStateRecord,
    state: LightweightSighting["state"],
    sighting: LightweightSighting,
    seenAt: string,
    checkedAt: string,
  ): void {
    // A lightweight sighting only proves that the listing was observed. It
    // refreshes seen/check timestamps and provenance, but cannot reopen a
    // closed posting or replace detail content without an analyzed upsert.
    const unchangedPayload = state === "unchanged" && row.internship
      ? JSON.stringify(InternshipSchema.parse({ ...row.internship, lifecycleStatus: "UNCHANGED" }))
      : null;
    this.database.prepare(`
      UPDATE internships
      SET payload_json = COALESCE(@payload, payload_json),
          lifecycle_status = CASE WHEN @state = 'unchanged' THEN 'UNCHANGED' ELSE lifecycle_status END,
          last_seen_at = @seenAt,
          last_checked_at = @checkedAt,
          last_seen_run_id = @runId,
          miss_count = CASE WHEN @state = 'unchanged' AND availability_status = 'open' THEN 0 ELSE miss_count END,
          etag = COALESCE(@etag, etag),
          last_modified = COALESCE(@lastModified, last_modified),
          failure_state = CASE WHEN @state = 'retryable' OR @state = 'failed' THEN 'retryable' ELSE failure_state END,
          failure_count = CASE WHEN @state = 'retryable' OR @state = 'failed' THEN failure_count + 1 ELSE failure_count END,
          last_failure_at = CASE WHEN @state = 'retryable' OR @state = 'failed' THEN @checkedAt ELSE last_failure_at END
      WHERE id = @internshipId
    `).run({
      seenAt,
      checkedAt,
      runId,
      payload: unchangedPayload,
      state,
      etag: sighting.etag ?? null,
      lastModified: sighting.lastModified ?? null,
      internshipId: row.internshipId,
    });
    this.database.prepare(`
      INSERT INTO internship_sources (internship_id, source_id, first_seen_at, last_seen_at, last_seen_run_id)
      VALUES (@internshipId, @sourceId, @seenAt, @seenAt, @runId)
      ON CONFLICT(internship_id, source_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_seen_run_id = excluded.last_seen_run_id
    `).run({ internshipId: row.internshipId, sourceId, seenAt, runId });
    if (state === "unchanged") this.recordRunInternship(runId, row.internshipId, "UNCHANGED");
  }

  private markClosedFromState(runId: number, row: CrawlStateRecord, now: string): void {
    if (!row.internship || row.availabilityStatus === "closed") return;
    const closed = InternshipSchema.parse({
      ...row.internship,
      lifecycleStatus: "REMOVED_OR_CLOSED",
      availabilityStatus: "closed",
      lastVerifiedAt: now,
    });
    this.database.prepare(`
      UPDATE internships
      SET payload_json = @payload, lifecycle_status = 'REMOVED_OR_CLOSED', availability_status = 'closed',
          last_verified_at = @now, last_checked_at = @now, status_run_id = @runId
      WHERE id = @id
    `).run({ payload: JSON.stringify(closed), now, runId, id: row.internshipId });
    this.recordRunInternship(runId, row.internshipId, "REMOVED_OR_CLOSED");
  }

  private recordCrawlMetricsInTransaction(runId: number, metrics: CrawlMetrics): void {
    const now = new Date().toISOString();
    const updateRun = this.database.prepare(`
      UPDATE crawl_runs SET
        -- crawl_run_metrics is the durable additive ledger. Progress updates
        -- may already have populated a live snapshot, so reconcile with the
        -- ledger using MAX instead of adding the same total a second time.
        cache_hits = CASE WHEN @metric = 'cacheHits' THEN MAX(cache_hits, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'cacheHits'), 0)) ELSE cache_hits END,
        unchanged_skips = CASE WHEN @metric = 'unchangedSkips' THEN MAX(unchanged_skips, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'unchangedSkips'), 0)) ELSE unchanged_skips END,
        new_listings = CASE WHEN @metric = 'newListings' THEN MAX(new_listings, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'newListings'), 0)) ELSE new_listings END,
        changed_listings = CASE WHEN @metric = 'changedListings' THEN MAX(changed_listings, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'changedListings'), 0)) ELSE changed_listings END,
        retryable_failures = CASE WHEN @metric = 'retryableFailures' THEN MAX(retryable_failures, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'retryableFailures'), 0)) ELSE retryable_failures END,
        detail_pages_fetched = CASE WHEN @metric = 'detailPagesFetched' THEN MAX(detail_pages_fetched, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'detailPagesFetched'), 0)) ELSE detail_pages_fetched END,
        duplicate_listings_skipped = CASE WHEN @metric = 'duplicateListingsSkipped' THEN MAX(duplicate_listings_skipped, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'duplicateListingsSkipped'), 0)) ELSE duplicate_listings_skipped END,
        irrelevant_listings_skipped = CASE WHEN @metric = 'irrelevantListingsSkipped' THEN MAX(irrelevant_listings_skipped, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'irrelevantListingsSkipped'), 0)) ELSE irrelevant_listings_skipped END,
        http_requests = CASE WHEN @metric = 'httpRequests' THEN MAX(http_requests, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'httpRequests'), 0)) ELSE http_requests END,
        browser_navigations = CASE WHEN @metric = 'browserNavigations' THEN MAX(browser_navigations, COALESCE((SELECT value FROM crawl_run_metrics WHERE run_id = @runId AND metric_key = 'browserNavigations'), 0)) ELSE browser_navigations END
      WHERE id = @runId
    `);
    const insert = this.database.prepare(`
      INSERT INTO crawl_run_metrics (run_id, metric_key, value, unit, updated_at)
      VALUES (@runId, @metric, @value, @unit, @updatedAt)
      ON CONFLICT(run_id, metric_key) DO UPDATE SET value = value + excluded.value, unit = excluded.unit, updated_at = excluded.updated_at
    `);
    for (const [metric, value] of Object.entries(metrics)) {
      if (typeof value !== "number" || !Number.isFinite(value)) continue;
      const unit = metric.toLocaleLowerCase().includes("latency") || metric.toLocaleLowerCase().endsWith("ms") ? "ms" : "count";
      insert.run({ runId, metric, value, unit, updatedAt: now });
      updateRun.run({ runId, metric });
    }
  }

  private sourceStrategyFromRow(sourceUrl: string, sourceId: number, row: {
    adapter: string | null;
    requires_js: number;
    last_success_at: string | null;
    last_failure_at: string | null;
    failure_count: number;
    consecutive_failure_count: number;
    average_latency_ms: number | null;
    latency_samples: number;
    last_status: string | null;
    last_http_status: number | null;
    last_error: string | null;
    metadata_json: string;
    updated_at: string;
  }): SourceStrategyState {
    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(row.metadata_json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch {
      // Keep malformed legacy metadata as an empty object.
    }
    return {
      sourceUrl,
      sourceId,
      adapter: row.adapter,
      requiresJs: row.requires_js === 1,
      lastSuccessAt: row.last_success_at,
      lastFailureAt: row.last_failure_at,
      failureCount: row.failure_count,
      consecutiveFailureCount: row.consecutive_failure_count,
      averageLatencyMs: row.average_latency_ms,
      latencySamples: row.latency_samples,
      lastStatus: row.last_status,
      lastHttpStatus: row.last_http_status,
      lastError: row.last_error,
      metadata,
      updatedAt: row.updated_at,
    };
  }

  /** Record the first moment an individual source begins crawling. A
   * placeholder row lets the dashboard show source-specific elapsed time
   * before the source has produced its final result. */
  public recordSourceStart(runId: number, sourceUrl: string, startedAt: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnership(runId);
      const source = this.ensureSource(sourceUrl);
      this.database.prepare(`
        INSERT INTO source_run_results (run_id, source_id, settled, completed, started_at)
        VALUES (@runId, @sourceId, 0, 0, @startedAt)
        ON CONFLICT(run_id, source_id) DO UPDATE SET
          started_at = COALESCE(source_run_results.started_at, excluded.started_at)
      `).run({ runId, sourceId: source.id, startedAt });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Commit one settled source while the crawl is still running. This keeps a
   * successful source durable even if a later source crashes or the process is
   * interrupted. The final persistRun call remains responsible for lifecycle
   * reconciliation such as markMissing().
   */
  public persistSourceResult(runId: number, result: CrawlResult["sourceResults"][number]): void {
    const sourceKey = canonicalizeUrl(result.sourceUrl);
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnership(runId);
      this.persistFailures(runId, result.failures);
      this.persistSourceMetadata(runId, result);
      const seenInternshipIds = new Set<string>();
      for (const analyzed of result.jobs) {
        if (analyzed.internship.relevanceScore < MIN_LISTING_SCORE) continue;
        seenInternshipIds.add(this.upsertInternship(runId, analyzed.internship, analyzed.cacheMetadata));
      }
      const now = new Date().toISOString();
      for (const closed of result.closedPages) {
        this.markClosedByUrl(runId, closed.url, now, seenInternshipIds);
      }
      this.database.exec("COMMIT");
      this.updateRunProgressFromSourceResults(runId);
      const persistedSources = this.incrementallyPersistedSources.get(runId) ?? new Set<string>();
      persistedSources.add(sourceKey);
      this.incrementallyPersistedSources.set(runId, persistedSources);
      const persistedClosed = this.incrementallyPersistedClosedUrls.get(runId) ?? new Set<string>();
      for (const closed of result.closedPages) persistedClosed.add(canonicalizeUrl(closed.url));
      this.incrementallyPersistedClosedUrls.set(runId, persistedClosed);
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  public persistRun(runId: number, crawl: CrawlResult, closedAfterMisses: number, onCommitted?: () => void): PersistedRunResult {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.assertRunOwnership(runId);
      const incrementallyPersisted = this.incrementallyPersistedSources.get(runId) ?? new Set<string>();
      this.persistFailures(runId, crawl.failures.filter((failure) => !incrementallyPersisted.has(canonicalizeUrl(failure.sourceUrl))));
      const completed = new Set(crawl.completedSourceUrls.map((value) => canonicalizeUrl(value)));
      const now = new Date().toISOString();
      for (const result of crawl.sourceResults) {
        if (!incrementallyPersisted.has(canonicalizeUrl(result.sourceUrl))) this.persistSourceMetadata(runId, result);
      }

      const seenInternshipIds = new Set<string>();
      for (const analyzed of crawl.jobs) {
        const allSourcesWerePersisted = analyzed.internship.sources.length > 0
          && analyzed.internship.sources.every((source) => incrementallyPersisted.has(canonicalizeUrl(source)));
        if (!allSourcesWerePersisted && analyzed.internship.relevanceScore >= MIN_LISTING_SCORE) {
          seenInternshipIds.add(this.upsertInternship(runId, analyzed.internship, analyzed.cacheMetadata));
        }
      }
      const incrementallyPersistedClosed = this.incrementallyPersistedClosedUrls.get(runId) ?? new Set<string>();
      for (const closed of crawl.closedPages) {
        if (!incrementallyPersistedClosed.has(canonicalizeUrl(closed.url))) this.markClosedByUrl(runId, closed.url, now, seenInternshipIds);
      }
      this.markMissing(runId, [...completed], closedAfterMisses, now, seenInternshipIds);
      const runCounts = this.database.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN lifecycle_status = 'NEW' THEN 1 ELSE 0 END), 0) AS new_count,
          COALESCE(SUM(CASE WHEN lifecycle_status = 'UPDATED' THEN 1 ELSE 0 END), 0) AS updated_count,
          COALESCE(SUM(CASE WHEN lifecycle_status = 'UNCHANGED' THEN 1 ELSE 0 END), 0) AS unchanged_count,
          COALESCE(SUM(CASE WHEN lifecycle_status = 'REMOVED_OR_CLOSED' THEN 1 ELSE 0 END), 0) AS closed_count
        FROM run_internships WHERE run_id = @runId
      `).get({ runId }) as unknown as {
        new_count: number;
        updated_count: number;
        unchanged_count: number;
        closed_count: number;
      };

      this.database.prepare(`
        UPDATE crawl_runs
        SET finished_at = @finishedAt, heartbeat_at = NULL, status = 'COMPLETED', sources_settled = MAX(sources_settled, @sourcesSettled),
            sources_completed = MAX(sources_completed, @sourcesCompleted),
            pages_visited = MAX(pages_visited, @pagesVisited), potential_postings_inspected = MAX(potential_postings_inspected, @potentialPostingsInspected),
            internships_discovered = MAX(internships_discovered, @internshipsDiscovered), new_count = @newCount,
            updated_count = @updatedCount, unchanged_count = @unchangedCount, closed_count = @closedCount
        WHERE id = @runId
      `).run({
        finishedAt: now,
        sourcesSettled: crawl.sourceResults.length,
        sourcesCompleted: crawl.sourcesCompleted,
        pagesVisited: crawl.pagesVisited,
        potentialPostingsInspected: crawl.potentialPostingsInspected,
        internshipsDiscovered: crawl.jobsDiscovered ?? crawl.jobs.length,
        newCount: runCounts.new_count,
        updatedCount: runCounts.updated_count,
        unchangedCount: runCounts.unchanged_count,
        closedCount: runCounts.closed_count,
        runId,
      });
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }

    // The run row and all role lifecycle changes are durable at this point.
    // A dashboard consumer may begin an independent read-side prewarm before
    // the legacy export projection below parses and formats every run role.
    // Keep this callback best-effort: a read-side optimization must never turn
    // an already-committed crawl into a failed run.
    try {
      onCommitted?.();
    } catch {
      // Preserve the committed crawl result even if an optional observer fails.
    }

    const internships = this.getRunInternships(runId);
    const counts: Record<LifecycleStatus, number> = { NEW: 0, UPDATED: 0, UNCHANGED: 0, REMOVED_OR_CLOSED: 0 };
    for (const internship of internships) counts[internship.lifecycleStatus] += 1;
    return { runId, internships, counts };
  }

  public getRunInternships(runId: number): Internship[] {
    const rows = this.database.prepare(`
      SELECT i.id, i.payload_json
      FROM run_internships run
      JOIN internships i ON i.id = run.internship_id
      WHERE run.run_id = @runId
      ORDER BY CASE run.lifecycle_status WHEN 'NEW' THEN 1 WHEN 'UPDATED' THEN 2 WHEN 'UNCHANGED' THEN 3 ELSE 4 END,
               i.company COLLATE NOCASE, i.title COLLATE NOCASE
    `).all({ runId }) as unknown as Array<{ id: string; payload_json: string }>;
    return rows.flatMap(({ payload_json: payload }) => {
      try {
        const internship = InternshipSchema.parse(JSON.parse(payload));
        return [internship];
      } catch {
        return [];
      }
    });
  }

  private persistFailures(runId: number, failures: CrawlResult["failures"]): void {
    for (const failure of failures) {
      const source = this.ensureSource(failure.sourceUrl);
      this.database.prepare(`
        INSERT INTO failed_pages (run_id, source_id, url, error_type, message, status_code, retry_count, occurred_at)
        VALUES (@runId, @sourceId, @url, @errorType, @message, @statusCode, @retryCount, @occurredAt)
      `).run({
        runId,
        sourceId: source.id,
        url: failure.url,
        errorType: failure.errorType,
        message: failure.message,
        statusCode: failure.statusCode,
        retryCount: failure.retryCount,
        occurredAt: failure.occurredAt,
      });
    }
  }

  private persistSourceMetadata(runId: number, result: CrawlResult["sourceResults"][number]): void {
    const source = this.ensureSource(result.sourceUrl);
    const now = new Date().toISOString();
    this.database.prepare(`
      UPDATE sources SET last_crawled_at = @now, last_run_id = @runId, last_status = @status WHERE id = @id
    `).run({ now, runId, status: result.completed ? "COMPLETED" : "FAILED", id: source.id });
    this.database.prepare(`
      INSERT INTO source_run_results (
        run_id, source_id, settled, completed, pages_visited, potential_postings_inspected, jobs_discovered, failure_count,
        started_at, duration_ms, retrieval_mode, retrieval_urls_json, coverage_notes_json, status, retrieval_method, attempts,
        http_status, direct_application_links
      ) VALUES (
        @runId, @sourceId, 1, @completed, @pagesVisited, @potentialPostingsInspected, @jobsDiscovered, @failureCount,
        @startedAt, @durationMs, @retrievalMode, @retrievalUrls, @coverageNotes, @status, @retrievalMethod, @attempts,
        @httpStatus, @directApplicationLinks
      )
      ON CONFLICT(run_id, source_id) DO UPDATE SET
        settled = 1,
        completed = excluded.completed,
        pages_visited = excluded.pages_visited,
        potential_postings_inspected = excluded.potential_postings_inspected,
        jobs_discovered = excluded.jobs_discovered,
        failure_count = excluded.failure_count,
        started_at = COALESCE(source_run_results.started_at, excluded.started_at),
        duration_ms = excluded.duration_ms,
        retrieval_mode = excluded.retrieval_mode,
        retrieval_urls_json = excluded.retrieval_urls_json,
        coverage_notes_json = excluded.coverage_notes_json,
        status = excluded.status,
        retrieval_method = excluded.retrieval_method,
        attempts = excluded.attempts,
        http_status = excluded.http_status,
        direct_application_links = excluded.direct_application_links
    `).run({
      runId,
      sourceId: source.id,
      completed: result.completed ? 1 : 0,
      pagesVisited: result.pagesVisited,
      potentialPostingsInspected: result.potentialPostingsInspected,
      jobsDiscovered: result.jobsDiscovered ?? result.jobs.length,
      failureCount: result.failures.length,
      startedAt: result.startedAt ?? null,
      durationMs: result.durationMs ?? null,
      retrievalMode: result.retrievalMode ?? "configured_url",
      retrievalUrls: JSON.stringify(result.retrievalUrls ?? [result.sourceUrl]),
      coverageNotes: JSON.stringify(result.coverageNotes ?? []),
      status: result.status ?? (result.completed ? "success" : "source_unavailable"),
      retrievalMethod: result.retrievalMethod ?? "configured_url",
      attempts: result.attempts ?? 0,
      httpStatus: result.httpStatus ?? null,
      directApplicationLinks: result.directApplicationLinks ?? 0,
    });
  }

  public close(): void {
    this.database.close();
  }

  private purgeBelowMinimumScore(): void {
    this.database.prepare(`
      DELETE FROM internships
      WHERE CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) < @minimumScore
    `).run({ minimumScore: MIN_LISTING_SCORE });
  }

  /**
   * Rewrite the small legacy category vocabulary once, while the schema
   * transaction is already holding the writer reservation. Reads still
   * normalize through CategorySchema, but durable normalization prevents old
   * payloads from repeatedly exercising compatibility code on every run.
   */
  private normalizeLegacyCategoryPayloads(): void {
    const rows = this.database.prepare(`
      SELECT id, payload_json
      FROM internships
      WHERE payload_json LIKE '%"other"%'
         OR payload_json LIKE '%"other_code"%'
         OR payload_json LIKE '%"other code"%'
    `).iterate() as Iterable<{ id: string; payload_json: string }>;
    const update = this.database.prepare(`
      UPDATE internships
      SET payload_json = @payload, content_hash = @contentHash
      WHERE id = @id
    `);
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.payload_json);
      } catch {
        continue;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const record = parsed as Record<string, unknown>;
      if (!Array.isArray(record.categories)) continue;
      const rawCategories = record.categories;
      const categories = rawCategories.map(normalizeCategory);
      if (categories.every((category, index) => category === rawCategories[index])) continue;
      const normalized = InternshipSchema.safeParse({ ...record, categories });
      if (!normalized.success) continue;
      update.run({
        id: row.id,
        payload: JSON.stringify(normalized.data),
        contentHash: internshipContentHash(normalized.data),
      });
    }
  }

  private migrateSchema(): void {
    const columns = this.database.prepare("PRAGMA table_info(crawl_runs)").all() as unknown as Array<{ name: string }>;
    const migrations = [
      ["heartbeat_at", "TEXT"],
      ["cancel_requested_at", "TEXT"],
      ["sources_settled", "INTEGER NOT NULL DEFAULT 0"],
      ["potential_postings_inspected", "INTEGER NOT NULL DEFAULT 0"],
      ["new_count", "INTEGER NOT NULL DEFAULT 0"],
      ["updated_count", "INTEGER NOT NULL DEFAULT 0"],
      ["unchanged_count", "INTEGER NOT NULL DEFAULT 0"],
      ["closed_count", "INTEGER NOT NULL DEFAULT 0"],
      ["cache_hits", "INTEGER NOT NULL DEFAULT 0"],
      ["unchanged_skips", "INTEGER NOT NULL DEFAULT 0"],
      ["new_listings", "INTEGER NOT NULL DEFAULT 0"],
      ["changed_listings", "INTEGER NOT NULL DEFAULT 0"],
      ["retryable_failures", "INTEGER NOT NULL DEFAULT 0"],
      ["detail_pages_fetched", "INTEGER NOT NULL DEFAULT 0"],
      ["duplicate_listings_skipped", "INTEGER NOT NULL DEFAULT 0"],
      ["irrelevant_listings_skipped", "INTEGER NOT NULL DEFAULT 0"],
      ["http_requests", "INTEGER NOT NULL DEFAULT 0"],
      ["browser_navigations", "INTEGER NOT NULL DEFAULT 0"],
    ] as const;
    let addedLifecycleCounts = false;
    for (const [name, definition] of migrations) {
      if (columns.some((column) => column.name === name)) continue;
      this.database.exec(`ALTER TABLE crawl_runs ADD COLUMN ${name} ${definition}`);
      if (name.endsWith("_count")) addedLifecycleCounts = true;
    }
    if (addedLifecycleCounts) {
      this.database.exec(`
        UPDATE crawl_runs SET
          new_count = (SELECT COUNT(*) FROM run_internships WHERE run_id = crawl_runs.id AND lifecycle_status = 'NEW'),
          updated_count = (SELECT COUNT(*) FROM run_internships WHERE run_id = crawl_runs.id AND lifecycle_status = 'UPDATED'),
          unchanged_count = (SELECT COUNT(*) FROM run_internships WHERE run_id = crawl_runs.id AND lifecycle_status = 'UNCHANGED'),
          closed_count = (SELECT COUNT(*) FROM run_internships WHERE run_id = crawl_runs.id AND lifecycle_status = 'REMOVED_OR_CLOSED')
      `);
    }
    const sourceColumns = this.database.prepare("PRAGMA table_info(sources)").all() as unknown as Array<{ name: string }>;
    if (!sourceColumns.some((column) => column.name === "is_configured")) {
      this.database.exec("ALTER TABLE sources ADD COLUMN is_configured INTEGER NOT NULL DEFAULT 0");
    }

    const sourceRunColumns = this.database.prepare("PRAGMA table_info(source_run_results)").all() as unknown as Array<{ name: string }>;
    const sourceRunMigrations = [
      ["settled", "INTEGER NOT NULL DEFAULT 1"],
      ["started_at", "TEXT"],
      ["duration_ms", "INTEGER"],
      ["retrieval_mode", "TEXT NOT NULL DEFAULT 'configured_url'"],
      ["retrieval_urls_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["coverage_notes_json", "TEXT NOT NULL DEFAULT '[]'"],
      ["status", "TEXT NOT NULL DEFAULT 'source_unavailable'"],
      ["retrieval_method", "TEXT"],
      ["attempts", "INTEGER"],
      ["http_status", "INTEGER"],
      ["direct_application_links", "INTEGER"],
    ] as const;
    for (const [name, definition] of sourceRunMigrations) {
      if (sourceRunColumns.some((column) => column.name === name)) continue;
      this.database.exec(`ALTER TABLE source_run_results ADD COLUMN ${name} ${definition}`);
    }

    const internshipColumns = this.database.prepare("PRAGMA table_info(internships)").all() as unknown as Array<{ name: string }>;
    const internshipMigrations = [
      ["canonical_url", "TEXT"],
      ["canonical_application_url", "TEXT"],
      ["canonical_posting_url", "TEXT"],
      ["external_job_id", "TEXT"],
      ["provider_identity", "TEXT"],
      ["last_checked_at", "TEXT"],
      ["etag", "TEXT"],
      ["last_modified", "TEXT"],
      ["failure_state", "TEXT NOT NULL DEFAULT 'none'"],
      ["failure_count", "INTEGER NOT NULL DEFAULT 0"],
      ["last_failure_at", "TEXT"],
      ["last_failure_message", "TEXT"],
    ] as const;
    for (const [name, definition] of internshipMigrations) {
      if (internshipColumns.some((column) => column.name === name)) continue;
      this.database.exec(`ALTER TABLE internships ADD COLUMN ${name} ${definition}`);
    }
    // Indexes are intentionally created after legacy columns are backfilled.
    this.database.exec(`
      CREATE INDEX IF NOT EXISTS internships_canonical_application_url_idx ON internships(canonical_application_url);
      CREATE INDEX IF NOT EXISTS internships_canonical_posting_url_idx ON internships(canonical_posting_url);
      CREATE INDEX IF NOT EXISTS internships_canonical_url_idx ON internships(canonical_url);
      CREATE INDEX IF NOT EXISTS internships_external_job_id_idx ON internships(external_job_id);
      CREATE INDEX IF NOT EXISTS internships_provider_identity_idx ON internships(provider_identity);
      CREATE INDEX IF NOT EXISTS internships_open_last_seen_idx ON internships(availability_status, last_seen_run_id);
    `);
    const legacyRows = this.database.prepare(`
      SELECT id, application_url, posting_url, job_id, payload_json, canonical_url, canonical_application_url, canonical_posting_url,
             external_job_id, provider_identity, last_checked_at
      FROM internships
      WHERE canonical_url IS NULL OR canonical_application_url IS NULL OR canonical_posting_url IS NULL OR external_job_id IS NULL OR provider_identity IS NULL OR last_checked_at IS NULL
    `).all() as unknown as Array<{
      id: string;
      application_url: string;
      posting_url: string;
      job_id: string | null;
      payload_json: string;
      canonical_application_url: string | null;
      canonical_posting_url: string | null;
      canonical_url: string | null;
      external_job_id: string | null;
      provider_identity: string | null;
      last_checked_at: string | null;
    }>;
    const updateLegacy = this.database.prepare(`
      UPDATE internships SET canonical_url = COALESCE(canonical_url, @canonicalUrl), canonical_application_url = @applicationUrl, canonical_posting_url = @postingUrl,
        external_job_id = @externalJobId, provider_identity = COALESCE(provider_identity, @providerIdentity),
        last_checked_at = COALESCE(last_checked_at, @lastVerifiedAt)
      WHERE id = @id
    `);
    for (const row of legacyRows) {
      let providerIdentity: string | null = null;
      try {
        providerIdentity = providerJobIdentityKeys(InternshipSchema.parse(JSON.parse(row.payload_json)))[0] ?? null;
      } catch {
        // Legacy malformed payloads still receive URL/job-id indexes.
      }
      updateLegacy.run({
        id: row.id,
        applicationUrl: normalizedJobUrl(row.application_url),
        postingUrl: normalizedJobUrl(row.posting_url),
        canonicalUrl: normalizedJobUrl(row.posting_url),
        externalJobId: row.external_job_id ?? row.job_id,
        providerIdentity,
        lastVerifiedAt: new Date().toISOString(),
      });
    }
  }

  private updateRunProgressFromSourceResults(runId: number): void {
    const totals = this.database.prepare(`
      SELECT COUNT(*) AS sources_settled,
             COALESCE(SUM(completed), 0) AS sources_completed,
             COALESCE(SUM(pages_visited), 0) AS pages_visited,
             COALESCE(SUM(potential_postings_inspected), 0) AS potential_postings_inspected,
             COALESCE(SUM(jobs_discovered), 0) AS internships_discovered
      FROM source_run_results
      WHERE run_id = @runId AND settled = 1
    `).get({ runId }) as unknown as {
      sources_settled: number | bigint;
      sources_completed: number | bigint;
      pages_visited: number | bigint;
      potential_postings_inspected: number | bigint;
      internships_discovered: number | bigint;
    };
    this.database.prepare(`
      UPDATE crawl_runs
      SET sources_settled = MAX(sources_settled, @sourcesSettled), sources_completed = MAX(sources_completed, @sourcesCompleted),
          pages_visited = MAX(pages_visited, @pagesVisited), potential_postings_inspected = MAX(potential_postings_inspected, @potentialPostingsInspected),
          internships_discovered = MAX(internships_discovered, @internshipsDiscovered)
      WHERE id = @runId AND status = 'RUNNING'
    `).run({
      runId,
      sourcesSettled: asNumber(totals.sources_settled),
      sourcesCompleted: asNumber(totals.sources_completed),
      pagesVisited: asNumber(totals.pages_visited),
      potentialPostingsInspected: asNumber(totals.potential_postings_inspected),
      internshipsDiscovered: asNumber(totals.internships_discovered),
    });
  }

  private assertRunOwnership(runId: number): void {
    const run = this.database.prepare(`
      SELECT status, cancel_requested_at FROM crawl_runs WHERE id = @runId
    `).get({ runId }) as unknown as { status: string; cancel_requested_at: string | null } | undefined;
    if (!run || run.status !== "RUNNING") {
      throw new Error(`Cannot persist crawl run ${runId}: it is no longer running.`);
    }
    if (run.cancel_requested_at !== null && run.cancel_requested_at !== undefined) {
      throw new CrawlCancelledError();
    }
    const latestRunning = this.database.prepare(`
      SELECT id FROM crawl_runs
      WHERE status = 'RUNNING'
      ORDER BY id DESC
      LIMIT 1
    `).get() as unknown as { id: number } | undefined;
    if (!latestRunning || latestRunning.id !== runId) {
      throw new Error(`Cannot persist crawl run ${runId}: another crawl owns the database.`);
    }
  }

  private getInternshipById(id: string): Internship | null {
    const row = this.database.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id }) as unknown as { payload_json: string } | undefined;
    if (!row) return null;
    try {
      return InternshipSchema.parse(JSON.parse(row.payload_json));
    } catch {
      return null;
    }
  }

  private ensureSource(url: string, configured = false): SourceRow {
    const canonical = canonicalizeUrl(url);
    this.database.prepare(`
      INSERT INTO sources (url, created_at, is_configured) VALUES (@url, @now, @configured)
      ON CONFLICT(url) DO UPDATE SET is_configured = MAX(sources.is_configured, excluded.is_configured)
    `).run({ url: canonical, now: new Date().toISOString(), configured: configured ? 1 : 0 });
    const row = this.database.prepare("SELECT id, url FROM sources WHERE url = @url").get({ url: canonical }) as unknown as SourceRow | undefined;
    if (!row) throw new Error(`Could not create source ${canonical}`);
    return row;
  }

  private duplicateIdentityMatches(internship: Internship): InternshipRow[] {
    const candidateKeys = new Set(providerJobIdentityKeys(internship));
    const candidateUrls = uniqueStrings([
      normalizedJobUrl(internship.applicationUrl),
      normalizedJobUrl(internship.postingUrl),
    ]).filter((url) => !isCompanyLandingUrl(url));
    const rowsById = new Map<string, InternshipRow>();
    const urlRows = this.database.prepare(`
      SELECT * FROM internships
      WHERE canonical_url IN (@applicationUrl, @postingUrl)
         OR canonical_application_url IN (@applicationUrl, @postingUrl)
         OR canonical_posting_url IN (@applicationUrl, @postingUrl)
         OR application_url IN (@applicationUrl, @postingUrl)
         OR posting_url IN (@applicationUrl, @postingUrl)
    `).all({ applicationUrl: candidateUrls[0] ?? "", postingUrl: candidateUrls[1] ?? candidateUrls[0] ?? "" }) as unknown as InternshipRow[];
    for (const row of urlRows) rowsById.set(row.id, row);
    if (candidateKeys.size > 0) {
      const providerRows = this.database.prepare(`SELECT * FROM internships WHERE provider_identity IN (${[...candidateKeys].map((_, index) => `@provider${index}`).join(", ")})`)
        .all(Object.fromEntries([...candidateKeys].map((key, index) => [`provider${index}`, key]))) as unknown as InternshipRow[];
      for (const row of providerRows) rowsById.set(row.id, row);
    }
    const sameRoleRows = this.database.prepare(`
      SELECT * FROM internships
      WHERE normalized_company = @company AND normalized_title = @title
    `).all({
      company: normalizeCompanyIdentity(internship.company),
      title: normalizeRoleIdentity(internship.title),
    }) as unknown as InternshipRow[];
    for (const row of sameRoleRows) rowsById.set(row.id, row);
    const rows = [...rowsById.values()];
    const normalizedUrlMatches = rows.filter((row) => {
      const existing = row.canonical_application_url || row.canonical_posting_url
        ? [row.canonical_application_url, row.canonical_posting_url]
        : [normalizedJobUrl(row.application_url), normalizedJobUrl(row.posting_url)];
      return existing.some((url) => url !== null && candidateUrls.includes(url));
    });
    const providerMatches = candidateKeys.size === 0 ? [] : rows.filter((row) => row.provider_identity !== null && candidateKeys.has(row.provider_identity));
    const sameRole = rows
      .map((row) => ({ row, internship: InternshipSchema.parse(JSON.parse(row.payload_json)) }))
      .filter(({ internship: existing }) => normalizeCompanyIdentity(existing.company) === normalizeCompanyIdentity(internship.company)
        && normalizeRoleIdentity(existing.title) === normalizeRoleIdentity(internship.title));
    const compatibleSurfaceMatches = sameRole.filter(({ internship: existing }) => {
      const candidateAggregator = isAggregatorUrl(internship.applicationUrl);
      const existingAggregator = isAggregatorUrl(existing.applicationUrl);
      return candidateAggregator !== existingAggregator
        || (candidateAggregator && existingAggregator && locationsOverlap(existing, internship));
    });
    const overlappingAggregatorMatches = compatibleSurfaceMatches.filter(({ internship: existing }) => locationsOverlap(existing, internship));
    const aggregatorMatches = overlappingAggregatorMatches.length > 0
      ? overlappingAggregatorMatches
      : compatibleSurfaceMatches.length === 1 ? compatibleSurfaceMatches : [];
    return [...new Map([
      ...normalizedUrlMatches,
      ...providerMatches,
      ...aggregatorMatches.map(({ row }) => row),
    ].map((row) => [row.id, row])).values()];
  }

  private findExisting(internship: Internship, duplicateMatches = this.duplicateIdentityMatches(internship)): InternshipRow | null {
    const normalizedApplicationUrl = normalizedJobUrl(internship.applicationUrl);
    const normalizedPostingUrl = normalizedJobUrl(internship.postingUrl);
    const urlMatch = this.database.prepare(`
      SELECT * FROM internships
      WHERE application_url IN (@applicationUrl, @postingUrl, @normalizedApplicationUrl, @normalizedPostingUrl)
         OR posting_url IN (@applicationUrl, @postingUrl, @normalizedApplicationUrl, @normalizedPostingUrl)
      LIMIT 1
    `).get({
      applicationUrl: isCompanyLandingUrl(internship.applicationUrl) ? "" : internship.applicationUrl,
      postingUrl: isCompanyLandingUrl(internship.postingUrl) ? "" : internship.postingUrl,
      normalizedApplicationUrl: isCompanyLandingUrl(normalizedApplicationUrl) ? "" : normalizedApplicationUrl,
      normalizedPostingUrl: isCompanyLandingUrl(normalizedPostingUrl) ? "" : normalizedPostingUrl,
    }) as unknown as InternshipRow | undefined;
    if (urlMatch) return urlMatch;
    const duplicateMatch = duplicateMatches.toSorted((left, right) => left.first_seen_at.localeCompare(right.first_seen_at))[0];
    if (duplicateMatch) return duplicateMatch;
    if (internship.jobId) {
      const candidates = this.database.prepare("SELECT * FROM internships WHERE job_id = @jobId")
        .all({ jobId: internship.jobId }) as unknown as InternshipRow[];
      const candidateKeys = new Set(providerJobIdentityKeys(internship));
      const jobMatch = candidates.find((row) => {
        const existing = InternshipSchema.parse(JSON.parse(row.payload_json));
        return normalizeCompanyIdentity(existing.company) === normalizeCompanyIdentity(internship.company)
          || providerJobIdentityKeys(existing).some((key) => candidateKeys.has(key));
      });
      if (jobMatch) return jobMatch;
    }
    const exactFallbackCandidates = this.database.prepare(`
      SELECT * FROM internships
      WHERE normalized_company = @company AND normalized_title = @title AND location_key = @locationKey
    `).all({
      company: normalizeCompanyIdentity(internship.company),
      title: normalizeRoleIdentity(internship.title),
      locationKey: locationKey(internship),
    }) as unknown as InternshipRow[];
    const exactFallback = exactFallbackCandidates.find((row) => !conflictingDirectJobIds(
      InternshipSchema.parse(JSON.parse(row.payload_json)),
      internship,
    ));
    if (exactFallback) return exactFallback;
    const sameRole = this.database.prepare(`
      SELECT * FROM internships WHERE normalized_company = @company AND normalized_title = @title
    `).all({
      company: normalizeCompanyIdentity(internship.company),
      title: normalizeRoleIdentity(internship.title),
    }) as unknown as InternshipRow[];
    return sameRole.find((row) => {
      const existing = InternshipSchema.parse(JSON.parse(row.payload_json));
      return !conflictingDirectJobIds(existing, internship) && locationsOverlap(existing, internship);
    }) ?? null;
  }

  private upsertInternship(runId: number, candidate: Internship, cacheMetadata?: ListingCacheMetadata): string {
    const duplicateMatches = this.duplicateIdentityMatches(candidate);
    const existing = this.findExisting(candidate, duplicateMatches);
    const existingPayload = existing ? InternshipSchema.parse(JSON.parse(existing.payload_json)) : null;
    const id = existing?.id ?? candidate.id;
    const duplicatePayloads = duplicateMatches
      .filter((row) => row.id !== existing?.id)
      .map((row) => InternshipSchema.parse(JSON.parse(row.payload_json)));
    const existingHasCompanyLandingUrl = existingPayload !== null
      && (isCompanyLandingUrl(existingPayload.applicationUrl) || isCompanyLandingUrl(existingPayload.postingUrl));
    const candidateHasRowSpecificUrl = [candidate.applicationUrl, candidate.postingUrl]
      .some((url) => !isCompanyLandingUrl(url) && normalizedJobUrl(url) !== normalizedJobUrl(candidate.sourceUrl));
    const authoritativeRefresh = existingPayload !== null
      && (
        normalizedJobUrl(candidate.postingUrl) === normalizedJobUrl(existingPayload.postingUrl)
        || (
          normalizedJobUrl(candidate.applicationUrl) === normalizedJobUrl(existingPayload.applicationUrl)
          && !isAggregatorUrl(candidate.postingUrl)
          && isAggregatorUrl(existingPayload.postingUrl)
        )
        || (existingHasCompanyLandingUrl && candidateHasRowSpecificUrl)
      );
    const mergedCandidate = [authoritativeRefresh ? null : existingPayload, ...duplicatePayloads]
      .filter((payload): payload is Internship => payload !== null)
      .reduce((merged, payload) => internshipQuality(payload) > internshipQuality(merged)
        ? mergeInternships(payload, merged)
        : mergeInternships(merged, payload), candidate);
    const sources = uniqueStrings([
      ...(existingPayload?.sources ?? []),
      ...duplicatePayloads.flatMap((payload) => payload.sources),
      ...candidate.sources,
    ]);
    const firstSeenAt = [existing?.first_seen_at, ...duplicateMatches.map((row) => row.first_seen_at), candidate.discoveredAt]
      .filter((value): value is string => Boolean(value))
      .sort()[0] ?? candidate.discoveredAt;
    const internship = InternshipSchema.parse({
      ...mergedCandidate,
      id,
      sourceUrl: existingPayload?.sourceUrl ?? candidate.sourceUrl,
      sources,
      lifecycleStatus: "UNCHANGED",
      availabilityStatus: "open",
      discoveredAt: firstSeenAt,
    });
    const finalHash = internshipContentHash(internship);
    const lifecycleStatus: LifecycleStatus = !existing
      ? "NEW"
      : existing.content_hash !== finalHash || existing.availability_status === "closed"
        ? "UPDATED"
        : "UNCHANGED";
    const persistedInternship = InternshipSchema.parse({ ...internship, lifecycleStatus });
    const canonicalApplicationUrl = normalizedJobUrl(persistedInternship.applicationUrl);
    const canonicalPostingUrl = normalizedJobUrl(persistedInternship.postingUrl);
    const canonicalUrl = canonicalPostingUrl || canonicalApplicationUrl;
    const providerIdentity = providerJobIdentityKeys(persistedInternship)[0] ?? null;
    const etag = cacheMetadata?.etag ?? null;
    const lastModified = cacheMetadata?.lastModified ?? null;
    this.database.prepare(`
      INSERT INTO internships (
        id, job_id, company, normalized_company, title, normalized_title, location_key,
        application_url, posting_url, payload_json, content_hash, lifecycle_status, availability_status,
        first_seen_at, last_seen_at, last_verified_at, last_seen_run_id, status_run_id, miss_count,
        canonical_url, canonical_application_url, canonical_posting_url, external_job_id, provider_identity,
        last_checked_at, etag, last_modified, failure_state, failure_count, last_failure_at, last_failure_message
      ) VALUES (
        @id, @jobId, @company, @normalizedCompany, @title, @normalizedTitle, @locationKey,
        @applicationUrl, @postingUrl, @payload, @contentHash, @lifecycleStatus, 'open',
        @firstSeenAt, @lastSeenAt, @lastVerifiedAt, @runId, @runId, 0,
        @canonicalUrl, @canonicalApplicationUrl, @canonicalPostingUrl, @externalJobId, @providerIdentity,
        @lastCheckedAt, @etag, @lastModified, 'none', 0, NULL, NULL
      )
      ON CONFLICT(id) DO UPDATE SET
        job_id = excluded.job_id, company = excluded.company, normalized_company = excluded.normalized_company,
        title = excluded.title, normalized_title = excluded.normalized_title, location_key = excluded.location_key,
        application_url = excluded.application_url, posting_url = excluded.posting_url, payload_json = excluded.payload_json,
        content_hash = excluded.content_hash, lifecycle_status = excluded.lifecycle_status, availability_status = 'open',
        last_seen_at = excluded.last_seen_at, last_verified_at = excluded.last_verified_at,
        last_seen_run_id = excluded.last_seen_run_id, status_run_id = excluded.status_run_id, miss_count = 0,
        canonical_application_url = excluded.canonical_application_url,
        canonical_posting_url = excluded.canonical_posting_url,
        canonical_url = excluded.canonical_url,
        external_job_id = excluded.external_job_id,
        provider_identity = excluded.provider_identity,
        last_checked_at = excluded.last_checked_at,
        etag = COALESCE(excluded.etag, internships.etag),
        last_modified = COALESCE(excluded.last_modified, internships.last_modified),
        failure_state = 'none', failure_count = 0, last_failure_at = NULL, last_failure_message = NULL
    `).run({
      id,
      jobId: persistedInternship.jobId,
      company: persistedInternship.company,
      normalizedCompany: normalizeCompanyIdentity(persistedInternship.company),
      title: persistedInternship.title,
      normalizedTitle: normalizeRoleIdentity(persistedInternship.title),
      locationKey: locationKey(persistedInternship),
      applicationUrl: persistedInternship.applicationUrl,
      postingUrl: persistedInternship.postingUrl,
      payload: JSON.stringify(persistedInternship),
      contentHash: finalHash,
      lifecycleStatus,
      firstSeenAt: persistedInternship.discoveredAt,
      lastSeenAt: persistedInternship.lastVerifiedAt,
      lastVerifiedAt: persistedInternship.lastVerifiedAt,
      runId,
      canonicalApplicationUrl,
      canonicalPostingUrl,
      canonicalUrl,
      externalJobId: persistedInternship.jobId,
      providerIdentity,
      lastCheckedAt: persistedInternship.lastVerifiedAt,
      etag,
      lastModified,
    });

    for (const sourceUrl of candidate.sources) {
      const source = this.ensureSource(sourceUrl);
      this.database.prepare(`
        INSERT INTO internship_sources (internship_id, source_id, first_seen_at, last_seen_at, last_seen_run_id)
        VALUES (@internshipId, @sourceId, @now, @now, @runId)
        ON CONFLICT(internship_id, source_id) DO UPDATE SET last_seen_at = excluded.last_seen_at, last_seen_run_id = excluded.last_seen_run_id
      `).run({ internshipId: id, sourceId: source.id, now: internship.lastVerifiedAt, runId });
    }
    for (const duplicate of duplicateMatches.filter((row) => row.id !== id)) {
      this.mergeDuplicateRelations(id, duplicate.id);
      this.database.prepare("DELETE FROM internships WHERE id = @id").run({ id: duplicate.id });
    }
    this.recordRunInternship(runId, id, lifecycleStatus);
    return id;
  }

  private mergeDuplicateRelations(canonicalId: string, duplicateId: string): void {
    this.database.prepare(`
      INSERT INTO internship_sources (internship_id, source_id, first_seen_at, last_seen_at, last_seen_run_id)
      SELECT @canonicalId, source_id, first_seen_at, last_seen_at, last_seen_run_id
      FROM internship_sources WHERE internship_id = @duplicateId
      ON CONFLICT(internship_id, source_id) DO UPDATE SET
        first_seen_at = MIN(internship_sources.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(internship_sources.last_seen_at, excluded.last_seen_at),
        last_seen_run_id = MAX(internship_sources.last_seen_run_id, excluded.last_seen_run_id)
    `).run({ canonicalId, duplicateId });
    this.database.prepare(`
      INSERT INTO run_internships (run_id, internship_id, lifecycle_status)
      SELECT run_id, @canonicalId, lifecycle_status
      FROM run_internships WHERE internship_id = @duplicateId
      ON CONFLICT(run_id, internship_id) DO NOTHING
    `).run({ canonicalId, duplicateId });
  }

  private markClosedByUrl(runId: number, value: string, now: string, protectedIds: Set<string>): void {
    const url = canonicalizeUrl(value);
    const normalized = normalizedJobUrl(url);
    const rows = this.database.prepare(`
      SELECT * FROM internships
      WHERE application_url = @url OR posting_url = @url
         OR canonical_url = @normalized OR canonical_application_url = @normalized OR canonical_posting_url = @normalized
    `).all({ url, normalized }) as unknown as InternshipRow[];
    for (const row of rows) {
      if (!protectedIds.has(row.id)) this.markClosed(runId, row, now);
    }
  }

  private markMissing(
    runId: number,
    completedSourceUrls: string[],
    threshold: number,
    now: string,
    protectedIds: Set<string>,
  ): void {
    if (completedSourceUrls.length === 0) return;
    const candidates = new Map<string, InternshipRow>();
    const statement = this.database.prepare(`
      SELECT i.* FROM internships i
      JOIN internship_sources link ON link.internship_id = i.id
      JOIN sources s ON s.id = link.source_id
      WHERE s.url = @sourceUrl AND i.availability_status != 'closed' AND i.last_seen_run_id != @runId
    `);
    for (const sourceUrl of completedSourceUrls) {
      const rows = statement.all({ sourceUrl, runId }) as unknown as InternshipRow[];
      for (const row of rows) candidates.set(row.id, row);
    }
    for (const row of candidates.values()) {
      if (protectedIds.has(row.id)) continue;
      if (row.miss_count + 1 >= threshold) this.markClosed(runId, row, now);
      else this.database.prepare("UPDATE internships SET miss_count = miss_count + 1, last_verified_at = @now WHERE id = @id").run({ now, id: row.id });
    }
  }

  private markClosed(runId: number, row: InternshipRow, now: string): void {
    const existing = InternshipSchema.parse(JSON.parse(row.payload_json));
    const closed = InternshipSchema.parse({
      ...existing,
      lifecycleStatus: "REMOVED_OR_CLOSED",
      availabilityStatus: "closed",
      lastVerifiedAt: now,
    });
    this.database.prepare(`
      UPDATE internships
      SET payload_json = @payload, lifecycle_status = 'REMOVED_OR_CLOSED', availability_status = 'closed',
          last_verified_at = @now, status_run_id = @runId, miss_count = miss_count + 1
      WHERE id = @id
    `).run({ payload: JSON.stringify(closed), now, runId, id: row.id });
    this.recordRunInternship(runId, row.id, "REMOVED_OR_CLOSED");
  }

  private recordRunInternship(runId: number, internshipId: string, lifecycleStatus: LifecycleStatus): void {
    this.database.prepare(`
      INSERT INTO run_internships (run_id, internship_id, lifecycle_status)
      VALUES (@runId, @internshipId, @lifecycleStatus)
      ON CONFLICT(run_id, internship_id) DO UPDATE SET lifecycle_status = CASE
        WHEN excluded.lifecycle_status = 'REMOVED_OR_CLOSED' THEN excluded.lifecycle_status
        WHEN run_internships.lifecycle_status = 'NEW' OR excluded.lifecycle_status = 'NEW' THEN 'NEW'
        WHEN run_internships.lifecycle_status = 'UPDATED' OR excluded.lifecycle_status = 'UPDATED' THEN 'UPDATED'
        ELSE excluded.lifecycle_status
      END
    `).run({ runId, internshipId, lifecycleStatus });
  }
}
