import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

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
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-incremental-state-"));
  temporaryDirectories.push(directory);
  const source = "https://example.com/careers";
  const settings = resolveSettings({ databasePath: join(directory, "crawl.db"), outputDirectory: join(directory, "output") });
  const options: ScoutRunOptions = { sources: [source], settings, filters: { categories: [], newOnly: false, minScore: 60 } };
  return { database: new InternshipDatabase(settings.databasePath), options, source };
}

function crawl(source: string, job: ReturnType<typeof makeInternship>): CrawlResult {
  const analyzedJob = analyzed(job);
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
    sourceResults: [{ sourceUrl: source, pagesVisited: 1, potentialPostingsInspected: 1, jobs: [analyzedJob], failures: [], closedPages: [], completed: true, coverageComplete: true }],
  };
}

describe("incremental crawl state", () => {
  it("returns indexed state and classifies validator matches as unchanged", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-100" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);

    const state = database.getCrawlStateBySource([source]).get(source) ?? [];
    expect(state).toHaveLength(1);
    expect(state[0]?.externalJobId).toBe("REQ-100");
    const decision = database.classifyListing(source, {
      canonicalUrl: job.postingUrl,
      externalJobId: "REQ-100",
      contentHash: analyzed(job).contentHash,
    });
    expect(decision.disposition).toBe("unchanged");
    expect(decision.validatorsMatch).toBe(true);
    database.close();
  });

  it("persists lightweight sightings without reopening closed content", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-200" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);
    const run = database.startRun(options);
    database.recordLightweightSightings(run, [{ sourceUrl: source, postingUrl: job.postingUrl, externalJobId: "REQ-200", state: "unchanged", observedOpen: true }]);
    const result = database.persistRun(run, { ...crawl(source, job), jobs: [], sourceResults: [] }, 2);
    expect(result.counts.UNCHANGED).toBe(1);
    expect(result.internships[0]?.availabilityStatus).toBe("open");
    database.close();
  });

  it("retains source strategy and metric state", () => {
    const { database, source } = setup();
    const strategy = database.recordSourceStrategy(source, { adapter: "json", requiresJs: false, success: true, latencyMs: 40, status: "success" });
    expect(strategy.adapter).toBe("json");
    expect(strategy.averageLatencyMs).toBe(40);
    const run = database.startRun({ ...({ sources: [source], settings: resolveSettings({ databasePath: database.path, outputDirectory: join(tmpdir(), "output") }), filters: { categories: [], newOnly: false, minScore: 60 } }) });
    database.recordCrawlMetrics(run, { cacheHits: 2, unchangedSkips: 2, detailPagesFetched: 1 });
    expect(database.getCrawlMetrics(run)).toMatchObject({ cacheHits: 2, unchangedSkips: 2, detailPagesFetched: 1 });
    database.markRunFailed(run, "test cleanup");
    database.close();
  });

  it("keeps progress counters monotonic and reconciles metric deltas once", () => {
    const { database, options } = setup();
    const run = database.startRun(options);
    database.updateRunProgress(run, {
      sourcesSettled: 1,
      sourcesCompleted: 1,
      pagesVisited: 3,
      potentialPostingsInspected: 2,
      internshipsDiscovered: 1,
      cacheHits: 1,
      unchangedSkips: 1,
      newListings: 1,
      changedListings: 1,
      detailPagesFetched: 1,
      duplicateListingsSkipped: 1,
      irrelevantListingsSkipped: 1,
    });
    // Incremental source persistence can expose a stale aggregate while a
    // newer progress snapshot is already ahead. That callback must not
    // regress the live counters.
    const sourceResult = crawl(options.sources[0]!, makeInternship({ jobId: "REQ-PROGRESS-SOURCE" })).sourceResults[0]!;
    database.persistSourceResult(run, sourceResult);
    // A late source callback can carry a partial/older snapshot. It must not
    // erase a larger live value before the final metrics ledger is committed.
    database.updateRunProgress(run, {
      sourcesSettled: 0,
      sourcesCompleted: 0,
      pagesVisited: 0,
      potentialPostingsInspected: 0,
      internshipsDiscovered: 0,
      cacheHits: 0,
      unchangedSkips: 0,
      newListings: 0,
      changedListings: 0,
      detailPagesFetched: 0,
      duplicateListingsSkipped: 0,
      irrelevantListingsSkipped: 0,
    });
    database.recordCrawlMetrics(run, { cacheHits: 2, unchangedSkips: 2, detailPagesFetched: 2 });
    database.recordCrawlMetrics(run, { cacheHits: 3, unchangedSkips: 1, detailPagesFetched: 1 });

    const raw = new DatabaseSync(options.settings.databasePath);
    const row = raw.prepare("SELECT * FROM crawl_runs WHERE id = @runId").get({ runId: run }) as Record<string, number>;
    raw.close();
    expect(row.sources_settled).toBe(1);
    expect(row.pages_visited).toBe(3);
    expect(row.cache_hits).toBe(5);
    expect(row.unchanged_skips).toBe(3);
    expect(row.detail_pages_fetched).toBe(3);
    expect(database.getCrawlMetrics(run)).toMatchObject({ cacheHits: 5, unchangedSkips: 3, detailPagesFetched: 3 });
    database.markRunFailed(run, "fixture cleanup");
    database.close();
  });

  it("does not double-count duplicate same-run sightings", () => {
    const { database, options, source } = setup();
    const job = makeInternship({ jobId: "REQ-DUPLICATE-SIGHTING" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);
    const run = database.startRun(options);
    const sighting = {
      sourceUrl: source,
      postingUrl: `${job.postingUrl}?utm_source=duplicate-link`,
      externalJobId: "REQ-DUPLICATE-SIGHTING",
      contentHash: analyzed(job).contentHash,
      state: "unchanged" as const,
      observedOpen: true,
    };
    database.recordLightweightSightings(run, [sighting, { ...sighting, provenance: { duplicate: true } }]);

    expect(database.getCrawlMetrics(run)).toMatchObject({ unchangedSkips: 1, cacheHits: 1 });
    const raw = new DatabaseSync(options.settings.databasePath);
    const rows = raw.prepare("SELECT COUNT(*) AS count FROM listing_sightings WHERE run_id = @runId").get({ runId: run }) as { count: number };
    raw.close();
    expect(rows.count).toBe(1);
    database.markRunFailed(run, "fixture cleanup");
    database.close();
  });

  it("does not use a shared provider label as a listing identity", () => {
    const { database, options, source } = setup();
    const first = makeInternship({
      id: "provider-label-first",
      jobId: "REQ-PROVIDER-1",
      postingUrl: "https://jobs.example.test/postings/REQ-PROVIDER-1",
      applicationUrl: "https://jobs.example.test/postings/REQ-PROVIDER-1/apply",
    });
    const second = makeInternship({
      id: "provider-label-second",
      jobId: "REQ-PROVIDER-2",
      postingUrl: "https://jobs.example.test/postings/REQ-PROVIDER-2",
      applicationUrl: "https://jobs.example.test/postings/REQ-PROVIDER-2/apply",
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    database.persistRun(database.startRun(options), crawl(source, first), 2);
    database.persistRun(database.startRun(options), crawl(source, second), 2);

    // Simulate a legacy/static adapter that persisted the same broad provider
    // label for every posting. The label is intentionally not a unique key.
    database.close();
    const raw = new DatabaseSync(options.settings.databasePath);
    raw.prepare("UPDATE internships SET provider_identity = CASE id WHEN 'provider-label-first' THEN 'static' ELSE 'other-static' END, external_job_id = CASE id WHEN 'provider-label-second' THEN 'REQ-PROVIDER-1' ELSE external_job_id END WHERE id IN ('provider-label-first', 'provider-label-second')").run();
    raw.close();
    const reopened = new InternshipDatabase(options.settings.databasePath);

    const unknown = reopened.classifyListing(source, {
      postingUrl: "https://jobs.example.test/postings/unknown",
      providerIdentity: "static",
    });
    expect(unknown.disposition).toBe("new");
    expect(unknown.record).toBeNull();

    const ambiguous = reopened.classifyListing(source, {
      postingUrl: "https://jobs.example.test/postings/unknown",
      externalJobId: "REQ-PROVIDER-1",
    });
    expect(ambiguous.disposition).toBe("new");
    expect(ambiguous.record).toBeNull();

    const exact = reopened.classifyListing(source, {
      postingUrl: first.postingUrl,
      externalJobId: "REQ-PROVIDER-1",
    });
    expect(exact.record?.internshipId).toBe("provider-label-first");

    // A specific external requisition remains sufficient to recover the right
    // indexed record even when the adapter's provider label is broad.
    const specific = reopened.classifyListing(source, {
      postingUrl: "https://jobs.example.test/postings/unknown",
      externalJobId: "REQ-PROVIDER-1",
      providerIdentity: "static",
    });
    expect(specific.record?.internshipId).toBe("provider-label-first");
    reopened.close();
  });

  it("migrates legacy other categories before the next duplicate upsert", () => {
    const setupResult = setup();
    const { options, source } = setupResult;
    let { database } = setupResult;
    const job = makeInternship({ id: "legacy-category", jobId: "REQ-LEGACY-CATEGORY" });
    database.persistRun(database.startRun(options), crawl(source, job), 2);
    database.close();

    const raw = new DatabaseSync(options.settings.databasePath);
    const row = raw.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: job.id }) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.categories = ["swe", "other"];
    raw.prepare("UPDATE internships SET payload_json = @payload WHERE id = @id").run({ id: job.id, payload: JSON.stringify(payload) });
    raw.close();

    database = new InternshipDatabase(options.settings.databasePath);
    const migrated = new DatabaseSync(options.settings.databasePath);
    const migratedRow = migrated.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: job.id }) as { payload_json: string };
    migrated.close();
    expect((JSON.parse(migratedRow.payload_json) as { categories: string[] }).categories).toEqual(["swe", "other-code"]);

    expect(() => database.persistRun(database.startRun(options), crawl(source, job), 2)).not.toThrow();
    database.close();
  });
});
