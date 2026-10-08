import "./config/env.js";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { activeRunMaxDurationMs, RUNNING_SCAN_MAX_AGE_MS } from "./config/runLock.js";
import { readMacPowerState, type MacPowerState } from "./config/macPowerState.js";
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

export interface SchedulerRuntime {
  platform?: NodeJS.Platform;
  now?: () => number;
  probePowerState?: () => Promise<MacPowerState>;
  databaseCrawlDue?: (databasePath: string) => boolean;
  spawnWorker?: typeof spawn;
  log?: Pick<Console, "log" | "error">;
  onWorkerChange?: (worker: ChildProcess | null) => void;
}

/** Build one serialized scheduler tick so the power gate can be exercised without launchd. */
export function createSchedulerTick(
  databasePath: string,
  outputDirectory: string,
  runtime: SchedulerRuntime = {},
): () => Promise<void> {
  let worker: ChildProcess | null = null;
  let retryAfter = 0;
  let workerStartedAt = 0;
  let tickInProgress = false;
  let lastDeferredPowerState: MacPowerState | null = null;
  const platform = runtime.platform ?? process.platform;
  const now = runtime.now ?? Date.now;
  const probePowerState = runtime.probePowerState ?? readMacPowerState;
  const isDue = runtime.databaseCrawlDue ?? databaseCrawlDue;
  const spawnWorker = runtime.spawnWorker ?? spawn;
  const log = runtime.log ?? console;

  return async (): Promise<void> => {
    if (tickInProgress) return;
    tickInProgress = true;
    try {
      if (worker) {
        if (now() - workerStartedAt >= activeRunMaxDurationMs() + 60_000) {
          log.error("[SCHEDULER] Stopping worker past its wall-clock limit");
          worker.kill("SIGKILL");
        }
        return;
      }
      if (now() < retryAfter) return;

      try {
        if (!isDue(databasePath)) return;
      } catch (error) {
        retryAfter = now() + CRAWL_RETRY_MS;
        log.error(`[SCHEDULER] ${error instanceof Error ? error.message : String(error)}`);
        return;
      }

      if (platform === "darwin") {
        let powerState: MacPowerState;
        try { powerState = await probePowerState(); }
        catch { powerState = "unknown"; }
        if (powerState !== "full-wake") {
          if (powerState !== lastDeferredPowerState) {
            const reason = powerState === "dark-wake"
              ? "macOS is in dark wake"
              : "macOS full wake could not be confirmed";
            log.log(`[SCHEDULER] Deferring scheduled crawl: ${reason}.`);
            lastDeferredPowerState = powerState;
          }
          return;
        }
        if (lastDeferredPowerState !== null) {
          log.log("[SCHEDULER] macOS full wake confirmed; scheduled crawling resumed.");
          lastDeferredPowerState = null;
        }
      }

      try {
        // The macOS power probe is asynchronous; recheck the lease after it so
        // an intervening manual crawl cannot race this scheduled spawn.
        if (platform === "darwin" && !isDue(databasePath)) return;
        log.log(`[SCHEDULER] Crawl due at ${new Date(now()).toISOString()}`);
        workerStartedAt = now();
        worker = spawnWorker(process.execPath, [fileURLToPath(new URL("./index.js", import.meta.url)),
          "--database", databasePath, "--output-dir", outputDirectory], { stdio: "inherit", env: process.env });
        runtime.onWorkerChange?.(worker);
        worker.once("error", (error) => log.error(`[SCHEDULER] ${error.message}`));
        worker.once("close", () => {
          worker = null;
          runtime.onWorkerChange?.(null);
          retryAfter = now() + CRAWL_RETRY_MS;
        });
      } catch (error) {
        retryAfter = now() + CRAWL_RETRY_MS;
        log.error(`[SCHEDULER] ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      tickInProgress = false;
    }
  };
}

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback;
}

export function startScheduler(databasePath: string, outputDirectory: string): void {
  let worker: ChildProcess | null = null;
  const tick = createSchedulerTick(databasePath, outputDirectory, {
    onWorkerChange: (current) => { worker = current; },
  });
  const timer = setInterval(() => { void tick(); }, 60_000);
  void tick();
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.once(signal, () => {
      clearInterval(timer);
      if (worker) {
        worker.once("close", () => process.exit(0));
        worker.kill("SIGTERM");
      } else process.exit(0);
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const databasePath = resolve(argument("--database", process.env.SCOUT_DATABASE_PATH ?? "output/live/internships.db"));
  startScheduler(databasePath, resolve(argument("--output-dir", process.env.SCOUT_OUTPUT_DIR ?? dirname(databasePath))));
}
