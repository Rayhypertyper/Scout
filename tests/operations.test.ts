import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DATABASE_SCHEMA } from "../src/database/schema.js";
import { METRIC_REGISTRY } from "../src/observability/metrics.js";
import {
  DEFAULT_OPERATIONS_THRESHOLDS,
  OPERATIONS_METRIC_REGISTRY,
  buildOperationsSnapshot,
  publicFreshnessFromOperations,
  readOperationsSnapshot,
  readPublicFreshness,
} from "../src/observability/operations.js";

const directories: string[] = [];
const NOW = new Date("2027-01-10T12:00:00.000Z");
const SOURCE = "https://ops.example/careers";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(): { database: DatabaseSync; path: string; sourceId: number } {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-operations-"));
  directories.push(directory);
  const path = join(directory, "operations.db");
  const database = new DatabaseSync(path);
  database.exec(DATABASE_SCHEMA);
  database.prepare("INSERT INTO sources (url, created_at, is_configured) VALUES (@url, @createdAt, 1)").run({
    url: SOURCE,
    createdAt: NOW.toISOString(),
  });
  const row = database.prepare("SELECT id FROM sources WHERE url = @url").get({ url: SOURCE }) as { id: number | bigint };
  return { database, path, sourceId: Number(row.id) };
}

interface RunInput {
  status?: "RUNNING" | "COMPLETED" | "FAILED";
  ageMs?: number;
  durationMs?: number;
  heartbeatAgeMs?: number;
  trusted?: boolean;
  completed?: boolean;
  coverageComplete?: boolean;
  inventoryCount?: number;
  rateLimitCount?: number;
  browserFallbacks?: number;
  browserFallbackSuccesses?: number;
  error?: string | null;
  rolesDiscovered?: number;
  rolesEntered?: number;
  rolesChanged?: number;
  rolesUnchanged?: number;
  rolesClosed?: number;
  duplicateListingsSkipped?: number;
  sourcesRequested?: number;
  sourcesSettled?: number;
  sourcesCompleted?: number;
  responseLatencyMs?: number | null;
  httpStatus?: number | null;
}

