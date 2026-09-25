import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { Internship } from "../src/domain/schemas.js";
import type { GrindJobBoardSnapshot } from "../src/integrations/grindJobBoard.js";
import { GrindJobBoardClient } from "../src/integrations/grindJobBoard.js";
import { analyzed, makeInternship } from "./helpers.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

interface RolesPayload {
  version: string;
  stats: { total: number; open: number; closed: number; new: number; updated: number; unchanged: number };
  pagination: { total: number };
  items: Array<{
    id: string;
    listingType: string;
    listingId: string;
    isNew: boolean;
    lifecycleStatus: string;
  }>;
}

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

function request(url: string): Record<string, unknown> {
  return { method: "GET", url, headers: { host: "localhost" } };
}

function boardSnapshot(jobs: GrindJobBoardSnapshot["jobs"]): GrindJobBoardSnapshot {
  const now = new Date().toISOString();
  return {
    sourceUrl: "https://board.example/jobs",
    status: "ready",
    jobs,
    jobCount: jobs.length,
    freshCount: jobs.length,
    companyCount: jobs.length,
    companiesSynced: jobs.length,
    companiesRefreshed: jobs.length,
    lastAttemptAt: now,
    lastSuccessfulSyncAt: now,
    cacheTtlMinutes: 5,
    attempts: jobs.length,
    retrievalUrl: "https://board.example/api/query",
    failures: [],
  };
}

