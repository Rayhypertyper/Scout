import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    headers,
    async *[Symbol.asyncIterator](): AsyncGenerator<string> {
      // The dashboard reads request bodies through the same async interface as
      // node:http requests, even for this bodyless GET fixture.
      if (body !== undefined) yield JSON.stringify(body);
    },
  };
}

describe("dashboard deadline notification API", () => {
  let requestHandler: typeof import("../src/dashboard.js").requestHandler;
  let databasePath = "";
  let directory = "";

  beforeAll(async () => {
    directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-deadline-"));
    mkdirSync(join(directory, "output"), { recursive: true });
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
    rmSync(directory, { recursive: true, force: true });
    delete process.env.INTERNSHIPMATIC_ROOT;
    delete process.env.DASHBOARD_SKIP_LIVE_BOARD;
    delete process.env.DASHBOARD_SKIP_STARTUP_SCAN;
    delete process.env.SCOUT_OUTPUT_DIR;
  });

  it("publishes closing-soon listings through changes and roles", async () => {
    const changes = response();
    await requestHandler(request("/api/changes") as never, changes as never, databasePath);
    const changesPayload = JSON.parse(changes.body.toString("utf8")) as {
      deadlineNotifications: Array<{ listingId: string; roleTitle: string }>;
    };
    expect(changes.statusCode).toBe(200);
    expect(changesPayload.deadlineNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "closing-soon", roleTitle: "Software Engineering Intern" }),
    ]));

    const roles = response();
    await requestHandler(request("/api/roles?tab=summer&status=open&limit=1") as never, roles as never, databasePath);
    const rolesPayload = JSON.parse(roles.body.toString("utf8")) as {
      deadlineNotifications: Array<{ listingId: string }>;
    };
    expect(roles.statusCode).toBe(200);
    expect(rolesPayload.deadlineNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "closing-soon" }),
    ]));
  });

  it("does not show a marked role through deadline alerts, listings, or details", async () => {
    const action = response();
    await requestHandler(request("/api/actions", {}, "POST", {
      listingType: "internship",
      listingId: "closing-soon",
      action: "cant_fit",
      company: "Northstar Labs",
      title: "Software Engineering Intern",
    }) as never, action as never, databasePath);
    expect(action.statusCode).toBe(200);

    try {
      const changes = response();
      await requestHandler(request("/api/changes") as never, changes as never, databasePath);
      const changesPayload = JSON.parse(changes.body.toString("utf8")) as {
        deadlineNotifications: Array<{ listingId: string }>;
      };
      expect(changesPayload.deadlineNotifications.some(({ listingId }) => listingId === "closing-soon")).toBe(false);

      const roles = response();
      await requestHandler(request("/api/roles?tab=summer&status=open&limit=10") as never, roles as never, databasePath);
      const rolesPayload = JSON.parse(roles.body.toString("utf8")) as {
        items: Array<{ listingId?: string; id?: string }>;
        deadlineNotifications: Array<{ listingId: string }>;
      };
      expect(rolesPayload.items.some((item) => (item.listingId ?? item.id) === "closing-soon")).toBe(false);
      expect(rolesPayload.deadlineNotifications.some(({ listingId }) => listingId === "closing-soon")).toBe(false);

      const detail = response();
      await requestHandler(request("/api/roles/internship/closing-soon") as never, detail as never, databasePath);
      expect(detail.statusCode).toBe(404);
    } finally {
      const undo = response();
      await requestHandler(request("/api/actions?listingType=internship&listingId=closing-soon", {}, "DELETE") as never, undo as never, databasePath);
      expect(undo.statusCode).toBe(200);
    }
  });

  it("changes the status ETag when a deadline alert enters the window", async () => {
    const database = new DatabaseSync(databasePath);
    try {
      const row = database.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: "closing-soon" }) as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.deadline = new Date(Date.now() + 25 * 60 * 60_000).toISOString();
      database.prepare("UPDATE internships SET payload_json = @payload WHERE id = @id").run({
        id: "closing-soon",
        payload: JSON.stringify(payload),
      });
    } finally {
      database.close();
    }

    const first = response();
    await requestHandler(request("/api/changes") as never, first as never, databasePath);
    const firstEtag = first.headers.ETag;
    if (!firstEtag) throw new Error("Expected an ETag on the first changes response");

    const updatedDatabase = new DatabaseSync(databasePath);
    try {
      const row = updatedDatabase.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: "closing-soon" }) as { payload_json: string };
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.deadline = new Date(Date.now() + 4 * 60 * 60_000).toISOString();
      updatedDatabase.prepare("UPDATE internships SET payload_json = @payload WHERE id = @id").run({
        id: "closing-soon",
        payload: JSON.stringify(payload),
      });
    } finally {
      updatedDatabase.close();
    }

    const second = response();
    await requestHandler(request("/api/changes", { "if-none-match": firstEtag }) as never, second as never, databasePath);
    expect(second.statusCode).toBe(200);
    const secondPayload = JSON.parse(second.body.toString("utf8")) as {
      deadlineNotifications: Array<{ listingId: string }>;
    };
    expect(secondPayload.deadlineNotifications).toEqual(expect.arrayContaining([
      expect.objectContaining({ listingId: "closing-soon" }),
    ]));
  });
});
