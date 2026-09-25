import type { DatabaseSync } from "node:sqlite";

export interface DashboardRevisionCounters {
  roles: number;
  memberships: number;
  actions: number;
  identities: number;
}

const REVISION_TRIGGERS = [
  "dashboard_revision_internships_insert",
  "dashboard_revision_internships_update",
  "dashboard_revision_internships_delete",
  "dashboard_revision_memberships_insert",
  "dashboard_revision_memberships_update",
  "dashboard_revision_memberships_delete",
  "dashboard_revision_actions_insert",
  "dashboard_revision_actions_update",
  "dashboard_revision_actions_delete",
  "dashboard_revision_identities_insert",
  "dashboard_revision_identities_update",
  "dashboard_revision_identities_delete",
] as const;

/**
 * Install durable content-domain counters before the dashboard begins serving
 * requests. Triggers are deliberately scoped to tables whose rows contribute
 * to the compact role index; crawl heartbeat/progress writes stay separate.
 */
export function ensureDashboardRevisionSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS dashboard_revisions (
      domain TEXT PRIMARY KEY,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    );
    CREATE INDEX IF NOT EXISTS run_internships_internship_status_idx
      ON run_internships(internship_id, lifecycle_status);
    INSERT OR IGNORE INTO dashboard_revisions (domain, revision) VALUES
      ('roles', 0), ('memberships', 0), ('actions', 0), ('identities', 0);

    CREATE TRIGGER IF NOT EXISTS dashboard_revision_internships_insert
    AFTER INSERT ON internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'roles';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_internships_update
    AFTER UPDATE OF id, job_id, company, normalized_company, title, normalized_title, location_key,
      application_url, posting_url, payload_json, content_hash, lifecycle_status, availability_status,
      first_seen_at, last_seen_at, last_seen_run_id, last_verified_at, status_run_id, miss_count,
      canonical_url, canonical_application_url, canonical_posting_url, external_job_id, provider_identity
    ON internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'roles';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_internships_delete
    AFTER DELETE ON internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'roles';
    END;

    CREATE TRIGGER IF NOT EXISTS dashboard_revision_memberships_insert
    AFTER INSERT ON run_internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'memberships';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_memberships_update
    AFTER UPDATE ON run_internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'memberships';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_memberships_delete
    AFTER DELETE ON run_internships BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'memberships';
    END;

    CREATE TRIGGER IF NOT EXISTS dashboard_revision_actions_insert
    AFTER INSERT ON listing_actions BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'actions';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_actions_update
    AFTER UPDATE ON listing_actions BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'actions';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_actions_delete
    AFTER DELETE ON listing_actions BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'actions';
    END;

    CREATE TRIGGER IF NOT EXISTS dashboard_revision_identities_insert
    AFTER INSERT ON listing_action_identities BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'identities';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_identities_update
    AFTER UPDATE ON listing_action_identities BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'identities';
    END;
    CREATE TRIGGER IF NOT EXISTS dashboard_revision_identities_delete
    AFTER DELETE ON listing_action_identities BEGIN
      UPDATE dashboard_revisions SET revision = revision + 1 WHERE domain = 'identities';
    END;
  `);
}

/**
 * Return counters only when the whole trigger set is present. A partially
 * migrated or hand-created table must fall back to the legacy content hashes
 * so every write remains visible.
 */
export function readDashboardRevisionCounters(database: DatabaseSync): DashboardRevisionCounters | null {
  try {
    const triggerNames = database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND name IN (${REVISION_TRIGGERS.map(() => "?").join(", ")})
    `).all(...REVISION_TRIGGERS) as unknown as Array<{ name: string }>;
    if (triggerNames.length !== REVISION_TRIGGERS.length) return null;

    const rows = database.prepare(`
      SELECT domain, revision FROM dashboard_revisions
      WHERE domain IN ('roles', 'memberships', 'actions', 'identities')
    `).all() as unknown as Array<{ domain: string; revision: number | bigint }>;
    if (rows.length !== 4) return null;
    const counters = new Map(rows.map((row) => [
      row.domain,
      typeof row.revision === "bigint" ? Number(row.revision) : row.revision,
    ]));
    const value = (domain: keyof DashboardRevisionCounters): number | null => {
      const counter = counters.get(domain);
      return typeof counter === "number" && Number.isSafeInteger(counter) && counter >= 0 ? counter : null;
    };
    const roles = value("roles");
    const memberships = value("memberships");
    const actions = value("actions");
    const identities = value("identities");
    if (roles === null || memberships === null || actions === null || identities === null) return null;
    return { roles, memberships, actions, identities };
  } catch {
    return null;
  }
}
