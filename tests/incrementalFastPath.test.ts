import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { database: InternshipDatabase; options: ScoutRunOptions; source: string } {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-fast-path-"));
  temporaryDirectories.push(directory);
  const source = "https://example.com/careers";
  const settings = resolveSettings({
    outputDirectory: join(directory, "output"),
    databasePath: join(directory, "crawl.db"),
    perHostDelayMs: 0,
  });
  const options: ScoutRunOptions = {
    sources: [source],
    settings,
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
  return { database: new InternshipDatabase(settings.databasePath), options, source };
}

function crawl(source: string, job: ReturnType<typeof makeInternship>, cacheMetadata?: CrawlResult["jobs"][number]["cacheMetadata"]): CrawlResult {
  const analyzedJob = cacheMetadata ? { ...analyzed(job), cacheMetadata } : analyzed(job);
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: 1,
    jobs: [analyzedJob],
    failures: [],
    closedPages: [],
    completedSourceUrls: [source],
    sourceResults: [{
      sourceUrl: source,
      pagesVisited: 1,
      potentialPostingsInspected: 1,
      jobs: [analyzedJob],
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

function emptyCrawl(source: string, completed: boolean): CrawlResult {
  return {
    sourcesRequested: 1,
    sourcesCompleted: completed ? 1 : 0,
    sourcesSuccessful: completed ? 1 : 0,
    sourcesPartiallyCompleted: completed ? 0 : 1,
    sourcesFailed: completed ? 0 : 1,
    pagesVisited: 0,
    potentialPostingsInspected: 0,
    jobs: [],
    failures: completed ? [] : [{
      sourceUrl: source,
      url: source,
      errorType: "source_unavailable",
      message: "partial source fixture",
      statusCode: null,
      retryCount: 0,
      occurredAt: new Date().toISOString(),
    }],
    closedPages: [],
    completedSourceUrls: completed ? [source] : [],
    sourceResults: [{
      sourceUrl: source,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      jobs: [],
      failures: completed ? [] : [{
        sourceUrl: source,
        url: source,
        errorType: "source_unavailable",
        message: "partial source fixture",
        statusCode: null,
        retryCount: 0,
        occurredAt: new Date().toISOString(),
      }],
      closedPages: [],
      completed,
      coverageComplete: completed,
    }],
  };
}

describe("incremental crawl fast paths", () => {
  it("emits an unchanged decision only when a content hash or HTTP validator matches", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-FAST-1" });
    database.persistRun(database.startRun(options), crawl(source, job, {
      etag: "etag-1",
      lastModified: "Wed, 01 Jan 2027 00:00:00 GMT",
      externalJobId: "REQ-FAST-1",
      canonicalUrl: job.postingUrl,
    }), 2);

    const same = database.classifyListing(source, {
      postingUrl: `${job.postingUrl}?utm_source=feed`,
      externalJobId: "REQ-FAST-1",
      etag: "etag-1",
    });
    const changed = database.classifyListing(source, {
      postingUrl: job.postingUrl,
      externalJobId: "REQ-FAST-1",
      etag: "etag-2",
    });
    const identityOnly = database.classifyListing(source, {
      postingUrl: job.postingUrl,
      externalJobId: "REQ-FAST-1",
    });

    expect(same.disposition).toBe("unchanged");
    expect(same.validatorsMatch).toBe(true);
    expect(changed.disposition).toBe("possibly_changed");
    expect(changed.validatorsMatch).toBe(false);
    expect(identityOnly.disposition).toBe("possibly_changed");
    expect(identityOnly.validatorsMatch).toBe(false);
    database.close();
  });

  it("records a lightweight unchanged sighting without replacing detail content", () => {
    const { database, options, source } = setup();
    const original = makeInternship({ jobId: "REQ-FAST-2", description: "Original detail body." });
    database.persistRun(database.startRun(options), crawl(source, original, { etag: "etag-2" }), 2);
    const runId = database.startRun(options);
    database.recordLightweightSightings(runId, [{
      sourceUrl: source,
      postingUrl: `${original.postingUrl}?utm_campaign=tracker`,
      externalJobId: "REQ-FAST-2",
      etag: "etag-2",
      state: "unchanged",
      observedOpen: true,
      seenAt: "2027-02-01T00:00:00.000Z",
      checkedAt: "2027-02-01T00:00:00.000Z",
    }]);
    const result = database.persistRun(runId, emptyCrawl(source, false), 2);

    expect(result.counts.UNCHANGED).toBe(1);
    expect(result.internships[0]?.description).toBe("Original detail body.");
    expect(database.getCrawlMetrics(runId)).toMatchObject({ unchangedSkips: 1, cacheHits: 1 });
    database.close();
  });

  it("routes failed detail sightings to retryable state instead of skipping forever", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-FAST-3" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);
    const runId = database.startRun(options);
    database.recordLightweightSightings(runId, [{
      sourceUrl: source,
      postingUrl: job.postingUrl,
      externalJobId: "REQ-FAST-3",
      state: "failed",
      observedOpen: true,
    }]);

    const decision = database.classifyListing(source, {
      postingUrl: job.postingUrl,
      externalJobId: "REQ-FAST-3",
      contentHash: analyzed(job).contentHash,
    });
    expect(decision.disposition).toBe("retryable");
    expect(decision.record?.failureState).toBe("retryable");
    expect(decision.record?.failureCount).toBe(1);
    database.markRunFailed(runId, "fixture cleanup");
    database.close();
  });

  it("does not reopen a closed listing from a matching stale validator", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-FAST-4" });
    database.persistRun(database.startRun(options), crawl(source, job, { etag: "etag-4" }), 2);
    const closure = emptyCrawl(source, true);
    closure.closedPages = [{ url: job.postingUrl, reason: "HTTP 404", statusCode: 404 }];
    database.persistRun(database.startRun(options), closure, 2);

    const decision = database.classifyListing(source, {
      postingUrl: job.postingUrl,
      externalJobId: "REQ-FAST-4",
      etag: "etag-4",
    });
    expect(decision.disposition).toBe("possibly_changed");
    expect(decision.validatorsMatch).toBe(true);
    expect(decision.record?.availabilityStatus).toBe("closed");
    database.close();
  });

  it("only counts misses from coverage-complete sources and closes after the configured threshold", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-FAST-5" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);

    database.persistRun(database.startRun(options), emptyCrawl(source, false), 2);
    expect(database.getCrawlState(source)[0]?.missCount).toBe(0);
    expect(database.getCrawlState(source)[0]?.availabilityStatus).toBe("open");

    database.persistRun(database.startRun(options), emptyCrawl(source, true), 2);
    expect(database.getCrawlState(source)[0]?.missCount).toBe(1);
    expect(database.getCrawlState(source)[0]?.availabilityStatus).toBe("open");

    database.persistRun(database.startRun(options), emptyCrawl(source, true), 2);
    expect(database.getCrawlState(source)[0]?.availabilityStatus).toBe("closed");
    database.close();
  });
});

