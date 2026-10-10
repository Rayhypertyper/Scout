/* global document, Element, HTMLDialogElement, URL, URLSearchParams, fetch, AbortController, Blob, btoa, structuredClone, setTimeout, setInterval, clearTimeout, IntersectionObserver, localStorage, navigator, window, history */

import { isRecentListing } from "./newRole.js";
import { hasRequiredListingKeywords } from "./listingKeywords.js";
import {
  compareByPostedDate,
  compareBySeason,
  parseSortDate,
  ROLE_SEASON_FILTERS,
  roleHasSeason,
} from "./roleSorting.js";
import { authClient, wireLogoutButton } from "./auth/auth-client.js";
import { clearListingSnapshots, readListingSnapshot, rememberListingSnapshot } from "./app/listing-snapshot.js";
// Today feature is dormant for now.
// import { createTodayController } from "./app/today.js";

const SERVER_ROLE_TABS = ["main", "canada", "summer", "internship", "quant", "non-intern"];
const SAVED_ROLE_TAB = "saved";
const ROLE_TABS = [...SERVER_ROLE_TABS, SAVED_ROLE_TAB];
export const ROLE_VIEWS = ["matches", "all"];
export const DEFAULT_ROLE_VIEW = "all";
export const ROLE_WORK_MODES = ["all", "onsite", "hybrid", "remote"];
export const ROLE_SEASONS = ["all", ...ROLE_SEASON_FILTERS];
export const DEFAULT_ROLE_SEASONS = Object.freeze(["summer", "unknown"]);
export const INITIAL_ROLE_TAB = "canada";
export const FALLBACK_ROLE_TAB = "internship";
export const DEFAULT_ROLE_SORT = "posted";

export function normalizeSeasonFilters(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  const normalized = new Set(values
    .flatMap((candidate) => String(candidate ?? "").split(","))
    .map((candidate) => candidate.trim().toLocaleLowerCase())
    .filter((candidate) => ROLE_SEASONS.includes(candidate)));
  if (normalized.has("all")) return [];
  return ROLE_SEASON_FILTERS.filter((season) => normalized.has(season));
}

function selectedSeasonFilters() {
  const select = $("#season-filter");
  if (!select) return [];
  return normalizeSeasonFilters([...select.options].filter((option) => option.selected).map((option) => option.value));
}

function setSelectedSeasonFilters(value) {
  const select = $("#season-filter");
  if (!select) return;
  const selected = new Set(normalizeSeasonFilters(value));
  const allValue = select.dataset.multiSelectAllValue || "all";
  const allOption = [...select.options].find((option) => option.value === allValue);
  [...select.options].forEach((option) => {
    option.selected = selected.size > 0 ? selected.has(option.value) : option === allOption;
  });
  if (typeof window !== "undefined") window.refreshThemedSelects?.();
}

function seasonFilterLabel(value = selectedSeasonFilters()) {
  const selected = normalizeSeasonFilters(value);
  if (selected.length === 0) return "All seasons";
  const select = $("#season-filter");
  const labels = selected.map((season) => [...(select?.options || [])].find((option) => option.value === season)?.textContent?.trim() || season);
  return labels.length <= 2 ? labels.join(", ") : `${labels.length} seasons`;
}

function seasonFiltersMatchRole(role, selected = selectedSeasonFilters()) {
  const seasons = normalizeSeasonFilters(selected);
  return seasons.length === 0 || seasons.some((season) => roleHasSeason(role, season));
}
const APPLICATION_STAGE_OPTIONS = Object.freeze([
  { value: "applied", label: "Applied" },
  { value: "oa", label: "OA" },
  { value: "recruiter", label: "Recruiter" },
  { value: "interview", label: "Interview" },
  { value: "final", label: "Final" },
  { value: "offer", label: "Offer" },
  { value: "rejected", label: "Rejected" },
]);
const APPLICATION_STAGE_VALUES = new Set(APPLICATION_STAGE_OPTIONS.map(({ value }) => value));
const APPLICATION_STAGE_LABELS = new Map(APPLICATION_STAGE_OPTIONS.map(({ value, label }) => [value, label]));
const LEGACY_APPLICATION_STAGE_MAP = new Map([
  ["pending", "applied"],
  ["accepted", "offer"],
  ["rejected", "rejected"],
]);
// A tab switch must paint real roles immediately: the active tab's first page
// is a 40-role request, every other tab warms 20 roles in the background, and
// remaining pages stream in via the background loader while the user stays on
// a tab. Inactive tabs fill from 20 to 40 if the user stays long enough.
export const INITIAL_PAGE_SIZE = 40;
export const PREFETCH_PAGE_SIZE = 20;
export const BACKGROUND_PAGE_SIZE = 8;
export const MAX_PAGE_SIZE = 100;
export const RECENT_RUN_LIMIT = 5;
const EXPANDED_RUN_LIMIT = 40;
export const NOTIFICATION_LIMIT = 20;
const MAX_RENDERED_ROLES = 500;
const LIST_RENDER_CAP = 5_000;
const TAB_SNAPSHOT_CACHE_MAX = 12;
const DETAIL_CACHE_MAX = 100;
const SEARCH_DEBOUNCE_MS = 220;
const POLL_INTERVAL_MS = 5_000;
const SCAN_POLL_INTERVAL_MS = 1_500;
const ROLE_SNAPSHOT_RETRY_DELAYS_MS = [60, 180];
const SAVED_VIEWS_KEY = "roleradar.savedViews";
const WATCHLIST_KEY = "roleradar.watchlist";
const NOTIFICATION_HISTORY_KEY = "roleradar.notifications";
const NOTIFICATION_READ_KEY = "roleradar.notifications.read";
const DASHBOARD_SETTINGS_KEY = "roleradar.settings";
const MAX_WATCHLIST_ROLES = 200;
const COMPANY_LOGO_ORIGIN = "https://logos.hunter.io";
const COMPANY_FAVICON_ORIGIN = "https://www.google.com/s2/favicons";
const MAX_LOGO_DOMAINS = 10;
const DEFAULT_DASHBOARD_SETTINGS = Object.freeze({
  theme: "light",
  motion: "full",
  defaultTab: INITIAL_ROLE_TAB,
  defaultSort: DEFAULT_ROLE_SORT,
  defaultStatus: "open",
  notifyCompleted: true,
  notifyFailed: true,
  notifyNew: true,
  notifyDeadlineSoon: true,
});
const SETTINGS_THEME_VALUES = new Set(["light", "dark", "system"]);
const SETTINGS_MOTION_VALUES = new Set(["full", "reduced"]);
const SETTINGS_SORT_VALUES = new Set(["posted", "relevance", "season", "recent", "last-seen", "company"]);
const SETTINGS_STATUS_VALUES = new Set(["open", "new", "updated", "all", "closed"]);
const COMPANY_DOMAIN_ALIASES = new Map([
  ["amazonwebservices", ["amazon.com"]],
  ["americanexpress", ["americanexpress.com"]],
  ["automationanywhere", ["automationanywhere.com"]],
  ["axon", ["axon.com"]],
  ["baesystems", ["baesystems.com"]],
  ["bytedance", ["bytedance.com"]],
  ["cadencedesignsystems", ["cadence.com"]],
  ["chicagotrading", ["chicagotrading.com"]],
  ["dvtrading", ["dvtrading.com"]],
  ["emoryuniversity", ["emory.edu"]],
  ["fifththirdbank", ["53.com"]],
  ["geaerospace", ["geaerospace.com", "ge.com"]],
  ["generaldynamicsmissionsystems", ["gd.com"]],
  ["gulfstreamaerospace", ["gulfstream.com"]],
  ["honeywellaerospace", ["honeywell.com"]],
  ["tiktokusdsjointventure", ["tiktok.com", "tiktokusds.com"]],
  ["ibm", ["ibm.com"]],
  ["joinbytedance", ["bytedance.com"]],
  ["lplfinancial", ["lpl.com"]],
  ["microchiptechnology", ["microchip.com"]],
  ["motorolasolutions", ["motorolasolutions.com"]],
  ["navyfederalcreditunion", ["navyfederal.com"]],
  ["netapp", ["netapp.com"]],
  ["objecttech", ["object.tech"]],
  ["pathai", ["pathai.com"]],
  ["ponyai", ["pony.ai"]],
  ["salesforce", ["salesforce.com"]],
  ["sentry", ["sentry.io"]],
  ["solopulseco", ["solopulse.co"]],
  ["spacex", ["spacex.com"]],
  ["sriinternational", ["sri.com"]],
  ["turnerconstruction", ["turnerconstruction.com"]],
  ["waltdisneyworld", ["disney.com", "waltdisneyworld.com"]],
  ["wd", ["westerndigital.com"]],
]);
const CAREER_HOST_ALIASES = new Map([
  ["amazon.jobs", ["amazon.com"]],
  ["joinbytedance.com", ["bytedance.com"]],
  ["lifeattiktok.com", ["tiktok.com"]],
]);
const GENERIC_JOB_HOSTS = [
  /(^|\.)applybolt\.app$/i,
  /(^|\.)applytojob\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)avature\.net$/i,
  /(^|\.)bamboohr\.com$/i,
  /(^|\.)dayforcehcm\.com$/i,
  /(^|\.)dreamworkhq\.com$/i,
  /(^|\.)eightfold\.ai$/i,
  /(^|\.)github\.com$/i,
  /(^|\.)glassdoor\.com$/i,
  /(^|\.)greenhouse\.com$/i,
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)hiringcafe\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)indeed\.com$/i,
  /(^|\.)intern-list\.com$/i,
  /(^|\.)interninsider\.me$/i,
  /(^|\.)jibeapply\.com$/i,
  /(^|\.)jobright\.ai$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)linkedin\.com$/i,
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)myworkdaysite\.com$/i,
  /(^|\.)oraclecloud\.com$/i,
  /(^|\.)paycomonline\.net$/i,
  /(^|\.)personio\.(?:com|de)$/i,
  /(^|\.)recruitee\.com$/i,
  /(^|\.)rippling\.com$/i,
  /(^|\.)simplify\.jobs$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)successfactors\.com$/i,
  /(^|\.)taleo\.net$/i,
  /(^|\.)teamtailor\.com$/i,
  /(^|\.)ultipro\.com$/i,
  /(^|\.)useno\.app$/i,
  /(^|\.)earlycareerradar\.com$/i,
  /(^|\.)csjobs\.ca$/i,
  /(^|\.)didtheboysgrindleetcodetoday\.com$/i,
  /(^|\.)wellfound\.com$/i,
  /(^|\.)workable\.com$/i,
  /(^|\.)ziprecruiter\.com$/i,
];
const GENERIC_HOST_SLUGS = new Set([
  "apply", "ats", "boards", "career", "careers", "job", "job-boards", "jobs",
  "recruiting", "recruiting2", "www",
]);
const GENERIC_PATH_SLUGS = new Set([
  "apply", "application", "boards", "c", "career", "careers", "embed", "en",
  "en-ca", "en-gb", "en-us", "hcmui", "info", "j", "job", "job-boards", "jobs",
  "recruiting", "search", "sites",
]);
const GENERIC_COMPANY_WORDS = new Set([
  "aerospace", "associates", "co", "companies", "company", "consulting", "corp",
  "corporation", "design", "digital", "global", "group", "holdings", "inc",
  "incorporated", "industries", "industrial", "institute", "international",
  "lab", "labs", "limited", "llc", "lp", "ltd", "partners", "plc", "services",
  "software", "solutions", "system", "systems", "tech", "technologies",
  "technology", "university", "college", "usa", "us", "ventures", "worldwide",
]);
// Match the server's abandoned-run lease window for legacy payloads that do
// not yet carry scan.active. A RUNNING row by itself is never authoritative.
const LEGACY_RUN_MAX_AGE_MS = 5 * 60 * 1_000;
const LEGACY_RUN_FUTURE_SKEW_MS = 60_000;

export function normalizeRoleView(value, fallback = DEFAULT_ROLE_VIEW) {
  return ROLE_VIEWS.includes(value) ? value : fallback;
}

export function readRoleUrlState(value) {
  const url = value instanceof URL ? value : new URL(String(value || "/jobs"), "http://localhost");
  const params = url.searchParams;
  const rawWorkMode = params.get("workMode")?.trim().toLocaleLowerCase() || "all";
  const rawSeasons = params.getAll("season");
  if (rawSeasons.length === 0 && params.has("seasons")) rawSeasons.push(params.get("seasons") || "");
  const seasons = rawSeasons.length > 0
    ? normalizeSeasonFilters(rawSeasons)
    : [...DEFAULT_ROLE_SEASONS];
  return {
    view: normalizeRoleView(params.get("view")),
    tab: params.get("tab"),
    status: params.get("status"),
    sort: params.get("sort"),
    category: params.get("category"),
    workMode: ROLE_WORK_MODES.includes(rawWorkMode) ? rawWorkMode : "all",
    seasons,
    // Keep the singular field for callers that only understand the legacy
    // URL/API shape. Multiple selections use the canonical `seasons` field.
    season: seasons.length === 1 ? seasons[0] : "all",
    location: params.get("location")?.trim() || null,
    search: params.get("q") || "",
  };
}

function initialRoleView() {
  if (typeof window === "undefined") return DEFAULT_ROLE_VIEW;
  return readRoleUrlState(window.location.href).view;
}

const state = {
  auth: authClient.getState(),
  activeView: typeof window !== "undefined" && ["applications", "watchlist", "dashboard", "sources", "analytics", "settings"].includes(window.location.hash.slice(1))
    ? window.location.hash.slice(1)
    : "roles",
  roleView: initialRoleView(),
  activeTab: INITIAL_ROLE_TAB,
  settings: { ...DEFAULT_DASHBOARD_SETTINGS },
  data: null,
  items: [],
  watchlistRoles: [],
  pagination: { limit: INITIAL_PAGE_SIZE, offset: 0, total: 0, hasMore: false, nextOffset: null },
  version: null,
  statusVersion: null,
  changesEtag: null,
  rolesContentVersion: null,
  showingCachedRoles: false,
  cachedRolesUnavailable: false,
  listController: null,
  detailControllers: new Map(),
  detailCache: new Map(),
  tabSnapshots: new Map(),
  draining: new Set(),
  prefetching: false,
  roleCacheRevision: 0,
  requestRevision: 0,
  intentRevision: 0,
  loading: false,
  loadingMore: false,
  listError: null,
  changesRequest: null,
  analyticsRequest: null,
  analyticsEtag: null,
  analyticsReady: false,
  analyticsData: null,
  analyticsAccount: null,
  analyticsAccountRequest: null,
  searchTimer: null,
  scanning: false,
  terminating: false,
  pendingActions: new Set(),
  actionRequests: new Map(),
  optimisticallyHiddenListings: new Set(),
  undoStack: [],
  currentSourceTimerKey: null,
  currentSourceTimerStartedAt: null,
  sourceResultMemory: { runKey: null, results: [] },
  runLimit: RECENT_RUN_LIMIT,
  runHistory: null,
  sourcesExpanded: false,
  loadMoreObserver: null,
  notifications: [],
  notificationReadIds: new Set(),
  notificationsReady: false,
  applications: [],
  applicationCounts: { all: 0, applied: 0, oa: 0, recruiter: 0, interview: 0, final: 0, offer: 0, rejected: 0 },
  applicationStageFilter: "all",
  applicationSearch: "",
  applicationsLoading: false,
  applicationsError: null,
  applicationsRequest: null,
  pendingApplicationStages: new Set(),
  selectedRoleKey: null,
  roleDetailReturnFocus: null,
  applicationDraftCache: new Map(),
  activeApplicationDraft: null,
  applicationDraftRequestId: 0,
  activeResumeProfileSession: null,
  resumeProfileRequestId: 0,
  roleMotionContext: null,
  sourceMarqueeTween: null,
  sourceMarqueeKey: null,
  sourceMarqueePaused: false,
  menuReturnFocus: null,
};

const $ = (selector) => document.querySelector(selector);
/* Today feature is dormant for now.
const todayController = typeof document === "undefined" ? null : createTodayController({
  authClient,
  getSavedRoles: () => state.watchlistRoles,
  saveRole: (role) => {
    const key = listingKeyForRole(role);
    const saved = state.watchlistRoles.some((candidate) => listingKeyForRole(candidate) === key);
    state.watchlistRoles = saved ? removeWatchlistRole(state.watchlistRoles, key) : upsertWatchlistRole(state.watchlistRoles, role);
    writeWatchlistRoles(state.watchlistRoles);
    renderWatchlistCount();
    showToast(saved ? "Removed from watchlist" : "Saved to watchlist");
  },

});
*/

function roleArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
}

export function listingKey(listingType, listingId) {
  return `${listingType}:${listingId}`;
}

export function filterListingRoles(items, hiddenKeys = []) {
  const hidden = hiddenKeys instanceof Set ? hiddenKeys : new Set(hiddenKeys);
  return (Array.isArray(items) ? items : []).filter((role) => !hidden.has(listingKeyForRole(role)));
}

function listingKeyForRole(role) {
  return listingKey(role?.listingType || "internship", role?.listingId || role?.id);
}

const WATCHLIST_ROLE_FIELDS = [
  "id", "listingType", "listingId", "jobId", "company", "title", "location",
  "canadianLocation",
  "remoteStatus", "applicationUrl", "postingUrl", "sourceUrl", "sources",
  "technologies", "categories", "relevanceScore", "relevanceReason", "internshipTerm",
  "seasons", "internshipYear", "duration", "postingDate", "discoveredAt", "firstSeenAt", "lastSeenAt",
  "availabilityStatus", "lifecycleStatus", "statusRunId", "missCount", "isNew",
  "normalizedLocations", "eligibilityStatus", "sponsorshipOfferStatus", "description",
  "responsibilities", "requiredQualifications", "preferredQualifications",
  "workAuthorizationRequirements", "sponsorshipInformation", "qualificationDetails",
  // Today feature is dormant for now.
  // "deadline", "salary",
];

export function watchlistRoleKey(role) {
  return listingKeyForRole(role);
}

export function createWatchlistEntry(role, savedAt = new Date().toISOString()) {
  if (!role || !(role.listingId || role.id) || !role.company || !role.title) return null;
  const snapshot = Object.fromEntries(WATCHLIST_ROLE_FIELDS
    .filter((field) => role[field] !== undefined)
    .map((field) => [field, role[field]]));
  return { ...snapshot, savedAt };
}

export function upsertWatchlistRole(entries, role, savedAt = null) {
  const entry = createWatchlistEntry(role, savedAt || new Date().toISOString());
  if (!entry) return Array.isArray(entries) ? [...entries] : [];
  const key = listingKeyForRole(entry);
  const existing = Array.isArray(entries) ? entries : [];
  const index = existing.findIndex((candidate) => listingKeyForRole(candidate) === key);
  if (index < 0) return [entry, ...existing].slice(0, MAX_WATCHLIST_ROLES);
  const next = [...existing];
  next[index] = { ...entry, savedAt: existing[index]?.savedAt || entry.savedAt };
  return next;
}

export function removeWatchlistRole(entries, key) {
  return (Array.isArray(entries) ? entries : []).filter((role) => listingKeyForRole(role) !== key);
}

function watchlistSearchText(role) {
  return [
    role.company,
    role.title,
    ...roleArray(role.location),
    ...roleArray(role.categories),
    ...roleArray(role.technologies),
    role.internshipTerm,
    role.internshipYear,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function watchlistStatusMatches(role, status) {
  const availability = String(role.availabilityStatus || "open").toLocaleLowerCase();
  const lifecycle = String(role.lifecycleStatus || "").toLocaleUpperCase();
  if (status === "closed") return availability === "closed" || lifecycle === "REMOVED_OR_CLOSED";
  if (status === "new") return role.isNew === true || lifecycle === "NEW" || isRecentListing(role, null);
  if (status === "updated") return lifecycle === "UPDATED";
  if (status === "open") return availability !== "closed" && lifecycle !== "REMOVED_OR_CLOSED";
  return true;
}

export function filterWatchlistRoles(entries, {
  status = "open",
  search = "",
  category = "all",
  sort = DEFAULT_ROLE_SORT,
  workMode = "all",
  season = "all",
  seasons,
  location = "all",
} = {}) {
  const normalizedSearch = String(search || "").trim().toLocaleLowerCase();
  const normalizedCategory = String(category || "all");
  const normalizedMode = String(workMode || "all").toLocaleLowerCase();
  const selectedSeasons = normalizeSeasonFilters(seasons === undefined ? season : seasons);
  const normalizedLocation = String(location || "all").toLocaleLowerCase();
  const filtered = (Array.isArray(entries) ? entries : [])
    .filter((role) => {
      if (!hasRequiredListingKeywords(role)) return false;
      if (!watchlistStatusMatches(role, status)) return false;
      if (normalizedSearch && !watchlistSearchText(role).includes(normalizedSearch)) return false;
      if (normalizedCategory !== "all" && !roleArray(role.categories).some((value) => String(value) === normalizedCategory)) return false;
      if (normalizedMode !== "all" && String(role.remoteStatus || "unknown").toLocaleLowerCase() !== normalizedMode) return false;
      if (!seasonFiltersMatchRole(role, selectedSeasons)) return false;
      if (normalizedLocation !== "all" && !roleArray(role.location).join(" ").toLocaleLowerCase().includes(normalizedLocation)) return false;
      return true;
    });

  return filtered.toSorted((left, right) => {
    if (sort === "relevance") return Number(right.relevanceScore || 0) - Number(left.relevanceScore || 0)
      || String(left.company || "").localeCompare(String(right.company || ""));
    if (sort === "recent") return (parseSortDate(right.discoveredAt || right.firstSeenAt || right.savedAt) || 0)
      - (parseSortDate(left.discoveredAt || left.firstSeenAt || left.savedAt) || 0);
    if (sort === "last-seen") return (parseSortDate(right.lastSeenAt) || 0) - (parseSortDate(left.lastSeenAt) || 0);
    if (sort === "season") return compareBySeason(left, right);
    if (sort === "company") return String(left.company || "").localeCompare(String(right.company || ""))
      || String(left.title || "").localeCompare(String(right.title || ""));
    return compareByPostedDate(left, right);
  });
}

export function buildRolesQuery({
  view,
  tab = INITIAL_ROLE_TAB,
  status = "open",
  search = "",
  category = "all",
  workMode = "all",
  season = "all",
  seasons,
  location = "all",
  sort = DEFAULT_ROLE_SORT,
  limit = INITIAL_PAGE_SIZE,
  offset = 0,
} = {}) {
  const params = new URLSearchParams({
    tab,
    status,
    sort,
    limit: String(limit),
    offset: String(offset),
  });
  if (ROLE_VIEWS.includes(view)) params.set("view", view);
  const normalizedSearch = String(search ?? "").trim();
  const normalizedCategory = String(category ?? "").trim();
  if (normalizedSearch) params.set("q", normalizedSearch);
  if (normalizedCategory && normalizedCategory !== "all") params.set("category", normalizedCategory);
  const normalizedWorkMode = String(workMode ?? "all").trim().toLocaleLowerCase();
  if (ROLE_WORK_MODES.includes(normalizedWorkMode) && normalizedWorkMode !== "all") params.set("workMode", normalizedWorkMode);
  const selectedSeasons = normalizeSeasonFilters(seasons === undefined ? season : seasons);
  selectedSeasons.forEach((selectedSeason) => params.append("season", selectedSeason));
  const normalizedLocation = String(location ?? "").trim();
  if (normalizedLocation && normalizedLocation !== "all") params.set("location", normalizedLocation);
  return params;
}

export function shouldFallbackToCanada(payload) {
  const total = Number(payload?.pagination?.total);
  if (Number.isFinite(total)) return total === 0;
  return Array.isArray(payload?.items) && payload.items.length === 0;
}

export function mergeRolePage(previousItems, nextItems, maxItems = Number.POSITIVE_INFINITY) {
  const merged = [];
  const seen = new Set();
  for (const role of [...(previousItems || []), ...(nextItems || [])]) {
    const key = listingKey(role.listingType || "internship", role.listingId || role.id);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(role);
  }
  return Number.isFinite(maxItems) && merged.length > maxItems ? merged.slice(-maxItems) : merged;
}

export function roleQueueHead(items) {
  return Array.isArray(items) && items.length ? items[0] : null;
}

export function canLoadMoreRoles(pagination, loadedCount, maxItems = MAX_RENDERED_ROLES) {
  const nextOffset = pagination?.nextOffset == null ? loadedCount : Number(pagination.nextOffset);
  const total = Number(pagination?.total);
  const totalKnown = Number.isSafeInteger(total) && total >= 0;
  return Boolean(
    pagination?.hasMore
      && Number.isSafeInteger(nextOffset)
      && nextOffset >= 0
      && (!totalKnown || loadedCount < total)
      && (!totalKnown || nextOffset < total)
      && loadedCount < maxItems,
  );
}

// The API total is the boundary for the current filtered result set. Keep the
// client from inheriting a contradictory hasMore/nextOffset pair from a stale
// or changing response, otherwise the sentinel can request one page past the
// advertised result set.
export function normalizeRolePagination(pagination, loadedCount = 0, pageLength = null) {
  const source = pagination && typeof pagination === "object" ? pagination : {};
  const total = Number(source.total);
  const totalKnown = Number.isSafeInteger(total) && total >= 0;
  const nextOffset = source.nextOffset == null ? null : Number(source.nextOffset);
  const validNextOffset = Number.isSafeInteger(nextOffset) && nextOffset >= 0;
  const loaded = Number(loadedCount);
  const loadedKnown = Number.isSafeInteger(loaded) && loaded >= 0;
  const offset = Number(source.offset);
  const validOffset = Number.isSafeInteger(offset) && offset >= 0;
  const previousBoundary = validOffset ? offset : loaded;
  const advancesOffset = validNextOffset
    && (!Number.isSafeInteger(previousBoundary) || nextOffset > previousBoundary);
  const reachedTotal = totalKnown && (
    (loadedKnown && loaded >= total)
      || (validNextOffset && nextOffset >= total)
  );
  const emptyPage = pageLength !== null && Number(pageLength) === 0;
  const hasMore = source.hasMore === true
    && advancesOffset
    && !reachedTotal
    && !emptyPage;
  return {
    ...source,
    hasMore,
    nextOffset: hasMore ? nextOffset : null,
  };
}

export function remainingRolePageSize(pagination, offset, requestedLimit) {
  const limit = Number(requestedLimit);
  if (!Number.isSafeInteger(limit) || limit < 1) return 0;
  const total = Number(pagination?.total);
  if (!Number.isSafeInteger(total) || total < 0) return limit;
  const start = Number(offset);
  if (!Number.isSafeInteger(start) || start < 0) return 0;
  return Math.min(limit, Math.max(0, total - start));
}

export function roleFiltersKey({
  view,
  tab = INITIAL_ROLE_TAB,
  status = "open",
  search = "",
  category = "all",
  workMode = "all",
  season = "all",
  seasons,
  location = "all",
  sort = DEFAULT_ROLE_SORT,
} = {}) {
  const keyParts = [
    tab,
    status,
    sort,
    String(search ?? "").trim().toLocaleLowerCase(),
    String(category ?? "").trim() || "all",
    String(workMode ?? "all").trim().toLocaleLowerCase() || "all",
    normalizeSeasonFilters(seasons === undefined ? season : seasons).join(",") || "all",
    String(location ?? "").trim().toLocaleLowerCase() || "all",
  ];
  const key = keyParts.join("|");
  return ROLE_VIEWS.includes(view) ? `${view}|${key}` : key;
}

function freshPagination() {
  return { limit: INITIAL_PAGE_SIZE, offset: 0, total: 0, hasMore: false, nextOffset: null };
}

// A refresh keeps at least one full initial page but never asks the server for
// more than the /api/roles limit ceiling in a single request.
export function adaptiveListLimit(loadedCount) {
  const loaded = Number(loadedCount);
  const base = Number.isSafeInteger(loaded) && loaded > 0 ? loaded : INITIAL_PAGE_SIZE;
  return Math.min(MAX_PAGE_SIZE, Math.max(INITIAL_PAGE_SIZE, base));
}

export function prefetchLookaheadReady(
  loadedCount,
  pagination,
  initialPageSize = INITIAL_PAGE_SIZE,
  backgroundPageSize = BACKGROUND_PAGE_SIZE,
) {
  return loadedCount >= initialPageSize + backgroundPageSize || !canLoadMoreRoles(pagination, loadedCount);
}

// Other tabs can start warming once the active tab has painted its first page.
export function prefetchBackgroundReady(
  loadedCount,
  pagination,
  initialPageSize = INITIAL_PAGE_SIZE,
) {
  if (loadedCount >= initialPageSize) return true;
  return loadedCount > 0 && !canLoadMoreRoles(pagination, loadedCount);
}

export function shouldPrefetchRoleTab(snapshot, version, minItems = PREFETCH_PAGE_SIZE) {
  if (!snapshot) return true;
  if (version && snapshot.version !== version) return true;
  const count = Array.isArray(snapshot.items) ? snapshot.items.length : 0;
  if (snapshot.pagination?.hasMore === false) return false;
  return count < minItems;
}

export function shouldPrefetchTabLookahead(snapshot, version) {
  if (!snapshot || (version && snapshot.version !== version)) return false;
  if (snapshot.pagination?.hasMore === false) return false;
  const count = Array.isArray(snapshot.items) ? snapshot.items.length : 0;
  return count >= PREFETCH_PAGE_SIZE && count < INITIAL_PAGE_SIZE;
}

export function shouldReplaceTabSnapshot(existing, next) {
  if (!existing) return true;
  if (next?.version && existing.version !== next.version) return true;
  const existingCount = Array.isArray(existing.items) ? existing.items.length : 0;
  const nextCount = Array.isArray(next?.items) ? next.items.length : 0;
  return nextCount >= existingCount;
}

export function rememberTabSnapshot(cache, key, snapshot, maxEntries = TAB_SNAPSHOT_CACHE_MAX) {
  if (!cache || maxEntries < 1) return cache;
  cache.delete(key);
  cache.set(key, snapshot);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return cache;
}

export function getTabSnapshot(cache, key) {
  const snapshot = cache?.get(key) || null;
  if (!snapshot) return null;
  // Re-insert so the most recently viewed tab is the last to be evicted.
  rememberTabSnapshot(cache, key, snapshot);
  return snapshot;
}

export function invalidateRoleListingCaches(tabSnapshots, detailCache) {
  tabSnapshots?.clear?.();
  detailCache?.clear?.();
}

export function isCurrentIntent(capturedIntent, currentIntent) {
  return capturedIntent === currentIntent;
}

export function isDetailCacheValid(cacheEntry, listVersion) {
  return Boolean(cacheEntry && listVersion && cacheEntry.listVersion === listVersion);
}

export function getCachedDetail(cache, key, listVersion) {
  const entry = cache?.get(key);
  return isDetailCacheValid(entry, listVersion) ? entry : null;
}

export function rememberDetailCache(cache, key, entry, maxEntries = DETAIL_CACHE_MAX) {
  if (!cache || maxEntries < 1) return cache;
  cache.set(key, entry);
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  return cache;
}

export function isDetailResponseCurrent(capturedIntent, currentIntent, capturedListVersion, currentListVersion) {
  return isCurrentIntent(capturedIntent, currentIntent) && capturedListVersion === currentListVersion;
}

export function hasVersionChanged(previousVersion, nextVersion) {
  return Boolean(previousVersion && nextVersion && previousVersion !== nextVersion);
}

// A role read can briefly lose the race with the action/crawler writer. The
// server exposes this exact message for that recoverable boundary, so callers
// can retry it without hiding genuine API failures behind a generic retry.
export function isTransientDashboardReadError(error) {
  const message = typeof error?.message === "string" ? error.message : String(error ?? "");
  return message.includes("Dashboard data changed while reading a snapshot");
}

export function applyListingActionCounts(data, payload) {
  if (!data || !payload || typeof payload !== "object") return data;
  const stats = mergeDashboardStats(data.stats, payload.stats);
  if (payload.closedCount !== undefined) stats.closed = payload.closedCount;
  if (payload.hiddenCount !== undefined) stats.hidden = payload.hiddenCount;
  return {
    ...data,
    ...(payload.appliedRoleCount !== undefined
      ? { appliedRoleCount: payload.appliedRoleCount }
      : {}),
    stats,
  };
}

// The lightweight changes response intentionally carries only dynamic
// counters (currently hidden, and optionally closed). Keep those partial
// counters from replacing the full stats snapshot returned by /api/roles.
export function mergeDashboardStats(previousStats, incomingStats) {
  return {
    ...(previousStats && typeof previousStats === "object" ? previousStats : {}),
    ...(incomingStats && typeof incomingStats === "object" ? incomingStats : {}),
  };
}

export function settleListRequest(requestRevision, currentRevision, { append = false, failed = false } = {}) {
  return requestRevision === currentRevision
    ? { current: true, loading: false, loadingMore: false, render: !failed || append }
    : { current: false };
}

export function isScanActive(data, now = Date.now()) {
  const scan = data?.scan;
  // New dashboard responses explicitly publish the authoritative state. This
  // must win even when latestRun is a stale RUNNING database row.
  if (typeof scan?.active === "boolean") return scan.active;

  const run = data?.latestRun;
  const scanStatus = typeof scan?.status === "string" ? scan.status.toUpperCase() : scan?.status;
  const runStatus = typeof run?.status === "string" ? run.status.toUpperCase() : run?.status;
  if (scanStatus && scanStatus !== "RUNNING") return false;
  if (scanStatus !== "RUNNING" && runStatus !== "RUNNING") return false;

  const timestampValue = run?.heartbeat_at || scan?.heartbeatAt || scan?.startedAt || run?.started_at;
  const timestamp = timestampValue ? Date.parse(timestampValue) : Number.NaN;
  if (!Number.isFinite(timestamp)) return false;
  return timestamp <= now + LEGACY_RUN_FUTURE_SKEW_MS && now - timestamp < LEGACY_RUN_MAX_AGE_MS;
}

export function scanUiState(data, scanning = false) {
  const active = isScanActive(data);
  return {
    active,
    refreshEnabled: !scanning && !active,
    terminateVisible: active,
    waitForCompletion: active,
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[character]);
}

function accountLabel(user) {
  const displayName = typeof user?.displayName === "string" ? user.displayName.trim() : "";
  if (displayName) return displayName;
  const email = typeof user?.email === "string" ? user.email.trim() : "";
  return email || "Account";
}

function accountInitials(user, label) {
  const source = String(user?.displayName || user?.email || label || "Account")
    .trim()
    .replace(/@.*$/, "")
    .split(/[\s._+-]+/u)
    .filter(Boolean);
  if (!source.length) return "AC";
  return (source.length > 1 ? `${source[0][0]}${source[1][0]}` : source[0].slice(0, 2)).toUpperCase();
}

function renderAccountIdentity(authState = state.auth) {
  const previousUserId = state.auth?.user?.id;
  state.auth = authState;
  const user = authState?.status === "authenticated" ? authState.user : null;
  if (previousUserId !== user?.id) state.analyticsAccount = null;
  const label = user ? accountLabel(user) : authState?.status === "unavailable" ? "Account unavailable" : "Sign in";
  const email = user?.email || (authState?.status === "unavailable" ? "Account access unavailable" : "No active account");
  const initials = user ? accountInitials(user, label) : "AC";
  const accountStatus = user ? "Account connected" : authState?.status === "unavailable" ? "Unavailable" : "Not connected";

  for (const [selector, value] of [
    ["#dashboard-user-avatar", initials],
    ["#dashboard-user-name", label],
    ["#dashboard-profile-avatar", initials],
    ["#dashboard-profile-name", label],
    ["#dashboard-profile-email", email],
    ["#dashboard-profile-status", accountStatus],
    ["#settings-profile-avatar", initials],
    ["#settings-profile-name", label],
    ["#settings-profile-email", user?.email || "Sign in to connect your account"],
    ["#settings-account-status", accountStatus],
    ["#settings-account-kicker", user ? "Account" : "Not connected"],
  ]) {
    const node = $(selector);
    if (node) node.textContent = value;
  }

  const userButton = $("#user-menu-button");
  if (userButton) userButton.setAttribute("aria-label", user ? `Open account menu for ${label}` : "Open account menu");
  const profileStatus = $("#dashboard-profile-status");
  if (profileStatus) {
    profileStatus.classList.toggle("is-connected", Boolean(user));
    profileStatus.classList.toggle("is-unavailable", authState?.status === "unavailable");
  }
  const logout = $("#dashboard-logout");
  if (logout) logout.hidden = !user;
  if (isAnalyticsView()) {
    renderCrawlStatistics(state.data);
    if (user && previousUserId !== user.id) void syncAnalyticsAccount();
  }
}

function normalizeDashboardSettings(value) {
  const candidate = value && typeof value === "object" ? value : {};
  return {
    theme: SETTINGS_THEME_VALUES.has(candidate.theme) ? candidate.theme : DEFAULT_DASHBOARD_SETTINGS.theme,
    motion: SETTINGS_MOTION_VALUES.has(candidate.motion) ? candidate.motion : DEFAULT_DASHBOARD_SETTINGS.motion,
    defaultTab: ROLE_TABS.includes(candidate.defaultTab) ? candidate.defaultTab : DEFAULT_DASHBOARD_SETTINGS.defaultTab,
    defaultSort: SETTINGS_SORT_VALUES.has(candidate.defaultSort) ? candidate.defaultSort : DEFAULT_DASHBOARD_SETTINGS.defaultSort,
    defaultStatus: SETTINGS_STATUS_VALUES.has(candidate.defaultStatus) ? candidate.defaultStatus : DEFAULT_DASHBOARD_SETTINGS.defaultStatus,
    notifyCompleted: candidate.notifyCompleted !== false,
    notifyFailed: candidate.notifyFailed !== false,
    notifyNew: candidate.notifyNew !== false,
    notifyDeadlineSoon: candidate.notifyDeadlineSoon !== false,
  };
}

function readDashboardSettings() {
  if (typeof localStorage === "undefined") return { ...DEFAULT_DASHBOARD_SETTINGS };
  try {
    return normalizeDashboardSettings(JSON.parse(localStorage.getItem(DASHBOARD_SETTINGS_KEY) || "{}"));
  } catch {
    return { ...DEFAULT_DASHBOARD_SETTINGS };
  }
}

function persistDashboardSettings() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(DASHBOARD_SETTINGS_KEY, JSON.stringify(state.settings));
  } catch {
    showToast("Could not save preferences on this device.");
  }
}

