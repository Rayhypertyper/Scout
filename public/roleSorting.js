function compareByRelevance(left, right) {
  return right.relevanceScore - left.relevanceScore
    || left.company.localeCompare(right.company)
    || left.title.localeCompare(right.title);
}

export function parseSortDate(value, relativeBase = Date.now()) {
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
  const unitMs = {
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
  }[unit];
  return Number.isFinite(amount) && unitMs ? relativeBase - amount * unitMs : null;
}

const MAX_POSTING_AGE_MONTHS = 2;

function calendarDay(timestamp) {
  const date = new Date(timestamp);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

function postingAgeCutoff(relativeBase) {
  const base = new Date(relativeBase);
  const target = new Date(
    base.getFullYear(),
    base.getMonth() - MAX_POSTING_AGE_MONTHS,
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

export function isDashboardPostingTooOld(value, relativeBase = Date.now()) {
  const timestamp = parseSortDate(value, relativeBase);
  if (timestamp === null) return false;
  return calendarDay(timestamp) < calendarDay(postingAgeCutoff(relativeBase));
}

export const ROLE_SEASONS = Object.freeze(["winter", "spring", "summer", "fall"]);
export const ROLE_SEASON_FILTERS = Object.freeze([...ROLE_SEASONS, "unknown"]);
const ROLE_SEASON_RANK = new Map(ROLE_SEASONS.map((season, index) => [season, index]));

const ROLE_SEASON_TEXT_FIELDS = [
  "title",
  "description",
  "responsibilities",
  "requiredQualifications",
  "preferredQualifications",
  "technologies",
  "educationRequirements",
  "graduationRequirements",
  "experienceRequirements",
  "workAuthorizationRequirements",
  "sponsorshipInformation",
  "qualificationDetails",
  "internshipTerm",
  "internshipYear",
  "duration",
  "salary",
];

function seasonTextValues(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(seasonTextValues);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(seasonTextValues);
  return [];
}

function roleSeasonText(role) {
  return ROLE_SEASON_TEXT_FIELDS.flatMap((field) => seasonTextValues(role?.[field])).join("\n");
}

export function normalizeRoleSeason(value) {
  const match = /\b(winter|spring|summer|fall|autumn)\b/i.exec(String(value ?? ""));
  if (!match) return null;
  return match[1].toLocaleLowerCase() === "autumn" ? "fall" : match[1].toLocaleLowerCase();
}

export function roleSeasons(role) {
  if (Array.isArray(role?.seasons)) {
    const known = new Set(role.seasons.map(normalizeRoleSeason));
    return ROLE_SEASONS.filter((season) => known.has(season));
  }
  const text = roleSeasonText(role);
  return ROLE_SEASONS.filter((season) => new RegExp(`\\b${season}\\b`, "i").test(text)
    || (season === "fall" && /\bautumn\b/i.test(text)));
}

export function roleHasSeason(role, season) {
  const seasons = roleSeasons(role);
  return season === "unknown" ? seasons.length === 0 : seasons.includes(season);
}

export function roleSeason(role) {
  return roleSeasons(role)[0] || "unknown";
}

function roleSeasonYear(role) {
  const explicitYear = /\b20\d{2}\b/.exec(String(role?.internshipYear ?? ""))?.[0]
    || /\b20\d{2}\b/.exec(String(role?.title ?? ""))?.[0];
  return explicitYear ? Number(explicitYear) : null;
}

export function compareBySeason(left, right) {
  const leftSeason = roleSeason(left);
  const rightSeason = roleSeason(right);
  if (leftSeason === "unknown" && rightSeason !== "unknown") return 1;
  if (leftSeason !== "unknown" && rightSeason === "unknown") return -1;
  if (leftSeason !== "unknown" && rightSeason !== "unknown") {
    const seasonOrder = ROLE_SEASON_RANK.get(leftSeason) - ROLE_SEASON_RANK.get(rightSeason);
    if (seasonOrder) return seasonOrder;
    const leftYear = roleSeasonYear(left);
    const rightYear = roleSeasonYear(right);
    if (leftYear === null && rightYear !== null) return 1;
    if (leftYear !== null && rightYear === null) return -1;
    if (leftYear !== null && rightYear !== null && leftYear !== rightYear) return leftYear - rightYear;
  }
  return Number(right?.relevanceScore || 0) - Number(left?.relevanceScore || 0)
    || String(left?.company || "").localeCompare(String(right?.company || ""))
    || String(left?.title || "").localeCompare(String(right?.title || ""));
}

function postingDayForSort(role) {
  const postedAt = parseSortDate(role.postingDate);
  if (postedAt === null) return null;
  const date = new Date(postedAt);
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

export function compareByPostedDate(left, right) {
  const leftPostingDay = postingDayForSort(left);
  const rightPostingDay = postingDayForSort(right);
  if (leftPostingDay === null && rightPostingDay !== null) return 1;
  if (leftPostingDay !== null && rightPostingDay === null) return -1;
  if (leftPostingDay !== null && rightPostingDay !== null && rightPostingDay !== leftPostingDay) {
    return rightPostingDay - leftPostingDay;
  }
  return compareByRelevance(left, right);
}
