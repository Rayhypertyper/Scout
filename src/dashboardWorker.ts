import { runScout } from "./scout.js";
import type { ScoutRunOptions } from "./domain/types.js";
import { ActiveCrawlRunError } from "./database/db.js";

interface SerializedDashboardCrawl {
  sources: ScoutRunOptions["sources"];
  settings: ScoutRunOptions["settings"];
  filters: ScoutRunOptions["filters"];
}

function readOptions(): ScoutRunOptions {
  const raw = process.env.DASHBOARD_CRAWL_OPTIONS;
  if (!raw) throw new Error("DASHBOARD_CRAWL_OPTIONS is required for the dashboard crawl worker.");
  const parsed = JSON.parse(raw) as SerializedDashboardCrawl;
  if (!Array.isArray(parsed.sources) || parsed.sources.length === 0) {
    throw new Error("Dashboard crawl worker received no sources.");
  }
  return {
    sources: parsed.sources,
    settings: parsed.settings,
    filters: parsed.filters,
  };
}

async function main(): Promise<void> {
  await runScout(readOptions());
}

main().catch((error: unknown) => {
  // A calendar scout or a manual refresh may win the SQLite run lease between
  // the dashboard's preflight check and this worker's startRun transaction.
  // Treat that race as a no-op so the dashboard does not report a false scan
  // failure for work that is already in progress.
  if (error instanceof ActiveCrawlRunError) {
    console.warn(`[DASHBOARD CRAWL SKIPPED] ${error.message}`);
    return;
  }
  console.error(`[DASHBOARD CRAWL WORKER FAILED] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
