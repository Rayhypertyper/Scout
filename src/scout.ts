import { DatabaseSync } from "node:sqlite";

import { InternshipCrawler } from "./crawler/crawler.js";
import { activeRunMaxDurationMs, RUN_HEARTBEAT_INTERVAL_MS } from "./config/runLock.js";
import { InternshipDatabase } from "./database/db.js";
import type { Internship } from "./domain/schemas.js";
import { CliFiltersSchema } from "./domain/schemas.js";
import type { CrawlProgress, CrawlResult, PersistedRunResult, ScoutRunOptions } from "./domain/types.js";
import { writeCsvOutput } from "./output/csv.js";
import { printConsoleSummary } from "./output/console.js";
import { filterInternships } from "./output/filter.js";
import { writeJsonOutput } from "./output/json.js";
import { Logger } from "./utils/logger.js";
import { canonicalizeUrl, isHttpUrl } from "./utils/url.js";
import { CrawlCancelledError, CrawlDeadlineExceededError, isCrawlDeadlineExceededError, throwIfAborted } from "./domain/cancellation.js";

export interface ScoutExecution {
  crawl: CrawlResult;
  persisted: PersistedRunResult;
  displayed: Internship[];
  jsonPath: string;
  csvPath: string;
}

export async function runScout(options: ScoutRunOptions): Promise<ScoutExecution> {
  if (options.sources.length === 0) {
    throw new Error("No sources are configured. Add URLs to src/config/sources.ts or pass one or more --source flags.");
  }
  const sources = [...new Set(options.sources.map((source) => {
    if (!isHttpUrl(source)) throw new Error(`Source must be an HTTP(S) URL: ${source}`);
    return canonicalizeUrl(source);
  }))];
  const filters = CliFiltersSchema.parse(options.filters);
  throwIfAborted(options.cancellationSignal);
  const normalizedOptions: ScoutRunOptions = { ...options, sources, filters };
  const logger = new Logger(options.settings.verbose ? "debug" : "info");
  const database = new InternshipDatabase(options.settings.databasePath);
  try {
    const runId = database.startRun(normalizedOptions);
    options.onRunStarted?.(runId);
    const cancellation = new AbortController();
    let crawler: InternshipCrawler | null = null;
    const maxDurationMs = activeRunMaxDurationMs();
    const deadlineTimer = setTimeout(() => {
      if (cancellation.signal.aborted) return;
      const deadlineError = new CrawlDeadlineExceededError(maxDurationMs);
      logger.error("RUN", deadlineError.message);
      cancellation.abort(deadlineError);
      crawler?.cancel();
      // Make the cutoff visible immediately to the dashboard. The catch block
      // below remains the owner of the thrown error and is safe if this update
      // races a persistence transaction.
      try {
        database.markRunFailed(runId, deadlineError);
      } catch (error) {
        logger.error("RUN", `Could not mark deadline-exceeded run ${runId} as failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, maxDurationMs);
    // Keep the hard deadline referenced. If a browser/network promise loses
    // all of its own event-loop handles, an unref'ed deadline lets Node exit
    // silently with a RUNNING row still in SQLite. The worker must stay alive
    // until the deadline can cancel and finalize that run.
    const cancel = (): void => {
      if (cancellation.signal.aborted) return;
      cancellation.abort(new CrawlCancelledError());
      crawler?.cancel();
    };
    const onExternalCancellation = (): void => cancel();
    options.cancellationSignal?.addEventListener("abort", onExternalCancellation, { once: true });
    const cancellationPoller = setInterval(() => {
      if (!database.isRunCancellationRequested(runId) || cancellation.signal.aborted) return;
      cancel();
    }, 250);
    cancellationPoller.unref?.();
    // Use a dedicated SQLite connection for heartbeats so a long write
    // transaction on the main crawler connection (e.g., persisting a large
    // source with thousands of listings) cannot block the 60s heartbeat and
    // make the run appear stale to the dashboard watcher.
    const heartbeatDatabase = new DatabaseSync(options.settings.databasePath);
    heartbeatDatabase.exec("PRAGMA busy_timeout = 30000");
    const heartbeat = setInterval(() => {
      try {
        const result = heartbeatDatabase.prepare(`
          UPDATE crawl_runs
          SET heartbeat_at = @heartbeatAt
          WHERE id = @runId AND status = 'RUNNING'
        `).run({ heartbeatAt: new Date().toISOString(), runId });
        if (result.changes !== 1) {
          throw new Error(`Cannot heartbeat crawl run ${runId}: it is no longer running.`);
        }
      } catch (error) {
        logger.error("RUN", `Heartbeat lost for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, RUN_HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();
    try {
      const knownUrls = database.getKnownUrlsBySource(sources);
      crawler = new InternshipCrawler(options.settings, logger, {}, cancellation.signal);
      // SQLite has one owning run connection. Source workers may settle in
      // parallel, but all persistence/events are serialized through this
      // bounded promise lane to avoid concurrent BEGIN IMMEDIATE contention.
      let writerTail: Promise<void> = Promise.resolve();
      const enqueueWrite = (operation: () => void): Promise<void> => {
        const next = writerTail.catch(() => undefined).then(operation);
        writerTail = next.catch(() => undefined);
        return next;
      };
      let lastProgressWriteAt = 0;
      let lastProgressSourceCount = -1;
      const updateProgress = (progress: CrawlProgress): void => {
        const now = Date.now();
        if (progress.sourcesSettled === lastProgressSourceCount && now - lastProgressWriteAt < 1_000) return;
        database.updateRunProgress(runId, progress);
        lastProgressWriteAt = now;
        lastProgressSourceCount = progress.sourcesSettled;
      };
      const crawl = await crawler.crawl(
        sources,
        knownUrls,
        (sourceResult) => enqueueWrite(() => {
          database.persistSourceResult(runId, sourceResult);
          options.onSourceSettled?.(sourceResult.sourceUrl);
        }),
        updateProgress,
        {
          runId,
          signal: cancellation.signal,
          classifyListing: (source, hint) => database.classifyListing(source, hint),
          getJobrightDestinations: (source) => database.getJobrightDestinations(source),
          recordLightweightSightings: (id, sightings) => enqueueWrite(() => database.recordLightweightSightings(id, sightings)),
          recordCrawlMetrics: (id, metrics) => enqueueWrite(() => database.recordCrawlMetrics(id, metrics)),
          recordSourceStart: (source, startedAt) => {
            options.onSourceStarted?.(source, startedAt);
            return enqueueWrite(() => database.recordSourceStart(runId, source, startedAt));
          },
          recordSourceFetch: (source, patch) => enqueueWrite(() => database.recordSourceFetch(source, patch)),
          getSourceStrategy: (source) => database.getSourceStrategy(source),
        },
      );
      if (cancellation.signal.aborted) throw cancellation.signal.reason ?? new CrawlCancelledError();
      await writerTail;
      if (cancellation.signal.aborted) throw cancellation.signal.reason ?? new CrawlCancelledError();
      const persisted = database.persistRun(
        runId,
        crawl,
        options.settings.closedAfterMisses,
        () => options.onRunCommitted?.(runId),
      );
      const displayed = filterInternships(persisted.internships, filters);
      const [jsonPath, csvPath] = await Promise.all([
        writeJsonOutput(options.settings.outputDirectory, displayed),
        writeCsvOutput(options.settings.outputDirectory, displayed),
      ]);
      printConsoleSummary(crawl, persisted, displayed);
      logger.info("OUTPUT", jsonPath);
      logger.info("OUTPUT", csvPath);
      return { crawl, persisted, displayed, jsonPath, csvPath };
    } catch (error) {
      const deadlineExceeded = isCrawlDeadlineExceededError(error)
        || isCrawlDeadlineExceededError(cancellation.signal.reason);
      if (deadlineExceeded) {
        database.markRunFailed(runId, error instanceof CrawlDeadlineExceededError ? error : new CrawlDeadlineExceededError(maxDurationMs));
      } else if (cancellation.signal.aborted || database.isRunCancellationRequested(runId) || error instanceof CrawlCancelledError) {
        database.markRunCancelled(runId);
      } else {
        database.markRunFailed(runId, error);
      }
      throw error;
    } finally {
      clearTimeout(deadlineTimer);
      clearInterval(heartbeat);
      clearInterval(cancellationPoller);
      try {
        heartbeatDatabase.close();
      } catch {
        // The heartbeat connection may already be closed after a failed startup.
      }
      options.cancellationSignal?.removeEventListener("abort", onExternalCancellation);
    }
  } finally {
    database.close();
  }
}