function systemThemeIsDark() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function applyThemePreference(preference) {
  if (typeof document === "undefined") return;
  const resolved = preference === "system" ? (systemThemeIsDark() ? "dark" : "light") : preference;
  const dark = resolved === "dark";
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  const themeColor = document.querySelector("meta[name='theme-color']");
  if (themeColor) themeColor.setAttribute("content", dark ? "#111512" : "#f2f0e9");
  const toggle = $("#theme-toggle");
  if (toggle) {
    toggle.setAttribute("aria-pressed", String(dark));
    toggle.setAttribute("aria-label", dark ? "Switch to light theme" : "Switch to dark theme");
  }
}

function applyMotionPreference(preference = state.settings.motion) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.motion = preference === "reduced" ? "reduced" : "full";
  state.sourceMarqueeKey = null;
  if (state.data) renderSourceMarquee(state.data);
}

function updateDashboardSettings(patch, { announce = false } = {}) {
  state.settings = normalizeDashboardSettings({ ...state.settings, ...patch });
  persistDashboardSettings();
  applyThemePreference(state.settings.theme);
  applyMotionPreference(state.settings.motion);
  state.notifications = state.notifications.filter(notificationPreferenceEnabled);
  state.notificationReadIds = new Set([...state.notificationReadIds].filter((id) => state.notifications.some((notification) => notification.id === id)));
  persistNotificationState();
  renderSettings();
  renderNotifications();
  if (announce) showToast("Preferences saved on this device.");
}

function normalizeWatchlistEntry(value) {
  if (!value || typeof value !== "object") return null;
  const savedAt = typeof value.savedAt === "string" && value.savedAt ? value.savedAt : new Date().toISOString();
  return createWatchlistEntry(value, savedAt);
}

function readWatchlistRoles() {
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    const seen = new Set();
    return parsed.map(normalizeWatchlistEntry).filter((entry) => {
      if (!entry) return false;
      const key = listingKeyForRole(entry);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, MAX_WATCHLIST_ROLES);
  } catch {
    return [];
  }
}

function writeWatchlistRoles(roles) {
  try {
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify((roles || []).slice(0, MAX_WATCHLIST_ROLES)));
  } catch {
    showToast("Could not save the watchlist on this device.");
  }
}

function isWatchlisted(role) {
  const key = listingKeyForRole(role);
  return state.watchlistRoles.some((candidate) => listingKeyForRole(candidate) === key);
}

export function isRoleFeedView(activeView) {
  return activeView === "roles" || activeView === "dashboard";
}

export function isUndoShortcut(event) {
  if (!event || event.defaultPrevented || event.altKey || event.shiftKey || event.isComposing) return false;
  if (!event.ctrlKey && !event.metaKey) return false;
  return String(event.key || "").toLowerCase() === "z";
}

function isSavedRoleView() {
  return state.activeView === "watchlist"
    || (state.activeView === "roles" && state.activeTab === SAVED_ROLE_TAB);
}

function visibleWatchlistRoles() {
  return pendingVisibleRoles(state.watchlistRoles);
}

function isMatchesRoleView() {
  return !isSavedRoleView() && state.roleView === "matches";
}

function syncWatchlistRoles(roles) {
  if (!state.watchlistRoles.length || !Array.isArray(roles) || !roles.length) return;
  const freshByKey = new Map(roles.map((role) => [listingKeyForRole(role), role]));
  let changed = false;
  const next = state.watchlistRoles.map((saved) => {
    const fresh = freshByKey.get(listingKeyForRole(saved));
    if (!fresh) return saved;
    const merged = createWatchlistEntry(fresh, saved.savedAt);
    if (!merged) return saved;
    if (JSON.stringify(merged) !== JSON.stringify(saved)) changed = true;
    return merged;
  });
  if (!changed) return;
  state.watchlistRoles = next;
  writeWatchlistRoles(next);
  renderWatchlistCount();
}

function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.href : "#";
  } catch { return "#"; }
}

export function compactSourceUrl(value, maxLength = 44) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  let display;
  try {
    const parsed = new URL(raw);
    const host = parsed.hostname.replace(/^www\./i, "");
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.replace(/\/+$/, "");
    display = path && path !== "/" ? `${host}${path}` : host;
  } catch {
    display = raw.replace(/^https?:\/\//i, "").replace(/^www\./i, "");
  }
  if (display.length <= maxLength) return display;
  const keepEnd = Math.min(18, Math.max(8, Math.floor(maxLength / 3)));
  const keepStart = Math.max(8, maxLength - keepEnd - 1);
  return `${display.slice(0, keepStart)}…${display.slice(-keepEnd)}`;
}

function formatDate(value, includeTime = false) {
  if (!value) return "Unknown";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", year: "numeric",
    ...(includeTime ? { hour: "numeric", minute: "2-digit" } : {}),
  }).format(date);
}

function formatDurationMs(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "time unavailable";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const totalSeconds = Math.round(seconds);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const remainder = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(remainder).padStart(2, "0")}s`;
  return `${minutes}m ${String(remainder).padStart(2, "0")}s`;
}

function runDurationMs(run) {
  const startedAt = run?.started_at ? new Date(run.started_at).valueOf() : Number.NaN;
  const finishedAt = run?.finished_at ? new Date(run.finished_at).valueOf() : Date.now();
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return null;
  return Math.max(0, finishedAt - startedAt);
}

export function formatRunDuration(run) {
  const duration = runDurationMs(run);
  if (duration === null) return "Elapsed time unavailable";
  return `${formatDurationMs(duration)} elapsed`;
}

export function recentRuns(data, limit = RECENT_RUN_LIMIT) {
  const runs = Array.isArray(data?.runs) && data.runs.length > 0
    ? data.runs
    : (data?.latestRun ? [data.latestRun] : []);
  return runs.slice(0, limit);
}

function mergeRunHistoryLists(previousRuns, incomingRuns) {
  const runsById = new Map();
  for (const run of [...(previousRuns || []), ...(incomingRuns || [])]) {
    if (run?.id === undefined || run?.id === null) continue;
    runsById.set(String(run.id), run);
  }
  return [...runsById.values()]
    .sort((left, right) => Number(right.id) - Number(left.id))
    .slice(0, EXPANDED_RUN_LIMIT);
}

function rememberRunHistory(incomingRuns) {
  if (state.runHistory === null) return incomingRuns;
  state.runHistory = mergeRunHistoryLists(state.runHistory, incomingRuns);
  return state.runHistory;
}

export function recentRunStatus(run, { staleRunning = false } = {}) {
  if (staleRunning) return "STALE";
  const status = String(run?.status || "UNKNOWN").toUpperCase();
  if (status === "FAILED" && /terminated by user/i.test(run?.error_message || "")) return "TERMINATED";
  return status;
}

function notificationRunTimestamp(run) {
  return run?.timestamp || run?.finished_at || run?.started_at || "";
}

function notificationSortValue(value) {
  const timestamp = Date.parse(notificationRunTimestamp(value));
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function notificationComparator(left, right) {
  return notificationSortValue(right) - notificationSortValue(left)
    || Number(right?.runId ?? right?.id ?? 0) - Number(left?.runId ?? left?.id ?? 0);
}

export function notificationIdForRun(run) {
  if (!run || run.id === undefined || run.id === null || run.id === "") return null;
  return `run-${String(run.status || "unknown").toLowerCase()}-${String(run.id)}`;
}

function notificationRuns(data) {
  const byId = new Map();
  const candidates = [
    ...(Array.isArray(data?.runs) ? data.runs : []),
    data?.latestRun,
    data?.latestCompletedRun,
  ];
  for (const run of candidates) {
    if (!run || run.id === undefined || run.id === null) continue;
    const key = String(run.id);
    byId.set(key, { ...(byId.get(key) || {}), ...run });
  }
  return [...byId.values()]
    .filter((run) => ["COMPLETED", "FAILED"].includes(String(run.status || "").toUpperCase()))
    .sort((left, right) => notificationSortValue(right) - notificationSortValue(left)
      || Number(right.id) - Number(left.id));
}

function notificationCount(value) {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? Math.round(count) : null;
}

function notificationCountLabel(count, singular) {
  if (count === null) return "";
  return `${formatNumber(count)} ${count === 1 ? singular : `${singular}s`}`;
}

function runNotificationMessage(run) {
  const runId = `#${run.id}`;
  const status = String(run.status || "").toUpperCase();
  if (status === "FAILED") {
    const message = String(run.error_message || "No error details were reported.")
      .replace(/\s+/g, " ")
      .trim();
    return `${runId} failed${message ? `: ${message.slice(0, 140)}${message.length > 140 ? "…" : ""}` : ""}`;
  }

  const newCount = notificationCount(run.new_count);
  const discoveredCount = notificationCount(run.internships_discovered);
  const newLabel = notificationCountLabel(newCount, "new role");
  const discoveredLabel = notificationCountLabel(discoveredCount, "role");
  if (newLabel && discoveredLabel) return `${runId} completed · ${newLabel} found · ${discoveredLabel} scanned`;
  if (newLabel) return `${runId} completed · ${newLabel} found`;
  if (discoveredLabel) return `${runId} completed · ${discoveredLabel} scanned`;
  return `${runId} completed successfully.`;
}

export function notificationIdForDeadline(notification) {
  if (!notification || notification.id === undefined || notification.id === null || notification.id === "") return null;
  return String(notification.id);
}

export function buildDeadlineNotifications(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const id = notificationIdForDeadline(item);
      if (!id || !item.listingId || !item.company || !item.roleTitle || !item.deadlineAt) return null;
      return {
        id,
        kind: "deadline-soon",
        listingKey: listingKey(item.listingType || "internship", item.listingId),
        listingType: item.listingType || "internship",
        listingId: String(item.listingId),
        company: String(item.company),
        roleTitle: String(item.roleTitle),
        postingUrl: String(item.postingUrl || ""),
        deadline: String(item.deadline || ""),
        deadlineAt: String(item.deadlineAt),
        title: "Closing soon",
        message: `${String(item.roleTitle)} at ${String(item.company)} closes ${formatDate(item.deadlineAt, true)}.`,
        timestamp: String(item.alertAt || item.deadlineAt),
      };
    })
    .filter(Boolean);
}

export function buildNotifications(data, limit = NOTIFICATION_LIMIT) {
  const crawlNotifications = notificationRuns(data)
    .map((run) => {
      const status = String(run.status || "").toUpperCase();
      return {
        id: notificationIdForRun(run),
        kind: status === "FAILED" ? "run-failed" : "run-completed",
        runId: run.id,
        title: status === "FAILED" ? "Crawl failed" : "Crawl completed",
        message: runNotificationMessage(run),
        newCount: notificationCount(run.new_count),
        timestamp: notificationRunTimestamp(run),
      };
    })
    .filter((notification) => notification.id);
  return [...crawlNotifications, ...buildDeadlineNotifications(data?.deadlineNotifications)]
    .sort(notificationComparator)
    .slice(0, limit);
}

function notificationPreferenceEnabled(notification) {
  if (notification?.kind === "deadline-soon") return state.settings.notifyDeadlineSoon;
  if (notification?.kind === "run-failed") return state.settings.notifyFailed;
  if (!state.settings.notifyCompleted) return false;
  return state.settings.notifyNew || notification?.newCount === null || notification?.newCount === 0;
}

export function mergeNotificationHistory(existing, incoming, limit = NOTIFICATION_LIMIT) {
  const byId = new Map();
  for (const notification of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    if (!notification || !notification.id) continue;
    byId.set(String(notification.id), { ...byId.get(String(notification.id)), ...notification, id: String(notification.id) });
  }
  return [...byId.values()].sort(notificationComparator).slice(0, limit);
}

function readNotificationHistory() {
  if (typeof localStorage === "undefined") return [];
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFICATION_HISTORY_KEY) || "[]");
    return Array.isArray(parsed) ? mergeNotificationHistory(parsed, []) : [];
  } catch {
    return [];
  }
}

