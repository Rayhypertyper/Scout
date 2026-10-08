import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import { internshipListingActionIdentities } from "../src/database/actions.js";
import type { Internship } from "../src/domain/schemas.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";
import { dashboardAccountHeaders, installDashboardAccountFixture, DASHBOARD_TEST_USER } from "./dashboardAccountFixture.js";
import { accountActionScope } from "../src/database/accountActions.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string>): void;
  end(body?: Buffer | string): void;
}

type RevisionScanDomain = "roles" | "memberships" | "actions" | "identities";

function response(): CapturedResponse {
  return {
    statusCode: 0,
    headers: {},
    body: Buffer.alloc(0),
    writeHead(status, headers) { this.statusCode = status; this.headers = headers; },
    end(body) { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
  };
}

function request(method: string, url: string, body?: unknown): Record<string, unknown> {
  return {
    method,
    url,
    headers: dashboardAccountHeaders(),
    ...(body === undefined ? {} : {
      async *[Symbol.asyncIterator](): AsyncGenerator<string> {
        yield JSON.stringify(body);
      },
    }),
  };
}

function crawl(roles: Internship[]): CrawlResult {
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

function options(databasePath: string, directory: string): ScoutRunOptions {
  return {
    sources: ["https://example.com/careers"],
    settings: resolveSettings({ databasePath, outputDirectory: join(directory, "output") }),
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
}

function role(company: string): Internship {
  const slug = company.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-");
  return makeInternship({
    id: "revision-target",
    company,
    applicationUrl: `https://boards.greenhouse.io/${slug}/jobs/123/apply`,
    postingUrl: `https://boards.greenhouse.io/${slug}/jobs/123`,
    jobId: "REQ-123",
  });
}

function createDatabase(databasePath: string, directory: string, company: string): Internship {
  const database = new InternshipDatabase(databasePath);
  const internship = role(company);
  const runId = database.startRun(options(databasePath, directory));
  database.persistRun(runId, crawl([internship]), 1);
  database.close();
  return internship;
}

function updatePayloadCompany(databasePath: string, company: string, internshipId = "revision-target"): void {
  const database = new DatabaseSync(databasePath);
  try {
    const row = database.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: internshipId }) as {
      payload_json: string;
    };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    payload.company = company;
    database.prepare("UPDATE internships SET payload_json = @payload WHERE id = @id").run({
      payload: JSON.stringify(payload),
      id: internshipId,
    });
  } finally {
    database.close();
  }
}

function addHandledAlias(databasePath: string): void {
  const target = role("Updated During Build Labs");
  const identity = internshipListingActionIdentities(target).find(({ identityKey }) => identityKey.startsWith("role:"));
  if (!identity) throw new Error("Test role did not produce a role identity");
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare(`
      INSERT INTO user_listing_actions (
        user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at
      ) VALUES ('dashboard-test-user', 'internship:background-alias', 'internship', 'background-alias', 'cant_fit',
                'Alias Labs', 'alias labs', 'Alias Intern', @createdAt)
    `).run({ createdAt: new Date().toISOString() });
    database.prepare(`
      INSERT INTO user_listing_action_identities (user_id, listing_key, identity_key, direct_job_ids_json)
      VALUES ('dashboard-test-user', 'internship:background-alias', @identityKey, '[]')
    `).run({ identityKey: identity.identityKey });
  } finally {
    database.close();
  }
}

