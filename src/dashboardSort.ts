/**
 * Canonical dashboard date parsing shared by every server-side sort.
 *
 * Stored postings contain a mixture of ISO timestamps, date-only values, and
 * human-readable relative values from live feeds. Keep this implementation in
 * one server module so all fast endpoint sorts use the same rules.
 */
export function parseDashboardSortDate(value: string | null | undefined, relativeBase = Date.now()): number | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;

  const dateValue = normalized.replace(/^(?:posted|date posted)\s*:?\s*/i, "").trim();
  if (/^(?:n\/?a|unknown|null|none|not available|not provided|-)$/i.test(dateValue)) return null;

  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateValue);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    return new Date(Number(year), Number(month) - 1, Number(day)).valueOf();
  }

  const directTimestamp = new Date(dateValue.replace(/^(\d{4}-\d{2}-\d{2})\s+/, "$1T")).valueOf();
  if (Number.isFinite(directTimestamp)) return directTimestamp;

  const relative = /^(today|tomorrow|yesterday|(\d+)\s*(minutes?|mins?|hours?|days?|weeks?|months?|years?)\s+ago|(\d+)\s*(mo|min|m|h|d|w|y|yr))$/i.exec(dateValue);
  if (!relative) return null;
  if (relative[1]?.toLowerCase() === "today") return relativeBase;
  if (relative[1]?.toLowerCase() === "tomorrow") return relativeBase + 86_400_000;
  if (relative[1]?.toLowerCase() === "yesterday") return relativeBase - 86_400_000;

  const amount = Number(relative[2] ?? relative[4]);
  const unit = (relative[3] ?? relative[5] ?? "d").toLowerCase();
  const unitMs: Record<string, number> = {
    min: 60_000,
    mins: 60_000,
    minute: 60_000,
    minutes: 60_000,
    h: 3_600_000,
    hour: 3_600_000,
    hours: 3_600_000,
    d: 86_400_000,
    day: 86_400_000,
    days: 86_400_000,
    w: 604_800_000,
    week: 604_800_000,
    weeks: 604_800_000,
    mo: 2_592_000_000,
    month: 2_592_000_000,
    months: 2_592_000_000,
    y: 31_536_000_000,
    yr: 31_536_000_000,
    year: 31_536_000_000,
    years: 31_536_000_000,
  };
  return Number.isFinite(amount) && unitMs[unit] ? relativeBase - amount * unitMs[unit] : null;
}

export const DASHBOARD_MAX_POSTING_AGE_MONTHS = 2;

function dashboardCalendarDay(timestamp: number): number {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Return the local timestamp exactly two calendar months before the reference time. */
export function dashboardPostingAgeCutoff(relativeBase = Date.now()): number {
  const base = new Date(relativeBase);
  const target = new Date(
    base.getFullYear(),
    base.getMonth() - DASHBOARD_MAX_POSTING_AGE_MONTHS,
    1,
    base.getHours(),
    base.getMinutes(),
    base.getSeconds(),
    base.getMilliseconds(),
  );
  const lastTargetDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(base.getDate(), lastTargetDay));
  return target.valueOf();
}

/**
 * Old postings are hidden by calendar day. Unknown or unparsable dates stay
 * visible because their age cannot be established safely.
 */
export function isDashboardPostingTooOld(
  value: string | null | undefined,
  relativeBase = Date.now(),
): boolean {
  const timestamp = parseDashboardSortDate(value, relativeBase);
  if (timestamp === null) return false;
  return dashboardCalendarDay(timestamp) < dashboardCalendarDay(dashboardPostingAgeCutoff(relativeBase));
}

/** Cache-key component for the moving two-month visibility window. */
export function dashboardPostingAgeKey(relativeBase = Date.now()): string {
  return dashboardLocalDayKey(dashboardPostingAgeCutoff(relativeBase));
}

export const DASHBOARD_SEASONS = ["winter", "spring", "summer", "fall"] as const;
export type DashboardSeason = typeof DASHBOARD_SEASONS[number];
export const DASHBOARD_SEASON_FILTERS = [...DASHBOARD_SEASONS, "unknown"] as const;
export type DashboardSeasonFilter = typeof DASHBOARD_SEASON_FILTERS[number];

const DASHBOARD_SEASON_RANK = new Map<DashboardSeason, number>(
  DASHBOARD_SEASONS.map((season, index) => [season, index]),
);

/** Normalize a term or title into the season vocabulary used by the dashboard. */
export function normalizeDashboardSeason(value: string | null | undefined): DashboardSeason | null {
  const match = /\b(winter|spring|summer|fall|autumn)\b/i.exec(String(value ?? ""));
  const season = match?.[1]?.toLocaleLowerCase();
  if (!season) return null;
  return season === "autumn" ? "fall" : season as DashboardSeason;
}

export function dashboardRoleSeason(role: Pick<{
  internshipTerm: string | null;
  title: string;
}, "internshipTerm" | "title">): DashboardSeasonFilter {
  return normalizeDashboardSeason(role.internshipTerm)
    ?? normalizeDashboardSeason(role.title)
    ?? "unknown";
}

function dashboardRoleSeasonYear(role: {
  internshipYear: string | null | undefined;
  title: string;
}): number | null {
  const explicitYear = /\b20\d{2}\b/.exec(String(role.internshipYear ?? ""))?.[0]
    ?? /\b20\d{2}\b/.exec(String(role.title ?? ""))?.[0];
  return explicitYear ? Number(explicitYear) : null;
}

export function compareByDashboardSeason(left: {
  company: string;
  title: string;
  relevanceScore: number;
  internshipTerm: string | null;
  internshipYear: string | null;
}, right: {
  company: string;
  title: string;
  relevanceScore: number;
  internshipTerm: string | null;
  internshipYear: string | null;
}): number {
  const leftSeason = dashboardRoleSeason(left);
  const rightSeason = dashboardRoleSeason(right);
  if (leftSeason === "unknown" && rightSeason !== "unknown") return 1;
  if (leftSeason !== "unknown" && rightSeason === "unknown") return -1;
  if (leftSeason !== "unknown" && rightSeason !== "unknown") {
    const seasonOrder = DASHBOARD_SEASON_RANK.get(leftSeason)!
      - DASHBOARD_SEASON_RANK.get(rightSeason)!;
    if (seasonOrder) return seasonOrder;
    const leftYear = dashboardRoleSeasonYear(left);
    const rightYear = dashboardRoleSeasonYear(right);
    if (leftYear === null && rightYear !== null) return 1;
    if (leftYear !== null && rightYear === null) return -1;
    if (leftYear !== null && rightYear !== null && leftYear !== rightYear) return leftYear - rightYear;
  }
  return Number(right.relevanceScore || 0) - Number(left.relevanceScore || 0)
    || left.company.localeCompare(right.company)
    || left.title.localeCompare(right.title);
}

export function dashboardPostingDay(value: string | null | undefined, relativeBase = Date.now()): number | null {
  const timestamp = parseDashboardSortDate(value, relativeBase);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/**
 * Local calendar day used by relative posting labels (for example
 * "yesterday").  The day is part of dashboard validators so a long-lived
 * client is revalidated when those labels change at local midnight.
 */
export function dashboardLocalDayKey(timestamp = Date.now()): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}
