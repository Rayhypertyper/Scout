import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { RETIRED_JOBRIGHT_LIST_URL } from "../src/config/retiredSources.js";
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
  it("rejects retired feed GET and POST variants before robots, cache, or network", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const policy = vi.fn().mockResolvedValue({ allowed: true, crawlDelayMs: null });
    const http = client();
    http.attachRobotsPolicy(policy);
    for (const url of [RETIRED_JOBRIGHT_LIST_URL, `${RETIRED_JOBRIGHT_LIST_URL}?count=50&position=0`, `${RETIRED_JOBRIGHT_LIST_URL}/obsolete`]) {
      await expect(http.get(url)).rejects.toMatchObject({ errorType: "source_retired", attempts: 0 });
      await expect(http.postJson(url, { category: "intern:us:swe" })).rejects.toMatchObject({ errorType: "source_retired", attempts: 0 });
    }
    expect(policy).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows Intern List HTML and public SSR tab pages through the ordinary robots policy", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("<html>Internships</html>", { status: 200, headers: { "content-type": "text/html" } }));
    const policy = vi.fn().mockResolvedValue({ allowed: true, crawlDelayMs: null });
    const http = client();
    http.attachRobotsPolicy(policy);
    for (const url of ["https://www.intern-list.com/?k=swe", "https://jobright.ai/minisites-jobs/intern/ca/swe?embed=true"]) {
      expect((await http.get(url)).status).toBe(200);
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(policy).toHaveBeenCalledTimes(2);
  });

  it("blocks a redirect to the retired feed without retrying or contacting it", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 302, headers: { location: `${RETIRED_JOBRIGHT_LIST_URL}?count=50` } }));
    await expect(client().get("https://public.example/old-feed")).rejects.toMatchObject({ errorType: "source_retired" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

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

  it("serves stale cache while the domain circuit is open", async () => {
    const url = "https://interninsider.me/internships/new";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("cached page", { status: 200 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    const http = client({
      cacheTtlMs: 0,
      retryCount: 0,
      circuitBreakerFailureThreshold: 1,
    });

    await http.get(url);
    await expect(http.get(url, { cache: false })).rejects.toMatchObject({ errorType: "rate_limited" });

    await expect(http.get(url, { staleIfError: true })).resolves.toMatchObject({
      body: "cached page",
      fromCache: true,
      stale: true,
    });
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

  it("keeps the default response truncation at 12 MB when no override is provided", async () => {
    const body = "x".repeat(12_000_123);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(body, { status: 200, headers: { "content-type": "text/plain" } })
    ));
    const http = client({ retryCount: 0 });

    const response = await http.get("https://large.example/jobs", { cache: false });

    expect(response.body).toHaveLength(12_000_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a complete POST body above 12 MB without making it disk-cache eligible", async () => {
    const json = `{"data":"${"x".repeat(12_000_010)}"}`;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(json, { status: 200, headers: { "content-type": "application/json" } })
    ));
    const http = client({ retryCount: 0 });
    const options = { maxResponseBodyBytes: 13_000_000 };

    const first = await http.postJson("https://api.example/large-feed", { category: "large" }, options);
    const second = await http.postJson("https://api.example/large-feed", { category: "large" }, options);

    expect(first.body).toBe(json);
    const parsed = JSON.parse(first.body) as { data: string };
    expect(parsed.data).toHaveLength(12_000_010);
    expect(second.body).toBe(json);
    expect(second.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("counts opt-in response limits in bytes and cancels an oversized stream", async () => {
    const encoder = new TextEncoder();
    let cancelled = false;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode("é".repeat(51)));
        },
        cancel() {
          cancelled = true;
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    ));
    const http = client({ retryCount: 0 });

    await expect(http.postJson("https://api.example/oversized", {}, {
      cache: false,
      maxResponseBodyBytes: 101,
    })).rejects.toMatchObject({
      statusCode: 200,
      errorType: "response_too_large",
      attempts: 0,
    });

    expect(cancelled).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("hard-clamps opt-in limits to 48 MB and rejects non-finite limits before fetching", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 200, headers: { "content-length": "48000001" } }),
    );
    const http = client({ retryCount: 0 });

    await expect(http.postJson("https://api.example/clamped", {}, {
      cache: false,
      maxResponseBodyBytes: 90_000_000,
    })).rejects.toMatchObject({
      errorType: "response_too_large",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await expect(http.postJson("https://api.example/invalid", {}, {
      cache: false,
      maxResponseBodyBytes: Number.NaN,
    })).rejects.toThrow("maxResponseBodyBytes must be a finite number");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps default and opt-in response-limit POST cache entries separate", async () => {
    let responseNumber = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      responseNumber += 1;
      return new Response(JSON.stringify({ responseNumber }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const http = client({ retryCount: 0 });
    const first = await http.postJson("https://api.example/cache-limit", { category: "same" }, {
      maxResponseBodyBytes: 100,
    });
    const second = await http.postJson("https://api.example/cache-limit", { category: "same" });

    const firstPayload = JSON.parse(first.body) as { responseNumber: number };
    const secondPayload = JSON.parse(second.body) as { responseNumber: number };
    expect(firstPayload.responseNumber).toBe(1);
    expect(secondPayload.responseNumber).toBe(2);
    expect(second.fromCache).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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

  it("rejects an opt-in redirect outside its allowed origins before contacting the target", async () => {
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      return new Response(null, { status: 302, headers: { location: "https://ats.example/apply" } });
    });
    const http = client({ retryCount: 0 });

    await expect(http.get("https://earlycareerradar.com/api/jobs", {
      cache: false,
      respectRobots: false,
      allowedRedirectOrigins: ["https://earlycareerradar.com"],
    })).rejects.toMatchObject({ errorType: "redirect_error" });

    expect(requests).toEqual(["https://earlycareerradar.com/api/jobs"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows redirects within the explicitly permitted first-party origin", async () => {
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (requests.length === 1) return new Response(null, { status: 301, headers: { location: "/jobs" } });
      return new Response("first-party response", { status: 200 });
    });
    const http = client({ retryCount: 0 });

    const response = await http.get("https://earlycareerradar.com/api/jobs", {
      cache: false,
      respectRobots: false,
      allowedRedirectOrigins: ["https://earlycareerradar.com/"],
    });

    expect(response.body).toBe("first-party response");
    expect(requests).toEqual(["https://earlycareerradar.com/api/jobs", "https://earlycareerradar.com/jobs"]);
  });

  it("isolates constrained redirects from unconstrained in-flight and cached responses", async () => {
    const sourceUrl = "https://earlycareerradar.com/api/jobs";
    const outsideUrl = "https://ats.example/jobs";
    let sourceRequests = 0;
    let startFirstRequest: (() => void) | undefined;
    let releaseFirstResponse: ((response: Response) => void) | undefined;
    const firstRequestStarted = new Promise<void>((resolve) => { startFirstRequest = resolve; });
    const firstResponse = new Promise<Response>((resolve) => { releaseFirstResponse = resolve; });
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === sourceUrl) {
        sourceRequests += 1;
        if (sourceRequests === 1) {
          startFirstRequest?.();
          return firstResponse;
        }
        return new Response("constrained first-party response", { status: 200 });
      }
      if (url === outsideUrl) return new Response("unconstrained response", { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    });
    const http = client({ cacheTtlMs: 60_000, retryCount: 0 });

    const unconstrained = http.get(sourceUrl, { cache: true, respectRobots: false });
    await firstRequestStarted;
    const constrained = http.get(sourceUrl, {
      cache: true,
      respectRobots: false,
      allowedRedirectOrigins: ["https://earlycareerradar.com"],
    });
    releaseFirstResponse?.(new Response(null, { status: 302, headers: { location: outsideUrl } }));

    await expect(unconstrained).resolves.toMatchObject({ body: "unconstrained response" });
    await expect(constrained).resolves.toMatchObject({ body: "constrained first-party response" });
    expect(sourceRequests).toBe(2);
    expect(requests.filter((url) => url === outsideUrl)).toHaveLength(1);

    await expect(http.get(sourceUrl, {
      cache: true,
      respectRobots: false,
      allowedRedirectOrigins: ["https://earlycareerradar.com"],
    })).resolves.toMatchObject({ body: "constrained first-party response", fromCache: true });
    expect(sourceRequests).toBe(2);
  });
});