function insertRun(database: DatabaseSync, sourceId: number, input: RunInput = {}): number {
  const status = input.status ?? "COMPLETED";
  const ageMs = input.ageMs ?? 60_000;
  const durationMs = input.durationMs ?? 1_000;
  const startedAt = new Date(NOW.getTime() - ageMs - durationMs).toISOString();
  const heartbeatAt = new Date(NOW.getTime() - (input.heartbeatAgeMs ?? Math.min(ageMs, 1_000))).toISOString();
  const finishedAt = status === "RUNNING" ? null : new Date(NOW.getTime() - ageMs).toISOString();
  const sourcesRequested = input.sourcesRequested ?? 1;
  const sourcesSettled = input.sourcesSettled ?? (status === "RUNNING" ? 0 : sourcesRequested);
  const sourcesCompleted = input.sourcesCompleted ?? (status === "RUNNING" ? 0 : sourcesRequested);
  const optionsJson = JSON.stringify({ edition: "personal", sources: [SOURCE] });
  database.prepare(`
    INSERT INTO crawl_runs (
      started_at, heartbeat_at, finished_at, status, options_json,
      sources_requested, sources_settled, sources_completed,
      internships_discovered, new_count, updated_count, unchanged_count, closed_count,
      duplicate_listings_skipped
    ) VALUES (
      @startedAt, @heartbeatAt, @finishedAt, @status, @optionsJson,
      @sourcesRequested, @sourcesSettled, @sourcesCompleted,
      @rolesDiscovered, @rolesEntered, @rolesChanged, @rolesUnchanged, @rolesClosed,
      @duplicateListingsSkipped
    )
  `).run({
    startedAt,
    heartbeatAt,
    finishedAt,
    status,
    optionsJson,
    sourcesRequested,
    sourcesSettled,
    sourcesCompleted,
    rolesDiscovered: input.rolesDiscovered ?? input.inventoryCount ?? 10,
    rolesEntered: input.rolesEntered ?? 1,
    rolesChanged: input.rolesChanged ?? 2,
    rolesUnchanged: input.rolesUnchanged ?? 3,
    rolesClosed: input.rolesClosed ?? 0,
    duplicateListingsSkipped: input.duplicateListingsSkipped ?? 1,
  });
  const row = database.prepare("SELECT last_insert_rowid() AS id").get() as { id: number | bigint };
  const runId = Number(row.id);
  const completed = input.completed ?? status === "COMPLETED";
  const coverageComplete = input.coverageComplete ?? completed;
  const trusted = input.trusted ?? (completed && coverageComplete);
  const settled = status === "RUNNING" ? 0 : 1;
  const settledAt = settled === 1 ? finishedAt : null;
  const resultStatus = input.rateLimitCount && input.rateLimitCount > 0 ? "rate_limited" : status === "COMPLETED" ? "success" : "source_unavailable";
  database.prepare(`
    INSERT INTO source_run_results (
      run_id, source_id, settled, completed, started_at, duration_ms, status,
      coverage_complete, stale, health_excluded, inventory_count, trusted_inventory,
      suspicious_inventory, inventory_status, rate_limit_count, browser_fallbacks,
      browser_fallback_successes, response_latency_ms, http_status, settled_at, last_error
    ) VALUES (
      @runId, @sourceId, @settled, @completed, @startedAt, @durationMs, @status,
      @coverageComplete, 0, 0, @inventoryCount, @trusted, 0, @inventoryStatus,
      @rateLimitCount, @browserFallbacks, @browserFallbackSuccesses, @responseLatencyMs,
      @httpStatus, @settledAt, @error
    )
  `).run({
    runId,
    sourceId,
    settled,
    completed: completed ? 1 : 0,
    startedAt,
    durationMs,
    status: resultStatus,
    coverageComplete: coverageComplete ? 1 : 0,
    inventoryCount: input.inventoryCount ?? 10,
    trusted: trusted ? 1 : 0,
    inventoryStatus: trusted ? "trusted" : "incomplete",
    rateLimitCount: input.rateLimitCount ?? 0,
    browserFallbacks: input.browserFallbacks ?? 0,
    browserFallbackSuccesses: input.browserFallbackSuccesses ?? 0,
    responseLatencyMs: input.responseLatencyMs ?? null,
    httpStatus: input.httpStatus ?? null,
    settledAt,
    error: input.error ?? null,
  });
  return runId;
}

function snapshot(database: DatabaseSync, options: Record<string, unknown> = {}) {
  return buildOperationsSnapshot(database, {
    now: NOW,
    configuredSourceUrls: [SOURCE],
    ...options,
  });
}

