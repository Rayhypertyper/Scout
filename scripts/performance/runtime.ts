import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { PriorityQueue } from "../../src/crawler/queue.js";
import { backfillListingActionIdentities } from "../../src/database/actions.js";
import { InternshipDatabase } from "../../src/database/db.js";
import type { CrawlQueueItem, ListingIdentityHint } from "../../src/domain/types.js";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface Sample {
  milliseconds: number;
  checksum: string;
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

function positiveInteger(name: string, fallback: number): number {
  const value = Number(argument(name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function checksum(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function measure(operation: () => unknown): Sample {
  const startedAt = performance.now();
  const result = operation();
  const milliseconds = performance.now() - startedAt;
  return { milliseconds, checksum: checksum(result) };
}

async function measureAsync(operation: () => Promise<unknown>): Promise<Sample> {
  const startedAt = performance.now();
  const result = await operation();
  const milliseconds = performance.now() - startedAt;
  return { milliseconds, checksum: checksum(result) };
}

function summarize(samples: Sample[]) {
  if (new Set(samples.map((sample) => sample.checksum)).size !== 1) {
    throw new Error("Benchmark output changed between repetitions; timings are not comparable.");
  }
  const times = samples.map((sample) => sample.milliseconds).sort((left, right) => left - right);
  const middle = Math.floor(times.length / 2);
  const medianMs = times.length % 2 ? times[middle]! : (times[middle - 1]! + times[middle]!) / 2;
  return { medianMs, samplesMs: samples.map((sample) => sample.milliseconds), checksum: samples[0]!.checksum };
}

async function run(): Promise<void> {
  const sourcePath = resolve(argument("--database", join(PROJECT_ROOT, "output/live/internships.db")));
  const boardPath = resolve(argument("--board-cache", join(PROJECT_ROOT, "output/live/source-cache/grind-job-board.json")));
  const outputPath = resolve(argument("--json-output", join(PROJECT_ROOT, "output/performance/runtime-latest.json")));
  if (outputPath === sourcePath || outputPath === boardPath) throw new Error("Benchmark output must not overwrite an input fixture.");
  const repeats = positiveInteger("--samples", 5);
  const lookupCount = positiveInteger("--lookups", 250);
  const queueSize = positiveInteger("--queue-size", 10_000);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let snapshot: Uint8Array;
  try {
    snapshot = source.serialize();
  } finally {
    source.close();
  }
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-runtime-performance-"));
  const databasePath = join(directory, "fixture.db");
  const originalFetch = globalThis.fetch;
  let blockedNetworkRequests = 0;
  globalThis.fetch = () => {
    blockedNetworkRequests += 1;
    return Promise.reject(new Error("Runtime benchmark does not allow network requests."));
  };
  let dashboard: typeof import("../../src/dashboard.js") | undefined;
  let database: InternshipDatabase | undefined;
  let raw: DatabaseSync | undefined;
  try {
    writeFileSync(databasePath, snapshot);
    const boardCachePath = join(directory, "board.json");
    if (existsSync(boardPath)) writeFileSync(boardCachePath, readFileSync(boardPath));
    process.env.INTERNSHIPMATIC_ROOT = PROJECT_ROOT;
    process.env.SCOUT_DATABASE_PATH = databasePath;
    process.env.SCOUT_OUTPUT_DIR = directory;
    process.env.SCOUT_EDITION = "public";
    process.env.DASHBOARD_SKIP_LIVE_BOARD = "1";
    process.env.DASHBOARD_SKIP_STARTUP_SCAN = "1";
    process.env.GRIND_JOB_BOARD_CACHE_PATH = boardCachePath;

    const measurements: Record<string, Sample[]> = {};
    const record = (name: string, sample: Sample): void => {
      (measurements[name] ??= []).push(sample);
      process.stderr.write(`${name}: ${sample.milliseconds.toFixed(2)}ms\n`);
    };
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      record("databaseOpen", measure(() => {
        const opened = new InternshipDatabase(databasePath);
        opened.close();
        return "opened";
      }));
    }
    database = new InternshipDatabase(databasePath);
    raw = new DatabaseSync(databasePath);
    const counts = raw.prepare(`
      SELECT (SELECT COUNT(*) FROM internships) AS roles,
             (SELECT COUNT(*) FROM listing_actions) AS actions
    `).get();
    const largestSource = raw.prepare(`
      SELECT s.url, COUNT(*) AS listings FROM sources s
      JOIN internship_sources link ON link.source_id = s.id
      GROUP BY s.id ORDER BY listings DESC, s.id LIMIT 1
    `).get() as { url: string; listings: number } | undefined;
    if (!largestSource) throw new Error("The benchmark database needs at least one source with stored roles.");
    const hints = raw.prepare(`
      SELECT i.posting_url AS canonicalUrl, i.external_job_id AS externalJobId,
             i.content_hash AS contentHash
      FROM internships i JOIN internship_sources link ON link.internship_id = i.id
      JOIN sources s ON s.id = link.source_id WHERE s.url = ? ORDER BY i.id LIMIT ?
    `).all(largestSource.url, lookupCount) as unknown as ListingIdentityHint[];
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      record("listingLookups", measure(() => hints.map((hint) => {
        const result = database!.classifyListing(largestSource.url, hint);
        return [result.disposition, result.validatorsMatch, result.record?.internshipId, result.record?.contentHash];
      })));
      raw.exec("BEGIN IMMEDIATE");
      try {
        record("actionBackfill", measure(() => {
          backfillListingActionIdentities(raw!);
          return raw!.prepare("SELECT listing_key, identity_key, direct_job_ids_json FROM listing_action_identities ORDER BY listing_key, identity_key").all();
        }));
      } finally {
        raw.exec("ROLLBACK");
      }
    }
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      record("knownUrlsBySource", measure(() => database!.getKnownUrlsBySource([largestSource.url]).get(largestSource.url)?.length ?? 0));
    }
    raw.close();
    raw = undefined;
    database.close();
    database = undefined;

    const queueItems: CrawlQueueItem[] = Array.from({ length: queueSize }, (_, index) => ({
      url: `https://benchmark.invalid/jobs/${index}`,
      sourceUrl: "https://benchmark.invalid/jobs",
      referrerUrl: null,
      depth: 1,
      priority: (index * 7919) % 101,
      reason: "benchmark",
    }));
    const expectedOrder = checksum(queueItems.toSorted((left, right) => right.priority - left.priority).map((item) => item.url));
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      const sample = measure(() => {
        const queue = new PriorityQueue();
        for (const item of queueItems) queue.push(item);
        const result: string[] = [];
        while (queue.size) result.push(queue.pop()!.url);
        return result;
      });
      if (sample.checksum !== expectedOrder) throw new Error("Priority queue changed ordering or lost entries.");
      record("priorityQueue", sample);
    }

    dashboard = await import("../../src/dashboard.js");
    const request = async (url: string): Promise<unknown> => {
      const response = {
        statusCode: 0,
        body: Buffer.alloc(0),
        writeHead(status: number): void { this.statusCode = status; },
        end(body?: string | Buffer): void { this.body = body === undefined ? Buffer.alloc(0) : Buffer.from(body); },
      };
      await dashboard!.requestHandler({ method: "GET", url, headers: {} } as never, response as never, databasePath);
      if (response.statusCode !== 200) throw new Error(`Benchmark API returned ${response.statusCode}: ${response.body.toString("utf8")}`);
      const payload = JSON.parse(response.body.toString("utf8")) as { pagination: unknown; items: unknown[] };
      return { pagination: payload.pagination, items: payload.items };
    };
    for (let repeat = 0; repeat < repeats; repeat += 1) {
      dashboard.clearDashboardDataCacheForTests();
      record("dashboardColdList", await measureAsync(() => request("/api/roles?tab=internship&limit=8")));
      record("dashboardSeasonSort", await measureAsync(() => request("/api/roles?tab=internship&sort=season&limit=8")));
      // A multi-season filter used to rescan all listing text even on cache hits.
      await request("/api/roles?tab=internship&seasons=summer,fall&limit=8");
      record("dashboardCachedSeasonPage", await measureAsync(() => request("/api/roles?tab=internship&seasons=summer,fall&limit=8&offset=8")));
    }
    if (blockedNetworkRequests) throw new Error(`Benchmark attempted ${blockedNetworkRequests} network requests.`);
    const result = {
      benchmark: "runtime-performance.v1",
      capturedAt: new Date().toISOString(),
      node: process.version,
      fixture: { sha256: createHash("sha256").update(snapshot).digest("hex"), ...counts, largestSourceListings: largestSource.listings },
      workload: { samples: repeats, lookups: hints.length, queueSize, edition: "public" },
      isolation: { database: "temporary SQLite snapshot", sourceDatabaseReadOnly: true, networkRequests: blockedNetworkRequests },
      measurements: Object.fromEntries(Object.entries(measurements).map(([name, samples]) => [name, summarize(samples)])),
    };
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    console.table(Object.fromEntries(Object.entries(result.measurements).map(([name, value]) => [name, { medianMs: value.medianMs.toFixed(2) }])));
    console.log(`Saved ${outputPath}`);
  } finally {
    raw?.close();
    database?.close();
    dashboard?.stopDashboardRunWatcherForTests();
    dashboard?.closeFastRevisionTrackersForTests();
    dashboard?.clearDashboardDataCacheForTests();
    globalThis.fetch = originalFetch;
    rmSync(directory, { recursive: true, force: true });
  }
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