function readNotificationReadIds() {
  if (typeof localStorage === "undefined") return new Set();
  try {
    const parsed = JSON.parse(localStorage.getItem(NOTIFICATION_READ_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch {
    return new Set();
  }
}

function persistNotificationState() {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(NOTIFICATION_HISTORY_KEY, JSON.stringify(state.notifications.slice(0, NOTIFICATION_LIMIT)));
    localStorage.setItem(NOTIFICATION_READ_KEY, JSON.stringify([...state.notificationReadIds]));
  } catch {
    // Notifications remain available for this session when browser storage is unavailable.
  }
}

function notificationToastMessage(notification) {
  if (notification.kind === "deadline-soon") {
    return `${notification.company} · ${notification.roleTitle} closes within 24 hours.`;
  }
  return notification.kind === "run-failed"
    ? `Crawl #${notification.runId} failed.`
    : `Crawl #${notification.runId} completed.`;
}

function syncNotifications(data) {
  const incoming = buildNotifications(data).filter(notificationPreferenceEnabled);
  if (!state.notificationsReady) {
    const stored = readNotificationHistory().filter(notificationPreferenceEnabled);
    state.notifications = mergeNotificationHistory(stored, incoming);
    state.notificationReadIds = readNotificationReadIds();
    // Existing runs are useful history, but only the newest one should start
    // as an unread item when this device has no notification state yet.
    if (!stored.length) {
      for (const notification of incoming.slice(1)) {
        if (notification.kind !== "deadline-soon") state.notificationReadIds.add(notification.id);
      }
    }
    state.notificationsReady = true;
  } else {
    const previousIds = new Set(state.notifications.map((notification) => notification.id));
    state.notifications = mergeNotificationHistory(state.notifications.filter(notificationPreferenceEnabled), incoming);
    const newlyArrived = incoming.filter((notification) => !previousIds.has(notification.id));
    if (newlyArrived.length > 0) showToast(notificationToastMessage(newlyArrived[0]));
  }
  const currentIds = new Set(state.notifications.map((notification) => notification.id));
  state.notificationReadIds = new Set([...state.notificationReadIds].filter((id) => currentIds.has(id)));
  persistNotificationState();
  renderNotifications();
}

function deadlineNotificationMessage(notification, now = Date.now()) {
  const deadline = new Date(notification.deadlineAt).valueOf();
  const remaining = deadline - now;
  if (!Number.isFinite(remaining)) return notification.message;
  if (remaining <= 0) return `${notification.roleTitle} at ${notification.company} closed ${formatDate(notification.deadlineAt, true)}.`;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const timeLeft = minutes < 60
    ? `${minutes}m`
    : `${Math.max(1, Math.ceil(minutes / 60))}h`;
  return `${notification.roleTitle} at ${notification.company} closes in ${timeLeft} · ${formatDate(notification.deadlineAt, true)}.`;
}

function notificationItemHtml(notification) {
  const unread = !state.notificationReadIds.has(notification.id);
  const deadline = notification.kind === "deadline-soon";
  const icon = notification.kind === "run-failed" || deadline ? "!" : "✓";
  const message = deadline ? deadlineNotificationMessage(notification) : notification.message;
  const actionHint = deadline && notification.postingUrl ? " Open the original posting." : "";
  return `<button class="notification-item${unread ? " unread" : ""}" type="button" data-notification-id="${escapeHtml(notification.id)}" aria-label="${escapeHtml(`${notification.title}. ${message}${actionHint}`)}">
    <span class="notification-icon ${notification.kind === "run-failed" ? "failed" : deadline ? "deadline" : "completed"}" aria-hidden="true">${icon}</span>
    <span class="notification-copy"><span class="notification-item-heading"><strong>${escapeHtml(notification.title)}</strong><time datetime="${escapeHtml(notification.timestamp)}">${escapeHtml(relativeDate(notification.timestamp))}</time></span><span class="notification-message">${escapeHtml(message)}</span>${deadline && notification.postingUrl ? '<span class="notification-link-label">Open original posting</span>' : ""}</span>
    <span class="notification-unread-dot" aria-hidden="true"></span>
  </button>`;
}

function renderNotifications() {
  const notifications = state.notifications.filter(notificationPreferenceEnabled);
  const unreadCount = notifications.filter((notification) => !state.notificationReadIds.has(notification.id)).length;
  const button = $("#notifications-button");
  const badge = $("#notifications-badge");
  const summary = $("#notifications-summary");
  const list = $("#notifications-list");
  const markAll = $("#mark-all-notifications");
  if (badge) {
    badge.hidden = unreadCount === 0;
    badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  }
  if (button) button.setAttribute("aria-label", unreadCount ? `Notifications (${unreadCount} unread)` : "Notifications");
  if (summary) summary.textContent = unreadCount ? `${formatNumber(unreadCount)} unread` : notifications.length ? "All caught up" : "Stay up to date";
  if (markAll) markAll.disabled = unreadCount === 0;
  if (!list) return;
  list.innerHTML = notifications.length
    ? notifications.map(notificationItemHtml).join("")
    : `<div class="notification-empty">Completed crawls and failures will appear here.</div>`;
}

function markNotificationRead(id) {
  const normalizedId = String(id || "");
  if (!normalizedId || !state.notifications.some((notification) => notification.id === normalizedId)) return;
  state.notificationReadIds.add(normalizedId);
  persistNotificationState();
  renderNotifications();
}

function markAllNotificationsRead() {
  for (const notification of state.notifications) state.notificationReadIds.add(notification.id);
  persistNotificationState();
  renderNotifications();
}

function recentRunRowHtml(run, { staleRunning = false } = {}) {
  const status = recentRunStatus(run, { staleRunning });
  const statusClass = status === "FAILED" || status === "STALE" ? "failed" : status === "RUNNING" ? "running" : status === "TERMINATED" ? "terminated" : "completed";
  return `<div class="recent-run"><div class="recent-run-meta"><span class="run-date">#${escapeHtml(run.id)} · ${escapeHtml(relativeDate(run.started_at))}</span><span class="run-duration">${escapeHtml(formatRunDuration(run))}</span></div><div class="run-aside"><span class="run-state ${statusClass}">${escapeHtml(status === "STALE" ? "FAILED" : status)}</span><span class="run-count">${escapeHtml(formatNumber(run.internships_discovered ?? 0))} roles</span></div></div>`;
}

function elapsedSince(value) {
  const startedAt = value ? new Date(value).valueOf() : Number.NaN;
  return Number.isFinite(startedAt) ? Math.max(0, Date.now() - startedAt) : null;
}

function relativeDate(value) {
  if (!value) return "Unknown";
  const delta = Date.now() - new Date(value).valueOf();
  if (!Number.isFinite(delta)) return formatDate(value);
  const minutes = Math.round(delta / 60000);
  if (minutes < 1) return "just now";
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
  if (minutes < 60) return formatter.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return formatter.format(-hours, "hour");
  return formatter.format(-Math.round(hours / 24), "day");
}

function compactDuration(value) {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  if (milliseconds < 1000) return `${Math.round(milliseconds)}ms`;
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
  return formatDurationMs(milliseconds);
}

function latestCompletedRun(data) {
  return data?.latestCompletedRun || (data?.latestRun?.status === "COMPLETED" ? data.latestRun : null);
}

function crawlErrorCount(data, health) {
  const explicit = [data?.errors24h, data?.scan?.errors24h, data?.stats?.errors24h]
    .map((value) => Number(value))
    .find((value) => Number.isFinite(value) && value >= 0);
  if (explicit !== undefined) return explicit;
  const failures = Array.isArray(data?.failures) ? data.failures : [];
  const failureCount = failures.reduce((total, failure) => {
    const count = Number(failure?.count);
    return total + (Number.isFinite(count) && count >= 0 ? count : 1);
  }, 0);
  return failureCount || Number(health?.failed) || 0;
}

function averageRunDuration(data) {
  const runs = Array.isArray(data?.runs) ? [...data.runs] : [];
  const completed = latestCompletedRun(data);
  if (completed && !runs.some((run) => String(run?.id) === String(completed.id))) runs.push(completed);
  const durations = runs
    .filter((run) => String(run?.status || "").toUpperCase() === "COMPLETED" && run?.started_at && run?.finished_at)
    .map((run) => runDurationMs(run))
    .filter((value) => value !== null);
  if (!durations.length) return "—";
  return compactDuration(durations.reduce((total, value) => total + value, 0) / durations.length);
}

function nextCrawlLabel(data, completed) {
  const baseValue = completed?.finished_at || completed?.started_at;
  const base = baseValue ? new Date(baseValue).valueOf() : Number.NaN;
  const intervalMinutes = Number(data?.scheduler?.intervalMinutes ?? 90);
  if (!Number.isFinite(base) || !Number.isFinite(intervalMinutes) || intervalMinutes <= 0) return "—";
  const remaining = Math.ceil((base + intervalMinutes * 60_000 - Date.now()) / 60_000);
  return remaining > 0 ? `${remaining}m` : "Due now";
}

function setCrawlField(field, value) {
  document.querySelectorAll(`[data-crawl-field="${field}"]`).forEach((node) => {
    node.textContent = String(value ?? "—");
  });
}

function renderCrawlHealthSummary(data, health = sourceHealthCounts(data)) {
  const completed = latestCompletedRun(data);
  setCrawlField("last-crawl", completed ? relativeDate(completed.finished_at || completed.started_at) : "—");
  setCrawlField("next-crawl", nextCrawlLabel(data, completed));
  setCrawlField("errors", formatNumber(crawlErrorCount(data, health)));
  setCrawlField("average-duration", averageRunDuration(data));
}

function listHtml(values, empty = "Unknown") {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  return list.length ? `<ul>${list.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : `<p>${escapeHtml(empty)}</p>`;
}

function linkHtml(label, value) {
  const url = safeUrl(value);
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`;
}

function configuredSourceCount(data) {
  const candidates = [data?.scan?.configuredSourceCount, data?.configuredSourceCount]
    .map((value) => Number(value)).filter((value) => Number.isInteger(value) && value >= 0);
  return Math.max(...candidates, 0);
}

export function inProgressSources(data) {
  const listed = data?.scan?.currentSources;
  if (Array.isArray(listed) && listed.length) {
    return listed.filter((source) => source && typeof source.url === "string" && source.url);
  }
  const current = data?.scan?.currentSource;
  if (current && typeof current.url === "string" && current.url) return [current];
  const results = Array.isArray(data?.sourceResults) ? data.sourceResults : [];
  return results
    .filter((result) => result?.url && (Number(result.settled) === 0 || result.settled === false))
    .map((result) => ({ url: result.url, startedAt: result.startedAt || result.started_at || null }));
}

export function sourceRunKey(data) {
  // While a crawl is live, remember results under the in-memory scan id.
  // Once the run is terminal, always key off latestRun so a FAILED run cannot
  // keep the previous completed crawl's source rows in the sidebar.
  if (isScanActive(data)) return data?.scan?.runId || data?.latestRun?.id || null;
  return data?.latestRun?.id || data?.scan?.runId || data?.latestCompletedRun?.id || null;
}

function isSourceSettled(result) {
  return Number(result?.settled) === 1 || result?.settled === true;
}

const SUCCESSFUL_SOURCE_STATUSES = new Set(["success", "no_internships_found"]);

export function sourceCheckStatus(result) {
  if (!result || !isSourceSettled(result)) return "unchecked";
  const status = String(result.status || "").toLowerCase();
  const failureCount = Number(result.failure_count);
  const completed = Number(result.completed) === 1;
  if (status === "partial" || (completed && Number.isFinite(failureCount) && failureCount > 0)) return "partial";
  if (completed || SUCCESSFUL_SOURCE_STATUSES.has(status)) return "success";
  return "failed";
}

export function rememberSourceResults(runKey, previousMemory, incoming) {
  const incomingRows = (Array.isArray(incoming) ? incoming : []).filter((row) => row && typeof row.url === "string" && row.url);
  if (runKey == null) return { runKey: null, results: incomingRows };
  const previous = previousMemory?.runKey === runKey ? (previousMemory.results || []) : [];
  const byUrl = new Map(previous.map((row) => [row.url, row]));
  for (const row of incomingRows) {
    const existing = byUrl.get(row.url);
    if (existing && isSourceSettled(existing) && !isSourceSettled(row)) continue;
    byUrl.set(row.url, row);
  }
  return { runKey, results: [...byUrl.values()] };
}

function applyRememberedSourceHealth(payload, previousData = state.data) {
  if (!payload || typeof payload !== "object") return payload;
  const incomingResults = Object.prototype.hasOwnProperty.call(payload, "sourceResults")
    ? payload.sourceResults
    : previousData?.sourceResults;
  state.sourceResultMemory = rememberSourceResults(sourceRunKey(payload), state.sourceResultMemory, incomingResults);
  const incomingSources = Array.isArray(payload.sources)
    ? payload.sources
    : (Array.isArray(previousData?.sources) ? previousData.sources : []);
  const sourcesByUrl = new Map();
  for (const source of incomingSources) {
    if (source?.url) sourcesByUrl.set(source.url, source);
  }
  for (const result of state.sourceResultMemory.results) {
    if (!sourcesByUrl.has(result.url)) sourcesByUrl.set(result.url, { url: result.url, last_crawled_at: null, last_status: null, isConfigured: true });
  }
  return {
    ...payload,
    sources: [...sourcesByUrl.values()],
    sourceResults: state.sourceResultMemory.results,
  };
}

export function provenanceSourceRows(data) {
  const checkingByUrl = new Map(inProgressSources(data).map((source) => [source.url, source]));
  const resultsByUrl = new Map((Array.isArray(data?.sourceResults) ? data.sourceResults : []).filter((row) => row?.url).map((row) => [row.url, row]));
  const sourcesByUrl = new Map();
  for (const source of Array.isArray(data?.sources) ? data.sources : []) {
    if (source?.url) sourcesByUrl.set(source.url, source);
  }
  for (const url of resultsByUrl.keys()) {
    if (!sourcesByUrl.has(url)) sourcesByUrl.set(url, { url, last_crawled_at: null, last_status: null, isConfigured: true });
  }
  for (const url of checkingByUrl.keys()) {
    if (!sourcesByUrl.has(url)) sourcesByUrl.set(url, { url, last_crawled_at: null, last_status: null, isConfigured: true });
  }
  const rank = { failed: 0, partial: 1, success: 2, unchecked: 3 };
  const rows = [...sourcesByUrl.values()].map((source) => {
    const result = resultsByUrl.get(source.url);
    const checking = Boolean(checkingByUrl.get(source.url));
    const status = checking && !isSourceSettled(result) ? "unchecked" : sourceCheckStatus(result);
    const className = status === "failed" ? "source-fail" : status === "partial" ? "source-partial" : status === "success" ? "source-ok" : "source-unchecked";
    let detail = "Not checked in this run";
    if (status === "success") {
      const parts = [];
      if (result?.duration_ms != null) parts.push(formatDurationMs(result.duration_ms));
      if (Number.isFinite(Number(result?.jobs_discovered))) parts.push(`${result.jobs_discovered} roles`);
      detail = parts.join(" · ") || "Checked";
    } else if (status === "partial") {
      const parts = [];
      if (result?.status) parts.push(String(result.status).replace(/_/g, " "));
      if (Number.isFinite(Number(result?.jobs_discovered))) parts.push(`${result.jobs_discovered} roles`);
      if (Number.isFinite(Number(result?.failure_count)) && Number(result.failure_count) > 0) parts.push(`${result.failure_count} page failure${Number(result.failure_count) === 1 ? "" : "s"}`);
      detail = parts.join(" · ") || "Checked with page failures";
    } else if (status === "failed") {
      detail = result?.status ? String(result.status).replace(/_/g, " ") : "Check failed";
    } else if (checking) {
      detail = "In progress";
    }
    return {
      url: source.url,
      isConfigured: source.isConfigured !== false,
      checking,
      status,
      label: status,
      className,
      detail,
      jobsDiscovered: result?.jobs_discovered != null && Number.isFinite(Number(result.jobs_discovered)) ? Number(result.jobs_discovered) : null,
      pagesVisited: result?.pages_visited != null && Number.isFinite(Number(result.pages_visited)) ? Number(result.pages_visited) : null,
      postingsInspected: result?.potential_postings_inspected != null && Number.isFinite(Number(result.potential_postings_inspected)) ? Number(result.potential_postings_inspected) : null,
      failureCount: result?.failure_count != null && Number.isFinite(Number(result.failure_count)) ? Number(result.failure_count) : null,
      durationMs: result?.duration_ms != null && Number.isFinite(Number(result.duration_ms)) ? Number(result.duration_ms) : null,
    };
  });
  return rows.toSorted((left, right) => (rank[left.status] - rank[right.status]) || Number(right.checking) - Number(left.checking) || left.url.localeCompare(right.url));
}

export function sourceHealthCounts(data) {
  const rows = provenanceSourceRows(data);
  const sourceCount = configuredSourceCount(data) || rows.length;
  return {
    rows,
    sourceCount,
    settled: rows.filter((row) => row.status !== "unchecked").length,
    success: rows.filter((row) => row.status === "success").length,
    partial: rows.filter((row) => row.status === "partial").length,
    failed: rows.filter((row) => row.status === "failed").length,
    unchecked: rows.filter((row) => row.status === "unchecked").length,
  };
}

export function crawlProgressMessage(data) {
  const run = data?.latestRun;
  const scan = data?.scan || {};
  const active = isScanActive(data);
  const terminated = run?.status === "FAILED" && /terminated by user/i.test(run.error_message || scan.error || "");
  const health = sourceHealthCounts(data);
  const runSettled = Number(run?.sources_settled);
  const runSourceCount = Number(run?.sources_requested);
  const settled = Number.isFinite(runSettled) ? runSettled : health.settled;
  const sourceCount = Number.isFinite(runSourceCount) && runSourceCount >= 0 ? runSourceCount : health.sourceCount;
  if (active) {
    return scan.terminationRequested
      ? "Terminating current crawl…"
      : `Crawling · ${Number.isFinite(settled) ? settled : 0}/${sourceCount} sources settled · ${run?.pages_visited ?? 0} pages visited`;
  }
  if (terminated) return "Crawl terminated by user.";
  if (run?.status === "FAILED" || scan.status === "FAILED") {
    const error = scan.error || run?.error_message || "unknown error";
    if (Number.isFinite(settled) && sourceCount > 0 && settled < sourceCount) {
      return `Last run failed after ${settled}/${sourceCount} sources settled: ${error}`;
    }
    return `Last run failed: ${error}`;
  }
  return "All configured sources checked";
}

function sourceRowHtml(row) {
  const href = safeUrl(row.url);
  const metrics = [
    row.jobsDiscovered !== null ? `${formatNumber(row.jobsDiscovered)} roles` : "",
    row.pagesVisited !== null ? `${formatNumber(row.pagesVisited)} pages` : "",
    row.durationMs !== null ? compactDuration(row.durationMs) : "",
  ].filter(Boolean).join(" · ");
  return `<div class="source-row"><div class="source-name"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(row.url)}">${escapeHtml(compactSourceUrl(row.url, 36))}</a><span class="source-detail">${escapeHtml(metrics || row.detail)}</span></div><span class="${escapeHtml(row.className)}">${escapeHtml(row.label)}</span></div>`;
}

export function failureRowHtml(failure) {
  const source = failure.source_url && failure.source_url !== "(unknown)"
    ? linkHtml(compactSourceUrl(failure.source_url), failure.source_url)
    : escapeHtml(failure.source_url || "Unknown source");
  const count = Number(failure.count);
  const countLabel = Number.isFinite(count) && count > 1 ? ` ×${count}` : "";
  const status = failure.status_code != null ? ` HTTP ${escapeHtml(failure.status_code)}` : "";
  const occurredAt = failure.occurred_at ? new Date(failure.occurred_at) : null;
  const time = occurredAt && Number.isFinite(occurredAt.valueOf())
    ? `<time datetime="${escapeHtml(occurredAt.toISOString())}">${escapeHtml(occurredAt.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" }))}</time>`
    : "";
  const metadata = [
    time,
    failure.run_id != null ? `Crawl #${escapeHtml(failure.run_id)}` : "",
    Number(failure.retry_count) > 0 ? `${escapeHtml(failure.retry_count)} ${Number(failure.retry_count) === 1 ? "retry" : "retries"}` : "",
  ].filter(Boolean).join(" · ");
  const page = failure.url ? `<a class="failure-url" href="${escapeHtml(safeUrl(failure.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(failure.url)}</a>` : "";
  return `<div class="failure-row" role="listitem"><strong>${source}${escapeHtml(countLabel)}</strong>${metadata ? `<div class="failure-meta">${metadata}</div>` : ""}${page}<p>${escapeHtml(String(failure.error_type || "error").replace(/_/g, " "))}${status}: ${escapeHtml(failure.message || "Request failed")}</p></div>`;
}

function detailBlock(title, body, full = false) {
  return `<div class="detail-block${full ? " full" : ""}"><h4>${escapeHtml(title)}</h4>${body}</div>`;
}

function roleIdentityAttributes(role) {
  const location = Array.isArray(role.location) ? role.location.join(" · ") : "";
  return `data-listing-application-url="${escapeHtml(role.applicationUrl || "")}" data-listing-posting-url="${escapeHtml(role.postingUrl || "")}" data-listing-job-id="${escapeHtml(role.jobId || "")}" data-listing-location="${escapeHtml(location)}"`;
}

function listingActionButtons(role, listingType, listingId, company, title, { wrapped = true } = {}) {
  const label = escapeHtml(`${title} at ${company}`);
  const attributes = roleIdentityAttributes(role);
  const applied = `<button class="listing-action-button applied-action" type="button" data-listing-type="${escapeHtml(listingType)}" data-listing-id="${escapeHtml(listingId)}" data-listing-action="applied" data-listing-company="${escapeHtml(company)}" data-listing-title="${escapeHtml(title)}" ${attributes} aria-label="Mark ${label} as applied">Mark applied</button>`;
  const hidden = `<button class="listing-action-button cant-fit-action" type="button" data-listing-type="${escapeHtml(listingType)}" data-listing-id="${escapeHtml(listingId)}" data-listing-action="cant_fit" data-listing-company="${escapeHtml(company)}" data-listing-title="${escapeHtml(title)}" ${attributes} aria-label="Hide ${label} because it does not fit">Can't fit</button>`;
  return wrapped ? `<div class="listing-actions" aria-label="Actions for ${label}">${applied}${hidden}</div>` : `${applied}${hidden}`;
}

function roleDetailsHtml(role) {
  const liveSource = role.listingType === "grind";
  const qualifications = [...(role.educationRequirements || []), ...(role.graduationRequirements || [])];
  const authorization = [...(role.workAuthorizationRequirements || []), role.sponsorshipInformation].filter(Boolean);
  const sources = (role.sources || []).map((source) => `<div>${linkHtml(source, source)}</div>`).join("");
  const description = role.description || (liveSource ? "Full details are available on the live source posting." : "Unknown");
  return `<div class="detail-grid">
    ${detailBlock("Description", `<p>${escapeHtml(description)}</p>`, true)}
    ${detailBlock("Responsibilities", listHtml(role.responsibilities))}
    ${detailBlock("Required qualifications", listHtml(role.requiredQualifications))}
    ${detailBlock("Preferred qualifications", listHtml(role.preferredQualifications))}
    ${detailBlock("Education / graduation", listHtml(qualifications))}
    ${detailBlock("Work authorization / sponsorship", listHtml(authorization))}
    ${detailBlock("Technologies", listHtml(role.technologies))}
    ${detailBlock("Compensation / timing", listHtml([role.salary && `Salary: ${role.salary}`, role.deadline && `Deadline: ${role.deadline}`, role.internshipYear && `Year: ${role.internshipYear}`, role.duration && `Duration: ${role.duration}`]))}
    ${detailBlock("Links", `<div class="link-stack">${linkHtml("Direct application", role.applicationUrl)}${linkHtml("Original posting", role.postingUrl)}</div>`)}
    ${detailBlock("Discovered through", `<div class="link-stack">${sources || "<p>Unknown</p>"}</div>`, true)}
  </div>`;
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString("en-US") : "0";
}

function crawlStatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function crawlStatHtml(className, value, label) {
  return `<div class="crawl-stat ${className}">
    <span class="crawl-stat-value">${value == null ? "—" : escapeHtml(formatNumber(value))}</span>
    <span class="crawl-stat-label">${label}</span>
  </div>`;
}

function normalizeCompanyName(company) {
  return String(company || "")
    .replace(/[*_]+/g, " ")
    .replace(/[✓✔]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/['’]/g, "")
    .replace(/&/g, " and ")
    .replace(/[/·]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companySlug(company) {
  return normalizeCompanyName(company)
    .toLocaleLowerCase()
    .replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|co|company|lp|plc|ag)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function companyDomainSlug(company) {
  return normalizeCompanyName(company)
    .toLocaleLowerCase()
    .replace(/\b(?:incorporated|inc|llc|ltd|limited|corp|corporation|co|company|lp|plc|ag)\b/g, " ")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .trim();
}

function splitCamelCase(value) {
  return String(value || "")
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2");
}

function domainLikeValue(value) {
  const token = String(value || "")
    .trim()
    .toLocaleLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  if (!/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+$/.test(token)) return "";
  const tld = token.split(".").pop() ?? "";
  if (!/^(?:com|org|net|edu|gov|io|ai|co|app|dev|tech|so|me|info|us|uk|ca|au|de|fr|jp|in|jobs|gg|fm|tv|cc|cloud)$/i.test(tld)) return "";
  return token;
}

function isGenericJobHost(hostname) {
  return GENERIC_JOB_HOSTS.some((pattern) => pattern.test(hostname));
}

function rootDomain(hostname) {
  const labels = String(hostname || "").toLocaleLowerCase().replace(/^www\./, "").split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const suffix = labels.slice(-2).join(".");
  return ["co.uk", "com.au", "co.nz", "co.jp", "com.br"].includes(suffix)
    ? labels.slice(-3).join(".")
    : suffix;
}

function addLogoDomain(domains, value) {
  const candidate = String(value || "").toLocaleLowerCase().replace(/^\.+|\.+$/g, "");
  if (!/^(?=.{3,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(candidate)) return;
  if (!domains.includes(candidate)) domains.push(candidate);
}

function decodePathSegment(value) {
  try {
    return decodeURIComponent(String(value || ""));
  } catch {
    return String(value || "");
  }
}

function slugStems(value) {
  const decoded = decodePathSegment(value);
  const dotted = decoded.replace(/-dot-/gi, ".");
  const domain = domainLikeValue(dotted);
  if (domain) return [domain];
  const hyphen = companyDomainSlug(splitCamelCase(dotted));
  if (!hyphen) return [];
  const compact = hyphen.replace(/-/g, "");
  const suffixPeeled = [];
  let suffixBase = compact;
  for (const suffix of ["university", "careers", "jobs", "corp", "inc", "group", "official", "recruiting"]) {
    if (suffixBase.length > suffix.length + 2 && suffixBase.endsWith(suffix)) {
      suffixBase = suffixBase.slice(0, -suffix.length);
      suffixPeeled.push(suffixBase);
    }
  }
  const stems = [...suffixPeeled];
  if (compact) stems.push(compact);
  if (hyphen !== compact) stems.push(hyphen);
  const withoutTrailingDigits = compact.replace(/\d+$/, "");
  if (withoutTrailingDigits.length >= 4 && withoutTrailingDigits !== compact) stems.unshift(withoutTrailingDigits);
  const parts = hyphen.split("-").filter(Boolean);
  while (parts.length > 1 && GENERIC_COMPANY_WORDS.has(parts[parts.length - 1])) {
    parts.pop();
    const nextHyphen = parts.join("-");
    const nextCompact = parts.join("");
    if (nextCompact) stems.push(nextCompact);
    if (nextHyphen !== nextCompact) stems.push(nextHyphen);
  }
  return [...new Set(stems.filter(Boolean))];
}

function addSlugLogoDomains(domains, value, { university = false } = {}) {
  const domain = domainLikeValue(value);
  if (domain) {
    addLogoDomain(domains, domain);
    return;
  }
  const stems = slugStems(value);
  const allowAltTlds = !/[\s.-]/.test(String(value || "").trim());
  for (const stem of stems) {
    if (stem.includes(".")) {
      addLogoDomain(domains, stem);
      continue;
    }
    if (stem.length < 2) continue;
    addLogoDomain(domains, `${stem}.com`);
    if (university) addLogoDomain(domains, `${stem}.edu`);
    if (allowAltTlds && !stem.includes("-") && stem.length >= 3 && stem.length <= 16) {
      addLogoDomain(domains, `${stem}.io`);
      addLogoDomain(domains, `${stem}.ai`);
    }
  }
}

function companyNameVariants(company) {
  const normalized = normalizeCompanyName(company);
  if (!normalized) return [];
  const variants = [];
  const seen = new Set();
  const add = (value) => {
    const cleaned = String(value || "").replace(/^\s+(?:the|a|an)\s+/i, "").replace(/\s+/g, " ").trim();
    if (!cleaned || seen.has(cleaned.toLocaleLowerCase())) return;
    seen.add(cleaned.toLocaleLowerCase());
    variants.push(cleaned);
  };
  const words = normalized.split(/\s+/).filter(Boolean);
  const leadingAcronym = words[0] || "";
  if (/^[A-Z]{2,6}$/.test(leadingAcronym) && words.length >= 4) add(leadingAcronym);
  add(normalized);
  for (const part of normalized.split(/\s+[-–—|/]\s+/)) add(part);
  for (const current of [...variants]) {
    const words = current.split(/\s+/).filter(Boolean);
    while (words.length > 1 && GENERIC_COMPANY_WORDS.has(words[words.length - 1].toLocaleLowerCase())) {
      words.pop();
      add(words.join(" "));
    }
  }
  return variants;
}

function addCompanyNameLogoDomains(domains, company) {
  const university = /\b(?:university|college|institute)\b/i.test(String(company || ""));
  const domain = domainLikeValue(normalizeCompanyName(company));
  if (domain) addLogoDomain(domains, domain);
  for (const variant of companyNameVariants(company)) {
    if (domainLikeValue(variant)) {
      addLogoDomain(domains, domainLikeValue(variant));
      continue;
    }
    addSlugLogoDomains(domains, variant, { university });
  }
}

function meaningfulPathSegments(pathname) {
  return String(pathname || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => decodePathSegment(segment))
    .filter((segment) => {
      const lower = segment.toLocaleLowerCase();
      return !GENERIC_PATH_SLUGS.has(lower)
        && !/^cx[_-]?\d+/i.test(segment)
        && !/^[a-z]{0,2}\d{6,}$/i.test(segment)
        && segment.length > 1;
    });
}

function addLogoDomainFromUrl(domains, value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return;
  }
  const hostname = parsed.hostname.toLocaleLowerCase();
  if (!hostname || hostname === "localhost") return;
  if (/(?:github\.com|githubusercontent\.com)$/i.test(hostname)) return;

  if (/(?:dreamworkhq\.com)$/i.test(hostname)) {
    for (const segment of meaningfulPathSegments(parsed.pathname)) {
      const embedded = domainLikeValue(segment);
      if (embedded) addLogoDomain(domains, embedded);
    }
  }
  const forCompany = parsed.searchParams.get("for");
  if (forCompany) addSlugLogoDomains(domains, forCompany);

  if (isGenericJobHost(hostname)) {
    const hostSlug = hostname.split(".")[0]
      .replace(/^(?:careers?|jobs?)-/i, "")
      .replace(/(?:careers?|jobs?)$/i, "");
    const pathContainsCompanySlug = /(?:greenhouse\.(?:io|com)|lever\.co|ashbyhq\.com|jobvite\.com|smartrecruiters\.com|workable\.com|rippling\.com)$/i.test(hostname);
    if (pathContainsCompanySlug) {
      const pathSlug = meaningfulPathSegments(parsed.pathname)[0];
      if (pathSlug) addSlugLogoDomains(domains, pathSlug);
    }
    if (/(?:linkedin\.com)$/i.test(hostname)) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const companyIndex = parts.findIndex((part) => part.toLocaleLowerCase() === "company");
      if (companyIndex >= 0 && parts[companyIndex + 1]) addSlugLogoDomains(domains, parts[companyIndex + 1]);
    }
    if (/(?:myworkdaysite\.com)$/i.test(hostname)) {
      const parts = parsed.pathname.split("/").filter(Boolean);
      const recruitingIndex = parts.findIndex((part) => part.toLocaleLowerCase() === "recruiting");
      const token = recruitingIndex >= 0 ? parts[recruitingIndex + 1] : "";
      if (token && token.length > 2) addSlugLogoDomains(domains, token);
    }
    const hostContainsCompanySlug = /(?:\.myworkdayjobs\.com|\.icims\.com|\.eightfold\.ai|\.applytojob\.com|\.avature\.net|\.jibeapply\.com|\.ultipro\.com)$/i.test(hostname);
    if (
      hostContainsCompanySlug
      && hostSlug
      && !GENERIC_HOST_SLUGS.has(hostSlug.toLocaleLowerCase())
      && !/^wd\d+$/i.test(hostSlug)
    ) {
      addSlugLogoDomains(domains, hostSlug);
    }
    return;
  }

  for (const domain of CAREER_HOST_ALIASES.get(rootDomain(hostname)) || CAREER_HOST_ALIASES.get(hostname) || []) {
    addLogoDomain(domains, domain);
  }
  if (CAREER_HOST_ALIASES.has(rootDomain(hostname)) || CAREER_HOST_ALIASES.has(hostname)) return;
  if (/\.jobs$/i.test(hostname)) {
    const brand = hostname.replace(/^www\./, "").split(".")[0];
    if (brand) addLogoDomain(domains, `${brand}.com`);
    return;
  }
  const root = rootDomain(hostname);
  const sld = root.split(".")[0] || "";
  const careerBrand = sld.replace(/(?:careers|jobs)$/i, "");
  if (careerBrand && careerBrand !== sld && careerBrand.length >= 2) addLogoDomain(domains, `${careerBrand}.com`);
  addLogoDomain(domains, root);
}

export function companyLogoDomains(role = {}) {
  const domains = [];
  const company = role.company || "";
  const slug = companySlug(company);
  const explicitDomain = role.companyLogoDomain || role.logoDomain;
  if (explicitDomain) addLogoDomain(domains, explicitDomain);
  for (const domain of COMPANY_DOMAIN_ALIASES.get(slug) || []) addLogoDomain(domains, domain);
  for (const url of [role.applicationUrl, role.postingUrl, role.sourceUrl, ...(role.sources || [])]) {
    if (url) addLogoDomainFromUrl(domains, url);
  }
  addCompanyNameLogoDomains(domains, company);
  return domains.slice(0, MAX_LOGO_DOMAINS);
}

export function companyLogoSources(role = {}) {
  const explicitUrls = [role.companyLogoUrl, role.logoUrl]
    .map((value) => safeUrl(value))
    .filter((value) => value !== "#");
  const domains = companyLogoDomains(role);
  const hunterUrls = domains.map((domain) => `${COMPANY_LOGO_ORIGIN}/${encodeURIComponent(domain)}`);
  const faviconUrls = domains.map((domain) => `${COMPANY_FAVICON_ORIGIN}?sz=128&domain=${encodeURIComponent(domain)}`);
  return [...new Set([...explicitUrls, ...hunterUrls, ...faviconUrls])];
}

export function companyLogoUrl(role = {}) {
  return companyLogoSources(role)[0] || "";
}

function companyLogoFallbackSvg() {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 20V6.8L12 4l7 2.8V20" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><path d="M8.5 10h1M14.5 10h1M8.5 13.5h1M14.5 13.5h1M10 20v-3.5h4V20" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
}

function companyLogoHtml(role, size = "") {
  const sources = companyLogoSources(role);
  const source = sources[0] || "";
  const remaining = sources.slice(1);
  const sourcesAttribute = remaining.length ? ` data-logo-sources="${escapeHtml(JSON.stringify(remaining))}"` : "";
  const image = source
    ? `<img class="company-logo-image" data-company-logo src="${escapeHtml(source)}"${sourcesAttribute} alt="" aria-hidden="true" width="40" height="40" loading="lazy" decoding="async" />`
    : "";
  return `<span class="company-logo${size ? ` ${size}` : ""}" title="${escapeHtml(`${role.company || "Company"} logo`)}" aria-hidden="true">${image}<span class="company-logo-fallback">${companyLogoFallbackSvg()}</span></span>`;
}

function bindCompanyLogos(root) {
  if (!root?.querySelectorAll) return;
  root.querySelectorAll("img[data-company-logo]").forEach((image) => {
    if (image.dataset.logoBound) return;
    image.dataset.logoBound = "true";
    const logo = image.closest(".company-logo");
    let sources = [];
    try {
      sources = [image.getAttribute("src"), ...JSON.parse(image.dataset.logoSources || "[]")].filter(Boolean);
    } catch {
      sources = [image.getAttribute("src")].filter(Boolean);
    }
    sources = [...new Set(sources)];
    let sourceIndex = 0;
    const showFallback = () => {
      image.hidden = true;
      logo?.classList.add("company-logo-fallback-visible");
    };
    image.addEventListener("load", () => {
      image.hidden = false;
      logo?.classList.remove("company-logo-fallback-visible");
    });
    image.addEventListener("error", () => {
      sourceIndex += 1;
      if (sources[sourceIndex]) {
        image.setAttribute("src", sources[sourceIndex]);
        return;
      }
      showFallback();
    });
    if (!sources.length) showFallback();
  });
}

function formatMode(role) {
  const status = String(role.remoteStatus || "unknown").toLowerCase();
  const label = { remote: "Remote", hybrid: "Hybrid", onsite: "On-site", unknown: "—" }[status] || status;
  const unique = [...new Set(roleArray(role.location).filter(Boolean))];
  if (status === "onsite" && unique.length > 1) return `${label} (Multiple)`;
  return label;
}

export function roleDisplayLocation(role, activeTab = "main") {
  const unique = [...new Set(roleArray(role.location).filter(Boolean))];
  const normalizedCanadianLocation = roleArray(role.normalizedLocations).find((location) => (
    location && typeof location === "object"
      && (String(location.remoteScope || "").toLowerCase() === "canada"
        || ["canada", "canadian"].includes(String(location.country || "").toLowerCase()))
  ));
  const canadianLocation = activeTab === "canada"
    ? String(role.canadianLocation || normalizedCanadianLocation?.raw || "").trim()
    : "";
  return (canadianLocation || unique[0] || "—")
    .replace(/\s*\((?:on[- ]?site|hybrid|remote)\)\s*$/i, "").trim() || "—";
}

function formatLocation(role) {
  return roleDisplayLocation(role, state.activeTab);
}

export function formatPosted(value, now = Date.now()) {
  if (!value) return "—";
  // A source's zero-day label has no minute/hour precision.
  if (/^(?:(?:posted|date posted)\s*:?\s*)?(?:today|0\s*d(?:ays?)?(?:\s+ago)?)$/i.test(String(value).trim())) return "Today";
  const parsed = parseSortDate(value, now);
  if (parsed !== null) {
    // Date-only postings carry calendar precision; midnight is not a posting time.
    const dateOnly = /^(?:(?:posted|date posted)\s*:?\s*)?\d{4}-\d{2}-\d{2}$/i.test(String(value).trim());
    if (dateOnly) {
      const postedDay = new Date(parsed);
      const currentDay = new Date(now);
      const days = Math.max(0, Math.round((
        Date.UTC(currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate())
        - Date.UTC(postedDay.getFullYear(), postedDay.getMonth(), postedDay.getDate())
      ) / 86_400_000));
      if (days === 0) return "Today";
      if (days < 28) return `${days}d ago`;
      return formatDate(new Date(parsed).toISOString());
    }
    const delta = Math.max(0, now - parsed);
    if (delta < 60_000) return "<1 min ago";
    if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} min ago`;
    if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
    if (delta < 28 * 86_400_000) return `${Math.floor(delta / 86_400_000)}d ago`;
    return formatDate(new Date(parsed).toISOString());
  }
  return String(value);
}

function formatCategory(value) {
  const labels = { swe: "SWE", ml: "ML", ai: "AI", qa: "QA" };
  if (labels[value]) return labels[value];
  return String(value || "").replace(/[-_]/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
}

function normalizeScheduleTerm(value) {
  return String(value || "")
    .trim()
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function roleScheduleLabel(role) {
  const term = normalizeScheduleTerm(role.internshipTerm);
  const year = String(role.internshipYear || "").trim();
  if (term && year) return `${term} ${year}`;
  if (term || year) return term || year;

  const title = String(role.title || "");
  const seasonOrMonth = /\b(?:winter|spring|summer|fall|autumn|january|february|march|april|may|june|july|august|september|october|november|december)\b(?:\s+(?:of\s+)?)?(?:20\d{2})?/i.exec(title)?.[0];
  if (seasonOrMonth) return normalizeScheduleTerm(seasonOrMonth);
  return /\b20\d{2}\b/.exec(title)?.[0] || "";
}

function jobTagValues(role) {
  const values = [...roleArray(role.categories).map(formatCategory), ...roleArray(role.technologies)];
  const seen = new Set();
  return values.filter((value) => {
    const normalized = String(value || "").trim().toLocaleLowerCase();
    if (!normalized || seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  }).slice(0, 5);
}

function roleKey(role) {
  return listingKey(role.listingType || "internship", role.listingId || role.id);
}

export function insertRoleForUndo(items, role, index = 0) {
  if (!role || !(role.listingId || role.id)) return Array.isArray(items) ? [...items] : [];
  const key = listingKeyForRole(role);
  const existing = (Array.isArray(items) ? items : [])
    .filter((candidate) => listingKeyForRole(candidate) !== key);
  const insertionIndex = Number.isInteger(index) && index >= 0
    ? Math.min(index, existing.length)
    : 0;
  const next = [...existing];
  next.splice(insertionIndex, 0, role);
  return next;
}

function displayRoles(items = state.items) {
  const mode = $("#work-mode-filter")?.value || "all";
  const seasons = selectedSeasonFilters();
  const location = $("#location-filter")?.value || "all";
  return items.filter((role) => {
    if (!hasRequiredListingKeywords(role)) return false;
    if (mode !== "all" && String(role.remoteStatus || "").toLowerCase() !== mode) return false;
    if (!seasonFiltersMatchRole(role, seasons)) return false;
    if (location !== "all") {
      const haystack = roleArray(role.location).join(" ").toLowerCase();
      if (!haystack.includes(location.toLowerCase())) return false;
    }
    return true;
  });
}

function featuredRole() {
  const items = displayRoles();
  if (!items.length) return null;
  // The featured role is the head of the same ordered queue rendered below.
  // Keeping one source of order makes completing the head promote the next
  // listing instead of selecting a different role independently.
  return roleQueueHead(items);
}

function metaIcon(kind) {
  if (kind === "pin") return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 21s7-5.4 7-11.2A7 7 0 0 0 5 9.8C5 15.6 12 21 12 21Z" stroke="currentColor" stroke-width="1.7"/><circle cx="12" cy="9.8" r="2.1" stroke="currentColor" stroke-width="1.7"/></svg>`;
  if (kind === "briefcase") return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="4" y="8" width="16" height="11" rx="2" stroke="currentColor" stroke-width="1.7"/><path d="M9 8V7.4A3 3 0 0 1 15 7.4V8" stroke="currentColor" stroke-width="1.7"/></svg>`;
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.7"/><path d="M12 8v4l2.5 1.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`;
}

function verifiedMarkHtml() {
  return `<span class="company-verified" title="Verified listing" aria-label="Verified listing"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="currentColor"/><path d="m8.2 12.1 2.3 2.2 5.3-5.1" stroke="var(--job-card-bg)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>`;
}

function moreActionsIconHtml() {
  return `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="18.5" r="1.5"/></svg>`;
}

function watchlistIconHtml(saved) {
  return `<svg viewBox="0 0 24 24" fill="${saved ? "currentColor" : "none"}" aria-hidden="true"><path d="M7 4.8h10a1 1 0 0 1 1 1V20l-6-3.2L6 20V5.8a1 1 0 0 1 1-1Z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`;
}

function watchlistButton(role, { compact = false } = {}) {
  const saved = isWatchlisted(role);
  const label = `${role.title || "Role"} at ${role.company || "Company"}`;
  const listingType = role.listingType || "internship";
  const listingId = role.listingId || role.id;
  return `<button class="watchlist-toggle${saved ? " is-saved" : ""}" type="button" data-watchlist-toggle data-listing-type="${escapeHtml(listingType)}" data-listing-id="${escapeHtml(listingId)}" aria-pressed="${String(saved)}" aria-label="${escapeHtml(saved ? `Remove ${label} from watchlist` : `Save ${label} to watchlist`)}" title="${escapeHtml(saved ? "Remove from watchlist" : "Save to watchlist")}">${watchlistIconHtml(saved)}${compact ? "" : `<span>${saved ? "Saved" : "Watchlist"}</span>`}</button>`;
}

function eligibilityCandidate(role) {
  const nested = [role?.eligibility, role?.eligibilityEvaluation, role?.eligibilityResult]
    .find((value) => value && typeof value === "object" && !Array.isArray(value));
  const criterionResults = Array.isArray(nested?.criterionResults)
    ? nested.criterionResults
    : Array.isArray(role?.eligibilityCriterionResults)
      ? role.eligibilityCriterionResults
      : nested?.criteria && typeof nested.criteria === "object"
        ? Object.values(nested.criteria)
        : role?.eligibilityCriteria && typeof role.eligibilityCriteria === "object"
          ? Object.values(role.eligibilityCriteria)
          : [];
  const status = nested?.status
    ?? role?.eligibilityStatus
    ?? role?.eligibility_status
    ?? role?.matchEligibility;
  const reasonValues = role?.eligibilityReasons
    ?? role?.eligibility_reasons
    ?? nested?.reasons
    ?? nested?.reason
    ?? [];
  const reasons = (Array.isArray(reasonValues) ? reasonValues : [reasonValues])
    .map((value) => typeof value === "object" && value !== null ? value.reason : value)
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
  const criterionReasons = criterionResults
    .filter((criterion) => criterion && typeof criterion === "object" && criterion.state !== "not_applicable")
    .map((criterion) => String(criterion.reason || "").trim())
    .filter(Boolean);
  const unknownSources = [...new Set(criterionResults
    .filter((criterion) => criterion?.state === "unknown")
    .map((criterion) => String(criterion.unknownSource || "").trim())
    .filter(Boolean))];
  return {
    status,
    reasons: [...new Set([...reasons, ...criterionReasons])],
    unknownSources,
    explicit: normalizeEligibilityStatus(status) !== null || criterionResults.length > 0,
  };
}

export function eligibilityPresentation(role) {
  const candidate = eligibilityCandidate(role || {});
  return {
    status: normalizeEligibilityStatus(candidate.status) || "unclear",
    reasons: candidate.reasons.slice(0, 5),
    unknownSources: candidate.unknownSources,
    explicit: candidate.explicit,
  };
}

const SPONSORSHIP_OFFER_LABELS = Object.freeze({
  offered: "Visa sponsorship offered",
  not_offered: "No visa sponsorship",
  not_stated: "Visa sponsorship not stated",
});

function normalizeSponsorshipOfferStatus(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "offered" || normalized === "available") return "offered";
  if (normalized === "not_offered" || normalized === "unavailable") return "not_offered";
  if (normalized === "not_stated" || normalized === "unknown" || normalized === "required") return "not_stated";
  return null;
}

export function sponsorshipOfferPresentation(role) {
  const candidate = role && typeof role === "object" ? role : {};
  const qualificationDetails = candidate.qualificationDetails && typeof candidate.qualificationDetails === "object"
    ? candidate.qualificationDetails
    : {};
  const conflicts = Array.isArray(qualificationDetails.conflicts) ? qualificationDetails.conflicts : [];
  const hasSponsorshipConflict = conflicts.some((conflict) => conflict && typeof conflict === "object" && conflict.key === "sponsorship");
  const status = hasSponsorshipConflict
    ? "not_stated"
    : normalizeSponsorshipOfferStatus(candidate.sponsorshipOfferStatus)
      || normalizeSponsorshipOfferStatus(qualificationDetails.sponsorship)
      || "not_stated";
  return { status, label: SPONSORSHIP_OFFER_LABELS[status] };
}

export function sponsorshipOfferHtml(role) {
  const { status, label } = sponsorshipOfferPresentation(role);
  return `<span class="sponsorship-offer sponsorship-offer--${status}" data-sponsorship-offer="${status}">${escapeHtml(label)}</span>`;
}

const HIDDEN_MATCH_REASON = "The posting states only part of an internship term.";

function roleSignalReasons(role) {
  if (isMatchesRoleView()) {
    const eligibility = eligibilityPresentation(role);
    const legacyReasons = Array.isArray(role.matchReasons)
      ? role.matchReasons.map((reason) => String(reason || "").trim()).filter(Boolean)
      : [];
    const reasons = eligibility.reasons.length
      ? eligibility.reasons
      : legacyReasons.length
        ? legacyReasons
        : [eligibility.explicit
          ? `${ELIGIBILITY_STATUS_LABELS[eligibility.status]} based on the preferences saved for your account.`
          : "Ranked by your saved preferences; eligibility status is not available."];
    const visibleReasons = reasons.filter((reason) => reason !== HIDDEN_MATCH_REASON);
    return (visibleReasons.length ? visibleReasons : [
      eligibility.explicit
        ? `${ELIGIBILITY_STATUS_LABELS[eligibility.status]} based on the preferences saved for your account.`
        : "Ranked by your saved preferences; eligibility status is not available.",
    ]).slice(0, 5);
  }
  const raw = String(role.relevanceReason || "").trim();
  if (!raw) return ["Ordered by the catalog signal for the current view."];
  const reasons = raw.split(/;\s+/).map((reason) => reason.trim()).filter(Boolean);
  return (reasons.length > 1 ? reasons : [raw]).slice(0, 5);
}

function roleSignalScore(role) {
  if (isMatchesRoleView()) {
    const rawScore = role.matchScore;
    const score = Number(rawScore);
    return rawScore !== null && rawScore !== undefined && rawScore !== "" && Number.isFinite(score)
      ? { value: `${Math.round(score)}/100`, label: "match score" }
      : { value: ELIGIBILITY_STATUS_LABELS[eligibilityPresentation(role).status], label: "eligibility status" };
  }
  const rawScore = role.relevanceScore;
  const score = Number(rawScore);
  return rawScore !== null && rawScore !== undefined && rawScore !== "" && Number.isFinite(score)
    ? { value: String(Math.round(score)), label: "catalog relevance" }
    : { value: "—", label: "catalog signal" };
}

const ELIGIBILITY_STATUS_LABELS = Object.freeze({
  eligible: "Eligible",
  likely_eligible: "Likely eligible",
  unclear: "Unclear",
  not_eligible: "Not eligible",
});

function normalizeEligibilityStatus(value) {
  const normalized = String(value || "").trim().toLocaleLowerCase().replace(/[\s-]+/g, "_");
  if (normalized === "likely" || normalized === "likelyeligible") return "likely_eligible";
  if (normalized === "noteligible" || normalized === "ineligible") return "not_eligible";
  return Object.prototype.hasOwnProperty.call(ELIGIBILITY_STATUS_LABELS, normalized) ? normalized : null;
}

function roleEligibilityStatus(role) {
  return eligibilityPresentation(role).status;
}

function eligibilityBadgeHtml(role) {
  if (!isMatchesRoleView()) return "";
  const status = roleEligibilityStatus(role);
  const label = ELIGIBILITY_STATUS_LABELS[status];
  return `<span class="eligibility-badge eligibility-badge-${status}" data-eligibility-status="${status}"><span class="eligibility-badge-dot" aria-hidden="true"></span><span class="sr-only">Eligibility: </span><span>${label}</span></span>`;
}

function applicationDraftButtons(role) {
  const listingType = role.listingType || "internship";
  const listingId = role.listingId || role.id;
  const roleLabel = escapeHtml(`${role.title} at ${role.company}`);
  const identity = `data-listing-type="${escapeHtml(listingType)}" data-listing-id="${escapeHtml(listingId)}" data-listing-title="${escapeHtml(role.title)}" data-listing-company="${escapeHtml(role.company)}"`;
  return `<button type="button" class="listing-action-button resume-action application-draft-action" data-application-draft="resume" ${identity} aria-label="Download resume for ${roleLabel}" title="See what changed for this role, then download your tailored resume">Download resume</button>
    <button type="button" class="listing-action-button application-draft-action cover-letter-action" data-application-draft="cover-letter" ${identity} aria-label="Draft cover letter for ${roleLabel}" title="Review and edit a role-specific cover letter">Cover letter</button>`;
}

function applicationDraftCacheKey(listingType, listingId, kind) {
  return `${listingType}:${listingId}:${kind}`;
}

function applicationDraftEndpoint(session) {
  return `/api/application-drafts/${encodeURIComponent(session.listingType)}/${encodeURIComponent(session.listingId)}`;
}

function applicationDraftLabel(kind) {
  return kind === "cover-letter" ? "Cover letter" : "Resume";
}

function draftLines(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function resumeEntryEditor(group, title, entries, prefix, { editable = false, max = 0 } = {}) {
  return `<section class="application-draft-section" aria-labelledby="${prefix}-${group}-heading">
    <div class="application-draft-section-heading"><h3 id="${prefix}-${group}-heading">${title}</h3><span>${entries.length} ${entries.length === 1 ? "entry" : "entries"}</span></div>
    ${entries.map((entry, index) => `<fieldset class="application-draft-entry" data-resume-entry data-entry-group="${group}" data-entry-index="${index}">
      <legend>${title} ${index + 1}</legend>
      <div class="application-draft-entry-fields">
        <label class="application-draft-field"><span>Title</span><input type="text" data-entry-field="title" value="${escapeHtml(entry.title)}" autocomplete="off" /></label>
        <label class="application-draft-field"><span>Organization or subtitle</span><input type="text" data-entry-field="subtitle" value="${escapeHtml(entry.subtitle)}" autocomplete="off" /></label>
        <label class="application-draft-field"><span>Date</span><input type="text" data-entry-field="date" value="${escapeHtml(entry.date)}" autocomplete="off" /></label>
      </div>
      <label class="application-draft-field application-draft-bullets"><span>Bullets <small>One per line</small></span><textarea data-entry-field="bullets" rows="${Math.max(2, Math.min(5, entry.bullets.length))}">${escapeHtml(entry.bullets.join("\n"))}</textarea></label>
      ${editable ? `<button class="application-draft-remove" type="button" data-remove-resume-entry="${group}" data-entry-index="${index}">Remove ${title.toLocaleLowerCase()}</button>` : ""}
    </fieldset>`).join("")}
    ${editable ? `<button class="application-draft-add" type="button" data-add-resume-entry="${group}" ${entries.length >= max ? "disabled" : ""}>Add ${title.toLocaleLowerCase()}</button>` : ""}
  </section>`;
}

function resumeStructureEditor(resume, prefix, { editableCollections = false } = {}) {
  const skills = Array.isArray(resume.skills) ? resume.skills : [];
  return `<div class="application-draft-editor" data-resume-editor="${prefix}">
    <section class="application-draft-section" aria-labelledby="${prefix}-profile-heading">
      <div class="application-draft-section-heading"><h3 id="${prefix}-profile-heading">Contact</h3></div>
      <div class="application-draft-entry-fields">
        <label class="application-draft-field"><span>Name</span><input type="text" data-resume-name value="${escapeHtml(resume.name)}" autocomplete="name" /></label>
      </div>
      <label class="application-draft-field application-draft-contact"><span>Contact details <small>One per line</small></span><textarea data-resume-contact rows="${Math.max(2, Math.min(5, resume.contact.length))}">${escapeHtml(resume.contact.join("\n"))}</textarea></label>
    </section>
    ${resumeEntryEditor("education", "Education", resume.education, prefix, { editable: editableCollections, max: 4 })}
    ${resumeEntryEditor("experience", "Experience", resume.experience, prefix, { editable: editableCollections, max: 8 })}
    ${resumeEntryEditor("projects", "Projects", resume.projects, prefix, { editable: editableCollections, max: 8 })}
    <section class="application-draft-section" aria-labelledby="${prefix}-awards-heading">
      <div class="application-draft-section-heading"><h3 id="${prefix}-awards-heading">Awards &amp; leadership</h3></div>
      <label class="application-draft-field"><span>Awards <small>One per line</small></span><textarea data-resume-awards rows="${Math.max(2, Math.min(5, resume.awards.length))}">${escapeHtml(resume.awards.join("\n"))}</textarea></label>
    </section>
    <section class="application-draft-section" aria-labelledby="${prefix}-skills-heading">
      <div class="application-draft-section-heading"><h3 id="${prefix}-skills-heading">Skills</h3></div>
      ${skills.map((group, index) => `<fieldset class="application-draft-skill" data-resume-skill data-skill-index="${index}">
        <legend>Skill group ${index + 1}</legend>
        <div class="application-draft-entry-fields">
          <label class="application-draft-field"><span>Group name</span><input type="text" data-skill-label value="${escapeHtml(group.label)}" autocomplete="off" /></label>
          <label class="application-draft-field"><span>Skills <small>One per line</small></span><textarea data-skill-items rows="${Math.max(2, Math.min(5, group.items.length))}">${escapeHtml(group.items.join("\n"))}</textarea></label>
        </div>
        ${editableCollections ? '<button class="application-draft-remove" type="button" data-remove-resume-skill>Remove skill group</button>' : ""}
      </fieldset>`).join("")}
      ${editableCollections ? `<button class="application-draft-add" type="button" data-add-resume-skill ${skills.length >= 8 ? "disabled" : ""}>Add skill group</button>` : ""}
    </section>
  </div>`;
}

function retryAiWordingMarkup(session, result) {
  if (result.source !== "deterministic") return "";
  if (session.regenerationConfirm) {
    return `<div class="application-draft-regenerate-confirm" role="group" aria-label="Confirm draft replacement">
      <p>Trying AI wording again sends your resume details to OpenAI when available and replaces the current edited draft.</p>
      <button class="dialog-secondary" type="button" data-cancel-ai-wording>Keep my edits</button>
      <button class="dialog-primary" type="button" data-confirm-ai-wording>Regenerate and replace</button>
    </div>`;
  }
  return `<div class="application-draft-regenerate">
    <p>This draft uses rule-based matching. Try AI wording again when you want another generation attempt.</p>
    <button class="dialog-secondary" type="button" data-retry-ai-wording>Try AI wording again</button>
  </div>`;
}

function renderResumeChanges(changes) {
  if (!changes || !Array.isArray(changes.bullets) || !Array.isArray(changes.ordering)) {
    return '<p class="resume-changes-empty">Change details are unavailable for this draft.</p>';
  }
  const groups = new Map();
  for (const change of changes.bullets) {
    const key = change.sourceRef.split(".bullets.")[0];
    if (!groups.has(key)) groups.set(key, { ...change, bullets: [] });
    groups.get(key).bullets.push(change);
  }
  const comparisons = (before, after, { ordered = false, roleKeyword = "", roleRequirement = "" } = {}) => {
    const text = (value) => ordered
      ? `<ol>${value.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ol>`
      : `<p>${escapeHtml(value)}</p>`;
    return `<div class="resume-change-comparison">
      <div class="resume-change-original"><h5>${ordered ? "Original order" : "Original"}</h5>${text(before)}</div>
      <div class="resume-change-tailored"><h5>${ordered ? "Tailored order" : "Tailored"}</h5>${text(after)}${roleKeyword && roleRequirement ? `<small class="resume-change-context"><strong>Role focus: ${escapeHtml(roleKeyword)}</strong> · ${escapeHtml(roleRequirement)}</small>` : ""}</div>
    </div>`;
  };
  return `<section class="resume-changes" aria-labelledby="resume-changes-heading">
    <div class="application-draft-section-heading"><h3 id="resume-changes-heading">Rewritten bullets</h3><span>${changes.bullets.length} ${changes.bullets.length === 1 ? "change" : "changes"}</span></div>
    ${groups.size ? [...groups.values()].map((group) => `<article class="resume-change-entry">
      <h4>${escapeHtml(group.title)}</h4>
      <p class="resume-change-context">${group.section === "experience" ? "Experience" : "Project"} · ${escapeHtml(group.subtitle)}</p>
      ${group.bullets.map((change) => comparisons(change.before, change.after, change)).join("")}
    </article>`).join("") : '<p class="resume-changes-empty">No bullet wording was changed in this draft.</p>'}
  </section>
  ${changes.ordering.length ? `<details class="resume-change-ordering">
    <summary>Relevance ordering <span>${changes.ordering.length} ${changes.ordering.length === 1 ? "change" : "changes"}</span></summary>
    <p class="resume-change-context">These items were moved higher to emphasize their relevance to the role.</p>
    ${changes.ordering.map((change) => `<article class="resume-change-entry"><h4>${escapeHtml(change.label)}</h4>${comparisons(change.before, change.after, { ordered: true })}</article>`).join("")}
  </details>` : ""}`;
}

function renderResumeDraftReview(result, session) {
  const warningMarkup = (Array.isArray(result.warnings) ? result.warnings : [])
    .filter((warning) => typeof warning === "string" && warning.trim())
    .map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const matchedSkills = (Array.isArray(result.matchedSkills) ? result.matchedSkills : [])
    .filter((skill) => typeof skill === "string" && skill.trim());
  const sourceLabel = result.source === "llm" ? "AI-assisted wording" : "Fallback draft · rule-based matching";
  return `<div class="application-draft-source" aria-label="Draft method">${escapeHtml(sourceLabel)}</div>
    ${matchedSkills.length ? `<p class="application-draft-matches"><strong>Relevant skills found in your resume</strong><span>${escapeHtml(matchedSkills.join(" · "))}</span></p>` : ""}
    ${renderResumeChanges(result.changes)}
    ${warningMarkup ? `<details class="resume-draft-notes"><summary>Review notes</summary><ul class="application-draft-warnings" aria-label="Draft notes">${warningMarkup}</ul></details>` : ""}
    ${retryAiWordingMarkup(session, result)}
    <p id="application-draft-export-error" class="application-draft-error" role="alert" hidden></p>
    <p id="application-draft-feedback" class="application-draft-feedback" role="status" aria-live="polite"></p>
    <footer class="application-draft-actions">
      <button class="dialog-secondary" type="button" data-close-application-draft>Close</button>
      <button class="dialog-primary application-draft-export" type="button" data-download-resume>Download tailored resume PDF</button>
    </footer>`;
}

function renderCoverLetterDraftEditor(result, session) {
  const warningMarkup = (Array.isArray(result.warnings) ? result.warnings : [])
    .filter((warning) => typeof warning === "string" && warning.trim())
    .map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const matchedSkills = (Array.isArray(result.matchedSkills) ? result.matchedSkills : [])
    .filter((skill) => typeof skill === "string" && skill.trim());
  const sourceLabel = result.source === "llm" ? "AI-assisted wording" : "Fallback draft · rule-based matching";
  return `<div class="application-draft-source" aria-label="Draft method">${escapeHtml(sourceLabel)}</div>
    <p class="application-draft-review-note">Your experience details are sent to OpenAI to prepare this draft. Review every name, date, and claim before using it.</p>
    ${warningMarkup ? `<ul class="application-draft-warnings" aria-label="Draft notes">${warningMarkup}</ul>` : ""}
    ${matchedSkills.length ? `<p class="application-draft-matches"><strong>Relevant skills found in your resume</strong><span>${escapeHtml(matchedSkills.join(" · "))}</span></p>` : ""}
    ${retryAiWordingMarkup(session, result)}
    <label class="application-draft-field application-draft-letter"><span>Cover letter text</span><textarea data-cover-letter-text rows="19" spellcheck="true">${escapeHtml(result.text || "")}</textarea></label>
    <p id="application-draft-export-error" class="application-draft-error" role="alert" hidden></p>
    <p id="application-draft-feedback" class="application-draft-feedback" role="status" aria-live="polite"></p>
    <footer class="application-draft-actions">
      <button class="dialog-secondary" type="button" data-close-application-draft>Close</button>
      <div class="application-draft-export-actions">
        <button class="dialog-secondary" type="button" data-copy-cover-letter>Copy text</button>
        <button class="dialog-primary" type="button" data-download-cover-letter>Download .txt</button>
      </div>
    </footer>`;
}

function renderApplicationDraft(session) {
  if (state.activeApplicationDraft !== session) return;
  const dialog = $("#application-draft-dialog");
  const content = $("#application-draft-content");
  if (!dialog || !content) return;
  dialog.querySelector(".resume-draft-footer")?.remove();
  const label = applicationDraftLabel(session.kind);
  $("#application-draft-title").textContent = session.kind === "resume" ? "Resume changes" : `${label} draft`;
  $("#application-draft-close").setAttribute("aria-label", session.kind === "resume" ? "Close resume changes" : "Close cover letter editor");
  $("#application-draft-role").textContent = `${session.title} · ${session.company}`;
  if (session.loading) {
    $("#application-draft-description").textContent = "Preparing a draft from your resume details and this role.";
    content.innerHTML = `<p class="application-draft-review-note">Your resume details may be sent to OpenAI to prepare this draft. You can close this window to cancel.</p><div class="application-draft-loading" role="status" aria-live="polite"><span>Preparing your ${escapeHtml(label.toLocaleLowerCase())} draft…</span><i></i><i></i><i></i></div>`;
    return;
  }
  if (session.error) {
    $("#application-draft-description").textContent = "The draft could not be prepared. You can retry when ready.";
    const needsResumeProfile = session.kind === "resume" && /resume.{0,50}(profile|upload|missing|not found|not saved)|upload.{0,50}resume|resume is not saved/i.test(session.error);
    const profileHint = needsResumeProfile
      ? '<p class="application-draft-review-note">Set up your resume once using the global resume control beside Add source, then retry this role draft.</p>'
      : "";
    const previousDraft = session.previousEntry
      ? '<button class="dialog-secondary" type="button" data-return-previous-draft>Keep current draft</button>'
      : "";
    content.innerHTML = `<div class="application-draft-error-state"><p class="application-draft-error" role="alert">${escapeHtml(session.error)}</p>${profileHint}<footer class="application-draft-actions"><button class="dialog-secondary" type="button" data-close-application-draft>Close</button>${previousDraft}<button class="dialog-primary" type="button" data-retry-application-draft>Try again</button></footer></div>`;
    return;
  }
  if (!session.entry) return;
  $("#application-draft-description").textContent = session.kind === "resume"
    ? "See how your saved resume was tailored for this role. Review the changes before applying."
    : "Review and edit every detail before using this draft.";
  content.innerHTML = session.kind === "resume"
    ? renderResumeDraftReview(session.entry.result, session)
    : renderCoverLetterDraftEditor(session.entry.result, session);
  if (session.kind === "resume") {
    const footer = document.createElement("div");
    footer.className = "resume-draft-footer";
    for (const selector of ["#application-draft-export-error", "#application-draft-feedback", ".application-draft-actions"]) {
      const element = content.querySelector(selector);
      if (element) footer.append(element);
    }
    content.parentElement.append(footer);
  }
}

function draftIsCurrent(session) {
  return state.activeApplicationDraft === session
    && session.id === state.applicationDraftRequestId
    && $("#application-draft-dialog")?.open === true;
}

async function requestApplicationDraft(session) {
  const replacedEntry = session.regenerating
    ? session.entry || state.applicationDraftCache.get(session.cacheKey) || null
    : null;
  session.previousEntry = replacedEntry;
  session.controller?.abort();
  session.controller = new AbortController();
  session.requestId = ++state.applicationDraftRequestId;
  session.id = session.requestId;
  session.loading = true;
  session.error = "";
  session.entry = null;
  renderApplicationDraft(session);
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    if (!draftIsCurrent(session)) return;
    const response = await fetch(applicationDraftEndpoint(session), {
      method: "POST",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ kind: session.kind }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not prepare this draft. Please try again.");
    if (!draftIsCurrent(session)) return;
    if (payload.kind !== session.kind || !payload.role || typeof payload.source !== "string") {
      throw new Error("The draft response was incomplete. Please try again.");
    }
    if (session.kind === "resume" && (!payload.resume || !Array.isArray(payload.resume.education))) {
      throw new Error("The resume draft could not be read. Please try again.");
    }
    if (session.kind === "cover-letter" && typeof payload.text !== "string") {
      throw new Error("The cover letter draft could not be read. Please try again.");
    }
    const entry = {
      key: session.cacheKey,
      kind: session.kind,
      result: payload,
      resume: session.kind === "resume" ? structuredClone(payload.resume) : null,
      text: session.kind === "cover-letter" ? payload.text : "",
      userEdited: false,
    };
    state.applicationDraftCache.set(session.cacheKey, entry);
    session.entry = entry;
    session.previousEntry = null;
    session.regenerating = false;
    session.regenerationConfirm = false;
    session.title = payload.role.title || session.title;
    session.company = payload.role.company || session.company;
    session.loading = false;
    renderApplicationDraft(session);
    const draftContent = $("#application-draft-content");
    if (draftContent) draftContent.scrollTop = 0;
  } catch (error) {
    if (!draftIsCurrent(session) || error?.name === "AbortError") return;
    session.loading = false;
    session.error = error instanceof Error ? error.message : "Could not prepare this draft. Please try again.";
    renderApplicationDraft(session);
  }
}

function openApplicationDraft(button) {
  const kind = button.dataset.applicationDraft;
  if (kind !== "resume" && kind !== "cover-letter") return;
  const dialog = $("#application-draft-dialog");
  const listingType = button.dataset.listingType || "internship";
  const listingId = button.dataset.listingId || "";
  if (!dialog || !listingId) return;
  if (dialog.open) closeApplicationDraftDialog({ restoreFocus: false });
  const cacheKey = applicationDraftCacheKey(listingType, listingId, kind);
  const session = {
    id: ++state.applicationDraftRequestId,
    requestId: state.applicationDraftRequestId,
    kind,
    listingType,
    listingId,
    title: button.dataset.listingTitle || "Role",
    company: button.dataset.listingCompany || "Company",
    cacheKey,
    trigger: button,
    controller: new AbortController(),
    entry: state.applicationDraftCache.get(cacheKey) || null,
    regenerating: false,
    regenerationConfirm: false,
    previousEntry: null,
    loading: false,
    error: "",
  };
  state.activeApplicationDraft = session;
  if (!dialog.open) dialog.showModal();
  if (session.entry) {
    renderApplicationDraft(session);
    const content = $("#application-draft-content");
    if (content) content.scrollTop = 0;
    setTimeout(() => $("#application-draft-close")?.focus(), 0);
  } else {
    session.loading = true;
    renderApplicationDraft(session);
    setTimeout(() => $("#application-draft-close")?.focus(), 0);
    void requestApplicationDraft(session);
  }
}

function closeApplicationDraftDialog({ restoreFocus = true } = {}) {
  const dialog = $("#application-draft-dialog");
  const session = state.activeApplicationDraft;
  if (!dialog?.open && !session) return;
  session?.controller?.abort();
  state.applicationDraftRequestId += 1;
  state.activeApplicationDraft = null;
  if (dialog?.open) dialog.close();
  if (restoreFocus && session?.trigger?.isConnected) session.trigger.focus();
}

function collectEditedResume(content, original) {
  const entries = (group) => [...content.querySelectorAll(`[data-resume-entry][data-entry-group="${group}"]`)].map((entry) => ({
    title: entry.querySelector('[data-entry-field="title"]')?.value.trim() || "",
    subtitle: entry.querySelector('[data-entry-field="subtitle"]')?.value.trim() || "",
    date: entry.querySelector('[data-entry-field="date"]')?.value.trim() || "",
    bullets: draftLines(entry.querySelector('[data-entry-field="bullets"]')?.value || ""),
  }));
  return {
    ...original,
    ownerEmail: original.ownerEmail,
    name: content.querySelector("[data-resume-name]")?.value.trim() || "",
    contact: draftLines(content.querySelector("[data-resume-contact]")?.value || ""),
    education: entries("education"),
    experience: entries("experience"),
    projects: entries("projects"),
    awards: draftLines(content.querySelector("[data-resume-awards]")?.value || ""),
    skills: [...content.querySelectorAll("[data-resume-skill]")].map((group) => ({
      label: group.querySelector("[data-skill-label]")?.value.trim() || "",
      items: draftLines(group.querySelector("[data-skill-items]")?.value || ""),
    })),
  };
}

function validateEditableResume(resume) {
  if (!resume.name.trim()) return "Add a name before saving or downloading this resume.";
  if (resume.contact.length < 1 || resume.contact.length > 8) return "Add between one and eight contact details.";
  if (resume.education.length < 1 || resume.education.length > 4) return "Keep between one and four education entries.";
  if (resume.experience.length > 8 || resume.projects.length > 8) return "Keep each experience and project section to eight entries or fewer.";
  if (resume.awards.length > 6) return "Keep awards and leadership entries to six or fewer.";
  if (resume.skills.length > 8) return "Keep skill groups to eight or fewer.";
  for (const [section, entries] of [["Education", resume.education], ["Experience", resume.experience], ["Projects", resume.projects]]) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry.title.trim() || !entry.subtitle.trim() || !entry.date.trim()) {
        return `Complete the title, organization, and date for ${section.toLocaleLowerCase()} entry ${index + 1}.`;
      }
      if (entry.bullets.length > 8) return `${section} entry ${index + 1} can have at most eight bullets.`;
    }
  }
  for (let index = 0; index < resume.skills.length; index += 1) {
    if (!resume.skills[index].label.trim()) return `Add a name for skill group ${index + 1}.`;
    if (resume.skills[index].items.length > 40) return `Skill group ${index + 1} can have at most 40 items.`;
  }
  return "";
}

function saveApplicationDraftEdits(session, markEdited = false) {
  if (!draftIsCurrent(session) || !session.entry || session.kind !== "cover-letter") return;
  session.entry.text = $("[data-cover-letter-text]")?.value ?? session.entry.text;
  session.entry.result.text = session.entry.text;
  if (markEdited) session.entry.userEdited = true;
  state.applicationDraftCache.set(session.cacheKey, session.entry);
}

function startAiWordingRetry() {
  const session = state.activeApplicationDraft;
  if (!session?.entry || session.entry.result.source !== "deterministic") return;
  saveApplicationDraftEdits(session);
  if (session.entry.userEdited) {
    session.regenerationConfirm = true;
    renderApplicationDraft(session);
    $(`[data-cancel-ai-wording]`)?.focus();
    return;
  }
  session.regenerating = true;
  void requestApplicationDraft(session);
}

function cancelAiWordingRetry() {
  const session = state.activeApplicationDraft;
  if (!session) return;
  session.regenerationConfirm = false;
  renderApplicationDraft(session);
  $(`[data-retry-ai-wording]`)?.focus();
}

function confirmAiWordingRetry() {
  const session = state.activeApplicationDraft;
  if (!session?.entry || !session.regenerationConfirm) return;
  saveApplicationDraftEdits(session);
  session.regenerationConfirm = false;
  session.regenerating = true;
  void requestApplicationDraft(session);
}

function keepPreviousApplicationDraft() {
  const session = state.activeApplicationDraft;
  if (!session?.previousEntry) return;
  session.entry = session.previousEntry;
  session.previousEntry = null;
  session.regenerating = false;
  session.error = "";
  state.applicationDraftCache.set(session.cacheKey, session.entry);
  renderApplicationDraft(session);
}

function applicationDraftFeedback(message) {
  const feedback = $("#application-draft-feedback");
  if (feedback) feedback.textContent = message;
}

function safeDownloadName(header, fallback) {
  const encoded = header?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const basic = header?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = basic || fallback;
  if (encoded) {
    try { candidate = decodeURIComponent(encoded); } catch { candidate = fallback; }
  }
  return candidate.split(/[\\/]/).pop() || fallback;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadTailoredResume(button) {
  const session = state.activeApplicationDraft;
  if (!session || session.kind !== "resume" || !draftIsCurrent(session) || button.disabled) return;
  const validationError = validateEditableResume(session.entry.resume);
  if (validationError) {
    const message = $("#application-draft-export-error");
    if (message) { message.textContent = validationError; message.hidden = false; }
    return;
  }
  const exportError = $("#application-draft-export-error");
  if (exportError) { exportError.hidden = true; exportError.textContent = ""; }
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Preparing PDF…";
  applicationDraftFeedback("Preparing your tailored PDF…");
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    if (!draftIsCurrent(session)) return;
    const response = await fetch(`/api/resumes/${encodeURIComponent(session.listingType)}/${encodeURIComponent(session.listingId)}`, {
      method: "POST",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/pdf", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ resume: session.entry.resume }),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Could not create the PDF. Please try again.");
    }
    const blob = await response.blob();
    if (!draftIsCurrent(session)) return;
    downloadBlob(blob, safeDownloadName(response.headers.get("content-disposition"), "resume.pdf"));
    applicationDraftFeedback("Tailored resume PDF downloaded. Review the saved file before applying.");
  } catch (error) {
    if (!draftIsCurrent(session) || error?.name === "AbortError") return;
    if (exportError) {
      exportError.textContent = error instanceof Error ? error.message : "Could not create the PDF. Please try again.";
      exportError.hidden = false;
    }
    applicationDraftFeedback("");
  } finally {
    if (draftIsCurrent(session)) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Download tailored resume PDF";
    }
  }
}

async function copyCoverLetter(button) {
  const session = state.activeApplicationDraft;
  if (!session || session.kind !== "cover-letter" || !draftIsCurrent(session) || button.disabled) return;
  saveApplicationDraftEdits(session);
  const text = session.entry.text.trim();
  if (!text) {
    applicationDraftFeedback("Add cover letter text before copying.");
    return;
  }
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text);
    else {
      const temporary = document.createElement("textarea");
      temporary.value = text;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.append(temporary);
      temporary.select();
      const copied = document.execCommand("copy");
      temporary.remove();
      if (!copied) throw new Error("Clipboard access is unavailable. Select and copy the text instead.");
    }
    if (draftIsCurrent(session)) applicationDraftFeedback("Cover letter copied.");
  } catch (error) {
    if (draftIsCurrent(session)) applicationDraftFeedback(error instanceof Error ? error.message : "Could not copy the cover letter.");
  }
}

