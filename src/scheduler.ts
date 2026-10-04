import "./config/env.js";

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { activeRunMaxDurationMs, RUNNING_SCAN_MAX_AGE_MS } from "./config/runLock.js";
import { readConfiguredSourcesAtPath } from "./config/sourceCatalog.js";

export const CRAWL_INTERVAL_MS = 90 * 60_000;
export const CRAWL_RETRY_MS = 5 * 60_000;

interface ScheduledRun {
  started_at: string;
  finished_at: string | null;
  heartbeat_at: string | null;
  status: string;
  options_json: string;
}

/** Partial/manual source checks must not postpone the full catalog crawl. */
export function isCrawlDue(runs: ScheduledRun[], sources: string[], now = Date.now()): boolean {
  if (runs.some((run) => run.status === "RUNNING"
    && now - Date.parse(run.started_at) < activeRunMaxDurationMs()
    && now - Date.parse(run.heartbeat_at ?? run.started_at) < RUNNING_SCAN_MAX_AGE_MS)) return false;
  const fullRuns = runs.filter((run) => {
    try {
      const options = JSON.parse(run.options_json) as { sources?: string[] };
      return Array.isArray(options.sources) && sources.every((source) => options.sources!.includes(source));
    } catch { return false; }
  });
  if (fullRuns.some((run) => run.status === "COMPLETED"
    && now - Date.parse(run.started_at) < CRAWL_INTERVAL_MS)) return false;
  // Back off after failures/cancellation, including across scheduler restarts.
  return !fullRuns.some((run) => run.finished_at !== null
    && now - Date.parse(run.finished_at) < CRAWL_RETRY_MS);
}

export function databaseCrawlDue(databasePath: string): boolean {
  if (!existsSync(databasePath)) return true;
  const sources = readConfiguredSourcesAtPath(databasePath);
  if (sources.length === 0) return false;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    database.exec("PRAGMA busy_timeout = 1000");
    // Recent rows suffice for freshness; keep every RUNNING lease regardless of age.
    const runs = database.prepare(`SELECT started_at, finished_at, heartbeat_at, status, options_json
      FROM crawl_runs WHERE status = 'RUNNING' OR started_at >= ? OR finished_at >= ?`)
      .all(new Date(Date.now() - CRAWL_INTERVAL_MS).toISOString(),
        new Date(Date.now() - CRAWL_RETRY_MS).toISOString()) as unknown as ScheduledRun[];
    return isCrawlDue(runs, sources);
  } finally { database.close(); }
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

export function startScheduler(databasePath: string, outputDirectory: string): void {
  let worker: ReturnType<typeof spawn> | null = null;
  let retryAfter = 0;
  let workerStartedAt = 0;
  const tick = (): void => {
    if (worker) {
      if (Date.now() - workerStartedAt >= activeRunMaxDurationMs() + 60_000) {
        console.error("[SCHEDULER] Stopping worker past its wall-clock limit");
        worker.kill("SIGKILL");
      }
      return;
    }
    if (Date.now() < retryAfter) return;
    try {
      if (!databaseCrawlDue(databasePath)) return;
      console.log(`[SCHEDULER] Crawl due at ${new Date().toISOString()}`);
      workerStartedAt = Date.now();
      worker = spawn(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)),
        "--database", databasePath, "--output-dir", outputDirectory], { stdio: "inherit", env: process.env });
      worker.once("error", (error) => console.error(`[SCHEDULER] ${error.message}`));
      worker.once("close", () => { worker = null; retryAfter = Date.now() + CRAWL_RETRY_MS; });
    } catch (error) {
      retryAfter = Date.now() + CRAWL_RETRY_MS;
      console.error(`[SCHEDULER] ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  const timer = setInterval(tick, 60_000);
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      if (worker) {
        worker.once("close", () => process.exit(0));
        worker.kill("SIGTERM");
      } else process.exit(0);
    });
  }
  tick();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databasePath = resolve(argument("--database", process.env.SCOUT_DATABASE_PATH ?? "output/live/internships.db"));
  startScheduler(databasePath, resolve(argument("--output-dir", process.env.SCOUT_OUTPUT_DIR ?? dirname(databasePath))));
}
