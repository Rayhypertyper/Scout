import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import type { Resume } from "../src/resume/tailor.js";
import { analyzed, makeInternship } from "./helpers.js";
import { openAIEnvelope } from "./helpers/openaiResponse.js";

const { resolveResume } = vi.hoisted(() => ({ resolveResume: vi.fn() }));
vi.mock("../src/resume/profile.js", () => ({
  resolveResumeForRequest: resolveResume,
  handleResumeProfileRequest: vi.fn(async () => false),
}));

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

const generatedPdf = Buffer.from("%PDF-1.7\nexample");
const baseResume: Resume = {
  ownerEmail: "owner@example.com",
  name: "Example Candidate",
  contact: ["candidate@example.com"],
  education: [{ title: "University", subtitle: "Computer Science", date: "2025–2029", bullets: [] }],
  experience: [{ title: "Intern", subtitle: "Acme", date: "Summer 2025", bullets: ["Built a TypeScript API."] }],
  projects: [],
  awards: [],
  skills: [{ label: "Languages", items: ["TypeScript"] }],
};
import { compileResumePdf, generateResume } from "../src/resume/service.js";
vi.mock("../src/resume/service.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../src/resume/service.js")>();
  return {
    ...original,
    readBaseResume: vi.fn(async () => baseResume),
    compileResumePdf: vi.fn(async () => ({ pdf: generatedPdf, filename: "Edited-Resume.pdf" })),
    generateResume: vi.fn(async () => ({ pdf: generatedPdf, filename: "Example-Resume.pdf", matches: 2 })),
  };
});
describe("resume download API", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let databasePath = "";
  let directory = "";

  afterEach(() => vi.unstubAllGlobals());

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-deadline-"));
    mkdirSync(join(directory, "output"), { recursive: true });
    vi.stubEnv("SUPABASE_URL", "");
    vi.stubEnv("AUTH_SITE_URL", "");
    process.env.INTERNSHIPMATIC_ROOT = directory;
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.SCOUT_OUTPUT_DIR = join(directory, "output");
    resolveResume.mockResolvedValue(baseResume);
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

  it("exports an edited resume without invoking another draft or mutating the source", async () => {
    const original = structuredClone(baseResume);
    const edited: Resume = {
      ...baseResume,
      projects: [{ title: "New draft title", subtitle: "Personal project", date: "2026", bullets: ["Edited wording."] }],
    };
    vi.mocked(compileResumePdf).mockClear();
    vi.mocked(generateResume).mockClear();
    const result = response();
    await requestHandler(request("/api/resumes/internship/closing-soon", { "content-type": "application/json" }, "POST", { resume: edited }) as never, result as never, databasePath);
    expect(result.statusCode).toBe(200);
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
    expect(result.headers["Content-Disposition"]).toContain("Edited-Resume.pdf");
    expect(vi.mocked(compileResumePdf).mock.lastCall?.[0]).toEqual(edited);
    expect(vi.mocked(compileResumePdf).mock.lastCall?.[1]?.title).toBe("Software Engineering Intern");
    expect(vi.mocked(compileResumePdf).mock.lastCall?.[1]?.company).toBe("Northstar Labs");
    expect(generateResume).not.toHaveBeenCalled();
    expect(baseResume).toEqual(original);
  });

  it("reports unavailable AI rather than returning a reordered-only resume", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const result = response();
    await requestHandler(request("/api/application-drafts/internship/closing-soon", { "content-type": "application/json" }, "POST", { kind: "resume" }) as never, result as never, databasePath);
    expect(result.statusCode).toBe(503);
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
    const payload = JSON.parse(result.body.toString("utf8")) as Record<string, unknown>;
    expect(payload.error).toContain("Set OPENAI_API_KEY");
    expect(payload).not.toHaveProperty("resume");
    expect(payload).not.toHaveProperty("source");
  });

  it("returns a retryable error when all AI corrections invent facts, with no fallback resume", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(openAIEnvelope({
      bullets: [{ sourceRef: "experience.0.bullets.0", text: "Built 10 TypeScript APIs.", sourceRefs: ["experience.0.bullets.0"] }],
    })), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = response();
    await requestHandler(request("/api/application-drafts/internship/closing-soon", { "content-type": "application/json" }, "POST", { kind: "resume" }) as never, result as never, databasePath);
    expect(result.statusCode).toBe(422);
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
    const payload = JSON.parse(result.body.toString("utf8")) as Record<string, unknown>;
    expect(payload.error).toContain("after 3 attempts");
    expect(payload).not.toHaveProperty("resume");
    expect(payload).not.toHaveProperty("source");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rejects malformed edited resumes with private no-store errors", async () => {
    vi.mocked(compileResumePdf).mockClear();
    const result = response();
    await requestHandler(request("/api/resumes/internship/closing-soon", { "content-type": "application/json" }, "POST", { resume: { ...baseResume, name: "" } }) as never, result as never, databasePath);
    expect(result.statusCode).toBe(400);
    expect(result.headers["Cache-Control"]).toBe("private, no-store");
    expect(vi.mocked(compileResumePdf)).not.toHaveBeenCalled();
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