function downloadCoverLetter() {
  const session = state.activeApplicationDraft;
  if (!session || session.kind !== "cover-letter" || !draftIsCurrent(session)) return;
  saveApplicationDraftEdits(session);
  const text = session.entry.text.trim();
  const exportError = $("#application-draft-export-error");
  if (!text) {
    if (exportError) {
      exportError.textContent = "Add cover letter text before downloading.";
      exportError.hidden = false;
    }
    return;
  }
  if (exportError) exportError.hidden = true;
  const filenameCompany = session.company.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "role";
  downloadBlob(new Blob([text], { type: "text/plain;charset=utf-8" }), `cover-letter-${filenameCompany}.txt`);
  applicationDraftFeedback("Edited cover letter downloaded as a text file.");
}

function trapApplicationDraftFocus(event) {
  if (event.key !== "Tab") return;
  const dialog = event.currentTarget instanceof HTMLDialogElement
    ? event.currentTarget
    : $("#application-draft-dialog");
  if (!dialog?.open) return;
  const focusable = [...dialog.querySelectorAll("a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])")]
    .filter((element) => !element.hidden && element.getClientRects().length > 0);
  if (!focusable.length) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
    event.preventDefault();
    first.focus();
  }
}

const RESUME_UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

function setResumeProfileToolbarLabel(hasSavedProfile) {
  const button = $("#resume-profile-button");
  const label = $("#resume-profile-button-label");
  if (!button || !label) return;
  if (hasSavedProfile) {
    label.textContent = "Manage resume";
    button.setAttribute("aria-label", "Manage your resume");
    button.title = "Manage or replace your saved resume";
  } else {
    label.textContent = "Upload resume";
    button.setAttribute("aria-label", "Upload or manage your resume");
    button.title = "Upload or manage your resume";
  }
}

function resumeProfileIsCurrent(session) {
  return state.activeResumeProfileSession === session
    && session.id === state.resumeProfileRequestId
    && $("#resume-profile-dialog")?.open === true;
}

function resumeProfileDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString() : "";
}

function renderResumeProfile(session) {
  if (!resumeProfileIsCurrent(session)) return;
  const content = $("#resume-profile-content");
  if (!content) return;
  const record = session.candidate || session.profile;
  $("#resume-profile-title").textContent = "Your resume";
  $("#resume-profile-filename").textContent = record?.filename || "No resume saved yet";
  if (session.loading) {
    $("#resume-profile-description").textContent = session.stage === "importing"
      ? "Extracting editable resume details…"
      : "Loading your saved resume…";
    content.innerHTML = `<div class="application-draft-loading" role="status" aria-live="polite"><span>${session.stage === "importing" ? "Reading your resume…" : "Loading your resume…"}</span><i></i><i></i><i></i></div>`;
    return;
  }
  if (session.loadError) {
    $("#resume-profile-description").textContent = "Your saved resume could not be loaded.";
    content.innerHTML = `<div class="application-draft-error-state"><p class="application-draft-error" role="alert">${escapeHtml(session.loadError)}</p><footer class="application-draft-actions"><button class="dialog-secondary" type="button" data-close-resume-profile>Close</button><button class="dialog-primary" type="button" data-retry-resume-profile>Try again</button></footer></div>`;
    return;
  }
  if (!record) {
    $("#resume-profile-description").textContent = "Upload a PDF or text resume to use in role-specific drafts.";
    content.innerHTML = `<div class="resume-profile-empty">
      <p>Choose a resume file to extract editable details. Files may be up to 5 MiB.</p>
      <p class="application-draft-review-note">Scout sends the original file to OpenAI to extract your resume details. Review every field before saving; extracted details stay a draft until you save them.</p>
      ${session.message ? `<p class="${session.messageError ? "application-draft-error" : "application-draft-feedback"}" ${session.messageError ? 'role="alert"' : 'role="status"'}>${escapeHtml(session.message)}</p>` : ""}
      <footer class="application-draft-actions"><button class="dialog-secondary" type="button" data-close-resume-profile>Close</button><button class="dialog-primary" type="button" data-choose-resume-file>Upload resume</button></footer>
    </div>`;
    return;
  }
  const candidate = Boolean(session.candidate);
  const warnings = Array.isArray(record.warnings) ? record.warnings : [];
  $("#resume-profile-description").textContent = candidate
    ? "Review the extracted content and save it to make it your active resume."
    : `Saved resume${resumeProfileDate(session.profile.updatedAt) ? ` · updated ${resumeProfileDate(session.profile.updatedAt)}` : ""}. Edit the details below before saving changes.`;
  const messageMarkup = session.message
    ? `<p class="${session.messageError ? "application-draft-error" : "application-draft-feedback"}" ${session.messageError ? 'role="alert"' : 'role="status"'}>${escapeHtml(session.message)}</p>`
    : "";
  const warningMarkup = warnings.length
    ? `<ul class="application-draft-warnings" aria-label="Extraction notes">${warnings.filter((warning) => typeof warning === "string" && warning.trim()).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")}</ul>`
    : "";
  const extractionNotice = candidate
    ? '<p class="application-draft-review-note">The original file was sent to OpenAI for extraction. Check names, dates, and all extracted content; this draft is not active until you save it.</p>'
    : '<p class="application-draft-review-note">Uploading or replacing a resume sends the original file to OpenAI for extraction. Review the extracted fields before saving; your saved details are used to prepare role-specific drafts.</p>';
  const removeConfirmation = !candidate && session.removeConfirm
    ? `<div class="resume-profile-remove-confirm" role="group" aria-label="Confirm resume removal"><span>Remove the saved resume from your account?</span><button class="dialog-secondary" type="button" data-cancel-remove-resume>Keep resume</button><button class="dialog-primary" type="button" data-confirm-remove-resume>Remove resume</button></div>`
    : "";
  content.innerHTML = `<div class="resume-profile-editor" data-resume-profile-state="${candidate ? "review" : "saved"}">
    <div class="application-draft-source" aria-label="Resume status">${candidate ? "Extraction ready · review before saving" : "Active resume"}</div>
    ${extractionNotice}${warningMarkup}${messageMarkup}
    ${resumeStructureEditor(session.editedResume || record.resume, "profile-resume", { editableCollections: true })}
    <p id="resume-profile-feedback" class="application-draft-feedback" role="status" aria-live="polite"></p>
    ${removeConfirmation}
    <footer class="application-draft-actions">
      <button class="dialog-secondary" type="button" data-close-resume-profile>Close</button>
      <div class="application-draft-export-actions">
        ${candidate ? '<button class="dialog-secondary" type="button" data-discard-resume-candidate>Discard draft</button>' : '<button class="dialog-secondary" type="button" data-show-remove-resume>Remove saved resume</button>'}
        <button class="dialog-secondary" type="button" data-choose-resume-file>${candidate ? "Choose another file" : "Replace resume"}</button>
        <button class="dialog-primary" type="button" data-save-resume-profile>${candidate ? "Save as my resume" : "Save changes"}</button>
      </div>
    </footer>
  </div>`;
}

function openResumeProfile(trigger = null) {
  const dialog = $("#resume-profile-dialog");
  if (!dialog) return;
  let returnFocus = trigger;
  if ($("#application-draft-dialog")?.open) {
    returnFocus = state.activeApplicationDraft?.trigger || returnFocus;
    closeApplicationDraftDialog({ restoreFocus: false });
  }
  if (dialog.open) closeResumeProfileDialog({ restoreFocus: false });
  const session = {
    id: ++state.resumeProfileRequestId,
    trigger: returnFocus,
    controller: new AbortController(),
    profile: null,
    candidate: null,
    stage: "loading",
    loading: true,
    saving: false,
    loadError: "",
    message: "",
    messageError: false,
    removeConfirm: false,
  };
  state.activeResumeProfileSession = session;
  dialog.showModal();
  renderResumeProfile(session);
  setTimeout(() => $("#resume-profile-close")?.focus(), 0);
  void loadResumeProfile(session);
}

