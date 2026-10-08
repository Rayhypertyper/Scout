import { AsyncLocalStorage } from "node:async_hooks";
import type { DatabaseSync } from "node:sqlite";
import type { AuthResponseState } from "../auth/types.js";

// HTTP requests always enter this scope, including anonymous requests. Offline
// tools may still use the original local decision store outside an HTTP scope.
export const accountActionScope = new AsyncLocalStorage<{ userId: string | null; responseState?: AuthResponseState }>();

export function accountActionUserId(): string | null | undefined {
  return accountActionScope.getStore()?.userId;
}

export function accountActionCacheKey(): string {
  const scope = accountActionScope.getStore();
  return JSON.stringify(scope ? { userId: scope.userId } : { offline: true });
}

/** A fixed table name plus a quoted, server-verified account identifier. */
export function listingActionReadTable(userId: string | null | undefined, identities = false): string {
  const legacy = identities ? "listing_action_identities" : "listing_actions";
  if (userId === undefined) return legacy;
  const table = identities ? "user_listing_action_identities" : "user_listing_actions";
  const predicate = userId === null ? "0" : `user_id = '${userId.replaceAll("'", "''")}'`;
  return `(SELECT rowid AS rowid, * FROM ${table} WHERE ${predicate})`;
}

export function accountActionReadTable(identities = false): string {
  return listingActionReadTable(accountActionUserId(), identities);
}

export function ensureAccountActionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_listing_actions (
      user_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      listing_type TEXT NOT NULL CHECK (listing_type IN ('internship', 'grind')),
      listing_id TEXT NOT NULL,
      action TEXT NOT NULL CHECK (action IN ('applied', 'cant_fit')),
      application_status TEXT NOT NULL DEFAULT 'pending' CHECK (application_status IN ('pending', 'accepted', 'rejected')),
      application_stage TEXT NOT NULL DEFAULT 'applied' CHECK (application_stage IN ('applied', 'oa', 'recruiter', 'interview', 'final', 'offer', 'rejected')),
      company TEXT NOT NULL,
      normalized_company TEXT NOT NULL,
      title TEXT NOT NULL,
      application_url TEXT,
      posting_url TEXT,
      job_id TEXT,
      location TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_id, listing_key),
      UNIQUE (user_id, listing_type, listing_id)
    );
    CREATE TABLE IF NOT EXISTS user_listing_action_identities (
      user_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      identity_key TEXT NOT NULL,
      direct_job_ids_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (user_id, listing_key, identity_key)
    );
    CREATE INDEX IF NOT EXISTS user_listing_action_identity_idx
      ON user_listing_action_identities(user_id, identity_key);
    CREATE TABLE IF NOT EXISTS account_action_migrations (name TEXT PRIMARY KEY);
  `);
  if (database.prepare("SELECT 1 FROM account_action_migrations WHERE name = 'legacy-quarantine-v1'").get()) return;

  const columns = database.prepare("PRAGMA table_info(listing_actions)").all() as unknown as Array<{ name: string }>;
  const owned = columns.some((column) => column.name === "user_id");
  const unowned = owned ? "user_id IS NULL OR trim(user_id) = '' OR user_id = '__legacy__'" : "1";
  // Preserve ambiguous records separately. Never infer ownership from the
  // first login, an email, a browser-supplied user_id, or the local operator.
  database.exec(`CREATE TABLE IF NOT EXISTS legacy_listing_actions_quarantine AS
    SELECT * FROM listing_actions WHERE ${unowned}`);
  if (owned) {
    database.exec(`
      INSERT OR IGNORE INTO user_listing_actions (
        user_id, listing_key, listing_type, listing_id, action, application_status, application_stage,
        company, normalized_company, title, application_url, posting_url, job_id, location, created_at
      ) SELECT user_id, listing_key, listing_type, listing_id, action, application_status, application_stage,
        company, normalized_company, title, application_url, posting_url, job_id, location, created_at
      FROM listing_actions WHERE NOT (${unowned});
    `);
    const identityColumns = database.prepare("PRAGMA table_info(listing_action_identities)").all() as unknown as Array<{ name: string }>;
    if (identityColumns.some((column) => column.name === "user_id")) {
      database.exec(`INSERT OR IGNORE INTO user_listing_action_identities
        SELECT user_id, listing_key, identity_key, direct_job_ids_json
        FROM listing_action_identities
        WHERE user_id IS NOT NULL AND trim(user_id) <> '' AND user_id <> '__legacy__'`);
    }
  }
  database.prepare("INSERT INTO account_action_migrations(name) VALUES ('legacy-quarantine-v1')").run();
}
