import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { SOURCES } from "./sources.js";
import { canonicalizeUrl } from "../utils/url.js";

export const STATIC_CONFIGURED_SOURCES = [...new Set(SOURCES.map((source) => canonicalizeUrl(source)))];

function hasDatabaseColumn(database: DatabaseSync, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

export function readConfiguredSources(database: DatabaseSync): string[] {
  const configured = new Set(STATIC_CONFIGURED_SOURCES);
  try {
    if (!hasDatabaseColumn(database, "sources", "is_configured")) return [...configured].toSorted();
    const rows = database.prepare("SELECT url FROM sources WHERE is_configured = 1 ORDER BY url").all() as unknown as Array<{ url: string }>;
    for (const row of rows) {
      if (row.url) configured.add(canonicalizeUrl(row.url));
    }
  } catch {
    // Keep the static catalog available while a legacy or unavailable store
    // is being migrated.
  }
  return [...configured].toSorted();
}

export function readConfiguredSourcesAtPath(databasePath: string): string[] {
  if (!existsSync(databasePath)) return [...STATIC_CONFIGURED_SOURCES].toSorted();
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    return readConfiguredSources(database);
  } catch {
    return [...STATIC_CONFIGURED_SOURCES].toSorted();
  } finally {
    database?.close();
  }
}
