import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  GRIND_JOB_BOARD_FEEDS,
  GrindJobBoardClient,
  grindJobToInternship,
} from "../src/integrations/grindJobBoard.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function feedResponse(path: string, firstSeen = "2026-08-12T16:11:54.299Z"): Response {
  const moduleName = path.split(":")[0] ?? "unknown";
  return Response.json({
    status: "success",
    value: [{
      firstSeen,
      jobId: `${moduleName}-1`,
      link: `https://jobs.example.com/${moduleName}/1`,
      location: "Toronto, Ontario, Canada",
      title: `${moduleName} Software Engineer`,
    }],
  });
}

function queryPath(init?: RequestInit): string {
  if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
  const body = JSON.parse(init.body) as { path: string };
  return body.path;
}

describe("Grind job-board sync", () => {
  it("loads every company feed and normalizes its jobs", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount += 1;
      return feedResponse(queryPath(init));
    };
    const client = new GrindJobBoardClient({
      fetchImpl,
      now: () => Date.parse("2026-08-12T18:00:00.000Z"),
    });

    const snapshot = await client.getSnapshot();

    expect(callCount).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(snapshot.status).toBe("ready");
    expect(snapshot.companiesSynced).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(snapshot.jobCount).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(snapshot.freshCount).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(snapshot.jobs).toContainEqual(expect.objectContaining({
      company: "Amazon",
      link: "https://jobs.example.com/amazon/1",
    }));
  });

  it("uses its cache unless a refresh is explicitly requested", async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount += 1;
      return feedResponse(queryPath(init));
    };
    const client = new GrindJobBoardClient({ fetchImpl, now: () => 1_786_552_800_000 });

    await client.getSnapshot();
    await client.getSnapshot();
    expect(callCount).toBe(GRIND_JOB_BOARD_FEEDS.length);

    await client.getSnapshot(true);
    expect(callCount).toBe(GRIND_JOB_BOARD_FEEDS.length * 2);
  });

  it("treats a successful null feed as an empty company board", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      const path = queryPath(init);
      return path === "janestreet:getJobs"
        ? Response.json({ status: "success", value: null })
        : feedResponse(path);
    };
    const client = new GrindJobBoardClient({ fetchImpl, now: () => 1_786_552_800_000 });

    const snapshot = await client.getSnapshot();

    expect(snapshot.status).toBe("ready");
    expect(snapshot.companiesSynced).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(snapshot.jobCount).toBe(GRIND_JOB_BOARD_FEEDS.length - 1);
    expect(snapshot.failures).toEqual([]);
  });

  it("keeps last-known jobs when a later refresh is temporarily unavailable", async () => {
    let fail = false;
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (fail) return new Response("unavailable", { status: 503 });
      return feedResponse(queryPath(init));
    };
    const client = new GrindJobBoardClient({ fetchImpl, now: () => 1_786_552_800_000 });
    const first = await client.getSnapshot();
    fail = true;

    const second = await client.getSnapshot(true);

    expect(first.jobCount).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(second.status).toBe("stale");
    expect(second.jobCount).toBe(first.jobCount);
    expect(second.failures).toHaveLength(GRIND_JOB_BOARD_FEEDS.length);
  });

  it("retries transient feed failures without delaying healthy feeds", async () => {
    let failedOnce = true;
    let callCount = 0;
    const fetchImpl: typeof fetch = async (_input, init) => {
      callCount += 1;
      const path = queryPath(init);
      if (path === "amazon:getJobs" && failedOnce) {
        failedOnce = false;
        return new Response("temporary", { status: 503 });
      }
      return feedResponse(path);
    };
    const client = new GrindJobBoardClient({ fetchImpl, retryCount: 1, retryBackoffMs: 0 });

    const snapshot = await client.getSnapshot();

    expect(snapshot.status).toBe("ready");
    expect(snapshot.failures).toEqual([]);
    expect(callCount).toBe(GRIND_JOB_BOARD_FEEDS.length + 1);
    expect(snapshot.attempts).toBe(callCount);
  });

  it("persists a last-known cache and serves it when the feed is fully unavailable", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-grind-cache-"));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, "grind-job-board.json");
    const successfulFetch: typeof fetch = async (_input, init) => feedResponse(queryPath(init));
    const firstClient = new GrindJobBoardClient({ fetchImpl: successfulFetch, cachePath, retryCount: 0 });
    const first = await firstClient.getSnapshot();

    expect(JSON.parse(readFileSync(cachePath, "utf8"))).toMatchObject({ version: 1 });

    const unavailableFetch: typeof fetch = async () => new Response("offline", { status: 503 });
    const secondClient = new GrindJobBoardClient({ fetchImpl: unavailableFetch, cachePath, retryCount: 0 });
    const second = await secondClient.getSnapshot();

    expect(second.status).toBe("stale");
    expect(second.jobCount).toBe(first.jobCount);
    expect(second.companiesSynced).toBe(GRIND_JOB_BOARD_FEEDS.length);
    expect(second.companiesRefreshed).toBe(0);
  });

  it("returns the durable cache without starting a network request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-grind-cache-"));
    temporaryDirectories.push(directory);
    const cachePath = join(directory, "grind-job-board.json");
    const firstClient = new GrindJobBoardClient({
      fetchImpl: async (_input, init) => feedResponse(queryPath(init)),
      cachePath,
      retryCount: 0,
    });
    const first = await firstClient.getSnapshot();

    let callCount = 0;
    const secondClient = new GrindJobBoardClient({
      fetchImpl: async (_input, init) => {
        callCount += 1;
        return feedResponse(queryPath(init));
      },
      cachePath,
      retryCount: 0,
    });

    const cached = secondClient.getCachedSnapshot();

    expect(cached.jobCount).toBe(first.jobCount);
    expect(cached.status).toBe("stale");
    expect(callCount).toBe(0);
    expect(secondClient.isSnapshotFresh()).toBe(false);
  });

  it("rediscovers a rotated Convex host from the first-party bundle", async () => {
    const requestedUrls: string[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requestedUrls.push(url);
      if (url === "https://old.convex.cloud/api/query") return new Response("temporary", { status: 503 });
      if (url === "https://didtheboysgrindleetcodetoday.com/jobs") {
        return new Response('<html><script src="/_next/static/chunks/layout.js"></script></html>', { status: 200 });
      }
      if (url === "https://didtheboysgrindleetcodetoday.com/_next/static/chunks/layout.js") {
        return new Response('new ConvexClient("https://rotated.convex.cloud")', { status: 200 });
      }
      if (url === "https://rotated.convex.cloud/api/query") return feedResponse(queryPath(init));
      return new Response("not found", { status: 404 });
    };
    const client = new GrindJobBoardClient({
      convexUrl: "https://old.convex.cloud",
      fetchImpl,
      retryCount: 0,
      concurrency: 30,
    });

    const snapshot = await client.getSnapshot();

    expect(snapshot.status).toBe("ready");
    expect(snapshot.retrievalUrl).toBe("https://rotated.convex.cloud/api/query");
    expect(requestedUrls).toContain("https://didtheboysgrindleetcodetoday.com/jobs");
    expect(requestedUrls).toContain("https://rotated.convex.cloud/api/query");
  });

  it("normalizes a board row into the shared internship contract", () => {
    const internship = grindJobToInternship({
      id: "amazon:/en/jobs/123",
      company: "Amazon",
      title: "Software Development Engineer Intern",
      location: "Seattle, Washington, USA",
      link: "https://amazon.jobs/en/jobs/123/software-development-engineer-intern?utm_source=board",
      firstSeen: "2026-08-15T19:11:54.303Z",
      jobId: "/en/jobs/123/software-development-engineer-intern",
    }, undefined, "2026-08-15T20:00:00.000Z");

    expect(internship).toMatchObject({
      id: "grind:amazon:/en/jobs/123",
      company: "Amazon",
      title: "Software Development Engineer Intern",
      jobId: "/en/jobs/123/software-development-engineer-intern",
      postingUrl: "https://amazon.jobs/en/jobs/123/software-development-engineer-intern",
      applicationUrl: "https://amazon.jobs/en/jobs/123/software-development-engineer-intern",
      lifecycleStatus: "NEW",
      availabilityStatus: "open",
      lastVerifiedAt: "2026-08-15T20:00:00.000Z",
    });
    expect(internship.relevanceScore).toBeGreaterThanOrEqual(50);
    expect(internship.normalizedLocations[0]?.country).toBe("United States");
  });
});