async function loadResumeProfile(session) {
  session.controller?.abort();
  session.controller = new AbortController();
  session.id = ++state.resumeProfileRequestId;
  session.stage = "loading";
  session.loading = true;
  session.loadError = "";
  renderResumeProfile(session);
  try {
    const response = await fetch("/api/resume-profile", {
      cache: "no-store",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/json" },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not load your saved resume.");
    if (!resumeProfileIsCurrent(session)) return;
    if (payload.profile && (!payload.profile.resume || typeof payload.profile.filename !== "string")) {
      throw new Error("The saved resume response could not be read. Please try again.");
    }
    session.profile = payload.profile || null;
    setResumeProfileToolbarLabel(Boolean(session.profile));
    session.candidate = null;
    session.editedResume = session.profile?.resume || null;
    session.loading = false;
    session.stage = "ready";
    renderResumeProfile(session);
  } catch (error) {
    if (!resumeProfileIsCurrent(session) || error?.name === "AbortError") return;
    session.loading = false;
    session.loadError = error instanceof Error ? error.message : "Could not load your saved resume.";
    renderResumeProfile(session);
  }
}

function closeResumeProfileDialog({ restoreFocus = true } = {}) {
  const dialog = $("#resume-profile-dialog");
  const session = state.activeResumeProfileSession;
  if (!dialog?.open && !session) return;
  session?.controller?.abort();
  state.resumeProfileRequestId += 1;
  state.activeResumeProfileSession = null;
  if (dialog?.open) dialog.close();
  if (restoreFocus && session?.trigger?.isConnected) session.trigger.focus();
}

function resumeProfileError(session, message) {
  if (!resumeProfileIsCurrent(session)) return;
  session.message = message;
  session.messageError = true;
  session.loading = false;
  renderResumeProfile(session);
}

function validateResumeFile(file) {
  const filename = file.name || "resume";
  const extension = filename.toLocaleLowerCase().split(".").at(-1);
  if (file.size > RESUME_UPLOAD_MAX_BYTES) return "Choose a resume file that is 5 MiB or smaller.";
  if (extension !== "pdf" && extension !== "txt") return "Choose a PDF or plain text resume.";
  const allowed = extension === "pdf"
    ? new Set(["", "application/pdf", "application/x-pdf", "application/octet-stream"])
    : new Set(["", "text/plain", "application/octet-stream"]);
  if (!allowed.has((file.type || "").toLocaleLowerCase())) return "The selected file type does not match its extension. Choose a PDF or plain text resume.";
  return "";
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function importResumeFile(file) {
  const session = state.activeResumeProfileSession;
  if (!session || !resumeProfileIsCurrent(session) || !file) return;
  const validationError = validateResumeFile(file);
  if (validationError) {
    resumeProfileError(session, validationError);
    return;
  }
  session.controller?.abort();
  session.controller = new AbortController();
  session.id = ++state.resumeProfileRequestId;
  session.loading = true;
  session.stage = "importing";
  session.message = "";
  session.messageError = false;
  renderResumeProfile(session);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!resumeProfileIsCurrent(session)) return;
    const extension = file.name.toLocaleLowerCase().split(".").at(-1);
    const contentType = extension === "pdf" ? "application/pdf" : "text/plain";
    const csrfHeaders = await authClient.csrfHeaders();
    if (!resumeProfileIsCurrent(session)) return;
    const response = await fetch("/api/resume-profile/import", {
      method: "POST",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ filename: file.name, contentType, data: bytesToBase64(bytes) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not extract resume details. Please try another file.");
    if (!resumeProfileIsCurrent(session)) return;
    if (!payload.resume || !Array.isArray(payload.resume.education) || typeof payload.filename !== "string") {
      throw new Error("The extracted resume could not be read. Please try another file.");
    }
    session.candidate = { resume: payload.resume, filename: payload.filename, warnings: payload.warnings || [] };
    session.editedResume = payload.resume;
    session.loading = false;
    session.stage = "review";
    session.message = "Extraction is ready. Review the fields, then save to activate this resume.";
    session.messageError = false;
    renderResumeProfile(session);
  } catch (error) {
    if (!resumeProfileIsCurrent(session) || error?.name === "AbortError") return;
    session.loading = false;
    session.stage = "ready";
    session.message = error instanceof Error ? error.message : "Could not extract resume details. Please try again.";
    session.messageError = true;
    renderResumeProfile(session);
  }
}

async function saveResumeProfile() {
  const session = state.activeResumeProfileSession;
  if (!session || !resumeProfileIsCurrent(session) || session.loading || session.saving) return;
  const candidate = session.candidate;
  const record = candidate || session.profile;
  if (!record) return;
  const editor = $("[data-resume-editor='profile-resume']");
  const resume = collectEditedResume(editor, session.editedResume || record.resume);
  session.editedResume = resume;
  const validationError = validateEditableResume(resume);
  if (validationError) {
    resumeProfileError(session, validationError);
    return;
  }
  const filename = candidate?.filename || session.profile.filename;
  session.controller?.abort();
  session.controller = new AbortController();
  session.id = ++state.resumeProfileRequestId;
  session.saving = true;
  const button = $("[data-save-resume-profile]");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Saving…"; }
  const feedback = $("#resume-profile-feedback");
  if (feedback) feedback.textContent = "Saving your resume…";
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    if (!resumeProfileIsCurrent(session)) return;
    const response = await fetch("/api/resume-profile", {
      method: "PUT",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ resume, filename }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not save your resume. Please try again.");
    if (!resumeProfileIsCurrent(session)) return;
    if (!payload.profile?.resume) throw new Error("The saved resume response was incomplete. Please try again.");
    session.profile = payload.profile;
    setResumeProfileToolbarLabel(true);
    session.candidate = null;
    session.editedResume = payload.profile.resume;
    session.removeConfirm = false;
    session.message = candidate ? "Resume saved as your active profile." : "Resume changes saved.";
    session.messageError = false;
    session.saving = false;
    state.applicationDraftCache.clear();
    renderResumeProfile(session);
  } catch (error) {
    if (!resumeProfileIsCurrent(session) || error?.name === "AbortError") return;
    session.saving = false;
    session.message = error instanceof Error ? error.message : "Could not save your resume. Please try again.";
    session.messageError = true;
    renderResumeProfile(session);
  }
}

async function removeResumeProfile() {
  const session = state.activeResumeProfileSession;
  if (!session || !resumeProfileIsCurrent(session) || !session.removeConfirm) return;
  session.controller?.abort();
  session.controller = new AbortController();
  session.id = ++state.resumeProfileRequestId;
  const button = $("[data-confirm-remove-resume]");
  if (button) { button.disabled = true; button.setAttribute("aria-busy", "true"); button.textContent = "Removing…"; }
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    if (!resumeProfileIsCurrent(session)) return;
    const response = await fetch("/api/resume-profile", {
      method: "DELETE",
      credentials: "same-origin",
      signal: session.controller.signal,
      headers: { Accept: "application/json", ...csrfHeaders },
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Could not remove your saved resume. Please try again.");
    if (!resumeProfileIsCurrent(session)) return;
    session.profile = payload.profile || null;
    setResumeProfileToolbarLabel(Boolean(session.profile));
    session.candidate = null;
    session.editedResume = null;
    session.removeConfirm = false;
    session.message = "Saved resume removed.";
    session.messageError = false;
    state.applicationDraftCache.clear();
    renderResumeProfile(session);
  } catch (error) {
    if (!resumeProfileIsCurrent(session) || error?.name === "AbortError") return;
    session.removeConfirm = false;
    session.message = error instanceof Error ? error.message : "Could not remove your saved resume. Please try again.";
    session.messageError = true;
    renderResumeProfile(session);
  }
}

function editResumeProfileCollection(button) {
  const session = state.activeResumeProfileSession;
  if (!session || !resumeProfileIsCurrent(session) || session.loading || !session.candidate && !session.profile) return;
  const record = session.candidate || session.profile;
  const editor = $("[data-resume-editor='profile-resume']");
  const resume = collectEditedResume(editor, session.editedResume || record.resume);
  const addGroup = button.dataset.addResumeEntry;
  const removeGroup = button.dataset.removeResumeEntry;
  if (addGroup) {
    const max = addGroup === "education" ? 4 : 8;
    if (!Array.isArray(resume[addGroup]) || resume[addGroup].length >= max) return;
    resume[addGroup].push({ title: "", subtitle: "", date: "", bullets: [] });
  } else if (removeGroup) {
    const index = Number(button.dataset.entryIndex);
    if (!Array.isArray(resume[removeGroup]) || !Number.isInteger(index)) return;
    if (removeGroup === "education" && resume.education.length <= 1) {
      session.editedResume = resume;
      session.message = "Keep at least one education entry in your resume.";
      session.messageError = true;
      renderResumeProfile(session);
      return;
    }
    resume[removeGroup].splice(index, 1);
  } else if (button.hasAttribute("data-add-resume-skill")) {
    if (resume.skills.length >= 8) return;
    resume.skills.push({ label: "", items: [] });
  } else if (button.hasAttribute("data-remove-resume-skill")) {
    const skillGroup = button.closest("[data-resume-skill]");
    const index = Number(skillGroup?.dataset.skillIndex);
    if (!Number.isInteger(index)) return;
    resume.skills.splice(index, 1);
  } else {
    return;
  }
  session.editedResume = resume;
  session.message = "";
  session.messageError = false;
  renderResumeProfile(session);
  if (addGroup) {
    const entries = document.querySelectorAll(`[data-resume-entry][data-entry-group="${addGroup}"]`);
    entries[entries.length - 1]?.querySelector("[data-entry-field='title']")?.focus();
  } else if (button.hasAttribute("data-add-resume-skill")) {
    const skills = document.querySelectorAll("[data-resume-skill]");
    skills[skills.length - 1]?.querySelector("[data-skill-label]")?.focus();
  } else {
    const section = $(`#profile-resume-${removeGroup || "skills"}-heading`)?.closest(".application-draft-section");
    section?.querySelector("[data-resume-entry] [data-entry-field='title'], [data-resume-skill] [data-skill-label], .application-draft-add")?.focus();
  }
}

function showResumeProfileRemovalConfirmation() {
  const session = state.activeResumeProfileSession;
  if (!session || !resumeProfileIsCurrent(session) || !session.profile || session.candidate) return;
  session.editedResume = collectEditedResume($("[data-resume-editor='profile-resume']"), session.editedResume || session.profile.resume);
  session.removeConfirm = true;
  renderResumeProfile(session);
  $("[data-cancel-remove-resume]")?.focus();
}

function featuredHtml(role) {
  const listingType = role.listingType || "internship";
  const listingId = role.listingId || role.id;
  const applicationUrl = safeUrl(role.applicationUrl);
  const applicationLabel = escapeHtml(`Open direct application for ${role.title} at ${role.company}`);
  const isNew = isRecentListing(role, state.data);
  const schedule = roleScheduleLabel(role);
  const categories = roleArray(role.categories).slice(0, 4).map((category) => `<span class="pill">${escapeHtml(formatCategory(category))}</span>`).join("");
  const technologies = roleArray(role.technologies).slice(0, 3).map((tech) => `<span class="pill">${escapeHtml(tech)}</span>`).join("");
  const newPill = isNew ? '<span class="pill pill-new" title="Posted or found within the last 24 hours">New today</span>' : "";
  const liveSource = listingType === "grind";
  const verified = liveSource ? `<span class="verified-mark" title="Live source" aria-label="Live source"><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="12" r="9" fill="currentColor"/><path d="m8 12.2 2.4 2.4 5.6-5.6" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg></span>` : "";
  const applyLink = role.applicationUrl && applicationUrl !== "#"
    ? `<a class="job-apply-link" href="${escapeHtml(applicationUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${applicationLabel}">Apply now</a>`
    : "";
  const featuredLabel = isMatchesRoleView() ? "Top match in this view" : "Top role in this view";
  const posted = formatPosted(role.postingDate || role.firstSeenAt || role.discoveredAt);
  return `<div class="listing-clickable" data-listing-key="${escapeHtml(roleKey(role))}">
    <div class="featured-shell">
      <div class="featured-copy">
        <div class="featured-kicker-row"><div class="featured-kicker">${escapeHtml(featuredLabel)}</div>${eligibilityBadgeHtml(role)}</div>
        <div class="featured-title-lockup">
          <div class="featured-company-line">${companyLogoHtml(role)}<span>${escapeHtml(role.company)}</span>${verified}</div>
        <h3 class="featured-title">${escapeHtml(role.title)}</h3>
        </div>
        <div class="featured-meta"><span>${metaIcon("pin")}${escapeHtml(formatLocation(role))}</span><span>${metaIcon("briefcase")}${escapeHtml(formatMode(role))}</span>${schedule ? `<span class="featured-schedule">${escapeHtml(schedule)}</span>` : ""}</div>
        ${sponsorshipOfferHtml(role)}
        <div class="featured-pills">${newPill}${categories}${technologies}</div>
        <div class="featured-foot">
          <time class="job-posted job-posted--left">${escapeHtml(posted)}</time>
          ${isNew ? '<span class="job-new job-new--left" title="Posted or found within the last 24 hours">New today</span>' : ""}
        </div>
      </div>
      <div class="featured-side featured-side--large">
        <div class="listing-actions listing-row-actions listing-row-actions--large" aria-label="Actions for ${escapeHtml(role.title)} at ${escapeHtml(role.company)}">
          ${watchlistButton(role)}
          ${applyLink}${applicationDraftButtons(role)}
          ${listingActionButtons(role, listingType, listingId, role.company, role.title, { compact: true, wrapped: false })}
        </div>
      </div>
    </div>
  </div>`;
}

function roleRowHtml(role) {
  const listingType = role.listingType || "internship";
  const listingId = role.listingId || role.id;
  const isNew = isRecentListing(role, state.data);
  const schedule = roleScheduleLabel(role);
  const tags = jobTagValues(role).map((tag) => `<span class="job-tag">${escapeHtml(tag)}</span>`).join("");
  const location = formatLocation(role);
  const mode = formatMode(role);
  const posted = formatPosted(role.postingDate || role.firstSeenAt || role.discoveredAt);
  const matchReasons = isMatchesRoleView() ? roleSignalReasons(role) : [];
  const matchScore = isMatchesRoleView() ? roleSignalScore(role) : null;
  const applyUrl = safeUrl(role.applicationUrl);
  const applicationLabel = escapeHtml(`Open direct application for ${role.title} at ${role.company}`);
  const menuId = `row-menu-${String(listingType)}-${String(listingId)}`.replace(/[^a-zA-Z0-9_-]+/g, "-");
  const detailButton = `<button class="listing-card-link" type="button" data-open-role-detail aria-expanded="false" aria-controls="role-detail-panel" aria-label="${escapeHtml(`Inspect ${role.title} at ${role.company}`)}"></button>`;
  const applyLink = role.applicationUrl && applyUrl !== "#" ? `<a class="job-apply-link" href="${escapeHtml(applyUrl)}" target="_blank" rel="noopener noreferrer" aria-label="${applicationLabel}">Apply</a>` : "";
  const rowActions = `<div class="job-card-actions"><div class="listing-actions listing-row-actions listing-row-actions--large" aria-label="Actions for ${escapeHtml(role.title)} at ${escapeHtml(role.company)}">${watchlistButton(role)}${applyLink}${applicationDraftButtons(role)}${listingActionButtons(role, listingType, listingId, role.company, role.title, { compact: true, wrapped: false })}</div></div>`;
  const menu = `<div class="row-menu job-card-menu"><button class="row-menu-trigger job-more" type="button" aria-label="More actions for ${escapeHtml(role.title)}" aria-haspopup="dialog" aria-expanded="false" aria-controls="${escapeHtml(menuId)}" data-menu-trigger>${moreActionsIconHtml()}</button><div class="row-menu-popover" id="${escapeHtml(menuId)}" role="dialog" aria-label="Actions for ${escapeHtml(role.title)} at ${escapeHtml(role.company)}" hidden><button class="ghost-action" type="button" data-open-role-detail aria-expanded="false" aria-controls="role-detail-panel">Inspect details</button>${watchlistButton(role)}${listingActionButtons(role, listingType, listingId, role.company, role.title, { compact: true })}</div></div>`;
  return `<article class="job-card listing-clickable${isNew ? " job-card-new" : ""}" data-listing-key="${escapeHtml(roleKey(role))}" role="listitem">
    ${detailButton}
    ${companyLogoHtml(role, "card")}
    <div class="job-card-body">
      <h3 class="job-title">${escapeHtml(role.title)}</h3>
      <div class="job-company-row"><div class="job-company">${escapeHtml(role.company)}${verifiedMarkHtml()}</div>${eligibilityBadgeHtml(role)}</div>
      <div class="job-meta">
        <span class="job-meta-location">${metaIcon("pin")}${escapeHtml(location)}</span>
        ${mode !== "—" ? `<span class="job-mode">${escapeHtml(mode)}</span>` : ""}
        ${schedule ? `<span class="job-season">${escapeHtml(schedule)}</span>` : ""}
      </div>
      ${sponsorshipOfferHtml(role)}
      ${tags ? `<div class="job-tags" aria-label="Skills and categories">${tags}</div>` : ""}
      <div class="job-card-foot">
        <time class="job-posted job-posted--left">${escapeHtml(posted)}</time>
        ${isNew ? '<span class="job-new job-new--left" title="Posted or found within the last 24 hours">New today</span>' : ""}
      </div>
      ${isMatchesRoleView() ? `<div class="job-match-meta"><strong>${escapeHtml(matchScore.value)} ${escapeHtml(matchScore.label)}</strong><span>${escapeHtml(matchReasons[0])}</span></div>` : ""}
    </div>
    <div class="job-card-side job-card-side--large">
      <div class="job-card-side-top">
        ${menu}
      </div>
      ${rowActions}
    </div>
  </article>`;
}

function renderFeatured() {
  const panel = $("#featured-match");
  if (!panel) return;
  if (isSavedRoleView()) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  const role = featuredRole();
  if (!role || state.loading) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }
  panel.hidden = false;
  panel.setAttribute("aria-label", isMatchesRoleView() ? "Featured match" : "Featured role");
  panel.classList.add("featured-match");
  panel.innerHTML = featuredHtml(role);
  bindCompanyLogos(panel);
  setupMatchCarousel(panel.querySelector("[data-match-carousel]"));
}

function reducedMotionPreferred() {
  return typeof document !== "undefined" && document.documentElement.dataset.motion === "reduced"
    || typeof window === "undefined"
    || Boolean(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
}

function motionRuntime() {
  const gsap = typeof window !== "undefined" ? window.gsap : null;
  if (gsap && window.ScrollTrigger) gsap.registerPlugin(window.ScrollTrigger);
  return gsap;
}

function updateMatchCarousel(root, index, { animate = true } = {}) {
  if (!root) return;
  const cards = [...root.querySelectorAll("[data-match-signal]")];
  if (!cards.length) return;
  const nextIndex = ((Number(index) % cards.length) + cards.length) % cards.length;
  root.dataset.active = String(nextIndex);
  const gsap = motionRuntime();
  cards.forEach((card, cardIndex) => {
    const distance = cardIndex - nextIndex;
    const active = distance === 0;
    card.setAttribute("aria-hidden", String(!active));
    const properties = {
      autoAlpha: active ? 1 : distance > 0 ? Math.max(.08, .22 - distance * .05) : 0,
      scale: active ? 1 : Math.max(.93, 1 - Math.abs(distance) * .025),
      y: active ? 0 : distance > 0 ? Math.min(24, distance * 9) : -10,
      zIndex: cards.length - Math.abs(distance),
    };
    if (!gsap || reducedMotionPreferred() || !animate) {
      if (gsap) gsap.set(card, properties);
      else {
        card.style.opacity = String(properties.autoAlpha);
        card.style.transform = `translateY(${properties.y}px) scale(${properties.scale})`;
        card.style.visibility = properties.autoAlpha === 0 ? "hidden" : "visible";
        card.style.zIndex = String(properties.zIndex);
      }
      return;
    }
    gsap.to(card, { ...properties, duration: .42, ease: "power3.out", overwrite: true });
  });
  const count = root.querySelector(".match-carousel-count");
  if (count) count.textContent = `${nextIndex + 1} / ${cards.length}`;
  const activeWords = cards[nextIndex].querySelectorAll(".signal-word");
  if (!gsap || reducedMotionPreferred()) {
    activeWords.forEach((word) => { word.style.opacity = "1"; });
    return;
  }
  gsap.set(activeWords, { opacity: .24 });
  gsap.to(activeWords, { opacity: 1, duration: .55, stagger: .014, ease: "power1.out", overwrite: true });
}

function setupMatchCarousel(root) {
  if (!root) return;
  updateMatchCarousel(root, Number(root.dataset.active || 0), { animate: false });
}

function animateRoleRows(rows) {
  const gsap = motionRuntime();
  if (!gsap || reducedMotionPreferred() || !rows?.length) return;
  gsap.fromTo(rows.slice(0, 16), { opacity: .55, y: 12 }, { opacity: 1, y: 0, duration: .34, stagger: .018, ease: "power2.out", overwrite: true });
}

function refreshRoleMotion({ animateRows = true } = {}) {
  state.roleMotionContext?.revert?.();
  state.roleMotionContext = null;
  const gsap = motionRuntime();
  const scroll = $("#jobs-scroll");
  if (!gsap || !scroll || reducedMotionPreferred()) {
    document.querySelectorAll(".signal-word").forEach((word) => { word.style.opacity = "1"; });
    return;
  }
  state.roleMotionContext = gsap.context(() => {
    if (animateRows) animateRoleRows([...scroll.querySelectorAll(".job-card")]);
    const carousel = scroll.querySelector("[data-match-carousel]");
    const cards = carousel ? [...carousel.querySelectorAll(".match-signal-card")] : [];
    if (carousel && cards.length && window.ScrollTrigger) {
      gsap.fromTo(cards,
        { y: (index) => 24 + index * 9, opacity: (index) => index === 0 ? .45 : .08 },
        {
          y: (index) => index * 5,
          opacity: (index) => index === 0 ? 1 : Math.max(.08, .2 - index * .04),
          ease: "none",
          scrollTrigger: { trigger: carousel, scroller: scroll, start: "top 94%", end: "top 46%", scrub: .45 },
        },
      );
      const words = cards[0].querySelectorAll(".signal-word");
      gsap.to(words, {
        opacity: 1,
        stagger: .022,
        ease: "none",
        scrollTrigger: { trigger: carousel, scroller: scroll, start: "top 90%", end: "bottom 42%", scrub: .55 },
      });
    }
  }, scroll);
}

function setupRoleDetailMotion(panel) {
  const gsap = motionRuntime();
  if (!gsap || reducedMotionPreferred()) return;
  gsap.fromTo(panel, { opacity: .78, x: 28 }, { opacity: 1, x: 0, duration: .34, ease: "power3.out", overwrite: true });
}

function renderCrawlStatistics(data) {
  const analytics = isAnalyticsView() && state.analyticsData ? state.analyticsData : data;
  const stats = analytics?.stats || {};
  const account = state.analyticsAccount;
  const savedCountsReady = account?.status === "authenticated" && account.userId === state.auth?.user?.id;
  const crawlStatistics = $("#crawl-statistics");
  if (crawlStatistics) {
    const open = stats.open == null ? null : crawlStatCount(stats.open);
    const fresh = stats.new == null ? null : crawlStatCount(stats.new);
    const updated = stats.updated == null ? null : crawlStatCount(stats.updated);
    const closed = stats.closed == null ? null : crawlStatCount(stats.closed);
    const hidden = savedCountsReady ? account.hiddenCount : null;
    const applied = savedCountsReady ? account.appliedRoleCount : null;
    crawlStatistics.innerHTML = `<div class="crawl-stat-row crawl-stat-row-top">
        ${crawlStatHtml("crawl-stat-primary", open, "Open roles")}
        ${crawlStatHtml("crawl-stat-new", fresh, "New")}
        ${crawlStatHtml("crawl-stat-updated", updated, "Updated")}
      </div>
      <div class="crawl-stat-row crawl-stat-row-bottom">
        ${crawlStatHtml("crawl-stat-closed", closed, "Closed by crawler")}
        ${crawlStatHtml("crawl-stat-hidden", hidden, "Hidden by you")}
        ${crawlStatHtml("crawl-stat-applied", applied, "Applied roles")}
      </div>`;
  }
  const accountStatus = $("#analytics-account-status");
  if (accountStatus) {
    accountStatus.hidden = false;
    const signInHref = `/login?next=${encodeURIComponent(`${window.location.pathname}${window.location.search}#analytics`)}`;
    accountStatus.innerHTML = savedCountsReady && !account.error
      ? `Saved counts for ${escapeHtml(state.auth.user.email || "your account")}.`
      : state.auth?.status === "anonymous"
      ? `Your saved counts are linked to your account. <a href="${escapeHtml(signInHref)}">Sign in to see them</a>.`
      : account?.error || state.auth?.status === "unavailable"
        ? `${escapeHtml(account?.error || "Your account could not be checked.")} <button class="text-link" type="button" data-retry-analytics-account>Retry saved counts</button>`
        : "Checking your saved counts…";
  }
  const updated = $("#analytics-updated-value");
  if (updated) updated.textContent = analytics?.generatedAt ? formatDate(analytics.generatedAt, true) : "Waiting for data";
}

function renderRoleTabs(data) {
  const counts = data?.counts || data?.filterMeta?.tabCounts || {};
  document.querySelectorAll("[data-role-tab]").forEach((button) => {
    const tab = button.dataset.roleTab;
    const active = tab === state.activeTab;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.setAttribute("tabindex", active ? "0" : "-1");
    const count = button.querySelector("[data-role-tab-count]");
    if (count) {
      count.textContent = tab === SAVED_ROLE_TAB
        ? formatNumber(visibleWatchlistRoles().length)
        : Number.isFinite(Number(counts[tab])) ? formatNumber(counts[tab]) : "—";
    }
  });
  const panel = $("#jobs-scroll");
  const activeTab = document.querySelector("[data-role-tab][aria-selected='true']");
  if (panel && activeTab?.id) panel.setAttribute("aria-labelledby", activeTab.id);
}

function handleRoleTabKeydown(event) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  const tabs = [...document.querySelectorAll("[data-role-tab]")].filter((tab) => !tab.disabled);
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0 || !tabs.length) return;
  event.preventDefault();
  const rtl = document.documentElement.dir === "rtl";
  const direction = event.key === "ArrowRight" ? (rtl ? -1 : 1) : (rtl ? 1 : -1);
  const nextIndex = event.key === "Home"
    ? 0
    : event.key === "End"
      ? tabs.length - 1
      : (current + direction + tabs.length) % tabs.length;
  tabs[nextIndex].focus();
  tabs[nextIndex].click();
}

function renderWatchlistCount() {
  const visibleCount = visibleWatchlistRoles().length;
  const count = $("#watchlist-count");
  if (count) {
    count.textContent = formatNumber(visibleCount);
    count.hidden = visibleCount === 0;
  }
  const savedTabCount = document.querySelector('[data-role-tab-count="saved"]');
  if (savedTabCount) savedTabCount.textContent = formatNumber(visibleCount);
}

function renderNavigation() {
  const activeNav = state.activeView === "dashboard"
    ? "dashboard"
    : state.activeView === "sources"
      ? "sources"
    : state.activeView === "analytics"
      ? "analytics"
    : state.activeView === "applications"
    ? "applications"
    : isSavedRoleView()
      ? "watchlist"
      : state.activeView === "settings"
        ? "settings"
        : state.activeView === "roles" ? "roles" : "dashboard";
  document.querySelectorAll("[data-nav]").forEach((link) => {
    const active = link.dataset.nav === activeNav;
    link.classList.toggle("active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  renderWatchlistCount();
}

function setViewVisibility() {
  const activeRoleView = state.activeView === "watchlist"
    ? "roles"
    : state.activeView === "dashboard"
      ? "roles"
      : state.activeView === "sources" ? "analytics" : state.activeView;
  document.querySelectorAll("[data-role-view]").forEach((view) => {
    view.hidden = view.dataset.roleView !== activeRoleView;
  });
  const main = $("#main-content");
  if (main) main.setAttribute("aria-labelledby", activeRoleView === "applications"
    ? "applications-title"
    : activeRoleView === "analytics"
      ? state.activeView === "sources" ? "sources-heading" : "analytics-title"
      : activeRoleView === "settings" ? "settings-title" : "page-title");
}

function roleViewHref(view) {
  if (typeof window === "undefined") return `/jobs?view=${encodeURIComponent(view)}`;
  const url = new URL(window.location.href);
  url.searchParams.set("view", normalizeRoleView(view));
  return `${url.pathname}${url.search}${url.hash}`;
}

function renderRoleViewSwitch() {
  const switcher = $("#role-view-switch");
  if (!switcher) return;
  const hidden = isSavedRoleView();
  switcher.hidden = hidden;
  switcher.querySelectorAll("[data-role-view-link]").forEach((link) => {
    const view = normalizeRoleView(link.dataset.roleViewLink);
    link.setAttribute("href", roleViewHref(view));
    if (!hidden && view === state.roleView) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function renderViewChrome() {
  if (!["roles", "dashboard", "watchlist"].includes(state.activeView)) {
    setViewVisibility();
    return;
  }
  const watchlist = state.activeView === "watchlist";
  const savedTab = state.activeView === "roles" && state.activeTab === SAVED_ROLE_TAB;
  const title = $("#page-title");
  const subtitle = document.querySelector(".page-subtitle");
  const roleTabs = document.querySelector(".role-tabs");
  if (typeof document !== "undefined") {
    document.title = watchlist || savedTab
      ? "Saved roles — Scout"
      : isMatchesRoleView() ? "Matches for you — Scout" : "All internships — Scout";
  }
  if (title) title.innerHTML = watchlist || savedTab
    ? 'Saved roles <span class="title-cutout" aria-hidden="true"></span> ready when you are.'
    : isMatchesRoleView()
      ? 'Matches for you <span class="title-cutout" aria-hidden="true"></span> ranked by your preferences.'
      : 'All internships <span class="title-cutout" aria-hidden="true"></span> in the live market.';
  if (subtitle) subtitle.textContent = watchlist || savedTab
    ? "Only the roles you saved, with the same filters, detail view, and direct actions as the live opportunity feed."
    : isMatchesRoleView()
      ? "Eligible internships ordered by the preferences you saved, with the posting details behind each match."
      : "Browse the full open internship catalog, then narrow it with search, filters, and source context.";
  const resultsContext = $("#results-context");
  if (resultsContext) resultsContext.textContent = watchlist || savedTab
    ? "Open a saved role to inspect its source and posting context without losing your place."
    : isMatchesRoleView()
      ? "Open a role to inspect why it matches without losing your place."
      : "Open a role to inspect the source and posting context without losing your place.";
  if (roleTabs) roleTabs.hidden = watchlist;
  renderRoleViewSwitch();
  setViewVisibility();
}

function settingsUnreadCount() {
  return state.notifications.filter(notificationPreferenceEnabled)
    .filter((notification) => !state.notificationReadIds.has(notification.id)).length;
}

function settingsLatestCrawl(data) {
  const completed = data?.latestCompletedRun || (Array.isArray(data?.runs)
    ? data.runs.find((run) => String(run?.status || "").toUpperCase() === "COMPLETED")
    : null);
  return completed ? relativeDate(completed.finished_at || completed.started_at) : "—";
}

function animateSettingsView() {
  const view = $("#settings-view");
  const panels = view ? [...view.querySelectorAll(".settings-panel")] : [];
  const gsap = motionRuntime();
  if (!panels.length || !gsap || reducedMotionPreferred()) return;
  gsap.fromTo(panels, { opacity: .45, y: 12 }, {
    opacity: 1,
    y: 0,
    duration: .38,
    ease: "power2.out",
    overwrite: true,
    stagger: .035,
  });
}

function renderSettings({ animate = false } = {}) {
  const view = $("#settings-view");
  if (!view) return;
  const settings = state.settings;
  const fields = [
    ["#settings-theme", settings.theme],
    ["#settings-motion", settings.motion],
    ["#settings-default-tab", settings.defaultTab],
    ["#settings-default-sort", settings.defaultSort],
    ["#settings-default-status", settings.defaultStatus],
    ["#settings-notify-completed", settings.notifyCompleted],
    ["#settings-notify-failed", settings.notifyFailed],
    ["#settings-notify-new", settings.notifyNew],
    ["#settings-notify-deadline-soon", settings.notifyDeadlineSoon],
  ];
  for (const [selector, value] of fields) {
    const input = $(selector);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else if (input.value !== value) input.value = value;
  }
  const sourceCount = $("#settings-source-count");
  if (sourceCount) sourceCount.textContent = state.data ? formatNumber(configuredSourceCount(state.data)) : "—";
  const visibleWatchlistCount = visibleWatchlistRoles().length;
  const watchlistCount = $("#settings-watchlist-count");
  if (watchlistCount) watchlistCount.textContent = formatNumber(visibleWatchlistCount);
  const unreadCount = $("#settings-unread-count");
  if (unreadCount) unreadCount.textContent = formatNumber(settingsUnreadCount());
  const lastCrawl = $("#settings-last-crawl");
  if (lastCrawl) lastCrawl.textContent = settingsLatestCrawl(state.data);
  const watchlistSummary = $("#settings-watchlist-summary");
  if (watchlistSummary) watchlistSummary.textContent = `${formatNumber(visibleWatchlistCount)} saved ${visibleWatchlistCount === 1 ? "role" : "roles"}`;
  const savedViewsCount = readSavedViews().length;
  const savedViewsSummary = $("#settings-saved-views-summary");
  if (savedViewsSummary) savedViewsSummary.textContent = `${formatNumber(savedViewsCount)} saved ${savedViewsCount === 1 ? "filter" : "filters"}`;
  const notificationsCount = state.notifications.filter(notificationPreferenceEnabled).length;
  const notificationsSummary = $("#settings-notifications-summary");
  if (notificationsSummary) notificationsSummary.textContent = `${formatNumber(notificationsCount)} ${notificationsCount === 1 ? "alert" : "alerts"} stored`;
  const status = $("#settings-save-status");
  if (status) status.textContent = "Saved on this device";
  const shortcut = $("#settings-search-shortcut");
  if (shortcut) shortcut.textContent = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘ K" : "Ctrl K";
  const undoShortcut = $("#settings-undo-shortcut");
  if (undoShortcut) undoShortcut.textContent = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘ Z" : "Ctrl Z";
  if (animate) animateSettingsView();
}

function confirmLocalDataAction(message) {
  return typeof window === "undefined" || typeof window.confirm !== "function" ? true : window.confirm(message);
}

function clearLocalSettingsData(action) {
  if (action === "clear-watchlist") {
    if (!state.watchlistRoles.length || !confirmLocalDataAction("Clear every saved role from this browser?")) return;
    state.watchlistRoles = [];
    writeWatchlistRoles([]);
    renderWatchlistCount();
    if (isSavedRoleView()) handleFilterChange();
    renderSettings();
    showToast("Watchlist cleared on this device.");
    return;
  }
  if (action === "clear-saved-views") {
    if (!readSavedViews().length || !confirmLocalDataAction("Clear every saved filter from this browser?")) return;
    try { localStorage.removeItem(SAVED_VIEWS_KEY); } catch { /* Keep the in-memory dashboard usable. */ }
    renderSavedViews();
    renderSettings();
    showToast("Saved filters cleared on this device.");
    return;
  }
  if (action === "clear-notifications") {
    if (!state.notifications.length || !confirmLocalDataAction("Clear notification history from this browser?")) return;
    state.notifications = [];
    state.notificationReadIds.clear();
    persistNotificationState();
    renderNotifications();
    renderSettings();
    showToast("Notification history cleared on this device.");
  }
}

function resetDashboardSettings() {
  if (!confirmLocalDataAction("Reset appearance, feed, and notification preferences?")) return;
  state.settings = { ...DEFAULT_DASHBOARD_SETTINGS };
  state.activeTab = state.settings.defaultTab;
  if ($("#settings-default-status")) $("#settings-default-status").value = state.settings.defaultStatus;
  if ($("#sort-filter")) $("#sort-filter").value = state.settings.defaultSort;
  persistDashboardSettings();
  applyThemePreference(state.settings.theme);
  applyMotionPreference(state.settings.motion);
  state.notifications = state.notifications.filter(notificationPreferenceEnabled);
  persistNotificationState();
  renderSettings();
  renderNotifications();
  showToast("Preferences reset to defaults.");
}

function handleSettingsFieldChange(event) {
  const input = event.target;
  if (!(input instanceof Element)) return;
  const settingById = {
    "settings-theme": "theme",
    "settings-motion": "motion",
    "settings-default-tab": "defaultTab",
    "settings-default-sort": "defaultSort",
    "settings-default-status": "defaultStatus",
    "settings-notify-completed": "notifyCompleted",
    "settings-notify-failed": "notifyFailed",
    "settings-notify-new": "notifyNew",
    "settings-notify-deadline-soon": "notifyDeadlineSoon",
  };
  const key = settingById[input.id];
  if (!key) return;
  updateDashboardSettings({ [key]: input.type === "checkbox" ? input.checked : input.value });
}

function normalizeApplicationStage(stage, legacyStatus) {
  if (APPLICATION_STAGE_VALUES.has(stage)) return stage;
  return LEGACY_APPLICATION_STAGE_MAP.get(legacyStatus) || "applied";
}

function applicationStageLabel(stage) {
  return APPLICATION_STAGE_LABELS.get(normalizeApplicationStage(stage)) || "Applied";
}

function derivedApplicationCounts(applications = state.applications) {
  const values = Array.isArray(applications) ? applications : [];
  const counts = {
    all: values.length,
    applied: 0,
    oa: 0,
    recruiter: 0,
    interview: 0,
    final: 0,
    offer: 0,
    rejected: 0,
  };
  for (const application of values) {
    const stage = normalizeApplicationStage(application.stage, application.status);
    counts[stage] += 1;
  }
  return counts;
}

function applicationSearchText(application) {
  return [
    application.company,
    application.title,
    ...(application.location || []),
    application.jobId,
  ].filter(Boolean).join(" ").toLocaleLowerCase();
}

function filteredApplications() {
  const search = String(state.applicationSearch || "").trim().toLocaleLowerCase();
  return state.applications.filter((application) => (
    (state.applicationStageFilter === "all" || normalizeApplicationStage(application.stage, application.status) === state.applicationStageFilter)
    && (!search || applicationSearchText(application).includes(search))
  ));
}

function applicationRole(application) {
  return application.role || {
    id: application.listingId,
    listingType: application.listingType,
    listingId: application.listingId,
    jobId: application.jobId,
    company: application.company,
    title: application.title,
    location: application.location || [],
    applicationUrl: application.applicationUrl || "",
    postingUrl: application.postingUrl || "",
    sourceUrl: application.postingUrl || application.applicationUrl || "",
    sources: [],
  };
}

function applicationSummaryHtml() {
  const counts = state.applicationCounts || derivedApplicationCounts();
  return [["all", "All applications"], ...APPLICATION_STAGE_OPTIONS.map(({ value, label }) => [value, label])]
    .map(([stage, label]) => `<button class="application-summary-card${state.applicationStageFilter === stage ? " active" : ""}" type="button" data-application-filter="${stage}" aria-pressed="${String(state.applicationStageFilter === stage)}"><span class="application-summary-label">${label}</span><strong class="application-summary-value">${escapeHtml(formatNumber(stage === "all" ? counts.all : counts[stage] ?? 0))}</strong></button>`)
    .join("");
}

function applicationCardHtml(application) {
  const key = application.listingKey || listingKey(application.listingType, application.listingId);
  const role = applicationRole(application);
  const location = (application.location || []).filter(Boolean).join(" · ") || "Location not listed";
  const applicationUrl = safeUrl(application.applicationUrl);
  const postingUrl = safeUrl(application.postingUrl);
  const stage = normalizeApplicationStage(application.stage, application.status);
  const pending = state.pendingApplicationStages.has(key);
  const progressStages = APPLICATION_STAGE_OPTIONS.slice(0, 5);
  const progressIndex = progressStages.findIndex(({ value }) => value === stage);
  const stageButton = ({ value, label }, index, group = "progress") => {
    const isCurrent = stage === value;
    const isCompleted = group === "progress" && stage !== "rejected" && (stage === "offer" || (progressIndex >= 0 && index < progressIndex));
    const stateClass = isCurrent ? " is-current" : isCompleted ? " is-complete" : "";
    const number = group === "progress" ? index + 1 : "";
    return `<li class="application-stage-item${stateClass}"${isCurrent ? ' aria-current="step"' : ""}>
      <button class="application-stage-step" type="button" data-application-stage="${value}" data-application-listing-type="${escapeHtml(application.listingType)}" data-application-listing-id="${escapeHtml(application.listingId)}" aria-label="Move ${escapeHtml(application.title)} to ${label}" aria-pressed="${String(isCurrent)}"${pending ? " disabled" : ""}>
        ${number ? `<span class="application-stage-marker" aria-hidden="true">${number}</span>` : `<span class="application-stage-marker application-stage-marker-outcome" aria-hidden="true"></span>`}
        <span class="application-stage-step-label">${label}</span>
      </button>
    </li>`;
  };
  const links = [
    postingUrl !== "#" ? `<a href="${escapeHtml(postingUrl)}" target="_blank" rel="noopener noreferrer">View posting</a>` : "",
    applicationUrl !== "#" ? `<a href="${escapeHtml(applicationUrl)}" target="_blank" rel="noopener noreferrer">Open application</a>` : "",
  ].filter(Boolean).join("");
  /* Today/application reminder support is dormant for now.
  const localDateTime = (value) => {
    if (!value || !Number.isFinite(Date.parse(value))) return "";
    const date = new Date(value);
    return new Date(date.valueOf() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  };
  */
  return `<article class="application-card" data-application-key="${escapeHtml(key)}" role="listitem">
    ${companyLogoHtml(role, "sm")}
    <div class="application-card-main">
      <h2 class="application-card-title">${escapeHtml(application.title)}</h2>
      <p class="application-card-company">${escapeHtml(application.company)}</p>
      <div class="application-card-meta"><span>${escapeHtml(location)}</span><span>Applied ${escapeHtml(formatDate(application.appliedAt))}</span></div>
      <div class="application-stage-current"><span class="application-stage-kicker">Current stage</span><span class="application-status-badge stage-${escapeHtml(stage)}">${escapeHtml(applicationStageLabel(stage))}</span></div>
      <div class="application-stage-control">
        <ol class="application-stage-track" aria-label="Application progress">
          ${progressStages.map((option, index) => stageButton(option, index)).join("")}
        </ol>
        <div class="application-stage-outcomes">
          <span class="application-stage-outcome-label">Outcome</span>
          <ol class="application-stage-outcome-track" aria-label="Application outcome">
            ${APPLICATION_STAGE_OPTIONS.slice(5).map((option, index) => stageButton(option, index, "outcome")).join("")}
          </ol>
        </div>
      </div>
      ${/* Today/application reminder form is dormant for now.
      `<form class="application-reminder-form" data-application-reminders data-listing-type="${escapeHtml(application.listingType)}" data-listing-id="${escapeHtml(application.listingId)}" aria-label="Reminders for ${escapeHtml(application.title)} at ${escapeHtml(application.company)}">
        <label>Follow-up date<input type="datetime-local" name="followUpAt" value="${escapeHtml(localDateTime(application.followUpAt))}" /></label>
        <label>Interview date<input type="datetime-local" name="interviewAt" value="${escapeHtml(localDateTime(application.interviewAt))}" /></label>
        <button class="button button-subtle" type="submit">Save reminders</button>
        <p class="application-reminder-feedback" role="status" aria-live="polite">Dates use your local timezone.</p>
      </form>`
      */ ""}
    </div>
    <div class="application-card-actions">
      ${links ? `<div class="application-links">${links}</div>` : ""}
    </div>
  </article>`;
}

function renderApplications() {
  const list = $("#applications-list");
  if (!list) return;
  const status = $("#applications-status");
  setViewVisibility();
  const summary = $("#application-summary");
  if (summary) summary.innerHTML = applicationSummaryHtml();
  const filter = $("#applications-stage-filter");
  if (filter && filter.value !== state.applicationStageFilter) filter.value = state.applicationStageFilter;
  if (state.applicationsLoading) {
    list.setAttribute("aria-busy", "true");
    if (status) status.textContent = "Loading applications…";
    list.innerHTML = '<div class="applications-loading" role="status">Loading applications…</div>';
    return;
  }
  list.setAttribute("aria-busy", "false");
  if (state.applicationsError) {
    if (status) status.textContent = state.applicationsError;
    list.innerHTML = `<div class="applications-empty error-state" role="alert"><p>${escapeHtml(state.applicationsError)}</p><button class="button button-subtle" type="button" data-retry-applications>Retry</button></div>`;
    return;
  }
  const applications = filteredApplications();
  if (!applications.length) {
    const message = state.applications.length
      ? "No applications match this filter."
      : "Roles you mark as Applied will appear here.";
    if (status) status.textContent = message;
    list.innerHTML = `<div class="applications-empty"><p>${escapeHtml(message)}</p></div>`;
    return;
  }
  if (status) status.textContent = `Showing ${formatNumber(applications.length)} ${applications.length === 1 ? "application" : "applications"}.`;
  list.innerHTML = applications.map(applicationCardHtml).join("");
  bindCompanyLogos(list);
}

async function loadApplications({ force = false } = {}) {
  if (state.applicationsRequest && !force) return state.applicationsRequest;
  state.applicationsLoading = true;
  state.applicationsError = null;
  renderApplications();
  const request = (async () => {
    try {
      const response = await fetch("/api/applications", { cache: "no-store", headers: { Accept: "application/json" } });
      const payload = await readJsonResponse(response);
      state.applications = Array.isArray(payload.applications)
        ? payload.applications.map((application) => ({
          ...application,
          stage: normalizeApplicationStage(application.stage, application.status),
        }))
        : [];
      state.applicationCounts = derivedApplicationCounts(state.applications);
      state.applicationsError = null;
      renderApplications();
      return payload;
    } catch (error) {
      state.applicationsError = error?.message || "Could not load applications";
      renderApplications();
      return null;
    } finally {
      state.applicationsLoading = false;
      state.applicationsRequest = null;
      renderApplications();
    }
  })();
  state.applicationsRequest = request;
  return request;
}

async function updateApplicationStage(button) {
  const listingType = button.dataset.applicationListingType;
  const listingId = button.dataset.applicationListingId;
  const stage = button.dataset.applicationStage;
  const key = listingType && listingId ? listingKey(listingType, listingId) : "";
  const application = state.applications.find((candidate) => candidate.listingKey === key);
  if (!application || !key || !APPLICATION_STAGE_VALUES.has(stage) || state.pendingApplicationStages.has(key)) return;
  const previousStage = normalizeApplicationStage(application.stage, application.status);
  if (previousStage === stage) return;
  state.pendingApplicationStages.add(key);
  application.stage = stage;
  state.applicationCounts = derivedApplicationCounts();
  renderApplications();
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    const response = await fetch("/api/applications/status", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ listingType, listingId, stage }),
    });
    const payload = await readJsonResponse(response);
    state.applicationCounts = payload.counts || derivedApplicationCounts();
    showToast(`${application.title} moved to ${applicationStageLabel(stage)}.`);
  } catch (error) {
    application.stage = previousStage;
    state.applicationCounts = derivedApplicationCounts();
    showToast(error?.message || "Could not update application stage");
  } finally {
    state.pendingApplicationStages.delete(key);
    renderApplications();
  }
}

function openApplicationsView({ updateLocation = true } = {}) {
  state.activeView = "applications";
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#applications" });
  renderNavigation();
  renderViewChrome();
  renderApplications();
  void loadApplications();
}

/* Today/application reminder support is dormant for now.
async function saveApplicationReminderForm(form) {
  const button = form.querySelector("button[type='submit']");
  const feedback = form.querySelector(".application-reminder-feedback");
  if (button?.disabled) return;
  button.disabled = true;
  feedback.textContent = "Saving reminders…";
  const dates = {};
  try {
    for (const name of ["followUpAt", "interviewAt"]) {
      const input = form.querySelector(`[name="${name}"]`);
      dates[name] = input.value ? new Date(input.value).toISOString() : null;
    }
    const csrfHeaders = await authClient.csrfHeaders();
    const response = await fetch("/api/applications/reminders", { method: "POST", cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ listingType: form.dataset.listingType, listingId: form.dataset.listingId, ...dates }),
    });
    await readJsonResponse(response);
    const application = state.applications.find((item) => item.listingType === form.dataset.listingType && item.listingId === form.dataset.listingId);
    if (application) Object.assign(application, dates);
    feedback.textContent = "Reminders saved.";
  } catch (error) {
    feedback.textContent = error?.message || "Reminders couldn’t be saved. Try again.";
  } finally { button.disabled = false; }
}
*/

function openDashboardView({ updateLocation = true } = {}) {
  const cameFromSettings = state.activeView === "settings";
  const cameFromSavedRoles = isSavedRoleView();
  state.activeView = "dashboard";
  if (cameFromSettings || cameFromSavedRoles) {
    state.activeTab = state.settings.defaultTab;
    if (cameFromSettings) {
      if ($("#status-filter")) $("#status-filter").value = state.settings.defaultStatus;
      if ($("#sort-filter")) $("#sort-filter").value = state.settings.defaultSort;
    }
  }
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#dashboard" });
  renderNavigation();
  renderViewChrome();
  handleFilterChange();
}

function openRolesView({ tab = null, updateLocation = true } = {}) {
  const cameFromSettings = state.activeView === "settings";
  state.activeView = "roles";
  if (tab) state.activeTab = ROLE_TABS.includes(tab) ? tab : "main";
  else if (cameFromSettings) {
    state.activeTab = state.settings.defaultTab;
    if ($("#status-filter")) $("#status-filter").value = state.settings.defaultStatus;
    if ($("#sort-filter")) $("#sort-filter").value = state.settings.defaultSort;
  }
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#roles" });
  renderNavigation();
  renderViewChrome();
  handleFilterChange();
}

function openWatchlistView({ updateLocation = true } = {}) {
  state.activeView = "roles";
  state.activeTab = SAVED_ROLE_TAB;
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#roles" });
  renderNavigation();
  renderViewChrome();
  handleFilterChange();
}

function openAnalyticsView({ updateLocation = true } = {}) {
  state.activeView = "analytics";
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#analytics" });
  renderNavigation();
  renderViewChrome();
  if (state.data) renderChrome(state.data);
  void syncAnalytics({ force: true });
}

function openSourcesView({ updateLocation = true } = {}) {
  state.activeView = "sources";
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#sources" });
  renderNavigation();
  renderViewChrome();
  if (state.data) renderChrome(state.data);
  void syncAnalytics({ force: true });
  $("#source-list")?.scrollIntoView({ block: "nearest" });
}

function openSettingsView({ updateLocation = true } = {}) {
  state.activeView = "settings";
  if (updateLocation && typeof history !== "undefined") syncUiStateToUrl({ push: true, hash: "#settings" });
  renderNavigation();
  renderViewChrome();
  renderSettings({ animate: true });
}

function currentStatusLabel() {
  const filter = $("#status-filter")?.value || "open";
  return filter === "closed" ? "Closed roles" : filter === "all" ? "All roles" : filter === "new" ? "New roles" : filter === "updated" ? "Updated roles" : "Open roles";
}

function renderCategoryOptions(data) {
  const select = $("#category-filter");
  if (!select) return;
  const current = select.value;
  const categories = Array.isArray(data?.filterMeta?.categories) ? data.filterMeta.categories : [];
  select.innerHTML = `<option value="all">All categories</option>${categories.map((category) => `<option value="${escapeHtml(category)}">${escapeHtml(formatCategory(category))}</option>`).join("")}`;
  select.value = categories.includes(current) ? current : "all";
}

function populateLocationFilter(items) {
  const select = $("#location-filter");
  if (!select) return;
  const current = select.value;
  const locations = [...new Set((items || []).flatMap((role) => roleArray(role.location).filter(Boolean)))]
    .toSorted((left, right) => left.localeCompare(right))
    .slice(0, 48);
  select.innerHTML = `<option value="all">Location</option>${locations.map((location) => `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`).join("")}`;
  if (current && current !== "all" && !locations.includes(current)) {
    select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(current)}">${escapeHtml(current)}</option>`);
  }
  select.value = current && [...select.options].some((option) => option.value === current) ? current : "all";
}

function selectedOptionLabel(selector) {
  const select = $(selector);
  return select?.selectedOptions?.[0]?.textContent?.trim() || "";
}

function activeFilterEntries() {
  const entries = [];
  const search = String($("#search-input")?.value || "").trim();
  const category = $("#category-filter")?.value || "all";
  const workMode = $("#work-mode-filter")?.value || "all";
  const seasons = selectedSeasonFilters();
  const location = $("#location-filter")?.value || "all";
  const status = $("#status-filter")?.value || "open";
  if (search) entries.push(["search", `Search: ${search}`]);
  if (category !== "all") entries.push(["category", selectedOptionLabel("#category-filter")]);
  if (workMode !== "all") entries.push(["workMode", selectedOptionLabel("#work-mode-filter")]);
  if (seasons.length) entries.push(["season", `Seasons: ${seasonFilterLabel(seasons)}`]);
  if (location !== "all") entries.push(["location", selectedOptionLabel("#location-filter")]);
  if (status !== "open") entries.push(["status", selectedOptionLabel("#status-filter")]);
  return entries;
}

function renderActiveFilters() {
  const panel = $("#active-filters");
  if (!panel) return;
  const entries = activeFilterEntries();
  panel.hidden = entries.length === 0;
  panel.innerHTML = entries.length
    ? `${entries.map(([filter, label]) => `<button class="active-filter-button" type="button" data-clear-filter="${filter}" aria-label="Remove ${escapeHtml(label)} filter">${escapeHtml(label)}</button>`).join("")}<button class="clear-filters-button" type="button" data-clear-filter="all">Clear all</button>`
    : "";
  $("#more-filters-button")?.classList.toggle("has-active", ($("#status-filter")?.value || "open") !== "open");
}

function clearFilter(name) {
  const filterName = String(name || "");
  if (filterName === "all" || filterName === "search") syncSearchInputs("");
  if ((filterName === "all" || filterName === "category") && $("#category-filter")) $("#category-filter").value = "all";
  if ((filterName === "all" || filterName === "workMode") && $("#work-mode-filter")) $("#work-mode-filter").value = "all";
  if (filterName === "all" || filterName === "season") setSelectedSeasonFilters([]);
  if ((filterName === "all" || filterName === "location") && $("#location-filter")) $("#location-filter").value = "all";
  if ((filterName === "all" || filterName === "status") && $("#status-filter")) $("#status-filter").value = "open";
  handleFilterChange();
}

function watchlistDisplayRoles() {
  const filters = readFilters();
  return pendingVisibleRoles(filterWatchlistRoles(state.watchlistRoles, {
    ...filters,
    workMode: $("#work-mode-filter")?.value || "all",
    seasons: selectedSeasonFilters(),
    location: $("#location-filter")?.value || "all",
  }));
}

function roleListHeading() {
  if (isSavedRoleView()) return "Saved";
  const statusHeading = currentStatusLabel();
  const tabHeading = { canada: "Canada", quant: "Quant", summer: "Summer", internship: "Intern / Internship / Co-op", "non-intern": "Non-intern", main: "All", saved: "Saved" }[state.activeTab];
  if (isMatchesRoleView()) return tabHeading ? `Matches for you · ${tabHeading}` : "Matches for you";
  return tabHeading ? `${statusHeading} · ${tabHeading}` : statusHeading;
}

function roleListCountText() {
  if (isSavedRoleView()) {
    const roles = watchlistDisplayRoles();
    if (!roles.length) return state.watchlistRoles.length ? "No saved roles match these filters." : "Your saved roles will appear here.";
    return `Showing ${formatNumber(roles.length)} saved ${roles.length === 1 ? "role" : "roles"}`;
  }
  const roles = displayRoles();
  const rawTotal = Number(state.pagination.total);
  const total = Number.isSafeInteger(rawTotal) && rawTotal >= 0 ? rawTotal : roles.length;
  const shownCount = Math.min(roles.length, total);
  const streaming = state.loadingMore || (state.draining.size > 0 && canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP));
  const loadingLabel = streaming ? " · loading more" : "";
  if (state.loading) return isMatchesRoleView() ? "Loading your matches…" : "Loading roles…";
  if (!roles.length) return isMatchesRoleView() ? "No matches in this view." : "No roles match these filters.";
  if (isMatchesRoleView()) {
    return total > shownCount
      ? `Showing ${formatNumber(shownCount)} of ${formatNumber(total)} matches${loadingLabel}`
      : `Showing ${formatNumber(shownCount)} ${shownCount === 1 ? "match" : "matches"}`;
  }
  return total > shownCount
    ? `Showing ${formatNumber(shownCount)} of ${formatNumber(total)} roles${loadingLabel}`
    : `Showing ${formatNumber(shownCount)} ${shownCount === 1 ? "role" : "roles"}`;
}

function bindRoleRow(row) {
  row.querySelector("[data-menu-trigger]")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const trigger = event.currentTarget;
    const menu = row.querySelector(".row-menu-popover");
    const open = menu && !menu.hidden;
    closeAllMenus();
    if (menu && !open) {
      menu.hidden = false;
      trigger.setAttribute("aria-expanded", "true");
      state.menuReturnFocus = trigger;
    }
  });
  row.querySelector("[data-toggle-detail]")?.addEventListener("click", () => {
    closeAllMenus();
    openRoleDetail(row);
  });
}

