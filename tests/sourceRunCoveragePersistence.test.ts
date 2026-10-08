import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions, SourceCrawlResult } from "../src/domain/types.js";
import { buildOperationsSnapshot } from "../src/observability/operations.js";

const source = "https://earlycareerradar.com/summer-internships?locations=all";
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setup(): { database: InternshipDatabase; options: ScoutRunOptions } {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-source-run-coverage-"));
  directories.push(directory);
  const settings = resolveSettings({ databasePath: join(directory, "crawl.db"), outputDirectory: join(directory, "output") });
  return {
    database: new InternshipDatabase(settings.databasePath),
    options: { sources: [source], settings, filters: { categories: [], newOnly: false, minScore: 60 } },
  };
}

function crawl(result: SourceCrawlResult): CrawlResult {
  return {
    sourcesRequested: 1,
    sourcesCompleted: result.completed ? 1 : 0,
    sourcesSuccessful: result.status === "success" ? 1 : 0,
    sourcesPartiallyCompleted: result.status === "partial" ? 1 : 0,
    sourcesFailed: result.completed ? 0 : 1,
    pagesVisited: result.pagesVisited,
    potentialPostingsInspected: result.potentialPostingsInspected,
    jobs: result.jobs,
    failures: result.failures,
    closedPages: result.closedPages,
    completedSourceUrls: result.coverageComplete ? [result.sourceUrl] : [],
    sourceResults: [result],
  };
}

function radarResult(overrides: Partial<SourceCrawlResult> = {}): SourceCrawlResult {
  return {
    sourceUrl: source,
    pagesVisited: 1,
    potentialPostingsInspected: 5_503,
    inventoryCount: 5_503,
    jobs: [],
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

describe("source run inventory coverage persistence", () => {
  it("persists only feed-proven ECR inventory as trusted and exposes the flags to operations", () => {
    const { database, options } = setup();
    const completedRunId = database.startRun(options);
    database.persistRun(completedRunId, crawl(radarResult()), 2);

    const incompleteRunId = database.startRun(options);
    database.persistRun(incompleteRunId, crawl(radarResult({
      // A successful HTTP root and a known parsed count do not prove that a
      // truncated feed represents the complete source inventory.
      coverageComplete: false,
      trustedInventory: false,
      inventoryStatus: "incomplete",
      status: "success",
    })), 2);

    const reader = new DatabaseSync(options.settings.databasePath, { readOnly: true });
    try {
      const rows = reader.prepare(`
        SELECT run_id, settled, completed, coverage_complete, stale, health_excluded,
          inventory_count, trusted_inventory, suspicious_inventory, inventory_status, settled_at
        FROM source_run_results ORDER BY run_id
      `).all() as Array<Record<string, number | string | null>>;
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({
        run_id: completedRunId,
        settled: 1,
        completed: 1,
        coverage_complete: 1,
        stale: 0,
        health_excluded: 0,
        inventory_count: 5_503,
        trusted_inventory: 1,
        suspicious_inventory: 0,
        inventory_status: "trusted",
      });
      expect(rows[0]?.settled_at).toEqual(expect.any(String));
      expect(rows[1]).toMatchObject({
        run_id: incompleteRunId,
        settled: 1,
        completed: 1,
        coverage_complete: 0,
        stale: 0,
        health_excluded: 0,
        inventory_count: 5_503,
        trusted_inventory: 0,
        suspicious_inventory: 0,
        inventory_status: "incomplete",
      });
      expect(rows[1]?.settled_at).toEqual(expect.any(String));

      const operations = buildOperationsSnapshot(reader, {
        now: new Date(Date.now() + 1_000),
        configuredSourceUrls: [source],
      });
      const summary = operations.sources.find(({ url }) => url === source);
      expect(summary?.latest).toMatchObject({
        runId: incompleteRunId,
        completed: true,
        coverageComplete: false,
        stale: false,
        healthExcluded: false,
        trustedInventory: false,
        inventoryCount: 5_503,
      });
      expect(summary?.successes).toBe(1);
      expect(summary?.lastSuccessAt).toBe(rows[0]?.settled_at);
      expect(summary?.failures).toBe(1);
    } finally {
      reader.close();
      database.close();
    }
  });
});
