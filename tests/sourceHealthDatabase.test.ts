import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { INTERN_LIST_SOURCE_URL } from "../src/config/internListSource.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions, SourceCrawlResult } from "../src/domain/types.js";
import { RETIRED_JOBRIGHT_LIST_URL } from "../src/config/retiredSources.js";
import { readOperationsSnapshot } from "../src/observability/operations.js";
import { analyzed, makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(sources: string[]): { database: InternshipDatabase; options: ScoutRunOptions } {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-source-health-"));
  temporaryDirectories.push(directory);
  const settings = resolveSettings({ databasePath: join(directory, "crawl.db"), outputDirectory: join(directory, "output") });
  return {
    database: new InternshipDatabase(settings.databasePath),
    options: { sources, settings, filters: { categories: [], newOnly: false, minScore: 60 } },
  };
}

function sourceResult(sourceUrl: string, jobs: ReturnType<typeof analyzed>[], overrides: Partial<SourceCrawlResult> = {}): SourceCrawlResult {
  return {
    sourceUrl,
    pagesVisited: jobs.length > 0 ? 1 : 0,
    potentialPostingsInspected: jobs.length,
    jobs,
    failures: [],
    closedPages: [],
    completed: true,
    coverageComplete: true,
    trustedInventory: true,
    inventoryStatus: "trusted",
    status: "success",
    ...overrides,
  };
}

function crawlResult(sourceResults: SourceCrawlResult[], jobs = sourceResults.flatMap(({ jobs: sourceJobs }) => sourceJobs)): CrawlResult {
  return {
    sourcesRequested: sourceResults.length,
    sourcesCompleted: sourceResults.filter(({ completed }) => completed).length,
    sourcesSuccessful: sourceResults.filter(({ status }) => status === "success").length,
    sourcesPartiallyCompleted: sourceResults.filter(({ status }) => status === "partial").length,
    sourcesFailed: sourceResults.filter(({ completed }) => !completed).length,
    pagesVisited: sourceResults.reduce((sum, source) => sum + source.pagesVisited, 0),
    potentialPostingsInspected: sourceResults.reduce((sum, source) => sum + source.potentialPostingsInspected, 0),
    jobs,
    failures: sourceResults.flatMap(({ failures }) => failures),
    closedPages: sourceResults.flatMap(({ closedPages }) => closedPages),
    completedSourceUrls: sourceResults.filter(({ coverageComplete }) => coverageComplete).map(({ sourceUrl }) => sourceUrl),
    sourceResults,
  };
}

function role(index: number, sourceUrl: string, sources = [sourceUrl]): ReturnType<typeof analyzed> {
  const internship = makeInternship({
    id: `health-role-${index}`,
    jobId: `HEALTH-${index}`,
    company: `Health Labs ${index}`,
    title: `Software Engineering Intern ${index}`,
    applicationUrl: `https://boards.greenhouse.io/health/jobs/${index}/apply`,
    postingUrl: `https://boards.greenhouse.io/health/jobs/${index}`,
    sourceUrl,
    sources,
  });
  return analyzed(internship);
}

function sourceSummary(database: InternshipDatabase, sourceUrl: string) {
  const snapshot = readOperationsSnapshot(database.path, { configuredSourceUrls: [sourceUrl] });
  return snapshot.sources.find(({ url }) => url === sourceUrl)!;
}

describe("durable source health and completeness", () => {
  it("summarizes settled source outcomes and transport counters in the operations view", () => {
    const source = "https://health.example/jobs";
    const { database, options } = setup([source]);
    const healthy = sourceResult(source, [role(1, source)], {
      inventoryCount: 1,
      trustedInventory: true,
      inventoryStatus: "trusted",
      metrics: { responseLatencyMs: 30, browserFallbacks: 1, browserFallbackSuccesses: 1 },
    });
    const failure = sourceResult(source, [], {
      completed: false,
      coverageComplete: false,
      status: "source_unavailable",
      failures: [{ sourceUrl: source, url: source, errorType: "navigation_error", message: "timeout", statusCode: null, retryCount: 1, occurredAt: new Date().toISOString() }],
    });
    database.persistRun(database.startRun(options), crawlResult([failure]), 2);
    const circuitSkip = sourceResult(source, [], {
      completed: false,
      coverageComplete: false,
      healthExcluded: true,
      status: "source_unavailable",
      failures: [{ sourceUrl: source, url: source, errorType: "circuit_open", message: "cooldown", statusCode: null, retryCount: 0, occurredAt: new Date().toISOString() }],
    });
    database.persistRun(database.startRun(options), crawlResult([circuitSkip]), 2);
    database.persistRun(database.startRun(options), crawlResult([healthy]), 2);

    const health = sourceSummary(database, source);
    expect(health.attempts).toBe(3);
    expect(health.successes).toBe(1);
    expect(health.failures).toBe(2);
    expect(health.browserFallbacks).toBe(1);
    expect(health.latest?.responseLatencyMs).toBe(30);
    database.close();
  });

  it("retains browser fallback totals in the bounded operations source history", () => {
    const source = "https://browser-health.example/jobs";
    const { database, options } = setup([source]);
    const baseline = sourceResult(source, [role(1, source)], {
      inventoryCount: 1,
      trustedInventory: true,
      inventoryStatus: "trusted",
      metrics: { browserFallbacks: 1, browserFallbackSuccesses: 1 },
    });
    database.persistRun(database.startRun(options), crawlResult([baseline]), 2);
    for (let index = 0; index < 3; index += 1) {
      database.persistRun(database.startRun(options), crawlResult([sourceResult(source, [], {
        completed: false,
        coverageComplete: false,
        status: "source_unavailable",
        metrics: { browserFallbacks: 1, browserFallbackSuccesses: 0 },
      })]), 2);
    }

    const health = sourceSummary(database, source);
    expect(health.browserFallbacks).toBe(4);
    expect(health.browserFallbackSuccesses).toBe(1);
    expect(health.attempts).toBe(4);
    database.close();
  });

  it("persists explicit inventory trust states and accepts a later recovered inventory", () => {
    const source = "https://collapse.example/jobs";
    const { database, options } = setup([source]);
    const baseline = Array.from({ length: 20 }, (_, index) => role(index, source));
    database.persistRun(database.startRun(options), crawlResult([sourceResult(source, baseline, {
      inventoryCount: 20,
      trustedInventory: true,
      inventoryStatus: "trusted",
    })]), 2);
    const collapsed = sourceResult(source, [baseline[0]!], {
      inventoryCount: 1,
      trustedInventory: false,
      suspiciousInventory: true,
      inventoryStatus: "quarantined",
    });
    database.persistRun(database.startRun(options), crawlResult([collapsed]), 2);

    const raw = new DatabaseSync(options.settings.databasePath);
    const quarantined = raw.prepare(`
      SELECT trusted_inventory, suspicious_inventory, inventory_status
      FROM source_run_results ORDER BY run_id DESC LIMIT 1
    `).get() as { trusted_inventory: number; suspicious_inventory: number; inventory_status: string };
    const lifecycle = raw.prepare(`
      SELECT COUNT(*) AS role_count,
        SUM(miss_count) AS total_misses,
        SUM(CASE WHEN availability_status = 'closed' THEN 1 ELSE 0 END) AS closed_count
      FROM internships
    `).get() as { role_count: number; total_misses: number; closed_count: number };
    raw.close();
    expect(quarantined).toEqual({ trusted_inventory: 0, suspicious_inventory: 1, inventory_status: "quarantined" });
    expect(lifecycle).toEqual({ role_count: 20, total_misses: 0, closed_count: 0 });

    database.persistRun(database.startRun(options), crawlResult([sourceResult(source, baseline, {
      inventoryCount: 20,
      trustedInventory: true,
      inventoryStatus: "trusted",
    })]), 2);
    const health = sourceSummary(database, source);
    expect(health.latest).toMatchObject({ trustedInventory: true, suspiciousInventory: false, inventoryCount: 20 });
    expect(health.successes).toBe(2);
    expect(health.failures).toBe(1);
    database.close();
  });

  it("requires trusted results from every configured source before the operations snapshot reports full coverage", () => {
    const first = "https://source-a.example/jobs";
    const second = "https://source-b.example/jobs";
    const { database } = setup([first, second]);
    const settings = resolveSettings({ databasePath: database.path, outputDirectory: join(tmpdir(), "source-health-output") });
    const oneSourceOptions: ScoutRunOptions = {
      sources: [first], settings, filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const trusted = (sourceUrl: string) => sourceResult(sourceUrl, [], {
      inventoryCount: 0,
      trustedInventory: true,
      inventoryStatus: "trusted",
    });
    database.persistRun(database.startRun(oneSourceOptions), crawlResult([trusted(first)]), 2);
    const partial = readOperationsSnapshot(database.path, {
      now: new Date(Date.now() + 1_000),
      configuredSourceUrls: [first, second],
    });
    expect(partial.freshness).toMatchObject({ expectedSources: 2, trustedSources: 1, fullCoverage: false });

    const bothOptions = { ...oneSourceOptions, sources: [first, second] };
    database.persistRun(database.startRun(bothOptions), crawlResult([trusted(first), trusted(second)]), 2);
    const complete = readOperationsSnapshot(database.path, {
      now: new Date(Date.now() + 1_000),
      configuredSourceUrls: [first, second],
    });
    expect(complete.freshness).toMatchObject({ expectedSources: 2, trustedSources: 2, fullCoverage: true });
    database.close();
  });

  it("does not age a shared role until every linked source has full coverage", () => {
    const first = "https://source-a.example/jobs";
    const second = "https://source-b.example/jobs";
    const { database, options } = setup([first, second]);
    database.configureSource(first);
    database.configureSource(second);
    const trustedResult = (sourceUrl: string, jobs: ReturnType<typeof analyzed>[]) => sourceResult(sourceUrl, jobs, {
      inventoryCount: jobs.length,
      trustedInventory: true,
      inventoryStatus: "trusted",
    });
    const singleSourceOptions = (sourceUrl: string): ScoutRunOptions => ({
      ...options,
      sources: [sourceUrl],
    });

    const shared = role(900, first, [first, second]);
    database.persistRun(
      database.startRun(singleSourceOptions(first)),
      crawlResult([trustedResult(first, [shared])]),
      2,
    );
    database.persistRun(
      database.startRun(singleSourceOptions(second)),
      crawlResult([trustedResult(second, [analyzed({ ...shared.internship, sourceUrl: second })])]),
      2,
    );

    database.persistRun(
      database.startRun(singleSourceOptions(first)),
      crawlResult([sourceResult(first, [], {
        coverageComplete: false,
        trustedInventory: false,
        inventoryStatus: "incomplete",
      })]),
      2,
    );
    let raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 0, availability_status: "open" });
    raw.close();

    database.persistRun(
      database.startRun(singleSourceOptions(first)),
      crawlResult([trustedResult(first, [])]),
      2,
    );
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 0, availability_status: "open" });
    raw.close();

    const missingTrustSecond = sourceResult(second, [], {
      inventoryCount: 0,
    });
    // Older crawl producers have no trust flag; complete coverage keeps their
    // lifecycle behavior compatible until those producers are upgraded.
    delete missingTrustSecond.trustedInventory;
    database.persistRun(
      database.startRun({ ...options, sources: [first, second] }),
      crawlResult([trustedResult(first, []), missingTrustSecond]),
      2,
    );
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 1, availability_status: "open" });
    raw.close();

    const untrustedSecond = sourceResult(second, [], {
      inventoryCount: 0,
      trustedInventory: false,
      inventoryStatus: "unknown",
    });
    database.persistRun(
      database.startRun({ ...options, sources: [first, second] }),
      crawlResult([trustedResult(first, []), untrustedSecond]),
      2,
    );
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 1, availability_status: "open" });
    raw.close();

    const bothOptions: ScoutRunOptions = { ...options, sources: [first, second] };
    const emptyInventories = crawlResult([trustedResult(first, []), trustedResult(second, [])]);
    database.persistRun(database.startRun(bothOptions), emptyInventories, 2);
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 2, availability_status: "closed" });
    raw.close();

    database.persistRun(database.startRun(bothOptions), emptyInventories, 2);
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string }))
      .toEqual({ miss_count: 2, availability_status: "closed" });
    raw.close();
    database.close();
  });

  it("normalizes catalog aliases and ignores retired historical source links", () => {
    const { database, options } = setup([INTERN_LIST_SOURCE_URL]);
    database.configureSource(INTERN_LIST_SOURCE_URL);
    const historicalAlias = "https://jobright.ai/minisites-jobs/intern/us/software_engineering";
    const shared = role(901, INTERN_LIST_SOURCE_URL, [historicalAlias, RETIRED_JOBRIGHT_LIST_URL]);
    const sourceOptions = { ...options, sources: [INTERN_LIST_SOURCE_URL] };
    database.persistRun(
      database.startRun(sourceOptions),
      crawlResult([sourceResult(INTERN_LIST_SOURCE_URL, [shared])]),
      2,
    );

    database.persistRun(
      database.startRun(sourceOptions),
      crawlResult([sourceResult(INTERN_LIST_SOURCE_URL, [])]),
      2,
    );
    const raw = new DatabaseSync(database.path);
    const row = raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string };
    raw.close();
    expect(row).toEqual({ miss_count: 1, availability_status: "open" });
    database.close();
  });

  it("does not re-persist checkpoint failures or source metadata during final persistence", () => {
    const source = "https://replay.example/jobs";
    const { database, options } = setup([source]);
    const result = sourceResult(source, [role(1, source)], {
      completed: false,
      coverageComplete: false,
      status: "partial",
      failures: [{ sourceUrl: source, url: `${source}/detail`, errorType: "navigation_error", message: "temporary", statusCode: null, retryCount: 1, occurredAt: new Date().toISOString() }],
    });
    const runId = database.startRun(options);
    database.persistSourceResult(runId, result);
    database.persistRun(runId, crawlResult([result]), 2);
    const raw = new DatabaseSync(options.settings.databasePath);
    const failedPages = raw.prepare("SELECT COUNT(*) AS count FROM failed_pages WHERE run_id = @runId").get({ runId }) as { count: number };
    const sourceRows = raw.prepare("SELECT COUNT(*) AS count FROM source_run_results WHERE run_id = @runId").get({ runId }) as { count: number };
    raw.close();
    expect(failedPages.count).toBe(1);
    expect(sourceRows.count).toBe(1);
    expect(sourceSummary(database, source).attempts).toBe(1);
    database.close();
  });
});
