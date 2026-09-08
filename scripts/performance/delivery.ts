import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import {
  clearResponseRepresentationCacheForTests,
  encodeResponseBody,
  getResponseRepresentationCacheStatsForTests,
  jsonResponseBody,
} from "../../src/dashboard/http.js";
import {
  clearStaticDeliveryCachesForTests,
  getStaticDeliveryCacheStatsForTests,
  serveStatic,
} from "../../src/dashboard/static.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const DEFAULT_OUTPUT = "/tmp/scout-dashboard-delivery-after.json";
const SAMPLE_COUNT = 100;

interface CapturedResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: Buffer;
  elapsedMs?: number;
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
  method = "GET",
  headers: Record<string, string> = {},
): Record<string, unknown> {
  return { method, url, headers };
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function decodedBody(captured: CapturedResponse): Buffer {
  if (captured.headers["Content-Encoding"] === "br") return brotliDecompressSync(captured.body);
  if (captured.headers["Content-Encoding"] === "gzip") return gunzipSync(captured.body);
  return captured.body;
}

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index] ?? 0;
}

function timingSummary(values: number[]): {
  repeats: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
} {
  return {
    repeats: values.length,
    medianMs: percentile(values, 0.5),
    p95Ms: percentile(values, 0.95),
    minMs: Math.min(...values),
    maxMs: Math.max(...values),
  };
}

function responseSummary(captured: CapturedResponse): Record<string, unknown> {
  return {
    status: captured.statusCode,
    responseHeaders: captured.headers,
    wireBytes: captured.body.byteLength,
    decodedBytes: captured.statusCode === 304 ? 0 : decodedBody(captured).byteLength,
    ...(captured.elapsedMs === undefined ? {} : { elapsedMs: captured.elapsedMs }),
  };
}

async function staticCapture(
  path: string,
  method = "GET",
  headers: Record<string, string> = {},
): Promise<CapturedResponse> {
  const captured = response();
  const started = nowMs();
  await serveStatic(
    request(path, method, headers) as never,
    captured as never,
    path.split("?", 1)[0] ?? path,
    { publicRoot: PUBLIC_ROOT },
  );
  captured.elapsedMs = nowMs() - started;
  return captured;
}

function jsonCapture(
  body: string,
  headers: Record<string, string> = {},
  method = "GET",
  etag?: string,
): CapturedResponse {
  const captured = response();
  const started = nowMs();
  jsonResponseBody(captured as never, 200, body, {
    request: request("/api/roles", method, headers) as never,
    ...(etag === undefined ? {} : { etag }),
  });
  captured.elapsedMs = nowMs() - started;
  return captured;
}

function sampleJsonBody(): string {
  return JSON.stringify({
    contract: "dashboard.roles.v1",
    version: "baseline",
    pagination: { limit: 40, offset: 0, total: 400, hasMore: true, nextOffset: 40 },
    items: Array.from({ length: 40 }, (_, index) => ({
      listingType: "internship",
      listingId: String(index + 1),
      company: `Example Company ${index}`,
      title: "Software Engineering Intern",
      location: ["Toronto, ON, Canada"],
      remoteStatus: "hybrid",
      postingUrl: `https://example.com/jobs/${index}`,
      applicationUrl: `https://example.com/apply/${index}`,
      description: "A role description with repeated text for representative payload compression.",
      technologies: ["TypeScript", "Node.js", "SQL"],
      categories: ["swe"],
      isNew: index < 4,
    })),
  });
}