function closeAllMenus({ restoreFocus = false } = {}) {
  document.querySelectorAll(".row-menu-popover").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".menu-popover").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".notification-popover").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll(".user-menu-popover").forEach((menu) => { menu.hidden = true; });
  document.querySelectorAll("[data-menu-trigger][aria-expanded='true'], #more-filters-button[aria-expanded='true'], #saved-views-button[aria-expanded='true'], #notifications-button[aria-expanded='true'], #user-menu-button[aria-expanded='true']")
    .forEach((button) => button.setAttribute("aria-expanded", "false"));
  if (restoreFocus && state.menuReturnFocus?.isConnected) state.menuReturnFocus.focus();
  state.menuReturnFocus = null;
}

function closeRoleDetail({ restoreFocus = true } = {}) {
  const panel = $("#role-detail-panel");
  if (!panel || panel.hidden) return;
  const key = state.selectedRoleKey;
  if (key) state.detailControllers.get(key)?.abort();
  panel.hidden = true;
  panel.removeAttribute("data-listing-key");
  document.querySelectorAll(".job-card.is-selected").forEach((row) => row.classList.remove("is-selected"));
  state.selectedRoleKey = null;
  syncSelectedRoleState();
  if (restoreFocus && state.roleDetailReturnFocus?.isConnected) state.roleDetailReturnFocus.focus();
  state.roleDetailReturnFocus = null;
}

function syncSelectedRoleState() {
  document.querySelectorAll(".job-card[data-listing-key]").forEach((row) => {
    row.classList.toggle("is-selected", row.dataset.listingKey === state.selectedRoleKey);
  });
  document.querySelectorAll("[data-open-role-detail]").forEach((button) => {
    const owner = button.closest("[data-listing-key]");
    button.setAttribute("aria-expanded", String(Boolean(owner && owner.dataset.listingKey === state.selectedRoleKey)));
  });
}

function openRoleDetail(row, trigger = null) {
  const key = row?.dataset?.listingKey;
  const role = state.items.find((item) => roleKey(item) === key);
  const panel = $("#role-detail-panel");
  const summary = $("#role-detail-summary");
  const details = $("#role-detail-content");
  if (!key || !role || !panel || !summary || !details) return;
  const listingType = role.listingType || "internship";
  const listingId = role.listingId || role.id;
  const applyUrl = safeUrl(role.applicationUrl);
  const schedule = roleScheduleLabel(role);
  const applyLink = role.applicationUrl && applyUrl !== "#"
    ? `<a class="job-apply-link" href="${escapeHtml(applyUrl)}" target="_blank" rel="noopener noreferrer">Apply directly</a>`
    : "";
  const roleSignal = isMatchesRoleView()
    ? roleSignalScore(role)
    : null;
  const roleReason = isMatchesRoleView() ? roleSignalReasons(role)[0] : "";
  state.roleDetailReturnFocus = trigger || document.activeElement;
  state.selectedRoleKey = key;
  panel.dataset.listingKey = key;
  summary.innerHTML = `<div class="role-detail-company">${companyLogoHtml(role)}<span>${escapeHtml(role.company)}</span></div>
    <h2 id="role-detail-title">${escapeHtml(role.title)}</h2>
    <div class="role-detail-meta"><span>${escapeHtml(formatLocation(role))}</span><span>${escapeHtml(formatMode(role))}</span>${schedule ? `<span>${escapeHtml(schedule)}</span>` : ""}<span>Posted ${escapeHtml(formatPosted(role.postingDate || role.firstSeenAt || role.discoveredAt))}</span></div>
    ${sponsorshipOfferHtml(role)}
    ${roleSignal ? `<div class="role-detail-match"><strong>${escapeHtml(roleSignal.value)} ${escapeHtml(roleSignal.label)}</strong><span>${escapeHtml(roleReason)}</span></div>` : ""}
    <div class="role-detail-actions">${applyLink}${applicationDraftButtons(role)}${watchlistButton(role)}${listingActionButtons(role, listingType, listingId, role.company, role.title, { compact: true, wrapped: false })}</div>`;
  bindCompanyLogos(summary);
  details.dataset.detailKey = key;
  details.open = true;
  detailContent(details).innerHTML = '<p class="detail-loading" role="status">Loading full role details…</p>';
  panel.hidden = false;
  syncSelectedRoleState();
  setupRoleDetailMotion(panel);
  setTimeout(() => $("#close-role-detail")?.focus(), 0);
  void loadRoleDetails(panel, details);
}

function roleListFooterMarkup() {
  const canLoadMore = canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP);
  const atRenderCap = state.pagination.hasMore && state.items.length >= LIST_RENDER_CAP;
  if (state.loadingMore || (canLoadMore && state.draining.size > 0)) {
    return `<div class="load-more-status" role="status"><p class="sr-only">Loading more roles</p>${jobCardSkeletonMarkup()}</div>`;
  }
  if (atRenderCap) {
    return `<p class="muted load-more-status" role="status">Showing the first ${formatNumber(LIST_RENDER_CAP)} roles. Refine your filters to see more.</p>`;
  }
  return "";
}

function updateRoleListChrome() {
  const heading = $("#results-heading");
  const count = $("#jobs-status");
  if (heading) heading.textContent = roleListHeading();
  const previewStatus = state.showingCachedRoles
    ? state.cachedRolesUnavailable ? "Showing saved listings" : "Updating listings…"
    : "";
  if (count) count.innerHTML = `<span>${escapeHtml(roleListCountText())}${previewStatus ? ` · ${previewStatus}` : ""}</span>`;
  const sentinel = $("#load-more-sentinel");
  if (sentinel) sentinel.innerHTML = roleListFooterMarkup();
  $("#role-list")?.setAttribute("aria-busy", String(state.loading || state.loadingMore));
  bindLoadMoreSentinel();
}

function tableRoles() {
  if (isSavedRoleView()) return watchlistDisplayRoles();
  const featured = featuredRole();
  const featuredKey = featured ? roleKey(featured) : null;
  return displayRoles().filter((role) => roleKey(role) !== featuredKey);
}

function appendRoleCards(roles) {
  const list = $("#role-list");
  if (!list || !roles.length) {
    updateRoleListChrome();
    return;
  }
  const existing = new Set([...list.querySelectorAll(".job-card[data-listing-key]")].map((row) => row.dataset.listingKey));
  const featuredKey = featuredRole() ? roleKey(featuredRole()) : null;
  const toAdd = roles.filter((role) => {
    const key = roleKey(role);
    return key !== featuredKey && !existing.has(key) && displayRoles([role]).length > 0;
  });
  if (!toAdd.length) {
    updateRoleListChrome();
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = toAdd.map(roleRowHtml).join("");
  const rows = [...template.content.querySelectorAll(".job-card[data-listing-key]")];
  rows.forEach(bindRoleRow);
  const empty = list.querySelector(".empty-row, .jobs-loading-row");
  empty?.remove();
  list.append(...rows);
  bindCompanyLogos(list);
  populateLocationFilter(state.items);
  syncSelectedRoleState();
  animateRoleRows(rows);
  updateRoleListChrome();
}

function jobCardSkeletonMarkup() {
  return `<div class="job-card job-card-skeleton" aria-hidden="true">
    <span class="skeleton-logo"></span>
    <div class="job-card-body">
      <span class="skeleton-line skeleton-title"></span>
      <span class="skeleton-line skeleton-company"></span>
      <span class="skeleton-line skeleton-meta"></span>
    </div>
    <div class="job-card-side job-card-side--large">
      <div class="listing-row-actions listing-row-actions--large skeleton-actions">
        <span class="skeleton-action"></span>
        <span class="skeleton-action"></span>
        <span class="skeleton-action"></span>
        <span class="skeleton-action"></span>
      </div>
    </div>
  </div>`;
}

function rolesLoadingMarkup() {
  const label = isMatchesRoleView() ? "Loading your matches" : "Loading roles";
  return `<div class="jobs-loading-row" role="status" aria-live="polite"><p class="sr-only">${label}</p>${jobCardSkeletonMarkup().repeat(5)}</div>`;
}

function rolesEmptyMarkup(title, message, actions = "") {
  return `<div class="empty-row"><div class="empty-state"><h3>${title}</h3><p>${message}</p>${actions ? `<div class="empty-state-actions">${actions}</div>` : ""}</div></div>`;
}

function rolesErrorMarkup(message) {
  return `<div class="empty-row"><div class="empty-state error-state"><h3>Couldn’t load ${isMatchesRoleView() ? "your matches" : "roles"}</h3><p>${escapeHtml(message)}</p><div class="empty-state-actions"><button class="button button-subtle" type="button" data-retry-roles>Retry</button></div></div></div>`;
}

function matchesEmptyMarkup() {
  return rolesEmptyMarkup(
    "No matches yet",
    "Nothing in the current catalog meets your saved preferences right now. Broaden a location, term, or role choice, or keep browsing while new postings arrive.",
    `<a class="button button-subtle" href="/preferences">Edit preferences</a><a class="button button-secondary" href="${escapeHtml(roleViewHref("all"))}">View all internships</a>`
  );
}

function renderRoles({ animate = true } = {}) {
  const list = $("#role-list");
  if (!list) return;
  renderNavigation();
  renderViewChrome();
  renderActiveFilters();
  if (isSavedRoleView()) {
    state.items = pendingVisibleRoles(state.watchlistRoles);
    state.loading = false;
    state.loadingMore = false;
    state.pagination = { limit: state.items.length, offset: 0, total: watchlistDisplayRoles().length, hasMore: false, nextOffset: null };
  }
  if ($("#results-heading")) $("#results-heading").textContent = roleListHeading();
  renderFeatured();
  list.setAttribute("aria-busy", String(state.loading));
  if (state.loading) {
    list.innerHTML = rolesLoadingMarkup();
    updateRoleListChrome();
    return;
  }
  if (state.listError) {
    list.innerHTML = rolesErrorMarkup(state.listError);
    closeRoleDetail({ restoreFocus: false });
    updateRoleListChrome();
    list.setAttribute("aria-busy", "false");
    return;
  }
  const rows = tableRoles();
  populateLocationFilter(state.items);
  if (!rows.length) {
    if (isMatchesRoleView() && !state.items.length && Number(state.pagination.total) === 0) {
      list.innerHTML = matchesEmptyMarkup();
      closeRoleDetail({ restoreFocus: false });
      updateRoleListChrome();
      list.setAttribute("aria-busy", "false");
      return;
    }
    const emptyTitle = isSavedRoleView()
      ? (state.watchlistRoles.length ? "No saved roles match these filters" : "Nothing saved yet")
      : (state.items.length ? "No roles match these local filters" : "No roles match these filters");
    const emptyMessage = isSavedRoleView()
      ? (state.watchlistRoles.length ? "Try clearing a filter or switching the sort to bring saved roles back into view." : "Save a role from the listings to keep it here for later.")
      : (state.items.length ? "Try a broader location, category, or work mode." : "Adjust the filters or wait for the next crawl to bring in new postings.");
    const browseButton = isSavedRoleView() && !state.watchlistRoles.length
      ? '<button class="button button-subtle" type="button" data-discover-roles>Browse roles</button>'
      : "";
    list.innerHTML = rolesEmptyMarkup(emptyTitle, emptyMessage, browseButton);
    closeRoleDetail({ restoreFocus: false });
    updateRoleListChrome();
    list.setAttribute("aria-busy", "false");
    return;
  }
  list.innerHTML = rows.map(roleRowHtml).join("");
  bindCompanyLogos(list);
  list.querySelectorAll(".job-card[data-listing-key]").forEach(bindRoleRow);
  if (state.selectedRoleKey && !state.items.some((role) => roleKey(role) === state.selectedRoleKey)) closeRoleDetail({ restoreFocus: false });
  syncSelectedRoleState();
  updateRoleListChrome();
  refreshRoleMotion({ animateRows: animate });
  maybeDrainRemainingRoles();
  list.setAttribute("aria-busy", "false");
}

function renderCurrentSource(data) {
  const scan = data?.scan || {};
  const active = isScanActive(data);
  const checking = inProgressSources(data);
  const current = checking[0];
  const key = active ? `${scan.runId || data?.latestRun?.id || "active"}:${current?.url || scan.status}` : null;
  if (key !== state.currentSourceTimerKey) {
    state.currentSourceTimerKey = key;
    state.currentSourceTimerStartedAt = active ? Date.now() : null;
  }
  const panels = [...document.querySelectorAll("[data-crawl-current]")];
  if (!panels.length) return;
  document.querySelector(".dashboard-crawl-health")?.classList.toggle("is-active", active);
  const statusLabel = active ? (scan.terminationRequested ? "Terminating" : "Running") : "";
  const elapsedMs = active ? elapsedSince(current?.startedAt || scan.startedAt || state.currentSourceTimerStartedAt) : null;
  const extras = checking.length > 1 ? ` · ${checking.length - 1} other source${checking.length === 2 ? "" : "s"} also in progress` : "";
  const detailText = active
    ? current?.url
      ? `${configuredSourceCount(data)} configured sources${extras}`
      : `${configuredSourceCount(data)} configured sources · waiting for the first source to start.`
    : `${configuredSourceCount(data)} configured sources`;
  panels.forEach((panel) => {
    panel.classList.toggle("active", active);
    const name = panel.querySelector('[data-crawl-field="source-name"]');
    const status = panel.querySelector('[data-crawl-field="source-status"]');
    const elapsed = panel.querySelector('[data-crawl-field="source-elapsed"]');
    const detail = panel.querySelector('[data-crawl-field="source-detail"]');
    if (name) {
      if (active && current?.url) {
        const href = safeUrl(current.url);
        name.innerHTML = `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(current.url)}">${escapeHtml(compactSourceUrl(current.url))}</a>`;
      } else {
        name.textContent = active ? "Starting source crawl…" : "No active source";
      }
    }
    if (status) {
      status.textContent = statusLabel;
      status.className = active ? (scan.terminationRequested ? "status-stop" : "status-run") : "status-idle";
      status.hidden = !active;
    }
    if (elapsed) elapsed.textContent = elapsedMs === null ? "—" : formatDurationMs(elapsedMs);
    if (detail) detail.textContent = detailText;
  });
}

function renderPlanCard(data) {
  const run = data?.latestCompletedRun || (data?.latestRun?.status === "COMPLETED" ? data.latestRun : data?.latestRun);
  const used = Number(run?.pages_visited ?? 0);
  const total = Math.max(used, configuredSourceCount(data) * 100, 1);
  const renewal = $("#plan-renewal");
  const usage = $("#plan-usage");
  const fill = $("#plan-fill");
  if (renewal) {
    const completed = data?.latestCompletedRun || (run?.status === "COMPLETED" ? run : null);
    renewal.textContent = completed?.finished_at || completed?.started_at
      ? `Last crawl ${formatDate(completed.finished_at || completed.started_at)}`
      : "No completed crawl yet";
  }
  if (usage) usage.textContent = `${formatNumber(used)} / ${formatNumber(total)} scans`;
  if (fill) fill.style.width = `${Math.max(4, Math.min(100, Math.round((used / total) * 100)))}%`;
}

function renderCrawlRunSummary(data) {
  const run = data?.latestRun;
  const health = sourceHealthCounts(data);
  const runSettled = Number(run?.sources_settled);
  const runSourceCount = Number(run?.sources_requested);
  const settled = Number.isFinite(runSettled) ? runSettled : health.settled;
  const sourceCount = Number.isFinite(runSourceCount) && runSourceCount >= 0 ? runSourceCount : health.sourceCount;
  const duration = run ? runDurationMs(run) : null;
  const values = run
    ? [
        ["Sources settled", `${Number.isFinite(settled) ? settled : 0}/${sourceCount}`],
        ["Pages visited", formatNumber(run.pages_visited ?? 0)],
        ["Postings inspected", formatNumber(run.potential_postings_inspected ?? 0)],
        ["Roles crawled", formatNumber(run.internships_discovered ?? 0)],
        ["Run duration", duration === null ? "—" : compactDuration(duration)],
      ]
    : [];
  const markup = values.length
    ? values.map(([label, value]) => {
      const live = label === "Roles crawled";
      return `<div class="run-stat${live ? " run-stat-live" : ""}"${live ? ' data-crawl-live="roles" title="Updates while the current crawl is running"' : ""}><strong${live ? ' aria-live="polite" aria-atomic="true"' : ""}>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`;
    }).join("")
    : `<div class="empty-state">No crawl data yet.</div>`;
  document.querySelectorAll("[data-crawl-run-summary]").forEach((summary) => {
    summary.innerHTML = markup;
  });
}

function compactDashboardProgress(progress) {
  return String(progress || "")
    .replace("All configured sources checked", "All sources checked")
    .replace(" sources settled", " settled")
    .replace(" pages visited", " pages");
}

function renderRunHealth(data) {
  const run = data?.latestRun;
  const scan = data?.scan || {};
  const active = isScanActive(data);
  const terminated = run?.status === "FAILED" && /terminated by user/i.test(run.error_message || scan.error || "");
  const staleRunning = !active && run?.status === "RUNNING";
  const status = terminated ? "cancelled" : String(staleRunning ? scan.status || "IDLE" : run?.status || scan.status || "unknown").toLowerCase();
  document.querySelectorAll('[data-crawl-field="run-status"]').forEach((runStatus) => {
    runStatus.className = `status-pill ${status}`;
    runStatus.textContent = run ? `${terminated ? "TERMINATED" : staleRunning ? "IDLE" : run.status} · #${run.id}` : String(scan.status || "No runs");
  });
  const completed = data?.latestCompletedRun || (run?.status === "COMPLETED" ? run : null);
  setCrawlField("last-crawl", completed ? relativeDate(completed.finished_at || completed.started_at) : "—");
  const health = sourceHealthCounts(data);
  const progress = crawlProgressMessage(data);
  renderCrawlHealthSummary(data, health);
  document.querySelectorAll('[data-crawl-field="progress"]').forEach((progressNode) => {
    const compact = Boolean(progressNode.closest(".dashboard-crawl-health"));
    progressNode.textContent = compact ? compactDashboardProgress(progress) : progress;
    if (compact) {
      progressNode.title = progress;
      progressNode.setAttribute("aria-label", progress);
    }
    progressNode.classList.toggle("scanning", active);
    progressNode.classList.toggle("failed", !active && /failed/i.test(progress));
  });
  document.querySelectorAll('[data-crawl-field="source-status"]').forEach((sourceStatus) => {
    const requested = active && Boolean(scan.terminationRequested || run?.cancel_requested_at);
    sourceStatus.textContent = active ? (requested ? "Terminating" : "Running") : "";
    sourceStatus.className = active ? (requested ? "status-stop" : "status-run") : "status-idle";
    sourceStatus.hidden = !active;
  });
  renderCrawlRunSummary(data);
  const runs = recentRuns(data, state.runLimit);
  $("#recent-runs").innerHTML = runs.length
    ? runs.map((item) => recentRunRowHtml(item, { staleRunning: staleRunning && item.id === run.id })).join("")
    : `<div class="empty-state">No crawl data yet.</div>`;
  const runHistoryButton = $("#view-all-runs");
  if (runHistoryButton) {
    const expanded = state.runLimit > RECENT_RUN_LIMIT;
    runHistoryButton.textContent = expanded ? "Show recent" : "View all";
    runHistoryButton.setAttribute("aria-expanded", String(expanded));
    runHistoryButton.hidden = state.runHistory !== null && state.runHistory.length <= RECENT_RUN_LIMIT;
  }
  renderPlanCard(data);
}

function renderSourceMarquee(data) {
  const root = $("#source-marquee");
  const track = $("#source-marquee-track");
  const toggle = $("#source-marquee-toggle");
  if (!root || !track) return;
  const active = isScanActive(data);
  const rows = provenanceSourceRows(data).slice(0, 9);
  if (!active) state.sourceMarqueePaused = false;
  const canAnimate = Boolean(motionRuntime()) && !reducedMotionPreferred() && active && rows.length >= 2;
  if (toggle) {
    toggle.hidden = !canAnimate;
    toggle.textContent = state.sourceMarqueePaused ? "Resume activity" : "Pause activity";
    toggle.setAttribute("aria-pressed", String(state.sourceMarqueePaused));
  }
  const marqueeKey = `${active}:${rows.map((row) => `${row.url}:${row.status}`).join("|")}`;
  root.classList.toggle("is-running", canAnimate && !state.sourceMarqueePaused);
  root.classList.toggle("is-paused", state.sourceMarqueePaused);
  if (marqueeKey === state.sourceMarqueeKey) {
    state.sourceMarqueeTween?.paused?.(state.sourceMarqueePaused);
    return;
  }
  state.sourceMarqueeKey = marqueeKey;
  state.sourceMarqueeTween?.kill?.();
  state.sourceMarqueeTween = null;
  const health = sourceHealthCounts(data);
  const items = active && rows.length
    ? rows.map((row) => `<span class="source-marquee-item ${escapeHtml(row.status || "unchecked")}">${escapeHtml(compactSourceUrl(row.url, 34))} · ${escapeHtml(row.status || "unchecked")}</span>`)
    : [
        `<span class="source-marquee-item success">${escapeHtml(formatNumber(health.success))} healthy sources</span>`,
        `<span class="source-marquee-item${health.failed ? " failed" : ""}">${escapeHtml(formatNumber(health.failed))} failed</span>`,
        `<span class="source-marquee-item">${escapeHtml(formatNumber(health.unchecked))} unchecked</span>`,
      ];
  track.innerHTML = (active ? [...items, ...items] : items).join("");
  const gsap = motionRuntime();
  if (!gsap || reducedMotionPreferred() || !active || rows.length < 2) {
    if (gsap) gsap.set(track, { xPercent: 0 });
    return;
  }
  gsap.set(track, { xPercent: 0 });
  state.sourceMarqueeTween = gsap.to(track, { xPercent: -50, duration: Math.max(24, rows.length * 4.5), ease: "none", repeat: -1 });
  state.sourceMarqueeTween.paused(state.sourceMarqueePaused);
}

function toggleSourceMarquee() {
  if (!state.sourceMarqueeTween) return;
  state.sourceMarqueePaused = !state.sourceMarqueePaused;
  state.sourceMarqueeTween.paused(state.sourceMarqueePaused);
  const root = $("#source-marquee");
  root?.classList.toggle("is-running", !state.sourceMarqueePaused);
  root?.classList.toggle("is-paused", state.sourceMarqueePaused);
  const toggle = $("#source-marquee-toggle");
  if (toggle) {
    toggle.textContent = state.sourceMarqueePaused ? "Resume activity" : "Pause activity";
    toggle.setAttribute("aria-pressed", String(state.sourceMarqueePaused));
  }
}

function renderSources(data) {
  const scan = data?.scan || {};
  const health = sourceHealthCounts(data);
  const counts = [`${health.success} success`];
  if (health.partial > 0) counts.push(`${health.partial} partial`);
  counts.push(`${health.failed} failed`, `${health.unchecked} unchecked`);
  $("#source-count").textContent = counts.join(" · ");
  const board = data?.board;
  const boardLabel = board?.status ? `Live board: ${String(board.status).toLowerCase()}` : "Live board status follows the change stream.";
  const list = $("#source-list");
  list.classList.toggle("expanded", state.sourcesExpanded);
  list.innerHTML = health.rows.length
    ? health.rows.map(sourceRowHtml).join("")
    : `<div class="empty-state">${escapeHtml(isScanActive(data) ? "Waiting for the first source to start." : boardLabel)}</div>`;
  const hasFailureWindow = Array.isArray(data?.failures24h);
  const failures = hasFailureWindow ? data.failures24h : Array.isArray(data?.failures) ? data.failures : [];
  const failureWindow = $("#failure-window");
  if (failureWindow) failureWindow.textContent = hasFailureWindow
    ? `${formatNumber(failures.length)} ${failures.length === 1 ? "error" : "errors"} · Past 24 hours`
    : "Latest run";
  const runFailed = data?.latestRun?.status === "FAILED" || scan.status === "FAILED";
  const runError = scan.error || data?.latestRun?.error_message || "";
  const terminated = runFailed && /terminated by user/i.test(runError);
  const scanFailure = runFailed && !terminated ? (runError || "Run failed") : "";
  if (failures.length) {
    $("#failure-list").innerHTML = failures.map(failureRowHtml).join("");
  } else if (scanFailure) {
    $("#failure-list").innerHTML = `<div class="failure-row" role="listitem"><strong>Latest run</strong><p>${escapeHtml(scanFailure)}</p></div>`;
  } else if (terminated) {
    $("#failure-list").innerHTML = `<div class="empty-state">Crawl stopped by you. Results from settled sources were kept.</div>`;
  } else {
    $("#failure-list").innerHTML = `<div class="empty-state">${hasFailureWindow ? "No errors recorded in the past 24 hours." : "No failures reported for this run."}</div>`;
  }
  const recovery = $("#failure-recovery");
  if (recovery) recovery.hidden = !(failures.length || scanFailure);
  renderSourceMarquee(data);
}

function renderChrome(data) {
  syncNotifications(data);
  renderNavigation();
  renderViewChrome();
  renderCrawlStatistics(data);
  renderRunHealth(data);
  renderCurrentSource(data);
  renderSources(data);
  renderCategoryOptions(data);
  renderRoleTabs(data);
  if (state.activeView === "settings") renderSettings();
  if (data?.generatedAt && $("#last-refresh")) $("#last-refresh").textContent = formatDate(data.generatedAt, true);
  if ($("#connection-label")) $("#connection-label").textContent = state.scanning || scanIsActive(data) ? "Checking sources" : "Live";
  updateScanButton();
  if (state.activeView === "applications") renderApplications();
}

function scanIsActive(data = state.data) {
  return isScanActive(data);
}

function updateScanButton() {
  const button = $("#refresh-button");
  const terminateButton = $("#terminate-button");
  const quickButton = $("#quick-refresh-button");
  const quickTerminateButton = $("#quick-terminate-button");
  const pulse = $("#workspace-pulse-dot");
  const connection = $("#connection-label");
  const uiState = scanUiState(state.data, state.scanning);
  const active = !uiState.refreshEnabled;
  const terminated = !uiState.active && /terminated by user/i.test(state.data?.scan?.error || state.data?.latestRun?.error_message || "");
  const requested = uiState.active && Boolean(state.data?.scan?.terminationRequested || state.data?.latestRun?.cancel_requested_at);
  if (button) {
    button.hidden = uiState.terminateVisible;
    button.disabled = active;
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 6.8v10.4L18.2 12 8 6.8Z"/></svg> Crawl Now`;
  }
  if (terminateButton) {
    terminateButton.hidden = !uiState.terminateVisible;
    terminateButton.disabled = state.terminating || requested;
    terminateButton.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6.5" y="6.5" width="11" height="11" rx="1.2"/></svg> ${state.terminating || requested ? "Terminating…" : "Terminate Crawl"}`;
  }
  if (quickButton) {
    quickButton.hidden = uiState.terminateVisible;
    quickButton.disabled = active;
    quickButton.textContent = active ? "Starting…" : "Run crawl";
  }
  if (quickTerminateButton) {
    quickTerminateButton.hidden = !uiState.terminateVisible;
    quickTerminateButton.disabled = state.terminating || requested;
    quickTerminateButton.textContent = state.terminating || requested ? "Stopping…" : "Stop crawl";
  }
  pulse?.classList.toggle("is-active", uiState.active);
  pulse?.classList.toggle("is-failed", !terminated && !uiState.active && String(state.data?.scan?.status || state.data?.latestRun?.status || "").toUpperCase() === "FAILED");
  if (connection) {
    const failed = String(state.data?.scan?.status || "").toUpperCase() === "FAILED";
    connection.textContent = requested || state.terminating ? "Stopping crawl" : uiState.active ? "Crawling sources" : terminated ? "Crawl stopped" : failed ? "Crawl needs attention" : "Ready";
    if (state.showingCachedRoles) connection.textContent = state.cachedRolesUnavailable ? "Showing saved listings" : "Updating listings…";
  }
}

let toastTimer = null;

function showToast(message, action = null) {
  const toast = $("#toast");
  if (!toast) return;
  const messageNode = $("#toast-message");
  const actionButton = $("#toast-action");
  if (messageNode) messageNode.textContent = message;
  else toast.textContent = message;
  if (actionButton) {
    actionButton.hidden = !action?.label || typeof action?.onClick !== "function";
    actionButton.textContent = action?.label || "";
    actionButton.onclick = actionButton.hidden ? null : () => {
      toast.classList.remove("visible");
      action.onClick();
    };
  }
  toast.classList.add("visible");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("visible"), actionButton?.hidden === false ? 6_000 : 2_600);
}

let addSourceDialogLastFocus = null;

function openAddSourceDialog() {
  const dialog = $("#add-source-dialog");
  const input = $("#source-url-input");
  if (!dialog || dialog.open) return;
  addSourceDialogLastFocus = document.activeElement instanceof Element ? document.activeElement : null;
  const error = $("#source-url-error");
  if (error) {
    error.hidden = true;
    error.textContent = "";
  }
  input?.removeAttribute("aria-invalid");
  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
  if (input) {
    input.value = "";
    setTimeout(() => input.focus(), 0);
  }
}

function closeAddSourceDialog() {
  const dialog = $("#add-source-dialog");
  if (!dialog) return;
  if (dialog.open && typeof dialog.close === "function") dialog.close();
  else dialog.removeAttribute("open");
  if (addSourceDialogLastFocus && typeof addSourceDialogLastFocus.focus === "function") addSourceDialogLastFocus.focus();
  addSourceDialogLastFocus = null;
}

