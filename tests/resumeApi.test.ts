import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

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

function request(
  url: string,
  headers: Record<string, string> = {},
  method = "GET",
  body?: unknown,
): Record<string, unknown> {
  return {
    method,
    url,
    headers: { host: "localhost", ...headers },
    socket: { remoteAddress: "127.0.0.1" },
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      // The dashboard reads request bodies through the same async interface as
      // node:http requests, even for this bodyless GET fixture.
      if (body !== undefined) yield JSON.stringify(body);
    },
  };
}

import { generateResume } from "../src/resume/service.js";
vi.mock("../src/resume/service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/resume/service.js")>();
  return { ...original, readBaseResume: vi.fn(async () => ({ ownerEmail: "owner@example.com" })),
    generateResume: vi.fn(async () => ({ pdf: Buffer.from("%PDF-1.7\nexample"), filename: "Example-Resume.pdf", matches: 2 })) };
});
describe("resume download API", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let databasePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-deadline-"));
    mkdirSync(join(directory, "output"), { recursive: true });
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("AUTH_SITE_URL", "");
    process.env.INTERNSHIPMATIC_ROOT = directory;
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.SCOUT_OUTPUT_DIR = join(directory, "output");
    ({ requestHandler } = await import("../src/dashboard.js"));

    databasePath = join(directory, "deadline.db");
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    const options: ScoutRunOptions = {
      sources: ["https://example.com/careers"],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const role = makeInternship({
      id: "closing-soon",
      deadline: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    });
    const database = new InternshipDatabase(databasePath);
    const runId = database.startRun(options);
    const analyzedRole = analyzed(role);
    const crawl: CrawlResult = {
      sourcesRequested: 1,
      sourcesCompleted: 1,
      sourcesSuccessful: 1,
      sourcesPartiallyCompleted: 0,
      sourcesFailed: 0,
      pagesVisited: 1,
      potentialPostingsInspected: 1,
      jobs: [analyzedRole],
      failures: [],
      closedPages: [],
      completedSourceUrls: ["https://example.com/careers"],
      sourceResults: [{
        sourceUrl: "https://example.com/careers",
        pagesVisited: 1,
        potentialPostingsInspected: 1,
        jobs: [analyzedRole],
        failures: [],
        closedPages: [],
        completed: true,
        coverageComplete: true,
      }],
    };
    database.persistRun(runId, crawl, 1);
    database.close();
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    rmSync(directory, { recursive: true, force: true });
    delete process.env.INTERNSHIPMATIC_ROOT;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.SCOUT_OUTPUT_DIR;
  });

  it("returns a private attachment generated from the complete stored listing", async () => {
    const result = response();
    await requestHandler(request("/api/resumes/internship/closing-soon", {}, "POST") as never, result as never, databasePath);
    expect(result.statusCode).toBe(200);
    expect(result.headers["Content-Type"]).toBe("application/pdf");
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
    expect(result.headers["Content-Disposition"]).toContain("Example-Resume.pdf");
    expect(result.body.toString()).toMatch(/^%PDF/);
    expect(vi.mocked(generateResume).mock.lastCall?.[1].description).toContain("TypeScript");
  });
  it.each([
    ["/api/resumes/internship/closing-soon", "GET", {}, 405],
    ["/api/resumes/invalid/closing-soon", "POST", {}, 400],
    ["/api/resumes/internship/%zz", "POST", {}, 400],
    ["/api/resumes/internship/missing", "POST", {}, 404],
    ["/api/resumes/internship/closing-soon", "POST", { origin: "https://evil.example" }, 403],
  ])("handles %s %s", async (url, method, headers, status) => {
    const result = response();
    await requestHandler(request(url, headers, method) as never, result as never, databasePath);
    expect(result.statusCode).toBe(status);
  });
});