async function measureStatic(): Promise<{ assets: Record<string, unknown>[]; cache: Record<string, unknown> }> {
  clearStaticDeliveryCachesForTests();
  clearResponseRepresentationCacheForTests();
  const requestedAssets = [
    "/",
    "/jobs/",
    "/styles.css",
    "/redesign.css",
    "/catalog-freshness.css",
    "/conversion.css",
    "/themed-select.css",
    "/themed-select.js",
    "/app.js",
    "/vendor/gsap.min.js",
    "/vendor/ScrollTrigger.min.js",
    "/landing.css",
    "/landing.js",
    "/landing-motion.js",
    "/conversion.js",
    "/fonts/geist/Geist-Regular.woff2",
    "/fonts/geist/Geist-Medium.woff2",
    "/fonts/geist/Geist-SemiBold.woff2",
    "/fonts/geist/Geist-Bold.woff2",
    "/fonts/geist/GeistMono-Medium.woff2",
    "/fonts/geist/GeistMono-SemiBold.woff2",
    "/fonts/outfit/Outfit-latin.woff2",
    "/fonts/outfit/Outfit-latin-ext.woff2",
    "/assets/brand/scout-logo-2x.png",
    "/assets/brand/scout-favicon-2x.png",
    "/assets/brand/scout-icon-2x.png",
    "/site.webmanifest",
  ].filter((path) => path === "/jobs/" || existsSync(join(PUBLIC_ROOT, path.slice(1))));
  const assets: Record<string, unknown>[] = [];
  for (const path of requestedAssets) {
    const identity = await staticCapture(path, "GET", { "accept-encoding": "identity" });
    const br = await staticCapture(path, "GET", { "accept-encoding": "br, gzip" });
    const warm = await staticCapture(path, "GET", { "accept-encoding": "br, gzip" });
    const head = await staticCapture(path, "HEAD", { "accept-encoding": "br, gzip" });
    const unchanged = await staticCapture(path, "GET", {
      "accept-encoding": "br",
      "if-none-match": br.headers.ETag ?? "",
    });
    assets.push({
      path,
      identity: responseSummary(identity),
      br: responseSummary(br),
      warm: responseSummary(warm),
      head: responseSummary(head),
      etag304: responseSummary(unchanged),
    });
  }
  return {
    assets,
    cache: getStaticDeliveryCacheStatsForTests(),
  };
}

function measureCompression(body: Buffer, encoding: "br" | "gzip"): Record<string, unknown> {
  const samples: number[] = [];
  let encodedBytes = 0;
  for (let index = 0; index < SAMPLE_COUNT; index += 1) {
    clearResponseRepresentationCacheForTests();
    const started = nowMs();
    const encoded = encodeResponseBody(body, request("/api/roles", "GET", { "accept-encoding": encoding }) as never);
    samples.push(nowMs() - started);
    encodedBytes = encoded.body.byteLength;
  }
  return { ...timingSummary(samples), encodedBytes, algorithm: encoding === "br" ? "brotli-quality-5" : "gzip-default" };
}

function measureJson(body: string): Record<string, unknown> {
  clearResponseRepresentationCacheForTests();
  const variants = [
    ["identity", { "accept-encoding": "identity" }],
    ["br", { "accept-encoding": "br, gzip" }],
    ["gzip", { "accept-encoding": "gzip, br;q=0.2" }],
    ["br-explicit", { "accept-encoding": "gzip;q=0.5, br;q=1" }],
    ["br-disabled", { "accept-encoding": "br;q=0, gzip;q=0" }],
  ] as const;
  const results = variants.map(([label, headers]) => {
    const captured = jsonCapture(body, headers);
    return { label, headers, ...responseSummary(captured) };
  });
  const etag = "\"delivery-after\"";
  const etagResponse = jsonCapture(body, { "accept-encoding": "br" }, "GET", etag);
  const unchanged = jsonCapture(body, {
    "accept-encoding": "gzip",
    "if-none-match": etag,
  }, "GET", etag);
  const beforeHead = getResponseRepresentationCacheStatsForTests();
  const head = jsonCapture(body, { "accept-encoding": "br" }, "HEAD", "\"delivery-head\"");
  const afterHead = getResponseRepresentationCacheStatsForTests();
  return {
    bodyBytes: Buffer.byteLength(body),
    variants: results,
    etag: responseSummary(etagResponse),
    etag304: responseSummary(unchanged),
    head: responseSummary(head),
    headCacheUnchanged: JSON.stringify(beforeHead) === JSON.stringify(afterHead),
    representationCache: afterHead,
  };
}

async function run(): Promise<void> {
  const body = Buffer.from(sampleJsonBody(), "utf8");
  const staticResult = await measureStatic();
  const jsonResult = measureJson(body.toString("utf8"));
  const output = {
    schemaVersion: 1,
    benchmark: "dashboard-delivery-direct-after",
    capturedAt: new Date().toISOString(),
    node: process.version,
    sourceRoot: PROJECT_ROOT,
    publicRoot: PUBLIC_ROOT,
    fixture: { jsonBodyBytes: body.byteLength },
    static: staticResult.assets,
    staticCache: staticResult.cache,
    json: jsonResult,
    repeatedCompression: {
      br: measureCompression(body, "br"),
      gzip: measureCompression(body, "gzip"),
    },
    notes: [
      "Local in-process probe; no browser, external network, database, or production writes.",
      "HEAD skips synchronous compression; coded GETs omit HEAD Content-Length while identity GETs retain the raw length.",
      "Static cache uses stat fingerprint invalidation and bounded body/template entries.",
    ],
  };
  const outputPath = process.argv[2] ?? DEFAULT_OUTPUT;
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`);
  process.stdout.write(`${outputPath}\n`);
}

await run();
