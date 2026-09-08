import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions, SourceCrawlResult } from "../src/domain/types.js";
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

describe("durable source health and completeness", () => {
  it("counts one terminal outcome and excludes circuit skips", () => {
    const source = "https://health.example/jobs";
    const { database, options } = setup([source]);
    const healthy = sourceResult(source, [role(1, source)], { metrics: { responseLatencyMs: 30, browserFallbacks: 1, browserFallbackSuccesses: 1 } });
    database.persistRun(database.startRun(options), crawlResult([healthy]), 2);
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
      status: "source_unavailable",
      failures: [{ sourceUrl: source, url: source, errorType: "circuit_open", message: "cooldown", statusCode: null, retryCount: 0, occurredAt: new Date().toISOString() }],
    });
    database.persistRun(database.startRun(options), crawlResult([circuitSkip]), 2);

    const health = database.getSourceHealth(source);
    expect(health.attempts).toBe(2);
    expect(health.successes).toBe(1);
    expect(health.failures).toBe(1);
    expect(health.browserFallbacks).toBe(1);
    expect(health.latencyMs).toBe(30);
    database.close();
  });

  it("retains the browser fallback failure streak after older useful history", () => {
    const source = "https://browser-health.example/jobs";
    const { database, options } = setup([source]);
    const baseline = sourceResult(source, [role(1, source)], {
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

    const health = database.getSourceHealth(source);
    expect(health.consecutiveBrowserFallbackFailures).toBe(3);
    expect(health.browserFallbackSuccesses).toBe(1);
    database.close();
  });

  it("quarantines a 95% inventory collapse and accepts a recovered inventory", () => {
    const source = "https://collapse.example/jobs";
    const { database, options } = setup([source]);
    const baseline = Array.from({ length: 20 }, (_, index) => role(index, source));
    database.persistRun(database.startRun(options), crawlResult([sourceResult(source, baseline)]), 2);
    const collapsed = sourceResult(source, [baseline[0]!]);
    database.persistRun(database.startRun(options), crawlResult([collapsed]), 2);

    const raw = new DatabaseSync(options.settings.databasePath);
    const quarantined = raw.prepare(`
      SELECT trusted_inventory, suspicious_inventory, inventory_status
      FROM source_run_results ORDER BY run_id DESC LIMIT 1
    `).get() as { trusted_inventory: number; suspicious_inventory: number; inventory_status: string };
    const openRoles = raw.prepare("SELECT COUNT(*) AS count FROM internships WHERE availability_status = 'open' AND miss_count = 0").get() as { count: number };
    raw.close();
    expect(quarantined).toEqual({ trusted_inventory: 0, suspicious_inventory: 1, inventory_status: "quarantined" });
    expect(openRoles.count).toBe(20);

    database.persistRun(database.startRun(options), crawlResult([collapsed]), 2);
    database.persistRun(database.startRun(options), crawlResult([sourceResult(source, baseline)]), 2);
    const health = database.getSourceHealth(source);
    expect(health.suspiciousSnapshotCount).toBe(2);
    expect(health.trustedInventoryCount).toBe(20);
    expect(health.lastInventoryStatus).toBe("trusted");
    database.close();
  });

  it("requires trusted coverage from every configured source before misses", () => {
    const first = "https://source-a.example/jobs";
    const second = "https://source-b.example/jobs";
    const { database } = setup([first, second]);
    const firstOptions: ScoutRunOptions = {
      sources: [first],
      settings: resolveSettings({ databasePath: database.path, outputDirectory: join(tmpdir(), "source-health-output") }),
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const shared = role(900, first, [first, second]);
    database.persistRun(database.startRun(firstOptions), crawlResult([sourceResult(first, [shared])]), 2);
    const secondOptions = { ...firstOptions, sources: [second] };
    database.persistRun(database.startRun(secondOptions), crawlResult([sourceResult(second, [analyzed({ ...shared.internship, sourceUrl: second })])]), 2);

    database.persistRun(database.startRun(firstOptions), crawlResult([sourceResult(first, [])]), 2);
    let raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number }).miss_count).toBe(0);
    raw.close();

    const bothOptions = { ...firstOptions, sources: [first, second] };
    const empty = crawlResult([sourceResult(first, []), sourceResult(second, [])]);
    database.persistRun(database.startRun(bothOptions), empty, 2);
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string })).toEqual({ miss_count: 1, availability_status: "open" });
    raw.close();
    database.persistRun(database.startRun(bothOptions), empty, 2);
    raw = new DatabaseSync(database.path);
    expect((raw.prepare("SELECT miss_count, availability_status FROM internships WHERE id = @id").get({ id: shared.internship.id }) as { miss_count: number; availability_status: string })).toEqual({ miss_count: 2, availability_status: "closed" });
    raw.close();
    database.close();
  });

  it("replays a checkpoint and final persist without duplicate failures or health", () => {
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
    database.persistSourceResult(runId, result);
    database.persistRun(runId, crawlResult([result]), 2);
    const replay = database.persistRun(runId, crawlResult([result]), 2);
    const raw = new DatabaseSync(options.settings.databasePath);
    const failedPages = raw.prepare("SELECT COUNT(*) AS count FROM failed_pages WHERE run_id = @runId").get({ runId }) as { count: number };
    const sourceRows = raw.prepare("SELECT COUNT(*) AS count FROM source_run_results WHERE run_id = @runId").get({ runId }) as { count: number };
    raw.close();
    expect(replay.counts).toEqual({ NEW: 1, UPDATED: 0, UNCHANGED: 0, REMOVED_OR_CLOSED: 0 });
    expect(failedPages.count).toBe(1);
    expect(sourceRows.count).toBe(1);
    expect(database.getSourceHealth(source).attempts).toBe(1);
    database.close();
  });
});
