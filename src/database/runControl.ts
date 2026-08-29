import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { activeRunMaxDurationMs, RUNNING_SCAN_MAX_AGE_MS } from "../config/runLock.js";

export interface RunTerminationResult {
  runId: number | null;
  requested: boolean;
  finalized: boolean;
}

export function ensureRunCancellationSchema(database: DatabaseSync): void {
  const columns = database.prepare("PRAGMA table_info(crawl_runs)").all() as unknown as Array<{ name: string }>;
  if (columns.length === 0) return;
  if (!columns.some((column) => column.name === "cancel_requested_at")) {
    database.exec("ALTER TABLE crawl_runs ADD COLUMN cancel_requested_at TEXT");
  }
}

/**
 * Finalize cancellation requests left behind by a worker that exited before
 * it could update its own run row. The cancellation marker is checked by the
 * worker before every persistence transaction, so finalizing here cannot make
 * a stale worker write into a later run.
 */
export function finalizeCancellationRequests(databasePath: string): number[] {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 30000");
    const crawlRunsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawl_runs'").get() as { name: string } | undefined;
    if (!crawlRunsTable) return [];
    ensureRunCancellationSchema(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      const rows = database.prepare(`
        SELECT id
        FROM crawl_runs
        WHERE status = 'RUNNING' AND cancel_requested_at IS NOT NULL
        ORDER BY id DESC
      `).all() as unknown as Array<{ id: number }>;
      if (rows.length === 0) {
        database.exec("COMMIT");
        return [];
      }
      database.prepare(`
        UPDATE crawl_runs
        SET finished_at = COALESCE(finished_at, @finishedAt),
            heartbeat_at = NULL,
            status = 'FAILED',
            error_message = COALESCE(error_message, 'Terminated by user.')
        WHERE status = 'RUNNING' AND cancel_requested_at IS NOT NULL
      `).run({ finishedAt: new Date().toISOString() });
      database.exec("COMMIT");
      return rows.map(({ id }) => id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

/**
 * Request and finalize the newest running crawl in one transaction. The
 * owning worker also receives the durable cancellation marker and will abort
 * any in-flight browser/network work it still controls.
 */
export function requestRunTermination(databasePath: string): RunTerminationResult {
  if (!existsSync(databasePath)) return { runId: null, requested: false, finalized: false };
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 30000");
    const crawlRunsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawl_runs'").get() as { name: string } | undefined;
    if (!crawlRunsTable) return { runId: null, requested: false, finalized: false };
    ensureRunCancellationSchema(database);
    database.exec("BEGIN IMMEDIATE");
    try {
      const run = database.prepare(`
        SELECT id
        FROM crawl_runs
        WHERE status = 'RUNNING'
        ORDER BY id DESC
        LIMIT 1
      `).get() as unknown as { id: number } | undefined;
      if (!run) {
        database.exec("COMMIT");
        return { runId: null, requested: false, finalized: false };
      }
      const requestedAt = new Date().toISOString();
      const result = database.prepare(`
        UPDATE crawl_runs
        SET cancel_requested_at = COALESCE(cancel_requested_at, @requestedAt),
            finished_at = COALESCE(finished_at, @finishedAt),
            heartbeat_at = NULL,
            status = 'FAILED',
            error_message = COALESCE(error_message, 'Terminated by user.')
        WHERE id = @runId AND status = 'RUNNING'
      `).run({ requestedAt, finishedAt: requestedAt, runId: run.id });
      database.exec("COMMIT");
      const finalized = Number(result.changes) > 0;
      return { runId: run.id, requested: finalized, finalized };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

/**
 * Close RUNNING rows whose heartbeat lease has expired so a dead worker cannot
 * look live until the next calendar scout. Cancel-requested rows are left for
 * `finalizeCancellationRequests`.
 */
export function failStaleRunningRuns(databasePath: string, now = Date.now()): number[] {
  if (!existsSync(databasePath)) return [];
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 30000");
    const crawlRunsTable = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'crawl_runs'").get() as { name: string } | undefined;
    if (!crawlRunsTable) return [];
    ensureRunCancellationSchema(database);
    const columns = database.prepare("PRAGMA table_info(crawl_runs)").all() as unknown as Array<{ name: string }>;
    const names = new Set(columns.map((column) => column.name));
    if (!names.has("started_at") || !names.has("status")) return [];
    const heartbeatExpr = names.has("heartbeat_at") ? "heartbeat_at" : "NULL";
    const cancelExpr = names.has("cancel_requested_at") ? "cancel_requested_at" : "NULL";
    const rows = database.prepare(`
      SELECT id, started_at, ${heartbeatExpr} AS heartbeat_at, ${cancelExpr} AS cancel_requested_at
      FROM crawl_runs
      WHERE status = 'RUNNING'
      ORDER BY id DESC
    `).all() as unknown as Array<{ id: number; started_at: string; heartbeat_at: string | null; cancel_requested_at: string | null }>;
    const staleRuns = rows.filter((run) => {
      if (run.cancel_requested_at !== null) return false;
      const startedAt = Date.parse(run.started_at);
      const hardExpired = Number.isFinite(startedAt) && now - startedAt >= activeRunMaxDurationMs();
      const leaseAt = Date.parse(run.heartbeat_at ?? run.started_at);
      return hardExpired || (Number.isFinite(leaseAt) && now - leaseAt >= RUNNING_SCAN_MAX_AGE_MS);
    });
    if (staleRuns.length === 0) return [];
    database.exec("BEGIN IMMEDIATE");
    try {
      const finishedAt = new Date(now).toISOString();
      const heartbeatClear = names.has("heartbeat_at") ? "heartbeat_at = NULL," : "";
      const statement = database.prepare(`
        UPDATE crawl_runs
        SET finished_at = @finishedAt, ${heartbeatClear} status = 'FAILED',
            cancel_requested_at = CASE WHEN started_at <= @hardDeadline
              THEN COALESCE(cancel_requested_at, @finishedAt)
              ELSE cancel_requested_at
            END,
            error_message = COALESCE(error_message, CASE WHEN started_at <= @hardDeadline
              THEN 'Crawl exceeded the maximum wall-clock duration.'
              ELSE 'Marked stale after exceeding the maximum crawl duration.'
            END)
        WHERE id = @id AND status = 'RUNNING'
      `);
      const hardDeadline = new Date(now - activeRunMaxDurationMs()).toISOString();
      for (const { id } of staleRuns) statement.run({ finishedAt, hardDeadline, id });
      database.exec("COMMIT");
      return staleRuns.map(({ id }) => id);
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
