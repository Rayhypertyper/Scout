import type { Internship } from "./domain/schemas.js";

export const CLOSING_SOON_WINDOW_MS = 24 * 60 * 60 * 1_000;

const MONTHS = new Map([
  ["jan", 1], ["january", 1],
  ["feb", 2], ["february", 2],
  ["mar", 3], ["march", 3],
  ["apr", 4], ["april", 4],
  ["may", 5],
  ["jun", 6], ["june", 6],
  ["jul", 7], ["july", 7],
  ["aug", 8], ["august", 8],
  ["sep", 9], ["sept", 9], ["september", 9],
  ["oct", 10], ["october", 10],
  ["nov", 11], ["november", 11],
  ["dec", 12], ["december", 12],
]);

const TIME_ZONE_OFFSETS_MINUTES: Record<string, number> = {
  UTC: 0,
  GMT: 0,
  EST: -5 * 60,
  EDT: -4 * 60,
  CST: -6 * 60,
  CDT: -5 * 60,
  MST: -7 * 60,
  MDT: -6 * 60,
  PST: -8 * 60,
  PDT: -7 * 60,
};

export interface DeadlineNotificationRole extends Pick<
  Internship,
  "id" | "company" | "title" | "postingUrl" | "deadline" | "availabilityStatus"
> {
  listingType?: "internship" | "grind";
  listingId?: string;
}

export interface ClosingSoonNotification {
  id: string;
  listingType: "internship" | "grind";
  listingId: string;
  company: string;
  roleTitle: string;
  postingUrl: string;
  deadline: string;
  deadlineAt: string;
  alertAt: string;
}

function endOfLocalDay(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 23, 59, 59, 999).valueOf();
}

function localTimestamp(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  timeZone: string | undefined,
): number {
  const normalizedZone = timeZone?.toUpperCase();
  const offsetMinutes = normalizedZone ? TIME_ZONE_OFFSETS_MINUTES[normalizedZone] : undefined;
  if (offsetMinutes !== undefined) {
    return Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000;
  }
  return new Date(year, month - 1, day, hour, minute, second, 0).valueOf();
}

function parseClock(value: string): { hour: number; minute: number; second: number; timeZone?: string } | null {
  const match = /\b(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?\s*(am|pm)?\b(?:\s*(UTC|GMT|EST|EDT|CST|CDT|MST|MDT|PST|PDT))?/i.exec(value);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  const second = Number(match[3] ?? 0);
  const meridiem = match[4]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const timeZone = match[5]?.toUpperCase();
  return { hour, minute, second, ...(timeZone ? { timeZone } : {}) };
}

function parseCalendarDate(
  year: number,
  month: number,
  day: number,
  suffix: string,
): number | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const clock = parseClock(suffix);
  const timestamp = clock
    ? localTimestamp(year, month, day, clock.hour, clock.minute, clock.second, clock.timeZone)
    : endOfLocalDay(year, month, day);
  if (clock?.timeZone && TIME_ZONE_OFFSETS_MINUTES[clock.timeZone] !== undefined) {
    const calendar = new Date(Date.UTC(year, month - 1, day));
    return calendar.getUTCFullYear() === year && calendar.getUTCMonth() === month - 1 && calendar.getUTCDate() === day
      ? timestamp
      : null;
  }
  const date = new Date(timestamp);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
    ? timestamp
    : null;
}

function parseIsoDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})(.*)$/u.exec(value);
  if (!match) return null;
  const [, yearValue, monthValue, dayValue, suffix = ""] = match;
  const year = Number(yearValue);
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!suffix.trim()) return endOfLocalDay(year, month, day);
  const normalized = suffix.trim().replace(/^T/u, "");
  const direct = new Date(`${yearValue}-${monthValue}-${dayValue}T${normalized}`).valueOf();
  return Number.isFinite(direct) ? direct : null;
}

