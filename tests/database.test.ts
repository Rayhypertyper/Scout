import { mkdtempSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { listingActionIdentityMatches, readListingActionIdentities } from "../src/database/actions.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { Internship } from "../src/domain/schemas.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function crawl(job = makeInternship()): CrawlResult {
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 2,
    potentialPostingsInspected: 1,
    jobs: [analyzed(job)],
    failures: [],
    closedPages: [],
    completedSourceUrls: ["https://example.com/careers"],
    sourceResults: [{
      sourceUrl: "https://example.com/careers",
      durationMs: 1_250,
      pagesVisited: 2,
      potentialPostingsInspected: 1,
      jobs: [analyzed(job)],
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

function crawlJobs(jobs: Internship[]): CrawlResult {
  const first = jobs[0];
  if (!first) throw new Error("crawlJobs requires at least one job");
  const analyzedJobs = jobs.map(analyzed);
  const result = crawl(first);
  return {
    ...result,
    jobs: analyzedJobs,
    sourceResults: result.sourceResults.map((source) => ({ ...source, jobs: analyzedJobs })),
  };
}

describe("SQLite lifecycle", () => {
  it("serializes concurrent constructor migrations and remains idempotent", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-constructors-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "concurrent.db");
    const childSource = `
      import { InternshipDatabase } from "./src/database/db.ts";
      const database = new InternshipDatabase(${JSON.stringify(databasePath)});
      database.close();
    `;
    const runChild = (): Promise<{ status: number | null; error: string }> => new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childSource], {
        cwd: process.cwd(),
        stdio: ["ignore", "ignore", "pipe"],
      });
      let error = "";
      child.stderr.on("data", (chunk: Buffer) => { error += chunk.toString("utf8"); });
      child.on("close", (status) => resolve({ status, error }));
      child.on("error", (spawnError) => resolve({ status: null, error: spawnError.message }));
    });
    const results = await Promise.all(Array.from({ length: 4 }, runChild));
    expect(results.map((result) => result.status), results.map((result) => result.error).join("\n")).toEqual([0, 0, 0, 0]);

    const reopened = new InternshipDatabase(databasePath);
    reopened.close();
    const check = new DatabaseSync(databasePath);
    expect(check.prepare("SELECT name FROM sqlite_master WHERE name IN ('crawl_runs', 'listing_actions', 'listing_action_identities') ORDER BY name").all()).toHaveLength(3);
    check.close();
  });

  it("does not allow overlapping crawl runs to share the database", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-lock-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const competingDatabase = new InternshipDatabase(settings.databasePath);

    expect(() => competingDatabase.startRun(options)).toThrow(/run .* is already running/);

    database.markRunFailed(firstRun, "test cleanup");
    competingDatabase.close();
    database.close();
  });

  it("keeps termination requests separate from the owning worker's final status", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-cancel-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const runId = database.startRun(options);
    const requestDatabase = new DatabaseSync(settings.databasePath);
    requestDatabase.prepare("UPDATE crawl_runs SET cancel_requested_at = @requestedAt WHERE id = @runId").run({
      requestedAt: new Date().toISOString(),
      runId,
    });
    requestDatabase.close();

    expect(database.isRunCancellationRequested(runId)).toBe(true);
    database.markRunCancelled(runId);
    const rowDatabase = new DatabaseSync(settings.databasePath);
    const row = rowDatabase.prepare("SELECT status, error_message FROM crawl_runs WHERE id = @runId").get({ runId }) as { status: string; error_message: string };
    rowDatabase.close();
    expect(row).toEqual({ status: "FAILED", error_message: "Terminated by user." });
    database.close();
  });

  it("keeps a long-running crawl active when its heartbeat is fresh", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-heartbeat-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const rawDatabase = new DatabaseSync(settings.databasePath);
    rawDatabase.prepare("UPDATE crawl_runs SET started_at = @startedAt WHERE id = @runId").run({
      startedAt: new Date(Date.now() - 30 * 60 * 1_000).toISOString(),
      runId: firstRun,
    });
    rawDatabase.close();
    const competingDatabase = new InternshipDatabase(settings.databasePath);

    expect(() => competingDatabase.startRun(options)).toThrow(/run .* is already running/);

    database.markRunFailed(firstRun, "test cleanup");
    competingDatabase.close();
    database.close();
  });

  it("allows a new crawl after five minutes without a heartbeat", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-stale-lease-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const staleAt = new Date(Date.now() - 21 * 60 * 1_000).toISOString();
    const rawDatabase = new DatabaseSync(settings.databasePath);
    rawDatabase.prepare("UPDATE crawl_runs SET started_at = @staleAt, heartbeat_at = @staleAt WHERE id = @runId").run({
      staleAt,
      runId: firstRun,
    });
    rawDatabase.close();
    const competingDatabase = new InternshipDatabase(settings.databasePath);
    const secondRun = competingDatabase.startRun(options);
    expect(secondRun).toBeGreaterThan(firstRun);
    competingDatabase.markRunFailed(secondRun, "test cleanup");
    competingDatabase.close();
    database.close();
  });

  it("keeps a one-minute-old heartbeat from being stolen by a second start", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-fresh-lease-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const recentAt = new Date(Date.now() - 60 * 1_000).toISOString();
    const rawDatabase = new DatabaseSync(settings.databasePath);
    rawDatabase.prepare("UPDATE crawl_runs SET heartbeat_at = @recentAt WHERE id = @runId").run({
      recentAt,
      runId: firstRun,
    });
    rawDatabase.close();
    const competingDatabase = new InternshipDatabase(settings.databasePath);
    expect(() => competingDatabase.startRun(options)).toThrow(/run .* is already running/);
    database.markRunFailed(firstRun, "test cleanup");
    competingDatabase.close();
    database.close();
  });

  it("prevents a stale process from persisting after ownership moves to a new run", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-ownership-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const rawDatabase = new DatabaseSync(settings.databasePath);
    rawDatabase.prepare(`
      UPDATE crawl_runs
      SET started_at = @startedAt, heartbeat_at = @heartbeatAt
      WHERE id = @runId
    `).run({
      startedAt: "2000-01-01T00:00:00.000Z",
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      runId: firstRun,
    });
    rawDatabase.close();
    const competingDatabase = new InternshipDatabase(settings.databasePath);
    const secondRun = competingDatabase.startRun(options);

    expect(() => database.persistRun(firstRun, crawl(), 2)).toThrow(/no longer running|another crawl owns/);

    competingDatabase.markRunFailed(secondRun, "test cleanup");
    competingDatabase.close();
    database.close();
  });

  it("closes a stored aggregator URL even when the verification URL omits tracking parameters", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-closure-url-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const tracked = makeInternship({
      applicationUrl: "https://jobright.ai/jobs/info/abc123?visit=related-role",
      postingUrl: "https://jobright.ai/jobs/info/abc123?visit=related-role",
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(tracked), 2);

    const secondRun = database.startRun(options);
    const closure = crawl(tracked);
    closure.jobs = [];
    closure.closedPages = [{
      url: "https://jobright.ai/jobs/info/abc123",
      reason: "Aggregator marks job expired",
      statusCode: 200,
    }];
    const result = database.persistRun(secondRun, closure, 2);
    expect(result.counts.REMOVED_OR_CLOSED).toBe(1);
    expect(result.internships[0]?.availabilityStatus).toBe("closed");
    database.close();
  });

  it("does not close a listing when the same crawl rediscovers it", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-rediscovered-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const tracked = makeInternship();
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(tracked), 2);

    const secondRun = database.startRun(options);
    const rediscovered = crawl(tracked);
    rediscovered.closedPages = [{ url: tracked.postingUrl, reason: "Conflicting stale page signal", statusCode: 404 }];
    const result = database.persistRun(secondRun, rediscovered, 2);

    expect(result.internships[0]?.availabilityStatus).toBe("open");
    expect(result.counts.REMOVED_OR_CLOSED).toBe(0);
    database.close();
  });

  it("classifies repeat discoveries, updates, and explicit closure without deleting history", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);

    const firstRun = database.startRun(options);
    const firstCrawl = crawl();
    firstCrawl.failures.push({
      sourceUrl: "https://example.com/careers",
      url: "https://example.com/careers/broken",
      errorType: "navigation_error",
      message: "Fixture timeout",
      statusCode: null,
      retryCount: 2,
      occurredAt: "2027-01-01T00:00:00.000Z",
    });
    expect(database.persistRun(firstRun, firstCrawl, 2).counts.NEW).toBe(1);

    const secondRun = database.startRun(options);
    const repeated = makeInternship({ lastVerifiedAt: "2027-01-02T00:00:00.000Z" });
    expect(database.persistRun(secondRun, crawl(repeated), 2).counts.UNCHANGED).toBe(1);

    const thirdRun = database.startRun(options);
    const changed = makeInternship({
      description: "Develop, test, and maintain TypeScript and Python APIs for production distributed systems.",
      lastVerifiedAt: "2027-01-03T00:00:00.000Z",
    });
    expect(database.persistRun(thirdRun, crawl(changed), 2).counts.UPDATED).toBe(1);

    const fourthRun = database.startRun(options);
    const closedCrawl: CrawlResult = {
      ...crawl(changed),
      jobs: [],
      closedPages: [{ url: changed.postingUrl, reason: "HTTP 404", statusCode: 404 }],
    };
    const closed = database.persistRun(fourthRun, closedCrawl, 2);
    expect(closed.counts.REMOVED_OR_CLOSED).toBe(1);
    expect(closed.internships[0]?.availabilityStatus).toBe("closed");
    database.close();
  });

  it("consolidates persisted provider URL variants and preserves discovery sources", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-dedup-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const first = makeInternship({
      id: "ibm-query",
      jobId: "first-slug",
      title: "Software Developer Intern 2027",
      applicationUrl: "https://careers.ibm.com/job/123?jobId=128497",
      postingUrl: "https://careers.ibm.com/job/123?jobId=128497",
      sources: ["https://example.com/careers"],
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(first), 2);

    const second = makeInternship({
      id: "ibm-path",
      jobId: "second-slug",
      title: "Software Development Internship",
      applicationUrl: "https://careers.ibm.com/job/toronto/software-developer-intern-2027/128497",
      postingUrl: "https://careers.ibm.com/job/toronto/software-developer-intern-2027/128497",
      sources: ["https://github.com/example/list"],
      sourceUrl: "https://github.com/example/list",
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    const secondRun = database.startRun(options);
    const result = database.persistRun(secondRun, crawl(second), 2);
    expect(result.internships).toHaveLength(1);
    expect(result.internships[0]?.id).toBe("ibm-query");
    expect(result.internships[0]?.sources).toEqual(expect.arrayContaining([
      "https://example.com/careers",
      "https://github.com/example/list",
    ]));
    database.close();
  });

  it("retains an official ATS destination when a later aggregator copy is merged", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-quality-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const official = makeInternship({
      id: "official-cambium",
      company: "Cambium Assessment",
      title: "Machine Learning Intern",
      applicationUrl: "https://cambiumlearning.wd1.myworkdayjobs.com/camb/job/Remote/Machine-Learning-Intern_REQ-4561",
      postingUrl: "https://www.applybolt.app/job/machine-learning-intern-at-cambium",
      sources: ["https://www.applybolt.app/jobs/internships"],
      sourceUrl: "https://www.applybolt.app/jobs/internships",
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(official), 2);

    const aggregator = makeInternship({
      id: "aggregator-cambium",
      company: "Cambium Assessment",
      title: "Machine Learning Intern",
      applicationUrl: "https://jobright.ai/jobs/info/123456",
      postingUrl: "https://jobright.ai/jobs/info/123456",
      sources: ["https://www.intern-list.com/"],
      sourceUrl: "https://www.intern-list.com/",
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    const secondRun = database.startRun(options);
    const result = database.persistRun(secondRun, crawl(aggregator), 2);
    expect(result.internships).toHaveLength(1);
    expect(result.internships[0]?.applicationUrl).toBe(official.applicationUrl);
    expect(result.internships[0]?.sources).toEqual(expect.arrayContaining([
      "https://www.applybolt.app/jobs/internships",
      "https://www.intern-list.com/",
    ]));
    database.close();
  });

  it("replaces a shared company page with a row-specific posting on refresh", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-company-page-refresh-"));
    temporaryDirectories.push(directory);
    const sourceUrl = "https://github.com/dreamworkhq/Tech-Internships-2027";
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: [sourceUrl],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const companyPage = "https://www.dreamworkhq.com/c/southstatebank.com";
    const shared = makeInternship({
      id: "southstate-houston",
      company: "Southstatebank",
      title: "Summer 2027 Commercial Banking Intern Houston, TX",
      location: ["Houston, TX", "Richmond James Center", "Atlanta Midtown"],
      normalizedLocations: [{
        raw: "Houston, TX",
        country: "United States",
        provinceState: "Texas",
        city: "Houston",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: companyPage,
      postingUrl: companyPage,
      sourceUrl,
      sources: [sourceUrl],
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(shared), 2);

    const specificUrl = "https://www.dreamworkhq.com/job/613e0503-9132-4309-8b0e-aa660d1e7bf7";
    const specific = makeInternship({
      id: "southstate-houston-specific",
      company: shared.company,
      title: shared.title,
      location: ["Houston, TX"],
      normalizedLocations: [{
        raw: "Houston, TX",
        country: "United States",
        provinceState: "Texas",
        city: "Houston",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: specificUrl,
      postingUrl: specificUrl,
      sourceUrl,
      sources: [sourceUrl],
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    const secondRun = database.startRun(options);
    const result = database.persistRun(secondRun, crawl(specific), 2);

    expect(result.internships).toHaveLength(1);
    expect(result.internships[0]?.id).toBe(shared.id);
    expect(result.internships[0]?.applicationUrl).toBe(specificUrl);
    expect(result.internships[0]?.postingUrl).toBe(specificUrl);
    expect(result.internships[0]?.location).toEqual(["Houston, TX"]);
    database.close();
  });

  it("replaces stale extracted fields when the same posting is reprocessed", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-refresh-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const stale = makeInternship({
      requiredQualifications: ["Experience with Python.", "Equal opportunity boilerplate."],
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(stale), 2);
    const corrected = makeInternship({
      requiredQualifications: ["Experience with Python."],
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    const secondRun = database.startRun(options);
    const result = database.persistRun(secondRun, crawl(corrected), 2);
    expect(result.internships[0]?.requiredQualifications).toEqual(["Experience with Python."]);
    database.close();
  });

  it("treats an original company page as authoritative over its aggregator copy", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-original-refresh-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const applicationUrl = "https://company.example/jobs/100";
    const aggregator = makeInternship({
      applicationUrl,
      postingUrl: "https://jobright.ai/jobs/info/aggregated-100",
      description: "Aggregator summary with enough software internship detail to be accepted.",
      requiredQualifications: ["Aggregator-combined requirement."],
    });
    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawl(aggregator), 2);
    const original = makeInternship({
      applicationUrl,
      postingUrl: applicationUrl,
      description: "Original employer description for production TypeScript software engineering work.",
      requiredQualifications: ["Pursuing Computer Science."],
      lastVerifiedAt: "2027-01-02T00:00:00.000Z",
    });
    const secondRun = database.startRun(options);
    const result = database.persistRun(secondRun, crawl(original), 2);
    expect(result.internships).toHaveLength(1);
    expect(result.internships[0]?.postingUrl).toBe(applicationUrl);
    expect(result.internships[0]?.description).toBe(original.description);
    expect(result.internships[0]?.requiredQualifications).toEqual(["Pursuing Computer Science."]);
    database.close();
  });

  it("persists decisions per listing without removing handled roles from future raw runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-actions-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const appliedNorthstar = makeInternship({
      id: "northstar-applied",
      jobId: "REQ-100",
      title: "Software Engineering Intern",
    });
    const otherNorthstar = makeInternship({
      id: "northstar-other",
      jobId: "REQ-101",
      title: "Backend Engineering Intern",
      applicationUrl: "https://boards.greenhouse.io/northstar/jobs/101/apply",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/101",
    });
    const appliedAcme = makeInternship({
      id: "acme-applied",
      jobId: "REQ-200",
      company: appliedNorthstar.company,
      applicationUrl: "https://boards.greenhouse.io/acme/jobs/200/apply",
      postingUrl: "https://boards.greenhouse.io/acme/jobs/200",
    });

    const firstRun = database.startRun(options);
    database.persistRun(firstRun, crawlJobs([appliedNorthstar, otherNorthstar, appliedAcme]), 2);
    database.recordListingAction("internship", appliedNorthstar.id, "applied", appliedNorthstar.company, appliedNorthstar.title);
    database.recordListingAction("internship", appliedAcme.id, "applied", appliedAcme.company, appliedAcme.title);

    const actionDatabase = new DatabaseSync(settings.databasePath, { readOnly: true });
    const actionContext = actionDatabase.prepare("SELECT application_url, posting_url, job_id, location FROM listing_actions WHERE listing_key = @listingKey")
      .get({ listingKey: `internship:${appliedNorthstar.id}` });
    actionDatabase.close();
    expect(actionContext).toEqual({
      application_url: appliedNorthstar.applicationUrl,
      posting_url: appliedNorthstar.postingUrl,
      job_id: appliedNorthstar.jobId,
      location: appliedNorthstar.location.join(" · "),
    });

    expect(database.getAppliedRoleCount()).toBe(2);
    const knownUrls = database.getKnownUrlsBySource(options.sources).get(options.sources[0] ?? "") ?? [];
    expect(knownUrls).toContain(appliedNorthstar.applicationUrl);
    expect(knownUrls).toContain(otherNorthstar.applicationUrl);
    const secondRun = database.startRun(options);
    const secondResult = database.persistRun(secondRun, crawlJobs([appliedNorthstar, otherNorthstar, appliedAcme]), 2);
    expect(secondResult.internships).toHaveLength(3);
    expect(secondResult.internships.map(({ id }) => id)).toEqual(expect.arrayContaining([
      appliedNorthstar.id,
      otherNorthstar.id,
      appliedAcme.id,
    ]));

    database.recordListingAction("internship", otherNorthstar.id, "cant_fit", otherNorthstar.company, otherNorthstar.title);
    const thirdRun = database.startRun(options);
    const thirdResult = database.persistRun(thirdRun, crawlJobs([appliedNorthstar, otherNorthstar, appliedAcme]), 2);
    expect(thirdResult.internships).toHaveLength(3);
    expect(thirdResult.internships.map(({ id }) => id)).toEqual(expect.arrayContaining([
      appliedNorthstar.id,
      otherNorthstar.id,
      appliedAcme.id,
    ]));
    expect(database.getListingActions()).toHaveLength(3);
    database.close();
  });

  it.each(["cant_fit", "applied"] as const)("retains a crawler copy after the same role was marked %s on another source", (action) => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-cross-source-action-"));
    temporaryDirectories.push(directory);
    const source = "https://tracker.example/internships";
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: [source],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    database.recordListingAction(
      "grind",
      "board-role-100",
      action,
      "Northstar Labs",
      "Software Engineering Intern",
      {
        applicationUrl: "https://boards.greenhouse.io/northstar/jobs/100",
        postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
        jobId: "REQ-100",
        location: "Toronto, ON, Canada",
      },
    );
    const crawlerCopy = makeInternship({
      id: "northstar-career-copy",
      jobId: null,
      applicationUrl: "https://northstar.example/roles/software-engineering-intern",
      postingUrl: "https://northstar.example/roles/software-engineering-intern",
      sourceUrl: source,
      sources: [source],
    });
    const result = database.persistRun(database.startRun(options), {
      ...crawl(crawlerCopy),
      completedSourceUrls: [source],
      sourceResults: crawl(crawlerCopy).sourceResults.map((sourceResult) => ({ ...sourceResult, sourceUrl: source })),
    }, 2);

    expect(result.internships).toHaveLength(1);
    expect(result.internships[0]?.id).toBe(crawlerCopy.id);
    expect(database.getKnownUrlsBySource([source]).get(source)).toContain(crawlerCopy.applicationUrl);
    database.close();
  });

  it("retains URL context as the permanent decision key when identity aliases are rebuilt", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-action-context-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const ashby = makeInternship({
      id: "ashby-original",
      jobId: null,
      company: "Ellipsis Labs",
      title: "Software Engineer Intern (Summer 2027)",
      location: ["New York, NY"],
      normalizedLocations: [{
        raw: "New York, NY",
        country: "United States",
        provinceState: "New York",
        city: "New York",
        remote: false,
        remoteScope: null,
      }],
      applicationUrl: "https://jobs.ashbyhq.com/ellipsislabs/02136b22-35b1-4b3d-8bef-567c3380a849/application",
      postingUrl: "https://jobs.ashbyhq.com/ellipsislabs/02136b22-35b1-4b3d-8bef-567c3380a849",
    });
    const database = new InternshipDatabase(settings.databasePath);
    database.persistRun(database.startRun(options), crawl(ashby), 2);
    database.recordListingAction("internship", ashby.id, "applied", ashby.company, ashby.title, {
      applicationUrl: ashby.applicationUrl,
      postingUrl: ashby.postingUrl,
      location: ashby.location.join(" · "),
    });
    const rawDatabase = new DatabaseSync(settings.databasePath);
    rawDatabase.prepare("DELETE FROM listing_action_identities").run();
    rawDatabase.prepare(`
      UPDATE listing_actions
      SET listing_key = 'internship:legacy-action', listing_id = 'legacy-action'
      WHERE listing_key = 'internship:ashby-original'
    `).run();
    const storedIdentities = readListingActionIdentities(rawDatabase);
    rawDatabase.close();

    const refreshedCopy = makeInternship({
      ...ashby,
      id: "ashby-refreshed-id",
      applicationUrl: "https://jobs.ashbyhq.com/ellipsislabs/02136b22-35b1-4b3d-8bef-567c3380a849",
      postingUrl: "https://jobs.ashbyhq.com/ellipsislabs/02136b22-35b1-4b3d-8bef-567c3380a849",
    });
    expect(listingActionIdentityMatches(refreshedCopy, storedIdentities)).toBe(true);
    database.close();
  });

  it("persists each successful source before the batch is finalized without double-counting it", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-incremental-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const firstRun = database.startRun(options);
    const batch = crawl();
    database.persistSourceResult(firstRun, {
      ...batch.sourceResults[0]!,
      status: "success",
      retrievalMethod: "test HTTP",
      attempts: 1,
      directApplicationLinks: 1,
    });
    const rawDatabase = new DatabaseSync(settings.databasePath);
    expect(rawDatabase.prepare("SELECT COUNT(*) AS count FROM internships").get()).toEqual({ count: 1 });
    expect(rawDatabase.prepare("SELECT status, retrieval_method, duration_ms FROM source_run_results WHERE run_id = @runId").get({ runId: firstRun })).toEqual({ status: "success", retrieval_method: "test HTTP", duration_ms: 1_250 });
    rawDatabase.close();

    const persisted = database.persistRun(firstRun, batch, 2);
    expect(persisted.counts.NEW).toBe(1);
    expect(persisted.internships).toHaveLength(1);
    database.close();
  });

  it("notifies read-side observers only after the completion commit is durable", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-db-commit-observer-"));
    temporaryDirectories.push(directory);
    const settings = resolveSettings({
      databasePath: join(directory, "test.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);
    const runId = database.startRun(options);
    let observed: { status: string; roleCount: number } | null = null;
    const persisted = database.persistRun(runId, crawl(), 2, () => {
      const observer = new DatabaseSync(settings.databasePath, { readOnly: true });
      try {
        observed = {
          status: (observer.prepare("SELECT status FROM crawl_runs WHERE id = @runId").get({ runId }) as { status: string }).status,
          roleCount: Number((observer.prepare("SELECT COUNT(*) AS count FROM internships").get() as { count: number | bigint }).count),
        };
      } finally {
        observer.close();
      }
    });

    expect(persisted.runId).toBe(runId);
    expect(observed).toEqual({ status: "COMPLETED", roleCount: 1 });
    database.close();
  });
});
