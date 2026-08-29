import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { Browser } from "playwright";

import { resolveSettings } from "../src/config/settings.js";
import { BrowserManager } from "../src/crawler/browser.js";
import { HttpClient } from "../src/crawler/http.js";
import { mapBounded } from "../src/crawler/staticAdapters.js";
import { Semaphore } from "../src/utils/async.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function httpClient(overrides: Record<string, unknown> = {}): HttpClient {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-concurrency-"));
  temporaryDirectories.push(directory);
  const settings = resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "crawl.db"),
    retryCount: 0,
    perHostDelayMs: 0,
    ...overrides,
  });
  return new HttpClient(settings, new Logger("error"));
}

describe("bounded asynchronous scheduling", () => {
  it("preserves result order, bounds active work, and settles rejected items", async () => {
    let active = 0;
    let maxActive = 0;
    const results = await mapBounded([1, 2, 3, 4, 5], 2, async (value) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, value === 1 ? 12 : 2));
      active -= 1;
      if (value === 3) throw new Error("one item failed");
      return value * 10;
    });

    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(5);
    expect(results.map((result) => result.status)).toEqual([
      "fulfilled", "fulfilled", "rejected", "fulfilled", "fulfilled",
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 10 });
    expect(results[4]).toEqual({ status: "fulfilled", value: 50 });
  });

  it("releases a semaphore slot after an exception", async () => {
    const semaphore = new Semaphore(1);
    await expect(semaphore.use(async () => {
      throw new Error("first operation failed");
    })).rejects.toThrow("first operation failed");
    await expect(semaphore.use(async () => "second operation")).resolves.toBe("second operation");
  });

  it("coalesces concurrent identical HTTP requests without hiding distinct URLs", async () => {
    const http = httpClient();
    let release: (() => void) | undefined;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    let invocation = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      invocation += 1;
      started();
      if (invocation === 1) await new Promise<void>((resolve) => { release = resolve; });
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return new Response(`body for ${url}`, { status: 200, headers: { "content-type": "text/plain" } });
    });

    const first = http.get("https://coalesce.example/jobs/1", { cache: false });
    await startedPromise;
    const second = http.get("https://coalesce.example/jobs/1", { cache: false });
    release?.();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    const distinctResult = await http.get("https://coalesce.example/jobs/2", { cache: false });

    expect(firstResult.body).toBe(secondResult.body);
    expect(distinctResult.body).toContain("/jobs/2");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("keeps HTTP concurrency wider than per-domain concurrency", async () => {
    const http = httpClient({ httpConcurrency: 3, perDomainConcurrency: 1 });
    let active = 0;
    let maxActive = 0;
    const activeByDomain = new Map<string, number>();
    const maxByDomain = new Map<string, number>();
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const domain = new URL(url).hostname;
      const domainActive = (activeByDomain.get(domain) ?? 0) + 1;
      activeByDomain.set(domain, domainActive);
      maxByDomain.set(domain, Math.max(maxByDomain.get(domain) ?? 0, domainActive));
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      activeByDomain.set(domain, (activeByDomain.get(domain) ?? 1) - 1);
      return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
    });

    await Promise.all([
      http.get("https://one.example/jobs/1", { cache: false }),
      http.get("https://one.example/jobs/2", { cache: false }),
      http.get("https://two.example/jobs/1", { cache: false }),
      http.get("https://two.example/jobs/2", { cache: false }),
    ]);

    expect(maxActive).toBeLessThanOrEqual(3);
    expect(maxByDomain.get("one.example")).toBe(1);
    expect(maxByDomain.get("two.example")).toBe(1);
  });
});

describe("browser resource policy", () => {
  it("aborts media/analytics resources while allowing document navigation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-browser-routes-"));
    temporaryDirectories.push(directory);
    type RouteHandler = (route: {
      request: () => { resourceType: () => string; url: () => string };
      abort: () => Promise<void>;
      continue: () => Promise<void>;
    }) => Promise<void>;
    let routeHandler: RouteHandler | undefined;
    const locator = {
      first: () => locator,
      waitFor: async () => undefined,
      innerText: async () => "Software Engineering Intern",
      isVisible: async () => false,
      count: async () => 0,
      nth: () => locator,
      scrollIntoViewIfNeeded: async () => undefined,
      click: async () => undefined,
    };
    const page = {
      on: () => undefined,
      off: () => undefined,
      goto: async () => ({ status: () => 200, headers: () => ({ "content-type": "text/html" }), url: () => "https://source.example/jobs" }),
      waitForTimeout: async () => undefined,
      waitForFunction: async () => undefined,
      locator: () => locator,
      getByRole: () => locator,
      getByText: () => locator,
      content: async () => "<html><body>Software Engineering Intern</body></html>",
      url: () => "https://source.example/jobs",
      title: async () => "Internship",
      frames: () => [{ evaluate: async () => [] }],
      evaluate: async () => undefined,
      close: async () => undefined,
    };
    const context = {
      route: async (_pattern: string, handler: RouteHandler) => { routeHandler = handler; },
      on: () => undefined,
      newPage: async () => page,
      close: async () => undefined,
      setDefaultTimeout: () => undefined,
      setDefaultNavigationTimeout: () => undefined,
    };
    const fakeBrowser = {
      isConnected: () => true,
      newContext: async () => context,
      close: async () => undefined,
    };
    const settings = resolveSettings({
      outputDirectory: directory,
      databasePath: join(directory, "crawl.db"),
      retryCount: 0,
      perHostDelayMs: 0,
      maxLoadMoreClicks: 0,
    });
    const manager = new BrowserManager(settings, new Logger("error"), async () => fakeBrowser as unknown as Browser);
    try {
      await manager.fetchPage("https://source.example/jobs");
      expect(routeHandler).toBeDefined();
      const abort = vi.fn(async () => undefined);
      const continueRequest = vi.fn(async () => undefined);
      const runRoute = (resourceType: string, url: string) => routeHandler?.({
        request: () => ({ resourceType: () => resourceType, url: () => url }),
        abort,
        continue: continueRequest,
      });
      await runRoute("image", "https://source.example/logo.png");
      await runRoute("script", "https://www.google-analytics.com/collect");
      await runRoute("document", "https://source.example/jobs");
      expect(abort).toHaveBeenCalledTimes(2);
      expect(continueRequest).toHaveBeenCalledTimes(1);
    } finally {
      await manager.close();
    }
  });
});