describe("dashboard durable revision fast path", () => {
  const originalScoutEdition = process.env.SCOUT_EDITION;
  let directory = "";
  let restoreAuth: () => void;
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let setFastDashboardBuildBatchHookForTests: typeof import("../src/dashboard.js").setFastDashboardBuildBatchHookForTests;
  let setFastDatabaseRevisionScanHookForTests: typeof import("../src/dashboard.js").setFastDatabaseRevisionScanHookForTests;
  let setFastChangesAfterHydrationHookForTests: typeof import("../src/dashboard.js").setFastChangesAfterHydrationHookForTests;
  let setFastDashboardIndexBuildHookForTests: typeof import("../src/dashboard.js").setFastDashboardIndexBuildHookForTests;
  let clearFastDashboardCacheForTests: typeof import("../src/dashboard.js").clearFastDashboardCacheForTests;
  let clearDashboardDataCacheForTests: typeof import("../src/dashboard.js").clearDashboardDataCacheForTests;
  let closeFastRevisionTrackersForTests: typeof import("../src/dashboard.js").closeFastRevisionTrackersForTests;
  let prewarmFastDashboardIndexForTests: typeof import("../src/dashboard.js").prewarmFastDashboardIndexForTests;

  async function readRoles(databasePath: string, url: string): Promise<{
    response: CapturedResponse;
    payload: { version: string; items: Array<{ id: string; company: string; isNew?: boolean }>; latestRun?: { pages_visited: number } };
  }> {
    const result = response();
    await requestHandler(request("GET", url) as never, result as never, databasePath);
    return {
      response: result,
      payload: JSON.parse(result.body.toString("utf8")) as {
        version: string;
        items: Array<{ id: string; company: string; isNew?: boolean }>;
        latestRun?: { pages_visited: number };
      },
    };
  }

  async function waitForRoles(
    databasePath: string,
    url: string,
    predicate: (items: Array<{ id: string; company: string; isNew?: boolean }>, version: string) => boolean,
  ): Promise<{
    response: CapturedResponse;
    payload: { version: string; items: Array<{ id: string; company: string; isNew?: boolean }>; latestRun?: { pages_visited: number } };
  }> {
    let latest = await readRoles(databasePath, url);
    for (let attempt = 0; attempt < 50 && !predicate(latest.payload.items, latest.payload.version); attempt += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      latest = await readRoles(databasePath, url);
    }
    return latest;
  }

  it("advances the visible catalog while every build batch receives another crawl write", async () => {
    const databasePath = join(directory, "continuous-ready-publication.db");
    const database = new InternshipDatabase(databasePath);
    const opts = options(databasePath, directory);
    try {
      const seeds = Array.from({ length: 80 }, (_, index) => makeInternship({
        id: `seed-${index}`, company: `Seed Labs ${index}`, jobId: `SEED-${index}`,
        applicationUrl: `https://jobs.example.com/seed/${index}/apply`, postingUrl: `https://jobs.example.com/seed/${index}`,
      }));
      database.persistRun(database.startRun(opts), crawl(seeds), 2);
      await readRoles(databasePath, "/api/roles?tab=canada&season=all&q=published&limit=10");
      const runId = database.startRun(opts);
      database.persistReadyJobs(runId, [analyzed(makeInternship({
        id: "published-during-crawl", company: "Published Labs", jobId: "PUBLISHED-1",
        applicationUrl: "https://jobs.example.com/published/1/apply", postingUrl: "https://jobs.example.com/published/1",
      }))]);
      let writes = 0;
      setFastDashboardBuildBatchHookForTests(async () => {
        writes += 1;
        updatePayloadCompany(databasePath, `Still Crawling Labs ${writes}`, "seed-0");
      });
      const visible = await waitForRoles(
        databasePath, "/api/roles?tab=canada&season=all&q=published&limit=10",
        (items) => items.some(({ id }) => id === "published-during-crawl"),
      );
      expect(visible.response.statusCode).toBe(200);
      expect(visible.payload.items.map(({ id }) => id)).toContain("published-during-crawl");
      expect(writes).toBeGreaterThan(1);
      const reader = new DatabaseSync(databasePath, { readOnly: true });
      try { expect(reader.prepare("SELECT status FROM crawl_runs WHERE id = ?").get(runId)).toMatchObject({ status: "RUNNING" }); }
      finally { reader.close(); }
      database.markRunCancelled(runId);
    } finally {
      setFastDashboardBuildBatchHookForTests(null);
      database.close();
    }
  });

  beforeAll(async () => {
    restoreAuth = installDashboardAccountFixture();
    // The revision tests exercise owner-facing scan/run metadata, which is
    // intentionally unavailable in the safe Public default.
    process.env.SCOUT_EDITION = "personal";
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-revisions-"));
    process.env.INTERNSHIPMATIC_ROOT = directory;
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.SCOUT_OUTPUT_DIR = join(directory, "output", "live");
    process.env.GRIND_JOB_BOARD_CACHE_PATH = join(directory, "missing-board-cache.json");
    ({
      requestHandler,
      setFastDashboardBuildBatchHookForTests,
      setFastDatabaseRevisionScanHookForTests,
      setFastChangesAfterHydrationHookForTests,
      setFastDashboardIndexBuildHookForTests,
      clearFastDashboardCacheForTests,
      clearDashboardDataCacheForTests,
      closeFastRevisionTrackersForTests,
      prewarmFastDashboardIndexForTests,
    } = await import("../src/dashboard.js"));
  });

  afterEach(() => {
    vi.useRealTimers();
    setFastDashboardBuildBatchHookForTests(null);
    setFastDatabaseRevisionScanHookForTests(null);
    setFastChangesAfterHydrationHookForTests(null);
    setFastDashboardIndexBuildHookForTests(null);
    clearFastDashboardCacheForTests();
  });

  afterAll(() => {
    restoreAuth();
    setFastDashboardBuildBatchHookForTests(null);
    setFastDatabaseRevisionScanHookForTests(null);
    setFastChangesAfterHydrationHookForTests(null);
    setFastDashboardIndexBuildHookForTests(null);
    clearDashboardDataCacheForTests();
    closeFastRevisionTrackersForTests();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.INTERNSHIPMATIC_ROOT;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.SCOUT_OUTPUT_DIR;
    delete process.env.GRIND_JOB_BOARD_CACHE_PATH;
    if (originalScoutEdition === undefined) delete process.env.SCOUT_EDITION;
    else process.env.SCOUT_EDITION = originalScoutEdition;
  });

  it("returns fresh active-crawl progress without rescanning role or membership rows", async () => {
    const databasePath = join(directory, "active-crawl.db");
    createDatabase(databasePath, directory, "Progress Labs");
    const writable = new InternshipDatabase(databasePath);
    const activeRunId = writable.startRun(options(databasePath, directory));
    writable.close();

    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);
    const scans: RevisionScanDomain[] = [];
    let builds = 0;
    setFastDatabaseRevisionScanHookForTests((domain) => scans.push(domain));
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });

    const beforeResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, beforeResponse as never, databasePath);
    const before = JSON.parse(beforeResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number; heartbeat_at: string | null } | null;
    };
    expect(before.latestRun?.id).toBe(activeRunId);

    const heartbeatAt = new Date(Date.now() + 1000).toISOString();
    const progress = new DatabaseSync(databasePath);
    try {
      progress.prepare(`
        UPDATE crawl_runs
        SET pages_visited = pages_visited + 37, heartbeat_at = @heartbeatAt
        WHERE id = @runId
      `).run({ heartbeatAt, runId: activeRunId });
    } finally {
      progress.close();
    }

    const afterResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, afterResponse as never, databasePath);
    const after = JSON.parse(afterResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number; heartbeat_at: string | null } | null;
    };
    expect(afterResponse.statusCode).toBe(200);
    expect(after.latestRun).toMatchObject({
      id: activeRunId,
      pages_visited: (before.latestRun?.pages_visited ?? 0) + 37,
      heartbeat_at: heartbeatAt,
    });
    expect(after.version).not.toBe(before.version);

    const rolesResponse = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=20") as never, rolesResponse as never, databasePath);
    const roles = JSON.parse(rolesResponse.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(rolesResponse.statusCode).toBe(200);
    expect(roles.items.map((item) => item.company)).toContain("Progress Labs");
    expect(scans).toEqual([]);
    expect(builds).toBe(0);
  });

  it("retries changes when a progress commit lands during dynamic hydration", async () => {
    const databasePath = join(directory, "changes-hydration-race.db");
    createDatabase(databasePath, directory, "Hydration Labs");

    const beforeResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, beforeResponse as never, databasePath);
    const before = JSON.parse(beforeResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number } | null;
    };
    expect(beforeResponse.statusCode).toBe(200);
    expect(before.latestRun).not.toBeNull();

    setFastChangesAfterHydrationHookForTests(() => {
      const update = new DatabaseSync(databasePath);
      try {
        update.prepare("UPDATE crawl_runs SET pages_visited = pages_visited + 19 WHERE id = @id").run({
          id: before.latestRun!.id,
        });
      } finally {
        update.close();
      }
    });

    const duringRaceResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, duringRaceResponse as never, databasePath);
    const duringRace = JSON.parse(duringRaceResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number } | null;
    };
    expect(duringRaceResponse.statusCode).toBe(200);
    expect(duringRace.latestRun).toMatchObject({
      id: before.latestRun!.id,
      pages_visited: before.latestRun!.pages_visited + 19,
    });
    expect(duringRace.version).not.toBe(before.version);

    const cachedResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, cachedResponse as never, databasePath);
    const cached = JSON.parse(cachedResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number } | null;
    };
    expect(cachedResponse.statusCode).toBe(200);
    expect(cached.version).toBe(duringRace.version);
    expect(cached.latestRun).toEqual(duringRace.latestRun);
  });

  it("observes a legacy payload-only write without hashing the full role table", async () => {
    const databasePath = join(directory, "payload-only.db");
    createDatabase(databasePath, directory, "Before Payload Labs");
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    const scans: RevisionScanDomain[] = [];
    let builds = 0;
    setFastDatabaseRevisionScanHookForTests((domain) => scans.push(domain));
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });

    const mutation = new DatabaseSync(databasePath);
    try {
      const row = mutation.prepare("SELECT payload_json, content_hash FROM internships WHERE id = 'revision-target'").get() as {
        payload_json: string;
        content_hash: string;
      };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.company = "After Payload Labs";
      mutation.prepare("UPDATE internships SET payload_json = @payload WHERE id = 'revision-target'").run({ payload: JSON.stringify(payload) });
      const after = mutation.prepare("SELECT content_hash FROM internships WHERE id = 'revision-target'").get() as { content_hash: string };
      expect(after.content_hash).toBe(row.content_hash);
    } finally {
      mutation.close();
    }

    const changedResponse = response();
    await requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      changedResponse as never,
      databasePath,
    );
    const payload = JSON.parse(changedResponse.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(changedResponse.statusCode).toBe(200);
    expect(payload.items.map((item) => item.company)).toContain("Before Payload Labs");
    expect(scans).toEqual([]);
    expect(builds).toBe(1);

    const fresh = await waitForRoles(
      databasePath,
      "/api/roles?tab=summer&status=all&limit=10",
      (items) => items.some((item) => item.company === "After Payload Labs"),
    );
    expect(fresh.response.statusCode).toBe(200);
    expect(fresh.payload.items.map((item) => item.company)).toContain("After Payload Labs");
  });

  it("does not publish a mixed catalog after an ABA payload edit during legacy batch reads", async () => {
    const databasePath = join(directory, "legacy-batch-aba.db");
    const database = new InternshipDatabase(databasePath);
    try {
      const items = Array.from({ length: 251 }, (_, index) => {
        const company = `Batch Company ${String(index).padStart(3, "0")}`;
        return {
          ...role(company),
          id: `revision-batch-${String(index).padStart(3, "0")}`,
          jobId: `REQ-${String(index).padStart(3, "0")}`,
        };
      });
      const runId = database.startRun(options(databasePath, directory));
      database.persistRun(runId, crawl(items), 1);
    } finally {
      database.close();
    }

    const removeRevisionTriggers = new DatabaseSync(databasePath);
    try {
      const triggers = removeRevisionTriggers.prepare(`
        SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'dashboard_revision_%'
      `).all() as unknown as Array<{ name: string }>;
      expect(triggers.length).toBeGreaterThan(0);
      for (const { name } of triggers) {
        removeRevisionTriggers.exec(`DROP TRIGGER "${name.replaceAll('"', '""')}"`);
      }
    } finally {
      removeRevisionTriggers.close();
    }
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    let batches = 0;
    let enterFirstBatch!: () => void;
    let enterSecondBatch!: () => void;
    let releaseFirstBatch!: () => void;
    let releaseSecondBatch!: () => void;
    const firstBatchEntered = new Promise<void>((resolve) => { enterFirstBatch = resolve; });
    const secondBatchEntered = new Promise<void>((resolve) => { enterSecondBatch = resolve; });
    const firstBatchGate = new Promise<void>((resolve) => { releaseFirstBatch = resolve; });
    const secondBatchGate = new Promise<void>((resolve) => { releaseSecondBatch = resolve; });
    setFastDashboardBuildBatchHookForTests(async () => {
      batches += 1;
      if (batches === 1) {
        enterFirstBatch();
        await firstBatchGate;
      } else if (batches === 2) {
        enterSecondBatch();
        await secondBatchGate;
      }
    });

    updatePayloadCompany(databasePath, "Dirty Trigger Batch Company", "revision-batch-000");
    const builtResponse = response();
    const pendingBuild = requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      builtResponse as never,
      databasePath,
    );
    await firstBatchEntered;
    updatePayloadCompany(databasePath, "Temporary ABA Batch Company", "revision-batch-250");
    releaseFirstBatch();
    await secondBatchEntered;
    updatePayloadCompany(databasePath, "Batch Company 250", "revision-batch-250");
    releaseSecondBatch();
    setFastDashboardBuildBatchHookForTests(null);
    await pendingBuild;

    const currentChanges = response();
    await requestHandler(request("GET", "/api/changes") as never, currentChanges as never, databasePath);
    const currentVersion = (JSON.parse(currentChanges.body.toString("utf8")) as { version: string }).version;
    const final = await waitForRoles(
      databasePath,
      "/api/roles?tab=summer&status=all&q=temporary%20aba%20batch%20company&limit=10",
      (entries, version) => entries.length === 0 && version === currentVersion,
    );
    expect(final.response.statusCode).toBe(200);
    expect(final.payload.version).toBe(currentVersion);
    expect(final.payload.items).toEqual([]);
    expect(batches).toBe(2);
  });

  it("keeps revision counters transactional and observes INSERT OR REPLACE writes", async () => {
    const databasePath = join(directory, "transactional-counter.db");
    createDatabase(databasePath, directory, "Transactional Labs");
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    const scans: RevisionScanDomain[] = [];
    let builds = 0;
    setFastDatabaseRevisionScanHookForTests((domain) => scans.push(domain));
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });

    const mutation = new DatabaseSync(databasePath);
    try {
      const row = mutation.prepare("SELECT payload_json FROM internships WHERE id = 'revision-target'").get() as {
        payload_json: string;
      };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.company = "Rolled Back Labs";
      mutation.exec("BEGIN IMMEDIATE");
      mutation.prepare("UPDATE internships SET payload_json = @payload WHERE id = 'revision-target'").run({ payload: JSON.stringify(payload) });
      mutation.exec("ROLLBACK");
    } finally {
      mutation.close();
    }

    const afterRollback = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&q=transactional%20labs&limit=10") as never, afterRollback as never, databasePath);
    const rollbackPayload = JSON.parse(afterRollback.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(rollbackPayload.items.map((item) => item.company)).toEqual(["Transactional Labs"]);
    expect(builds).toBe(0);

    const replace = new DatabaseSync(databasePath);
    try {
      replace.exec("INSERT OR REPLACE INTO internships SELECT * FROM internships WHERE id = 'revision-target'");
    } finally {
      replace.close();
    }

    const afterReplace = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&q=transactional%20labs&limit=10") as never, afterReplace as never, databasePath);
    const replacePayload = JSON.parse(afterReplace.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(replacePayload.items.map((item) => item.company)).toEqual(["Transactional Labs"]);
    expect(builds).toBe(1);
    expect(scans).toEqual([]);
  });

  it("invalidates independently for membership, action, and identity writes", async () => {
    const databasePath = join(directory, "table-domains.db");
    const target = role("Table Revision Labs");
    createDatabase(databasePath, directory, target.company);
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    const scans: RevisionScanDomain[] = [];
    let builds = 0;
    setFastDatabaseRevisionScanHookForTests((domain) => scans.push(domain));
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });

    const baseline = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=new&limit=10") as never, baseline as never, databasePath);
    const baselinePayload = JSON.parse(baseline.body.toString("utf8")) as { items: Array<{ id: string; isNew: boolean }> };
    expect(baselinePayload.items).toContainEqual(expect.objectContaining({ id: target.id, isNew: true }));

    const mutation = new DatabaseSync(databasePath);
    try {
      mutation.prepare("UPDATE run_internships SET lifecycle_status = 'UNCHANGED' WHERE internship_id = @id").run({ id: target.id });
    } finally {
      mutation.close();
    }
    const membershipChanged = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=new&limit=10") as never, membershipChanged as never, databasePath);
    const membershipPayload = JSON.parse(membershipChanged.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(membershipPayload.items.some((item) => item.id === target.id)).toBe(true);
    expect(builds).toBe(1);

    const membershipFresh = await waitForRoles(
      databasePath,
      "/api/roles?tab=summer&status=new&limit=10",
      (items) => !items.some((item) => item.id === target.id),
    );
    expect(membershipFresh.response.statusCode).toBe(200);
    expect(membershipFresh.payload.items.some((item) => item.id === target.id)).toBe(false);

    const addAction = new DatabaseSync(databasePath);
    try {
      addAction.prepare(`
        INSERT INTO user_listing_actions (
          user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at
        ) VALUES ('dashboard-test-user', 'internship:revision-alias', 'internship', 'revision-alias', 'cant_fit',
                  'Alias Labs', 'alias labs', 'Alias Intern', @createdAt)
      `).run({ createdAt: new Date().toISOString() });
    } finally {
      addAction.close();
    }
    const actionChanged = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, actionChanged as never, databasePath);
    const actionPayload = JSON.parse(actionChanged.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(actionPayload.items.some((item) => item.id === target.id)).toBe(true);
    expect(builds).toBe(2);

    const roleIdentity = internshipListingActionIdentities(target).find(({ identityKey }) => identityKey.startsWith("role:"));
    expect(roleIdentity).toBeDefined();
    const addIdentity = new DatabaseSync(databasePath);
    try {
      addIdentity.prepare(`
        INSERT INTO user_listing_action_identities (user_id, listing_key, identity_key, direct_job_ids_json)
        VALUES ('dashboard-test-user', 'internship:revision-alias', @identityKey, '[]')
      `).run({ identityKey: roleIdentity!.identityKey });
    } finally {
      addIdentity.close();
    }
    const identityChanged = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, identityChanged as never, databasePath);
    const identityPayload = JSON.parse(identityChanged.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(identityPayload.items.some((item) => item.id === target.id)).toBe(false);
    expect(builds).toBe(3);
    expect(scans).toEqual([]);
  });

  it("keeps the prior coherent list responsive during a yielding rebuild, then publishes fresh roles", async () => {
    const databasePath = join(directory, "background-active-crawl.db");
    createDatabase(databasePath, directory, "Before Background Labs");
    const crawler = new InternshipDatabase(databasePath);
    const activeRunId = crawler.startRun(options(databasePath, directory));
    crawler.close();
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    const beforeResponse = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, beforeResponse as never, databasePath);
    const before = JSON.parse(beforeResponse.body.toString("utf8")) as {
      version: string;
      items: Array<{ company: string }>;
      latestRun: { pages_visited: number };
    };
    expect(before.items.map((item) => item.company)).toContain("Before Background Labs");

    let enteredBatch!: () => void;
    let releaseBatch!: () => void;
    const batchEntered = new Promise<void>((resolve) => { enteredBatch = resolve; });
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    let paused = false;
    setFastDashboardBuildBatchHookForTests(async () => {
      if (paused) return;
      paused = true;
      enteredBatch();
      await batchGate;
    });
    updatePayloadCompany(databasePath, "After Background Labs");

    const staleResponse = response();
    const pendingStaleResponse = requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      staleResponse as never,
      databasePath,
    );
    await batchEntered;
    await pendingStaleResponse;
    const stale = JSON.parse(staleResponse.body.toString("utf8")) as {
      version: string;
      items: Array<{ company: string }>;
    };
    expect(staleResponse.statusCode).toBe(200);
    expect(stale.version).toBe(before.version);
    expect(stale.items.map((item) => item.company)).toContain("Before Background Labs");
    expect(stale.items.map((item) => item.company)).not.toContain("After Background Labs");
    expect(staleResponse.headers.ETag).toBe(beforeResponse.headers.ETag);

    const progress = new DatabaseSync(databasePath);
    const heartbeatAt = new Date(Date.now() + 1000).toISOString();
    try {
      progress.prepare(`
        UPDATE crawl_runs SET pages_visited = pages_visited + 11, heartbeat_at = @heartbeatAt
        WHERE id = @runId
      `).run({ heartbeatAt, runId: activeRunId });
    } finally {
      progress.close();
    }
    const changesResponse = response();
    await requestHandler(request("GET", "/api/changes") as never, changesResponse as never, databasePath);
    const changes = JSON.parse(changesResponse.body.toString("utf8")) as {
      version: string;
      latestRun: { id: number; pages_visited: number; heartbeat_at: string | null } | null;
    };
    expect(changesResponse.statusCode).toBe(200);
    expect(changes.latestRun).toMatchObject({
      id: activeRunId,
      pages_visited: before.latestRun.pages_visited + 11,
      heartbeat_at: heartbeatAt,
    });
    expect(changes.version).not.toBe(before.version);

    releaseBatch();
    setFastDashboardBuildBatchHookForTests(null);
    const fresh = await waitForRoles(
      databasePath,
      "/api/roles?tab=summer&status=all&limit=10",
      (items) => items.some((item) => item.company === "After Background Labs"),
    );
    expect(fresh.response.statusCode).toBe(200);
    expect(fresh.payload.items.map((item) => item.company)).toContain("After Background Labs");
    expect(fresh.payload.version).not.toBe(before.version);
    expect(fresh.payload.version).toBe(changes.version);
    expect(fresh.payload.latestRun?.pages_visited).toBe(changes.latestRun?.pages_visited);
  });

  it("reprojects a cached candidate base at current time while a dirty rebuild is pending after idle", async () => {
    const databasePath = join(directory, "background-after-idle.db");
    const baseTime = new Date("2026-08-01T12:00:00.000Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(baseTime);
    createDatabase(databasePath, directory, "Before Idle Labs");
    const ageBaseline = new DatabaseSync(databasePath);
    try {
      ageBaseline.prepare("UPDATE internships SET first_seen_at = @firstSeen WHERE id = 'revision-target'").run({
        firstSeen: baseTime.toISOString(),
      });
    } finally {
      ageBaseline.close();
    }
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    const beforeResponse = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, beforeResponse as never, databasePath);
    const before = JSON.parse(beforeResponse.body.toString("utf8")) as {
      version: string;
      items: Array<{ company: string; isNew: boolean }>;
    };
    expect(before.items).toContainEqual(expect.objectContaining({ company: "Before Idle Labs", isNew: true }));

    let enteredBatch!: () => void;
    let releaseBatch!: () => void;
    const batchEntered = new Promise<void>((resolve) => { enteredBatch = resolve; });
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    setFastDashboardBuildBatchHookForTests(async () => {
      enteredBatch();
      await batchGate;
    });
    vi.setSystemTime(new Date(baseTime.getTime() + 17 * 60 * 60 * 1000));
    updatePayloadCompany(databasePath, "After Idle Labs");

    const staleResponse = response();
    const pendingStaleResponse = requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      staleResponse as never,
      databasePath,
    );
    await batchEntered;
    await pendingStaleResponse;
    const stale = JSON.parse(staleResponse.body.toString("utf8")) as {
      version: string;
      items: Array<{ company: string; isNew: boolean }>;
    };
    expect(staleResponse.statusCode).toBe(200);
    expect(stale.items).toContainEqual(expect.objectContaining({ company: "Before Idle Labs", isNew: false }));
    expect(stale.version).not.toBe(before.version);
    expect(stale.items.map((item) => item.company)).not.toContain("After Idle Labs");

    releaseBatch();
    setFastDashboardBuildBatchHookForTests(null);
    const fresh = await waitForRoles(
      databasePath,
      "/api/roles?tab=summer&status=all&limit=10",
      (items) => items.some((item) => item.company === "After Idle Labs"),
    );
    expect(fresh.response.statusCode).toBe(200);
    expect(fresh.payload.items).toContainEqual(expect.objectContaining({ company: "After Idle Labs", isNew: false }));
  });

  it("does not serve a previous list after its action safety revision changes during a build", async () => {
    const databasePath = join(directory, "background-action-safety.db");
    createDatabase(databasePath, directory, "Before Action Labs");
    const crawler = new InternshipDatabase(databasePath);
    crawler.startRun(options(databasePath, directory));
    crawler.close();
    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);

    let enteredBatch!: () => void;
    let releaseBatch!: () => void;
    const batchEntered = new Promise<void>((resolve) => { enteredBatch = resolve; });
    const batchGate = new Promise<void>((resolve) => { releaseBatch = resolve; });
    let paused = false;
    setFastDashboardBuildBatchHookForTests(async () => {
      if (paused) return;
      paused = true;
      enteredBatch();
      await batchGate;
    });
    updatePayloadCompany(databasePath, "Updated During Build Labs");

    const initialStale = response();
    const initialRequest = requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      initialStale as never,
      databasePath,
    );
    await batchEntered;
    await initialRequest;
    const priorPayload = JSON.parse(initialStale.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(priorPayload.items.map((item) => item.company)).toContain("Before Action Labs");

    addHandledAlias(databasePath);
    let actionRequestSettled = false;
    const afterAction = response();
    const actionRequest = requestHandler(
      request("GET", "/api/roles?tab=summer&status=all&limit=10") as never,
      afterAction as never,
      databasePath,
    ).then(() => { actionRequestSettled = true; });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(actionRequestSettled).toBe(false);

    releaseBatch();
    setFastDashboardBuildBatchHookForTests(null);
    await actionRequest;
    const actionPayload = JSON.parse(afterAction.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(afterAction.statusCode).toBe(200);
    expect(actionPayload.items.some((item) => item.id === "revision-target")).toBe(false);

    const stillHidden = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, stillHidden as never, databasePath);
    const finalPayload = JSON.parse(stillHidden.body.toString("utf8")) as { items: Array<{ id: string }> };
    expect(finalPayload.items.some((item) => item.id === "revision-target")).toBe(false);
  });

  it("does not reuse a revision token after replacing the database at the same path", async () => {
    const databasePath = join(directory, "replacement.db");
    const replacementPath = join(directory, "replacement-source.db");

    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-23T12:00:00.000Z"));
    createDatabase(databasePath, directory, "Original Snapshot Labs");
    createDatabase(replacementPath, directory, "Replacement Snapshot Labs");
    vi.useRealTimers();

    const originalRevisionDb = new DatabaseSync(databasePath, { readOnly: true });
    const replacementRevisionDb = new DatabaseSync(replacementPath, { readOnly: true });
    try {
      const originalRevisions = originalRevisionDb.prepare("SELECT domain, revision FROM dashboard_revisions ORDER BY domain").all();
      const replacementRevisions = replacementRevisionDb.prepare("SELECT domain, revision FROM dashboard_revisions ORDER BY domain").all();
      expect(replacementRevisions).toEqual(originalRevisions);
    } finally {
      originalRevisionDb.close();
      replacementRevisionDb.close();
    }

    await expect(accountActionScope.run({ userId: DASHBOARD_TEST_USER }, () => prewarmFastDashboardIndexForTests(databasePath))).resolves.toBe(true);
    let builds = 0;
    const scans: RevisionScanDomain[] = [];
    setFastDatabaseRevisionScanHookForTests((domain) => scans.push(domain));
    setFastDashboardIndexBuildHookForTests(() => { builds += 1; });

    const replacementBytes = readFileSync(replacementPath);
    const stagingPath = `${databasePath}.replacement`;
    writeFileSync(stagingPath, replacementBytes);
    renameSync(stagingPath, databasePath);

    const afterReplacement = response();
    await requestHandler(request("GET", "/api/roles?tab=summer&status=all&limit=10") as never, afterReplacement as never, databasePath);
    const payload = JSON.parse(afterReplacement.body.toString("utf8")) as { items: Array<{ company: string }> };
    expect(afterReplacement.statusCode).toBe(200);
    expect(payload.items.map((item) => item.company)).toContain("Replacement Snapshot Labs");
    expect(payload.items.map((item) => item.company)).not.toContain("Original Snapshot Labs");
    expect(builds).toBe(1);
    expect(scans).toEqual([]);
  });
});