describe("operations health snapshots", () => {
  it("derives the operations registry from the shared telemetry registry", () => {
    expect(OPERATIONS_METRIC_REGISTRY.crawl_duration_ms).toEqual(METRIC_REGISTRY.crawlDurationMs);
    expect(OPERATIONS_METRIC_REGISTRY.roles_entered).toEqual(METRIC_REGISTRY.rolesEntered);
    expect(OPERATIONS_METRIC_REGISTRY.source_duration_ms).toEqual(METRIC_REGISTRY.sourceDurationMs);
  });

  it("reports no data and unavailable databases without writing them", () => {
    const missing = readOperationsSnapshot(join(tmpdir(), "operations-never-created.db"), { now: NOW });
    expect(missing.status).toBe("unavailable");
    expect(missing.dataState).toBe("no_data");
    const { database, path } = fixture();
    const empty = snapshot(database);
    expect(empty.database).toEqual({ available: true, schemaReady: true });
    expect(empty.dataState).toBe("no_data");
    expect(empty.anomalies.some(({ code }) => code === "NO_DATA")).toBe(true);
    database.close();
    const reopened = new DatabaseSync(path, { readOnly: true });
    expect((reopened.prepare("SELECT COUNT(*) AS count FROM crawl_runs").get() as { count: number }).count).toBe(0);
    reopened.close();
  });

  it("marks legacy health columns as warmup/unknown instead of healthy", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-operations-legacy-"));
    directories.push(directory);
    const database = new DatabaseSync(join(directory, "legacy.db"));
    database.exec(`
      CREATE TABLE crawl_runs (id INTEGER PRIMARY KEY, started_at TEXT, status TEXT, options_json TEXT);
      CREATE TABLE sources (id INTEGER PRIMARY KEY, url TEXT);
      CREATE TABLE source_run_results (run_id INTEGER, source_id INTEGER);
    `);
    const result = snapshot(database);
    expect(result.database).toEqual({ available: true, schemaReady: false });
    expect(result.status).toBe("unknown");
    expect(result.anomalies[0]?.code).toBe("WARMUP");
    database.close();
  });

  it("requires trusted inventory for freshness, including a legitimate zero inventory", () => {
    const { database } = fixture();
    insertRun(database, 1, { inventoryCount: 0, trusted: true, rolesDiscovered: 0 });
    const result = snapshot(database);
    expect(result.freshness.state).toBe("fresh");
    expect(result.freshness.trustedSources).toBe(1);
    expect(result.sources[0]?.zeroYieldCount).toBe(1);

    insertRun(database, 1, { inventoryCount: 0, trusted: false, completed: true, coverageComplete: true });
    const untrusted = snapshot(database);
    expect(untrusted.freshness.lastSuccessfulCrawlAt).not.toBe(untrusted.latestRun?.finishedAt);
    expect(untrusted.sources[0]?.successes).toBe(1);
    database.close();
  });

  it("uses canonical lifecycle counters and detects repeated failures", () => {
    const { database } = fixture();
    insertRun(database, 1, { inventoryCount: 8, rolesEntered: 9, rolesChanged: 8, rolesUnchanged: 7, rolesDiscovered: 20 });
    for (let index = 0; index < 3; index += 1) {
      insertRun(database, 1, {
        status: "FAILED",
        completed: false,
        coverageComplete: false,
        trusted: false,
        error: `failed https://private.example/${index}?token=secret-${index} /Users/ray/private.db`,
      });
    }
    const result = snapshot(database);
    expect(result.latestRun).toMatchObject({ rolesEntered: 1, rolesChanged: 2, rolesUnchanged: 3 });
    expect(result.anomalies.some(({ code }) => code === "REPEATED_FAILURES")).toBe(true);
    expect(result.sources[0]?.lastError).not.toContain("private.example");
    expect(result.sources[0]?.lastError).not.toContain("secret-");
    expect(result.sources[0]?.lastError).not.toContain("/Users/ray");
    database.close();
  });

  it("detects stale, closure, dedup, source yield, and duration regressions only with comparable history", () => {
    const { database } = fixture();
    for (let index = 0; index < 3; index += 1) {
      insertRun(database, 1, {
        durationMs: 120_000,
        inventoryCount: 100,
        rolesDiscovered: 100,
        rolesClosed: 0,
        duplicateListingsSkipped: 1,
      });
    }
    insertRun(database, 1, {
      durationMs: 2 * 60 * 1_000,
      inventoryCount: 1,
      rolesDiscovered: 100,
      rolesClosed: 12,
      duplicateListingsSkipped: 60,
    });
    const result = snapshot(database, {
      thresholds: {
        ...DEFAULT_OPERATIONS_THRESHOLDS,
        staleAfterMs: 24 * 60 * 60 * 1_000,
        slowSourceAbsoluteMs: 10_000,
        durationRegressionAbsoluteMs: 5 * 60_000,
        closureSpikeAbsolute: 5,
      },
    });
    const codes = new Set(result.anomalies.map(({ code }) => code));
    expect(result.dataState).toBe("ready");
    expect(result.metrics.durationTrend).toBe("up");
    for (const code of ["DURATION_REGRESSION", "CLOSURE_SPIKE", "DEDUP_DRIFT", "ZERO_YIELD", "LOW_YIELD", "SLOW_SOURCE"] as const) {
      expect(codes.has(code)).toBe(true);
    }
    database.close();
  });

  it("does not double count terminal HTTP 429 and expires transport anomalies after one clean outcome", () => {
    const { database } = fixture();
    insertRun(database, 1, { rateLimitCount: 1, httpStatus: 429, browserFallbacks: 1, browserFallbackSuccesses: 0, trusted: false, completed: false, coverageComplete: false, status: "FAILED" });
    const first = snapshot(database);
    expect(first.sources[0]?.rateLimitCount).toBe(1);
    expect(first.anomalies.some(({ code }) => code === "RATE_LIMITED")).toBe(true);
    expect(first.anomalies.some(({ code }) => code === "BROWSER_FALLBACK")).toBe(true);
    insertRun(database, 1, { rateLimitCount: 0, browserFallbacks: 0, browserFallbackSuccesses: 0 });
    const recovered = snapshot(database);
    expect(recovered.anomalies.some(({ code }) => code === "RATE_LIMITED")).toBe(false);
    expect(recovered.anomalies.some(({ code }) => code === "BROWSER_FALLBACK")).toBe(false);
    database.close();
  });

  it("reports a stuck run with separate heartbeat and duration evidence", () => {
    const { database } = fixture();
    insertRun(database, 1, {
      status: "RUNNING",
      ageMs: 60 * 60 * 1_000,
      durationMs: 60 * 60 * 1_000,
      heartbeatAgeMs: 500,
    });
    const result = snapshot(database, { thresholds: { stuckRunAgeMs: 10 * 60_000, stuckRunDurationMs: 45 * 60_000 } });
    expect(result.activeRun?.heartbeatAgeMs).toBe(500);
    expect(result.activeRun?.durationMs).toBe(60 * 60 * 1_000);
    const stuck = result.anomalies.find(({ code }) => code === "STUCK_RUN");
    expect(stuck?.explanation).toContain("total duration");
    expect(stuck?.explanation).not.toContain("heartbeat age 60 minutes");
    database.close();
  });

  it("keeps public freshness aggregate safe and advances its wall clock age", () => {
    const { database, path } = fixture();
    insertRun(database, 1, { ageMs: 10 * 60_000, inventoryCount: 3 });
    database.close();
    const freshness = readPublicFreshness(path, { now: NOW });
    expect(freshness).toMatchObject({ state: "fresh", expectedSources: 1, trustedSources: 1, staleSources: 0 });
    expect(Object.keys(freshness).toSorted()).toEqual([
      "ageMs", "expectedSources", "lastSuccessfulCrawlAt", "staleSources", "state", "trustedSources",
    ]);
    const later = readPublicFreshness(path, { now: new Date(NOW.getTime() + 10 * 60_000) });
    expect(later.ageMs).toBe((freshness.ageMs ?? 0) + 10 * 60_000);
    const full = readOperationsSnapshot(path, { now: NOW, configuredSourceUrls: [SOURCE] });
    expect(publicFreshnessFromOperations(full)).toEqual(freshness);
  });

  it("does not mark a source stale before an attempted no-success check ages out", () => {
    const { database } = fixture();
    insertRun(database, 1, { status: "FAILED", completed: false, coverageComplete: false, trusted: false, ageMs: 10_000 });
    const recent = snapshot(database, { thresholds: { staleAfterMs: 60_000 } });
    expect(recent.sources[0]?.stale).toBe(false);
    expect(recent.freshness.state).toBe("unknown");
    insertRun(database, 1, { status: "FAILED", completed: false, coverageComplete: false, trusted: false, ageMs: 120_000 });
    const old = snapshot(database, { thresholds: { staleAfterMs: 60_000 } });
    expect(old.sources[0]?.stale).toBe(true);
    expect(old.anomalies.some(({ code }) => code === "STALE_SOURCE")).toBe(true);
    database.close();
  });

  it("does not let an unconfigured historical source degrade current health", () => {
    const { database } = fixture();
    database.prepare("INSERT INTO sources (url, created_at, is_configured) VALUES (@url, @createdAt, 0)").run({
      url: "https://obsolete.example/jobs",
      createdAt: NOW.toISOString(),
    });
    const obsolete = database.prepare("SELECT id FROM sources WHERE url = @url").get({ url: "https://obsolete.example/jobs" }) as { id: number | bigint };
    for (let index = 0; index < 3; index += 1) {
      insertRun(database, Number(obsolete.id), { status: "FAILED", completed: false, coverageComplete: false, trusted: false });
    }
    const result = snapshot(database);
    const source = result.sources.find(({ url }) => url.includes("obsolete.example"));
    expect(source?.configured).toBe(false);
    expect(result.anomalies.some(({ sourceUrl }) => sourceUrl?.includes("obsolete.example"))).toBe(false);
    database.close();
  });
});
