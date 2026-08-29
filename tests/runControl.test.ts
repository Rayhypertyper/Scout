import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { setRunMaxDurationForTests } from "../src/config/runLock.js";
import { InternshipDatabase } from "../src/database/db.js";
import { finalizeCancellationRequests, failStaleRunningRuns, requestRunTermination } from "../src/database/runControl.js";
import type { ScoutRunOptions } from "../src/domain/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function setupDatabase(): { database: InternshipDatabase; databasePath: string; options: ScoutRunOptions } {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-run-control-"));
  temporaryDirectories.push(directory);
  const databasePath = join(directory, "crawl.db");
  const settings = resolveSettings({
    databasePath,
    outputDirectory: join(directory, "output"),
  });
  const options: ScoutRunOptions = {
    sources: ["https://example.com/careers"],
    settings,
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
  return { database: new InternshipDatabase(databasePath), databasePath, options };
}

describe("run cancellation control", () => {
  it("keeps recurring launchd crawling independent of dashboard benchmark switches", () => {
    const plist = readFileSync(join(process.cwd(), "scripts", "com.internshipmatic.scout.plist"), "utf8");
    expect(plist).toContain("/dist/src/index.js");
    expect(plist.match(/<dict><key>Hour<\/key>/g) ?? []).toHaveLength(12);
    expect(plist).not.toContain("DASHBOARD_SKIP_STARTUP_SCAN");
    expect(plist).not.toContain("DASHBOARD_SKIP_FAST_PREWARM");
  });

  it("finalizes a running run and immediately allows the next run", () => {
    const { database, databasePath, options } = setupDatabase();
    const firstRun = database.startRun(options);

    expect(requestRunTermination(databasePath)).toEqual({
      runId: firstRun,
      requested: true,
      finalized: true,
    });
    expect(database.isRunCancellationRequested(firstRun)).toBe(true);

    const rowDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const row = rowDatabase.prepare(`
      SELECT status, finished_at, heartbeat_at, cancel_requested_at, error_message
      FROM crawl_runs WHERE id = @runId
    `).get({ runId: firstRun }) as { status: string; finished_at: string | null; heartbeat_at: string | null; cancel_requested_at: string | null; error_message: string };
    rowDatabase.close();
    expect(row.status).toBe("FAILED");
    expect(row.finished_at).not.toBeNull();
    expect(row.heartbeat_at).toBeNull();
    expect(row.cancel_requested_at).not.toBeNull();
    expect(row.error_message).toBe("Terminated by user.");

    const secondRun = database.startRun(options);
    expect(secondRun).toBeGreaterThan(firstRun);
    database.markRunFailed(secondRun, "test cleanup");
    database.close();
  });

  it("repairs a cancellation request left by an exited worker", () => {
    const { database, databasePath, options } = setupDatabase();
    const runId = database.startRun(options);
    const rawDatabase = new DatabaseSync(databasePath);
    rawDatabase.prepare("UPDATE crawl_runs SET cancel_requested_at = @requestedAt WHERE id = @runId").run({
      requestedAt: new Date().toISOString(),
      runId,
    });
    rawDatabase.close();

    expect(finalizeCancellationRequests(databasePath)).toEqual([runId]);
    expect(finalizeCancellationRequests(databasePath)).toEqual([]);
    const nextRun = database.startRun(options);
    expect(nextRun).toBeGreaterThan(runId);
    database.markRunFailed(nextRun, "test cleanup");
    database.close();
  });

  it("fails running rows whose heartbeat lease has expired", () => {
    const { database, databasePath, options } = setupDatabase();
    const runId = database.startRun(options);
    const staleAt = new Date(Date.now() - 21 * 60 * 1_000).toISOString();
    const rawDatabase = new DatabaseSync(databasePath);
    rawDatabase.prepare("UPDATE crawl_runs SET started_at = @staleAt, heartbeat_at = @staleAt WHERE id = @runId").run({
      staleAt,
      runId,
    });
    rawDatabase.close();

    expect(failStaleRunningRuns(databasePath)).toEqual([runId]);
    expect(failStaleRunningRuns(databasePath)).toEqual([]);
    const rowDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const row = rowDatabase.prepare("SELECT status, error_message FROM crawl_runs WHERE id = @runId").get({ runId }) as { status: string; error_message: string };
    rowDatabase.close();
    expect(row.status).toBe("FAILED");
    expect(row.error_message).toBe("Marked stale after exceeding the maximum crawl duration.");
    const nextRun = database.startRun(options);
    expect(nextRun).toBeGreaterThan(runId);
    database.markRunFailed(nextRun, "test cleanup");
    database.close();
  });

  it("does not fail a run with a heartbeat inside the lease window", () => {
    const { database, databasePath, options } = setupDatabase();
    const runId = database.startRun(options);
    expect(failStaleRunningRuns(databasePath)).toEqual([]);
    const rowDatabase = new DatabaseSync(databasePath, { readOnly: true });
    const row = rowDatabase.prepare("SELECT status FROM crawl_runs WHERE id = @runId").get({ runId }) as { status: string };
    rowDatabase.close();
    expect(row.status).toBe("RUNNING");
    database.markRunFailed(runId, "test cleanup");
    database.close();
  });

  it("fails a heartbeat-active run after the absolute wall-clock deadline", () => {
    setRunMaxDurationForTests(5 * 60 * 1_000);
    try {
      const { database, databasePath, options } = setupDatabase();
      const runId = database.startRun(options);
      const startedAt = new Date(Date.now() - 6 * 60 * 1_000).toISOString();
      const rawDatabase = new DatabaseSync(databasePath);
      rawDatabase.prepare("UPDATE crawl_runs SET started_at = @startedAt, heartbeat_at = @heartbeatAt WHERE id = @runId").run({
        startedAt,
        heartbeatAt: new Date().toISOString(),
        runId,
      });
      rawDatabase.close();

      expect(failStaleRunningRuns(databasePath)).toEqual([runId]);
      const rowDatabase = new DatabaseSync(databasePath, { readOnly: true });
      const row = rowDatabase.prepare("SELECT status, cancel_requested_at, error_message FROM crawl_runs WHERE id = @runId").get({ runId }) as { status: string; cancel_requested_at: string | null; error_message: string };
      rowDatabase.close();
      expect(row.status).toBe("FAILED");
      expect(row.cancel_requested_at).not.toBeNull();
      expect(row.error_message).toBe("Crawl exceeded the maximum wall-clock duration.");
      database.close();
    } finally {
      setRunMaxDurationForTests(null);
    }
  });
});