async function submitAddSource(event) {
  event.preventDefault();
  const form = $("#add-source-form");
  const input = $("#source-url-input");
  const submit = $("#submit-add-source");
  const errorNode = $("#source-url-error");
  if (!form || !input || !submit || !input.reportValidity()) return;
  const url = input.value.trim();
  const hadDashboardState = Boolean(state.data);
  submit.disabled = true;
  submit.textContent = "Adding…";
  form.setAttribute("aria-busy", "true");
  input.removeAttribute("aria-invalid");
  if (errorNode) {
    errorNode.hidden = true;
    errorNode.textContent = "";
  }
  try {
    const response = await fetch("/api/sources", {
      method: "POST",
      cache: "no-store",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
    const payload = await readJsonResponse(response);
    state.changesEtag = null;
    if (payload.scan) state.data = { ...(state.data || {}), scan: payload.scan };
    await syncChanges({ force: true });
    // A dashboard started before its first database existed can render an
    // unavailable placeholder. Adding the first source creates that database;
    // load the first real role page now instead of waiting for a full reload.
    if (!hadDashboardState) await ensureRolesLoaded(state.intentRevision, { silent: true });
    state.scanning = Boolean(payload.started || payload.queued || scanIsActive());
    updateScanButton();
    closeAddSourceDialog();
    const sourceUrl = payload.source?.url || url;
    const sourceLabel = compactSourceUrl(sourceUrl, 42);
    if (payload.started) showToast(`Added ${sourceLabel} · crawl started`);
    else if (payload.queued) showToast(`Added ${sourceLabel} · queued after this crawl`);
    else if (payload.source?.created === false) showToast(`${sourceLabel} is already configured`);
    else showToast(`Added ${sourceLabel} · run Crawl Now to check it`);
  } catch (error) {
    const message = error?.message || "Could not add source";
    input.setAttribute("aria-invalid", "true");
    if (errorNode) {
      errorNode.textContent = message;
      errorNode.hidden = false;
    }
    input.focus();
    showToast(message);
  } finally {
    form.setAttribute("aria-busy", "false");
    submit.disabled = false;
    submit.textContent = "Add & crawl";
  }
}

function abortDetailRequests() {
  for (const controller of state.detailControllers.values()) controller.abort();
  state.detailControllers.clear();
}

function invalidateRoleListingState() {
  closeRoleDetail({ restoreFocus: false });
  state.roleCacheRevision += 1;
  state.requestRevision += 1;
  state.listController?.abort();
  state.listController = null;
  state.loadMoreObserver?.disconnect();
  state.loadMoreObserver = null;
  abortDetailRequests();
  invalidateRoleListingCaches(state.tabSnapshots, state.detailCache);
}

function invalidateForIntent() {
  closeRoleDetail({ restoreFocus: false });
  state.intentRevision += 1;
  state.requestRevision += 1;
  state.loading = false;
  state.loadingMore = false;
  state.listError = null;
  state.listController?.abort();
  state.listController = null;
  state.loadMoreObserver?.disconnect();
  state.loadMoreObserver = null;
  abortDetailRequests();
}

function readFilters() {
  return {
    view: state.roleView,
    tab: state.activeTab,
    status: $("#status-filter")?.value || "open",
    search: $("#search-input")?.value || "",
    category: $("#category-filter")?.value || "all",
    workMode: $("#work-mode-filter")?.value || "all",
    seasons: selectedSeasonFilters(),
    location: $("#location-filter")?.value || "all",
    sort: $("#sort-filter")?.value || DEFAULT_ROLE_SORT,
  };
}

function syncUiStateToUrl({ push = false, hash } = {}) {
  if (typeof window === "undefined" || typeof history === "undefined") return;
  const url = new URL(window.location.href);
  if (hash !== undefined) url.hash = hash;
  const params = url.searchParams;
  const roleFilters = {
    view: state.roleView,
    tab: state.activeTab,
    status: $("#status-filter")?.value || "open",
    sort: $("#sort-filter")?.value || DEFAULT_ROLE_SORT,
    category: $("#category-filter")?.value || "all",
    workMode: $("#work-mode-filter")?.value || "all",
    location: $("#location-filter")?.value || "all",
    q: String($("#search-input")?.value || "").trim(),
  };
  for (const [key, value] of Object.entries(roleFilters)) {
    if (value && !(["category", "workMode", "location"].includes(key) && value === "all")) params.set(key, value);
    else params.delete(key);
  }
  params.delete("season");
  params.delete("seasons");
  const selectedSeasons = selectedSeasonFilters();
  if (selectedSeasons.length > 0) {
    selectedSeasons.forEach((season) => params.append("season", season));
  } else {
    params.set("season", "all");
  }
  const applicationStage = state.applicationStageFilter || "all";
  const applicationQuery = String(state.applicationSearch || "").trim();
  if (applicationStage !== "all") params.set("applicationStage", applicationStage);
  else params.delete("applicationStage");
  params.delete("applicationStatus");
  if (applicationQuery) params.set("applicationQ", applicationQuery);
  else params.delete("applicationQ");
  const method = push ? "pushState" : "replaceState";
  history[method](history.state, "", `${url.pathname}${url.search}${url.hash}`);
}

function restoreUiStateFromUrl() {
  if (typeof window === "undefined") return;
  const urlState = readRoleUrlState(window.location.href);
  const params = new URLSearchParams(window.location.search);
  state.roleView = urlState.view;
  const tab = params.get("tab");
  const status = params.get("status");
  const sort = params.get("sort");
  const category = params.get("category");
  const workMode = urlState.workMode;
  const location = urlState.location;
  const query = urlState.search;
  if (ROLE_TABS.includes(tab)) state.activeTab = tab;
  if (SETTINGS_STATUS_VALUES.has(status) && $("#status-filter")) $("#status-filter").value = status;
  if (SETTINGS_SORT_VALUES.has(sort) && $("#sort-filter")) $("#sort-filter").value = sort;
  if (category && $("#category-filter")) {
    const select = $("#category-filter");
    if (![...select.options].some((option) => option.value === category)) {
      select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(category)}">${escapeHtml(formatCategory(category))}</option>`);
    }
    select.value = category;
  }
  if (ROLE_WORK_MODES.includes(workMode) && $("#work-mode-filter")) $("#work-mode-filter").value = workMode;
  setSelectedSeasonFilters(urlState.seasons);
  if (location && $("#location-filter")) {
    const select = $("#location-filter");
    if (![...select.options].some((option) => option.value === location)) {
      select.insertAdjacentHTML("beforeend", `<option value="${escapeHtml(location)}">${escapeHtml(location)}</option>`);
    }
    select.value = location;
  }
  syncSearchInputs(query);
  const applicationStage = params.get("applicationStage");
  const legacyApplicationStatus = params.get("applicationStatus");
  const restoredApplicationStage = applicationStage || LEGACY_APPLICATION_STAGE_MAP.get(legacyApplicationStatus) || "all";
  state.applicationStageFilter = APPLICATION_STAGE_VALUES.has(restoredApplicationStage) ? restoredApplicationStage : "all";
  state.applicationSearch = params.get("applicationQ") || "";
  const applicationSearch = $("#applications-search-input");
  const applicationFilter = $("#applications-stage-filter");
  if (applicationSearch) applicationSearch.value = state.applicationSearch;
  if (applicationFilter) applicationFilter.value = state.applicationStageFilter;
  renderActiveFilters();
}

function rolesPath(filters, offset = 0, limit = INITIAL_PAGE_SIZE) {
  return `/api/roles?${buildRolesQuery({ ...filters, limit, offset }).toString()}`;
}

async function readJsonResponse(response) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    payload = {};
  }
  if (!response.ok) throw new Error(payload?.error?.message || payload?.error || `Request failed (${response.status})`);
  return payload;
}

function applyRolesPayload(payload, pageItems, append, expectedIntent, expectedRoleCacheRevision = state.roleCacheRevision) {
  if (!isCurrentIntent(expectedIntent, state.intentRevision) || expectedRoleCacheRevision !== state.roleCacheRevision) return false;
  const previousVersion = state.version;
  state.showingCachedRoles = false;
  state.cachedRolesUnavailable = false;
  state.version = payload.version || state.version;
  state.statusVersion = state.version;
  state.rolesContentVersion = payload.contentVersion || null;
  const pagination = payload.pagination || {
    limit: INITIAL_PAGE_SIZE,
    offset: append ? state.pagination.offset : 0,
    total: pageItems.length,
    hasMore: false,
    nextOffset: null,
  };
  const total = Number(pagination.total);
  const renderLimit = Number.isSafeInteger(total) && total >= 0
    ? Math.min(LIST_RENDER_CAP, total)
    : LIST_RENDER_CAP;
  const mergedItems = append
    ? mergeRolePage(state.items, pageItems, renderLimit)
    : mergeRolePage([], pageItems, renderLimit);
  syncWatchlistRoles(pageItems);
  state.items = pendingVisibleRoles(mergedItems);
  state.pagination = normalizeRolePagination(pagination, state.items.length, pageItems.length);
  if (previousVersion && state.version !== previousVersion) {
    abortDetailRequests();
    state.detailCache.clear();
  }
  const latestRun = payload.latestRun !== undefined ? payload.latestRun : (state.data?.latestRun || null);
  const incomingRuns = Array.isArray(payload.runs) ? payload.runs : (state.data?.runs || (latestRun ? [latestRun] : []));
  const runs = rememberRunHistory(incomingRuns);
  const hydrated = applyRememberedSourceHealth({ ...payload, latestRun, scan: payload.scan || state.data?.scan || {} }, state.data);
  state.data = { ...(state.data || {}), ...hydrated, items: state.items, internships: state.items, latestRun, latestCompletedRun: payload.latestCompletedRun || (latestRun?.status === "COMPLETED" ? latestRun : state.data?.latestCompletedRun || null), runs, scan: hydrated.scan || payload.scan || state.data?.scan || {} };
  rememberTabSnapshot(state.tabSnapshots, roleFiltersKey(readFilters()), {
    items: state.items,
    pagination: state.pagination,
    version: state.version,
  });
  renderChrome(state.data);
  if (!append) rememberListingSnapshot(roleFiltersKey(readFilters()), { ...payload, items: state.items });
  return true;
}

export async function fetchRolesPage(filters, offset, limit, signal) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const response = await fetch(rolesPath(filters, offset, limit), { cache: "no-store", signal });
      return await readJsonResponse(response);
    } catch (error) {
      const delay = ROLE_SNAPSHOT_RETRY_DELAYS_MS[attempt];
      if (!isTransientDashboardReadError(error) || delay === undefined || signal?.aborted) throw error;
      await wait(delay);
    }
  }
}

async function loadRoles({ append = false, expectedIntent = state.intentRevision, silent = false, limit, background = false, skipMotion = false } = {}) {
  if (state.activeTab === SAVED_ROLE_TAB) return null;
  if (!isCurrentIntent(expectedIntent, state.intentRevision)) return null;
  const roleCacheRevision = state.roleCacheRevision;
  const offset = append ? (state.pagination.nextOffset ?? state.items.length) : 0;
  if (append && (!canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP) || state.loadingMore)) return null;
  const requestedLimit = limit ?? (append ? BACKGROUND_PAGE_SIZE : adaptiveListLimit(state.items.length));
  const requestLimit = append
    ? remainingRolePageSize(state.pagination, offset, requestedLimit)
    : requestedLimit;
  if (append && requestLimit < 1) {
    state.pagination = normalizeRolePagination({ ...state.pagination, hasMore: false, nextOffset: null }, state.items.length, 0);
    updateRoleListChrome();
    return null;
  }
  const requestRevision = ++state.requestRevision;
  state.listController?.abort();
  const controller = new AbortController();
  state.listController = controller;
  state.loading = !append && !silent;
  if (!append) state.listError = null;
  // Background pages still flip loadingMore so the count label advertises the
  // ongoing stream; only the failure toast is suppressed (see background).
  state.loadingMore = append && (!silent || background);
  const previousLength = state.items.length;
  const previousHeadKey = state.items[0]
    ? listingKey(state.items[0].listingType || "internship", state.items[0].listingId || state.items[0].id)
    : null;
  if (append && previousLength) updateRoleListChrome();
  let requestFailed = false;
  let applied = false;
  try {
    const payload = await fetchRolesPage(readFilters(), offset, requestLimit, controller.signal);
    if (requestRevision !== state.requestRevision
      || !isCurrentIntent(expectedIntent, state.intentRevision)
      || roleCacheRevision !== state.roleCacheRevision) return null;
    if (append && payload.contentVersion && state.rolesContentVersion
      && payload.contentVersion !== state.rolesContentVersion) {
      // Offset pages from a changed sort order cannot update the old head of the list.
      invalidateRoleListingState();
      return await ensureRolesLoaded(expectedIntent, { silent: true, skipMotion: true });
    }
    const rawPageItems = Array.isArray(payload.items) ? payload.items : [];
    const responseTotal = Number(payload.pagination?.total);
    const responseOffset = Number(payload.pagination?.offset ?? offset);
    const pageItems = Number.isSafeInteger(responseTotal) && responseTotal >= 0
      && Number.isSafeInteger(responseOffset) && responseOffset >= 0
      ? rawPageItems.slice(0, Math.max(0, responseTotal - responseOffset))
      : rawPageItems;
    applied = applyRolesPayload(payload, pageItems, append, expectedIntent, roleCacheRevision);
    return applied ? payload : null;
  } catch (error) {
    if (error?.name === "AbortError" || requestRevision !== state.requestRevision || !isCurrentIntent(expectedIntent, state.intentRevision)) return null;
    // Action reconciliation is deliberately quiet. A one-time snapshot race
    // must not replace a usable feed with the raw 503 after the action itself
    // has already succeeded; the next poll or a later retry will reconcile it.
    if (silent && state.data && isTransientDashboardReadError(error)) return null;
    requestFailed = true;
    if (state.items.length && !append) {
      // Keep a usable preview on screen through provider/network failures.
      // The next visible poll retries the live head without mixing old offsets.
      state.showingCachedRoles = true;
      state.cachedRolesUnavailable = true;
      if ($("#connection-label")) $("#connection-label").textContent = "Showing saved listings";
      updateRoleListChrome();
      return null;
    }
    state.listError = error?.message || "Could not load roles";
    if ($("#connection-label")) $("#connection-label").textContent = "Unavailable";
    if (!append && $("#role-list")) $("#role-list").innerHTML = rolesErrorMarkup(state.listError);
    else if (!background) showToast(error?.message || "Could not finish loading roles");
    return null;
  } finally {
    const settled = settleListRequest(requestRevision, state.requestRevision, { append, failed: requestFailed });
    if (settled.current) {
      state.loading = settled.loading;
      state.loadingMore = settled.loadingMore;
      state.listController = null;
      if (append && applied && state.data) {
        const nextHeadKey = state.items[0]
          ? listingKey(state.items[0].listingType || "internship", state.items[0].listingId || state.items[0].id)
          : null;
        if (previousHeadKey && nextHeadKey && previousHeadKey !== nextHeadKey) {
          renderRoles({ animate: !skipMotion });
        } else {
          const added = state.items.slice(previousLength);
          if (added.length) appendRoleCards(added);
          else updateRoleListChrome();
        }
      } else if (settled.render && state.data) {
        renderRoles({ animate: !skipMotion });
      } else if (append) {
        updateRoleListChrome();
      }
    }
  }
}

// Streams every remaining page of the current tab into the list while the user
// stays on it. Stops on tab/filter changes, repeated failures, or the render cap.
async function drainRemainingRoles(expectedIntent = state.intentRevision) {
  if (state.draining.has(expectedIntent)) return;
  state.draining.add(expectedIntent);
  try {
    let failures = 0;
    while (isCurrentIntent(expectedIntent, state.intentRevision)) {
      while (state.loadingMore && isCurrentIntent(expectedIntent, state.intentRevision)) await wait(32);
      if (!isCurrentIntent(expectedIntent, state.intentRevision) || !canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP)) break;
      const previousOffset = state.pagination.nextOffset;
      const payload = await loadRoles({ append: true, expectedIntent, silent: true, background: true });
      if (!isCurrentIntent(expectedIntent, state.intentRevision)) break;
      if (!payload) {
        failures += 1;
        if (failures >= 3) break;
        await wait(200);
        continue;
      }
      failures = 0;
      const nextOffset = state.pagination.nextOffset;
      if (nextOffset !== null && previousOffset !== null && Number(nextOffset) <= Number(previousOffset)) break;
      if (state.prefetching && prefetchLookaheadReady(state.items.length, state.pagination)) {
        await wait(32);
      }
    }
  } finally {
    state.draining.delete(expectedIntent);
  }
}

function bindLoadMoreSentinel(expectedIntent = state.intentRevision) {
  const sentinel = $("#load-more-sentinel");
  const root = $("#jobs-scroll");
  const canLoadMore = canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP);
  state.loadMoreObserver?.disconnect();
  state.loadMoreObserver = null;
  if (state.loading || !canLoadMore) return;
  if (typeof IntersectionObserver !== "function" || !sentinel || !root) {
    void drainRemainingRoles(expectedIntent);
    return;
  }
  state.loadMoreObserver = new IntersectionObserver((entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    if (!isCurrentIntent(expectedIntent, state.intentRevision)) return;
    if (state.loading || state.loadingMore) return;
    if (!canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP)) return;
    void loadRoles({ append: true, expectedIntent, silent: true, background: true });
  }, { root, rootMargin: "360px 0px" });
  state.loadMoreObserver.observe(sentinel);
}

function maybeDrainRemainingRoles(expectedIntent = state.intentRevision) {
  bindLoadMoreSentinel(expectedIntent);
}

async function ensureRolesLoaded(expectedIntent = state.intentRevision, options = {}) {
  const payload = await loadRoles({ expectedIntent, ...options });
  if (payload) maybeDrainRemainingRoles(expectedIntent);
  return payload;
}

function restoreListingSnapshot() {
  if (state.roleView !== "all" || isSavedRoleView()) return false;
  const snapshot = readListingSnapshot(roleFiltersKey(readFilters()));
  if (!snapshot) return false;
  state.items = pendingVisibleRoles(snapshot.items);
  state.pagination = snapshot.pagination;
  state.loading = false;
  state.loadingMore = false;
  state.listError = null;
  state.showingCachedRoles = true;
  state.cachedRolesUnavailable = false;
  state.rolesContentVersion = null;
  // No cached version, account counts, or status: the server remains the
  // authority, and this preview cannot suppress a live content refresh.
  if (!state.data) state.data = { items: state.items, internships: state.items };
  renderRoles({ animate: false });
  updateScanButton();
  return true;
}

async function loadInitialRoles() {
  const initialIntent = state.intentRevision;
  const savedInitialView = state.activeTab === SAVED_ROLE_TAB || state.activeView === "watchlist";
  if (savedInitialView) state.activeTab = INITIAL_ROLE_TAB;
  const restored = !savedInitialView && restoreListingSnapshot();
  const initialPayload = await ensureRolesLoaded(initialIntent, { silent: restored, skipMotion: restored });
  if (savedInitialView) {
    state.activeTab = SAVED_ROLE_TAB;
    state.items = pendingVisibleRoles(state.watchlistRoles);
    state.pagination = { limit: state.items.length, offset: 0, total: watchlistDisplayRoles().length, hasMore: false, nextOffset: null };
    state.loading = false;
    state.loadingMore = false;
    if (state.data) renderChrome(state.data);
    renderRoles();
    return initialPayload;
  }
  if (!initialPayload
    || state.intentRevision !== initialIntent
    || state.activeTab !== INITIAL_ROLE_TAB
    || FALLBACK_ROLE_TAB === INITIAL_ROLE_TAB
    || !shouldFallbackToCanada(initialPayload)) {
    return initialPayload;
  }

  state.activeTab = FALLBACK_ROLE_TAB;
  invalidateForIntent();
  state.items = [];
  state.pagination = freshPagination();
  state.loading = true;
  if (state.data) renderChrome(state.data);
  renderRoles();
  return ensureRolesLoaded(state.intentRevision);
}

function pendingVisibleRoles(items) {
  return filterListingRoles(items, new Set([
    ...state.pendingActions,
    ...state.optimisticallyHiddenListings,
  ]));
}

async function prefetchRoleTabSnapshot(
  filters,
  expectedRoleCacheRevision = state.roleCacheRevision,
  expectedVersion = state.version,
) {
  if (expectedRoleCacheRevision !== state.roleCacheRevision
    || (expectedVersion && state.version !== expectedVersion)) return;
  const key = roleFiltersKey(filters);
  let snapshot = state.tabSnapshots.get(key);
  if (shouldPrefetchRoleTab(snapshot, state.version)) {
    const payload = await fetchRolesPage(filters, 0, PREFETCH_PAGE_SIZE);
    if (expectedRoleCacheRevision !== state.roleCacheRevision
      || (expectedVersion && state.version !== expectedVersion)) return;
    const nextSnapshot = {
      items: pendingVisibleRoles(payload.items),
      pagination: payload.pagination || freshPagination(),
      version: payload.version || state.version,
    };
    if (shouldReplaceTabSnapshot(state.tabSnapshots.get(key), nextSnapshot)) {
      rememberTabSnapshot(state.tabSnapshots, key, nextSnapshot);
      rememberListingSnapshot(key, payload);
    }
  }
  snapshot = state.tabSnapshots.get(key);
  if (expectedRoleCacheRevision !== state.roleCacheRevision
    || (expectedVersion && state.version !== expectedVersion)) return;
  if (!shouldPrefetchTabLookahead(snapshot, state.version)) return;
  while (state.loadingMore) await wait(32);
  if (expectedRoleCacheRevision !== state.roleCacheRevision
    || (expectedVersion && state.version !== expectedVersion)) return;
  const offset = snapshot.pagination?.nextOffset ?? snapshot.items.length;
  const payload = await fetchRolesPage(filters, offset, PREFETCH_PAGE_SIZE);
  if (expectedRoleCacheRevision !== state.roleCacheRevision
    || (expectedVersion && state.version !== expectedVersion)) return;
  const nextSnapshot = {
    items: mergeRolePage(snapshot.items, pendingVisibleRoles(payload.items)),
    pagination: payload.pagination || snapshot.pagination || freshPagination(),
    version: payload.version || snapshot.version || state.version,
  };
  if (shouldReplaceTabSnapshot(state.tabSnapshots.get(key), nextSnapshot)) {
    rememberTabSnapshot(state.tabSnapshots, key, nextSnapshot);
  }
}

// Warm 20 roles for every other tab as soon as the active tab's first page is
// on screen, then fill those snapshots to 40 if the user stays. All inactive
// tabs load in parallel so a switch is never an empty wait.
async function prefetchRoleTabs() {
  if (isSavedRoleView() || state.prefetching || !state.data) return;
  state.prefetching = true;
  const capturedFilters = roleFiltersKey({ ...readFilters(), tab: "_" });
  try {
    while (state.data && state.loading && !prefetchBackgroundReady(state.items.length, state.pagination)) {
      await wait(32);
    }
    const capturedVersion = state.version;
    const capturedRoleCacheRevision = state.roleCacheRevision;
    const filters = readFilters();
    await Promise.all(ROLE_TABS.map(async (tab) => {
      if (!state.data
        || (capturedVersion && state.version !== capturedVersion)
        || capturedRoleCacheRevision !== state.roleCacheRevision) return;
      if (tab === SAVED_ROLE_TAB || tab === state.activeTab) return;
      try {
        await prefetchRoleTabSnapshot({ ...filters, tab }, capturedRoleCacheRevision, capturedVersion);
      } catch { /* Prefetch is best effort; a miss falls back to a live fetch on switch. */ }
    }));
  } finally {
    state.prefetching = false;
    if (state.data && roleFiltersKey({ ...readFilters(), tab: "_" }) !== capturedFilters) {
      void prefetchRoleTabs();
    }
  }
}

export function shouldRefreshRoleListings(currentContentVersion, nextContentVersion, currentVersion, nextVersion, scanning) {
  if (nextContentVersion && currentContentVersion !== nextContentVersion) return true;
  return hasVersionChanged(currentVersion, nextVersion) && (!scanning || !nextContentVersion);
}

function isAnalyticsView() {
  return state.activeView === "analytics" || state.activeView === "sources";
}

async function syncAnalyticsAccount({ force = false } = {}) {
  if (state.analyticsAccountRequest) return state.analyticsAccountRequest;
  const request = (async () => {
    if (state.auth?.status === "loading" || force) await authClient.bootstrap();
    const user = state.auth?.status === "authenticated" ? state.auth.user : null;
    if (!user) return false;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/analytics/account", { cache: "no-store", headers: { Accept: "application/json" }, signal: controller.signal });
      const payload = await readJsonResponse(response);
      if (state.auth?.user?.id !== user.id) return false;
      if (payload.contract !== "dashboard.analytics-account.v1" || payload.account?.userId !== user.id
        || !Number.isSafeInteger(payload.hiddenCount) || payload.hiddenCount < 0
        || !Number.isSafeInteger(payload.appliedRoleCount) || payload.appliedRoleCount < 0) {
        throw new Error("Your saved counts need an active account session. Sign in again to reconnect.");
      }
      state.analyticsAccount = { ...payload.account, hiddenCount: payload.hiddenCount, appliedRoleCount: payload.appliedRoleCount };
      return true;
    } finally {
      clearTimeout(timeout);
    }
  })().catch((error) => {
    state.analyticsAccount = { ...(state.analyticsAccount || {}), error: error?.message || "Could not load your saved counts." };
    return false;
  }).finally(() => {
    state.analyticsAccountRequest = null;
    renderCrawlStatistics(state.data);
  });
  state.analyticsAccountRequest = request;
  return request;
}

async function syncAnalytics({ force = false } = {}) {
  if (!force && document.visibilityState === "hidden") return false;
  void syncAnalyticsAccount({ force });
  if (state.analyticsRequest) return state.analyticsRequest;
  const status = $("#analytics-load-status");
  const message = $("#analytics-load-message");
  const retry = $("#analytics-retry");
  if (!state.analyticsReady && status) {
    status.hidden = false;
    status.dataset.error = "false";
    if (message) message.textContent = "Loading saved analytics…";
  }
  if (retry) retry.hidden = true;
  $("#analytics-view")?.setAttribute("aria-busy", "true");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  const request = (async () => {
    const headers = { Accept: "application/json" };
    if (!force && state.analyticsEtag) headers["If-None-Match"] = state.analyticsEtag;
    const response = await fetch("/api/analytics", { cache: "no-store", headers, signal: controller.signal });
    if (response.status === 304) {
      if (status) status.hidden = true;
      return false;
    }
    const payload = await readJsonResponse(response);
    if (payload.contract !== "dashboard.analytics.v1" || !payload.stats) throw new Error("Scout returned incomplete analytics. Try again.");
    state.analyticsEtag = response.headers.get("ETag");
    const latestRun = payload.latestRun !== undefined ? payload.latestRun : state.data?.latestRun || null;
    const runs = rememberRunHistory(payload.runs || []);
    const hydrated = applyRememberedSourceHealth({ ...payload, latestRun }, state.data);
    state.analyticsData = payload;
    state.data = { ...(state.data || {}), ...hydrated, latestRun, runs, stats: mergeDashboardStats(state.data?.stats, payload.stats) };
    state.statusVersion = payload.version || state.statusVersion;
    if (state.scanning && !isScanActive(state.data)) state.scanning = false;
    state.analyticsReady = true;
    renderChrome(state.data);
    if (status) status.hidden = true;
    return true;
  })().catch((error) => {
    if (status) { status.hidden = false; status.dataset.error = "true"; }
    if (message) message.textContent = `${state.analyticsReady ? "Showing the last analytics snapshot. " : "Analytics could not load. "}${controller.signal.aborted ? "The request timed out. Retry to reconnect." : error?.message || "Retry to reconnect."}`;
    if (retry) retry.hidden = false;
    return false;
  }).finally(() => {
    clearTimeout(timeout);
    state.analyticsRequest = null;
    $("#analytics-view")?.setAttribute("aria-busy", "false");
  });
  state.analyticsRequest = request;
  return request;
}

async function syncChanges({ force = false } = {}) {
  if (isAnalyticsView()) return syncAnalytics({ force });
  if (!force && document.visibilityState === "hidden") return false;
  // A slow session refresh must finish once; polling must not abort and
  // restart the initial head request every five seconds.
  if (state.listController && !state.loadingMore) return false;
  if (state.changesRequest) return state.changesRequest;
  const request = (async () => {
    const headers = { Accept: "application/json" };
    if (!force && state.changesEtag) headers["If-None-Match"] = state.changesEtag;
    const response = await fetch("/api/changes", { cache: "no-store", headers });
    const etag = response.headers.get("ETag");
    if (etag) state.changesEtag = etag;
    if (response.status === 304) return false;
    const payload = await readJsonResponse(response);
    const previousVersion = state.version;
    state.statusVersion = payload.version || state.statusVersion;
    const latestRun = payload.latestRun !== undefined ? payload.latestRun : (state.data?.latestRun || null);
    const incomingRuns = Array.isArray(payload.runs) ? payload.runs : (state.data?.runs || (latestRun ? [latestRun] : []));
    const runs = rememberRunHistory(incomingRuns);
    const hydrated = applyRememberedSourceHealth({ ...payload, latestRun, scan: payload.scan || payload.status || state.data?.scan || {} }, state.data);
    state.data = {
      ...(state.data || {}),
      ...hydrated,
      stats: mergeDashboardStats(state.data?.stats, hydrated.stats),
      scan: hydrated.scan || payload.scan || payload.status || state.data?.scan || {},
      latestRun,
      latestCompletedRun: payload.latestCompletedRun || (latestRun?.status === "COMPLETED" ? latestRun : state.data?.latestCompletedRun || null),
      runs,
    };
    // Keep the analytics "hidden by you" counter in sync even when the lightweight
    // status poll is the only fresh source. The changes endpoint now carries the
    // same hidden/closed counts as the action mutation, so map them into stats.
    if (payload.hiddenCount !== undefined || payload.stats?.hidden !== undefined || payload.closedCount !== undefined || payload.stats?.closed !== undefined || payload.appliedRoleCount !== undefined) {
      state.data = applyListingActionCounts(state.data, {
        hiddenCount: payload.hiddenCount ?? payload.stats?.hidden,
        closedCount: payload.closedCount ?? payload.stats?.closed,
        appliedRoleCount: payload.appliedRoleCount,
      });
    }
    if (state.scanning && !isScanActive(state.data)) state.scanning = false;
    renderChrome(state.data);
    const refreshListings = shouldRefreshRoleListings(
      state.rolesContentVersion, payload.contentVersion, previousVersion, payload.version, scanIsActive(payload),
    );
    if (payload.version) state.version = payload.version;
    if (refreshListings) {
      invalidateRoleListingState();
      if (isSavedRoleView()) {
        renderRoles();
        return true;
      }
      const hasRenderedRoles = state.items.length > 0;
      await ensureRolesLoaded(state.intentRevision, { silent: hasRenderedRoles, skipMotion: hasRenderedRoles });
      // A catalog rebuild may serve the prior coherent snapshot once. Keep
      // polling without its ETag until the displayed rows reach this content revision.
      if (payload.contentVersion && state.rolesContentVersion !== payload.contentVersion) state.changesEtag = null;
      void prefetchRoleTabs();
    }
    return true;
  })().catch((error) => {
    if (!state.data) throw error;
    if ($("#connection-label")) $("#connection-label").textContent = "Unavailable";
    return false;
  }).finally(() => { state.changesRequest = null; });
  state.changesRequest = request;
  return request;
}

function detailContent(details) { return details.querySelector(".detail-content"); }

function renderDetailLoading(details) {
  const content = detailContent(details);
  if (!content) return;
  details.setAttribute("aria-busy", "true");
  content.innerHTML = '<p class="detail-loading" role="status">Loading full role details…</p>';
}

function renderDetailError(details, message) {
  const content = detailContent(details);
  if (!content) return;
  details.removeAttribute("aria-busy");
  content.innerHTML = `<p class="error-state" role="alert">${escapeHtml(message)}</p><button class="button button-subtle" type="button" data-detail-retry>Retry details</button>`;
}

async function loadRoleDetails(card, details, force = false) {
  const key = details.dataset.detailKey;
  const role = state.items.find((item) => listingKey(item.listingType || "internship", item.listingId || item.id) === key);
  if (!key || !role || !details.open) return;
  const cached = getCachedDetail(state.detailCache, key, state.version);
  if (!force && cached) {
    details.removeAttribute("aria-busy");
    detailContent(details).innerHTML = roleDetailsHtml(cached.role);
    return;
  }
  state.detailControllers.get(key)?.abort();
  const controller = new AbortController();
  state.detailControllers.set(key, controller);
  const capturedIntent = state.intentRevision;
  const capturedListVersion = state.version;
  renderDetailLoading(details);
  try {
    const path = `/api/roles/${encodeURIComponent(role.listingType || "internship")}/${encodeURIComponent(role.listingId || role.id)}`;
    const response = await fetch(path, { cache: "no-store", signal: controller.signal, headers: { Accept: "application/json" } });
    const payload = await readJsonResponse(response);
    if (!isDetailResponseCurrent(capturedIntent, state.intentRevision, capturedListVersion, state.version) || !details.open) return;
    const detailRole = payload.role || {};
    rememberDetailCache(state.detailCache, key, {
      listVersion: capturedListVersion,
      detailVersion: payload.version || null,
      detailEtag: response.headers.get("ETag") || null,
      role: detailRole,
    });
    details.removeAttribute("aria-busy");
    detailContent(details).innerHTML = roleDetailsHtml(detailRole);
  } catch (error) {
    if (error?.name !== "AbortError" && isDetailResponseCurrent(capturedIntent, state.intentRevision, capturedListVersion, state.version)) renderDetailError(details, error?.message || "Could not load role details");
  } finally {
    if (state.detailControllers.get(key) === controller) state.detailControllers.delete(key);
  }
}

function rememberListingAction(record, context = {}) {
  state.undoStack = state.undoStack.filter((item) => item.listingKey !== record.listingKey);
  const optimisticRole = context.role ?? record.optimisticRole ?? null;
  const optimisticFiltersKey = context.filtersKey ?? record.optimisticFiltersKey ?? null;
  const optimisticRoleIndex = Number.isInteger(context.index)
    ? context.index
    : Number.isInteger(record.optimisticRoleIndex)
      ? record.optimisticRoleIndex
      : null;
  const remembered = {
    ...record,
    ...(optimisticRole
      ? { optimisticRole, optimisticFiltersKey, optimisticRoleIndex }
      : {}),
  };
  state.undoStack.push(remembered);
  return remembered;
}

function forgetListingAction(key) {
  state.undoStack = state.undoStack.filter((item) => item.listingKey !== key);
}

function applyListingActionPayload(payload) {
  if (!state.data) return;
  state.data = applyListingActionCounts(state.data, payload);
  // Make the next change poll revalidate the action mutation even if the
  // server-side ETag was already captured by a concurrent poll.
  state.changesEtag = null;
  renderChrome(state.data);
}

function optimisticListingActionCounts(action, direction) {
  const payload = {};
  const multiplier = direction < 0 ? -1 : 1;
  if (action?.action === "cant_fit") {
    const hidden = Number(state.data?.stats?.hidden);
    if (Number.isFinite(hidden)) payload.hiddenCount = Math.max(0, hidden + multiplier);
  }
  if (action?.action === "applied") {
    const applied = Number(state.data?.appliedRoleCount);
    if (Number.isFinite(applied)) payload.appliedRoleCount = Math.max(0, applied + multiplier);
  }
  return payload;
}

function applyOptimisticListingActionCounts(action, direction) {
  if (!state.data) return;
  const payload = optimisticListingActionCounts(action, direction);
  if (!Object.keys(payload).length) return;
  state.data = applyListingActionCounts(state.data, payload);
  renderChrome(state.data);
}

function removeLocalRole(key) {
  if (state.selectedRoleKey === key) closeRoleDetail({ restoreFocus: false });
  state.items = state.items.filter((role) => listingKey(role.listingType || "internship", role.listingId || role.id) !== key);
  if (state.data) state.data.items = state.data.internships = state.items;
  renderRoles();
}

function restoreLocalRole(role, index = 0) {
  if (!role || state.pendingActions.has(roleKey(role))) return false;
  state.items = insertRoleForUndo(state.items, role, index);
  if (state.data) state.data.items = state.data.internships = state.items;
  state.loading = false;
  state.loadingMore = false;
  state.listError = null;
  renderRoles({ animate: false });
  return true;
}

function canRestoreRoleLocally(action) {
  return isRoleFeedView(state.activeView)
    && !isSavedRoleView()
    && Boolean(action?.optimisticRole)
    && action.optimisticFiltersKey === roleFiltersKey(readFilters());
}

function removeListingNotifications(key) {
  const removedIds = new Set(state.notifications
    .filter((notification) => notification.kind === "deadline-soon" && notification.listingKey === key)
    .map((notification) => notification.id));
  if (!removedIds.size) return;
  state.notifications = state.notifications.filter((notification) => !removedIds.has(notification.id));
  state.notificationReadIds = new Set([...state.notificationReadIds].filter((id) => !removedIds.has(id)));
  persistNotificationState();
  renderNotifications();
}

