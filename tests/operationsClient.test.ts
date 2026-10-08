/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  OperationsAccessError,
  diagnosticText,
  readOperations,
  renderOperationsMarkup,
} from "../public/admin/operations.js";
// @ts-expect-error The browser client is JavaScript and has no emitted declaration file.
import { crawlProgressMessage, provenanceSourceRows } from "../public/app.js";
// @ts-expect-error The browser client is JavaScript and has no emitted declaration file.
import { normalizePublicFreshness, publicFreshnessPresentation } from "../public/app/freshness.js";

const now = Date.parse("2026-08-31T16:00:00.000Z");

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    contract: "operations.v1",
    schemaVersion: 1,
    generatedAt: "2026-08-31T15:00:00.000Z",
    status: "healthy",
    dataState: "ready",
    database: { available: true, schemaReady: true },
    freshness: {
      state: "fresh",
      lastSuccessfulCrawlAt: "2026-08-31T14:00:00.000Z",
      ageMs: 7_200_000,
      expectedSources: 2,
      trustedSources: 2,
      staleSources: 0,
      latestTrustedRunId: 7,
      fullCoverage: true,
    },
    activeRun: null,
    latestRun: {
      id: 7,
      status: "COMPLETED",
      startedAt: "2026-08-31T13:59:00.000Z",
      finishedAt: "2026-08-31T14:00:00.000Z",
      durationMs: 60_000,
      sourcesRequested: 2,
      sourcesSettled: 2,
      sourcesCompleted: 2,
      rolesEntered: 3,
      rolesChanged: 4,
      rolesClosed: 1,
      rolesUnchanged: 8,
      rolesDiscovered: 16,
      duplicateListingsSkipped: 2,
      pagesVisited: 40,
    },
    runs: [],
    sources: [],
    anomalies: [],
    metrics: { latestRun: null, durationTrend: "flat", durationBaselineMs: 60_000, durationSamples: 4 },
    failureSummary: [],
    ...overrides,
  };
}