function crawl(roles: Internship[]) {
  const jobs = roles.map(analyzed);
  const sourceUrl = "https://example.com/careers";
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: jobs.length,
    jobs,
    failures: [],
    closedPages: [],
    completedSourceUrls: [sourceUrl],
    sourceResults: [{
      sourceUrl,
      pagesVisited: 1,
      potentialPostingsInspected: jobs.length,
      jobs,
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

async function createDatabase(directory: string, filename: string, roles: Internship[]): Promise<string> {
  const databasePath = join(directory, filename);
  const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
  const database = new InternshipDatabase(databasePath);
  try {
    const runId = database.startRun({
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    });
    database.persistRun(runId, crawl(roles), 2);
  } finally {
    database.close();
  }
  return databasePath;
}

describe("time-dependent dashboard cache projection", () => {
  let directory = "";
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let setFastDashboardIndexBuildHookForTests: typeof import("../src/dashboard.js").setFastDashboardIndexBuildHookForTests;
  let clearFastDashboardCacheForTests: typeof import("../src/dashboard.js").clearFastDashboardCacheForTests;
  let clearDashboardDataCacheForTests: typeof import("../src/dashboard.js").clearDashboardDataCacheForTests;
  let closeFastRevisionTrackersForTests: typeof import("../src/dashboard.js").closeFastRevisionTrackersForTests;
  let prewarmFastDashboardIndexForTests: typeof import("../src/dashboard.js").prewarmFastDashboardIndexForTests;
  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-time-cache-"));
    process.env.INTERNSHIPMATIC_ROOT = directory;
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.SCOUT_OUTPUT_DIR = join(directory, "output", "live");
    process.env.GRIND_JOB_BOARD_CACHE_PATH = join(directory, "missing-board-cache.json");
    ({
      requestHandler,
      setFastDashboardIndexBuildHookForTests,
      clearFastDashboardCacheForTests,
      clearDashboardDataCacheForTests,
      closeFastRevisionTrackersForTests,
      prewarmFastDashboardIndexForTests,
    } = await import("../src/dashboard.js"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    setFastDashboardIndexBuildHookForTests(null);
    clearFastDashboardCacheForTests();
    vi.useRealTimers();
  });

  afterAll(() => {
    setFastDashboardIndexBuildHookForTests(null);
    clearDashboardDataCacheForTests();
    closeFastRevisionTrackersForTests();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.INTERNSHIPMATIC_ROOT;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.SCOUT_OUTPUT_DIR;
    delete process.env.GRIND_JOB_BOARD_CACHE_PATH;
  });

  async function getRoles(databasePath: string, status = "all"): Promise<RolesPayload> {
    const captured = response();
    await requestHandler(
      request(`/api/roles?tab=main&status=${status}&sort=company&limit=100`) as never,
      captured as never,
      databasePath,
    );
    expect(captured.statusCode).toBe(200);
    return JSON.parse(captured.body.toString("utf8")) as RolesPayload;
  }

  it("expires stored and live-board NEW state on the cached 15-minute projection without rebuilding payloads", async () => {
    const start = Date.parse("2026-09-23T12:14:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const databasePath = await createDatabase(directory, "new-expiry.db", [makeInternship({
      id: "stored-timer-new",
      company: "Stored Timer Labs",
      applicationUrl: "https://boards.greenhouse.io/stored-timer/jobs/801/apply",
      postingUrl: "https://boards.greenhouse.io/stored-timer/jobs/801",
      discoveredAt: new Date(start - (16 * 60 * 60 * 1000) + 60_000).toISOString(),
      postingDate: "2026-09-23",
    })]);
    const mutation = new DatabaseSync(databasePath);
    try {
      mutation.prepare("UPDATE internships SET lifecycle_status = 'UPDATED' WHERE id = 'stored-timer-new'").run();
    } finally {
      mutation.close();
    }

    vi.spyOn(GrindJobBoardClient.prototype, "getCachedSnapshot").mockReturnValue(boardSnapshot([{
      id: "timer-board-job",
      company: "Board Timer Labs",
      title: "Software Engineer Intern",
      location: "Toronto, ON, Canada",
      link: "https://board.example/jobs/timer-board-job",
      firstSeen: new Date(start - (16 * 60 * 60 * 1000) + 60_000).toISOString(),
      jobId: "TIMER-BOARD-1",
    }]));

    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    clearFastDashboardCacheForTests();
    await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
    const before = await getRoles(databasePath, "new");
    expect(before.pagination.total).toBe(2);
    expect(before.stats.new).toBe(2);
    expect(before.items.every((item) => item.isNew)).toBe(true);
    const beforeVersion = before.version;
    builds = 0;

    // Move past the exact 16-hour edge and into a new 15-minute cache bucket.
    vi.setSystemTime(start + (16 * 60 * 60 * 1000) + 2 * 60_000);
    const expired = await getRoles(databasePath, "new");
    const updated = await getRoles(databasePath, "updated");
    const all = await getRoles(databasePath, "all");

    expect(expired.version).not.toBe(beforeVersion);
    expect(expired.pagination.total).toBe(0);
    expect(expired.stats.new).toBe(0);
    expect(updated.pagination.total).toBe(1);
    expect(updated.items.map((item) => item.listingId)).toEqual(["stored-timer-new"]);
    const boardItem = all.items.find((item) => item.listingId === "timer-board-job");
    expect(boardItem).toMatchObject({ isNew: false, lifecycleStatus: "UNCHANGED" });
    expect(all.stats.updated).toBe(1);
    expect(all.stats.unchanged).toBe(1);
    expect(all.version).toBe(expired.version);
    expect(builds).toBe(0);
  });

  it("reprojects posting-age visibility before deduping and keeps the same bucket stable", async () => {
    const start = new Date(2026, 8, 23, 23, 58, 0).valueOf();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(start);
    const databasePath = await createDatabase(directory, "posting-age.db", [
      makeInternship({
        id: "old-open-stored",
        company: "Old Open Labs",
        applicationUrl: "https://boards.greenhouse.io/old-open/jobs/901/apply",
        postingUrl: "https://boards.greenhouse.io/old-open/jobs/901",
        discoveredAt: new Date(start - 3 * 24 * 60 * 60 * 1000).toISOString(),
        postingDate: "2026-07-23",
      }),
      makeInternship({
        id: "closed-old",
        company: "Closed History Labs",
        applicationUrl: "https://boards.greenhouse.io/closed-old/jobs/902/apply",
        postingUrl: "https://boards.greenhouse.io/closed-old/jobs/902",
        discoveredAt: new Date(start - 3 * 24 * 60 * 60 * 1000).toISOString(),
        postingDate: "2026-07-23",
      }),
    ]);
    const mutation = new DatabaseSync(databasePath);
    try {
      mutation.prepare("UPDATE internships SET availability_status = 'closed', lifecycle_status = 'REMOVED_OR_CLOSED' WHERE id = 'closed-old'").run();
    } finally {
      mutation.close();
    }

    vi.spyOn(GrindJobBoardClient.prototype, "getCachedSnapshot").mockReturnValue(boardSnapshot([{
      id: "fresh-board-duplicate",
      company: "Old Open Labs",
      title: "Software Engineer Intern",
      location: "Toronto, ON, Canada",
      link: "https://boards.greenhouse.io/old-open/jobs/901/apply",
      firstSeen: new Date(start - 2 * 60 * 60 * 1000).toISOString(),
      jobId: "901",
    }]));

    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    clearFastDashboardCacheForTests();
    await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
    const before = await getRoles(databasePath);
    expect(before.items.map((item) => item.listingId).toSorted()).toEqual(["closed-old", "old-open-stored"]);
    builds = 0;

    // At local midnight, the inclusive July 23 posting day falls outside the
    // two-calendar-month window. The old stored candidate must not hide its
    // otherwise-fresh live-board duplicate when the aged source is removed.
    vi.setSystemTime(start + 5 * 60_000);
    const after = await getRoles(databasePath);
    expect(after.items.map((item) => item.listingId).toSorted()).toEqual(["closed-old", "fresh-board-duplicate"]);
    expect(after.items.find((item) => item.listingId === "closed-old")).toBeDefined();
    vi.setSystemTime(start + 7 * 60_000);
    const sameBucket = await getRoles(databasePath);
    expect(sameBucket.version).toBe(after.version);
    expect(sameBucket.stats).toEqual(after.stats);
    expect(sameBucket.items).toEqual(after.items);
    expect(builds).toBe(0);

    // A backward clock adjustment should re-show the saved stored candidate;
    // the projected entry list must not have mutated the immutable base pool.
    vi.setSystemTime(start);
    const restored = await getRoles(databasePath);
    expect(restored.items.map((item) => item.listingId).toSorted()).toEqual(["closed-old", "old-open-stored"]);
    expect(builds).toBe(0);
  });
});
