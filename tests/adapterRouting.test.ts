import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { SourceAdapterRouter } from "../src/crawler/adapters/router.js";
import type { SourceAdapter, SourceAdapterResult } from "../src/crawler/adapters/types.js";
import { HttpClient } from "../src/crawler/http.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function makeRouter(adapters: SourceAdapter[] = []): SourceAdapterRouter {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-routing-"));
  temporaryDirectories.push(directory);
  const settings = resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "crawl.db"),
    retryCount: 0,
    perHostDelayMs: 0,
  });
  const logger = new Logger("error");
  return new SourceAdapterRouter(settings, logger, new HttpClient(settings, logger), adapters);
}

function failure(sourceUrl: string, url = sourceUrl): SourceAdapterResult["failures"][number] {
  return {
    sourceUrl,
    url,
    errorType: "http_error",
    message: "structured endpoint unavailable",
    statusCode: 503,
    retryCount: 0,
    occurredAt: new Date().toISOString(),
  };
}

describe("source adapter routing contracts", () => {
  it("prefers known structured adapters before the generic static route", () => {
    const router = makeRouter();

    expect(router.route("https://github.com/acme/internships")?.name).toBe("GitHub");
    expect(router.route("https://boards.greenhouse.io/acme/jobs")?.name).toBe("Greenhouse");
    expect(router.route("https://jobs.lever.co/acme")?.name).toBe("Lever");
    expect(router.route("https://acme.wd5.myworkdayjobs.com/en-US/careers")?.name).toBe("Workday");
    expect(router.route("https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus")?.name).toBe("Early Career Radar");
    expect(router.route("https://internship-radar-2027.yuxhuang.com/?locations=country%3ACanada%7Cus")?.name).toBe("Early Career Radar");
    expect(router.route("https://ordinary.example/careers")?.name).toBe("Static HTML");
    expect(router.route("https://ordinary.example/careers")?.strategy).toBe("static_html");
  });

  it("falls from a failed structured endpoint to static HTTP without invoking a browser", async () => {
    const structured: SourceAdapter = {
      name: "Test structured",
      strategy: "structured_endpoint",
      canHandle: (sourceUrl) => new URL(sourceUrl).hostname === "structured.example",
      collect: async (sourceUrl) => ({
        snapshots: [],
        retrievalMethod: "test structured endpoint",
        retrievalUrls: [sourceUrl],
        attempts: 1,
        httpStatus: 503,
        notes: ["structured failed"],
        failures: [failure(sourceUrl)],
        strategy: "structured_endpoint",
      }),
    };
    const router = makeRouter([structured]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><head><title>Fallback</title></head><body><main>Software Engineering Intern</main></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));

    const result = await router.collect("https://structured.example/careers");

    expect(result.strategy).toBe("static_html");
    expect(result.browserRequired).not.toBe(true);
    expect(result.retrievalMethod).toContain("static HTTP fallback");
    expect(result.notes).toEqual(expect.arrayContaining(["structured failed"]));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const firstRequest = fetchMock.mock.calls[0]?.[0];
    const firstRequestUrl = typeof firstRequest === "string"
      ? firstRequest
      : firstRequest instanceof URL
        ? firstRequest.toString()
        : firstRequest?.url;
    expect(firstRequestUrl).toBe("https://structured.example/careers");
  });

  it("marks a JavaScript shell browser-required while keeping routing transport-only", async () => {
    const router = makeRouter();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(
      "<html><body><div id='root'></div><script>window.__next_f=[]</script></body></html>",
      { status: 200, headers: { "content-type": "text/html" } },
    ));

    const result = await router.collect("https://dynamic.example/careers");

    expect(result.strategy).toBe("browser_required");
    expect(result.browserRequired).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
