import { pathToFileURL } from "node:url";

import { readConfiguredSourcesAtPath } from "./config/sourceCatalog.js";
import { JOBRIGHT_RESOLVER_MAX_DURATION_MS } from "./config/runLock.js";
import { resolveSettings } from "./config/settings.js";
import { InternshipDatabase } from "./database/db.js";
import { CrawlDeadlineExceededError, isCrawlDeadlineExceededError, throwIfAborted } from "./domain/cancellation.js";
import { BrowserManager } from "./crawler/browser.js";
import { InternListAdapter, internListFeeds } from "./crawler/adapters/internList.js";
import { HttpClient } from "./crawler/http.js";
import { extractJobrightJobs } from "./extractors/jobright.js";
import { sleep } from "./utils/async.js";
import { Logger } from "./utils/logger.js";

function isSqliteBusyError(error: unknown): boolean {
  return /database is (?:locked|busy)|SQLITE_(?:BUSY|LOCKED)/i.test(error instanceof Error ? error.message : String(error));
}

async function openDatabaseWithRetry(path: string, signal: AbortSignal, logger: Logger): Promise<InternshipDatabase> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      return new InternshipDatabase(path);
    } catch (error) {
      lastError = error;
      if (!isSqliteBusyError(error) || attempt === 5) throw error;
      logger.warn("ORIGINAL", `Database is busy while opening the Jobright cache; retrying (${attempt + 1}/5).`);
      await sleep(Math.min(15_000, 1_000 * (2 ** attempt)), signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * Refresh the durable Jobright -> employer/ATS map outside the crawl. The
 * recurring scout only consumes this map, so a slow Jobright page can never
 * hold source settlement or lifecycle persistence open.
 */
export async function runJobrightResolver(): Promise<void> {
  const argumentValue = (flag: string): string | undefined => {
    const index = process.argv.indexOf(flag);
    const value = index >= 0 ? process.argv[index + 1] : undefined;
    return value && !value.startsWith("-") ? value : undefined;
  };
  const settings = resolveSettings({
    databasePath: argumentValue("--database") ?? process.env.SCOUT_DATABASE_PATH ?? "./output/internships.db",
    outputDirectory: argumentValue("--output-dir") ?? process.env.SCOUT_OUTPUT_DIR ?? "./output",
    httpConcurrency: 8,
    browserConcurrency: 4,
    perDomainConcurrency: 3,
    retryCount: 1,
  });
  const logger = new Logger(process.env.SCOUT_LOG_LEVEL === "debug" ? "debug" : "info");
  const controller = new AbortController();
  const deadlineTimer = setTimeout(() => controller.abort(new CrawlDeadlineExceededError(JOBRIGHT_RESOLVER_MAX_DURATION_MS)), JOBRIGHT_RESOLVER_MAX_DURATION_MS);
  deadlineTimer.unref?.();
  const http = new HttpClient(settings, logger, undefined, controller.signal);
  const adapter = new InternListAdapter(http, logger);
  const browser = new BrowserManager(settings, logger, undefined, undefined, controller.signal);
  let database: InternshipDatabase | null = null;

  try {
    database = await openDatabaseWithRetry(settings.databasePath, controller.signal, logger);
    const sources = readConfiguredSourcesAtPath(settings.databasePath)
      .filter((source) => internListFeeds(source).length > 0)
      .toSorted((left, right) => internListFeeds(right).length - internListFeeds(left).length);
    const sourceUrl = sources[0];
    if (!sourceUrl) {
      logger.info("ORIGINAL", "No Intern List source is configured; Jobright destination cache is unchanged.");
      return;
    }

    const collected = await adapter.collect(sourceUrl);
    throwIfAborted(controller.signal);
    const jobs = [...new Map(
      collected.snapshots
        .flatMap((snapshot) => extractJobrightJobs(snapshot))
        .filter((job) => Boolean(job.jobId))
        .map((job) => [job.jobId as string, job]),
    ).values()];
    const activeDatabase = database;
    const known = activeDatabase.getJobrightDestinations(sourceUrl);
    const recentlyAttempted = activeDatabase.getJobrightResolutionKeys();
    const pending = jobs.filter((job) => {
      const key = job.jobId?.trim() || job.postingUrl;
      return !known.has(key)
        && !known.has(job.postingUrl)
        && !recentlyAttempted.has(key)
        && !recentlyAttempted.has(job.postingUrl);
    });
    let resolved = 0;
    let attempted = 0;
    let nextIndex = 0;
    const persistDestination = async (
      jobrightUrl: string,
      destinationUrl: string | null,
      errorMessage: string | null,
    ): Promise<boolean> => {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          activeDatabase.recordJobrightDestination(jobrightUrl, destinationUrl, errorMessage);
          return true;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (!/database is (?:locked|busy)|SQLITE_BUSY/i.test(message) || attempt === 4) {
            logger.warn("ORIGINAL", "Could not persist Jobright cache row for "
              + jobrightUrl + ": " + message);
            return false;
          }
          await sleep(Math.min(8_000, 1_000 * (2 ** attempt)), controller.signal);
        }
      }
      return false;
    };
    const worker = async (): Promise<void> => {
      while (true) {
        throwIfAborted(controller.signal);
        const index = nextIndex;
        nextIndex += 1;
        const job = pending[index];
        if (!job) return;
        attempted += 1;
        try {
          const destination = await browser.resolveOriginalJobPostUrl(job.postingUrl, sourceUrl);
          const persisted = await persistDestination(
            job.postingUrl,
            destination,
            destination ? null : "Original Job Post anchor was not present or did not name an employer/ATS URL.",
          );
          if (destination && persisted) resolved += 1;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          await persistDestination(
            job.postingUrl,
            null,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(settings.browserConcurrency, Math.max(1, pending.length)) }, () => worker()));
      logger.info("ORIGINAL", `Jobright cache refresh attempted ${attempted} link(s), resolved ${resolved}; ${collected.failures.length} feed failure(s).`);
    } catch (error) {
      const deadlineExceeded = isCrawlDeadlineExceededError(error)
        || isCrawlDeadlineExceededError(controller.signal.reason);
      if (!deadlineExceeded) throw error;
      logger.warn("ORIGINAL", `Jobright cache refresh reached its ${Math.round(JOBRIGHT_RESOLVER_MAX_DURATION_MS / 60_000)}-minute limit after ${attempted} attempt(s); partial results were saved.`);
    }
  } finally {
    clearTimeout(deadlineTimer);
    await browser.close();
    database?.close();
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runJobrightResolver().catch((error: unknown) => {
    if (isCrawlDeadlineExceededError(error)) {
      console.warn(`[ORIGINAL] Jobright cache refresh stopped at its ${Math.round(JOBRIGHT_RESOLVER_MAX_DURATION_MS / 60_000)}-minute limit.`);
      return;
    }
    console.error(`[FATAL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
