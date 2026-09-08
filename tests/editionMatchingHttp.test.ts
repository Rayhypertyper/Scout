import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { setAuthGatewayFactoryForTests } from "../src/auth/router.js";
import type { AuthGateway, AuthUser } from "../src/auth/types.js";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import * as matching from "../src/preferences/matching.js";
import * as preferenceStore from "../src/preferences/store.js";
import { analyzed, makeInternship } from "./helpers.js";

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string | string[]>;
  body: Buffer;
  writeHead(status: number, headers: Record<string, string | string[]>): void;
  end(body?: Buffer | string): void;
}

interface RolesPayload {
  items: Array<{
    id: string;
    matchScore?: number;
    matchMatched?: boolean;
    matchStatus?: string;
    matchScoreVersion?: string;
    matchExplanation?: {
      hardExclusions: string[];
      preferenceMismatches: string[];
      uncertainty: string[];
      insufficientFit: string[];
    };
  }>;
  pagination: { total: number };
  matchingDiagnostics?: {
    evaluated: number;
    userMatched: number;
    userFiltered: number;
    hardExcluded: number;
    insufficientFit: number;
    uncertain: number;
  };
  capabilities: { crawlerAdministration: boolean };
}

const SOURCE = "https://private-source.example/careers";
const USER: AuthUser = {
  id: "edition-matching-user",
  email: "edition-matching@example.com",
  emailVerified: true,
  createdAt: "2026-08-23T12:00:00.000Z",
};
const csrf = "a".repeat(43);

function fakeGateway(): AuthGateway {
  return {
    async getCurrentUser() { return USER; },
    async signUp() { throw new Error("not used"); },
    async signIn() { throw new Error("not used"); },
    async resendVerification() { throw new Error("not used"); },
    async requestPasswordReset() { throw new Error("not used"); },
    async verifyToken() { throw new Error("not used"); },
    async exchangeCode() { throw new Error("not used"); },
    async updatePassword() { throw new Error("not used"); },
    async signOut() { throw new Error("not used"); },
  };
}

function payload<T>(response: CapturedResponse): T {
  return JSON.parse(response.body.toString("utf8")) as T;
}

