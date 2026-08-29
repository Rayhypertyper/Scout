import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { HttpClient, HttpRequestError, parseRetryAfterHeader, retryDelayMs } from "../src/crawler/http.js";
import { runWithSourceAbortSignal } from "../src/domain/cancellation.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function client(overrides: Record<string, unknown> = {}): HttpClient {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-http-"));
  temporaryDirectories.push(directory);
  return new HttpClient(resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "test.db"),
    perHostDelayMs: 0,
    retryCount: 3,
    ...overrides,
  }), new Logger("error"));
}

describe("shared HTTP retry and circuit policy", () => {
  it("parses Retry-After and applies exponential jitter without reducing the server delay", () => {
    expect(parseRetryAfterHeader("2")).toBe(2_000);
    expect(parseRetryAfterHeader("not-a-date")).toBeNull();
    expect(retryDelayMs(0, 2_000, 1_000, 0)).toBe(2_000);
    expect(retryDelayMs(1, null, 1_000, 0)).toBe(2_000);
  });

  it("exposes a 429 Retry-After and does not spin when retries are disabled", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("slow down", { status: 429, headers: { "retry-after": "7" } }),
    );
    const http = client({ retryCount: 0 });
    await expect(http.get("https://example.test/jobs", { perHostDelayMs: 0 })).rejects.toMatchObject({
      statusCode: 429,
      errorType: "rate_limited",
      retryAfterMs: 7_000,
      attempts: 0,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry 403 and opens a persisted circuit after consecutive access failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("forbidden", { status: 403 }),
    );
    const http = client({ retryCount: 4, circuitBreakerFailureThreshold: 3 });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(http.get("https://blocked.example/jobs", { perHostDelayMs: 0 })).rejects.toBeInstanceOf(HttpRequestError);
    }
    await expect(http.get("https://blocked.example/jobs", { perHostDelayMs: 0 })).rejects.toMatchObject({ errorType: "circuit_open" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(http.circuitSnapshot()["blocked.example"]?.consecutiveFailures).toBe(3);
  });

  it("revalidates stale cache entries with ETag and serves a 304 body from cache", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      if (requests.length === 1) return new Response("cached body", { status: 200, headers: { etag: "etag-1", "content-type": "text/plain" } });
      return new Response(null, { status: 304 });
    });
    const http = client({ cacheTtlMs: 0, retryCount: 0 });
    expect((await http.get("https://cache.example/jobs")).fromCache).toBe(false);
    const revalidated = await http.get("https://cache.example/jobs");
    expect(revalidated).toMatchObject({ fromCache: true, body: "cached body", status: 200 });
    expect(requests[1]?.headers.get("if-none-match")).toBe("etag-1");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serves a stale CSJobs cache entry after a transient timeout instead of failing the source", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("last successful page", { status: 200, headers: { "content-type": "text/html" } }))
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    const http = client({ cacheTtlMs: 0, retryCount: 0 });

    await http.get("https://csjobs.ca/internships/toronto");
    const recovered = await http.get("https://csjobs.ca/internships/toronto", { staleIfError: true });

    expect(recovered).toMatchObject({ body: "last successful page", fromCache: true, stale: true });
    expect(recovered.attempts).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("gives HiringCafe a 30s request budget instead of the 10s connect+read default", async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response("ok", { status: 200, headers: { "content-type": "text/html" } })
    ));
    const http = client({ retryCount: 0, connectTimeoutMs: 3_000, readTimeoutMs: 7_000, timeoutMs: 30_000 });

    await http.get("https://example.test/jobs");
    expect(timeoutSpy).toHaveBeenLastCalledWith(10_000);

    await http.get("https://hiringcafe.com/");
    expect(timeoutSpy).toHaveBeenLastCalledWith(30_000);
  });

  it("serves a stale HiringCafe cache entry after a transient timeout", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("last successful cafe page", { status: 200, headers: { "content-type": "text/html" } }))
      .mockRejectedValueOnce(new Error("The operation was aborted due to timeout"));
    const http = client({ cacheTtlMs: 0, retryCount: 0 });

    await http.get("https://hiringcafe.com/");
    const recovered = await http.get("https://hiringcafe.com/", { staleIfError: true });

    expect(recovered).toMatchObject({ body: "last successful cafe page", fromCache: true, stale: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies an exhausted transport timeout separately from an HTTP status error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("The operation was aborted due to timeout"));
    const http = client({ retryCount: 0 });

    await expect(http.get("https://timeout.example/jobs")).rejects.toMatchObject({
      errorType: "timeout",
      statusCode: null,
    });
  });

  it("posts JSON through the shared cache and keeps the request body in the cache identity", async () => {
    const requests: Request[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      requests.push(new Request(input, init));
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const http = client();
    const first = await http.postJson("https://api.example/feed", { category: "intern:us:swe", position: 0 });
    const second = await http.postJson("https://api.example/feed", { category: "intern:us:swe", position: 0 });
    const differentBody = await http.postJson("https://api.example/feed", { category: "intern:us:swe", position: 50 });

    expect(first.body).toContain('"ok":true');
    expect(second.fromCache).toBe(true);
    expect(differentBody.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]?.method).toBe("POST");
    expect(requests[0]?.headers.get("content-type")).toBe("application/json");
    expect(await requests[0]?.text()).toContain('"position":0');
    expect(await requests[1]?.text()).toContain('"position":50');
  });

  it("does not share an in-flight request across independently timed source attempts", async () => {
    let calls = 0;
    let firstStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      calls += 1;
      const signal = init?.signal as AbortSignal;
      if (calls === 1) {
        firstStarted?.();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason instanceof Error ? signal.reason : new Error("source aborted")), { once: true });
        });
      }
      return new Response("sibling response", { status: 200, headers: { "content-type": "text/plain" } });
    });
    const http = client({ retryCount: 0 });
    const firstController = new AbortController();
    const first = runWithSourceAbortSignal(firstController.signal, () => http.get("https://shared.example/jobs", { cache: false }));
    await started;

    const siblingController = new AbortController();
    await expect(runWithSourceAbortSignal(siblingController.signal, () => http.get("https://shared.example/jobs", { cache: false }))).resolves.toMatchObject({
      body: "sibling response",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    firstController.abort(new Error("first source timed out"));
    await expect(first).rejects.toThrow();
  });

  it("keeps robots enforcement by default but carries an explicit owner exception across redirects", async () => {
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      requests.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      if (requests.length === 1) {
        return new Response(null, { status: 301, headers: { location: "https://canonical.example/jobs" } });
      }
      return new Response("owner-authorized page", { status: 200, headers: { "content-type": "text/html" } });
    });
    const http = client({ retryCount: 0 });
    http.attachRobotsPolicy(async () => ({ allowed: false, crawlDelayMs: null }));

    await expect(http.get("https://blocked.example/jobs", { cache: false })).rejects.toMatchObject({ errorType: "robots_disallowed" });
    const response = await http.get("https://blocked.example/jobs", { cache: false, respectRobots: false });

    expect(response.body).toBe("owner-authorized page");
    expect(requests).toEqual([
      "https://blocked.example/jobs",
      "https://canonical.example/jobs",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