describe("private operations browser client", () => {
  it("escapes diagnostic text and strips URL paths before rendering", () => {
    const payload = snapshot({
      anomalies: [{
        code: "ZERO_YIELD",
        severity: "warning",
        scope: "source",
        runId: 7,
        sourceId: 2,
        sourceUrl: "https://user:pass@example.test/careers?token=secret",
        observed: 0,
        baseline: 12,
        threshold: 0,
        unit: "roles",
        explanation: "https://user:pass@example.test/careers?token=secret returned <script>alert(1)</script>",
        detectedAt: "2026-08-31T14:01:00.000Z",
      }],
      sources: [{
        sourceId: 2,
        url: "https://user:pass@example.test/careers?token=secret",
        configured: true,
        attempts: 2,
        successes: 1,
        failures: 1,
        successRate: .5,
        consecutiveFailures: 1,
        stale: false,
        lastSuccessAt: "2026-08-31T14:00:00.000Z",
        lastError: "GET https://user:pass@example.test/private?token=secret failed <b>bad</b>",
        yield: { observed: 0, baseline: 12, ratio: 0, samples: 4 },
        duration: { observedMs: 120_000, baselineMs: 60_000, samples: 4 },
        rateLimitCount: 1,
        browserFallbacks: 1,
        latest: { status: "failed", completed: false, error: "<failure>" },
      }],
    });
    const markup = renderOperationsMarkup(payload, { now });
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    expect(markup).not.toContain("/careers?token=secret");
    expect(markup).toContain("example.test");
    expect(markup).not.toContain("<a href");
    expect(diagnosticText("GET https://example.test/a?token=secret failed")).toBe("GET example.test failed");
  });

  it("does not call an unavailable database healthy and keeps no-data explicit", () => {
    const markup = renderOperationsMarkup(snapshot({
      status: "unavailable",
      dataState: "no_data",
      database: { available: false, schemaReady: false },
      freshness: { state: "unknown", lastSuccessfulCrawlAt: null, ageMs: null, expectedSources: 0, trustedSources: 0, staleSources: 0, fullCoverage: false },
      latestRun: null,
      anomalies: [{ code: "NO_DATA", severity: "info", scope: "database", explanation: "No database" }],
    }), { now });
    expect(markup).toContain("Database unavailable");
    expect(markup).toContain("No crawl data");
    expect(markup).not.toContain("Operating normally");
  });

  it("renders stale, failure, and warmup states with evidence instead of inferred health", () => {
    const payload = snapshot({
      status: "degraded",
      dataState: "warmup",
      freshness: { state: "stale", lastSuccessfulCrawlAt: "2026-08-29T10:00:00.000Z", ageMs: 190_000_000, expectedSources: 3, trustedSources: 1, staleSources: 2, fullCoverage: false },
      anomalies: [{ code: "STALE_DATABASE", severity: "warning", scope: "database", runId: 7, observed: 190_000_000, baseline: 86_400_000, threshold: 86_400_000, unit: "ms", explanation: "The trusted update is old.", detectedAt: "2026-08-31T15:00:00.000Z" }],
    });
    const markup = renderOperationsMarkup(payload, { now });
    expect(markup).toContain("Needs attention");
    expect(markup).toContain("Baselines warming");
    expect(markup).toContain("Database freshness is stale");
    expect(markup).toContain("Observed");
    expect(markup).toContain("Run #7");
  });

  it("maps denied API responses to a generic access error", async () => {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    const deniedFetch = async (url: string, init?: RequestInit) => {
      requestedUrl = url;
      requestedInit = init;
      return new Response(JSON.stringify({ error: "owner email leaked" }), { status: 403 });
    };
    await expect(readOperations(deniedFetch)).rejects.toBeInstanceOf(OperationsAccessError);
    expect(requestedUrl).toBe("/api/admin/operations");
    expect(requestedInit).toMatchObject({ cache: "no-store", credentials: "same-origin" });
  });

  it("keeps ordinary dashboard source and failure text out of the public projection", () => {
    const publicPayload = {
      capabilities: { crawlerAdministration: false },
      scan: { currentSource: { url: "https://internal.example/private" }, error: "secret failure" },
      latestRun: { error_message: "secret failure" },
      sources: [{ url: "https://internal.example/private" }],
      sourceResults: [{ url: "https://internal.example/private" }],
    };
    expect(provenanceSourceRows(publicPayload)).toEqual([]);
    expect(crawlProgressMessage(publicPayload)).toBe("Catalog status is available.");
    const freshness = publicFreshnessPresentation({
      generatedAt: "2026-08-31T15:00:00.000Z",
      freshness: { state: "partial", lastSuccessfulCrawlAt: "2026-08-31T14:00:00.000Z", expectedSources: 3, trustedSources: 2, staleSources: 1 },
    }, { now });
    expect(freshness).not.toHaveProperty("sources");
    expect(freshness).not.toHaveProperty("sourceUrl");
    expect(normalizePublicFreshness(publicPayload)).toMatchObject({ state: "unknown", lastSuccessfulCrawlAt: null });
  });

  it("ships the dedicated private page and public status assets", () => {
    const operationsPage = readFileSync(new URL("../public/admin/operations.html", import.meta.url), "utf8");
    const operationsStyle = readFileSync(new URL("../public/admin/operations.css", import.meta.url), "utf8");
    const operationsClient = readFileSync(new URL("../public/admin/operations.js", import.meta.url), "utf8");
    const jobsPage = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
    expect(operationsClient).toContain("/api/admin/operations");
    expect(operationsPage).toContain("Private owner operations");
    expect(operationsPage).toContain("operations-v1");
    expect(operationsStyle).toContain("@media (max-width: 700px)");
    expect(operationsClient).toContain("document.visibilityState");
    expect(operationsClient).toContain("operations.v1");
    expect(jobsPage).toContain('id="catalog-freshness"');
    expect(jobsPage).toContain('href="/catalog-freshness.css"');
  });
});