function showListingActionToast(action, message) {
  if (!action || state.undoStack.at(-1) !== action) return;
  showToast(message, {
    label: "Undo",
    onClick: () => { void undoListingAction(action.listingKey); },
  });
}

function toggleWatchlist(button) {
  const listingType = button.dataset.listingType || "internship";
  const listingId = button.dataset.listingId;
  if (!listingId) return;
  const key = listingKey(listingType, listingId);
  const saved = state.watchlistRoles.some((role) => listingKeyForRole(role) === key);
  if (saved) {
    state.watchlistRoles = removeWatchlistRole(state.watchlistRoles, key);
    writeWatchlistRoles(state.watchlistRoles);
    showToast("Removed from watchlist");
  } else {
    const role = state.items.find((candidate) => listingKeyForRole(candidate) === key);
    if (!role) return;
    state.watchlistRoles = upsertWatchlistRole(state.watchlistRoles, role);
    writeWatchlistRoles(state.watchlistRoles);
    showToast("Saved to watchlist");
  }
  renderWatchlistCount();
  if (isSavedRoleView()) state.items = pendingVisibleRoles(state.watchlistRoles);
  renderRoles();
}

async function saveListingAction(button) {
  const listingType = button.dataset.listingType;
  const listingId = button.dataset.listingId;
  const action = button.dataset.listingAction;
  const company = button.dataset.listingCompany;
  const title = button.dataset.listingTitle;
  const key = listingType && listingId ? listingKey(listingType, listingId) : "";
  if (!listingType || !listingId || !action || !company || !title || !state.data || !key || state.pendingActions.has(key) || state.actionRequests.has(key)) return;
  clearListingSnapshots();
  const optimisticRoleIndex = state.items.findIndex((role) => listingKey(role.listingType || "internship", role.listingId || role.id) === key);
  const optimisticRole = optimisticRoleIndex >= 0 ? state.items[optimisticRoleIndex] : null;
  const optimisticFiltersKey = roleFiltersKey(readFilters());
  const shouldOptimisticallyHide = action === "cant_fit";
  const successMessage = action === "applied" ? `Applied · ${company}` : `Hidden · ${title}`;
  const actionRecord = rememberListingAction({
    listingKey: key,
    listingType,
    listingId,
    action,
    company,
    title,
    createdAt: new Date().toISOString(),
  }, {
    role: optimisticRole,
    filtersKey: optimisticFiltersKey,
    index: optimisticRoleIndex,
  });
  state.pendingActions.add(key);
  // Keep every decision suppressed until it is undone. The server response
  // can arrive before its read-side cache has finished invalidating.
  state.optimisticallyHiddenListings.add(key);
  applyOptimisticListingActionCounts(actionRecord, 1);
  removeLocalRole(key);
  // The role is already gone from the feed optimistically; make both the
  // success state and its undo affordance available before the API responds.
  showListingActionToast(actionRecord, successMessage);
  let requestPromise = null;
  try {
    const csrfHeaders = await authClient.csrfHeaders();
    requestPromise = fetch("/api/actions", {
      method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json", ...csrfHeaders },
      body: JSON.stringify({ listingType, listingId, action, company, title, applicationUrl: button.dataset.listingApplicationUrl || "", postingUrl: button.dataset.listingPostingUrl || "", jobId: button.dataset.listingJobId || "", location: button.dataset.listingLocation || "" }),
    }).then((response) => readJsonResponse(response));
    state.actionRequests.set(key, requestPromise);
    const payload = await requestPromise;
    state.pendingActions.delete(key);
    if (actionRecord.undoRequested) {
      // Undo already restored the local queue. Do not paint the committed
      // action counts into the UI while its DELETE is waiting behind this POST.
      invalidateRoleListingState();
      return;
    }
    invalidateRoleListingState();
    removeListingNotifications(key);
    applyListingActionPayload(payload);
    showListingActionToast(actionRecord, successMessage);
    // Reconcile in the background; it should not delay the action feedback.
    void ensureRolesLoaded(state.intentRevision, { silent: true, skipMotion: true });
  } catch (error) {
    state.pendingActions.delete(key);
    if (actionRecord.undoRequested) return;
    if (shouldOptimisticallyHide) {
      // “Can’t fit” is a local triage action. Keep the row hidden and let the
      // server catch up without surfacing a database/network error here. The
      // action remains undoable in case the request committed before failing.
      invalidateRoleListingState();
      removeListingNotifications(key);
      void ensureRolesLoaded(state.intentRevision, { silent: true, skipMotion: true });
      return;
    }
    // The request may have committed successfully even if the response was
    // lost. Rebuild every view from the server's current action state before
    // restoring anything locally.
    state.optimisticallyHiddenListings.delete(key);
    forgetListingAction(key);
    applyOptimisticListingActionCounts(actionRecord, -1);
    invalidateRoleListingState();
    if (optimisticRole) restoreLocalRole(optimisticRole, optimisticRoleIndex);
    await ensureRolesLoaded(state.intentRevision, { silent: true, skipMotion: true });
    showToast(error?.message || "Could not save listing decision");
  } finally {
    if (!actionRecord.undoRequested && state.actionRequests.get(key) === requestPromise) state.actionRequests.delete(key);
  }
}

function undoListingAction(listingKeyToUndo = null) {
  const action = listingKeyToUndo
    ? state.undoStack.find((candidate) => candidate.listingKey === listingKeyToUndo)
    : state.undoStack.at(-1);
  if (!action) return;
  clearListingSnapshots();
  forgetListingAction(action.listingKey);
  action.undoRequested = true;
  const saveRequest = state.actionRequests.get(action.listingKey);
  state.pendingActions.delete(action.listingKey);
  state.optimisticallyHiddenListings.delete(action.listingKey);
  applyOptimisticListingActionCounts(action, -1);
  invalidateRoleListingState();
  let restoredLocally = false;
  if (canRestoreRoleLocally(action)) {
    restoredLocally = restoreLocalRole(action.optimisticRole, action.optimisticRoleIndex);
  }
  showToast(`Restored · ${action.title}`);
  void reconcileUndoneListingAction(action, saveRequest, restoredLocally);
}

function undoLastListingAction() {
  return undoListingAction();
}

async function reconcileUndoneListingAction(action, saveRequest, restoredLocally) {
  try {
    // A DELETE sent before the original POST can win the race and leave the
    // action committed after the user has already seen the local restore.
    // Always serialize the server-side undo behind the original mutation.
    if (saveRequest) {
      try { await saveRequest; } catch { /* DELETE is still safe if POST failed. */ }
    }
    const query = new URLSearchParams({ listingType: action.listingType, listingId: action.listingId });
    const csrfHeaders = await authClient.csrfHeaders();
    const response = await fetch(`/api/actions?${query.toString()}`, { method: "DELETE", headers: { Accept: "application/json", ...csrfHeaders } });
    const payload = await readJsonResponse(response);
    if (state.actionRequests.get(action.listingKey) === saveRequest) state.actionRequests.delete(action.listingKey);
    applyListingActionPayload(payload);
    // The role is already visible when possible. Reconcile quietly so the
    // server can correct stale ordering, closure, or filtering without
    // delaying the instant local restore.
    void ensureRolesLoaded(state.intentRevision, { silent: true, skipMotion: true });
  } catch (error) {
    if (restoredLocally) {
      state.optimisticallyHiddenListings.add(action.listingKey);
      removeLocalRole(action.listingKey);
      applyOptimisticListingActionCounts(action, 1);
      action.undoRequested = false;
      rememberListingAction(action);
    }
    showToast(error?.message || "Could not undo listing decision");
  } finally {
    if (state.actionRequests.get(action.listingKey) === saveRequest) state.actionRequests.delete(action.listingKey);
  }
}

function wait(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

async function waitForScanCompletion() {
  while (scanIsActive()) {
    await wait(SCAN_POLL_INTERVAL_MS);
    await syncChanges();
  }
}

async function checkAllSources() {
  if (state.scanning || scanIsActive()) return;
  state.scanning = true;
  updateScanButton();
  if ($("#connection-label")) $("#connection-label").textContent = "Checking sources";
  try {
    const response = await fetch("/api/refresh", { method: "POST", cache: "no-store", headers: { Accept: "application/json" } });
    const payload = await readJsonResponse(response);
    if (payload.scan) {
      state.data = { ...(state.data || {}), scan: payload.scan };
      renderChrome(state.data);
    }
    await syncChanges({ force: true });
    await waitForScanCompletion();
    if (state.data?.scan?.status === "FAILED") throw new Error(state.data.scan.error || "Source check failed");
    showToast(`Checked ${configuredSourceCount(state.data)} sources · ${state.data?.latestRun?.new_count ?? 0} new roles found`);
  } catch (error) {
    if ($("#connection-label")) $("#connection-label").textContent = "Unavailable";
    showToast(error?.message || "Could not check sources");
  } finally { state.scanning = false; updateScanButton(); }
}

async function terminateCurrentRun() {
  if (state.terminating || !scanIsActive()) return;
  if (!confirmLocalDataAction("Stop the active crawl? Sources already checked will keep their results.")) return;
  state.terminating = true;
  updateScanButton();
  try {
    const response = await fetch("/api/terminate", { method: "POST", cache: "no-store", headers: { Accept: "application/json" } });
    const payload = await readJsonResponse(response);
    state.scanning = false;
    await syncChanges({ force: true });
    showToast(payload.runId ? `Run #${payload.runId} terminated.` : "No crawl is currently running.");
  } catch (error) { showToast(error?.message || "Could not terminate the current run"); }
  finally { state.terminating = false; updateScanButton(); }
}

function syncSearchInputs(value, source) {
  const global = $("#global-search");
  const local = $("#search-input");
  if (source !== "global" && global && global.value !== value) global.value = value;
  if (source !== "local" && local && local.value !== value) local.value = value;
}

function handleSearchInput(event) {
  const value = event?.target?.value || "";
  syncSearchInputs(value, event?.target?.id === "global-search" ? "global" : "local");
  invalidateForIntent();
  if (state.searchTimer) clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => {
    state.searchTimer = null;
    handleFilterChange();
  }, SEARCH_DEBOUNCE_MS);
}

// Paints roles synchronously on every tab or filter change: a known snapshot
// renders immediately, and only an unseen view shows the loading placeholder.
function handleFilterChange() {
  invalidateForIntent();
  syncUiStateToUrl();
  if (state.activeView === "applications") {
    renderApplications();
    return;
  }
  if (["analytics", "sources", "settings"].includes(state.activeView)) return;
  if (isSavedRoleView()) {
    state.items = pendingVisibleRoles(state.watchlistRoles);
    state.pagination = { limit: state.items.length, offset: 0, total: watchlistDisplayRoles().length, hasMore: false, nextOffset: null };
    state.loading = false;
    state.loadingMore = false;
    if (state.data) renderChrome(state.data);
    renderRoles();
    return;
  }
  const snapshot = getTabSnapshot(state.tabSnapshots, roleFiltersKey(readFilters()));
  if (snapshot && Array.isArray(snapshot.items) && snapshot.items.length) {
    state.items = pendingVisibleRoles(snapshot.items);
    state.pagination = snapshot.pagination || freshPagination();
    state.loading = false;
    state.loadingMore = false;
    // The restore path may never fetch, so refresh the tab bar and chrome here.
    if (state.data) renderChrome(state.data);
    renderRoles();
    if (snapshot.version === state.version) {
      const needsFirstPage = state.items.length < INITIAL_PAGE_SIZE && canLoadMoreRoles(state.pagination, state.items.length, LIST_RENDER_CAP);
      if (needsFirstPage) void ensureRolesLoaded(state.intentRevision, { silent: true });
      else maybeDrainRemainingRoles(state.intentRevision);
    } else {
      void ensureRolesLoaded(state.intentRevision, { silent: true });
    }
    void prefetchRoleTabs();
    return;
  }
  if (restoreListingSnapshot()) {
    void ensureRolesLoaded(state.intentRevision, { silent: true, skipMotion: true });
    return;
  }
  state.showingCachedRoles = false;
  state.items = [];
  state.pagination = freshPagination();
  state.loading = true;
  renderRoles();
  void ensureRolesLoaded(state.intentRevision);
  void prefetchRoleTabs();
}

function readSavedViews() {
  try {
    const raw = localStorage.getItem(SAVED_VIEWS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSavedViews(views) {
  localStorage.setItem(SAVED_VIEWS_KEY, JSON.stringify(views.slice(0, 12)));
}

function renderSavedViews() {
  const views = readSavedViews();
  const empty = $("#saved-views-empty");
  const list = $("#saved-views-list");
  if (!list) return;
  if (empty) empty.hidden = views.length > 0;
  list.innerHTML = views.map((view, index) => `<button class="saved-view-item" type="button" data-saved-view="${index}">${escapeHtml(view.name)}</button>`).join("");
}

function applySavedView(view) {
  if (!view) return;
  state.activeView = "roles";
  state.roleView = normalizeRoleView(view.view, state.roleView);
  state.activeTab = ROLE_TABS.includes(view.tab) ? view.tab : "main";
  if ($("#status-filter")) $("#status-filter").value = view.status || "open";
  if ($("#category-filter")) $("#category-filter").value = view.category || "all";
  if ($("#sort-filter")) $("#sort-filter").value = view.sort || DEFAULT_ROLE_SORT;
  if ($("#work-mode-filter")) $("#work-mode-filter").value = view.workMode || "all";
  setSelectedSeasonFilters(view.seasons === undefined ? view.season : view.seasons);
  if ($("#location-filter") && view.location) {
    if (![...$("#location-filter").options].some((option) => option.value === view.location)) {
      $("#location-filter").insertAdjacentHTML("beforeend", `<option value="${escapeHtml(view.location)}">${escapeHtml(view.location)}</option>`);
    }
    $("#location-filter").value = view.location;
  }
  syncSearchInputs(view.search || "");
  handleFilterChange();
}

function bindEvents() {
  $("#analytics-retry")?.addEventListener("click", () => void syncAnalytics({ force: true }));
  $("#analytics-account-status")?.addEventListener("click", (event) => {
    if (event.target.closest("[data-retry-analytics-account]")) void syncAnalyticsAccount({ force: true });
  });
  /* Today/application reminder support is dormant for now.
  document.addEventListener("submit", (event) => {
    if (!(event.target instanceof Element)) return;
    const form = event.target.closest("[data-application-reminders]");
    if (!form) return;
    event.preventDefault();
    void saveApplicationReminderForm(form);
  });
  */
  $("#refresh-button")?.addEventListener("click", () => void checkAllSources());
  $("#terminate-button")?.addEventListener("click", () => void terminateCurrentRun());
  $("#quick-refresh-button")?.addEventListener("click", () => void checkAllSources());
  $("#quick-terminate-button")?.addEventListener("click", () => void terminateCurrentRun());
  $("#source-marquee-toggle")?.addEventListener("click", toggleSourceMarquee);
  $("#close-role-detail")?.addEventListener("click", () => closeRoleDetail());
  $("#application-draft-close")?.addEventListener("click", () => closeApplicationDraftDialog());
  $("#application-draft-dialog")?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeApplicationDraftDialog();
  });
  $("#application-draft-dialog")?.addEventListener("click", (event) => {
    if (event.target === $("#application-draft-dialog")) closeApplicationDraftDialog();
  });
  $("#application-draft-dialog")?.addEventListener("keydown", trapApplicationDraftFocus);
  $("#application-draft-content")?.addEventListener("input", () => {
    const session = state.activeApplicationDraft;
    if (session?.entry) saveApplicationDraftEdits(session, true);
  });
  $("#resume-profile-close")?.addEventListener("click", () => closeResumeProfileDialog());
  $("#resume-profile-dialog")?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeResumeProfileDialog();
  });
  $("#resume-profile-dialog")?.addEventListener("click", (event) => {
    if (event.target === $("#resume-profile-dialog")) closeResumeProfileDialog();
  });
  $("#resume-profile-dialog")?.addEventListener("keydown", trapApplicationDraftFocus);
  $("#resume-profile-content")?.addEventListener("input", () => {
    const session = state.activeResumeProfileSession;
    const record = session?.candidate || session?.profile;
    const editor = $("[data-resume-editor='profile-resume']");
    if (session && record && editor) session.editedResume = collectEditedResume(editor, session.editedResume || record.resume);
  });
  $("#resume-profile-file")?.addEventListener("change", (event) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (file) void importResumeFile(file);
    input.value = "";
  });
  $("#theme-toggle")?.addEventListener("click", () => {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    updateDashboardSettings({ theme: next });
  });
  $("#add-source-button")?.addEventListener("click", openAddSourceDialog);
  $("#add-source-form")?.addEventListener("submit", (event) => void submitAddSource(event));
  $("#source-url-input")?.addEventListener("input", (event) => {
    event.currentTarget.removeAttribute("aria-invalid");
    const error = $("#source-url-error");
    if (error) {
      error.hidden = true;
      error.textContent = "";
    }
  });
  $("#cancel-add-source")?.addEventListener("click", closeAddSourceDialog);
  $("#close-add-source")?.addEventListener("click", closeAddSourceDialog);
  $("#add-source-dialog")?.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeAddSourceDialog();
  });
  $("#add-source-dialog")?.addEventListener("click", (event) => {
    if (event.target === $("#add-source-dialog")) closeAddSourceDialog();
  });
  $("#notifications-button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#notifications-popover");
    const button = $("#notifications-button");
    const shouldOpen = menu?.hidden !== false;
    closeAllMenus();
    if (menu) menu.hidden = !shouldOpen;
    if (button) button.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      state.menuReturnFocus = button;
      renderNotifications();
    }
  });
  $("#mark-all-notifications")?.addEventListener("click", markAllNotificationsRead);
  $("#notifications-list")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest("[data-notification-id]");
    if (!item) return;
    const notification = state.notifications.find((candidate) => candidate.id === item.dataset.notificationId);
    markNotificationRead(item.dataset.notificationId);
    closeAllMenus();
    if (notification?.kind === "deadline-soon" && notification.postingUrl) {
      const postingUrl = safeUrl(notification.postingUrl);
      if (postingUrl !== "#") {
        window.open(postingUrl, "_blank", "noopener,noreferrer");
        return;
      }
    }
    openAnalyticsView();
    $("#recent-runs")?.scrollIntoView({ behavior: reducedMotionPreferred() ? "auto" : "smooth", block: "nearest" });
  });
  $("#user-menu-button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#user-menu-popover");
    const button = $("#user-menu-button");
    const shouldOpen = menu?.hidden !== false;
    closeAllMenus();
    if (menu) menu.hidden = !shouldOpen;
    if (button) button.setAttribute("aria-expanded", String(shouldOpen));
    if (shouldOpen) {
      state.menuReturnFocus = button;
      menu?.querySelector("[role='menuitem']")?.focus();
    }
  });
  $("#user-menu-popover")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const item = target.closest("[role='menuitem']");
    if (!(item instanceof Element)) return;
    const action = item.dataset.userMenuAction;
    if (action === "settings") {
      event.preventDefault();
      closeAllMenus();
      openSettingsView();
      return;
    }
    if (action === "help") {
      event.preventDefault();
      closeAllMenus();
      $("#need-help")?.click();
      return;
    }
    closeAllMenus();
  });
  $("#user-menu-popover")?.addEventListener("keydown", (event) => {
    if (!(event.target instanceof Element)) return;
    const menu = event.currentTarget;
    if (!(menu instanceof Element)) return;
    const items = [...menu.querySelectorAll("[role='menuitem']")]
      .filter((item) => !item.hasAttribute("hidden") && !item.matches(":disabled"));
    const current = items.indexOf(event.target.closest("[role='menuitem']"));
    if (current < 0 || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home"
      ? 0
      : event.key === "End"
        ? items.length - 1
        : (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  });
  const logoutButton = $("#dashboard-logout");
  if (logoutButton) {
    wireLogoutButton(logoutButton, { redirectTo: "/" });
    logoutButton.addEventListener("roleradar:autherror", (event) => {
      showToast(event.detail?.message || "Scout could not log you out. Try again.");
    });
  }
  $("#upgrade-plan")?.addEventListener("click", () => showToast("Plan billing is not connected in this workspace."));
  $("#need-help")?.addEventListener("click", () => showToast("Use crawl status and source rows to diagnose a run. ⌘/Ctrl+Z undoes Applied / Can't fit."));
  $("#view-all-runs")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (state.runLimit > RECENT_RUN_LIMIT) {
      state.runLimit = RECENT_RUN_LIMIT;
      if (state.data) renderRunHealth(state.data);
      return;
    }
    if (state.runHistory !== null) {
      state.runLimit = EXPANDED_RUN_LIMIT;
      if (state.data) {
        state.data = { ...state.data, runs: state.runHistory };
        renderRunHealth(state.data);
      }
      return;
    }

    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      const response = await fetch(`/api/runs?limit=${EXPANDED_RUN_LIMIT}`, {
        cache: "no-store",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response);
      if (!Array.isArray(payload.runs)) throw new Error("Run history was unavailable");
      state.runHistory = mergeRunHistoryLists(state.data?.runs, payload.runs);
      state.runLimit = EXPANDED_RUN_LIMIT;
      state.data = { ...(state.data || {}), runs: state.runHistory };
      renderRunHealth(state.data);
    } catch {
      state.runLimit = RECENT_RUN_LIMIT;
      showToast("Could not load crawl run history. Try again.");
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  });
  $("#view-all-sources")?.addEventListener("click", () => {
    state.sourcesExpanded = !state.sourcesExpanded;
    if (state.data) renderSources(state.data);
  });
  $("#more-filters-button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#more-filters-menu");
    const hidden = menu?.hidden !== false;
    closeAllMenus();
    if (menu) menu.hidden = !hidden;
    $("#more-filters-button")?.setAttribute("aria-expanded", String(hidden));
    if (hidden) state.menuReturnFocus = $("#more-filters-button");
  });
  $("#more-filters-menu")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches("select")) return;
    handleFilterChange();
  });
  $("#saved-views-button")?.addEventListener("click", (event) => {
    event.stopPropagation();
    const menu = $("#saved-views-menu");
    const hidden = menu?.hidden !== false;
    closeAllMenus();
    renderSavedViews();
    if (menu) menu.hidden = !hidden;
    $("#saved-views-button")?.setAttribute("aria-expanded", String(hidden));
    if (hidden) state.menuReturnFocus = $("#saved-views-button");
  });
  $("#save-current-view")?.addEventListener("click", () => {
    const filters = readFilters();
    const name = `${filters.tab} · ${filters.sort}${filters.seasons.length ? ` · ${seasonFilterLabel(filters.seasons)}` : ""}${filters.search ? ` · ${filters.search}` : ""}`;
    writeSavedViews([{ name, ...filters, workMode: $("#work-mode-filter")?.value || "all", seasons: selectedSeasonFilters(), location: $("#location-filter")?.value || "all" }, ...readSavedViews()]);
    renderSavedViews();
    showToast("Saved current filters on this device.");
  });
  $("#saved-views-list")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-saved-view]");
    if (!button) return;
    applySavedView(readSavedViews()[Number(button.dataset.savedView)]);
    closeAllMenus();
  });
  document.querySelectorAll("[data-nav]").forEach((link) => {
    link.addEventListener("click", (event) => {
      const isAnchor = link.tagName === "A";
      if (isAnchor && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
      const nav = link.dataset.nav;
      if (nav === "applications") {
        event.preventDefault();
        openApplicationsView();
        return;
      }
      if (nav === "analytics") {
        event.preventDefault();
        openAnalyticsView();
        return;
      }
      if (nav === "roles") {
        event.preventDefault();
        openRolesView({ tab: "main" });
        return;
      }
      if (nav === "watchlist") {
        event.preventDefault();
        openWatchlistView();
        return;
      }
      if (nav === "dashboard") {
        event.preventDefault();
        openDashboardView();
        return;
      }
      if (nav === "interview") {
        event.preventDefault();
        showToast("Interview Prep is not available in this workspace yet.");
        return;
      }
      if (nav === "sources") {
        event.preventDefault();
        openSourcesView();
        return;
      }
      if (nav === "settings") {
        event.preventDefault();
        openSettingsView();
        return;
      }
      if (nav && nav !== "dashboard") {
        event.preventDefault();
        showToast("This dashboard currently focuses on live roles, applications, and crawl status.");
      }
    });
  });
  document.querySelectorAll("[data-role-tab]").forEach((button) => {
    button.addEventListener("keydown", handleRoleTabKeydown);
    button.addEventListener("click", () => {
      const tab = button.dataset.roleTab;
      if (!tab || tab === state.activeTab) return;
      state.activeTab = ROLE_TABS.includes(tab) ? tab : "main";
      handleFilterChange();
    });
  });
  $("#search-input")?.addEventListener("input", handleSearchInput);
  $("#global-search")?.addEventListener("input", handleSearchInput);
  $("#category-filter")?.addEventListener("change", handleFilterChange);
  $("#sort-filter")?.addEventListener("change", handleFilterChange);
  $("#work-mode-filter")?.addEventListener("change", handleFilterChange);
  $("#season-filter")?.addEventListener("change", handleFilterChange);
  $("#location-filter")?.addEventListener("change", handleFilterChange);
  $("#applications-refresh-button")?.addEventListener("click", () => void loadApplications({ force: true }));
  $("#applications-search-input")?.addEventListener("input", (event) => {
    state.applicationSearch = event.target.value || "";
    renderApplications();
    syncUiStateToUrl();
  });
  $("#applications-stage-filter")?.addEventListener("change", (event) => {
    state.applicationStageFilter = APPLICATION_STAGE_VALUES.has(event.target.value)
      ? event.target.value
      : "all";
    renderApplications();
    syncUiStateToUrl();
  });
  [
    "#settings-theme",
    "#settings-motion",
    "#settings-default-tab",
    "#settings-default-sort",
    "#settings-default-status",
    "#settings-notify-completed",
    "#settings-notify-failed",
    "#settings-notify-new",
  ].forEach((selector) => $(selector)?.addEventListener("change", handleSettingsFieldChange));
  $("#reset-settings-button")?.addEventListener("click", resetDashboardSettings);
  $("#settings-manage-sources")?.addEventListener("click", () => {
    openSourcesView();
  });
  $("#settings-open-analytics")?.addEventListener("click", () => openAnalyticsView());
  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest(".filter-menu, .row-menu, .notification-menu, .user-menu")) closeAllMenus();
    const openProfileButton = target.closest("button[data-open-resume-profile]");
    if (openProfileButton) {
      event.preventDefault();
      openResumeProfile(openProfileButton);
      return;
    }
    const openDraftButton = target.closest("button[data-application-draft]");
    if (openDraftButton) {
      event.preventDefault();
      event.stopPropagation();
      openApplicationDraft(openDraftButton);
      return;
    }
    if (target.closest("button[data-close-application-draft]")) {
      closeApplicationDraftDialog();
      return;
    }
    if (target.closest("button[data-retry-application-draft]")) {
      const session = state.activeApplicationDraft;
      if (session) void requestApplicationDraft(session);
      return;
    }
    if (target.closest("button[data-retry-ai-wording]")) { startAiWordingRetry(); return; }
    if (target.closest("button[data-cancel-ai-wording]")) { cancelAiWordingRetry(); return; }
    if (target.closest("button[data-confirm-ai-wording]")) { confirmAiWordingRetry(); return; }
    if (target.closest("button[data-return-previous-draft]")) { keepPreviousApplicationDraft(); return; }
    const resumePdfButton = target.closest("button[data-download-resume]");
    if (resumePdfButton) { void downloadTailoredResume(resumePdfButton); return; }
    const coverCopyButton = target.closest("button[data-copy-cover-letter]");
    if (coverCopyButton) { void copyCoverLetter(coverCopyButton); return; }
    const coverDownloadButton = target.closest("button[data-download-cover-letter]");
    if (coverDownloadButton) { downloadCoverLetter(); return; }
    if (target.closest("button[data-close-resume-profile]")) {
      closeResumeProfileDialog();
      return;
    }
    if (target.closest("button[data-retry-resume-profile]")) {
      const session = state.activeResumeProfileSession;
      if (session) void loadResumeProfile(session);
      return;
    }
    if (target.closest("button[data-choose-resume-file]")) {
      const input = $("#resume-profile-file");
      if (input) { input.value = ""; input.click(); }
      return;
    }
    if (target.closest("button[data-save-resume-profile]")) { void saveResumeProfile(); return; }
    if (target.closest("button[data-show-remove-resume]")) { showResumeProfileRemovalConfirmation(); return; }
    if (target.closest("button[data-cancel-remove-resume]")) {
      const session = state.activeResumeProfileSession;
      if (session) { session.removeConfirm = false; renderResumeProfile(session); $(`[data-show-remove-resume]`)?.focus(); }
      return;
    }
    if (target.closest("button[data-confirm-remove-resume]")) { void removeResumeProfile(); return; }
    if (target.closest("button[data-discard-resume-candidate]")) {
      const session = state.activeResumeProfileSession;
      if (session) {
        session.candidate = null;
        session.editedResume = session.profile?.resume || null;
        session.message = "Extracted draft discarded.";
        session.messageError = false;
        renderResumeProfile(session);
      }
      return;
    }
    const resumeCollectionButton = target.closest("button[data-add-resume-entry], button[data-remove-resume-entry], button[data-add-resume-skill], button[data-remove-resume-skill]");
    if (resumeCollectionButton) { editResumeProfileCollection(resumeCollectionButton); return; }
    const matchDirection = target.closest("button[data-match-direction]");
    if (matchDirection) {
      const carousel = matchDirection.closest("[data-match-carousel]");
      const current = Number(carousel?.dataset.active || 0);
      updateMatchCarousel(carousel, current + (matchDirection.dataset.matchDirection === "next" ? 1 : -1));
      return;
    }
    const clearFilterButton = target.closest("button[data-clear-filter]");
    if (clearFilterButton) {
      clearFilter(clearFilterButton.dataset.clearFilter);
      return;
    }
    const watchlistButton = target.closest("button[data-watchlist-toggle]");
    if (watchlistButton) {
      event.preventDefault();
      toggleWatchlist(watchlistButton);
      return;
    }
    const applicationFilter = target.closest("button[data-application-filter]");
    if (applicationFilter) {
      const nextStage = applicationFilter.dataset.applicationFilter || "all";
      state.applicationStageFilter = nextStage === "all" || APPLICATION_STAGE_VALUES.has(nextStage) ? nextStage : "all";
      const filter = $("#applications-stage-filter");
      if (filter) filter.value = state.applicationStageFilter;
      renderApplications();
      syncUiStateToUrl();
      return;
    }
    const applicationStageButton = target.closest("button[data-application-stage]");
    if (applicationStageButton) {
      void updateApplicationStage(applicationStageButton);
      return;
    }
    const retryApplications = target.closest("button[data-retry-applications]");
    if (retryApplications) {
      void loadApplications({ force: true });
      return;
    }
    const settingsAction = target.closest("button[data-settings-action]");
    if (settingsAction) {
      clearLocalSettingsData(settingsAction.dataset.settingsAction);
      return;
    }
    const actionButton = target.closest("button[data-listing-action]");
    if (actionButton) { void saveListingAction(actionButton); return; }
    const roleDetailTrigger = target.closest("button[data-open-role-detail]");
    if (roleDetailTrigger) {
      event.preventDefault();
      const row = roleDetailTrigger.closest("[data-listing-key]");
      closeAllMenus();
      if (row) openRoleDetail(row, roleDetailTrigger);
      return;
    }
    const discoverRoles = target.closest("button[data-discover-roles]");
    if (discoverRoles) {
      state.activeView = "roles";
      state.activeTab = "main";
      handleFilterChange();
      return;
    }
    const retryRoles = target.closest("button[data-retry-roles]");
    if (retryRoles) { void ensureRolesLoaded(state.intentRevision); return; }
    const retryDetails = target.closest("button[data-detail-retry]");
    if (retryDetails) {
      const details = retryDetails.closest("details");
      const card = retryDetails.closest("[data-listing-key]");
      if (details && card) void loadRoleDetails(card, details, true);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && $("#add-source-dialog")?.open) {
      event.preventDefault();
      closeAddSourceDialog();
      return;
    }
    if (event.key === "Escape" && document.querySelector(".row-menu-popover:not([hidden]), .menu-popover:not([hidden]), .notification-popover:not([hidden]), .user-menu-popover:not([hidden])")) {
      event.preventDefault();
      closeAllMenus({ restoreFocus: true });
      return;
    }
    if (event.key === "Escape" && $("#role-detail-panel")?.hidden === false) {
      event.preventDefault();
      closeRoleDetail();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#global-search")?.focus();
      return;
    }
    if (!isUndoShortcut(event)) return;
    const target = event.target;
    if (target instanceof Element && target.closest("input, textarea, select, [contenteditable='true']")) return;
    if (state.undoStack.length === 0) return;
    event.preventDefault();
    undoLastListingAction();
  });
  if (typeof window !== "undefined") {
    window.matchMedia?.("(prefers-color-scheme: dark)")?.addEventListener?.("change", () => {
      if (state.settings.theme === "system") applyThemePreference("system");
    });
    window.addEventListener("popstate", () => {
      restoreUiStateFromUrl();
      const view = window.location.hash.slice(1);
      if (view === "applications") openApplicationsView({ updateLocation: false });
      else if (view === "dashboard") openDashboardView({ updateLocation: false });
      else if (view === "analytics") openAnalyticsView({ updateLocation: false });
      else if (view === "sources") openSourcesView({ updateLocation: false });
      else if (view === "watchlist") openWatchlistView({ updateLocation: false });
      else if (view === "settings") openSettingsView({ updateLocation: false });
      else openRolesView({ updateLocation: false });
    });
  }
}

function restoreTheme() {
  const hasDashboardSettings = typeof localStorage !== "undefined" && localStorage.getItem(DASHBOARD_SETTINGS_KEY);
  const savedTheme = !hasDashboardSettings && typeof localStorage !== "undefined" ? localStorage.getItem("roleradar.theme") : null;
  const stored = readDashboardSettings();
  state.settings = normalizeDashboardSettings({ ...stored, ...(savedTheme === "dark" || savedTheme === "light" ? { theme: savedTheme } : {}) });
  state.activeTab = state.settings.defaultTab;
  const defaultStatus = $("#settings-default-status");
  const sortFilter = $("#sort-filter");
  if (defaultStatus) defaultStatus.value = state.settings.defaultStatus;
  if (sortFilter) sortFilter.value = state.settings.defaultSort;
  applyThemePreference(state.settings.theme);
  applyMotionPreference(state.settings.motion);
  renderSettings();
  const hotkey = $("#search-hotkey");
  if (hotkey) hotkey.textContent = /mac/i.test(navigator.platform || navigator.userAgent || "") ? "⌘K" : "Ctrl K";
}

async function initialLoad() {
  restoreTheme();
  restoreUiStateFromUrl();
  // Authentication is an account-control concern. Do not hold the public
  // listings behind a provider round trip: a slow or unavailable auth
  // provider must not leave the role feed on its loading spinner forever.
  // Mutations still await the same shared bootstrap promise when they need a
  // CSRF token, and the subscription below updates the account controls when
  // the session check eventually settles.
  void authClient.bootstrap().catch(() => undefined);
  try {
    state.watchlistRoles = readWatchlistRoles();
    renderWatchlistCount();
    // Open the operating summary immediately. Its data is independent of
    // listing filters, matches, and the first role-page request.
    if (isAnalyticsView()) {
      renderNavigation();
      renderViewChrome();
      await syncAnalytics({ force: true });
      return;
    }
    await loadInitialRoles();
    void syncChanges({ force: true }).catch(() => undefined);
    void prefetchRoleTabs();
    const initialView = typeof window !== "undefined" ? window.location.hash.slice(1) : "";
    if (initialView === "applications" || state.activeView === "applications") openApplicationsView({ updateLocation: false });
    else if (initialView === "dashboard" || state.activeView === "dashboard") openDashboardView({ updateLocation: false });
    else if (initialView === "analytics" || state.activeView === "analytics") openAnalyticsView({ updateLocation: false });
    else if (initialView === "sources" || state.activeView === "sources") openSourcesView({ updateLocation: false });
    else if (initialView === "settings" || state.activeView === "settings") openSettingsView({ updateLocation: false });
    else if (state.activeView === "watchlist") openWatchlistView({ updateLocation: false });
    if (scanIsActive()) {
      state.scanning = true;
      updateScanButton();
      await waitForScanCompletion();
      state.scanning = false;
      updateScanButton();
    }
  } catch (error) {
    if ($("#connection-label")) $("#connection-label").textContent = "Unavailable";
    if ($("#role-list")) $("#role-list").innerHTML = rolesErrorMarkup(error?.message || "Could not load dashboard");
  }
}

if (typeof document !== "undefined") {
  bindEvents();
  authClient.subscribe((authState) => renderAccountIdentity(authState));
  void initialLoad();
  setInterval(() => { void syncChanges(); }, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void syncChanges({ force: true }).catch(() => undefined);
  });
  setInterval(() => {
    if (scanIsActive() && state.data) {
      renderCurrentSource(state.data);
      renderCrawlHealthSummary(state.data);
      renderCrawlRunSummary(state.data);
      renderSources(state.data);
    }
  }, 1_000);
}