describe("edition-aware stored-job HTTP matching", () => {
  let dashboard: typeof import("../src/dashboard.js");
  let directory: string;
  let databasePath: string;
  const crawlRunner = vi.fn(async () => { throw new Error("Matching must never launch a crawl"); });

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "scout-edition-matching-"));
    databasePath = join(directory, "internships.db");
    vi.stubEnv("INTERNSHIPMATIC_ROOT", directory);
    vi.stubEnv("SCOUT_EDITION", "public");
    vi.stubEnv("DASHBOARD_SKIP_LIVE_BOARD", "1");
    vi.stubEnv("DASHBOARD_SKIP_STARTUP_SCAN", "1");
    vi.stubEnv("SCOUT_OUTPUT_DIR", join(directory, "output"));
    vi.stubEnv("GRIND_JOB_BOARD_CACHE_PATH", join(directory, "missing-board-cache.json"));
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    vi.stubEnv("AUTH_SITE_URL", "http://127.0.0.1:4173");
    dashboard = await import("../src/dashboard.js");
    dashboard.setDashboardScoutRunnerForTests(crawlRunner);
    setAuthGatewayFactoryForTests(fakeGateway);

    const jobs = [
      makeInternship({
        id: "summer-role", jobId: "SUMMER-1", company: "Summer Labs",
        applicationUrl: "https://boards.greenhouse.io/summer/jobs/100/apply",
        postingUrl: "https://boards.greenhouse.io/summer/jobs/100",
      }),
      makeInternship({
        id: "winter-role", jobId: "WINTER-1", company: "Winter Labs", internshipTerm: "Winter",
        applicationUrl: "https://boards.greenhouse.io/winter/jobs/200/apply",
        postingUrl: "https://boards.greenhouse.io/winter/jobs/200",
      }),
      makeInternship({
        id: "marketing-role", jobId: "MARKETING-1", company: "Broad Roles Ltd", title: "Marketing Intern",
        applicationUrl: "https://boards.greenhouse.io/broad/jobs/300/apply",
        postingUrl: "https://boards.greenhouse.io/broad/jobs/300",
        description: "Support summer marketing campaigns and customer interviews.",
        responsibilities: ["Plan marketing campaigns."], technologies: [], categories: ["other-internship"],
        requiredQualifications: ["Currently enrolled university student."], preferredQualifications: [], educationRequirements: [],
        relevanceScore: 10,
        deadline: new Date(Date.now() + 12 * 60 * 60 * 1_000).toISOString(),
      }),
      makeInternship({
        id: "sparse-role", jobId: "SPARSE-1", company: "Sparse Systems", title: "Backend Software Intern",
        applicationUrl: "https://boards.greenhouse.io/sparse/jobs/400/apply",
        postingUrl: "https://boards.greenhouse.io/sparse/jobs/400",
        description: "Build backend services and improve developer tooling.",
        responsibilities: ["Build backend services."],
        requiredQualifications: [], preferredQualifications: [], educationRequirements: [],
        graduationRequirements: [], experienceRequirements: [], workAuthorizationRequirements: [],
        sponsorshipInformation: null, technologies: [], categories: ["swe"], relevanceScore: 78,
      }),
      makeInternship({
        id: "hard-role", jobId: "HARD-1", company: "Strict Degree Labs", title: "Backend Software Intern",
        applicationUrl: "https://boards.greenhouse.io/strict/jobs/500/apply",
        postingUrl: "https://boards.greenhouse.io/strict/jobs/500",
        requiredQualifications: ["PhD required."], educationRequirements: ["PhD required."],
        technologies: ["Python"], categories: ["backend"], relevanceScore: 88,
      }),
      makeInternship({
        id: "unrelated-role", jobId: "UNRELATED-1", company: "Platform Operations Ltd", title: "Platform Operations Intern",
        applicationUrl: "https://boards.greenhouse.io/platform/jobs/600/apply",
        postingUrl: "https://boards.greenhouse.io/platform/jobs/600",
        description: "Coordinate service operations and vendor schedules.",
        responsibilities: ["Coordinate service operations."],
        requiredQualifications: ["Currently enrolled university student."], preferredQualifications: [],
        educationRequirements: [], graduationRequirements: [], experienceRequirements: [],
        workAuthorizationRequirements: [], sponsorshipInformation: null, technologies: [],
        categories: ["other-internship"], relevanceScore: 44,
      }),
    ].map((role) => analyzed({ ...role, sourceUrl: SOURCE, sources: [SOURCE] }));
    const crawl: CrawlResult = {
      sourcesRequested: 1, sourcesCompleted: 1, sourcesSuccessful: 1, sourcesPartiallyCompleted: 0,
      sourcesFailed: 0, pagesVisited: 1, potentialPostingsInspected: jobs.length,
      jobs, failures: [], closedPages: [], completedSourceUrls: [SOURCE],
      sourceResults: [{
        sourceUrl: SOURCE, pagesVisited: 1, potentialPostingsInspected: jobs.length,
        jobs, failures: [], closedPages: [], completed: true, coverageComplete: true,
      }],
    };
    const options: ScoutRunOptions = {
      sources: [SOURCE],
      settings: resolveSettings({ edition: "public", databasePath, outputDirectory: join(directory, "output") }),
      filters: { categories: [], newOnly: false, minScore: 0 },
    };
    const database = new InternshipDatabase(databasePath);
    try {
      database.configureSource(SOURCE);
      database.persistRun(database.startRun(options), crawl, 2);
    } finally {
      database.close();
    }
    preferenceStore.saveInternshipPreferenceStep(databasePath, USER.id, 1, { terms: [{ term: "summer", year: 2027 }] });
    preferenceStore.saveInternshipPreferenceStep(databasePath, USER.id, 2, {
      countries: ["canada"], cities: [{ name: "Toronto", country: "canada" }], remote: false,
      roleCategories: ["swe"], technologies: ["TypeScript"],
    });
    preferenceStore.saveInternshipPreferenceStep(databasePath, USER.id, 3, {
      degree: "bachelors", graduationYear: 2028, graduationYearOrLater: false,
      workAuthorization: { canada: "authorized", unitedStates: null },
      sponsorship: { canada: "none", unitedStates: null },
    });
  });

  beforeEach(() => {
    dashboard.setDashboardEditionForTests("public");
    crawlRunner.mockClear();
  });

  afterEach(() => { vi.restoreAllMocks(); });

  afterAll(() => {
    dashboard.setDashboardScoutRunnerForTests(null);
    dashboard.closeFastRevisionTrackersForTests();
    dashboard.clearDashboardDataCacheForTests();
    setAuthGatewayFactoryForTests(null);
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
  });

  async function dispatch(
    url: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<CapturedResponse> {
    const captured: CapturedResponse = {
      statusCode: 0, headers: {}, body: Buffer.alloc(0),
      writeHead(status, responseHeaders) { this.statusCode = status; this.headers = responseHeaders; },
      end(value) { this.body = value === undefined ? Buffer.alloc(0) : Buffer.from(value); },
    };
    const request = {
      method, url, headers: { host: "127.0.0.1:4173", ...headers }, socket: { remoteAddress: "127.0.0.1" },
      ...(body === undefined ? {} : {
        async *[Symbol.asyncIterator](): AsyncGenerator<string> { yield JSON.stringify(body); },
      }),
    } as unknown as IncomingMessage;
    await dashboard.requestHandler(request, captured as unknown as ServerResponse, databasePath);
    return captured;
  }

  function canonicalSnapshot(): string {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return JSON.stringify({
        roles: database.prepare("SELECT id, payload_json FROM internships ORDER BY id").all(),
        runs: database.prepare("SELECT id, options_json, status FROM crawl_runs ORDER BY id").all(),
      });
    } finally {
      database.close();
    }
  }

  it("reads and compiles preferences once per Matches request and responds to a saved edit without a recrawl", async () => {
    const readPreferences = vi.spyOn(preferenceStore, "readInternshipPreferences");
    const compileMatcher = vi.spyOn(matching, "compileMatcher");
    const before = canonicalSnapshot();
    const query = "/api/roles?view=matches&tab=internship&status=all&limit=20";

    const summerResponse = await dispatch(query);
    expect(summerResponse.statusCode).toBe(200);
    const summer = payload<RolesPayload>(summerResponse);
    console.log("MATCH_DEBUG", JSON.stringify(summer, null, 2));
    expect(summer.items.map(({ id }) => id)).toEqual(["summer-role", "sparse-role", "winter-role"]);
    expect(summer.items.every(({ matchMatched }) => matchMatched === true)).toBe(true);
    expect(summer.items[0]).toMatchObject({ matchScoreVersion: "matching-v2", matchStatus: expect.any(String) });
    expect(summer.items.find(({ id }) => id === "sparse-role")?.matchExplanation?.uncertainty.length).toBeGreaterThan(0);
    expect(summer.items.map(({ id }) => id)).not.toEqual(expect.arrayContaining(["hard-role", "unrelated-role", "marketing-role"]));
    expect(summer.matchingDiagnostics).toEqual({ evaluated: 5, userMatched: 3, userFiltered: 2, hardExcluded: 1, insufficientFit: 1, uncertain: expect.any(Number) });
    expect(readPreferences).toHaveBeenCalledExactlyOnceWith(databasePath, USER.id);
    expect(compileMatcher).toHaveBeenCalledTimes(1);

    const saved = await dispatch("/api/preferences/steps/1", "PUT", { terms: [{ term: "winter", year: 2027 }] }, {
      origin: "http://127.0.0.1:4173", cookie: `rr-csrf=${csrf}`,
      "x-csrf-token": csrf, "content-type": "application/json",
    });
    expect(saved.statusCode).toBe(200);
    readPreferences.mockClear();
    compileMatcher.mockClear();

    const winterResponse = await dispatch(query);
    expect(winterResponse.statusCode).toBe(200);
    const winter = payload<RolesPayload>(winterResponse);
    expect(winter.items.map(({ id }) => id)).toEqual(["winter-role", "sparse-role", "summer-role"]);
    expect(winter.items.every(({ matchMatched }) => matchMatched === true)).toBe(true);
    expect(winter.matchingDiagnostics).toEqual({ evaluated: 5, userMatched: 3, userFiltered: 2, hardExcluded: 1, insufficientFit: 1, uncertain: expect.any(Number) });
    expect(readPreferences).toHaveBeenCalledExactlyOnceWith(databasePath, USER.id);
    expect(compileMatcher).toHaveBeenCalledTimes(1);

    readPreferences.mockClear();
    compileMatcher.mockClear();
    const all = await dispatch("/api/roles?view=all&tab=internship&status=all&limit=20");
    expect(payload<RolesPayload>(all).pagination.total).toBe(5);
    expect(readPreferences).not.toHaveBeenCalled();
    expect(compileMatcher).not.toHaveBeenCalled();
    expect(crawlRunner).not.toHaveBeenCalled();
    expect(canonicalSnapshot()).toBe(before);
  });

  it("keeps source internals out of public list, detail, and change responses", async () => {
    for (const url of [
      "/api/roles?view=all&tab=internship&status=all&limit=20",
      "/api/roles/internship/summer-role",
      "/api/changes",
      "/api/status",
    ]) {
      const result = await dispatch(url);
      expect(result.statusCode, url).toBe(200);
      expect(result.body.toString("utf8"), url).not.toContain(SOURCE);
      for (const field of ["sourceUrl", "sourceResults", "relevanceReason", "currentSources", "failures", "latestRun"]) {
        expect(payload<Record<string, unknown>>(result), `${url}: ${field}`).not.toHaveProperty(field);
        expect(result.body.toString("utf8"), `${url}: ${field}`).not.toContain(`"${field}":`);
      }
    }
    const sourceSearch = await dispatch("/api/roles?view=all&tab=internship&status=all&q=private-source.example");
    expect(payload<RolesPayload>(sourceSearch).pagination.total).toBe(0);
  });

  it("invalidates edition-sensitive pages and ETags while preserving the canonical corpus", async () => {
    const before = canonicalSnapshot();
    const query = "/api/roles?view=all&tab=internship&status=all&limit=20";
    dashboard.setDashboardEditionForTests("personal");
    const personal = await dispatch(query);
    expect(personal.statusCode).toBe(200);
    expect(payload<RolesPayload>(personal).pagination.total).toBe(5);
    expect(payload<RolesPayload>(personal).capabilities.crawlerAdministration).toBe(true);
    expect(personal.body.toString("utf8")).toContain(SOURCE);
    expect(personal.headers.ETag).toEqual(expect.any(String));

    dashboard.setDashboardEditionForTests("public");
    const publicResponse = await dispatch(query, "GET", undefined, { "if-none-match": String(personal.headers.ETag) });
    expect(publicResponse.statusCode).toBe(200);
    expect(publicResponse.headers.ETag).not.toBe(personal.headers.ETag);
    expect(payload<RolesPayload>(publicResponse).pagination.total).toBe(5);
    expect(payload<RolesPayload>(publicResponse).capabilities.crawlerAdministration).toBe(false);
    expect(publicResponse.body.toString("utf8")).not.toContain(SOURCE);
    expect(canonicalSnapshot()).toBe(before);
    expect(crawlRunner).not.toHaveBeenCalled();
  });

  it("reevaluates closing-soon alerts when the server edition changes", async () => {
    for (const edition of ["public", "personal", "public"] as const) {
      dashboard.setDashboardEditionForTests(edition);
      const result = await dispatch("/api/changes");
      expect(result.statusCode).toBe(200);
      const notifications = payload<{ deadlineNotifications: Array<{ listingId: string }> }>(result).deadlineNotifications;
      expect(notifications.some(({ listingId }) => listingId === "marketing-role")).toBe(false);
    }
  });
});