function parseNumericDate(value: string): number | null {
  const match = /\b(\d{1,2})[/-](\d{1,2})[/-](20\d{2})([^\d].*)?$/u.exec(value);
  if (!match) return null;
  const [, monthValue, dayValue, yearValue, suffix = ""] = match;
  return parseCalendarDate(Number(yearValue), Number(monthValue), Number(dayValue), suffix);
}

function parseNamedDate(value: string, now: number): number | null {
  const monthFirst = /\b([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/u.exec(value);
  const dayFirst = /\b(\d{1,2})\s+([A-Za-z]{3,9})(?:\s+(20\d{2}))?/u.exec(value);
  const match = monthFirst ?? dayFirst;
  if (!match) return null;

  const monthName = (monthFirst ? match[1] : match[2]) ?? "";
  const month = MONTHS.get(monthName.toLowerCase());
  if (!month) return null;
  const day = Number(monthFirst ? match[2] : match[1]);
  const year = Number((monthFirst ? match[3] : match[3]) ?? new Date(now).getFullYear());
  const suffix = value.slice((match.index ?? 0) + match[0].length);
  return parseCalendarDate(year, month, day, suffix);
}

/**
 * Convert the stored deadline evidence into a timestamp when it contains a
 * concrete calendar date. Date-only deadlines are treated as closing at the
 * end of that local calendar day; phrases without a date remain unknown.
 */
export function parseDeadlineTimestamp(value: string | null | undefined, now = Date.now()): number | null {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) return null;

  const iso = parseIsoDate(normalized);
  if (iso !== null) return iso;
  const numeric = parseNumericDate(normalized);
  if (numeric !== null) return numeric;
  const named = parseNamedDate(normalized, now);
  if (named !== null) return named;

  const direct = new Date(normalized).valueOf();
  return Number.isFinite(direct) ? direct : null;
}

/**
 * Return the open roles whose parsed deadline is strictly inside the next 24
 * hours. The alert id includes the deadline timestamp so a changed deadline
 * creates a fresh, durable browser notification.
 */
export function buildClosingSoonNotifications(
  roles: readonly DeadlineNotificationRole[],
  now = Date.now(),
): ClosingSoonNotification[] {
  return roles
    .flatMap((role) => {
      if (role.availabilityStatus !== "open" || !role.deadline) return [];
      const deadlineTimestamp = parseDeadlineTimestamp(role.deadline, now);
      if (deadlineTimestamp === null) return [];
      const remaining = deadlineTimestamp - now;
      if (remaining <= 0 || remaining >= CLOSING_SOON_WINDOW_MS) return [];
      const listingType = role.listingType ?? "internship";
      const listingId = role.listingId ?? role.id;
      const deadlineAt = new Date(deadlineTimestamp).toISOString();
      return [{
        id: `deadline-${listingType}-${listingId}-${deadlineTimestamp}`,
        listingType,
        listingId,
        company: role.company,
        roleTitle: role.title,
        postingUrl: role.postingUrl,
        deadline: role.deadline,
        deadlineAt,
        alertAt: new Date(deadlineTimestamp - CLOSING_SOON_WINDOW_MS).toISOString(),
      }];
    })
    .toSorted((left, right) => Date.parse(left.deadlineAt) - Date.parse(right.deadlineAt));
}

/**
 * Find the next point at which the set of closing-soon alerts can change.
 * This lets the dashboard keep its cheap ETag poll without parsing every role
 * on every five-second status request.
 */
export function nextClosingSoonRefreshAt(
  roles: readonly DeadlineNotificationRole[],
  now = Date.now(),
): number | null {
  let next: number | null = null;
  for (const role of roles) {
    if (role.availabilityStatus !== "open" || !role.deadline) continue;
    const deadline = parseDeadlineTimestamp(role.deadline, now);
    if (deadline === null || deadline <= now) continue;
    const alertAt = deadline - CLOSING_SOON_WINDOW_MS;
    const candidate = alertAt > now ? alertAt : deadline;
    if (next === null || candidate < next) next = candidate;
  }
  return next;
}
