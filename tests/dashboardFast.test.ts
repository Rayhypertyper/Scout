import { mkdirSync, mkdtempSync, rmSync, renameSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { Internship } from "../src/domain/schemas.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { GrindJobBoardClient } from "../src/integrations/grindJobBoard.js";
import { analyzed, makeInternship } from "./helpers.js";
import { dashboardLocalDayKey, parseDashboardSortDate } from "../src/dashboardSort.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body);
    },
  };
}

function request(method: string, url: string, headers: Record<string, string> = {}, body?: unknown): Record<string, unknown> {
  return {
    method,
    url,
    headers,
    ...(body === undefined ? {} : {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield JSON.stringify(body);
      },
    }),
  };
}

function crawl(jobs: Internship[], sourceUrl = "https://example.com/careers"): CrawlResult {
  const analyzedJobs = jobs.map(analyzed);
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: jobs.length,
    jobs: analyzedJobs,
    failures: [],
    closedPages: [],
    completedSourceUrls: [sourceUrl],
    sourceResults: [{
      sourceUrl,
      pagesVisited: 1,
      potentialPostingsInspected: jobs.length,
      jobs: analyzedJobs,
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

describe("dashboard fast API", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let setFastSnapshotReadHookForTests: typeof import("../src/dashboard.js").setFastSnapshotReadHookForTests;
  let setFastRunRevisionCaptureHookForTests: typeof import("../src/dashboard.js").setFastRunRevisionCaptureHookForTests;
  let setFastStartupWatcherBaselineGapHookForTests: typeof import("../src/dashboard.js").setFastStartupWatcherBaselineGapHookForTests;
  let setFastStartupWatcherAfterBaselineHookForTests: typeof import("../src/dashboard.js").setFastStartupWatcherAfterBaselineHookForTests;
  let setFastDashboardIndexBuildHookForTests: typeof import("../src/dashboard.js").setFastDashboardIndexBuildHookForTests;
  let closeFastRevisionTrackersForTests: typeof import("../src/dashboard.js").closeFastRevisionTrackersForTests;
  let clearFastDashboardCacheForTests: typeof import("../src/dashboard.js").clearFastDashboardCacheForTests;
  let clearDashboardDataCacheForTests: typeof import("../src/dashboard.js").clearDashboardDataCacheForTests;
  let prewarmFastDashboardIndexForTests: typeof import("../src/dashboard.js").prewarmFastDashboardIndexForTests;
  let setFastPrewarmTimeoutForTests: typeof import("../src/dashboard.js").setFastPrewarmTimeoutForTests;
  let setFastVerificationReadTimeoutForTests: typeof import("../src/dashboard.js").setFastVerificationReadTimeoutForTests;
  let getVerificationSnapshotInflightSizeForTests: typeof import("../src/dashboard.js").getVerificationSnapshotInflightSizeForTests;
  let clearVerificationSnapshotCacheForTests: typeof import("../src/dashboard.js").clearVerificationSnapshotCacheForTests;
  let setDashboardScoutRunnerForTests: typeof import("../src/dashboard.js").setDashboardScoutRunnerForTests;
  let setDashboardCrawlLauncherForTests: typeof import("../src/dashboard.js").setDashboardCrawlLauncherForTests;
  let resetDashboardScanStateForTests: typeof import("../src/dashboard.js").resetDashboardScanStateForTests;
  let startDashboardStartupScanForTests: typeof import("../src/dashboard.js").startDashboardStartupScanForTests;
  let startDashboardRunWatcherForTests: typeof import("../src/dashboard.js").startDashboardRunWatcherForTests;
  let prepareDashboardRunWatcherForTests: typeof import("../src/dashboard.js").prepareDashboardRunWatcherForTests;
  let pollDashboardRunWatcherForTests: typeof import("../src/dashboard.js").pollDashboardRunWatcherForTests;
  let stopDashboardRunWatcherForTests: typeof import("../src/dashboard.js").stopDashboardRunWatcherForTests;
  let getDashboardRunWatcherStateForTests: typeof import("../src/dashboard.js").getDashboardRunWatcherStateForTests;
  let databasePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-fast-"));
    const publicDirectory = join(directory, "public");
    mkdirSync(publicDirectory, { recursive: true });
    writeFileSync(join(publicDirectory, "landing.html"), '<!doctype html><title>Landing fixture</title><link rel="stylesheet" href="/landing.css"><script src="/landing.js"></script>');
    writeFileSync(join(publicDirectory, "landing.css"), "body { background: #f2f0e9; }");
    writeFileSync(join(publicDirectory, "landing.js"), "document.documentElement.dataset.landing = 'ready';");
    mkdirSync(join(publicDirectory, "assets", "brand"), { recursive: true });
    writeFileSync(join(publicDirectory, "assets", "brand", "roleradar-mark.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"></svg>');
    writeFileSync(join(publicDirectory, "index.html"), '<!doctype html><title>Listings fixture</title><link rel="stylesheet" href="/styles.css"><script src="/app.js"></script>');
    writeFileSync(join(publicDirectory, "styles.css"), "body { background: white; }");
    writeFileSync(join(publicDirectory, "app.js"), "document.documentElement.dataset.listings = 'ready';");
    process.env.INTERNSHIPMATIC_ROOT = directory;
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.SCOUT_OUTPUT_DIR = join(directory, "output", "live");
    process.env.GRIND_JOB_BOARD_CACHE_PATH = join(directory, "missing-board-cache.json");
    ({ requestHandler, setFastSnapshotReadHookForTests, setFastRunRevisionCaptureHookForTests, setFastStartupWatcherBaselineGapHookForTests, setFastStartupWatcherAfterBaselineHookForTests, setFastDashboardIndexBuildHookForTests, closeFastRevisionTrackersForTests, clearFastDashboardCacheForTests, clearDashboardDataCacheForTests, prewarmFastDashboardIndexForTests, setFastPrewarmTimeoutForTests, setFastVerificationReadTimeoutForTests, getVerificationSnapshotInflightSizeForTests, clearVerificationSnapshotCacheForTests, setDashboardScoutRunnerForTests, setDashboardCrawlLauncherForTests, resetDashboardScanStateForTests, startDashboardStartupScanForTests, startDashboardRunWatcherForTests, prepareDashboardRunWatcherForTests, pollDashboardRunWatcherForTests, stopDashboardRunWatcherForTests, getDashboardRunWatcherStateForTests } = await import("../src/dashboard.js"));

    databasePath = join(directory, "dashboard.db");
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(databasePath);
    const roles = [
      makeInternship({ id: "summer-1", company: "Acme Labs", applicationUrl: "https://boards.greenhouse.io/acme/jobs/101/apply", postingUrl: "https://boards.greenhouse.io/acme/jobs/101" }),
      makeInternship({ id: "summer-2", company: "Beta Labs", applicationUrl: "https://boards.greenhouse.io/beta/jobs/102/apply", postingUrl: "https://boards.greenhouse.io/beta/jobs/102" }),
    ];
    const runId = database.startRun(options);
    database.persistRun(runId, crawl(roles), 2);
    database.close();
  });

  afterAll(() => {
    setFastSnapshotReadHookForTests(null);
    setFastRunRevisionCaptureHookForTests(null);
    setFastStartupWatcherBaselineGapHookForTests(null);
    setFastStartupWatcherAfterBaselineHookForTests(null);
    setFastDashboardIndexBuildHookForTests(null);
    setDashboardScoutRunnerForTests(null);
    setDashboardCrawlLauncherForTests(null);
    resetDashboardScanStateForTests();
    stopDashboardRunWatcherForTests();
    closeFastRevisionTrackersForTests();
    clearDashboardDataCacheForTests();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.INTERNSHIPMATIC_ROOT;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.SCOUT_OUTPUT_DIR;
    delete process.env.GRIND_JOB_BOARD_CACHE_PATH;
  });

  it("serves the landing page at root and preserves the listings application at /jobs", async () => {
    const landing = response();
    await requestHandler(request("GET", "/") as never, landing as never, databasePath);
    expect(landing.statusCode).toBe(200);
    expect(landing.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(landing.headers["Cache-Control"]).toBe("no-store");
    expect(landing.body.toString("utf8")).toContain("Landing fixture");
    expect(landing.body.toString("utf8")).toMatch(/landing\.css\?v=[a-f0-9]{12}/);
    expect(landing.body.toString("utf8")).toMatch(/landing\.js\?v=[a-f0-9]{12}/);

    const listings = response();
    await requestHandler(request("GET", "/jobs") as never, listings as never, databasePath);
    expect(listings.statusCode).toBe(200);
    expect(listings.headers["Content-Type"]).toBe("text/html; charset=utf-8");
    expect(listings.headers["Cache-Control"]).toBe("no-store");
    expect(listings.body.toString("utf8")).toContain("Listings fixture");
    expect(listings.body.toString("utf8")).toMatch(/styles\.css\?v=[a-f0-9]{12}/);
    expect(listings.body.toString("utf8")).toMatch(/app\.js\?v=[a-f0-9]{12}/);

    const listingsWithSlash = response();
    await requestHandler(request("HEAD", "/jobs/") as never, listingsWithSlash as never, databasePath);
    expect(listingsWithSlash.statusCode).toBe(200);
    expect(listingsWithSlash.body.byteLength).toBe(0);

    const brandMark = response();
    await requestHandler(request("GET", "/assets/brand/roleradar-mark.svg") as never, brandMark as never, databasePath);
    expect(brandMark.statusCode).toBe(200);
    expect(brandMark.headers["Content-Type"]).toBe("image/svg+xml");
    expect(brandMark.body.toString("utf8")).toContain("<svg");
  });

  it("serves applied roles with funnel stages and persists stage transitions", async () => {
    const applied = response();
    await requestHandler(request("POST", "/api/actions", {}, {
      listingType: "internship",
      listingId: "summer-2",
      action: "applied",
      company: "Beta Labs",
      title: "Software Engineering Intern",
    }) as never, applied as never, databasePath);
    expect(applied.statusCode).toBe(200);

    const initialApplications = response();
    await requestHandler(request("GET", "/api/applications") as never, initialApplications as never, databasePath);
    const initialPayload = JSON.parse(initialApplications.body.toString("utf8")) as {
      applications: Array<{ listingId: string; stage: string; status: string }>;
      counts: Record<string, number>;
    };
    expect(initialApplications.statusCode).toBe(200);
    expect(initialPayload.applications).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "summer-2", stage: "applied", status: "pending" }),
    ]));
    expect(initialPayload.counts.applied).toBe(1);

    const transitioned = response();
    await requestHandler(request("POST", "/api/applications/status", {}, {
      listingType: "internship",
      listingId: "summer-2",
      stage: "interview",
    }) as never, transitioned as never, databasePath);
    const transitionedPayload = JSON.parse(transitioned.body.toString("utf8")) as {
      stage: string;
      counts: Record<string, number>;
    };
    expect(transitioned.statusCode).toBe(200);
    expect(transitionedPayload.stage).toBe("interview");
    expect(transitionedPayload.counts.interview).toBe(1);

    const stored = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(stored.prepare("SELECT application_stage, application_status FROM listing_actions WHERE listing_key = 'internship:summer-2'").get()).toEqual({
        application_stage: "interview",
        application_status: "pending",
      });
    } finally {
      stored.close();
    }

    const cleanup = response();
    await requestHandler(request("DELETE", "/api/actions?listingType=internship&listingId=summer-2") as never, cleanup as never, databasePath);
    expect(cleanup.statusCode).toBe(200);
  });

  it("filters and paginates compact cards server-side", async () => {
    const captured = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=open&limit=1") as never,
      captured as never,
      databasePath,
    );
    const payload = JSON.parse(captured.body.toString("utf8")) as Record<string, unknown>;
    const pagination = payload.pagination as { total: number; hasMore: boolean };
    const items = payload.items as Array<Record<string, unknown>>;
    expect(captured.statusCode).toBe(200);
    expect(payload.contract).toBe("dashboard.roles.v1");
    expect(pagination.total).toBe(2);
    expect(pagination.hasMore).toBe(true);
    expect(items).toHaveLength(1);
    expect(items[0]).not.toHaveProperty("description");
    expect(items[0]).not.toHaveProperty("requiredQualifications");
    expect(items[0]).toHaveProperty("applicationUrl");
    expect(items[0]).toHaveProperty("canadianLocation", "Toronto, ON, Canada");
  });

  it("applies the shared hard filters to live-board listings", async () => {
    const now = new Date().toISOString();
    const boardRefresh = vi.spyOn(GrindJobBoardClient.prototype, "getCachedSnapshot").mockReturnValue({
      sourceUrl: "https://didtheboysgrindleetcodetoday.com/jobs",
      status: "ready",
      jobs: [
        {
          id: "board-allowed",
          company: "Board Labs",
          title: "Software Engineer Intern",
          location: "Toronto, ON, Canada",
          link: "https://board.example/jobs/allowed",
          firstSeen: now,
          jobId: "allowed",
        },
        {
          id: "board-foreign",
          company: "Foreign Labs",
          title: "Software Engineer Intern",
          location: "London, United Kingdom",
          link: "https://board.example/jobs/foreign",
          firstSeen: now,
          jobId: "foreign",
        },
        {
          id: "board-no-location",
          company: "Unknown Location Labs",
          title: "Software Engineer Intern",
          location: null,
          link: "https://board.example/jobs/no-location",
          firstSeen: now,
          jobId: "no-location",
        },
        {
          id: "board-excluded-title",
          company: "Excluded Title Labs",
          title: "Software Engineer Intern 2026",
          location: "Toronto, ON, Canada",
          link: "https://board.example/jobs/excluded-title",
          firstSeen: now,
          jobId: "excluded-title",
        },
        {
          id: "board-low-score",
          company: "Low Score Labs",
          title: "Marketing Intern",
          location: "Toronto, ON, Canada",
          link: "https://board.example/jobs/low-score",
          firstSeen: now,
          jobId: "low-score",
        },
      ],
      jobCount: 5,
      freshCount: 5,
      companyCount: 5,
      companiesSynced: 5,
      companiesRefreshed: 5,
      lastAttemptAt: now,
      lastSuccessfulSyncAt: now,
      cacheTtlMinutes: 5,
      attempts: 5,
      retrievalUrl: "https://board.example/api/query",
      failures: [],
    } as never);
    clearFastDashboardCacheForTests();
    try {
      const captured = response();
      await requestHandler(
        request("GET", "/api/roles?tab=main&status=open&limit=100") as never,
        captured as never,
        databasePath,
      );
      const payload = JSON.parse(captured.body.toString("utf8")) as {
        pagination: { total: number };
        items: Array<{ listingId?: string; id?: string }>;
      };
      const listingIds = payload.items.map((item) => item.listingId ?? item.id);
      expect(captured.statusCode).toBe(200);
      expect(listingIds).toContain("board-allowed");
      expect(listingIds).not.toEqual(expect.arrayContaining([
        "board-foreign",
        "board-no-location",
        "board-excluded-title",
        "board-low-score",
      ]));
      expect(payload.pagination.total).toBe(3);
    } finally {
      boardRefresh.mockRestore();
      clearFastDashboardCacheForTests();
    }
  });

  it("applies work-mode and location filters before pagination and varies validators", async () => {
    const location = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=open&location=Toronto&limit=1") as never,
      location as never,
      databasePath,
    );
    const locationPayload = JSON.parse(location.body.toString("utf8")) as {
      filters: { location: string | null; workMode: string | null };
      pagination: { total: number; hasMore: boolean };
    };
    expect(location.statusCode).toBe(200);
    expect(locationPayload.filters).toMatchObject({ location: "toronto", workMode: null });
    expect(locationPayload.pagination).toMatchObject({ total: 2, hasMore: true });

    const remote = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=open&workMode=remote&limit=1") as never,
      remote as never,
      databasePath,
    );
    const remotePayload = JSON.parse(remote.body.toString("utf8")) as {
      filters: { location: string | null; workMode: string | null };
      pagination: { total: number; hasMore: boolean };
    };
    expect(remotePayload.filters).toMatchObject({ location: null, workMode: "remote" });
    expect(remotePayload.pagination).toMatchObject({ total: 0, hasMore: false });
    expect(location.headers.ETag).not.toBe(remote.headers.ETag);

    const invalid = response();
    await requestHandler(
      request("GET", "/api/roles?workMode=teleport") as never,
      invalid as never,
      databasePath,
    );
    expect(invalid.statusCode).toBe(400);
  });

  it("exposes each configured source and the latest run's per-source status", async () => {
    const changes = response();
    await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
    const changesPayload = JSON.parse(changes.body.toString("utf8")) as {
      sources: Array<{ url: string; isConfigured: boolean; last_status: string | null }>;
      sourceResults: Array<{ url: string; settled: number; completed: number; status: string }>;
      failures: unknown[];
    };
    expect(changesPayload.sources.some((source) => source.isConfigured)).toBe(true);
    expect(changesPayload.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://example.com/careers" }),
    ]));
    expect(changesPayload.sourceResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: "https://example.com/careers", settled: 1, completed: 1 }),
    ]));
    expect(Array.isArray(changesPayload.failures)).toBe(true);

    const roles = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=1") as never, roles as never, databasePath);
    const rolesPayload = JSON.parse(roles.body.toString("utf8")) as {
      sources: Array<{ url: string }>;
      sourceResults: Array<{ url: string }>;
    };
    expect(rolesPayload.sources.map((source) => source.url)).toEqual(
      expect.arrayContaining(changesPayload.sources.map((source) => source.url)),
    );
    expect(rolesPayload.sourceResults.map((source) => source.url)).toEqual(
      expect.arrayContaining(["https://example.com/careers"]),
    );
  });

  it("keeps provenance and failures on a failed latest run instead of the last completed crawl", async () => {
    resetDashboardScanStateForTests();
    clearFastDashboardCacheForTests();
    const now = new Date().toISOString();
    const failedSource = "https://jobs.example.test/failed-latest-run";
    const database = new DatabaseSync(databasePath);
    let runId: number;
    try {
      database.prepare(`
        INSERT INTO crawl_runs (started_at, finished_at, heartbeat_at, status, options_json, sources_requested, sources_settled, error_message)
        VALUES (@startedAt, @finishedAt, NULL, 'FAILED', '{}', 19, 16, @error)
      `).run({
        startedAt: now,
        finishedAt: now,
        error: "Marked stale after exceeding the maximum crawl duration.",
      });
      runId = Number((database.prepare("SELECT MAX(id) AS id FROM crawl_runs").get() as { id: number }).id);
      database.prepare("INSERT INTO sources (url, created_at) VALUES (@url, @now) ON CONFLICT(url) DO NOTHING").run({ url: failedSource, now });
      const sourceId = Number((database.prepare("SELECT id FROM sources WHERE url = @url").get({ url: failedSource }) as { id: number }).id);
      database.prepare(`
        INSERT INTO source_run_results (run_id, source_id, settled, completed, jobs_discovered, failure_count, status)
        VALUES (@runId, @sourceId, 1, 1, 3, 1, 'partial')
      `).run({ runId, sourceId });
      database.prepare(`
        INSERT INTO failed_pages (run_id, source_id, url, error_type, message, status_code, retry_count, occurred_at)
        VALUES (@runId, @sourceId, @url, 'http_error', 'Not found HTTP 404', 404, 0, @now)
      `).run({ runId, sourceId, url: `${failedSource}/missing.md`, now });
    } finally {
      database.close();
    }

    try {
      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      expect(changes.statusCode).toBe(200);
      const payload = JSON.parse(changes.body.toString("utf8")) as {
        scan: { status: string; error: string | null; runId: number | null };
        latestRun: { id: number; status: string; sources_settled: number };
        latestCompletedRun: { id: number; status: string };
        sourceResults: Array<{ url: string; status: string }>;
        failures: Array<{ source_url: string }>;
      };
      expect(payload.latestRun.id).toBe(runId);
      expect(payload.latestRun.status).toBe("FAILED");
      expect(payload.latestCompletedRun.id).not.toBe(runId);
      expect(payload.scan.status).toBe("FAILED");
      expect(payload.scan.error).toMatch(/stale/i);
      expect(payload.scan.runId).toBe(runId);
      expect(payload.sourceResults.map((source) => source.url)).toEqual([failedSource]);
      expect(payload.sourceResults[0]).toMatchObject({ url: failedSource, status: "partial" });
      expect(payload.failures.map((failure) => failure.source_url)).toEqual([failedSource]);
    } finally {
      const cleanup = new DatabaseSync(databasePath);
      cleanup.prepare("DELETE FROM crawl_runs WHERE id = @runId").run({ runId });
      cleanup.close();
      resetDashboardScanStateForTests();
      clearFastDashboardCacheForTests();
    }
  });

  it("pages a later offset from the same filtered list", async () => {
    const first = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=open&limit=1&offset=0") as never,
      first as never,
      databasePath,
    );
    const second = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=open&limit=1&offset=1") as never,
      second as never,
      databasePath,
    );
    const firstPayload = JSON.parse(first.body.toString("utf8")) as {
      pagination: { total: number; hasMore: boolean; nextOffset: number | null };
      items: Array<{ id: string }>;
    };
    const secondPayload = JSON.parse(second.body.toString("utf8")) as {
      pagination: { total: number; hasMore: boolean; nextOffset: number | null };
      items: Array<{ id: string }>;
    };
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(firstPayload.pagination.total).toBe(2);
    expect(secondPayload.pagination.total).toBe(2);
    expect(firstPayload.items).toHaveLength(1);
    expect(secondPayload.items).toHaveLength(1);
    expect(firstPayload.items[0]?.id).not.toBe(secondPayload.items[0]?.id);
    expect(firstPayload.pagination.hasMore).toBe(true);
    expect(firstPayload.pagination.nextOffset).toBe(1);
    expect(secondPayload.pagination.hasMore).toBe(false);
    expect(secondPayload.pagination.nextOffset).toBeNull();
    expect([firstPayload.items[0]?.id, secondPayload.items[0]?.id].sort()).toEqual(["summer-1", "summer-2"]);
  });

  it("prewarms successfully without board/network work and falls back on failure", async () => {
    clearFastDashboardCacheForTests();
    const boardRefresh = vi.spyOn(GrindJobBoardClient.prototype, "getSnapshot");
    try {
      await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
      const concurrent = await Promise.all(Array.from({ length: 8 }, async () => {
        const captured = response();
        await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, captured as never, databasePath);
        return { status: captured.statusCode, body: captured.body.toString("utf8") };
      }));
      expect(concurrent.every(({ status }) => status === 200)).toBe(true);
      expect(new Set(concurrent.map(({ body }) => (JSON.parse(body) as { version: string }).version)).size).toBe(1);
      expect(boardRefresh).not.toHaveBeenCalled();

      await expect(prewarmFastDashboardIndexForTests(join(directory, "missing-prewarm.db"))).resolves.toBe(false);
    } finally {
      boardRefresh.mockRestore();
    }
  });

  it("detaches stalled prewarm verification so requests and shutdown recover", async () => {
    const artifactPath = join(directory, "output", "live", "final-report", "link-verification.json");
    mkdirSync(join(directory, "output", "live", "final-report"), { recursive: true });
    rmSync(artifactPath, { force: true });
    const fifo = spawnSync("mkfifo", [artifactPath], { stdio: "ignore" });
    if (fifo.status !== 0) throw new Error("mkfifo is required for the stalled verification regression");
    setFastPrewarmTimeoutForTests(50);
    setFastVerificationReadTimeoutForTests(50);
    clearFastDashboardCacheForTests();
    clearVerificationSnapshotCacheForTests();
    try {
      const startedAt = Date.now();
      const prewarmPromise = prewarmFastDashboardIndexForTests(databasePath);
      const requestsToMake: Array<[string, string]> = [
        ["GET", "/api/roles?tab=summer&status=open&limit=8"],
        ["GET", "/api/roles/internship/summer-1"],
        ["GET", "/api/changes"],
      ];
      const requests = await Promise.all(requestsToMake.map(async ([method, url]) => {
        const captured = response();
        await requestHandler(request(method, url) as never, captured as never, databasePath);
        return captured.statusCode;
      }));
      await expect(prewarmPromise).resolves.toBe(false);
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(requests).toEqual([200, 200, 200]);
      expect(getVerificationSnapshotInflightSizeForTests()).toBe(0);

      // Closing the normal shutdown-owned revision resources while the
      // prewarm has failed must not leave artifact work or map state behind.
      closeFastRevisionTrackersForTests();

      rmSync(artifactPath, { force: true });
      writeFileSync(artifactPath, JSON.stringify({ results: [] }), "utf8");
      setFastPrewarmTimeoutForTests(500);
      await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
      expect(getVerificationSnapshotInflightSizeForTests()).toBe(0);
    } finally {
      setFastPrewarmTimeoutForTests(null);
      setFastVerificationReadTimeoutForTests(null);
      clearVerificationSnapshotCacheForTests();
      rmSync(artifactPath, { force: true });
    }
  });

  it("keeps startup and manual crawl triggers alive across prewarm outcomes and run leases", async () => {
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    const previousSkip = process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    let calls = 0;
    let release: (() => void) | null = null;
    const execution = new Promise<unknown>((resolve) => {
      release = () => resolve({ persisted: { runId: 9_999 } });
    });
    const settleExecution = (): void => {
      const currentRelease = release;
      if (currentRelease !== null) currentRelease();
    };
    setDashboardScoutRunnerForTests(() => execution as never);
    resetDashboardScanStateForTests();
    try {
      // A prewarm failure is a display-cache concern and must not disable the
      // independent startup run trigger.
      await expect(prewarmFastDashboardIndexForTests(join(directory, "missing-prewarm.db"))).resolves.toBe(false);
      setDashboardScoutRunnerForTests(() => {
        calls += 1;
        return execution as never;
      });
      startDashboardStartupScanForTests(databasePath, settings);
      expect(calls).toBe(1);

      // The same process and a fresh durable lease both prevent duplicate
      // crawls, without making the manual endpoint rebuild dashboard data.
      startDashboardStartupScanForTests(databasePath, settings);
      expect(calls).toBe(1);
      const duplicate = response();
      await requestHandler(request("POST", "/api/refresh") as never, duplicate as never, databasePath);
      expect(duplicate.statusCode).toBe(200);
      expect((JSON.parse(duplicate.body.toString("utf8")) as { started: boolean }).started).toBe(false);

      settleExecution();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      resetDashboardScanStateForTests();

      const lock = new DatabaseSync(databasePath);
      const fresh = new Date().toISOString();
      try {
        lock.prepare(`
          INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
          VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)
        `).run({ startedAt: fresh, heartbeatAt: fresh });
      } finally {
        lock.close();
      }
      startDashboardStartupScanForTests(databasePath, settings);
      expect(calls).toBe(1);

      const stale = new DatabaseSync(databasePath);
      const staleTime = new Date(Date.now() - 21 * 60 * 1_000).toISOString();
      try {
        stale.prepare("UPDATE crawl_runs SET started_at = @staleTime, heartbeat_at = @staleTime WHERE status = 'RUNNING'").run({ staleTime });
      } finally {
        stale.close();
      }
      const staleStart = startDashboardStartupScanForTests(databasePath, settings);
      expect(staleStart).toBe(true);
      expect(calls).toBe(2);
    } finally {
      settleExecution();
      setDashboardScoutRunnerForTests(null);
      resetDashboardScanStateForTests();
      if (previousSkip === undefined) delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
      else process.env.DASHBOARD_SKIP_STARTUP_SCAN = previousSkip;
      const cleanup = new DatabaseSync(databasePath);
      cleanup.prepare("UPDATE crawl_runs SET status = 'FAILED', finished_at = @finishedAt, heartbeat_at = NULL WHERE status = 'RUNNING'").run({ finishedAt: new Date().toISOString() });
      cleanup.close();
    }
  });

  it("delegates production crawls to an isolated launcher while serving the dashboard", async () => {
    const previousSkip = process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    let release = (): void => undefined;
    let calls = 0;
    const execution = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    setDashboardScoutRunnerForTests(null);
    setDashboardCrawlLauncherForTests((options) => {
      calls += 1;
      expect(options.cancellationSignal).toBeDefined();
      expect(options.sources.length).toBeGreaterThan(0);
      return execution;
    });
    resetDashboardScanStateForTests();
    try {
      expect(startDashboardStartupScanForTests(databasePath, settings)).toBe(true);
      expect(calls).toBe(1);

      const landing = response();
      await requestHandler(request("GET", "/") as never, landing as never, databasePath);
      expect(landing.statusCode).toBe(200);
      expect(landing.body.toString("utf8")).toContain("Landing fixture");

      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    } finally {
      release();
      setDashboardCrawlLauncherForTests(null);
      resetDashboardScanStateForTests();
      if (previousSkip === undefined) delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
      else process.env.DASHBOARD_SKIP_STARTUP_SCAN = previousSkip;
    }
  });

  it("starts a deduped post-run index prewarm from the durable commit callback", async () => {
    clearFastDashboardCacheForTests();
    let buildCount = 0;
    let callbackObserved = false;
    const previousSkip = process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    setFastDashboardIndexBuildHookForTests(() => { buildCount += 1; });
    setDashboardScoutRunnerForTests((options) => {
      options.onRunCommitted?.(9_999);
      callbackObserved = true;
      return Promise.resolve({ persisted: { runId: 9_999 } }) as never;
    });
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    resetDashboardScanStateForTests();
    try {
      expect(startDashboardStartupScanForTests(databasePath, settings)).toBe(true);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      expect(callbackObserved).toBe(true);

      const captured = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, captured as never, databasePath);
      expect(captured.statusCode).toBe(200);
      expect(buildCount).toBe(1);
    } finally {
      setFastDashboardIndexBuildHookForTests(null);
      setDashboardScoutRunnerForTests(null);
      resetDashboardScanStateForTests();
      if (previousSkip === undefined) delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
      else process.env.DASHBOARD_SKIP_STARTUP_SCAN = previousSkip;
    }
  });

  it("reconciles a durable commit across the startup prewarm-to-baseline gap", async () => {
    const startupDirectory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-startup-gap-"));
    const startupPath = join(startupDirectory, "startup.db");
    const settings = resolveSettings({ databasePath: startupPath, outputDirectory: join(startupDirectory, "output") });
    const seed = makeInternship({
      id: "startup-gap-role",
      company: "Startup Gap Labs",
      applicationUrl: "https://boards.greenhouse.io/startup-gap/jobs/901/apply",
      postingUrl: "https://boards.greenhouse.io/startup-gap/jobs/901",
    });
    const seedDatabase = new InternshipDatabase(startupPath);
    const seedRun = seedDatabase.startRun({
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    });
    seedDatabase.persistRun(seedRun, crawl([seed]), 2);
    seedDatabase.close();

    const commitAfterPrewarm = (company = "Startup Gap Reconciled Labs"): void => {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", `
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(${JSON.stringify(startupPath)});
        const company = ${JSON.stringify(company)};
        database.exec("BEGIN IMMEDIATE");
        try {
          const role = database.prepare("SELECT payload_json FROM internships WHERE id = 'startup-gap-role'").get();
          const payload = JSON.parse(role.payload_json);
          payload.company = company;
          database.prepare("UPDATE internships SET company = @company, normalized_company = @normalizedCompany, payload_json = @payload, content_hash = @contentHash WHERE id = 'startup-gap-role'").run({ company, normalizedCompany: company.toLocaleLowerCase(), payload: JSON.stringify(payload), contentHash: "startup-gap-" + company.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-") });
          const now = new Date().toISOString();
          database.prepare("INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested) VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)").run({ startedAt: now, heartbeatAt: now });
          const run = database.prepare("SELECT id FROM crawl_runs ORDER BY id DESC LIMIT 1").get();
          database.prepare("UPDATE crawl_runs SET status = 'COMPLETED', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = @id").run({ finishedAt: now, id: run.id });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          database.close();
        }
      `], { cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"] });
      expect(child.status, child.stderr.toString("utf8")).toBe(0);
    };

    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    try {
      clearFastDashboardCacheForTests();
      await expect(prewarmFastDashboardIndexForTests(startupPath)).resolves.toBe(true);
      builds = 0;
      // This hook is called immediately before the suppressed watcher
      // baseline, after the successful prewarm has captured its revision.
      setFastStartupWatcherBaselineGapHookForTests(commitAfterPrewarm);
      await prepareDashboardRunWatcherForTests(startupPath, true);
      expect(builds).toBe(1);

      const warmed = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, warmed as never, startupPath);
      const warmedPayload = JSON.parse(warmed.body.toString("utf8")) as { items: Array<{ company: string }> };
      expect(warmed.statusCode).toBe(200);
      expect(warmedPayload.items[0]?.company).toBe("Startup Gap Reconciled Labs");
      expect(builds).toBe(1);

      // Simulate the listener callback after preparation. The external
      // terminal commit must be observed by the already-prepared watcher;
      // replacing it here would baseline the new run and lose the prewarm.
      const beforeListenerCommit = response();
      await requestHandler(request("GET", "/api/changes") as never, beforeListenerCommit as never, startupPath);
      const beforeListenerVersion = (JSON.parse(beforeListenerCommit.body.toString("utf8")) as { version: string }).version;
      builds = 0;
      commitAfterPrewarm("Startup Gap Listener Labs");
      startDashboardRunWatcherForTests(startupPath);
      startDashboardRunWatcherForTests(startupPath);
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: true, hasTimer: true });
      // No manual watcher poll or settling delay: the listener handoff poll
      // must schedule the shared prewarm before the first concurrent reads.
      const immediateFirst = response();
      const immediateSecond = response();
      await Promise.all([
        requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, immediateFirst as never, startupPath),
        requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, immediateSecond as never, startupPath),
      ]);
      const immediateFirstPayload = JSON.parse(immediateFirst.body.toString("utf8")) as { version: string; items: Array<{ company: string }> };
      const immediateSecondPayload = JSON.parse(immediateSecond.body.toString("utf8")) as { version: string; items: Array<{ company: string }> };
      expect(immediateFirst.statusCode).toBe(200);
      expect(immediateSecond.statusCode).toBe(200);
      expect(immediateFirstPayload.items[0]?.company).toBe("Startup Gap Listener Labs");
      expect(immediateSecondPayload.items[0]?.company).toBe("Startup Gap Listener Labs");
      expect(immediateFirstPayload.version).toBe(immediateSecondPayload.version);
      expect(builds).toBe(1);
      const afterListenerCommit = response();
      await requestHandler(request("GET", "/api/changes") as never, afterListenerCommit as never, startupPath);
      expect((JSON.parse(afterListenerCommit.body.toString("utf8")) as { version: string }).version).not.toBe(beforeListenerVersion);

      // A second unchanged startup handoff only baselines; it does not pay a
      // redundant rebuild after the successful prewarm.
      stopDashboardRunWatcherForTests();
      clearFastDashboardCacheForTests();
      await expect(prewarmFastDashboardIndexForTests(startupPath)).resolves.toBe(true);
      builds = 0;
      await prepareDashboardRunWatcherForTests(startupPath, true);
      expect(builds).toBe(0);
      startDashboardRunWatcherForTests(startupPath);
      expect(builds).toBe(0);

      // A commit immediately after the suppressed baseline is also caught by
      // the final revision reconciliation before the watcher is armed.
      stopDashboardRunWatcherForTests();
      clearFastDashboardCacheForTests();
      await expect(prewarmFastDashboardIndexForTests(startupPath)).resolves.toBe(true);
      builds = 0;
      setFastStartupWatcherAfterBaselineHookForTests(commitAfterPrewarm);
      await prepareDashboardRunWatcherForTests(startupPath, true);
      expect(builds).toBe(1);

      // A failed/disabled startup prewarm still creates and arms the watcher;
      // the next listener start reuses it rather than creating a second timer.
      stopDashboardRunWatcherForTests();
      await prepareDashboardRunWatcherForTests(startupPath, false);
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: true, hasTimer: true });
      startDashboardRunWatcherForTests(startupPath);
    } finally {
      setFastStartupWatcherBaselineGapHookForTests(null);
      setFastStartupWatcherAfterBaselineHookForTests(null);
      setFastDashboardIndexBuildHookForTests(null);
      stopDashboardRunWatcherForTests();
      closeFastRevisionTrackersForTests();
      rmSync(startupDirectory, { recursive: true, force: true });
    }
  });

  it("watches external scout terminal commits without rebuilding on progress", async () => {
    const watcherDirectory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-run-watcher-"));
    const watcherPath = join(watcherDirectory, "watcher.db");
    const settings = resolveSettings({ databasePath: watcherPath, outputDirectory: join(watcherDirectory, "output") });
    const seed = makeInternship({
      id: "watcher-role",
      company: "Watcher Labs",
      applicationUrl: "https://boards.greenhouse.io/watcher/jobs/701/apply",
      postingUrl: "https://boards.greenhouse.io/watcher/jobs/701",
    });
    const seedDatabase = new InternshipDatabase(watcherPath);
    const seedRun = seedDatabase.startRun({
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    });
    seedDatabase.persistRun(seedRun, crawl([seed]), 2);
    seedDatabase.close();

    const mutateInScoutProcess = (script: string): void => {
      const child = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      expect(child.status, child.stderr.toString("utf8")).toBe(0);
    };
    const insertRunning = (databasePath = watcherPath): void => {
      const now = new Date().toISOString();
      mutateInScoutProcess(`
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(${JSON.stringify(databasePath)});
        database.prepare("INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested) VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)").run({ startedAt: ${JSON.stringify(now)}, heartbeatAt: ${JSON.stringify(now)} });
        database.close();
      `);
    };
    const progress = (databasePath = watcherPath): void => {
      const now = new Date().toISOString();
      mutateInScoutProcess(`
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(${JSON.stringify(databasePath)});
        database.prepare("UPDATE crawl_runs SET pages_visited = pages_visited + 1, heartbeat_at = @heartbeatAt WHERE id = (SELECT MAX(id) FROM crawl_runs)").run({ heartbeatAt: ${JSON.stringify(now)} });
        database.close();
      `);
    };
    const complete = (databasePath = watcherPath): void => {
      const now = new Date().toISOString();
      mutateInScoutProcess(`
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(${JSON.stringify(databasePath)});
        database.prepare("UPDATE crawl_runs SET status = 'COMPLETED', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = (SELECT MAX(id) FROM crawl_runs)").run({ finishedAt: ${JSON.stringify(now)} });
        database.close();
      `);
    };
    const fail = (databasePath = watcherPath): void => {
      const now = new Date().toISOString();
      mutateInScoutProcess(`
        import { DatabaseSync } from "node:sqlite";
        const database = new DatabaseSync(${JSON.stringify(databasePath)});
        database.exec("BEGIN IMMEDIATE");
        try {
          const row = database.prepare("SELECT payload_json FROM internships WHERE id = 'watcher-role'").get();
          const payload = JSON.parse(row.payload_json);
          payload.company = "Watcher Failed Labs";
          database.prepare("UPDATE internships SET company = 'Watcher Failed Labs', normalized_company = 'watcher failed labs', payload_json = @payload WHERE id = 'watcher-role'").run({ payload: JSON.stringify(payload) });
          database.prepare("UPDATE crawl_runs SET status = 'FAILED', error_message = 'controlled failure', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = (SELECT MAX(id) FROM crawl_runs)").run({ finishedAt: ${JSON.stringify(now)} });
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        } finally {
          database.close();
        }
      `);
    };

    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    try {
      clearFastDashboardCacheForTests();
      await expect(prewarmFastDashboardIndexForTests(watcherPath)).resolves.toBe(true);
      builds = 0;
      startDashboardRunWatcherForTests(watcherPath);
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: true });
      expect(builds).toBe(0);

      insertRunning();
      pollDashboardRunWatcherForTests();
      progress();
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(builds).toBe(0);

      complete();
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(builds).toBe(1);
      const warmed = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, warmed as never, watcherPath);
      expect(warmed.statusCode).toBe(200);
      expect(builds).toBe(1);

      // Re-observing the same terminal run is a no-op.
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(builds).toBe(1);

      // A second terminal run is observed independently and warms its new
      // durable revision; progress-only writes never enter this path.
      insertRunning();
      fail();
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(builds).toBe(2);

      // FAILED is also terminal: a failed scout can persist incremental role
      // changes before recording its durable error, so it receives the same
      // one-shot read-side prewarm treatment as COMPLETED.
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(builds).toBe(2);

      // Replacing the SQLite file (as a safe snapshot restore can do) closes
      // the old watcher handle and observes the new inode/content revision.
      const replacement = new DatabaseSync(watcherPath);
      try {
        const row = replacement.prepare("SELECT payload_json FROM internships WHERE id = 'watcher-role'").get() as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        payload.company = "Watcher Replacement Labs";
        replacement.prepare("UPDATE internships SET company = @company, normalized_company = @normalizedCompany, payload_json = @payload, content_hash = @hash WHERE id = 'watcher-role'").run({
          company: "Watcher Replacement Labs",
          normalizedCompany: "watcher replacement labs",
          payload: JSON.stringify(payload),
          hash: "watcher-replacement",
        });
        writeFileSync(`${watcherPath}.replacement`, replacement.serialize());
      } finally {
        replacement.close();
      }
      renameSync(`${watcherPath}.replacement`, watcherPath);
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(builds).toBe(3);

      // An empty/legacy SQLite file is tolerated and retried rather than
      // taking down the resident dashboard watcher.
      const legacyPath = join(watcherDirectory, "legacy.db");
      const legacyDatabase = new DatabaseSync(legacyPath);
      legacyDatabase.close();
      startDashboardRunWatcherForTests(legacyPath);
      pollDashboardRunWatcherForTests();
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: true });
      stopDashboardRunWatcherForTests();

      // A temporarily missing database is recoverable without restarting the
      // resident dashboard or leaking the prior read handle.
      const missingPath = join(watcherDirectory, "recreated.db");
      stopDashboardRunWatcherForTests();
      startDashboardRunWatcherForTests(missingPath);
      pollDashboardRunWatcherForTests();
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: false });
      const recreatedSettings = resolveSettings({ databasePath: missingPath, outputDirectory: join(watcherDirectory, "recreated-output") });
      const recreatedDatabase = new InternshipDatabase(missingPath);
      const recreatedRun = recreatedDatabase.startRun({
        sources: ["https://example.com/careers"],
        settings: recreatedSettings,
        filters: { categories: [], newOnly: false, minScore: 60 },
      });
      recreatedDatabase.persistRun(recreatedRun, crawl([seed]), 2);
      recreatedDatabase.close();
      pollDashboardRunWatcherForTests();
      expect(getDashboardRunWatcherStateForTests()).toMatchObject({ running: true, hasDatabase: true });
      insertRunning(missingPath);
      complete(missingPath);
      pollDashboardRunWatcherForTests();
      await new Promise<void>((resolve) => setTimeout(resolve, 50));
      expect(builds).toBe(4);
    } finally {
      setFastDashboardIndexBuildHookForTests(null);
      stopDashboardRunWatcherForTests();
      expect(getDashboardRunWatcherStateForTests()).toEqual({ running: false, hasDatabase: false, hasTimer: false, fileIdentity: null });
      rmSync(watcherDirectory, { recursive: true, force: true });
    }
  });

  it("refreshes dynamic scan status from a prewarmed content cache", async () => {
    const database = new DatabaseSync(databasePath);
    try {
      const now = new Date().toISOString();
      database.prepare(`
        INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
        VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)
      `).run({ startedAt: now, heartbeatAt: now });
    } finally {
      database.close();
    }
    try {
      clearFastDashboardCacheForTests();
      await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
      const before = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, before as never, databasePath);
      const beforePayload = JSON.parse(before.body.toString("utf8")) as { version: string; scan: { trigger: string | null } };

      const refresh = response();
      await requestHandler(request("POST", "/api/refresh") as never, refresh as never, databasePath);
      expect(refresh.statusCode).toBe(200);

      const after = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, after as never, databasePath);
      const afterPayload = JSON.parse(after.body.toString("utf8")) as { version: string; scan: { active: boolean; trigger: string | null } };
      expect(after.statusCode).toBe(200);
      expect(afterPayload.version).not.toBe(beforePayload.version);
      expect(afterPayload.scan.active).toBe(true);
      expect(afterPayload.scan.trigger).toBe("existing");
    } finally {
      const cleanup = new DatabaseSync(databasePath);
      cleanup.prepare("UPDATE crawl_runs SET status = 'FAILED', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = (SELECT MAX(id) FROM crawl_runs WHERE status = 'RUNNING')").run({ finishedAt: new Date().toISOString() });
      cleanup.close();
    }
  });

  it("reuses card content when only run progress changes after prewarm", async () => {
    clearFastDashboardCacheForTests();
    await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
    const before = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, before as never, databasePath);
    const beforePayload = JSON.parse(before.body.toString("utf8")) as { version: string };

    const database = new DatabaseSync(databasePath);
    let run: { id: number; pages_visited: number };
    try {
      run = database.prepare("SELECT id, pages_visited FROM crawl_runs ORDER BY id DESC LIMIT 1").get() as { id: number; pages_visited: number };
      database.prepare("UPDATE crawl_runs SET pages_visited = @pagesVisited WHERE id = @id").run({
        pagesVisited: run.pages_visited + 1,
        id: run.id,
      });
    } finally {
      database.close();
    }
    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    try {
      const after = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, after as never, databasePath);
      const afterPayload = JSON.parse(after.body.toString("utf8")) as { version: string };
      expect(after.statusCode).toBe(200);
      expect(afterPayload.version).not.toBe(beforePayload.version);
      expect(builds).toBe(0);
    } finally {
      setFastDashboardIndexBuildHookForTests(null);
      const restore = new DatabaseSync(databasePath);
      restore.prepare("UPDATE crawl_runs SET pages_visited = @pagesVisited WHERE id = @id").run({ pagesVisited: run.pages_visited, id: run.id });
      restore.close();
    }
  });

  it("rebuilds cards for a legacy payload-only role write", async () => {
    clearFastDashboardCacheForTests();
    await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
    const database = new DatabaseSync(databasePath);
    let originalPayload: string;
    try {
      const row = database.prepare("SELECT payload_json FROM internships WHERE id = 'summer-1'").get() as { payload_json: string };
      originalPayload = row.payload_json;
      const payload = JSON.parse(originalPayload) as Record<string, unknown>;
      payload.company = "Legacy Payload Change";
      database.prepare("UPDATE internships SET payload_json = @payload WHERE id = 'summer-1'").run({
        payload: JSON.stringify(payload),
      });
    } finally {
      database.close();
    }

    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    try {
      const changed = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=all&q=legacy%20payload%20change&limit=8") as never, changed as never, databasePath);
      const payload = JSON.parse(changed.body.toString("utf8")) as { items: Array<{ company: string }> };
      expect(changed.statusCode).toBe(200);
      expect(payload.items.map((item) => item.company)).toEqual(["Legacy Payload Change"]);
      expect(builds).toBe(1);
    } finally {
      setFastDashboardIndexBuildHookForTests(null);
      const restore = new DatabaseSync(databasePath);
      restore.prepare("UPDATE internships SET payload_json = @payload WHERE id = 'summer-1'").run({ payload: originalPayload });
      restore.close();
    }
  });

  it("updates board status validators without rebuilding unchanged role content", async () => {
    clearFastDashboardCacheForTests();
    await expect(prewarmFastDashboardIndexForTests(databasePath)).resolves.toBe(true);
    const beforeChanges = response();
    await requestHandler(request("GET", "/api/changes") as never, beforeChanges as never, databasePath);
    const beforeVersion = (JSON.parse(beforeChanges.body.toString("utf8")) as { version: string }).version;
    let builds = 0;
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });
    const originalGetCachedSnapshot = Object.getOwnPropertyDescriptor(GrindJobBoardClient.prototype, "getCachedSnapshot")?.value as (this: GrindJobBoardClient) => ReturnType<GrindJobBoardClient["getCachedSnapshot"]>;
    const boardStatus = vi.spyOn(GrindJobBoardClient.prototype, "getCachedSnapshot").mockImplementation(function(this: GrindJobBoardClient) {
      const snapshot = Reflect.apply(originalGetCachedSnapshot, this, []);
      return {
        ...snapshot,
        status: "ready",
        lastAttemptAt: new Date().toISOString(),
        failures: [],
      };
    });
    try {
      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      const changesPayload = JSON.parse(changes.body.toString("utf8")) as { version: string };
      expect(changesPayload.version).not.toBe(beforeVersion);

      const roles = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, roles as never, databasePath);
      expect(roles.statusCode).toBe(200);
      expect(builds).toBe(0);
    } finally {
      boardStatus.mockRestore();
      setFastDashboardIndexBuildHookForTests(null);
    }
  });

  it("retries when a database commit lands between version and list reads", async () => {
    let hookCalls = 0;
    setFastSnapshotReadHookForTests(() => {
      hookCalls += 1;
      const mutation = new DatabaseSync(databasePath);
      try {
        const row = mutation.prepare("SELECT payload_json FROM internships WHERE id = 'summer-1'").get() as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        payload.company = "AAAA SNAPSHOT RACE";
        mutation.prepare(`
          UPDATE internships
          SET company = @company, normalized_company = @normalizedCompany,
              payload_json = @payload, content_hash = @contentHash
          WHERE id = 'summer-1'
        `).run({
          company: "AAAA SNAPSHOT RACE",
          normalizedCompany: "aaaa snapshot race",
          payload: JSON.stringify(payload),
          contentHash: "race-snapshot-v2",
        });
      } finally {
        mutation.close();
      }
    });
    try {
      const captured = response();
      await requestHandler(
        request("GET", "/api/roles?tab=summer&status=open&q=aaaa%20snapshot%20race&limit=8") as never,
        captured as never,
        databasePath,
      );
      const payload = JSON.parse(captured.body.toString("utf8")) as { version: string; items: Array<{ company: string }> };
      expect(captured.statusCode).toBe(200);
      expect(hookCalls).toBe(1);
      expect(payload.items.map((item) => item.company)).toEqual(["AAAA SNAPSHOT RACE"]);

      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      const changesPayload = JSON.parse(changes.body.toString("utf8")) as { version: string };
      expect(changesPayload.version).toBe(payload.version);
    } finally {
      setFastSnapshotReadHookForTests(null);
    }
  });

  it("keeps list, detail, and changes validators coherent across run-progress commits", async () => {
    const database = new DatabaseSync(databasePath);
    const run = database.prepare(`
      SELECT id, pages_visited, heartbeat_at, error_message, status, finished_at
      FROM crawl_runs ORDER BY id DESC LIMIT 1
    `).get() as {
      id: number;
      pages_visited: number;
      heartbeat_at: string | null;
      error_message: string | null;
      status: string;
      finished_at: string | null;
    };
    database.close();

    const mutations: Array<{ column: "pages_visited" | "heartbeat_at" | "error_message" | "status" | "finished_at"; value: number | string | null }> = [
      { column: "pages_visited", value: run.pages_visited + 1 },
      { column: "heartbeat_at", value: new Date(Date.now() + 1_000).toISOString() },
      { column: "error_message", value: "run-progress race warning" },
      { column: "status", value: "FAILED" },
      { column: "finished_at", value: new Date(Date.now() + 2_000).toISOString() },
    ];

    const mutateRun = (column: string, value: number | string | null): void => {
      const mutation = new DatabaseSync(databasePath);
      try {
        mutation.prepare(`UPDATE crawl_runs SET ${column} = @value WHERE id = @id`).run({ value, id: run.id });
      } finally {
        mutation.close();
      }
    };

    try {
      for (const mutation of mutations) {
        let hookCalls = 0;
        setFastRunRevisionCaptureHookForTests(() => {
          hookCalls += 1;
          mutateRun(mutation.column, mutation.value);
        });
        const list = response();
        await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=8") as never, list as never, databasePath);
        expect(list.statusCode, `list ${mutation.column}`).toBe(200);
        expect(hookCalls, `list hook ${mutation.column}`).toBe(1);
        const listPayload = JSON.parse(list.body.toString("utf8")) as { version: string };

        const listChanges = response();
        await requestHandler(request("GET", "/api/changes") as never, listChanges as never, databasePath);
        const listChangesPayload = JSON.parse(listChanges.body.toString("utf8")) as { version: string; latestRun: Record<string, unknown> | null };
        expect(listChanges.statusCode, `list changes ${mutation.column}`).toBe(200);
        expect(listChangesPayload.version, `list version ${mutation.column}`).toBe(listPayload.version);
        expect(listChangesPayload.latestRun?.[mutation.column], `list run field ${mutation.column}`).toBe(mutation.value);

        hookCalls = 0;
        setFastRunRevisionCaptureHookForTests(() => {
          hookCalls += 1;
          mutateRun(mutation.column, mutation.value);
        });
        const detail = response();
        await requestHandler(request("GET", "/api/roles/internship/summer-2") as never, detail as never, databasePath);
        expect(detail.statusCode, `detail ${mutation.column}`).toBe(200);
        expect(hookCalls, `detail hook ${mutation.column}`).toBe(1);
        const detailEtag = detail.headers.ETag;
        if (!detailEtag) throw new Error(`Expected detail ETag for ${mutation.column}`);
        const stableDetail = response();
        await requestHandler(request("GET", "/api/roles/internship/summer-2", { "if-none-match": detailEtag }) as never, stableDetail as never, databasePath);
        expect(stableDetail.statusCode, `detail revalidation ${mutation.column}`).toBe(304);

        hookCalls = 0;
        setFastRunRevisionCaptureHookForTests(() => {
          hookCalls += 1;
          mutateRun(mutation.column, mutation.value);
        });
        const changes = response();
        await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
        expect(changes.statusCode, `changes ${mutation.column}`).toBe(200);
        expect(hookCalls, `changes hook ${mutation.column}`).toBe(1);
        const changesPayload = JSON.parse(changes.body.toString("utf8")) as { latestRun: Record<string, unknown> | null };
        expect(changesPayload.latestRun?.[mutation.column], `changes run field ${mutation.column}`).toBe(mutation.value);
        const changesEtag = changes.headers.ETag;
        if (!changesEtag) throw new Error(`Expected changes ETag for ${mutation.column}`);
        const stableChanges = response();
        await requestHandler(request("GET", "/api/changes", { "if-none-match": changesEtag }) as never, stableChanges as never, databasePath);
        expect(stableChanges.statusCode, `changes revalidation ${mutation.column}`).toBe(304);
      }
    } finally {
      setFastRunRevisionCaptureHookForTests(null);
      mutateRun("pages_visited", run.pages_visited);
      mutateRun("heartbeat_at", run.heartbeat_at);
      mutateRun("error_message", run.error_message);
      mutateRun("status", run.status);
      mutateRun("finished_at", run.finished_at);
    }
  });

  it("matches legacy updated semantics: open, eligible, and not new", async () => {
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-updated-"));
    const fixturePath = join(fixtureDirectory, "updated.db");
    const settings = resolveSettings({ databasePath: fixturePath, outputDirectory: join(fixtureDirectory, "output") });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(fixturePath);
    try {
      const roles = [
        makeInternship({ id: "updated-open", jobId: "UPDATED-OPEN", company: "Updated Open", applicationUrl: "https://boards.greenhouse.io/updated-open/apply", postingUrl: "https://boards.greenhouse.io/updated-open" }),
        makeInternship({ id: "updated-new", jobId: "UPDATED-NEW", company: "Updated New", applicationUrl: "https://boards.greenhouse.io/updated-new/apply", postingUrl: "https://boards.greenhouse.io/updated-new" }),
        makeInternship({ id: "updated-closed", jobId: "UPDATED-CLOSED", company: "Updated Closed", applicationUrl: "https://boards.greenhouse.io/updated-closed/apply", postingUrl: "https://boards.greenhouse.io/updated-closed" }),
        makeInternship({ id: "new-closed", jobId: "NEW-CLOSED", company: "New Closed", applicationUrl: "https://boards.greenhouse.io/new-closed/apply", postingUrl: "https://boards.greenhouse.io/new-closed" }),
      ];
      const runId = database.startRun(options);
      database.persistRun(runId, crawl(roles), 2);
      database.close();
      const mutation = new DatabaseSync(fixturePath);
      try {
        mutation.exec("BEGIN IMMEDIATE");
        mutation.prepare("UPDATE internships SET lifecycle_status = 'UPDATED' WHERE id IN ('updated-open', 'updated-new', 'updated-closed', 'new-closed')").run();
        mutation.prepare("UPDATE internships SET availability_status = 'closed' WHERE id IN ('updated-closed', 'new-closed')").run();
        mutation.prepare("UPDATE run_internships SET lifecycle_status = 'UPDATED' WHERE internship_id IN ('updated-open', 'updated-closed')").run();
        mutation.exec("COMMIT");
      } catch (error) {
        try { mutation.exec("ROLLBACK"); } catch { /* preserve the mutation error */ }
        throw error;
      } finally {
        mutation.close();
      }

      const captured = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=updated&limit=100") as never, captured as never, fixturePath);
      const payload = JSON.parse(captured.body.toString("utf8")) as { pagination: { total: number }; items: Array<{ id: string }> };
      expect(captured.statusCode).toBe(200);
      expect(payload.pagination.total).toBe(1);
      expect(payload.items.map((item) => item.id)).toEqual(["updated-open"]);

      const newCaptured = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&status=new&limit=100") as never, newCaptured as never, fixturePath);
      const newPayload = JSON.parse(newCaptured.body.toString("utf8")) as { pagination: { total: number }; items: Array<{ id: string }> };
      expect(newCaptured.statusCode).toBe(200);
      expect(newPayload.pagination.total).toBe(1);
      expect(newPayload.items.map((item) => item.id)).toEqual(["updated-new"]);
    } finally {
      try { database.close(); } catch { /* already closed after persistence */ }
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });

  it("rejects zero/out-of-range limits and reports terminal pagination", async () => {
    for (const limit of ["0", "-1", "101", "abc"]) {
      const captured = response();
      await requestHandler(request("GET", `/api/roles?limit=${limit}`) as never, captured as never, databasePath);
      expect(captured.statusCode, `limit=${limit}`).toBe(400);
    }
    const invalidOffset = response();
    await requestHandler(request("GET", "/api/roles?offset=-1") as never, invalidOffset as never, databasePath);
    expect(invalidOffset.statusCode).toBe(400);

    const terminal = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=1&offset=999") as never, terminal as never, databasePath);
    const payload = JSON.parse(terminal.body.toString("utf8")) as { pagination: { hasMore: boolean; nextOffset: number | null }; items: unknown[] };
    expect(terminal.statusCode).toBe(200);
    expect(payload.items).toHaveLength(0);
    expect(payload.pagination.hasMore).toBe(false);
    expect(payload.pagination.nextOffset).toBeNull();
  });

  it("keeps canonical relative, prefixed, and date-only posting sort semantics", async () => {
    const base = Date.parse("2026-08-17T12:00:00.000Z");
    expect(parseDashboardSortDate("yesterday", base)).toBe(base - 86_400_000);
    expect(parseDashboardSortDate("2 days ago", base)).toBe(base - 2 * 86_400_000);
    expect(parseDashboardSortDate("1mo", base)).toBe(base - 2_592_000_000);
    expect(parseDashboardSortDate("Posted 2026-08-17", base)).toBe(new Date(2026, 7, 17).valueOf());

    const database = new DatabaseSync(databasePath);
    try {
      const postingDates: Record<string, string> = {
        "summer-1": "yesterday",
        "summer-2": "2 days ago",
      };
      for (const [id, postingDate] of Object.entries(postingDates)) {
        const row = database.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id }) as { payload_json: string };
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        payload.postingDate = postingDate;
        database.prepare("UPDATE internships SET payload_json = @payload, content_hash = @hash WHERE id = @id").run({
          id,
          payload: JSON.stringify(payload),
          hash: `sort-${id}-${postingDate}`,
        });
      }
    } finally {
      database.close();
    }
    const captured = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=open&sort=posted&limit=100") as never, captured as never, databasePath);
    const payload = JSON.parse(captured.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(captured.statusCode).toBe(200);
    expect(payload.items.map((item) => item.id)).toEqual(["summer-1", "summer-2"]);
  });

  it("hides postings older than the two-calendar-month cutoff", async () => {
    const database = new DatabaseSync(databasePath);
    const row = database.prepare("SELECT payload_json, content_hash FROM internships WHERE id = @id").get({ id: "summer-2" }) as { payload_json: string; content_hash: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.postingDate = "2026-01-01";
    database.prepare("UPDATE internships SET payload_json = @payload, content_hash = @hash WHERE id = @id").run({
      id: "summer-2",
      payload: JSON.stringify(payload),
      hash: "old-posting-test",
    });
    database.close();

    try {
      const listResponse = response();
      await requestHandler(
        request("GET", "/api/roles?tab=main&status=open&sort=posted&limit=100") as never,
        listResponse as never,
        databasePath,
      );
      const listPayload = JSON.parse(listResponse.body.toString("utf8")) as { items: Array<{ id: string }> };
      expect(listResponse.statusCode).toBe(200);
      const oldCard = listPayload.items.find((item) => item.id === "summer-2");
      expect(oldCard).toBeUndefined();

      const detailResponse = response();
      await requestHandler(
        request("GET", "/api/roles/internship/summer-2") as never,
        detailResponse as never,
        databasePath,
      );
      expect(detailResponse.statusCode).toBe(200);
    } finally {
      const restore = new DatabaseSync(databasePath);
      restore.prepare("UPDATE internships SET payload_json = @payload, content_hash = @hash WHERE id = @id").run({
        id: "summer-2",
        payload: row.payload_json,
        hash: row.content_hash,
      });
      restore.close();
    }
  });

  it("preserves tab/search/sort behavior and serves details separately", async () => {
    const listResponse = response();
    await requestHandler(
      request("GET", "/api/roles?tab=main&status=open&sort=company&q=beta&limit=10") as never,
      listResponse as never,
      databasePath,
    );
    const listPayload = JSON.parse(listResponse.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(listPayload.items.map((item) => item.id)).toEqual(["summer-2"]);

    const detailResponse = response();
    await requestHandler(
      request("GET", "/api/roles/internship/summer-1") as never,
      detailResponse as never,
      databasePath,
    );
    const detailPayload = JSON.parse(detailResponse.body.toString("utf8")) as { contract: string; role: Record<string, unknown> };
    expect(detailResponse.statusCode).toBe(200);
    expect(detailPayload.contract).toBe("dashboard.role.v1");
    expect(detailPayload.role).toHaveProperty("description");
    expect(detailPayload.role).toHaveProperty("requiredQualifications");

    const encodedDetail = response();
    await requestHandler(
      request("GET", "/api/roles/%69nternship/summer%2D1") as never,
      encodedDetail as never,
      databasePath,
    );
    expect(encodedDetail.statusCode).toBe(200);

    const malformedRoute = response();
    await requestHandler(request("GET", "/api/roles/%ZZ/summer-1") as never, malformedRoute as never, databasePath);
    expect(malformedRoute.statusCode).toBe(400);
  });

  it("looks up detail payloads without parsing unrelated role rows", async () => {
    const database = new DatabaseSync(databasePath);
    let originalPayload: string;
    try {
      // A full-index implementation would parse this malformed unrelated
      // row and either discard the snapshot or pay the cost for every row.
      // The target detail projection remains independently readable.
      const original = database.prepare("SELECT payload_json FROM internships WHERE id = 'summer-1'").get() as { payload_json: string };
      originalPayload = original.payload_json;
      database.prepare("UPDATE internships SET payload_json = 'not-json' WHERE id = 'summer-1'").run();
    } finally {
      database.close();
    }
    const captured = response();
    await requestHandler(request("GET", "/api/roles/internship/summer-2") as never, captured as never, databasePath);
    const payload = JSON.parse(captured.body.toString("utf8")) as { role: { id: string; description?: string } };
    expect(captured.statusCode).toBe(200);
    expect(payload.role.id).toBe("summer-2");
    expect(payload.role.description).toBeTruthy();
    const restore = new DatabaseSync(databasePath);
    try {
      restore.prepare("UPDATE internships SET payload_json = @payload WHERE id = 'summer-1'").run({ payload: originalPayload });
    } finally {
      restore.close();
    }
  });

  it("compresses a compact response when the client advertises gzip", async () => {
    const captured = response();
    await requestHandler(
      request("GET", "/api/roles?tab=main&status=all&limit=100", { "accept-encoding": "gzip" }) as never,
      captured as never,
      databasePath,
    );
    expect(captured.statusCode).toBe(200);
    expect(captured.headers["Content-Encoding"]).toBe("gzip");
    expect(captured.headers.Vary).toBe("Accept-Encoding");
    expect(captured.headers["Content-Length"]).toBe(String(captured.body.byteLength));
    expect(JSON.parse(gunzipSync(captured.body).toString("utf8"))).toHaveProperty("items");
  });

  it("negotiates wildcard/q encodings and supports HEAD with representation length", async () => {
    const identity = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=100") as never, identity as never, databasePath);
    expect(identity.statusCode).toBe(200);
    expect(identity.headers["Content-Encoding"]).toBeUndefined();
    const repeatIdentity = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=100") as never, repeatIdentity as never, databasePath);
    expect(repeatIdentity.headers.ETag).toBe(identity.headers.ETag);

    const head = response();
    await requestHandler(request("HEAD", "/api/roles?tab=main&status=all&limit=100") as never, head as never, databasePath);
    expect(head.statusCode).toBe(200);
    expect(head.body).toHaveLength(0);
    expect(head.headers["Content-Length"]).toBe(String(identity.body.byteLength));
    expect(head.headers.Vary).toBe("Accept-Encoding");

    const wildcard = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=100", {
      "accept-encoding": "gzip;q=0, *;q=0.8",
    }) as never, wildcard as never, databasePath);
    expect(wildcard.statusCode).toBe(200);
    expect(wildcard.headers["Content-Encoding"]).toBe("br");
    expect(wildcard.headers["Content-Length"]).toBe(String(wildcard.body.byteLength));

    const preferredGzip = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=100", {
      "accept-encoding": "br;q=0.2, gzip;q=0.9",
    }) as never, preferredGzip as never, databasePath);
    expect(preferredGzip.headers["Content-Encoding"]).toBe("gzip");
  });

  it("supports lightweight ETag polling and minimal action mutations", async () => {
    const changesResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, changesResponse as never, databasePath);
    const etag = changesResponse.headers.ETag;
    expect(etag).toBeTruthy();
    if (!etag) throw new Error("Expected an ETag");
    expect(etag.startsWith("W/"), "dashboard validators are semantic weak ETags").toBe(true);
    const changesPayload = JSON.parse(changesResponse.body.toString("utf8")) as {
      latestRun: { id: number } | null;
      runs: Array<{ id: number; started_at: string; finished_at: string | null; status: string; internships_discovered: number }>;
      sources: Array<{ url: string; isConfigured: boolean }>;
      sourceResults: Array<{ url: string }>;
    };
    expect(Array.isArray(changesPayload.runs)).toBe(true);
    expect(changesPayload.runs.length).toBeGreaterThan(0);
    expect(changesPayload.runs.length).toBeLessThanOrEqual(5);
    expect(changesPayload.runs[0]?.id).toBe(changesPayload.latestRun?.id);
    expect(changesPayload.sources.some((source) => source.isConfigured)).toBe(true);
    expect(Array.isArray(changesPayload.sourceResults)).toBe(true);
    // Live source health is compact (no role cards, no coverage notes), but it
    // includes every configured URL so the Provenance panel can render rows.
    expect(changesResponse.body.byteLength).toBeLessThan(24_000);

    const unchangedResponse = response();
    await requestHandler(request("GET", "/api/changes", { "if-none-match": etag }) as never, unchangedResponse as never, databasePath);
    expect(unchangedResponse.statusCode).toBe(304);
    expect(unchangedResponse.body).toHaveLength(0);
    expect(unchangedResponse.headers["Content-Length"]).toBeUndefined();
    expect(unchangedResponse.headers.Vary).toBe("Accept-Encoding");

    const listMatchResponse = response();
    await requestHandler(request("GET", "/api/changes", {
      "if-none-match": `"not-current", ${etag}`,
    }) as never, listMatchResponse as never, databasePath);
    expect(listMatchResponse.statusCode).toBe(304);

    const database = new DatabaseSync(databasePath);
    try {
      database.prepare("UPDATE crawl_runs SET pages_visited = pages_visited + 1 WHERE id = (SELECT MAX(id) FROM crawl_runs)").run();
    } finally {
      database.close();
    }
    const progressChanged = response();
    await requestHandler(request("GET", "/api/changes", { "if-none-match": etag }) as never, progressChanged as never, databasePath);
    expect(progressChanged.statusCode).toBe(200);
    expect(progressChanged.headers.ETag).not.toBe(etag);

    const staleDatabase = new DatabaseSync(databasePath);
    const staleTime = new Date(Date.now() - 21 * 60 * 1_000).toISOString();
    try {
      staleDatabase.prepare(`
        INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
        VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)
      `).run({ startedAt: staleTime, heartbeatAt: staleTime });
    } finally {
      staleDatabase.close();
    }
    const stale = response();
    await requestHandler(request("GET", "/api/changes") as never, stale as never, databasePath);
    const stalePayload = JSON.parse(stale.body.toString("utf8")) as { scan: { active: boolean } };
    expect(stalePayload.scan.active).toBe(false);

    const freshDatabase = new DatabaseSync(databasePath);
    try {
      freshDatabase.prepare("UPDATE crawl_runs SET heartbeat_at = @heartbeatAt WHERE id = (SELECT MAX(id) FROM crawl_runs)").run({ heartbeatAt: new Date().toISOString() });
    } finally {
      freshDatabase.close();
    }
    const fresh = response();
    const staleEtag = stale.headers.ETag;
    if (!staleEtag) throw new Error("Expected stale changes ETag");
    await requestHandler(request("GET", "/api/changes", { "if-none-match": staleEtag }) as never, fresh as never, databasePath);
    const freshPayload = JSON.parse(fresh.body.toString("utf8")) as { scan: { active: boolean } };
    expect(freshPayload.scan.active).toBe(true);
    expect(fresh.headers.ETag).not.toBe(stale.headers.ETag);
    const liveSourceDatabase = new DatabaseSync(databasePath);
    const liveSourceUrl = "https://jobs.example.test/live-source";
    try {
      const run = liveSourceDatabase.prepare("SELECT MAX(id) AS id FROM crawl_runs").get() as { id: number };
      liveSourceDatabase.prepare(`
        INSERT INTO sources (url, created_at) VALUES (@url, @createdAt)
        ON CONFLICT(url) DO NOTHING
      `).run({ url: liveSourceUrl, createdAt: new Date().toISOString() });
      const source = liveSourceDatabase.prepare("SELECT id FROM sources WHERE url = @url").get({ url: liveSourceUrl }) as { id: number };
      liveSourceDatabase.prepare(`
        INSERT INTO source_run_results (
          run_id, source_id, settled, completed, pages_visited, potential_postings_inspected,
          jobs_discovered, failure_count, started_at, status
        ) VALUES (
          @runId, @sourceId, 0, 0, 0, 0, 0, 0, @startedAt, 'source_unavailable'
        )
      `).run({ runId: run.id, sourceId: source.id, startedAt: new Date().toISOString() });
    } finally {
      liveSourceDatabase.close();
    }
    const liveSources = response();
    await requestHandler(request("GET", "/api/changes") as never, liveSources as never, databasePath);
    const livePayload = JSON.parse(liveSources.body.toString("utf8")) as {
      scan: { currentSources: Array<{ url: string }> };
      sourceResults: Array<{ url: string; settled: number }>;
      sources: Array<{ url: string }>;
    };
    expect(livePayload.scan.currentSources.map((source) => source.url)).toContain(liveSourceUrl);
    expect(livePayload.sourceResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ url: liveSourceUrl, settled: 0 }),
    ]));
    expect(livePayload.sources.map((source) => source.url)).toContain(liveSourceUrl);
    const freshEtag = fresh.headers.ETag;
    if (!freshEtag) throw new Error("Expected fresh changes ETag");
    const errorMutation = new DatabaseSync(databasePath);
    try {
      errorMutation.prepare("UPDATE crawl_runs SET error_message = 'progress warning' WHERE id = (SELECT MAX(id) FROM crawl_runs)").run();
    } finally {
      errorMutation.close();
    }
    const errorChanged = response();
    await requestHandler(request("GET", "/api/changes", { "if-none-match": freshEtag }) as never, errorChanged as never, databasePath);
    expect(errorChanged.statusCode).toBe(200);
    expect(errorChanged.headers.ETag).not.toBe(freshEtag);
    const finishedEtag = errorChanged.headers.ETag;
    if (!finishedEtag) throw new Error("Expected error mutation ETag");
    const finishedMutation = new DatabaseSync(databasePath);
    try {
      finishedMutation.prepare("UPDATE crawl_runs SET finished_at = @finishedAt WHERE id = (SELECT MAX(id) FROM crawl_runs)").run({ finishedAt: new Date().toISOString() });
    } finally {
      finishedMutation.close();
    }
    const finishedChanged = response();
    await requestHandler(request("GET", "/api/changes", { "if-none-match": finishedEtag }) as never, finishedChanged as never, databasePath);
    expect(finishedChanged.statusCode).toBe(200);
    expect(finishedChanged.headers.ETag).not.toBe(finishedEtag);

    const concurrent = await Promise.all(Array.from({ length: 8 }, async () => {
      const captured = response();
      await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=8") as never, captured as never, databasePath);
      return { status: captured.statusCode, payload: JSON.parse(captured.body.toString("utf8")) as { version: string; items?: unknown[] } };
    }));
    expect(concurrent.every(({ status }) => status === 200)).toBe(true);
    expect(new Set(concurrent.map(({ payload }) => payload.version)).size).toBe(1);
    expect(concurrent.every(({ payload }) => (payload.items?.length ?? 0) <= 8)).toBe(true);

    const actionResponse = response();
    await requestHandler(request("POST", "/api/actions", {}, {
      listingType: "internship",
      listingId: "summer-1",
      action: "cant_fit",
      company: "Acme Labs",
      title: "Software Engineering Intern",
    }) as never, actionResponse as never, databasePath);
    const actionPayload = JSON.parse(actionResponse.body.toString("utf8")) as Record<string, unknown>;
    expect(actionResponse.statusCode).toBe(200);
    expect(actionPayload).not.toHaveProperty("internships");
    expect(actionPayload).toHaveProperty("listingAction");

    const hiddenRoles = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=8") as never, hiddenRoles as never, databasePath);
    const hiddenPayload = JSON.parse(hiddenRoles.body.toString("utf8")) as {
      appliedRoleCount: number;
      stats: { hidden: number };
      items: Array<{ id?: string; listingId?: string }>;
    };
    expect(hiddenPayload.appliedRoleCount).toBe(0);
    expect(hiddenPayload.stats.hidden).toBe(1);
    expect(hiddenPayload.items.some((item) => (item.listingId ?? item.id) === "summer-1")).toBe(false);

    const hiddenFromMain = response();
    await requestHandler(request("GET", "/api/roles?tab=main&status=all&limit=100") as never, hiddenFromMain as never, databasePath);
    const hiddenFromMainPayload = JSON.parse(hiddenFromMain.body.toString("utf8")) as {
      items: Array<{ id?: string; listingId?: string }>;
    };
    expect(hiddenFromMainPayload.items.some((item) => (item.listingId ?? item.id) === "summer-1")).toBe(false);

    const hiddenDetail = response();
    await requestHandler(request("GET", "/api/roles/internship/summer-1") as never, hiddenDetail as never, databasePath);
    expect(hiddenDetail.statusCode).toBe(404);

    const hiddenLegacy = response();
    await requestHandler(request("GET", "/api/data") as never, hiddenLegacy as never, databasePath);
    const hiddenLegacyPayload = JSON.parse(hiddenLegacy.body.toString("utf8")) as {
      internships: Array<{ id?: string; listingId?: string }>;
    };
    expect(hiddenLegacyPayload.internships.some((item) => (item.listingId ?? item.id) === "summer-1")).toBe(false);

    const appliedAction = response();
    await requestHandler(request("POST", "/api/actions", {}, {
      listingType: "internship",
      listingId: "summer-2",
      action: "applied",
      company: "Beta Labs",
      title: "Software Engineering Intern",
    }) as never, appliedAction as never, databasePath);
    const appliedPayload = JSON.parse(appliedAction.body.toString("utf8")) as { appliedRoleCount: number };
    expect(appliedPayload.appliedRoleCount).toBe(1);

    const appliedChanges = response();
    await requestHandler(request("GET", "/api/changes") as never, appliedChanges as never, databasePath);
    const appliedChangesPayload = JSON.parse(appliedChanges.body.toString("utf8")) as { appliedRoleCount: number };
    expect(appliedChangesPayload.appliedRoleCount).toBe(1);

    const undoApplied = response();
    await requestHandler(request("DELETE", "/api/actions?listingType=internship&listingId=summer-2") as never, undoApplied as never, databasePath);
    const undoPayload = JSON.parse(undoApplied.body.toString("utf8")) as { appliedRoleCount: number };
    expect(undoPayload.appliedRoleCount).toBe(0);

    const changedResponse = response();
    await requestHandler(request("GET", "/api/changes", { "if-none-match": etag }) as never, changedResponse as never, databasePath);
    const changedPayload = JSON.parse(changedResponse.body.toString("utf8")) as { appliedRoleCount: number };
    expect(changedResponse.statusCode).toBe(200);
    expect(changedPayload.appliedRoleCount).toBe(0);
    expect(changedResponse.headers.ETag).not.toBe(etag);
  });

  it("keeps a handled role hidden when a source copy has a new listing id", async () => {
    const aliasDatabasePath = join(directory, "source-copy.db");
    const sourceUrl = "https://alias.example/careers";
    const copiedRole = makeInternship({
      id: "source-copy",
      company: "Alias Labs",
      applicationUrl: "https://careers.alias.example/jobs/software-engineering-intern",
      postingUrl: "https://careers.alias.example/jobs/software-engineering-intern",
      jobId: null,
      sourceUrl,
      sources: [sourceUrl],
    });
    const settings = resolveSettings({ databasePath: aliasDatabasePath, outputDirectory: join(directory, "output") });
    const options: ScoutRunOptions = {
      sources: [sourceUrl],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(aliasDatabasePath);
    const runId = database.startRun(options);
    database.persistRun(runId, crawl([copiedRole], sourceUrl), 2);
    database.close();

    const action = response();
    await requestHandler(request("POST", "/api/actions", {}, {
      listingType: "grind",
      listingId: "handled-board-copy",
      action: "cant_fit",
      company: copiedRole.company,
      title: copiedRole.title,
      applicationUrl: "https://boards.greenhouse.io/alias/jobs/777/apply",
      postingUrl: "https://boards.greenhouse.io/alias/jobs/777",
      jobId: "REQ-777",
      location: copiedRole.location.join(" · "),
    }) as never, action as never, aliasDatabasePath);
    expect(action.statusCode).toBe(200);

    // Leave one unrelated persisted identity so the detail path must rebuild
    // the action row instead of treating an empty projection as the only
    // migration signal.
    const projection = new DatabaseSync(aliasDatabasePath);
    projection.prepare("DELETE FROM listing_action_identities WHERE listing_key = @listingKey").run({ listingKey: "grind:handled-board-copy" });
    projection.prepare(`
      INSERT INTO listing_action_identities (listing_key, identity_key, direct_job_ids_json)
      VALUES ('grind:unrelated', 'listing:grind:unrelated', '[]')
    `).run();
    projection.close();

    try {
      const roles = response();
      await requestHandler(request("GET", "/api/roles?tab=main&status=open&limit=100") as never, roles as never, aliasDatabasePath);
      const rolesPayload = JSON.parse(roles.body.toString("utf8")) as { items: Array<{ listingId?: string; id?: string }> };
      expect(rolesPayload.items.some((item) => (item.listingId ?? item.id) === "source-copy")).toBe(false);

      const detail = response();
      await requestHandler(request("GET", "/api/roles/internship/source-copy") as never, detail as never, aliasDatabasePath);
      expect(detail.statusCode).toBe(404);

      const legacy = response();
      await requestHandler(request("GET", "/api/data") as never, legacy as never, aliasDatabasePath);
      const legacyPayload = JSON.parse(legacy.body.toString("utf8")) as {
        internships: Array<{ listingId?: string; id?: string }>;
      };
      expect(legacyPayload.internships.some((item) => (item.listingId ?? item.id) === "source-copy")).toBe(false);
    } finally {
      clearFastDashboardCacheForTests();
      clearDashboardDataCacheForTests();
    }
  });

  it("changes the polling validator at local midnight for relative-date semantics", async () => {
    const beforeMidnight = new Date(2026, 7, 17, 23, 59, 59, 0);
    const afterMidnight = new Date(2026, 7, 18, 0, 0, 1, 0);
    expect(dashboardLocalDayKey(beforeMidnight.valueOf())).not.toBe(dashboardLocalDayKey(afterMidnight.valueOf()));
    vi.useFakeTimers();
    try {
      vi.setSystemTime(beforeMidnight);
      const before = response();
      await requestHandler(request("GET", "/api/changes") as never, before as never, databasePath);
      vi.setSystemTime(afterMidnight);
      const after = response();
      await requestHandler(request("GET", "/api/changes") as never, after as never, databasePath);
      expect(before.headers.ETag).toBeTruthy();
      expect(after.headers.ETag).not.toBe(before.headers.ETag);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps cancellation state coherent across changes, refresh, and scan routes", async () => {
    const cleanupRuns = (): void => {
      const database = new DatabaseSync(databasePath);
      try {
        database.prepare("UPDATE crawl_runs SET status = 'FAILED', finished_at = @finishedAt, heartbeat_at = NULL, cancel_requested_at = NULL WHERE status = 'RUNNING'").run({ finishedAt: new Date().toISOString() });
      } finally {
        database.close();
      }
    };
    const insertRunning = (timestamp: string): number => {
      const database = new DatabaseSync(databasePath);
      try {
        const result = database.prepare(`
          INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
          VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)
        `).run({ startedAt: timestamp, heartbeatAt: timestamp });
        return Number(result.lastInsertRowid);
      } finally {
        database.close();
      }
    };
    const readScan = (captured: CapturedResponse): { active: boolean; terminationRequested: boolean; runId: number | null } => {
      const payload = JSON.parse(captured.body.toString("utf8")) as { scan?: { active: boolean; terminationRequested: boolean; runId: number | null }; status?: { active: boolean; terminationRequested: boolean; runId: number | null } };
      return payload.scan ?? payload.status ?? (() => { throw new Error("Expected scan state"); })();
    };

    cleanupRuns();
    const freshRunId = insertRunning(new Date().toISOString());
    try {
      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      const refresh = response();
      await requestHandler(request("POST", "/api/refresh") as never, refresh as never, databasePath);
      const scan = response();
      await requestHandler(request("POST", "/api/scan") as never, scan as never, databasePath);
      for (const captured of [changes, refresh, scan]) {
        expect(captured.statusCode).toBe(200);
        expect(readScan(captured)).toMatchObject({ active: true, terminationRequested: false, runId: freshRunId });
      }

      const cancel = new DatabaseSync(databasePath);
      try {
        cancel.prepare("UPDATE crawl_runs SET cancel_requested_at = @requestedAt WHERE id = @runId").run({ requestedAt: new Date().toISOString(), runId: freshRunId });
      } finally {
        cancel.close();
      }
      const requestedChanges = response();
      await requestHandler(request("GET", "/api/changes") as never, requestedChanges as never, databasePath);
      expect(requestedChanges.statusCode).toBe(200);
      expect(readScan(requestedChanges)).toMatchObject({ active: true, terminationRequested: true, runId: freshRunId });

      const stale = new DatabaseSync(databasePath);
      try {
        stale.prepare("UPDATE crawl_runs SET heartbeat_at = @staleAt, cancel_requested_at = NULL WHERE id = @runId").run({
          staleAt: new Date(Date.now() - 21 * 60 * 1_000).toISOString(),
          runId: freshRunId,
        });
      } finally {
        stale.close();
      }
      const staleChanges = response();
      await requestHandler(request("GET", "/api/changes") as never, staleChanges as never, databasePath);
      expect(staleChanges.statusCode).toBe(200);
      expect(readScan(staleChanges)).toMatchObject({ active: false, terminationRequested: false });

      let starts = 0;
      setDashboardScoutRunnerForTests(() => {
        starts += 1;
        return Promise.resolve({ persisted: { runId: 20_000 + starts } } as never);
      });
      const staleRefresh = response();
      await requestHandler(request("POST", "/api/refresh") as never, staleRefresh as never, databasePath);
      expect(staleRefresh.statusCode).toBe(202);
      expect((JSON.parse(staleRefresh.body.toString("utf8")) as { started: boolean }).started).toBe(true);
      expect(readScan(staleRefresh)).toMatchObject({ active: true, terminationRequested: false });
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      resetDashboardScanStateForTests();
      cleanupRuns();

      const newScan = response();
      await requestHandler(request("POST", "/api/scan") as never, newScan as never, databasePath);
      expect(newScan.statusCode).toBe(202);
      expect((JSON.parse(newScan.body.toString("utf8")) as { started: boolean }).started).toBe(true);
      expect(readScan(newScan)).toMatchObject({ active: true, terminationRequested: false });
      expect(starts).toBe(2);
    } finally {
      setDashboardScoutRunnerForTests(null);
      resetDashboardScanStateForTests();
      cleanupRuns();
    }
  });

  it("does not force a second live-board refresh when a scan is already running", async () => {
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
        VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 1)
      `).run({ startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() });
    } finally {
      database.close();
    }
    const previousSkip = process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    const boardRefresh = vi.spyOn(GrindJobBoardClient.prototype, "getSnapshot");
    try {
      const captured = response();
      await requestHandler(request("POST", "/api/refresh") as never, captured as never, databasePath);
      expect(captured.statusCode).toBe(200);
      expect(boardRefresh).not.toHaveBeenCalled();
    } finally {
      boardRefresh.mockRestore();
      if (previousSkip === undefined) delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
      else process.env.DASHBOARD_SKIP_LIVE_BOARD = previousSkip;
      const cleanup = new DatabaseSync(databasePath);
      cleanup.prepare("UPDATE crawl_runs SET status = 'FAILED', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = (SELECT MAX(id) FROM crawl_runs WHERE status = 'RUNNING')").run({
        finishedAt: new Date().toISOString(),
      });
      cleanup.close();
    }
  });

  it("separates request validation errors from unavailable database errors", async () => {
    const invalidAction = response();
    await requestHandler(request("POST", "/api/actions", {}, "not-json") as never, invalidAction as never, databasePath);
    expect(invalidAction.statusCode).toBe(400);

    const offlineGrindAction = response();
    await requestHandler(request("POST", "/api/actions", {}, {
      listingType: "grind",
      listingId: "offline-board-job",
      action: "cant_fit",
      company: "Offline Board",
      title: "Software Engineering Intern",
    }) as never, offlineGrindAction as never, databasePath);
    expect(offlineGrindAction.statusCode).toBe(200);

    const missingDatabase = response();
    await requestHandler(request("GET", "/api/roles?limit=1") as never, missingDatabase as never, join(directory, "missing.db"));
    expect(missingDatabase.statusCode).toBe(503);
  });

  it("caps live run history at the latest five crawls", async () => {
    const database = new DatabaseSync(databasePath);
    try {
      for (let index = 0; index < 6; index += 1) {
        const startedAt = new Date(Date.now() - ((6 - index) * 60_000)).toISOString();
        database.prepare(`
          INSERT INTO crawl_runs (started_at, finished_at, status, options_json, sources_requested, internships_discovered)
          VALUES (@startedAt, @finishedAt, 'COMPLETED', '{}', 1, @roles)
        `).run({ startedAt, finishedAt: startedAt, roles: index + 10 });
      }
    } finally {
      database.close();
    }

    const changes = response();
    await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
    const changesPayload = JSON.parse(changes.body.toString("utf8")) as {
      latestRun: { id: number };
      runs: Array<{ id: number; internships_discovered: number }>;
    };
    expect(changes.statusCode).toBe(200);
    expect(changesPayload.runs).toHaveLength(5);
    expect(changesPayload.runs.map((run) => run.id)).toEqual(
      [...changesPayload.runs.map((run) => run.id)].sort((left, right) => right - left),
    );
    expect(changesPayload.runs[0]?.id).toBe(changesPayload.latestRun.id);

    const roles = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=open&limit=1") as never, roles as never, databasePath);
    const rolesPayload = JSON.parse(roles.body.toString("utf8")) as {
      latestRun: { id: number };
      runs: Array<{ id: number }>;
    };
    expect(rolesPayload.runs.map((run) => run.id)).toEqual(changesPayload.runs.map((run) => run.id));
    expect(rolesPayload.latestRun.id).toBe(changesPayload.latestRun.id);
  });

  it("publishes the in-progress source URL on the live change stream", async () => {
    const sourceUrl = "https://jobs.example.test/current-source-check";
    const startedAt = new Date().toISOString();
    const database = new DatabaseSync(databasePath);
    let runId: number;
    try {
      database.prepare(`
        INSERT INTO crawl_runs (started_at, heartbeat_at, status, options_json, sources_requested)
        VALUES (@startedAt, @heartbeatAt, 'RUNNING', '{}', 2)
      `).run({ startedAt, heartbeatAt: startedAt });
      runId = Number((database.prepare("SELECT MAX(id) AS id FROM crawl_runs").get() as { id: number }).id);
      database.prepare("INSERT INTO sources (url, created_at) VALUES (@url, @now)").run({ url: sourceUrl, now: startedAt });
      const sourceId = Number((database.prepare("SELECT id FROM sources WHERE url = @url").get({ url: sourceUrl }) as { id: number }).id);
      database.prepare(`
        INSERT INTO source_run_results (run_id, source_id, settled, completed, started_at)
        VALUES (@runId, @sourceId, 0, 0, @startedAt)
      `).run({ runId, sourceId, startedAt });
    } finally {
      database.close();
    }

    try {
      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      expect(changes.statusCode).toBe(200);
      const payload = JSON.parse(changes.body.toString("utf8")) as {
        scan: { active: boolean; currentSource: { url: string } | null; currentSources: Array<{ url: string }> };
      };
      expect(payload.scan.active).toBe(true);
      expect(payload.scan.currentSource?.url).toBe(sourceUrl);
      expect(payload.scan.currentSources.map((source) => source.url)).toEqual([sourceUrl]);

      const roles = response();
      await requestHandler(request("GET", "/api/roles?tab=summer&limit=1") as never, roles as never, databasePath);
      const rolesPayload = JSON.parse(roles.body.toString("utf8")) as { scan: { currentSource: { url: string } | null } };
      expect(rolesPayload.scan.currentSource?.url).toBe(sourceUrl);
    } finally {
      const cleanup = new DatabaseSync(databasePath);
      cleanup.prepare("UPDATE crawl_runs SET status = 'FAILED', finished_at = @finishedAt, heartbeat_at = NULL WHERE id = @runId").run({
        finishedAt: new Date().toISOString(),
        runId,
      });
      cleanup.close();
    }
  });

  it("publishes an in-process source URL even when the latest stored run is already completed", async () => {
    const sourceUrl = "https://jobs.example.test/in-memory-current-source";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    setDashboardScoutRunnerForTests(async (options) => {
      options.onRunStarted?.(12_345);
      options.onSourceStarted?.(sourceUrl, new Date().toISOString());
      await gate;
      return { persisted: { runId: 12_345 } } as never;
    });
    try {
      const started = response();
      await requestHandler(request("POST", "/api/refresh") as never, started as never, databasePath);
      expect(started.statusCode).toBe(202);
      const changes = response();
      await requestHandler(request("GET", "/api/changes") as never, changes as never, databasePath);
      const payload = JSON.parse(changes.body.toString("utf8")) as {
        scan: { active: boolean; currentSource: { url: string } | null; runId: number | null };
      };
      expect(payload.scan.active).toBe(true);
      expect(payload.scan.runId).toBe(12_345);
      expect(payload.scan.currentSource?.url).toBe(sourceUrl);
    } finally {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
      resetDashboardScanStateForTests();
      setDashboardScoutRunnerForTests(null);
    }
  });

  it("persists a user-added source and starts a deterministic crawl with it", async () => {
    const sourceUrl = "https://custom.example/careers/?utm_source=dashboard";
    let observedSources: string[] = [];
    const execution = {
      crawl: crawl([]),
      persisted: {
        runId: 54_321,
        internships: [],
        counts: { NEW: 0, UPDATED: 0, UNCHANGED: 0, REMOVED_OR_CLOSED: 0 },
      },
      displayed: [],
      jsonPath: "",
      csvPath: "",
    };
    setDashboardScoutRunnerForTests(async (options) => {
      observedSources = options.sources;
      return execution;
    });
    resetDashboardScanStateForTests();
    try {
      const captured = response();
      await requestHandler(
        request("POST", "/api/sources", {}, { url: sourceUrl }) as never,
        captured as never,
        databasePath,
      );
      const payload = JSON.parse(captured.body.toString("utf8")) as {
        source: { url: string; created: boolean; isConfigured: boolean };
        started: boolean;
        queued: boolean;
        scan: { configuredSourceCount: number };
      };
      expect(captured.statusCode).toBe(202);
      expect(payload.source).toMatchObject({
        url: "https://custom.example/careers",
        created: true,
        isConfigured: true,
      });
      expect(payload.started).toBe(true);
      expect(payload.queued).toBe(false);
      expect(payload.scan.configuredSourceCount).toBeGreaterThan(19);
      expect(observedSources).toContain("https://custom.example/careers");

      const database = new DatabaseSync(databasePath, { readOnly: true });
      const row = database.prepare("SELECT is_configured FROM sources WHERE url = @url").get({ url: "https://custom.example/careers" }) as { is_configured: number };
      database.close();
      expect(row.is_configured).toBe(1);
    } finally {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      resetDashboardScanStateForTests();
      setDashboardScoutRunnerForTests(null);
    }
  });
});
