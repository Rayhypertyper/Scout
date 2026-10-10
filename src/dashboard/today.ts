import type { DatabaseSync } from "node:sqlite";
import { DashboardValidationError } from "./http.js";

export interface TodayRole {
  id: string;
  listingType: string;
  listingId: string;
  company: string;
  title: string;
  firstSeenAt: string;
  availabilityStatus: string;
  deadline: string | null;
  location: string[];
  remoteStatus: string;
  salary: string | null;
  internshipTerm: string | null;
  internshipYear: string | null;
  applicationUrl: string;
  postingUrl: string;
}

export interface TodayApplication {
  listingKey: string;
  listingType: string;
  listingId: string;
  company: string;
  title: string;
  stage: string;
  appliedAt: string;
  followUpAt: string | null;
  interviewAt: string | null;
}

export interface SavedTodayRole {
  listingKey: string;
  snapshot: Record<string, unknown>;
}

export function todayPageHtml(content: string): string {
  return content.replace("<title>Scout</title>", '<title>Today — Scout</title><meta name="robots" content="noindex, nofollow, noarchive" />')
    .replace('data-role-view="today" hidden', 'data-role-view="today"')
    .replaceAll('data-role-view="roles"', 'data-role-view="roles" hidden')
    .replace('class="main-pane" aria-labelledby="page-title"', 'class="main-pane" aria-labelledby="today-title"')
    .replace('href="/today" data-nav="today"', 'href="/today" data-nav="today" aria-current="page"');
}

const CHANGE_FIELDS = {
  title: "Title", location: "Location", remoteStatus: "Work arrangement",
  salary: "Compensation", deadline: "Deadline", availabilityStatus: "Availability",
  internshipTerm: "Term", internshipYear: "Year", applicationUrl: "Application link",
  postingUrl: "Posting link",
};

export function ensureTodaySchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS user_today_visits (
      user_id TEXT PRIMARY KEY,
      visited_at TEXT NOT NULL,
      saved_snapshots_json TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE IF NOT EXISTS user_application_reminders (
      user_id TEXT NOT NULL,
      listing_key TEXT NOT NULL,
      follow_up_at TEXT,
      interview_at TEXT,
      PRIMARY KEY (user_id, listing_key)
    );
  `);
}

export function readTodayVisit(database: DatabaseSync, userId: string): {
  visitedAt: string | null; savedRoles: SavedTodayRole[];
} {
  ensureTodaySchema(database);
  const row = database.prepare("SELECT visited_at, saved_snapshots_json FROM user_today_visits WHERE user_id = ?")
    .get(userId) as { visited_at: string; saved_snapshots_json: string } | undefined;
  return { visitedAt: row?.visited_at ?? null, savedRoles: row ? JSON.parse(row.saved_snapshots_json) as SavedTodayRole[] : [] };
}

export function parseSavedTodayRoles(value: unknown): SavedTodayRole[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 200) throw new DashboardValidationError("Send at most 200 saved roles.");
  const roles = value.map((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new DashboardValidationError("Invalid saved role.");
    const entry = item as Record<string, unknown>;
    if (typeof entry.listingKey !== "string" || !/^(internship|grind):.{1,300}$/u.test(entry.listingKey)
      || !entry.snapshot || typeof entry.snapshot !== "object" || Array.isArray(entry.snapshot)) {
      throw new DashboardValidationError("Invalid saved role.");
    }
    const snapshot = entry.snapshot as Record<string, unknown>;
    return { listingKey: entry.listingKey, snapshot: Object.fromEntries(Object.keys(CHANGE_FIELDS)
      .filter((key) => snapshot[key] !== undefined).map((key) => [key, snapshot[key]])) };
  });
  return [...new Map(roles.map((role) => [role.listingKey, role])).values()];
}

export function recordTodayVisit(database: DatabaseSync, userId: string, visitedAt: unknown, savedRoles: unknown, now = Date.now()): void {
  const timestamp = typeof visitedAt === "string" ? Date.parse(visitedAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now || timestamp < now - 24 * 60 * 60 * 1000) {
    throw new DashboardValidationError("Refresh Today before recording this visit.");
  }
  const snapshots = parseSavedTodayRoles(savedRoles);
  ensureTodaySchema(database);
  database.prepare(`INSERT INTO user_today_visits (user_id, visited_at, saved_snapshots_json)
    VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET visited_at = excluded.visited_at,
    saved_snapshots_json = excluded.saved_snapshots_json WHERE excluded.visited_at >= user_today_visits.visited_at`)
    .run(userId, new Date(timestamp).toISOString(), JSON.stringify(snapshots));
}

export function buildTodayListings<T extends TodayRole>({ roles, since, now }: {
  roles: T[]; since: string | null; now: number;
}) {
  // First visits show the past week; return visits use the account checkpoint.
  // Read stored listings directly without preference matching or generation.
  const cutoff = since ? Date.parse(since) : now - 7 * 24 * 60 * 60 * 1000;
  const newListings = roles.filter((role) => {
    const firstSeen = Date.parse(role.firstSeenAt);
    return role.availabilityStatus === "open" && firstSeen > cutoff && firstSeen <= now;
  }).toSorted((left, right) => Date.parse(right.firstSeenAt) - Date.parse(left.firstSeenAt)
    || `${left.listingType}:${left.listingId}`.localeCompare(`${right.listingType}:${right.listingId}`));
  return {
    contract: "dashboard.today.v2", generatedAt: new Date(now).toISOString(), since,
    counts: { newListings: newListings.length }, newListings,
  };
}

export function saveApplicationReminders(database: DatabaseSync, userId: string, listingKey: string,
  followUpAt: unknown, interviewAt: unknown): void {
  const date = (value: unknown) => {
    if (value === null || value === "") return null;
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/u.test(value) || !Number.isFinite(Date.parse(value))) {
      throw new DashboardValidationError("Reminder dates must include a valid time and timezone.");
    }
    return new Date(value).toISOString();
  };
  const follow = date(followUpAt);
  const interview = date(interviewAt);
  ensureTodaySchema(database);
  if (!database.prepare("SELECT 1 FROM user_listing_actions WHERE user_id = ? AND listing_key = ? AND action = 'applied'").get(userId, listingKey)) {
    throw new DashboardValidationError("Applied application not found.");
  }
  database.prepare(`INSERT INTO user_application_reminders (user_id, listing_key, follow_up_at, interview_at)
    VALUES (?, ?, ?, ?) ON CONFLICT(user_id, listing_key) DO UPDATE
    SET follow_up_at = excluded.follow_up_at, interview_at = excluded.interview_at`).run(userId, listingKey, follow, interview);
}
