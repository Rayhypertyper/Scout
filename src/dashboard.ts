import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalizeUrl } from "./utils/url.js";
import { MIN_LISTING_SCORE } from "./config/thresholds.js";
import { isAllowedPostingLocation } from "./parsing/locations.js";
import {
  STATIC_CONFIGURED_SOURCES,
  readConfiguredSources as readConfiguredSourceUrls,
  readConfiguredSourcesAtPath as readConfiguredSourceUrlsAtPath,
} from "./config/sourceCatalog.js";
import { visibleProvenanceSources } from "./config/removedSWEJobBoards.js";
import { activeRunMaxDurationMs, RUNNING_SCAN_MAX_AGE_MS } from "./config/runLock.js";
import {
  backfillListingActionIdentities,
  compileListingActionMatcher,
  ensureListingActionSchema,
  listingActionKey,
  mergeListingActionContext,
  readPersistedListingActionIdentities,
  readListingActionIdentities,
  replaceListingActionIdentities,
  type ListingAction,
  type ListingActionRecord,
  type ListingActionContext,
  type ListingType,
} from "./database/actions.js";
import {
  ensureRunCancellationSchema,
  failStaleRunningRuns,
  finalizeCancellationRequests,
  requestRunTermination,
} from "./database/runControl.js";
import { InternshipDatabase } from "./database/db.js";
import {
  applicationStageFromLegacyStatus,
  isApplicationStage,
  legacyApplicationStatusForStage,
  type ApplicationStage,
} from "./domain/applicationStages.js";
import { InternshipSchema, type Internship, type ScoutSettings } from "./domain/schemas.js";
import type { ScoutRunOptions } from "./domain/types.js";
import { resolveSettings } from "./config/settings.js";
import { runScout, type ScoutExecution } from "./scout.js";
import {
  GRIND_JOB_BOARD_SOURCE_URL,
  GrindJobBoardClient,
  grindJobToInternship,
  type GrindJob,
  type GrindJobBoardSnapshot,
} from "./integrations/grindJobBoard.js";
import {
  hasRequiredListingKeywords,
  isListingContentAllowed,
  isListingWorkAuthorizationAllowed,
} from "./output/eligibility.js";
import {
  hasVerifiedLinkedInDestinations,
  readVerifiedLinkedInUrls,
  VerificationReadTimeoutError,
  type VerifiedLinkedInUrlsReadOptions,
} from "./output/linkEligibility.js";
import { normalizeCompanyIdentity } from "./utils/text.js";
import { ROLE_TABS, buildRoleTabKeys, canadianLocationForRole, roleMatchesTab, type RoleTab } from "./dashboardTabs.js";
import { isWithinNewRoleBannerWindow, newRoleBannerCacheKey, readNewListingKeys } from "./dashboardNew.js";
import {
  compareByDashboardSeason,
  dashboardLocalDayKey,
  dashboardPostingAgeKey,
  dashboardPostingDay,
  dashboardRoleHasSeason,
  dashboardRoleSeasons,
  isDashboardPostingTooOld,
  DASHBOARD_SEASON_FILTERS,
  parseDashboardSortDate,
  type DashboardSeason,
} from "./dashboardSort.js";
import { sha256 } from "./utils/hash.js";
import { handleAuthRequest } from "./auth/router.js";
import { writeAuthJson } from "./auth/http.js";
import type { EligibilityEvaluation } from "./eligibility/index.js";
import {
  handlePreferenceRequest,
  loadAuthenticatedMatchPreferences,
} from "./preferences/http.js";
import { evaluateInternshipMatch } from "./preferences/matching.js";
import { ensurePreferenceSchema } from "./preferences/store.js";
import type { InternshipPreferences } from "./preferences/schema.js";
import {
  buildClosingSoonNotifications,
  nextClosingSoonRefreshAt,
  type ClosingSoonNotification,
  type DeadlineNotificationRole,
} from "./dashboardDeadlines.js";

const PROJECT_ROOT = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
const PUBLIC_ROOT = join(PROJECT_ROOT, "public");
const DEFAULT_DATABASE = join(PROJECT_ROOT, "output", "live", "internships.db");
const defaultGrindJobBoardCachePath = join(PROJECT_ROOT, "output", "live", "source-cache", "grind-job-board.json");
const grindJobBoardClient = new GrindJobBoardClient({
  cachePath: process.env.GRIND_JOB_BOARD_CACHE_PATH?.trim() || defaultGrindJobBoardCachePath,
  cacheTtlMs: 5 * 60_000,
});

interface RunRow {
  id: number;
  started_at: string;
  heartbeat_at: string | null;
  finished_at: string | null;
  cancel_requested_at: string | null;
  status: "RUNNING" | "COMPLETED" | "FAILED";
  sources_requested: number;
  sources_settled: number;
  sources_completed: number;
  pages_visited: number;
  potential_postings_inspected: number;
  internships_discovered: number;
  new_count: number;
  updated_count: number;
  unchanged_count: number;
  closed_count: number;
  error_message: string | null;
}

interface InternshipRow {
  payload_json: string;
  lifecycle_status: Internship["lifecycleStatus"];
  availability_status: Internship["availabilityStatus"];
  first_seen_at: string;
  last_seen_at: string;
  last_verified_at: string;
  status_run_id: number;
  miss_count: number;
}

interface FailureRow {
  source_url: string;
  error_type: string;
  status_code: number | null;
  message: string;
  count: number;
}

interface SourceRow {
  url: string;
  last_crawled_at: string | null;
  last_status: string | null;
  is_configured?: number;
}

interface ListingActionRow {
  listing_key: string;
  listing_type: ListingType;
  listing_id: string;
  action: ListingAction;
  company: string;
  normalized_company: string;
  title: string;
  created_at: string;
}

interface ApplicationActionRow extends ListingActionRow {
  application_status: string | null;
  application_stage: string | null;
  application_url: string | null;
  posting_url: string | null;
  job_id: string | null;
  location: string | null;
  payload_json: string | null;
}

interface FastActionContextRow extends ListingActionRow {
  application_url: string | null;
  posting_url: string | null;
  job_id: string | null;
  location: string | null;
}

interface DashboardInternship extends Internship {
  listingType?: ListingType;
  listingId?: string;
  listingSource?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  statusRunId?: number;
  missCount?: number;
}

type DashboardScanStatus = "IDLE" | "RUNNING" | "COMPLETED" | "FAILED";
type DashboardScanTrigger = "startup" | "refresh" | "existing" | null;

interface InProgressSource {
  url: string;
  startedAt: string | null;
}

interface DashboardScanState {
  status: DashboardScanStatus;
  trigger: DashboardScanTrigger;
  startedAt: string | null;
  finishedAt: string | null;
  runId: number | null;
  error: string | null;
  currentSources: InProgressSource[];
}

interface ActiveScan {
  execution: Promise<ScoutExecution | null>;
  cancellation: AbortController;
}

interface QueuedSourceScan {
  databasePath: string;
  settings: ScoutSettings;
  sources: string[];
}

// The dashboard owns the run trigger, while the scout owns crawl execution.
// Keep the seam explicit so startup/manual run-control can be exercised with a
// deterministic runner in tests without ever touching the network.
type DashboardScoutRunner = typeof runScout;
let dashboardScoutRunnerForTests: DashboardScoutRunner | null = null;
type DashboardCrawlLauncher = (options: ScoutRunOptions) => Promise<ScoutExecution | null>;
let dashboardCrawlLauncherForTests: DashboardCrawlLauncher | null = null;

/**
 * The dashboard must remain an HTTP process while a source is crawling. The
 * production runner therefore delegates the network/browser work to a
 * short-lived scout child process. Tests keep using the injectable in-process
 * runner so their deterministic fixtures do not need a compiled worker.
 */
function dashboardCrawlWorkerEntrypoint(): string {
  const siblingWorker = fileURLToPath(new URL("./dashboardWorker.js", import.meta.url));
  if (existsSync(siblingWorker)) return siblingWorker;
  const builtWorker = join(PROJECT_ROOT, "dist", "src", "dashboardWorker.js");
  if (existsSync(builtWorker)) return builtWorker;
  throw new Error(`Dashboard crawl worker is not built: ${builtWorker}`);
}

function launchDashboardCrawlWorker(options: ScoutRunOptions): Promise<ScoutExecution | null> {
  const serializedOptions = JSON.stringify({
    sources: options.sources,
    settings: options.settings,
    filters: options.filters,
  });
  const worker = spawn(process.execPath, [dashboardCrawlWorkerEntrypoint()], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      DASHBOARD_CRAWL_OPTIONS: serializedOptions,
    },
    // Inherit launchd/terminal logs without piping unconsumed crawler output
    // through the dashboard. A full crawl can produce enough diagnostics to
    // fill a pipe and stall the child if stdout is not drained.
    stdio: ["ignore", "inherit", "inherit"],
  });
  const stopWorker = (): void => {
    if (!worker.killed) worker.kill("SIGTERM");
  };
  options.cancellationSignal?.addEventListener("abort", stopWorker, { once: true });
  console.log(`[DASHBOARD CRAWL] Spawned scout worker${worker.pid === undefined ? "" : ` pid=${worker.pid}`}`);
  return new Promise<ScoutExecution | null>((resolve, reject) => {
    let settled = false;
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      options.cancellationSignal?.removeEventListener("abort", stopWorker);
      callback();
    };
    worker.once("error", (error) => settle(() => reject(error)));
    worker.once("exit", (code, signal) => settle(() => {
      if (code === 0) {
        resolve(null);
        return;
      }
      const reason = signal === null ? `exit code ${code ?? "unknown"}` : `signal ${signal}`;
      reject(new Error(`Dashboard crawl worker stopped with ${reason}.`));
    }));
  });
}

let activeScan: ActiveScan | null = null;
let queuedSourceScan: QueuedSourceScan | null = null;
let scanState: DashboardScanState = {
  status: "IDLE",
  trigger: null,
  startedAt: null,
  finishedAt: null,
  runId: null,
  error: null,
  currentSources: [],
};

export function setDashboardScoutRunnerForTests(runner: DashboardScoutRunner | null): void {
  dashboardScoutRunnerForTests = runner;
}

export function setDashboardCrawlLauncherForTests(launcher: DashboardCrawlLauncher | null): void {
  dashboardCrawlLauncherForTests = launcher;
}

export function resetDashboardScanStateForTests(): void {
  activeScan?.cancellation.abort();
  activeScan = null;
  queuedSourceScan = null;
  scanState = {
    status: "IDLE",
    trigger: null,
    startedAt: null,
    finishedAt: null,
    runId: null,
    error: null,
    currentSources: [],
  };
}

type DashboardPayload = Record<string, unknown>;

class DashboardValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DashboardValidationError";
  }
}

interface DashboardDataCache {
  payload: DashboardPayload;
  body: string;
  postingAgeWindow: string;
}

interface DashboardDataRefresh {
  cacheVersion: number;
  forceGrindRefresh: boolean;
  promise: Promise<DashboardPayload>;
}

type FastStatusFilter = "open" | "closed" | "new" | "updated" | "all";
type FastSort = "relevance" | "posted" | "season" | "recent" | "last-seen" | "company";
type FastExperienceView = "all" | "matches";

interface FastInternshipRow extends InternshipRow {
  id: string;
}

interface FastVersionMetadata {
  version: string;
  // Internal cache key for role-card content. Dynamic scan/board status fields
  // remain in `version` and are refreshed on cache hits without reparsing all
  // roles; only content-affecting revisions use this key.
  contentKey: string;
  databaseDataVersion: number | null;
  roleCount: number;
  actionCount: number;
  hiddenCount: number;
  appliedRoleCount: number;
  latestRunId: number | null;
  latestRunStatus: RunRow["status"] | null;
  latestRunHeartbeat: string | null;
  boardLastSuccessfulSyncAt: string | null;
  verificationRevision: string;
}

interface FastRoleRevisionMeta {
  role_count: number | bigint;
  role_verified: string | null;
  role_seen: string | null;
  role_status_run: number | bigint | null;
  role_hash: string | null;
  open_count: number | bigint | null;
  closed_count: number | bigint | null;
  unknown_count: number | bigint | null;
  new_count: number | bigint | null;
  updated_count: number | bigint | null;
  unchanged_count: number | bigint | null;
}

interface FastActionRevisionMeta {
  action_count: number | bigint;
  action_created: string | null;
  hidden_count: number | bigint;
  applied_roles: number | bigint;
}

interface FastDatabaseRevisionSnapshot {
  dataVersion: number | null;
  roleMeta: FastRoleRevisionMeta;
  actionMeta: FastActionRevisionMeta;
  roleRevision: string;
  newListingRevision: string;
  actionRevision: string;
}

interface FastDatabaseRevisionTracker {
  database: DatabaseSync;
  fileIdentity: string;
  snapshot: FastDatabaseRevisionSnapshot | null;
}

interface FastRoleCard {
  id: string;
  listingType: ListingType;
  listingId: string;
  jobId: string | null;
  company: string;
  title: string;
  location: string[];
  canadianLocation: string | null;
  remoteStatus: Internship["remoteStatus"];
  applicationUrl: string;
  postingUrl: string;
  sourceUrl: string;
  sources: string[];
  technologies: string[];
  categories: Internship["categories"];
  relevanceScore: number;
  relevanceReason: string;
  seasons: DashboardSeason[];
  internshipTerm: string | null;
  internshipYear: string | null;
  duration: string | null;
  salary: string | null;
  postingDate: string | null;
  deadline: string | null;
  lifecycleStatus: Internship["lifecycleStatus"];
  availabilityStatus: Internship["availabilityStatus"];
  discoveredAt: string;
  lastVerifiedAt: string;
  firstSeenAt: string;
  lastSeenAt: string;
  statusRunId: number;
  missCount: number;
  isNew: boolean;
  matchScore?: number;
  matchReasons?: string[];
  matchUnknownCount?: number;
  /** Versioned personal-compatibility facts; omitted from public all-role cards. */
  eligibility?: EligibilityEvaluation;
  eligibilityStatus?: EligibilityEvaluation["status"];
  eligibilityVersion?: EligibilityEvaluation["version"];
  eligibilityReasons?: string[];
  eligibilityUnknown?: string[];
}

interface FastRoleEntry {
  key: string;
  role: DashboardInternship;
  card: FastRoleCard;
  searchText: string;
  tabs: Set<RoleTab>;
  isNew: boolean;
}

interface CompactSourceResult {
  url: string;
  settled: number;
  completed: number;
  pages_visited: number;
  potential_postings_inspected: number;
  jobs_discovered: number;
  failure_count: number;
  started_at: string | null;
  duration_ms: number | null;
  status: string;
}

interface DashboardSourceHealth {
  sources: Array<SourceRow & { isConfigured: boolean }>;
  sourceResults: CompactSourceResult[];
  failures: FailureRow[];
  errors24h: number;
}

interface FastDashboardIndex {
  versionMetadata: FastVersionMetadata;
  generatedAt: string;
  entries: FastRoleEntry[];
  tabCounts: Record<RoleTab, number>;
  categories: string[];
  stats: {
    total: number;
    open: number;
    closed: number;
    hidden: number;
    unknown: number;
    new: number;
    updated: number;
    unchanged: number;
  };
  latestRun: RunRow | null;
  latestCompletedRun: RunRow | null;
  runs: RunRow[];
  deadlineNotifications: ClosingSoonNotification[];
  scan: Record<string, unknown>;
  sources: DashboardSourceHealth["sources"];
  sourceResults: CompactSourceResult[];
  failures: FailureRow[];
  errors24h: number;
  appliedRoleCount: number;
}

interface FastRoleDetailRead {
  role: DashboardInternship;
  isNew: boolean;
  version: string;
  generatedAt: string;
}

interface FastRolesQuery {
  view: FastExperienceView;
  tab: RoleTab;
  status: FastStatusFilter;
  category: string | null;
  workMode: Internship["remoteStatus"] | null;
  season: typeof DASHBOARD_SEASON_FILTERS[number] | null;
  location: string | null;
  search: string;
  sort: FastSort;
  limit: number;
  offset: number;
  relativeBase: number;
}

interface FastDashboardIndexReadOptions {
  startBackgroundBoardRefresh?: boolean;
  verification?: VerificationSnapshotReadOptions;
}

let fastDashboardIndexCache: { key: string; index: FastDashboardIndex } | null = null;
const fastDashboardIndexInflight = new Map<string, Promise<FastDashboardIndex>>();
const FAST_FILTERED_PAGE_CACHE_MAX = 24;
const fastFilteredPageCache = new Map<string, FastRoleEntry[]>();
const postRunFastDashboardPrewarms = new Map<string, Promise<boolean>>();
const postRunFastDashboardPrewarmActiveKeys = new Map<string, string>();
const postRunFastDashboardPrewarmSuccessfulKeys = new Map<string, string>();
const postRunFastDashboardPrewarmPendingKeys = new Map<string, string>();

interface FastPrewarmRevision {
  databasePath: string;
  fileIdentity: string | null;
  databaseDataVersion: number | null;
  contentKey: string;
  latestRunId: number | null;
  latestRunStatus: RunRow["status"] | null;
  latestRunHeartbeat: string | null;
}

let latestSuccessfulFastPrewarm: FastPrewarmRevision | null = null;

interface DashboardRunWatcher {
  databasePath: string;
  database: DatabaseSync | null;
  fileIdentity: string | null;
  interval: ReturnType<typeof setInterval> | null;
  initialized: boolean;
  startedWithFile: boolean;
  lastObservedRunId: number | null;
  lastObservedRunStatus: string | null;
  lastTerminalKey: string | null;
  lastErrorAt: number;
  suppressScheduling: boolean;
}

interface DashboardRunWatcherRow {
  id: number;
  status: string;
}

const DASHBOARD_RUN_WATCH_INTERVAL_MS = 2_000;
let dashboardRunWatcher: DashboardRunWatcher | null = null;

function dashboardDatabaseFileIdentity(databasePath: string): string | null {
  try {
    const stat = statSync(databasePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return null;
  }
}

function closeDashboardRunWatcherDatabase(watcher: DashboardRunWatcher): void {
  if (watcher.database === null) return;
  try {
    watcher.database.close();
  } catch {
    // A replaced/closed database handle is already safe to discard.
  }
  watcher.database = null;
}

function reportDashboardRunWatcherError(watcher: DashboardRunWatcher, error: unknown): void {
  const now = Date.now();
  if (now - watcher.lastErrorAt < 30_000) return;
  watcher.lastErrorAt = now;
  console.error(`[DASHBOARD RUN WATCHER] ${error instanceof Error ? error.message : String(error)}`);
}

function pollDashboardRunWatcher(watcher: DashboardRunWatcher): void {
  if (dashboardRunWatcher !== watcher) return;
  const fileIdentity = dashboardDatabaseFileIdentity(watcher.databasePath);
  if (fileIdentity === null) {
    closeDashboardRunWatcherDatabase(watcher);
    watcher.fileIdentity = null;
    return;
  }

  // A path can disappear while a scout process atomically replaces its DB.
  // Treat reappearance after a valid baseline as a new generation even when
  // the filesystem reuses the old inode.
  const replaced = (watcher.fileIdentity !== null && watcher.fileIdentity !== fileIdentity)
    || (watcher.fileIdentity === null && watcher.initialized);
  if (replaced) {
    closeDashboardRunWatcherDatabase(watcher);
    watcher.lastTerminalKey = null;
    watcher.lastObservedRunId = null;
    watcher.lastObservedRunStatus = null;
    watcher.initialized = true;
  }
  watcher.fileIdentity = fileIdentity;

  try {
    const staleIds = failStaleRunningRuns(watcher.databasePath);
    if (staleIds.length > 0) closeDashboardRunWatcherDatabase(watcher);
  } catch (error) {
    reportDashboardRunWatcherError(watcher, error);
  }

  if (watcher.database === null) {
    try {
      watcher.database = new DatabaseSync(watcher.databasePath, { readOnly: true });
      watcher.database.exec("PRAGMA busy_timeout = 500");
    } catch (error) {
      watcher.database = null;
      reportDashboardRunWatcherError(watcher, error);
      return;
    }
  }

  let latestRun: DashboardRunWatcherRow | undefined;
  try {
    latestRun = watcher.database.prepare(`
      SELECT id, status
      FROM crawl_runs
      ORDER BY id DESC
      LIMIT 1
    `).get() as unknown as DashboardRunWatcherRow | undefined;
  } catch (error) {
    // Missing legacy tables and transient SQLite busy/replace errors are
    // recoverable; keep the watcher alive and retry on the next cadence.
    reportDashboardRunWatcherError(watcher, error);
    if (replaced) closeDashboardRunWatcherDatabase(watcher);
    return;
  }

  let terminalRunsSinceLastPoll: DashboardRunWatcherRow[] = [];
  let runCursorReadSucceeded = watcher.lastObservedRunId === null;
  if (watcher.lastObservedRunId !== null) {
    try {
      terminalRunsSinceLastPoll = watcher.database.prepare(`
        SELECT id, status
        FROM crawl_runs
        WHERE id > @lastObservedRunId
          AND status IN ('COMPLETED', 'FAILED')
        ORDER BY id ASC
      `).all({ lastObservedRunId: watcher.lastObservedRunId }) as unknown as DashboardRunWatcherRow[];
      runCursorReadSucceeded = true;
    } catch (error) {
      // A legacy schema can expose the latest row while rejecting the cursor
      // query during a migration. Keep the latest-row observation useful and
      // retry the cursor on the next cadence.
      reportDashboardRunWatcherError(watcher, error);
    }
  }

  const latestTerminal = latestRun !== undefined
    && (latestRun.status === "COMPLETED" || latestRun.status === "FAILED")
    ? latestRun
    : null;
  const latestIsTerminal = latestTerminal !== null;
  if (latestTerminal !== null
    && watcher.lastObservedRunId === latestTerminal.id
    && watcher.lastObservedRunStatus !== latestTerminal.status) {
    // The run id stayed constant but its durable lifecycle changed from
    // RUNNING to a terminal state between polls.
    terminalRunsSinceLastPoll.push(latestTerminal);
  }
  if (latestTerminal !== null && watcher.lastObservedRunId === null && !watcher.startedWithFile) {
    // No startup prewarm could have succeeded while the database path was
    // absent. Its first valid terminal snapshot is therefore a real warmup
    // event rather than a startup baseline.
    terminalRunsSinceLastPoll.push(latestTerminal);
  }
  if (replaced && latestTerminal !== null) {
    // An atomic replacement can contain the same terminal run id with a
    // different role/action snapshot. Force a new generation prewarm.
    terminalRunsSinceLastPoll.push(latestTerminal);
  }

  const terminal = terminalRunsSinceLastPoll.at(-1) ?? null;
  const terminalKey = terminal === null ? null : `run:${terminal.id}`;
  // A replaced database can contain the same terminal run id with a newer
  // durable role/action snapshot. Treat that file generation as a distinct
  // prewarm key; ordinary progress/heartbeat writes keep the stable run key
  // and therefore remain intentionally ignored.
  const observedTerminalKey = terminalKey === null
    ? null
    : replaced
      ? `${terminalKey}:file:${fileIdentity}`
      : terminalKey;
  if (observedTerminalKey !== null && observedTerminalKey !== watcher.lastTerminalKey) {
    const shouldSchedule = watcher.initialized || replaced || !watcher.startedWithFile;
    watcher.lastTerminalKey = observedTerminalKey;
    if (shouldSchedule && !watcher.suppressScheduling) {
      schedulePostRunFastDashboardPrewarm(watcher.databasePath, observedTerminalKey);
    }
  } else if (!latestIsTerminal) {
    // A fresh RUNNING row is intentionally not a content invalidation. Clear
    // the prior terminal key so this run's eventual terminal transition is
    // observed, while repeated heartbeat/progress polls remain no-ops.
    watcher.lastTerminalKey = null;
  }
  if (latestRun !== undefined && runCursorReadSucceeded) {
    watcher.lastObservedRunId = latestRun.id;
    watcher.lastObservedRunStatus = latestRun.status;
  }
  watcher.initialized = true;
}

function createDashboardRunWatcher(databasePath: string, suppressScheduling: boolean): DashboardRunWatcher {
  stopDashboardRunWatcher();
  const startedWithFile = dashboardDatabaseFileIdentity(databasePath) !== null;
  const watcher: DashboardRunWatcher = {
    databasePath,
    database: null,
    fileIdentity: null,
    interval: null,
    initialized: false,
    startedWithFile,
    lastObservedRunId: null,
    lastObservedRunStatus: null,
    lastTerminalKey: null,
    lastErrorAt: 0,
    suppressScheduling,
  };
  dashboardRunWatcher = watcher;
  pollDashboardRunWatcher(watcher);
  return watcher;
}

function armDashboardRunWatcher(watcher: DashboardRunWatcher): void {
  if (dashboardRunWatcher !== watcher) return;
  const interval = setInterval(() => pollDashboardRunWatcher(watcher), DASHBOARD_RUN_WATCH_INTERVAL_MS);
  interval.unref?.();
  watcher.interval = interval;
}

function startDashboardRunWatcher(databasePath: string): void {
  const existing = dashboardRunWatcher;
  if (existing !== null && existing.databasePath === databasePath) {
    const currentIdentity = dashboardDatabaseFileIdentity(databasePath);
    const sameGeneration = currentIdentity === null
      || existing.fileIdentity === null
      || currentIdentity === existing.fileIdentity;
    if (sameGeneration) {
      // Startup preparation already created and armed this watcher. Reuse its
      // read handle/cursor/timer so the listener callback cannot erase a
      // terminal commit observed by the preparation reconciliation.
      existing.suppressScheduling = false;
      if (existing.interval === null) armDashboardRunWatcher(existing);
      // The listener callback can run after a durable scout commit but before
      // the next cadence tick. Poll once at handoff so the first request can
      // share the already-scheduled bounded prewarm instead of rebuilding the
      // compact index on its own. This is synchronous only for the watcher’s
      // short, busy-timeout-bounded run projection query; the index prewarm
      // remains fire-and-forget and is deduped by the existing maps.
      pollDashboardRunWatcher(existing);
      return;
    }
  }
  const watcher = createDashboardRunWatcher(databasePath, false);
  armDashboardRunWatcher(watcher);
}

function stopDashboardRunWatcher(): void {
  const watcher = dashboardRunWatcher;
  if (watcher === null) return;
  dashboardRunWatcher = null;
  if (watcher.interval !== null) clearInterval(watcher.interval);
  watcher.interval = null;
  closeDashboardRunWatcherDatabase(watcher);
}

export function startDashboardRunWatcherForTests(databasePath: string): void {
  startDashboardRunWatcher(databasePath);
}

export async function prepareDashboardRunWatcherForTests(
  databasePath: string,
  startupPrewarmSucceeded = true,
): Promise<void> {
  await prepareDashboardRunWatcherAfterPrewarm(databasePath, startupPrewarmSucceeded);
}

export function pollDashboardRunWatcherForTests(): void {
  if (dashboardRunWatcher !== null) pollDashboardRunWatcher(dashboardRunWatcher);
}

export function stopDashboardRunWatcherForTests(): void {
  stopDashboardRunWatcher();
}

export function getDashboardRunWatcherStateForTests(): { running: boolean; hasDatabase: boolean; hasTimer: boolean; fileIdentity: string | null } {
  return {
    running: dashboardRunWatcher !== null,
    hasDatabase: dashboardRunWatcher?.database !== null && dashboardRunWatcher?.database !== undefined,
    hasTimer: dashboardRunWatcher?.interval !== null && dashboardRunWatcher?.interval !== undefined,
    fileIdentity: dashboardRunWatcher?.fileIdentity ?? null,
  };
}

function readDashboardStartupRevision(databasePath: string): FastPrewarmRevision | null {
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    database.exec("PRAGMA busy_timeout = 500");
    let latestRunId: number | null = null;
    let latestRunStatus: RunRow["status"] | null = null;
    let latestRunHeartbeat: string | null = null;
    try {
      const row = database.prepare(`
        SELECT id, status, heartbeat_at
        FROM crawl_runs
        ORDER BY id DESC
        LIMIT 1
      `).get() as unknown as { id: number; status: string; heartbeat_at: string | null } | undefined;
      if (row !== undefined) {
        latestRunId = row.id;
        latestRunStatus = row.status === "RUNNING" || row.status === "COMPLETED" || row.status === "FAILED"
          ? row.status
          : null;
        latestRunHeartbeat = row.heartbeat_at ?? null;
      }
    } catch {
      // Legacy stores may not have crawl_runs or heartbeat_at yet. The
      // database revision/file identity still provide a safe best-effort
      // startup boundary, while the normal request path remains authoritative.
      try {
        const row = database.prepare(`
          SELECT id, status
          FROM crawl_runs
          ORDER BY id DESC
          LIMIT 1
        `).get() as unknown as { id: number; status: string } | undefined;
        if (row !== undefined) {
          latestRunId = row.id;
          latestRunStatus = row.status === "RUNNING" || row.status === "COMPLETED" || row.status === "FAILED"
            ? row.status
            : null;
        }
      } catch {
        // Keep the revision unavailable when the legacy schema has no run
        // table at all; startup will still arm the watcher for recovery.
      }
    }
    return {
      databasePath,
      fileIdentity: dashboardDatabaseFileIdentity(databasePath),
      databaseDataVersion: currentFastDatabaseDataVersion(databasePath, database),
      contentKey: "",
      latestRunId,
      latestRunStatus,
      latestRunHeartbeat,
    };
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function startupPrewarmRevisionIsCurrent(expected: FastPrewarmRevision): boolean | null {
  const current = readDashboardStartupRevision(expected.databasePath);
  if (current === null) return null;
  if (expected.fileIdentity !== current.fileIdentity) return false;
  if (expected.databaseDataVersion !== null && current.databaseDataVersion !== null
    && expected.databaseDataVersion !== current.databaseDataVersion) return false;
  if (expected.latestRunId !== current.latestRunId
    || expected.latestRunStatus !== current.latestRunStatus
    || expected.latestRunHeartbeat !== current.latestRunHeartbeat) return false;
  return true;
}

const STARTUP_PREWARM_RECONCILE_MAX_ATTEMPTS = 2;

async function prepareDashboardRunWatcherAfterPrewarm(
  databasePath: string,
  startupPrewarmSucceeded: boolean,
): Promise<void> {
  consumeFastStartupWatcherBaselineGapTestHook();
  const watcher = createDashboardRunWatcher(databasePath, true);
  try {
    let reconciliationAttempts = 0;
    if (startupPrewarmSucceeded) {
      while (reconciliationAttempts < STARTUP_PREWARM_RECONCILE_MAX_ATTEMPTS) {
        const expected = latestSuccessfulFastPrewarm?.databasePath === databasePath
          ? latestSuccessfulFastPrewarm
          : null;
        if (expected === null) break;
        const beforeBaseline = startupPrewarmRevisionIsCurrent(expected);
        if (beforeBaseline === false) {
          reconciliationAttempts += 1;
          const refreshed = await prewarmFastDashboardIndex(databasePath, "STARTUP RECONCILE");
          if (!refreshed) break;
          continue;
        }
        // Capture the baseline while scheduling is suppressed, then check
        // again. A commit after the first revision read but before baseline
        // must still receive a prewarm before listener readiness.
        pollDashboardRunWatcher(watcher);
        consumeFastStartupWatcherAfterBaselineTestHook();
        const afterBaseline = startupPrewarmRevisionIsCurrent(expected);
        if (afterBaseline !== false) break;
        reconciliationAttempts += 1;
        const refreshed = await prewarmFastDashboardIndex(databasePath, "STARTUP RECONCILE");
        if (!refreshed) break;
      }
    }
    // Refresh the suppressed baseline after reconciliation so a commit in
    // the prewarm→baseline gap is represented by the watcher without causing
    // a duplicate background rebuild. The loop above already captured the
    // normal baseline; this final poll is intentionally cheap for fallback
    // and legacy schemas where no prewarm revision was available.
    pollDashboardRunWatcher(watcher);
    if (startupPrewarmSucceeded && reconciliationAttempts < STARTUP_PREWARM_RECONCILE_MAX_ATTEMPTS) {
      const expected = latestSuccessfulFastPrewarm?.databasePath === databasePath
        ? latestSuccessfulFastPrewarm
        : null;
      if (expected !== null && startupPrewarmRevisionIsCurrent(expected) === false) {
        reconciliationAttempts += 1;
        const refreshed = await prewarmFastDashboardIndex(databasePath, "STARTUP RECONCILE");
        if (refreshed) pollDashboardRunWatcher(watcher);
      }
    }
  } catch (error) {
    console.error(`[DASHBOARD STARTUP RECONCILE FAILED] ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    watcher.suppressScheduling = false;
    armDashboardRunWatcher(watcher);
  }
}

// PRAGMA data_version is only useful when observed on a connection that stays
// open: a new connection starts at its own baseline.  Keep one read-only
// tracker per database path so writes from scout, dashboard actions, or other
// processes invalidate the expensive row-hash revision work immediately.
const fastDatabaseRevisionTrackers = new Map<string, FastDatabaseRevisionTracker>();

function closeFastDatabaseRevisionTrackers(): void {
  for (const tracker of fastDatabaseRevisionTrackers.values()) {
    try {
      tracker.database.close();
    } catch {
      // A replaced/closed database handle is already safe to discard.
    }
  }
  fastDatabaseRevisionTrackers.clear();
}

export function closeFastRevisionTrackersForTests(): void {
  closeFastDatabaseRevisionTrackers();
}

export function clearFastDashboardCacheForTests(): void {
  fastDashboardIndexCache = null;
  fastDashboardIndexInflight.clear();
  fastFilteredPageCache.clear();
  latestSuccessfulFastPrewarm = null;
}

class FastSnapshotChangedError extends Error {
  constructor() {
    super("Dashboard data changed while reading a snapshot");
    this.name = "FastSnapshotChangedError";
  }
}

// A one-shot hook keeps the race regression deterministic without adding a
// production delay or changing the public HTTP contract. It is intentionally
// test-only; normal callers never install it.
let fastSnapshotReadTestHook: (() => void) | null = null;
// A separate one-shot hook targets the narrower run-progress race: a test can
// commit a pages/heartbeat/status update after the initial latest-run query but
// before the SQLite revision stamp is captured. Production callers never set
// this hook.
let fastRunRevisionCaptureTestHook: (() => void) | null = null;
// Test-only startup sequencing hook: it fires after prewarm completion and
// immediately before the suppressed watcher baseline, reproducing the exact
// handoff window without delaying production startup.
let fastStartupWatcherBaselineGapTestHook: (() => void) | null = null;
let fastStartupWatcherAfterBaselineTestHook: (() => void) | null = null;
let fastDashboardIndexBuildTestHook: (() => void) | null = null;

export function setFastSnapshotReadHookForTests(hook: (() => void) | null): void {
  fastSnapshotReadTestHook = hook;
}

export function setFastRunRevisionCaptureHookForTests(hook: (() => void) | null): void {
  fastRunRevisionCaptureTestHook = hook;
}

export function setFastStartupWatcherBaselineGapHookForTests(hook: (() => void) | null): void {
  fastStartupWatcherBaselineGapTestHook = hook;
}

export function setFastStartupWatcherAfterBaselineHookForTests(hook: (() => void) | null): void {
  fastStartupWatcherAfterBaselineTestHook = hook;
}

export function setFastDashboardIndexBuildHookForTests(hook: (() => void) | null): void {
  fastDashboardIndexBuildTestHook = hook;
}

function consumeFastSnapshotReadTestHook(): void {
  const hook = fastSnapshotReadTestHook;
  fastSnapshotReadTestHook = null;
  hook?.();
}

function consumeFastRunRevisionCaptureTestHook(): void {
  const hook = fastRunRevisionCaptureTestHook;
  fastRunRevisionCaptureTestHook = null;
  hook?.();
}

function consumeFastStartupWatcherBaselineGapTestHook(): void {
  const hook = fastStartupWatcherBaselineGapTestHook;
  fastStartupWatcherBaselineGapTestHook = null;
  hook?.();
}

function consumeFastStartupWatcherAfterBaselineTestHook(): void {
  const hook = fastStartupWatcherAfterBaselineTestHook;
  fastStartupWatcherAfterBaselineTestHook = null;
  hook?.();
}

interface VerificationSnapshot {
  path: string;
  revision: string;
  urls: Set<string> | null;
}

interface VerificationSnapshotReadOptions extends VerifiedLinkedInUrlsReadOptions {
  // Startup prewarm reads are intentionally kept out of the request-shared
  // promise map. A stalled artifact must never make a later HTTP request wait
  // on abandoned startup work.
  coalesce?: boolean;
  failOnTimeout?: boolean;
}

let verificationSnapshotCache: VerificationSnapshot | null = null;
const verificationSnapshotInflight = new Map<string, Promise<VerificationSnapshot>>();
const FAST_VERIFICATION_READ_TIMEOUT_MS = 5_000;
let fastPrewarmTimeoutOverrideForTests: number | null = null;
let fastVerificationReadTimeoutOverrideForTests: number | null = null;

export function setFastPrewarmTimeoutForTests(timeoutMs: number | null): void {
  fastPrewarmTimeoutOverrideForTests = timeoutMs;
}

export function setFastVerificationReadTimeoutForTests(timeoutMs: number | null): void {
  fastVerificationReadTimeoutOverrideForTests = timeoutMs;
}

export function getVerificationSnapshotInflightSizeForTests(): number {
  return verificationSnapshotInflight.size;
}

export function clearVerificationSnapshotCacheForTests(): void {
  verificationSnapshotCache = null;
}

let dashboardDataCache: DashboardDataCache | null = null;
let dashboardDataRefresh: DashboardDataRefresh | null = null;
let dashboardDataCacheVersion = 0;
let backgroundGrindRefresh: Promise<GrindJobBoardSnapshot> | null = null;

function liveBoardReadsAllowed(): boolean {
  return process.env.DASHBOARD_SKIP_LIVE_BOARD !== "1";
}

function readBoardSnapshot(forceRefresh = false): Promise<GrindJobBoardSnapshot> {
  // Tests, offline dashboard mode, and deployments that explicitly separate
  // crawler/network work must never turn a display or action request into a
  // live-board call. The cached projection remains a valid stale snapshot.
  if (!liveBoardReadsAllowed()) return Promise.resolve(grindJobBoardClient.getCachedSnapshot());
  return grindJobBoardClient.getSnapshot(forceRefresh);
}

function asRun(row: RunRow | undefined): RunRow | null {
  return row ?? null;
}

function activeScanIsLive(): boolean {
  return activeScan !== null && !activeScan.cancellation.signal.aborted;
}

function cancelActiveScan(): void {
  if (!activeScanIsLive()) return;
  activeScan?.cancellation.abort();
}

function recordFinalizedCancellations(runIds: number[]): void {
  if (runIds.length === 0) return;
  cancelActiveScan();
  const finishedAt = new Date().toISOString();
  scanState = {
    ...scanState,
    status: "FAILED",
    finishedAt,
    runId: runIds[0] ?? scanState.runId,
    error: "Terminated by user.",
    currentSources: [],
  };
  invalidateDashboardDataCache();
}

interface JsonResponseOptions {
  request?: IncomingMessage;
  etag?: string;
  cacheControl?: string;
  head?: boolean;
}

function encodingQuality(request: IncomingMessage | undefined, encoding: "br" | "gzip"): number {
  const header = request?.headers["accept-encoding"];
  if (typeof header !== "string") return 0;
  let wildcard: number | null = null;
  let explicit: number | null = null;
  for (const item of header.split(",")) {
    const [rawName, ...parameters] = item.trim().toLocaleLowerCase().split(";");
    const name = (rawName ?? "").trim();
    if (!name) continue;
    const qParameter = parameters.find((parameter) => parameter.trim().startsWith("q="));
    const parsedQuality = qParameter ? Number.parseFloat(qParameter.trim().slice(2)) : 1;
    const quality = Number.isFinite(parsedQuality) ? Math.max(0, Math.min(1, parsedQuality)) : 0;
    if (name === encoding) explicit = quality;
    if (name === "*") wildcard = quality;
  }
  return explicit ?? wildcard ?? 0;
}

function chooseEncoding(request: IncomingMessage | undefined): "br" | "gzip" | null {
  const brQuality = encodingQuality(request, "br");
  const gzipQuality = encodingQuality(request, "gzip");
  if (brQuality <= 0 && gzipQuality <= 0) return null;
  if (brQuality >= gzipQuality && brQuality > 0) return "br";
  return gzipQuality > 0 ? "gzip" : null;
}

function normalizedEtag(value: string): string {
  return value.trim().replace(/^W\//i, "");
}

function etagMatches(request: IncomingMessage | undefined, etag: string | undefined): boolean {
  if (!etag) return false;
  const header = request?.headers["if-none-match"];
  if (typeof header !== "string") return false;
  const target = normalizedEtag(etag);
  return header.split(",").map((value) => value.trim()).some((value) => value === "*" || normalizedEtag(value) === target);
}

function weakEtag(value: string): string {
  const normalized = value.trim();
  return normalized.startsWith("W/") ? normalized : `W/${normalized}`;
}

function jsonResponseBody(
  response: ServerResponse,
  status: number,
  body: string,
  options: JsonResponseOptions = {},
): void {
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": options.cacheControl ?? "no-store",
  };
  if (options.etag) headers.ETag = weakEtag(options.etag);
  if (options.request) headers.Vary = "Accept-Encoding";
  let bodyBuffer = Buffer.from(body, "utf8");
  if (etagMatches(options.request, options.etag)) {
    // A 304 has no payload; omit payload framing and content coding rather
    // than claiming a length for the request-dependent JSON representation.
    response.writeHead(304, headers);
    response.end();
    return;
  }
  const selectedEncoding = bodyBuffer.length >= 1_024 ? chooseEncoding(options.request) : null;
  if (selectedEncoding === "br") {
    bodyBuffer = brotliCompressSync(bodyBuffer);
    headers["Content-Encoding"] = "br";
  } else if (selectedEncoding === "gzip") {
    bodyBuffer = gzipSync(bodyBuffer);
    headers["Content-Encoding"] = "gzip";
  }
  headers["Content-Length"] = String(bodyBuffer.byteLength);
  response.writeHead(status, headers);
  if (options.head || options.request?.method === "HEAD") response.end();
  else response.end(bodyBuffer);
}

function jsonResponse(
  response: ServerResponse,
  status: number,
  payload: unknown,
  options: JsonResponseOptions = {},
): void {
  jsonResponseBody(response, status, JSON.stringify(payload), options);
}

function cacheDashboardData(payload: DashboardPayload): DashboardPayload {
  dashboardDataCache = {
    payload,
    body: JSON.stringify(payload),
    postingAgeWindow: dashboardPostingAgeKey(),
  };
  return payload;
}

function invalidateDashboardDataCache(): void {
  dashboardDataCache = null;
  dashboardDataCacheVersion += 1;
  // Listing actions are durable writes too. Drop the compact index and its
  // filtered pages immediately so the next role/status request cannot reuse a
  // pre-action count or visible role while the revision tracker catches up.
  fastDashboardIndexCache = null;
  fastFilteredPageCache.clear();
}

export function clearDashboardDataCacheForTests(): void {
  invalidateDashboardDataCache();
}

function startBackgroundGrindRefresh(): void {
  if (!liveBoardReadsAllowed()) return;
  if (backgroundGrindRefresh !== null || grindJobBoardClient.isSnapshotFresh()) return;
  // A durable board cache carries the timestamp of its last successful sync,
  // but the integration intentionally treats a process restart as stale so a
  // caller can explicitly refresh it.  For dashboard display, a recent cache
  // is already a coherent local projection; starting a forced network refresh
  // during the first roles request would otherwise change only board status /
  // attempt metadata and invalidate the freshly-built index before search.
  // Revalidation resumes once that same cache TTL has elapsed.
  const cachedBoard = grindJobBoardClient.getCachedSnapshot();
  const cachedAt = cachedBoard.lastSuccessfulSyncAt === null
    ? Number.NaN
    : Date.parse(cachedBoard.lastSuccessfulSyncAt);
  const cacheAgeMs = Date.now() - cachedAt;
  const cacheTtlMs = Math.max(1, cachedBoard.cacheTtlMinutes) * 60_000;
  if (Number.isFinite(cachedAt) && cacheAgeMs >= 0 && cacheAgeMs < cacheTtlMs) return;
  backgroundGrindRefresh = grindJobBoardClient.getSnapshot(true)
    .catch((error: unknown) => {
      console.error(`[DASHBOARD BOARD REFRESH FAILED] ${error instanceof Error ? error.message : String(error)}`);
      return grindJobBoardClient.getCachedSnapshot();
    })
    .finally(() => {
      backgroundGrindRefresh = null;
    });
}

function startDashboardDataRefresh(databasePath: string, forceGrindRefresh = false): Promise<DashboardPayload> {
  if (dashboardDataRefresh !== null) {
    const isCurrentVersion = dashboardDataRefresh.cacheVersion === dashboardDataCacheVersion;
    if (isCurrentVersion && (!forceGrindRefresh || dashboardDataRefresh.forceGrindRefresh)) return dashboardDataRefresh.promise;
    return dashboardDataRefresh.promise.then(() => startDashboardDataRefresh(databasePath, forceGrindRefresh));
  }

  const refreshVersion = dashboardDataCacheVersion;
  const refreshPromise = readDashboardData(databasePath, forceGrindRefresh)
    .then((payload) => {
      if (refreshVersion === dashboardDataCacheVersion) cacheDashboardData(payload);
      return payload;
    })
    .finally(() => {
      if (dashboardDataRefresh?.promise === refreshPromise) dashboardDataRefresh = null;
    });
  dashboardDataRefresh = { cacheVersion: refreshVersion, forceGrindRefresh, promise: refreshPromise };
  return refreshPromise;
}

function startBackgroundDashboardDataRefresh(databasePath: string): void {
  void startDashboardDataRefresh(databasePath).catch((error: unknown) => {
    console.error(`[DASHBOARD DATA REFRESH FAILED] ${error instanceof Error ? error.message : String(error)}`);
  });
}

function dashboardVerificationPath(): string {
  return join(outputDirectory, "final-report", "link-verification.json");
}

function verificationRevision(path: string): string {
  try {
    const stat = statSync(path);
    const modifiedNs = (stat as typeof stat & { mtimeNs?: bigint }).mtimeNs;
    const modified = typeof modifiedNs === "bigint" ? modifiedNs.toString() : String(stat.mtimeMs);
    return `${modified}:${stat.size}`;
  } catch {
    return "missing";
  }
}

async function readVerificationSnapshot(options: VerificationSnapshotReadOptions = {}): Promise<VerificationSnapshot> {
  const path = dashboardVerificationPath();
  const revision = verificationRevision(path);
  if (verificationSnapshotCache?.path === path && verificationSnapshotCache.revision === revision) {
    return verificationSnapshotCache;
  }
  const key = `${path}:${revision}`;
  const coalesce = options.coalesce !== false;
  if (coalesce) {
    const existing = verificationSnapshotInflight.get(key);
    if (existing) return existing;
  }
  const promise = (async (): Promise<VerificationSnapshot> => {
    let observedRevision = revision;
    let urls: Set<string> | null = null;
    let timedOut = false;
    // Avoid mixing a parsed verifier result with a revision from a concurrent
    // report write. A second read is rare (only while the artifact changes)
    // and keeps list/detail snapshots coherent.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const verificationReadOptions: VerifiedLinkedInUrlsReadOptions = {
          timeoutMs: options.timeoutMs
            ?? fastVerificationReadTimeoutOverrideForTests
            ?? FAST_VERIFICATION_READ_TIMEOUT_MS,
        };
        if (options.signal !== undefined) verificationReadOptions.signal = options.signal;
        urls = await readVerifiedLinkedInUrls(path, verificationReadOptions);
      } catch (error) {
        if (!(error instanceof VerificationReadTimeoutError) || options.failOnTimeout) throw error;
        // Missing, malformed, and unreadable verification artifacts have
        // always been a valid null projection. Preserve that behavior for a
        // request deadline, but do not cache it: a repaired artifact must be
        // observable on the next request without relying on mtime changes.
        urls = null;
        timedOut = true;
        break;
      }
      const afterReadRevision = verificationRevision(path);
      if (afterReadRevision === observedRevision || attempt === 2) {
        const snapshot = { path, revision: afterReadRevision, urls };
        if (!timedOut) verificationSnapshotCache = snapshot;
        return snapshot;
      }
      observedRevision = afterReadRevision;
    }
    // The loop always returns, but retain a defensive fallback for future
    // changes to the retry bound.
    const snapshot = { path, revision: timedOut ? verificationRevision(path) : observedRevision, urls };
    if (!timedOut) verificationSnapshotCache = snapshot;
    return snapshot;
  })()
    .finally(() => {
      if (verificationSnapshotInflight.get(key) === promise) verificationSnapshotInflight.delete(key);
    });
  if (coalesce) verificationSnapshotInflight.set(key, promise);
  return promise;
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html; charset=utf-8";
  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (path.endsWith(".css")) return "text/css; charset=utf-8";
  if (path.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void> {
  const relativePath = pathname === "/"
    ? "landing.html"
    : pathname === "/jobs" || pathname === "/jobs/"
      ? "index.html"
      : pathname.replace(/^\/+/, "");
  if (relativePath.includes("..") || relativePath.includes("\\")) {
    jsonResponse(response, 400, { error: "Invalid path" }, { request });
    return;
  }
  const filePath = join(PUBLIC_ROOT, relativePath);
  try {
    let body = await readFile(filePath);
    if (relativePath === "index.html") {
      const appVersion = sha256((await readFile(join(PUBLIC_ROOT, "app.js"))).toString("utf8")).slice(0, 12);
      const cssVersion = sha256((await readFile(join(PUBLIC_ROOT, "styles.css"))).toString("utf8")).slice(0, 12);
      body = Buffer.from(
        body.toString("utf8")
          .replaceAll('href="/styles.css"', `href="/styles.css?v=${cssVersion}"`)
          .replaceAll('src="/app.js"', `src="/app.js?v=${appVersion}"`),
        "utf8",
      );
    } else if (relativePath === "landing.html") {
      const appVersion = sha256((await readFile(join(PUBLIC_ROOT, "landing.js"))).toString("utf8")).slice(0, 12);
      const cssVersion = sha256((await readFile(join(PUBLIC_ROOT, "landing.css"))).toString("utf8")).slice(0, 12);
      body = Buffer.from(
        body.toString("utf8")
          .replaceAll('href="/landing.css"', `href="/landing.css?v=${cssVersion}"`)
          .replaceAll('src="/landing.js"', `src="/landing.js?v=${appVersion}"`),
        "utf8",
      );
    }
    response.writeHead(200, {
      "Content-Type": contentType(filePath),
      "Cache-Control": relativePath.endsWith(".html") ? "no-store" : "no-cache",
      "Content-Length": String(body.byteLength),
    });
    if (request.method === "HEAD") response.end();
    else response.end(body);
  } catch {
    jsonResponse(response, 404, { error: "Not found" }, { request });
  }
}

type RunLease = Pick<RunRow, "id" | "started_at" | "status" | "heartbeat_at" | "cancel_requested_at">;
type LatestRun = RunLease & Pick<RunRow, "sources_requested">;

function readRunningRun(databasePath: string): LatestRun | null {
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    // Keep the lightweight run projection aligned with readDashboardRuns.
    // Older stores may not have either lease column yet, so project explicit
    // NULL aliases rather than falling back to an object with undefined
    // cancellation state. `undefined !== null` would incorrectly advertise
    // a termination request on every active refresh response.
    const heartbeatColumn = runHeartbeatColumn(database);
    const cancelRequestedColumn = runCancelRequestedColumn(database);
    const row = database.prepare(`
      SELECT id, started_at, status, sources_requested, ${heartbeatColumn}, ${cancelRequestedColumn}
      FROM crawl_runs
      WHERE status = 'RUNNING'
      ORDER BY id DESC
      LIMIT 1
    `).get() as unknown as LatestRun | undefined;
    return row ?? null;
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function readLatestRunId(databasePath: string): number | null {
  if (!existsSync(databasePath)) return null;
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(databasePath, { readOnly: true });
    const row = database.prepare("SELECT id FROM crawl_runs ORDER BY id DESC LIMIT 1").get() as unknown as { id: number | bigint } | undefined;
    if (row?.id === undefined) return null;
    return typeof row.id === "bigint" ? Number(row.id) : Number(row.id);
  } catch {
    return null;
  } finally {
    database?.close();
  }
}

function isFreshRunningRun(run: Pick<RunRow, "status" | "started_at" | "heartbeat_at"> | null): boolean {
  if (!run || run.status !== "RUNNING") return false;
  const startedAt = Date.parse(run.started_at);
  if (Number.isFinite(startedAt) && Date.now() - startedAt >= activeRunMaxDurationMs()) return false;
  const leaseAt = Date.parse(run.heartbeat_at ?? run.started_at);
  if (!Number.isFinite(leaseAt)) return true;
  return Date.now() - leaseAt < RUNNING_SCAN_MAX_AGE_MS;
}

function rememberScanRunId(runId: number): void {
  scanState = { ...scanState, runId };
}

function rememberScanSourceStart(sourceUrl: string, startedAt: string): void {
  scanState = {
    ...scanState,
    currentSources: [
      { url: sourceUrl, startedAt },
      ...scanState.currentSources.filter((source) => source.url !== sourceUrl),
    ],
  };
}

function rememberScanSourceSettled(sourceUrl: string): void {
  scanState = {
    ...scanState,
    currentSources: scanState.currentSources.filter((source) => source.url !== sourceUrl),
  };
}

function readInProgressSources(database: DatabaseSync, runId: number | null | undefined): InProgressSource[] {
  if (runId == null) return [];
  try {
    if (!hasDatabaseColumn(database, "source_run_results", "settled")) return [];
    const startedAtExpr = hasDatabaseColumn(database, "source_run_results", "started_at")
      ? "sr.started_at"
      : "NULL";
    const rows = database.prepare(`
      SELECT s.url, ${startedAtExpr} AS started_at
      FROM source_run_results sr
      JOIN sources s ON s.id = sr.source_id
      WHERE sr.run_id = @runId AND sr.settled = 0
      ORDER BY COALESCE(${startedAtExpr}, '') DESC, s.url
      LIMIT 16
    `).all({ runId: Number(runId) }) as unknown as Array<{ url: string; started_at: string | null }>;
    return rows.map((row) => ({ url: row.url, startedAt: row.started_at }));
  } catch {
    return [];
  }
}

function liveCurrentSources(database: DatabaseSync | undefined, latestRun: Pick<RunRow, "id" | "status" | "heartbeat_at" | "started_at"> | null): InProgressSource[] {
  const runId = activeRunId(latestRun);
  const fromDb = database && runId != null ? readInProgressSources(database, runId) : [];
  const fromMemory = activeScanIsLive() || scanState.status === "RUNNING" ? scanState.currentSources : [];
  const byUrl = new Map<string, InProgressSource>();
  for (const source of [...fromDb, ...fromMemory]) {
    if (source.url) byUrl.set(source.url, source);
  }
  return [...byUrl.values()].toSorted((left, right) => (right.startedAt || "").localeCompare(left.startedAt || "") || left.url.localeCompare(right.url));
}

function activeRunId(latestRun: Pick<RunRow, "id" | "status" | "heartbeat_at" | "started_at"> | null): number | null {
  if (latestRun?.status === "RUNNING" && isFreshRunningRun(latestRun)) return Number(latestRun.id);
  if (scanState.runId != null) return Number(scanState.runId);
  return null;
}

function dashboardSourceRunId(
  latestRun: Pick<RunRow, "id" | "status"> | null,
  latestCompletedRun: Pick<RunRow, "id"> | null,
): number | null {
  // Crawl health, provenance, and latest failures must describe the same run
  // as the status pill. An active crawl uses the live run; otherwise the latest
  // run wins even when it FAILED. Falling back to the last completed run here
  // mixed two crawls (failed 16/19 settled vs the prior completed 19 success).
  if (latestRun?.status === "RUNNING") return Number(latestRun.id);
  if (scanState.status === "RUNNING" && scanState.runId != null) return Number(scanState.runId);
  if (latestRun?.id != null) return Number(latestRun.id);
  return latestCompletedRun?.id ?? null;
}

function readDashboardErrorCount(database: DatabaseSync): number {
  try {
    const cutoff = new Date(Date.now() - 24 * 60 * 60_000).toISOString();
    const row = database.prepare(`
      SELECT COUNT(*) AS count
      FROM failed_pages
      WHERE occurred_at >= @cutoff
    `).get({ cutoff }) as unknown as { count: number | bigint } | undefined;
    return asFiniteNumber(row?.count);
  } catch {
    return 0;
  }
}

function readDashboardSourceHealth(
  database: DatabaseSync,
  latestRun: Pick<RunRow, "id" | "status"> | null,
  latestCompletedRun: Pick<RunRow, "id"> | null,
  failureLimit = 20,
): DashboardSourceHealth {
  const sourceRunId = dashboardSourceRunId(latestRun, latestCompletedRun);
  const configuredSourceUrls = new Set(readConfiguredSourceUrls(database));
  let sourceResults: CompactSourceResult[] = [];
  if (sourceRunId !== null) {
    try {
      const settledColumn = hasDatabaseColumn(database, "source_run_results", "settled")
        ? "sr.settled"
        : "1 AS settled";
      const startedAtColumn = hasDatabaseColumn(database, "source_run_results", "started_at")
        ? "sr.started_at"
        : "NULL AS started_at";
      const durationColumn = hasDatabaseColumn(database, "source_run_results", "duration_ms")
        ? "sr.duration_ms"
        : "NULL AS duration_ms";
      const rows = database.prepare(`
        SELECT s.url, ${settledColumn}, sr.completed, sr.pages_visited, sr.potential_postings_inspected,
               sr.jobs_discovered, sr.failure_count, ${startedAtColumn}, ${durationColumn}, sr.status
        FROM source_run_results sr JOIN sources s ON s.id = sr.source_id
        WHERE sr.run_id = @runId
        ORDER BY ${hasDatabaseColumn(database, "source_run_results", "settled") ? "sr.settled ASC," : ""} sr.jobs_discovered DESC, s.url
      `).all({ runId: sourceRunId }) as unknown as Array<Omit<CompactSourceResult, "settled" | "completed" | "pages_visited" | "potential_postings_inspected" | "jobs_discovered" | "failure_count" | "duration_ms"> & {
        settled: number | bigint;
        completed: number | bigint;
        pages_visited: number | bigint;
        potential_postings_inspected: number | bigint;
        jobs_discovered: number | bigint;
        failure_count: number | bigint;
        duration_ms: number | bigint | null;
      }>;
      sourceResults = rows.map((row) => ({
        url: row.url,
        settled: asFiniteNumber(row.settled),
        completed: asFiniteNumber(row.completed),
        pages_visited: asFiniteNumber(row.pages_visited),
        potential_postings_inspected: asFiniteNumber(row.potential_postings_inspected),
        jobs_discovered: asFiniteNumber(row.jobs_discovered),
        failure_count: asFiniteNumber(row.failure_count),
        started_at: row.started_at,
        duration_ms: row.duration_ms === null ? null : asFiniteNumber(row.duration_ms),
        status: row.status,
      }));
    } catch {
      sourceResults = [];
    }
  }

  const sourcesByUrl = new Map<string, SourceRow>([...configuredSourceUrls].map((url) => [url, { url, last_crawled_at: null, last_status: null, is_configured: 1 }]));
  try {
    const configuredColumn = hasDatabaseColumn(database, "sources", "is_configured") ? ", is_configured" : ", 0 AS is_configured";
    const storedSources = database.prepare(`
      SELECT url, last_crawled_at, last_status${configuredColumn} FROM sources ORDER BY url
    `).all() as unknown as SourceRow[];
    for (const source of storedSources) {
      if (sourcesByUrl.has(source.url) || source.is_configured === 1) sourcesByUrl.set(source.url, source);
    }
  } catch {
    // Keep the configured catalog even when the sources table is missing.
  }
  for (const result of sourceResults) {
    if (!sourcesByUrl.has(result.url)) sourcesByUrl.set(result.url, { url: result.url, last_crawled_at: null, last_status: null, is_configured: 0 });
  }
  const sources = [...sourcesByUrl.values()]
    .toSorted((left, right) => left.url.localeCompare(right.url))
    .map((source) => ({ ...source, isConfigured: configuredSourceUrls.has(source.url) }));

  let failures: FailureRow[] = [];
  if (sourceRunId !== null) {
    try {
      failures = database.prepare(`
        SELECT COALESCE(s.url, '(unknown)') AS source_url, f.error_type,
               f.status_code, f.message, COUNT(*) AS count
        FROM failed_pages f LEFT JOIN sources s ON s.id = f.source_id
        WHERE f.run_id = @runId
        GROUP BY source_url, f.error_type, f.status_code, f.message
        ORDER BY count DESC, source_url
        LIMIT @limit
      `).all({ runId: sourceRunId, limit: failureLimit }) as unknown as FailureRow[];
    } catch {
      failures = [];
    }
  }
  return { sources, sourceResults, failures, errors24h: readDashboardErrorCount(database) };
}

function liveSourceState(
  database: DatabaseSync,
  latestRun: RunRow | null,
  latestCompletedRun: RunRow | null,
): { scan: Record<string, unknown> } & DashboardSourceHealth {
  return {
    scan: scanPayload(latestRun, database),
    ...readDashboardSourceHealth(database, latestRun, latestCompletedRun),
  };
}

function scanPayload(
  latestRun: (Pick<RunRow, "id" | "started_at" | "status" | "heartbeat_at" | "cancel_requested_at">
    & Partial<Pick<RunRow, "error_message" | "finished_at">>) | null,
  database?: DatabaseSync,
  databasePath?: string,
): Record<string, unknown> {
  // A crashed worker can leave a RUNNING row behind. Honour the same
  // heartbeat lease used by startup run control so polling does not disable
  // Refresh forever or report an hours-old active crawl.
  const databaseRunIsActive = latestRun?.status === "RUNNING" && isFreshRunningRun(latestRun);
  const active = activeScanIsLive() || databaseRunIsActive;
  const status = active
    ? "RUNNING"
    : scanState.status === "RUNNING"
      ? "IDLE"
      : latestRun?.status === "FAILED" || scanState.status === "FAILED"
        ? "FAILED"
        : scanState.status !== "IDLE"
          ? scanState.status
          : latestRun?.status === "COMPLETED"
            ? "COMPLETED"
            : "IDLE";
  const currentSources = active ? liveCurrentSources(database, latestRun) : [];
  const activeId = activeRunId(latestRun);
  const failedError = latestRun?.status === "FAILED" ? latestRun.error_message ?? null : null;
  return {
    active,
    status,
    trigger: scanState.trigger,
    startedAt: active && databaseRunIsActive ? latestRun?.started_at : scanState.startedAt,
    finishedAt: scanState.finishedAt ?? (active ? null : latestRun?.status === "FAILED" || latestRun?.status === "COMPLETED" ? latestRun.finished_at : null),
    runId: active && databaseRunIsActive ? latestRun?.id : activeId ?? scanState.runId ?? latestRun?.id ?? null,
    terminationRequested: active && databaseRunIsActive ? latestRun?.cancel_requested_at !== null : false,
    error: active ? null : scanState.error ?? failedError,
    configuredSourceCount: database
      ? readConfiguredSourceUrls(database).length
      : databasePath
        ? readConfiguredSourceUrlsAtPath(databasePath).length
        : STATIC_CONFIGURED_SOURCES.length,
    currentSources,
    currentSource: currentSources[0] ?? null,
  };
}

async function addConfiguredSource(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  try {
    let body: Record<string, unknown>;
    const rawBody = await readRequestBody(request);
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new DashboardValidationError("Request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new DashboardValidationError("Request body must be a JSON object");
    }
    const url = optionalHttpUrl(body.url, "url");
    if (!url) throw new DashboardValidationError("url is required");
    const parsed = new URL(url);
    if (parsed.username || parsed.password) {
      throw new DashboardValidationError("url must not contain embedded credentials");
    }

    const database = new InternshipDatabase(databasePath);
    let source: ReturnType<InternshipDatabase["configureSource"]>;
    try {
      source = database.configureSource(url);
    } finally {
      database.close();
    }
    invalidateDashboardDataCache();

    let started = false;
    let queued = false;
    if (activeScanIsLive()) {
      queuedSourceScan = {
        databasePath,
        settings: dashboardSettings,
        sources: [...new Set([...(queuedSourceScan?.sources ?? []), url])],
      };
      queued = true;
    } else {
      started = startConfiguredSourceScan(databasePath, dashboardSettings, "refresh", [url]);
    }
    jsonResponse(response, started || queued ? 202 : 200, {
      ok: true,
      source,
      started,
      queued,
      scan: scanPayload(readRunningRun(databasePath), undefined, databasePath),
    }, { request, cacheControl: "no-store" });
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

function ensureListingActionsTable(databasePath: string): void {
  if (!existsSync(databasePath)) return;
  const database = new DatabaseSync(databasePath);
  try {
    // Startup can race when two dashboard workers are launched together.
    // Acquire one write reservation before any DDL/backfill so another
    // starter observes either the old schema or the complete migration, never
    // an intermediate identity set.
    database.exec("PRAGMA busy_timeout = 30000");
    database.exec("BEGIN IMMEDIATE");
    try {
      ensureRunCancellationSchema(database);
      ensureListingActionSchema(database);
      backfillListingActionIdentities(database);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}

function readClosedCount(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM internships
    WHERE availability_status = 'closed'
  `).get() as unknown as { count: number | bigint };
  return Number(row.count);
}

function readHiddenCount(database: DatabaseSync): number {
  const row = database.prepare(`
    SELECT COUNT(*) AS count
    FROM listing_actions
    WHERE action = 'cant_fit'
  `).get() as unknown as { count: number | bigint };
  return Number(row.count);
}

function hasDatabaseColumn(database: DatabaseSync, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function toListingActionRecord(row: ListingActionRow): ListingActionRecord {
  return {
    listingKey: row.listing_key,
    listingType: row.listing_type,
    listingId: row.listing_id,
    action: row.action,
    company: row.company,
    title: row.title,
    createdAt: row.created_at,
  };
}

function toApplicationItem(
  row: ApplicationActionRow,
): Record<string, unknown> {
  let role: FastRoleCard | null = null;
  if (row.payload_json) {
    try {
      const payload = InternshipSchema.parse(JSON.parse(row.payload_json));
      role = compactRole({
        ...payload,
        listingType: row.listing_type,
        listingId: row.listing_id,
      }, false);
    } catch {
      // Keep the durable action visible even if its historical role payload is
      // no longer parseable.
    }
  }
  const stage: ApplicationStage = isApplicationStage(row.application_stage)
    ? row.application_stage
    : applicationStageFromLegacyStatus(row.application_status);
  const location = row.location
    ? row.location.split(" · ").map((value) => value.trim()).filter(Boolean)
    : (role?.location ?? []);
  return {
    listingKey: row.listing_key,
    listingType: row.listing_type,
    listingId: row.listing_id,
    company: row.company,
    title: row.title,
    location,
    jobId: row.job_id ?? role?.jobId ?? null,
    applicationUrl: row.application_url ?? role?.applicationUrl ?? null,
    postingUrl: row.posting_url ?? role?.postingUrl ?? null,
    stage,
    // Keep the old field in the response for older dashboard bundles while
    // the stage field becomes the canonical application progress value.
    status: legacyApplicationStatusForStage(stage),
    appliedAt: row.created_at,
    role,
  };
}

function applicationCounts(applications: Array<Record<string, unknown>>): Record<ApplicationStage | "all", number> {
  const counts = {
    all: applications.length,
    applied: 0,
    oa: 0,
    recruiter: 0,
    interview: 0,
    final: 0,
    offer: 0,
    rejected: 0,
  } satisfies Record<ApplicationStage | "all", number>;
  for (const application of applications) {
    const stage = isApplicationStage(application.stage) ? application.stage : "applied";
    counts[stage] += 1;
  }
  return counts;
}

async function serveApplications(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  try {
    if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      let rows: ApplicationActionRow[];
      try {
        rows = database.prepare(`
          SELECT a.listing_key, a.listing_type, a.listing_id, a.action, a.company,
                 a.normalized_company, a.title, a.created_at, a.application_status,
                 a.application_stage,
                 a.application_url, a.posting_url, a.job_id, a.location,
                 i.payload_json
          FROM listing_actions a
          LEFT JOIN internships i
            ON a.listing_type = 'internship' AND i.id = a.listing_id
          WHERE a.action = 'applied'
          ORDER BY a.created_at DESC, a.listing_key
        `).all() as unknown as ApplicationActionRow[];
      } catch (error) {
        // A dashboard can briefly serve an old database while startup schema
        // migration is still pending. Treat those historical applications as
        // pending rather than making the track view unavailable.
        if (!(error instanceof Error) || !/no such table|no such column/i.test(error.message)) throw error;
        rows = database.prepare(`
          SELECT a.listing_key, a.listing_type, a.listing_id, a.action, a.company,
                 a.normalized_company, a.title, a.created_at,
                 'pending' AS application_status, 'applied' AS application_stage, a.application_url,
                 a.posting_url, a.job_id, a.location, i.payload_json
          FROM listing_actions a
          LEFT JOIN internships i
            ON a.listing_type = 'internship' AND i.id = a.listing_id
          WHERE a.action = 'applied'
          ORDER BY a.created_at DESC, a.listing_key
        `).all() as unknown as ApplicationActionRow[];
      }
      const applications = rows.map(toApplicationItem);
      jsonResponse(response, 200, {
        contract: "dashboard.applications.v1",
        generatedAt: new Date().toISOString(),
        applications,
        counts: applicationCounts(applications),
      }, { request, cacheControl: "private, no-cache, must-revalidate" });
    } finally {
      database.close();
    }
  } catch (error) {
    jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

async function updateApplicationStage(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  try {
    if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
    const rawBody = await readRequestBody(request);
    let body: Record<string, unknown>;
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new DashboardValidationError("Request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DashboardValidationError("Request body must be a JSON object");
    if (!isListingType(body.listingType)) throw new DashboardValidationError("listingType must be internship or grind");
    const requestedStage = body.stage ?? (
      body.status === "accepted" ? "offer" : body.status === "pending" ? "applied" : body.status
    );
    if (!isApplicationStage(requestedStage)) {
      throw new DashboardValidationError("stage must be applied, oa, recruiter, interview, final, offer, or rejected");
    }
    const stage: ApplicationStage = requestedStage;
    const listingId = requiredString(body.listingId, "listingId");
    const listingKey = listingActionKey(body.listingType, listingId);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 30000");
      database.exec("BEGIN IMMEDIATE");
      try {
        ensureListingActionSchema(database);
        const result = database.prepare(`
          UPDATE listing_actions
          SET application_stage = @stage,
              application_status = CASE
                WHEN @stage = 'offer' THEN 'accepted'
                WHEN @stage = 'rejected' THEN 'rejected'
                ELSE 'pending'
              END
          WHERE listing_key = @listingKey AND action = 'applied'
        `).run({ listingKey, stage });
        if (Number(result.changes) === 0) throw new DashboardValidationError("Applied application not found");
        const countRows = database.prepare(`
          SELECT application_stage, COUNT(*) AS count
          FROM listing_actions
          WHERE action = 'applied'
          GROUP BY application_stage
        `).all() as unknown as Array<{ application_stage: string; count: number | bigint }>;
        const counts: Record<ApplicationStage | "all", number> = {
          all: 0,
          applied: 0,
          oa: 0,
          recruiter: 0,
          interview: 0,
          final: 0,
          offer: 0,
          rejected: 0,
        };
        for (const row of countRows) {
          const rowStage = isApplicationStage(row.application_stage) ? row.application_stage : "applied";
          counts[rowStage] += Number(row.count);
          counts.all += Number(row.count);
        }
        database.exec("COMMIT");
        jsonResponse(response, 200, {
          ok: true,
          listingKey,
          stage,
          status: legacyApplicationStatusForStage(stage),
          counts,
        }, { request, cacheControl: "no-store" });
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

function roleLinkKeys(role: Pick<Internship, "applicationUrl" | "postingUrl">): string[] {
  return [role.applicationUrl, role.postingUrl].map((url) => canonicalizeUrl(url));
}

function readDashboardActionMatcher(database: DatabaseSync) {
  try {
    // Rebuild from both the persisted aliases and the action context. The
    // context rebuild covers legacy rows and actions whose original listing
    // was merged or removed from the internships table.
    return compileListingActionMatcher(readListingActionIdentities(database));
  } catch {
    try {
      // Keep old databases readable while their identity projection is being
      // created or when only the narrow projection is available.
      return compileListingActionMatcher(readPersistedListingActionIdentities(database));
    } catch {
      return compileListingActionMatcher([]);
    }
  }
}

function dashboardRoleIsHandled(
  role: DashboardInternship,
  hiddenListingKeys: ReadonlySet<string>,
  actionMatcher: { matches(internship: Internship): boolean },
  hiddenDestinationLinks: ReadonlySet<string>,
): boolean {
  const listingKey = listingActionKey(role.listingType ?? "internship", role.listingId ?? role.id);
  return hiddenListingKeys.has(listingKey)
    || actionMatcher.matches(role)
    || roleLinkKeys(role).some((link) => hiddenDestinationLinks.has(link));
}

function dashboardRolePassesHardFilters(
  role: DashboardInternship,
  handled: boolean,
  verifiedLinkedInUrls: Set<string> | null,
  includeHistoricalPosting = false,
): boolean {
  if (role.relevanceScore < MIN_LISTING_SCORE) return false;
  if (handled) return false;
  // This gate applies to every visible status, including closed roles. A
  // closed historical record may be retained for lifecycle tracking, but it
  // must still satisfy the user-facing technical + placement vocabulary.
  if (!hasRequiredListingKeywords(role)) return false;

  // Apply the same fixed dashboard policy to every source. Live-board roles
  // have sparse metadata, but they still carry enough normalized title,
  // location, authorization, destination, and lifecycle data to be checked by
  // the shared rules below.
  if (!isListingWorkAuthorizationAllowed(role)) return false;
  const isClosed = role.availabilityStatus === "closed";
  if (!isClosed && !isListingContentAllowed(role)) return false;
  if (!isClosed && !hasVerifiedLinkedInDestinations(role, verifiedLinkedInUrls)) return false;
  if (!isClosed && !isAllowedPostingLocation(role.normalizedLocations, role.remoteStatus)) return false;
  if (!isClosed && !includeHistoricalPosting && isDashboardPostingTooOld(role.postingDate)) return false;
  return true;
}

function isNewLiveBoardJob(job: GrindJob, now = Date.now()): boolean {
  return isWithinNewRoleBannerWindow(job.firstSeen, now);
}

function toLiveBoardInternship(
  job: GrindJob,
  latestCompletedRun: RunRow | null,
  verifiedAt: string,
): DashboardInternship {
  const isNew = isNewLiveBoardJob(job);
  const lifecycleStatus = isNew ? "NEW" : "UNCHANGED";
  const internship = grindJobToInternship(job, GRIND_JOB_BOARD_SOURCE_URL, verifiedAt);
  return {
    ...internship,
    lifecycleStatus,
    listingType: "grind",
    listingId: job.id,
    listingSource: GRIND_JOB_BOARD_SOURCE_URL,
    firstSeenAt: job.firstSeen,
    lastSeenAt: verifiedAt,
    ...(latestCompletedRun ? { statusRunId: latestCompletedRun.id } : {}),
    missCount: 0,
  };
}

function mergeLiveBoardInternships(
  storedInternships: DashboardInternship[],
  liveBoardInternships: DashboardInternship[],
): DashboardInternship[] {
  const merged = [...storedInternships];
  const byLink = new Map<string, DashboardInternship>();
  for (const role of merged) {
    for (const link of roleLinkKeys(role)) byLink.set(link, role);
  }
  for (const liveRole of liveBoardInternships) {
    const existing = roleLinkKeys(liveRole).map((link) => byLink.get(link)).find(Boolean);
    if (existing) {
      existing.sources = [...new Set([...existing.sources, ...liveRole.sources])];
      continue;
    }
    merged.push(liveRole);
    for (const link of roleLinkKeys(liveRole)) byLink.set(link, liveRole);
  }
  return merged;
}

async function readDashboardData(databasePath: string, forceGrindRefresh = false): Promise<Record<string, unknown>> {
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  if (!forceGrindRefresh) startBackgroundGrindRefresh();
  const rawGrindJobBoard = forceGrindRefresh
    ? await readBoardSnapshot(true)
    : grindJobBoardClient.getCachedSnapshot();
  const verification = await readVerificationSnapshot();
  const generatedAt = new Date().toISOString();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const listingActionRows = database.prepare(`
      SELECT listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at
      FROM listing_actions
      ORDER BY created_at DESC, listing_key
    `).all() as unknown as ListingActionRow[];
    const listingActions = listingActionRows.map(toListingActionRecord);
    const actionMatcher = readDashboardActionMatcher(database);
    const closedCount = readClosedCount(database);
    const hiddenCount = readHiddenCount(database);
    const hiddenListingKeys = new Set(listingActions.map((action) => action.listingKey));
    const appliedRoleCount = listingActionRows.filter((row) => row.action === "applied").length;
    const heartbeatColumn = hasDatabaseColumn(database, "crawl_runs", "heartbeat_at")
      ? "heartbeat_at"
      : "NULL AS heartbeat_at";
    const cancelRequestedColumn = runCancelRequestedColumn(database);
    const runs = database.prepare(`
      SELECT id, started_at, finished_at, status, sources_requested, sources_settled, sources_completed,
             pages_visited, potential_postings_inspected, internships_discovered,
             new_count, updated_count, unchanged_count, closed_count, error_message, ${cancelRequestedColumn},
             ${heartbeatColumn}
      FROM crawl_runs ORDER BY id DESC LIMIT 12
    `).all() as unknown as RunRow[];
    const latestRun = asRun(runs[0]);
    const latestCompletedRun = asRun(database.prepare(`
      SELECT id, started_at, finished_at, status, sources_requested, sources_settled, sources_completed,
             pages_visited, potential_postings_inspected, internships_discovered,
             new_count, updated_count, unchanged_count, closed_count, error_message, ${cancelRequestedColumn},
             ${heartbeatColumn}
      FROM crawl_runs
      WHERE status = 'COMPLETED'
      ORDER BY id DESC LIMIT 1
    `).get() as unknown as RunRow | undefined);
    const newListingKeys = new Set(readNewListingKeys(database));
    const verifiedLinkedInUrls = verification.urls;
    const configuredSourceUrls = new Set(readConfiguredSourceUrls(database));
    const hiddenBoardLinks = new Set(rawGrindJobBoard.jobs
      .filter((job) => hiddenListingKeys.has(listingActionKey("grind", job.id)))
      .flatMap((job) => [canonicalizeUrl(job.link)]));
    const actionContextRows = readFastActionContextRows(database);
    const hiddenDestinationLinks = new Set([
      ...hiddenBoardLinks,
      ...actionContextRows.flatMap((row) => fastActionLinks(row)),
      ...readFastHiddenInternshipLinks(database, actionContextRows),
    ]);

    const internshipRows = database.prepare(`
      SELECT payload_json, lifecycle_status, availability_status, first_seen_at,
             last_seen_at, last_verified_at, status_run_id, miss_count
      FROM internships
      ORDER BY CASE availability_status WHEN 'open' THEN 0 ELSE 1 END,
               CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) DESC,
               company COLLATE NOCASE, title COLLATE NOCASE
    `).all() as unknown as InternshipRow[];
    const storedInternships = internshipRows.flatMap((row) => {
      try {
        const payload = InternshipSchema.parse(JSON.parse(row.payload_json));
        return [{
          ...payload,
          sources: visibleProvenanceSources(payload.sources),
          lifecycleStatus: row.lifecycle_status,
          availabilityStatus: row.availability_status,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          statusRunId: row.status_run_id,
          missCount: row.miss_count,
        }];
      } catch {
        return [];
      }
    }).filter((role) => dashboardRolePassesHardFilters(
      role,
      dashboardRoleIsHandled(role, hiddenListingKeys, actionMatcher, hiddenDestinationLinks),
      verifiedLinkedInUrls,
    ));
    const liveBoardInternships = rawGrindJobBoard.jobs
      .map((job) => toLiveBoardInternship(job, latestCompletedRun, rawGrindJobBoard.lastSuccessfulSyncAt ?? generatedAt))
      .filter((role) => dashboardRolePassesHardFilters(
        role,
        dashboardRoleIsHandled(role, hiddenListingKeys, actionMatcher, hiddenDestinationLinks),
        verifiedLinkedInUrls,
      ));
    for (const role of liveBoardInternships) {
      if (role.lifecycleStatus === "NEW") {
        newListingKeys.add(listingActionKey("grind", role.listingId ?? role.id));
      }
    }
    const internships = mergeLiveBoardInternships(storedInternships, liveBoardInternships);
    const roleTabKeys = buildRoleTabKeys(
      internships,
      (role) => listingActionKey(role.listingType ?? "internship", role.listingId ?? role.id),
    );
    const { sources, sourceResults, failures, errors24h } = readDashboardSourceHealth(database, latestRun, latestCompletedRun, 100);

    const count = (predicate: (row: { availability_status: string; lifecycle_status: string }, internship: DashboardInternship) => boolean): number => (
      internships.reduce((total, internship) => total + (predicate({
        availability_status: internship.availabilityStatus,
        lifecycle_status: internship.lifecycleStatus,
      }, internship) ? 1 : 0), 0)
    );

    return {
      generatedAt,
      scheduler: { enabled: true, intervalMinutes: 90, activeWindow: "07:00–00:00 local", service: "macOS launchd" },
      stats: {
        total: internships.length,
        open: count(({ availability_status }) => availability_status === "open"),
        closed: closedCount,
        hidden: hiddenCount,
        unknown: count(({ availability_status }) => availability_status === "unknown"),
        new: count(({ availability_status }, internship) => newListingKeys.has(listingActionKey(internship.listingType ?? "internship", internship.listingId ?? internship.id)) && availability_status === "open"),
        updated: count(({ lifecycle_status, availability_status }, internship) => !newListingKeys.has(listingActionKey(internship.listingType ?? "internship", internship.listingId ?? internship.id)) && lifecycle_status === "UPDATED" && availability_status === "open"),
        unchanged: count(({ lifecycle_status, availability_status }, internship) => !newListingKeys.has(listingActionKey(internship.listingType ?? "internship", internship.listingId ?? internship.id)) && lifecycle_status === "UNCHANGED" && availability_status === "open"),
      },
      latestRun,
      latestCompletedRun,
      newListingKeys: [...newListingKeys],
      runs,
      deadlineNotifications: buildClosingSoonNotifications(internships),
      internships,
      roleTabKeys,
      configuredSourceCount: configuredSourceUrls.size,
      sources,
      sourceResults,
      failures,
      errors24h,
      scan: scanPayload(latestRun, database),
      listingActions,
      appliedRoleCount,
    };
  } finally {
    database.close();
  }
}

function asFiniteNumber(value: number | bigint | null | undefined): number {
  if (typeof value === "bigint") return Number(value);
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function runCancelRequestedColumn(database: DatabaseSync): string {
  return hasDatabaseColumn(database, "crawl_runs", "cancel_requested_at")
    ? "cancel_requested_at"
    : "NULL AS cancel_requested_at";
}

function runHeartbeatColumn(database: DatabaseSync): string {
  return hasDatabaseColumn(database, "crawl_runs", "heartbeat_at")
    ? "heartbeat_at"
    : "NULL AS heartbeat_at";
}

const RECENT_DASHBOARD_RUN_LIMIT = 5;

type RecentDashboardRun = Pick<RunRow, "id" | "started_at" | "finished_at" | "status" | "internships_discovered">;

function compactRecentDashboardRuns(runs: RunRow[], limit = RECENT_DASHBOARD_RUN_LIMIT): RecentDashboardRun[] {
  return runs.slice(0, limit).map((run) => ({
    id: run.id,
    started_at: run.started_at,
    finished_at: run.finished_at,
    status: run.status,
    internships_discovered: run.internships_discovered,
  }));
}

function readDashboardRuns(database: DatabaseSync, limit = 12): RunRow[] {
  const cancelRequestedColumn = runCancelRequestedColumn(database);
  const heartbeatColumn = runHeartbeatColumn(database);
  return database.prepare(`
    SELECT id, started_at, finished_at, status, sources_requested, sources_settled, sources_completed,
           pages_visited, potential_postings_inspected, internships_discovered,
           new_count, updated_count, unchanged_count, closed_count, error_message, ${cancelRequestedColumn},
           ${heartbeatColumn}
    FROM crawl_runs ORDER BY id DESC LIMIT @limit
  `).all({ limit }) as unknown as RunRow[];
}

function readLatestCompletedRun(database: DatabaseSync): RunRow | null {
  const cancelRequestedColumn = runCancelRequestedColumn(database);
  const heartbeatColumn = runHeartbeatColumn(database);
  return asRun(database.prepare(`
    SELECT id, started_at, finished_at, status, sources_requested, sources_settled, sources_completed,
           pages_visited, potential_postings_inspected, internships_discovered,
           new_count, updated_count, unchanged_count, closed_count, error_message, ${cancelRequestedColumn},
           ${heartbeatColumn}
    FROM crawl_runs WHERE status = 'COMPLETED' ORDER BY id DESC LIMIT 1
  `).get() as unknown as RunRow | undefined);
}

function fastDatabaseFileIdentity(databasePath: string): string {
  try {
    const stat = statSync(databasePath);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return databasePath;
  }
}

function readTrackerDataVersion(tracker: FastDatabaseRevisionTracker): number | null {
  try {
    const row = tracker.database.prepare("PRAGMA data_version").get() as unknown as { data_version?: number | bigint } | undefined;
    const value = row?.data_version;
    const numeric = typeof value === "bigint" ? Number(value) : value;
    return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function readDatabaseDataVersion(database: DatabaseSync): number | null {
  try {
    const row = database.prepare("PRAGMA data_version").get() as unknown as { data_version?: number | bigint } | undefined;
    const value = row?.data_version;
    const numeric = typeof value === "bigint" ? Number(value) : value;
    return typeof numeric === "number" && Number.isFinite(numeric) ? numeric : null;
  } catch {
    return null;
  }
}

function readFastDatabaseRevisionTracker(databasePath: string): FastDatabaseRevisionTracker | null {
  const fileIdentity = fastDatabaseFileIdentity(databasePath);
  const existing = fastDatabaseRevisionTrackers.get(databasePath);
  if (existing?.fileIdentity === fileIdentity) return existing;
  if (existing) {
    try {
      existing.database.close();
    } catch {
      // The old file may already have been replaced or closed by the runtime.
    }
    fastDatabaseRevisionTrackers.delete(databasePath);
  }
  try {
    const tracker: FastDatabaseRevisionTracker = {
      database: new DatabaseSync(databasePath, { readOnly: true }),
      fileIdentity,
      snapshot: null,
    };
    tracker.database.exec("PRAGMA busy_timeout = 5000");
    fastDatabaseRevisionTrackers.set(databasePath, tracker);
    return tracker;
  } catch {
    return null;
  }
}

function readFastDatabaseRevisionSnapshot(
  databasePath: string,
  database: DatabaseSync,
): FastDatabaseRevisionSnapshot {
  const tracker = readFastDatabaseRevisionTracker(databasePath);
  let before = tracker ? readTrackerDataVersion(tracker) : null;
  if (before === null) before = readDatabaseDataVersion(database);
  if (tracker?.snapshot && before !== null && tracker.snapshot.dataVersion === before) {
    // A writer may commit between the first data_version read and this cache
    // check. Confirm the stamp immediately before returning the cached rows;
    // otherwise a poll could briefly publish a validator for the prior DB
    // revision.
    const confirmed = readTrackerDataVersion(tracker);
    if (confirmed === before) return tracker.snapshot;
    before = confirmed;
  }

  const readCurrentSnapshot = (snapshotDataVersion: number | null): FastDatabaseRevisionSnapshot => {
    // A read transaction makes role/action/membership hashes come from one
    // SQLite snapshot. This matters when a crawler commits during a poll.
    database.exec("BEGIN");
    let committed = false;
    try {
      const roleMeta = database.prepare(`
        SELECT COUNT(*) AS role_count,
               MAX(last_verified_at) AS role_verified,
               MAX(last_seen_at) AS role_seen,
               MAX(status_run_id) AS role_status_run,
               MAX(content_hash) AS role_hash,
               SUM(CASE WHEN availability_status = 'open' THEN 1 ELSE 0 END) AS open_count,
               SUM(CASE WHEN availability_status = 'closed' THEN 1 ELSE 0 END) AS closed_count,
               SUM(CASE WHEN availability_status = 'unknown' THEN 1 ELSE 0 END) AS unknown_count,
               SUM(CASE WHEN lifecycle_status = 'NEW' THEN 1 ELSE 0 END) AS new_count,
               SUM(CASE WHEN lifecycle_status = 'UPDATED' THEN 1 ELSE 0 END) AS updated_count,
               SUM(CASE WHEN lifecycle_status = 'UNCHANGED' THEN 1 ELSE 0 END) AS unchanged_count
        FROM internships
      `).get() as unknown as FastRoleRevisionMeta;
      const roleRevisionRows = database.prepare(`
        SELECT id, payload_json, content_hash, lifecycle_status, availability_status, first_seen_at,
               last_seen_at, last_verified_at, status_run_id, miss_count
        FROM internships ORDER BY id
      `).all() as unknown as Array<Record<string, unknown>>;
      // Keep payload-only writes visible even when an older writer forgot to
      // refresh content_hash. This snapshot is reused while data_version is
      // stable, so it does not add work to ordinary warm polls.
      const roleRevision = sha256(JSON.stringify(roleRevisionRows));
      let newListingRevision = "none";
      try {
        const newListingRows = database.prepare(`
          SELECT run_id, internship_id, lifecycle_status
          FROM run_internships ORDER BY run_id, internship_id
        `).all() as unknown as Array<Record<string, unknown>>;
        newListingRevision = sha256(JSON.stringify(newListingRows));
      } catch {
        // Legacy fixtures may not include run membership history.
      }

      let actionMeta: FastActionRevisionMeta = {
        action_count: 0,
        action_created: null,
        hidden_count: 0,
        applied_roles: 0,
      };
      try {
        actionMeta = database.prepare(`
          SELECT COUNT(*) AS action_count,
                 MAX(created_at) AS action_created,
                 SUM(CASE WHEN action = 'cant_fit' THEN 1 ELSE 0 END) AS hidden_count,
                 COUNT(CASE WHEN action = 'applied' THEN 1 END) AS applied_roles
          FROM listing_actions
        `).get() as unknown as FastActionRevisionMeta;
      } catch {
        // Legacy databases may not have action tables until dashboard startup
        // finishes its best-effort migration.
      }

      let actionRevision = "none";
      try {
        const actionRevisionRows = database.prepare(`
          SELECT listing_key, listing_type, listing_id, action, company, normalized_company, title,
                 application_status, application_stage, application_url, posting_url, job_id, location, created_at
          FROM listing_actions ORDER BY listing_key
        `).all() as unknown as Array<Record<string, unknown>>;
        let identityRevisionRows: Array<Record<string, unknown>> = [];
        try {
          identityRevisionRows = database.prepare(`
            SELECT listing_key, identity_key, direct_job_ids_json
            FROM listing_action_identities ORDER BY listing_key, identity_key
          `).all();
        } catch {
          // The identity table is optional on the oldest dashboard databases.
        }
        actionRevision = sha256(JSON.stringify({ actions: actionRevisionRows, identities: identityRevisionRows }));
      } catch {
        // Keep the legacy no-action schema versionable.
      }
      database.exec("COMMIT");
      committed = true;
      return {
        dataVersion: snapshotDataVersion,
        roleMeta,
        actionMeta,
        roleRevision,
        newListingRevision,
        actionRevision,
      };
    } finally {
      if (!committed) {
        try {
          database.exec("ROLLBACK");
        } catch {
          // Preserve the original read error.
        }
      }
    }
  };

  let snapshot = readCurrentSnapshot(before);
  // A writer can commit while the metadata transaction is open. Retry from
  // the newly observed stamp so the hash and its stamp always describe the
  // same SQLite snapshot. If churn persists, return an uncached snapshot with
  // its starting stamp; the list builder's post-read check will discard it.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const after = (tracker ? readTrackerDataVersion(tracker) : null) ?? readDatabaseDataVersion(database);
    if (after === before) {
      snapshot = { ...snapshot, dataVersion: after };
      if (tracker && after !== null) tracker.snapshot = snapshot;
      return snapshot;
    }
    before = after;
    if (attempt < 2) snapshot = readCurrentSnapshot(before);
  }
  return snapshot;
}

function currentFastDatabaseDataVersion(databasePath: string, database: DatabaseSync): number | null {
  const tracker = readFastDatabaseRevisionTracker(databasePath);
  return (tracker ? readTrackerDataVersion(tracker) : null) ?? readDatabaseDataVersion(database);
}

function fastDatabaseRevisionIsCurrent(
  databasePath: string,
  expectedDataVersion: number | null,
  database: DatabaseSync,
): boolean {
  const currentDataVersion = currentFastDatabaseDataVersion(databasePath, database);
  // A database connection that cannot expose data_version is exceptionally
  // old/unsupported. Preserve the legacy read path in that case; normal
  // Node 24 SQLite connections always provide the stamp.
  return expectedDataVersion === null || currentDataVersion === null || currentDataVersion === expectedDataVersion;
}

function readFastVersionMetadata(
  database: DatabaseSync,
  board: GrindJobBoardSnapshot,
  verification: VerificationSnapshot,
  databasePath: string,
): FastVersionMetadata {
  // In the deterministic race test, perform the initial run query before the
  // revision capture and commit the injected progress update immediately
  // afterward. Production requests skip this test-only pre-query; their run
  // read below happens after the revision boundary, avoiding an extra query on
  // the warm path.
  if (fastRunRevisionCaptureTestHook !== null) {
    readDashboardRuns(database, 1);
    consumeFastRunRevisionCaptureTestHook();
  }
  const revisionSnapshot = readFastDatabaseRevisionSnapshot(databasePath, database);
  const latestRun = asRun(readDashboardRuns(database, 1)[0]);
  if (!fastDatabaseRevisionIsCurrent(databasePath, revisionSnapshot.dataVersion, database)) {
    throw new FastSnapshotChangedError();
  }
  const { roleMeta, actionMeta, roleRevision, newListingRevision, actionRevision } = revisionSnapshot;
  const latestRunId = latestRun?.id ?? null;
  const latestRunStatus = latestRun?.status ?? null;
  const latestRunHeartbeat = latestRun?.heartbeat_at ?? null;
  const boardLastSuccessfulSyncAt = board.lastSuccessfulSyncAt;
  const boardJobsRevision = sha256(JSON.stringify(board.jobs));
  // A crawler heartbeat/progress write changes SQLite's data_version but does
  // not change any role-card content. Include the 16-hour NEW banner window so
  // labels can expire between scans, while leaving run-only metadata to the
  // public version and dynamic cache hydration below. This avoids rebuilding
  // all cards when the normal startup scan creates its RUNNING row after prewarm.
  const latestCompletedRun = readLatestCompletedRun(database);
  const latestCompletedRunRevision = sha256(JSON.stringify(latestCompletedRun === null
    ? null
    : {
      id: latestCompletedRun.id,
      started_at: latestCompletedRun.started_at,
      finished_at: latestCompletedRun.finished_at,
      status: latestCompletedRun.status,
    }));
  const contentKey = sha256(JSON.stringify({
    roles: { roleRevision, newListingRevision },
    latestCompletedRunRevision,
    newRoleBannerWindow: newRoleBannerCacheKey(),
    postingAgeWindow: dashboardPostingAgeKey(),
    actions: actionRevision,
    board: { jobsRevision: boardJobsRevision, lastSuccessfulSyncAt: boardLastSuccessfulSyncAt },
    verificationRevision: verification.revision,
  }));
  const version = sha256(JSON.stringify({
    // Include the coherent SQLite revision itself as a final invalidation
    // boundary. This covers a committed payload/provenance change even when
    // an older database writer forgot to update content_hash.
    databaseDataVersion: revisionSnapshot.dataVersion,
    // Relative labels such as "yesterday" change meaning at local midnight
    // even when the database and board are untouched.
    relativeDay: dashboardLocalDayKey(),
    newRoleBannerWindow: newRoleBannerCacheKey(),
    postingAgeWindow: dashboardPostingAgeKey(),
    roles: {
      revision: roleRevision,
      newListingRevision,
      count: asFiniteNumber(roleMeta.role_count),
      verified: roleMeta.role_verified,
      seen: roleMeta.role_seen,
      statusRun: asFiniteNumber(roleMeta.role_status_run),
      hash: roleMeta.role_hash,
      open: asFiniteNumber(roleMeta.open_count),
      closed: asFiniteNumber(roleMeta.closed_count),
      unknown: asFiniteNumber(roleMeta.unknown_count),
      new: asFiniteNumber(roleMeta.new_count),
      updated: asFiniteNumber(roleMeta.updated_count),
      unchanged: asFiniteNumber(roleMeta.unchanged_count),
    },
    actions: {
      revision: actionRevision,
      count: asFiniteNumber(actionMeta.action_count),
      created: actionMeta.action_created,
      hidden: asFiniteNumber(actionMeta.hidden_count),
      appliedRoles: asFiniteNumber(actionMeta.applied_roles),
    },
    latestRun,
    scanState: {
      status: scanState.status,
      trigger: scanState.trigger,
      startedAt: scanState.startedAt,
      finishedAt: scanState.finishedAt,
      runId: scanState.runId,
      error: scanState.error,
      currentSources: scanState.currentSources,
    },
    scan: scanPayload(latestRun, database),
    board: {
      revision: boardJobsRevision,
      status: board.status,
      lastAttemptAt: board.lastAttemptAt,
      lastSuccessfulSyncAt: boardLastSuccessfulSyncAt,
      count: board.jobCount,
      freshCount: board.freshCount,
      companyCount: board.companyCount,
      companiesSynced: board.companiesSynced,
      companiesRefreshed: board.companiesRefreshed,
      cacheTtlMinutes: board.cacheTtlMinutes,
      attempts: board.attempts,
      retrievalUrl: board.retrievalUrl,
      failures: board.failures,
      latestFirstSeen: board.jobs.reduce<string | null>((latest, job) => (
        latest === null || job.firstSeen > latest ? job.firstSeen : latest
      ), null),
    },
    verification: {
      path: verification.path,
      revision: verification.revision,
    },
  }));
  return {
    version,
    contentKey,
    databaseDataVersion: revisionSnapshot.dataVersion,
    roleCount: asFiniteNumber(roleMeta.role_count),
    actionCount: asFiniteNumber(actionMeta.action_count),
    hiddenCount: asFiniteNumber(actionMeta.hidden_count),
    appliedRoleCount: asFiniteNumber(actionMeta.applied_roles),
    latestRunId,
    latestRunStatus,
    latestRunHeartbeat,
    boardLastSuccessfulSyncAt,
    verificationRevision: verification.revision,
  };
}

function fastListingKey(role: Pick<DashboardInternship, "id" | "listingType" | "listingId">): string {
  return listingActionKey(role.listingType ?? "internship", role.listingId ?? role.id);
}

function fastRoleSearchText(role: DashboardInternship): string {
  return [
    role.company,
    role.title,
    ...role.location,
    ...role.technologies,
    ...role.categories,
    role.description,
    role.listingSource ?? "",
    role.sourceUrl,
    ...role.sources,
  ].join(" ").toLocaleLowerCase();
}

function compactRole(
  role: DashboardInternship,
  isNew: boolean,
): FastRoleCard {
  const listingType = role.listingType ?? "internship";
  const listingId = role.listingId ?? role.id;
  return {
    id: role.id,
    listingType,
    listingId,
    jobId: role.jobId,
    company: role.company,
    title: role.title,
    location: role.location,
    canadianLocation: canadianLocationForRole(role),
    remoteStatus: role.remoteStatus,
    applicationUrl: role.applicationUrl,
    postingUrl: role.postingUrl,
    sourceUrl: role.listingSource ?? role.sourceUrl,
    sources: role.sources,
    technologies: role.technologies,
    categories: role.categories,
    relevanceScore: role.relevanceScore,
    relevanceReason: role.relevanceReason,
    seasons: dashboardRoleSeasons(role),
    internshipTerm: role.internshipTerm,
    internshipYear: role.internshipYear,
    duration: role.duration,
    salary: role.salary,
    postingDate: role.postingDate,
    deadline: role.deadline,
    lifecycleStatus: role.lifecycleStatus,
    availabilityStatus: role.availabilityStatus,
    discoveredAt: role.discoveredAt,
    lastVerifiedAt: role.lastVerifiedAt,
    firstSeenAt: role.firstSeenAt ?? role.discoveredAt,
    lastSeenAt: role.lastSeenAt ?? role.lastVerifiedAt,
    statusRunId: role.statusRunId ?? 0,
    missCount: role.missCount ?? 0,
    isNew,
  };
}

function postingDayForFastSort(role: DashboardInternship, relativeBase: number): number | null {
  return dashboardPostingDay(role.postingDate, relativeBase);
}

function compareFastRelevance(left: FastRoleEntry, right: FastRoleEntry): number {
  return right.role.relevanceScore - left.role.relevanceScore
    || left.role.company.localeCompare(right.role.company)
    || left.role.title.localeCompare(right.role.title);
}

function compareFastPosted(left: FastRoleEntry, right: FastRoleEntry, relativeBase: number): number {
  const leftPostingDay = postingDayForFastSort(left.role, relativeBase);
  const rightPostingDay = postingDayForFastSort(right.role, relativeBase);
  if (leftPostingDay === null && rightPostingDay !== null) return 1;
  if (leftPostingDay !== null && rightPostingDay === null) return -1;
  if (leftPostingDay !== null && rightPostingDay !== null && rightPostingDay !== leftPostingDay) {
    return rightPostingDay - leftPostingDay;
  }
  return compareFastRelevance(left, right);
}

function compareFastDefault(left: FastRoleEntry, right: FastRoleEntry, query: FastRolesQuery): number {
  if (query.tab === "main") return compareFastPosted(left, right, query.relativeBase);
  const newRank = Number(right.isNew) - Number(left.isNew);
  if (newRank) return newRank;
  return left.isNew && right.isNew ? compareFastPosted(left, right, query.relativeBase) : compareFastRelevance(left, right);
}

function compareFastEntries(left: FastRoleEntry, right: FastRoleEntry, query: FastRolesQuery): number {
  if (query.sort === "company") return left.role.company.localeCompare(right.role.company);
  if (query.sort === "posted") return compareFastPosted(left, right, query.relativeBase);
  if (query.sort === "season") return compareByDashboardSeason(left.role, right.role);
  if (query.sort === "recent" || query.sort === "last-seen") {
    const leftValue = parseDashboardSortDate(query.sort === "recent" ? left.role.discoveredAt : (left.role.lastSeenAt ?? left.role.lastVerifiedAt), query.relativeBase);
    const rightValue = parseDashboardSortDate(query.sort === "recent" ? right.role.discoveredAt : (right.role.lastSeenAt ?? right.role.lastVerifiedAt), query.relativeBase);
    if (leftValue === null && rightValue !== null) return 1;
    if (leftValue !== null && rightValue === null) return -1;
    if (leftValue !== null && rightValue !== null && rightValue !== leftValue) return rightValue - leftValue;
    return compareFastRelevance(left, right);
  }
  return compareFastDefault(left, right, query);
}

function parseFastQuery(requestUrl: URL): FastRolesQuery {
  const read = (name: string, fallback: string): string => requestUrl.searchParams.get(name)?.trim() || fallback;
  const view = read("view", "all") as FastExperienceView;
  if (view !== "all" && view !== "matches") throw new DashboardValidationError("view must be all or matches");
  const tabValue = read("tab", "summer");
  if (!ROLE_TABS.includes(tabValue as RoleTab)) throw new DashboardValidationError(`tab must be one of ${ROLE_TABS.join(", ")}`);
  const status = read("status", "open") as FastStatusFilter;
  if (!["open", "closed", "new", "updated", "all"].includes(status)) {
    throw new DashboardValidationError("status must be open, closed, new, updated, or all");
  }
  const sort = read("sort", "relevance") as FastSort;
  if (!["relevance", "posted", "season", "recent", "last-seen", "company"].includes(sort)) {
    throw new DashboardValidationError("sort must be relevance, posted, season, recent, last-seen, or company");
  }
  const integerParam = (name: string, fallback: number, maximum: number, minimum = 0): number => {
    const raw = requestUrl.searchParams.get(name);
    if (raw === null || raw.trim() === "") return fallback;
    if (!/^\d+$/.test(raw.trim())) throw new DashboardValidationError(`${name} must be a non-negative integer`);
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new DashboardValidationError(`${name} is out of range`);
    return value;
  };
  const search = (requestUrl.searchParams.get("q") ?? requestUrl.searchParams.get("search") ?? "").trim().toLocaleLowerCase();
  if (search.length > 200) throw new DashboardValidationError("search is too long");
  const categoryValue = requestUrl.searchParams.get("category")?.trim() ?? "";
  const workModeValue = requestUrl.searchParams.get("workMode")?.trim().toLocaleLowerCase() ?? "";
  if (workModeValue && workModeValue !== "all" && !["onsite", "hybrid", "remote"].includes(workModeValue)) {
    throw new DashboardValidationError("workMode must be onsite, hybrid, remote, or all");
  }
  const locationValue = requestUrl.searchParams.get("location")?.trim().toLocaleLowerCase() ?? "";
  if (locationValue.length > 200) throw new DashboardValidationError("location is too long");
  const seasonValue = requestUrl.searchParams.get("season")?.trim().toLocaleLowerCase() ?? "";
  if (seasonValue && seasonValue !== "all" && !DASHBOARD_SEASON_FILTERS.includes(seasonValue as typeof DASHBOARD_SEASON_FILTERS[number])) {
    throw new DashboardValidationError("season must be winter, spring, summer, fall, unknown, or all");
  }
  return {
    view,
    tab: tabValue as RoleTab,
    status,
    category: categoryValue && categoryValue !== "all" ? categoryValue : null,
    workMode: workModeValue && workModeValue !== "all" ? workModeValue as Internship["remoteStatus"] : null,
    season: seasonValue && seasonValue !== "all" ? seasonValue as typeof DASHBOARD_SEASON_FILTERS[number] : null,
    location: locationValue && locationValue !== "all" ? locationValue : null,
    search,
    sort,
    limit: integerParam("limit", 8, 100, 1),
    offset: integerParam("offset", 0, 5_000_000),
    relativeBase: Date.now(),
  };
}

function fastStatusMatches(entry: FastRoleEntry, status: FastStatusFilter): boolean {
  if (status === "open") return entry.role.availabilityStatus === "open";
  if (status === "closed") return entry.role.availabilityStatus === "closed";
  if (status === "new") return entry.isNew && entry.role.availabilityStatus === "open";
  // The legacy dashboard's Updated tab is the set of currently available,
  // non-new roles whose latest lifecycle state is UPDATED.  A role can retain
  // an UPDATED lifecycle marker while still being NEW in the 16-hour banner
  // window (or while having closed since that run), so lifecycle alone is not a
  // sufficient filter.
  if (status === "updated") {
    return !entry.isNew
      && entry.role.availabilityStatus === "open"
      && entry.role.lifecycleStatus === "UPDATED";
  }
  return true;
}

function fastFilterCacheKey(index: FastDashboardIndex, query: FastRolesQuery): string {
  return [
    index.versionMetadata.contentKey,
    query.view,
    query.tab,
    query.status,
    query.category ?? "",
    query.workMode ?? "",
    query.season ?? "",
    query.location ?? "",
    query.search,
    query.sort,
    dashboardLocalDayKey(query.relativeBase),
    String(newRoleBannerCacheKey(query.relativeBase)),
  ].join("|");
}

function rememberFastFilteredPage(key: string, entries: FastRoleEntry[]): void {
  fastFilteredPageCache.delete(key);
  fastFilteredPageCache.set(key, entries);
  while (fastFilteredPageCache.size > FAST_FILTERED_PAGE_CACHE_MAX) {
    const oldestKey = fastFilteredPageCache.keys().next().value;
    if (oldestKey === undefined) break;
    fastFilteredPageCache.delete(oldestKey);
  }
}

function fastFilterAndPage(
  index: FastDashboardIndex,
  query: FastRolesQuery,
  preferences: InternshipPreferences | null = null,
): { items: FastRoleCard[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const requestedLocation = query.location;
  const filtered = index.entries
    .filter((entry) => entry.tabs.has(query.tab))
    .filter((entry) => fastStatusMatches(entry, query.status))
    .filter((entry) => query.category === null || entry.role.categories.includes(query.category as Internship["categories"][number]))
    .filter((entry) => query.workMode === null || entry.role.remoteStatus === query.workMode)
    .filter((entry) => query.season === null || dashboardRoleHasSeason(entry.role, query.season))
    .filter((entry) => {
      if (requestedLocation === null) return true;
      return entry.role.location.some((value) => value.toLocaleLowerCase().includes(requestedLocation));
    })
    .filter((entry) => !query.search || entry.searchText.includes(query.search));

  if (query.view === "matches") {
    if (!preferences) throw new Error("Completed preferences are required for the matches view.");
    const matching = filtered
      .map((entry) => {
        const match = evaluateInternshipMatch(preferences, entry.role);
        return { entry, match };
      })
      .filter(({ match }) => match.eligibility.status !== "not_eligible")
      .toSorted((left, right) => right.match.score - left.match.score
        || compareFastEntries(left.entry, right.entry, query));
    const page = matching.slice(query.offset, query.offset + query.limit);
    const nextOffset = query.offset + page.length < matching.length ? query.offset + page.length : null;
    return {
      items: page.map(({ entry, match }) => ({
        ...entry.card,
        matchScore: match.score,
        matchReasons: match.reasons,
        matchUnknownCount: match.unknown.length,
        eligibility: match.eligibility,
        eligibilityStatus: match.eligibility.status,
        eligibilityVersion: match.eligibility.version,
        eligibilityReasons: match.eligibility.criterionResults.map(({ reason }) => reason),
        eligibilityUnknown: match.unknown,
      })),
      total: matching.length,
      hasMore: nextOffset !== null,
      nextOffset,
    };
  }

  const cacheKey = fastFilterCacheKey(index, query);
  let matching = fastFilteredPageCache.get(cacheKey);
  if (!matching) {
    matching = filtered
      .toSorted((left, right) => compareFastEntries(left, right, query));
  }
  rememberFastFilteredPage(cacheKey, matching);
  const page = matching.slice(query.offset, query.offset + query.limit);
  const nextOffset = query.offset + page.length < matching.length ? query.offset + page.length : null;
  return {
    items: page.map((entry) => entry.card),
    total: matching.length,
    hasMore: nextOffset !== null,
    nextOffset,
  };
}

function prewarmFastTabPages(index: FastDashboardIndex, relativeBase = Date.now()): void {
  // Internship is typically the largest tab; warm it first so a later switch
  // is a slice instead of a full filter+sort of thousands of intern roles.
  const tabOrder: RoleTab[] = ["internship", ...ROLE_TABS.filter((tab) => tab !== "internship")];
  for (const tab of tabOrder) {
    fastFilterAndPage(index, {
      view: "all",
      tab,
      status: "open",
      category: null,
      workMode: null,
      season: null,
      location: null,
      search: "",
      sort: "relevance",
      limit: 1,
      offset: 0,
      relativeBase,
    });
  }
}

async function readFastDashboardIndexAttempt(
  databasePath: string,
  options: FastDashboardIndexReadOptions = {},
): Promise<FastDashboardIndex> {
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  if (options.startBackgroundBoardRefresh !== false) startBackgroundGrindRefresh();
  const verification = await readVerificationSnapshot(options.verification);
  const board = grindJobBoardClient.getCachedSnapshot();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const versionMetadata = readFastVersionMetadata(database, board, verification, databasePath);
    consumeFastSnapshotReadTestHook();
    // Run rows are read after the coherent version boundary. If a run starts
    // or reports progress while the rest of the index is being built, the
    // post-build data_version check below discards this mixed snapshot.
    const runs = readDashboardRuns(database);
    const latestRun = asRun(runs[0]);
    const cacheKey = `${databasePath}:${versionMetadata.contentKey}`;
    if (fastDashboardIndexCache?.key === cacheKey) {
      if (!fastDatabaseRevisionIsCurrent(databasePath, versionMetadata.databaseDataVersion, database)) {
        throw new FastSnapshotChangedError();
      }
      const index = {
        ...fastDashboardIndexCache.index,
        versionMetadata,
        deadlineNotifications: buildClosingSoonNotifications(
          fastDashboardIndexCache.index.entries.map((entry) => entry.role as DeadlineNotificationRole),
        ),
        latestRun,
        latestCompletedRun: fastDashboardIndexCache.index.latestCompletedRun,
        runs,
        ...liveSourceState(database, latestRun, fastDashboardIndexCache.index.latestCompletedRun),
      };
      fastDashboardIndexCache = { key: cacheKey, index };
      if (fastFilteredPageCache.size === 0) queueMicrotask(() => prewarmFastTabPages(index));
      return index;
    }
    const existingBuild = fastDashboardIndexInflight.get(cacheKey);
    if (existingBuild) {
      const index = await existingBuild;
      if (!fastDatabaseRevisionIsCurrent(databasePath, versionMetadata.databaseDataVersion, database)) {
        throw new FastSnapshotChangedError();
      }
      return {
        ...index,
        versionMetadata,
        deadlineNotifications: buildClosingSoonNotifications(
          index.entries.map((entry) => entry.role as DeadlineNotificationRole),
        ),
        latestRun,
        runs,
        ...liveSourceState(database, latestRun, index.latestCompletedRun),
      };
    }

    fastDashboardIndexBuildTestHook?.();
    const buildPromise = (async (): Promise<FastDashboardIndex> => {
    const latestCompletedRun = readLatestCompletedRun(database);
    const newListingKeys = new Set(readNewListingKeys(database));
    const verifiedLinkedInUrls = verification.urls;

    let listingActionRows: ListingActionRow[] = [];
    try {
      listingActionRows = database.prepare(`
        SELECT listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at
        FROM listing_actions
      `).all() as unknown as ListingActionRow[];
    } catch {
      // Keep legacy databases readable while action tables are being migrated.
    }
    const hiddenListingKeys = new Set(listingActionRows.map((row) => row.listing_key));
    const actionContextRows = readFastActionContextRows(database);
    const actionMatcher = readDashboardActionMatcher(database);
    const hiddenBoardLinks = new Set(board.jobs
      .filter((job) => hiddenListingKeys.has(listingActionKey("grind", job.id)))
      .map((job) => canonicalizeUrl(job.link)));
    const hiddenDestinationLinks = new Set([
      ...hiddenBoardLinks,
      ...actionContextRows.flatMap((row) => fastActionLinks(row)),
      ...readFastHiddenInternshipLinks(database, actionContextRows),
    ]);
    const storedInternships: DashboardInternship[] = [];
    const internshipRows = database.prepare(`
      SELECT id, payload_json, lifecycle_status, availability_status, first_seen_at,
             last_seen_at, last_verified_at, status_run_id, miss_count
      FROM internships
      ORDER BY CASE availability_status WHEN 'open' THEN 0 ELSE 1 END,
               CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) DESC,
               company COLLATE NOCASE, title COLLATE NOCASE
    `).all() as unknown as FastInternshipRow[];
    for (const row of internshipRows) {
      try {
        const payload = InternshipSchema.parse(JSON.parse(row.payload_json));
        storedInternships.push({
          ...payload,
          sources: visibleProvenanceSources(payload.sources),
          lifecycleStatus: row.lifecycle_status,
          availabilityStatus: row.availability_status,
          firstSeenAt: row.first_seen_at,
          lastSeenAt: row.last_seen_at,
          statusRunId: row.status_run_id,
          missCount: row.miss_count,
        });
      } catch {
        // A malformed legacy row is not a user-facing listing.
      }
    }
    const visibleStoredInternships = storedInternships.filter((role) => dashboardRolePassesHardFilters(
      role,
      dashboardRoleIsHandled(role, hiddenListingKeys, actionMatcher, hiddenDestinationLinks),
      verifiedLinkedInUrls,
    ));
    const liveBoardInternships = board.jobs
      .map((job) => toLiveBoardInternship(job, latestCompletedRun, board.lastSuccessfulSyncAt ?? new Date().toISOString()))
      .filter((role) => dashboardRolePassesHardFilters(
        role,
        dashboardRoleIsHandled(role, hiddenListingKeys, actionMatcher, hiddenDestinationLinks),
        verifiedLinkedInUrls,
      ));
    for (const role of liveBoardInternships) {
      if (role.lifecycleStatus === "NEW") newListingKeys.add(fastListingKey(role));
    }
    const internships = mergeLiveBoardInternships(visibleStoredInternships, liveBoardInternships);
    const entries: FastRoleEntry[] = internships.map((role) => {
      const key = fastListingKey(role);
      const isNew = newListingKeys.has(key);
      return {
        key,
        role,
        card: compactRole(role, isNew),
        searchText: fastRoleSearchText(role),
        tabs: new Set(ROLE_TABS.filter((tab) => roleMatchesTab(role, tab))),
        isNew,
      };
    });
    const tabCounts = Object.fromEntries(ROLE_TABS.map((tab) => [
      tab,
      entries.filter((entry) => entry.tabs.has(tab) && entry.role.availabilityStatus === "open").length,
    ])) as Record<RoleTab, number>;
    const categories = [...new Set(entries.flatMap((entry) => entry.role.categories))].toSorted();
    const closedCount = readClosedCount(database);
    const hiddenCount = readHiddenCount(database);
    const appliedRoleCount = listingActionRows.filter((row) => row.action === "applied").length;
    const stats = {
      total: entries.length,
      open: entries.filter((entry) => entry.role.availabilityStatus === "open").length,
      closed: closedCount,
      hidden: hiddenCount,
      unknown: entries.filter((entry) => entry.role.availabilityStatus === "unknown").length,
      new: entries.filter((entry) => entry.isNew && entry.role.availabilityStatus === "open").length,
      updated: entries.filter((entry) => !entry.isNew && entry.role.lifecycleStatus === "UPDATED" && entry.role.availabilityStatus === "open").length,
      unchanged: entries.filter((entry) => !entry.isNew && entry.role.lifecycleStatus === "UNCHANGED" && entry.role.availabilityStatus === "open").length,
    };
    const index: FastDashboardIndex = {
      versionMetadata,
      generatedAt: new Date().toISOString(),
      entries,
      deadlineNotifications: buildClosingSoonNotifications(
        entries.map((entry) => entry.role as DeadlineNotificationRole),
      ),
      tabCounts,
      categories,
      stats,
      latestRun,
      latestCompletedRun,
      runs,
      appliedRoleCount,
      ...liveSourceState(database, latestRun, latestCompletedRun),
    };
    return index;
    })();
    fastDashboardIndexInflight.set(cacheKey, buildPromise);
    try {
      const index = await buildPromise;
      if (!fastDatabaseRevisionIsCurrent(databasePath, versionMetadata.databaseDataVersion, database)) {
        throw new FastSnapshotChangedError();
      }
      fastFilteredPageCache.clear();
      fastDashboardIndexCache = { key: cacheKey, index };
      queueMicrotask(() => prewarmFastTabPages(index));
      return index;
    } finally {
      if (fastDashboardIndexInflight.get(cacheKey) === buildPromise) fastDashboardIndexInflight.delete(cacheKey);
    }
  } finally {
    database.close();
  }
}

const FAST_SNAPSHOT_MAX_RETRIES = 3;

async function readFastDashboardIndex(
  databasePath: string,
  retryCount = 0,
  options: FastDashboardIndexReadOptions = {},
): Promise<FastDashboardIndex> {
  try {
    return await readFastDashboardIndexAttempt(databasePath, options);
  } catch (error) {
    if (error instanceof FastSnapshotChangedError && retryCount < FAST_SNAPSHOT_MAX_RETRIES - 1) {
      return readFastDashboardIndex(databasePath, retryCount + 1, options);
    }
    throw error;
  }
}

const FAST_DASHBOARD_PREWARM_TIMEOUT_MS = 15_000;

async function prewarmFastDashboardIndex(databasePath: string, logLabel = "PREWARM"): Promise<boolean> {
  if (process.env.DASHBOARD_SKIP_FAST_PREWARM === "1") return false;
  const timeoutMs = fastPrewarmTimeoutOverrideForTests ?? FAST_DASHBOARD_PREWARM_TIMEOUT_MS;
  const startedAt = Date.now();
  const cancellation = new AbortController();
  // Do not coalesce startup artifact work into the request-shared map. If the
  // artifact is a stalled FIFO, aborting this read must not cancel a live
  // request or leave that request awaiting an abandoned promise.
  const prewarm = readFastDashboardIndex(databasePath, 0, {
    startBackgroundBoardRefresh: false,
    verification: {
      signal: cancellation.signal,
      timeoutMs,
      coalesce: false,
      failOnTimeout: true,
    },
  });
  let prewarmTimedOut = false;
  const prewarmOutcome = prewarm.then((index) => {
    if (!prewarmTimedOut) {
      latestSuccessfulFastPrewarm = {
        databasePath,
        fileIdentity: dashboardDatabaseFileIdentity(databasePath),
        databaseDataVersion: index.versionMetadata.databaseDataVersion,
        contentKey: index.versionMetadata.contentKey,
        latestRunId: index.versionMetadata.latestRunId,
        latestRunStatus: index.versionMetadata.latestRunStatus,
        latestRunHeartbeat: index.versionMetadata.latestRunHeartbeat,
      };
    }
    return "ready" as const;
  }).catch((error: unknown) => {
    if (!(prewarmTimedOut && cancellation.signal.aborted)) {
      console.error(`[DASHBOARD PREWARM FAILED] ${error instanceof Error ? error.message : String(error)}`);
    }
    return "failed" as const;
  });
  let timeout: ReturnType<typeof setTimeout> | null = null;
  const outcomePromise = new Promise<"timeout">((resolve) => {
    timeout = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const outcome = await Promise.race([
    prewarmOutcome,
    outcomePromise,
  ]);
  if (timeout !== null) clearTimeout(timeout);
  if (outcome === "ready") {
    console.log(`[DASHBOARD ${logLabel}] Fast index ready in ${Date.now() - startedAt}ms`);
    return true;
  }
  if (outcome === "timeout") {
    prewarmTimedOut = true;
    cancellation.abort(new Error("Dashboard prewarm deadline exceeded"));
    console.error(`[DASHBOARD ${logLabel}] Timed out after ${timeoutMs}ms; serving with on-demand fallback`);
  }
  return false;
}

/**
 * Begin the read-side index rebuild as soon as a crawl commit is durable.
 * `runScout` still owns the crawl promise and its export work; this observer
 * is intentionally fire-and-forget so a failed/slow display prewarm cannot
 * change run status or hold the crawler's completion path hostage. The map
 * only deduplicates the short overlap between consecutive run commits; the
 * normal content-key in-flight map remains the correctness boundary.
 */
function schedulePostRunFastDashboardPrewarm(databasePath: string, runKey: string | null = null): void {
  if (process.env.DASHBOARD_SKIP_FAST_PREWARM === "1") return;
  const activeKey = postRunFastDashboardPrewarmActiveKeys.get(databasePath);
  if (runKey !== null && postRunFastDashboardPrewarmSuccessfulKeys.get(databasePath) === runKey) return;
  if (postRunFastDashboardPrewarms.has(databasePath)) {
    // A second run can commit while the first observer is still hashing its
    // snapshot. Ensure that revision receives a follow-up attempt after the
    // current bounded prewarm settles instead of relying on a user request.
    if (runKey !== null && activeKey !== runKey) {
      postRunFastDashboardPrewarmPendingKeys.set(databasePath, runKey);
    }
    return;
  }
  const prewarm = prewarmFastDashboardIndex(databasePath, "POSTRUN PREWARM")
    .catch((error: unknown) => {
      console.error(`[DASHBOARD POSTRUN PREWARM FAILED] ${error instanceof Error ? error.message : String(error)}`);
      return false;
    })
    .then((succeeded) => {
      if (succeeded && runKey !== null) postRunFastDashboardPrewarmSuccessfulKeys.set(databasePath, runKey);
      return succeeded;
    });
  const trackedPrewarm = prewarm.finally(() => {
    if (postRunFastDashboardPrewarms.get(databasePath) === trackedPrewarm) {
      postRunFastDashboardPrewarms.delete(databasePath);
    }
    if (runKey !== null && postRunFastDashboardPrewarmActiveKeys.get(databasePath) === runKey) {
      postRunFastDashboardPrewarmActiveKeys.delete(databasePath);
    }
    const pendingKey = postRunFastDashboardPrewarmPendingKeys.get(databasePath);
    if (pendingKey !== undefined) {
      postRunFastDashboardPrewarmPendingKeys.delete(databasePath);
      schedulePostRunFastDashboardPrewarm(databasePath, pendingKey);
    }
  });
  postRunFastDashboardPrewarms.set(databasePath, trackedPrewarm);
  if (runKey !== null) postRunFastDashboardPrewarmActiveKeys.set(databasePath, runKey);
}

export function schedulePostRunFastDashboardPrewarmForTests(databasePath: string): void {
  schedulePostRunFastDashboardPrewarm(databasePath);
}

export async function prewarmFastDashboardIndexForTests(databasePath: string): Promise<boolean> {
  return prewarmFastDashboardIndex(databasePath);
}

interface FastDetailInternshipRow extends InternshipRow {
  id: string;
  content_hash: string;
}

function readFastActionContextRows(database: DatabaseSync): FastActionContextRow[] {
  try {
    return database.prepare(`
      SELECT listing_key, listing_type, listing_id, action, company, normalized_company, title, created_at,
             application_url, posting_url, job_id, location
      FROM listing_actions
    `).all() as unknown as FastActionContextRow[];
  } catch {
    // The action schema is created lazily for old databases. A detail read
    // remains useful while that migration is pending.
    return [];
  }
}

function readFastDetailActionMatcher(database: DatabaseSync) {
  return readDashboardActionMatcher(database);
}

function fastActionLinks(row: Pick<FastActionContextRow, "application_url" | "posting_url">): string[] {
  return [row.application_url, row.posting_url]
    .filter((value): value is string => Boolean(value))
    .map((value) => canonicalizeUrl(value));
}

function readFastHiddenInternshipLinks(
  database: DatabaseSync,
  actionRows: readonly FastActionContextRow[],
): Set<string> {
  const links = new Set<string>();
  for (const row of actionRows) {
    if (row.listing_type !== "internship") continue;
    for (const link of fastActionLinks(row)) links.add(link);
    if (row.application_url || row.posting_url) continue;
    // Context columns are absent on some early action rows. Look up only the
    // explicitly hidden role instead of parsing the entire internships table.
    try {
      const role = database.prepare(`
        SELECT application_url, posting_url
        FROM internships WHERE id = @id
      `).get({ id: row.listing_id }) as unknown as { application_url: string | null; posting_url: string | null } | undefined;
      if (role) for (const link of fastActionLinks(role)) links.add(link);
    } catch {
      // Keep the key-based hide decision even when a legacy projection is
      // unavailable.
    }
  }
  return links;
}

function readFastDetailActionRevision(
  database: DatabaseSync,
  actionRows: readonly FastActionContextRow[],
): string {
  let identityRows: unknown[] = [];
  try {
    identityRows = database.prepare(`
      SELECT listing_key, identity_key, direct_job_ids_json
      FROM listing_action_identities ORDER BY listing_key, identity_key
    `).all();
  } catch {
    // Legacy databases may not have the persisted identity projection.
  }
  return sha256(JSON.stringify({ actions: actionRows, identities: identityRows }));
}

interface FastRunRevisionRead {
  latestRun: RunRow | null;
  dataVersion: number | null;
}

function readFastLatestRunWithRevision(databasePath: string, database: DatabaseSync): FastRunRevisionRead {
  // Capture a stamp before and after the run query. The run itself is read
  // after the first stamp and is accepted only when no commit crossed the
  // boundary. This keeps detail's lazy single-role query independent of the
  // full list revision hash while still making run progress coherent.
  const before = currentFastDatabaseDataVersion(databasePath, database);
  const latestRun = asRun(readDashboardRuns(database, 1)[0]);
  consumeFastRunRevisionCaptureTestHook();
  const after = currentFastDatabaseDataVersion(databasePath, database);
  if (before !== null && after !== null && before !== after) {
    throw new FastSnapshotChangedError();
  }
  return { latestRun, dataVersion: after ?? before };
}

async function readFastRoleDetailAttempt(
  databasePath: string,
  listingType: ListingType,
  listingId: string,
): Promise<FastRoleDetailRead | null> {
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  startBackgroundGrindRefresh();
  // Resolve verification before opening the database. This gives detail and
  // list reads one artifact revision and avoids holding a SQLite handle over
  // an awaited filesystem operation.
  const verification = await readVerificationSnapshot();
  const board = grindJobBoardClient.getCachedSnapshot();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const runRevision = readFastLatestRunWithRevision(databasePath, database);
    const { latestRun } = runRevision;
    const latestCompletedRun = readLatestCompletedRun(database);
    const newListingKeys = new Set(readNewListingKeys(database));
    const actionRows = readFastActionContextRows(database);
    const hiddenListingKeys = new Set(actionRows.map((row) => row.listing_key));
    const hiddenBoardLinks = new Set(board.jobs
      .filter((job) => hiddenListingKeys.has(listingActionKey("grind", job.id)))
      .map((job) => canonicalizeUrl(job.link)));
    const hiddenInternshipLinks = readFastHiddenInternshipLinks(database, actionRows);
    const hiddenDestinationLinks = new Set([
      ...hiddenBoardLinks,
      ...hiddenInternshipLinks,
    ]);
    const actionMatcher = readFastDetailActionMatcher(database);
    let role: DashboardInternship | null = null;
    let roleIsNew = false;
    let roleVersion: Record<string, unknown> = { listingType, listingId };

    if (listingType === "internship") {
      const row = database.prepare(`
        SELECT id, payload_json, content_hash, lifecycle_status, availability_status, first_seen_at,
               last_seen_at, last_verified_at, status_run_id, miss_count
        FROM internships WHERE id = @id
      `).get({ id: listingId }) as unknown as FastDetailInternshipRow | undefined;
      if (!row) {
        if (!fastDatabaseRevisionIsCurrent(databasePath, runRevision.dataVersion, database)) {
          throw new FastSnapshotChangedError();
        }
        return null;
      }
      const payload = InternshipSchema.parse(JSON.parse(row.payload_json));
      const listingKey = listingActionKey("internship", row.id);
      const isNew = newListingKeys.has(listingKey);
      roleIsNew = isNew;
      const candidate: DashboardInternship = {
        ...payload,
        sources: visibleProvenanceSources(payload.sources),
        lifecycleStatus: row.lifecycle_status,
        availabilityStatus: row.availability_status,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        statusRunId: row.status_run_id,
        missCount: row.miss_count,
        listingType: "internship",
        listingId: row.id,
      };
      const handled = dashboardRoleIsHandled(candidate, hiddenListingKeys, actionMatcher, hiddenDestinationLinks);
      if (dashboardRolePassesHardFilters(candidate, handled, verification.urls, true)) role = candidate;
      roleVersion = {
        listingType,
        listingId,
        contentHash: row.content_hash,
        lifecycleStatus: row.lifecycle_status,
        availabilityStatus: row.availability_status,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        lastVerifiedAt: row.last_verified_at,
        statusRunId: row.status_run_id,
        missCount: row.miss_count,
        isNew,
      };
    } else {
      const job = board.jobs.find((candidate) => candidate.id === listingId);
      if (!job) {
        if (!fastDatabaseRevisionIsCurrent(databasePath, runRevision.dataVersion, database)) {
          throw new FastSnapshotChangedError();
        }
        return null;
      }
      const candidate = toLiveBoardInternship(job, latestCompletedRun, board.lastSuccessfulSyncAt ?? new Date().toISOString());
      const listingKey = listingActionKey("grind", listingId);
      const isNew = candidate.lifecycleStatus === "NEW" || newListingKeys.has(listingKey);
      roleIsNew = isNew;
      const handled = dashboardRoleIsHandled(candidate, hiddenListingKeys, actionMatcher, hiddenDestinationLinks);
      if (dashboardRolePassesHardFilters(candidate, handled, verification.urls, true)) role = candidate;
      roleVersion = {
        listingType,
        listingId,
        isNew,
        job,
      };
    }
    if (!role) {
      if (!fastDatabaseRevisionIsCurrent(databasePath, runRevision.dataVersion, database)) {
        throw new FastSnapshotChangedError();
      }
      return null;
    }
    const actionRevision = readFastDetailActionRevision(database, actionRows);
    let actionVersion: { count: number; latest: string | null; revision: string } = {
      count: 0,
      latest: null,
      revision: actionRevision,
    };
    if (actionRows.length > 0) {
      actionVersion = {
        count: actionRows.length,
        latest: actionRows.reduce<string | null>((latest, row) => (
          latest === null || row.created_at > latest ? row.created_at : latest
        ), null),
        revision: actionRevision,
      };
    }
    const version = sha256(JSON.stringify({
      databaseDataVersion: runRevision.dataVersion,
      role: roleVersion,
      latestRun,
      scanState,
      actions: actionVersion,
      verification: { path: verification.path, revision: verification.revision },
      board: {
        status: board.status,
        lastAttemptAt: board.lastAttemptAt,
        lastSuccessfulSyncAt: board.lastSuccessfulSyncAt,
        attempts: board.attempts,
        failures: board.failures,
      },
    }));
    if (!fastDatabaseRevisionIsCurrent(databasePath, runRevision.dataVersion, database)) {
      throw new FastSnapshotChangedError();
    }
    return { role, isNew: roleIsNew, version, generatedAt: new Date().toISOString() };
  } finally {
    database.close();
  }
}

async function readFastRoleDetail(
  databasePath: string,
  listingType: ListingType,
  listingId: string,
  retryCount = 0,
): Promise<FastRoleDetailRead | null> {
  try {
    return await readFastRoleDetailAttempt(databasePath, listingType, listingId);
  } catch (error) {
    if (error instanceof FastSnapshotChangedError && retryCount < FAST_SNAPSHOT_MAX_RETRIES - 1) {
      return readFastRoleDetail(databasePath, listingType, listingId, retryCount + 1);
    }
    throw error;
  }
}

interface ClosingSoonNotificationCache {
  contentKey: string;
  notifications: ClosingSoonNotification[];
  nextRefreshAt: number;
}

const closingSoonNotificationCache = new Map<string, ClosingSoonNotificationCache>();

function readStoredClosingSoonNotifications(
  database: DatabaseSync,
  databasePath: string,
  contentKey: string,
  now = Date.now(),
): ClosingSoonNotification[] {
  const cached = closingSoonNotificationCache.get(databasePath);
  if (cached?.contentKey === contentKey && now < cached.nextRefreshAt) return cached.notifications;

  const rows = database.prepare(`
    SELECT id, payload_json
    FROM internships
    WHERE availability_status = 'open'
  `).all() as unknown as Array<{ id: string; payload_json: string }>;
  const roles: DeadlineNotificationRole[] = [];
  const actionRows = readFastActionContextRows(database);
  const hiddenListingKeys = new Set(actionRows.map((row) => row.listing_key));
  const hiddenDestinationLinks = new Set([
    ...actionRows.flatMap((row) => fastActionLinks(row)),
    ...readFastHiddenInternshipLinks(database, actionRows),
  ]);
  const actionMatcher = readDashboardActionMatcher(database);
  for (const row of rows) {
    try {
      const role = InternshipSchema.parse(JSON.parse(row.payload_json));
      const candidate = { ...role, listingType: "internship" as const, listingId: row.id };
      if (dashboardRoleIsHandled(candidate, hiddenListingKeys, actionMatcher, hiddenDestinationLinks)) continue;
      if (!hasRequiredListingKeywords(candidate)) continue;
      roles.push(candidate);
    } catch {
      // A malformed historical payload cannot produce a trustworthy alert.
    }
  }

  const notifications = buildClosingSoonNotifications(roles, now);
  const nextRefreshAt = nextClosingSoonRefreshAt(roles, now) ?? Number.POSITIVE_INFINITY;
  closingSoonNotificationCache.set(databasePath, { contentKey, notifications, nextRefreshAt });
  if (closingSoonNotificationCache.size > 16) {
    const oldestKey = closingSoonNotificationCache.keys().next().value;
    if (oldestKey !== undefined && oldestKey !== databasePath) closingSoonNotificationCache.delete(oldestKey);
  }
  return notifications;
}

type FastChangesRead = {
  metadata: FastVersionMetadata;
  latestRun: RunRow | null;
  latestCompletedRun: RunRow | null;
  runs: RecentDashboardRun[];
  deadlineNotifications: ClosingSoonNotification[];
  scan: Record<string, unknown>;
  board: Pick<GrindJobBoardSnapshot, "status" | "lastAttemptAt" | "lastSuccessfulSyncAt">;
} & DashboardSourceHealth;

async function readFastChangesAttempt(databasePath: string): Promise<FastChangesRead> {
  if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
  const verification = await readVerificationSnapshot();
  const board = grindJobBoardClient.getCachedSnapshot();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const metadata = readFastVersionMetadata(database, board, verification, databasePath);
    const recentRuns = readDashboardRuns(database, RECENT_DASHBOARD_RUN_LIMIT);
    const latestRun = asRun(recentRuns[0]);
    const latestCompletedRun = readLatestCompletedRun(database);
    if (!fastDatabaseRevisionIsCurrent(databasePath, metadata.databaseDataVersion, database)) {
      throw new FastSnapshotChangedError();
    }
    return {
      metadata,
      latestRun,
      latestCompletedRun,
      runs: compactRecentDashboardRuns(recentRuns),
      deadlineNotifications: readStoredClosingSoonNotifications(database, databasePath, metadata.contentKey),
      board: {
        status: board.status,
        lastAttemptAt: board.lastAttemptAt,
        lastSuccessfulSyncAt: board.lastSuccessfulSyncAt,
      },
      ...liveSourceState(database, latestRun, latestCompletedRun),
    };
  } finally {
    database.close();
  }
}

async function readFastChanges(
  databasePath: string,
  retryCount = 0,
): Promise<FastChangesRead> {
  try {
    return await readFastChangesAttempt(databasePath);
  } catch (error) {
    if (error instanceof FastSnapshotChangedError && retryCount < FAST_SNAPSHOT_MAX_RETRIES - 1) {
      return readFastChanges(databasePath, retryCount + 1);
    }
    throw error;
  }
}

function fastRolesEtag(index: FastDashboardIndex, query: FastRolesQuery): string {
  // `relativeBase` is captured per request for deterministic sorting but is
  // not itself representation state. Excluding the clock timestamp keeps
  // polling validators stable; include the local calendar day so relative
  // values can move to a new posting day at midnight.
  const { relativeBase, ...stableQuery } = query;
  const dayKey = dashboardLocalDayKey(relativeBase);
  return `"${sha256(JSON.stringify({ version: index.versionMetadata.version, query: stableQuery, relativeDay: dayKey }))}"`;
}

function fastChangesEtag(changes: FastChangesRead): string {
  return `"${sha256(JSON.stringify({
    version: changes.metadata.version,
    errors24h: changes.errors24h,
    deadlineNotifications: changes.deadlineNotifications.map((notification) => [notification.id, notification.deadlineAt]),
  }))}"`;
}

async function serveFastRoles(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
  requestUrl: URL,
): Promise<void> {
  try {
    const query = parseFastQuery(requestUrl);
    const matchAccess = query.view === "matches"
      ? await loadAuthenticatedMatchPreferences(request, response, databasePath)
      : null;
    if (query.view === "matches" && !matchAccess) return;
    const index = await readFastDashboardIndex(databasePath);
    const page = fastFilterAndPage(index, query, matchAccess?.preferences ?? null);
    const etag = fastRolesEtag(index, query);
    const payload = {
      contract: "dashboard.roles.v1",
      version: index.versionMetadata.version,
      generatedAt: index.generatedAt,
      view: query.view,
      filters: {
        view: query.view,
        tab: query.tab,
        status: query.status,
        category: query.category,
        workMode: query.workMode,
        season: query.season,
        location: query.location,
        search: query.search,
        sort: query.sort,
      },
      filterMeta: {
        tabs: ROLE_TABS,
        tabCounts: index.tabCounts,
        categories: index.categories,
        workModes: ["onsite", "hybrid", "remote"],
        seasons: DASHBOARD_SEASON_FILTERS,
        statuses: ["open", "new", "updated", "all", "closed"],
        sorts: ["relevance", "posted", "season", "recent", "last-seen", "company"],
      },
      stats: index.stats,
      counts: index.tabCounts,
      appliedRoleCount: index.appliedRoleCount,
      configuredSourceCount: index.sources.filter((source) => source.isConfigured).length,
      scan: index.scan,
      status: index.scan,
      latestRun: index.latestRun,
      latestCompletedRun: index.latestCompletedRun,
      runs: compactRecentDashboardRuns(index.runs),
      deadlineNotifications: index.deadlineNotifications,
      sources: index.sources,
      sourceResults: index.sourceResults,
      failures: index.failures,
      errors24h: index.errors24h,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total: page.total,
        hasMore: page.hasMore,
        nextOffset: page.nextOffset,
      },
      items: page.items,
      ...(matchAccess ? {
        preferences: {
          remote: matchAccess.preferences.remote,
          countries: matchAccess.preferences.countries,
          cityCount: matchAccess.preferences.cities.length,
          updatedAt: matchAccess.preferences.updatedAt,
        },
      } : {}),
    };
    if (matchAccess) {
      writeAuthJson(response, 200, payload, matchAccess.context.config, matchAccess.context.responseState);
    } else {
      jsonResponse(response, 200, payload, {
        request,
        etag,
        cacheControl: "private, no-cache, must-revalidate",
      });
    }
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

async function serveFastRoleDetail(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
  listingType: string,
  listingId: string,
): Promise<void> {
  try {
    if (!isListingType(listingType)) throw new DashboardValidationError("listingType must be internship or grind");
    const detail = await readFastRoleDetail(databasePath, listingType, listingId);
    if (!detail) {
      jsonResponse(response, 404, { error: "Role not found" }, { request });
      return;
    }
    const role = {
      ...detail.role,
      listingType,
      listingId,
      isNew: detail.isNew,
      canadianLocation: canadianLocationForRole(detail.role),
    };
    const etag = `"${detail.version}"`;
    jsonResponse(response, 200, {
      contract: "dashboard.role.v1",
      version: detail.version,
      generatedAt: detail.generatedAt,
      role,
    }, {
      request,
      etag,
      cacheControl: "private, no-cache, must-revalidate",
    });
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

async function serveFastChanges(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  try {
    const changes = await readFastChanges(databasePath);
    const etag = fastChangesEtag(changes);
    jsonResponse(response, 200, {
      contract: "dashboard.changes.v1",
      version: changes.metadata.version,
      changed: !etagMatches(request, etag),
      status: changes.scan,
      scan: changes.scan,
      latestRun: changes.latestRun,
      latestCompletedRun: changes.latestCompletedRun,
      runs: changes.runs,
      deadlineNotifications: changes.deadlineNotifications,
      appliedRoleCount: changes.metadata.appliedRoleCount,
      hiddenCount: changes.metadata.hiddenCount,
      stats: {
        hidden: changes.metadata.hiddenCount,
      },
      board: changes.board,
      sources: changes.sources,
      sourceResults: changes.sourceResults,
      failures: changes.failures,
      errors24h: changes.errors24h,
    }, {
      request,
      etag,
      cacheControl: "private, no-cache, must-revalidate",
    });
  } catch (error) {
    jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

function isListingType(value: unknown): value is ListingType {
  return value === "internship" || value === "grind";
}

function isListingAction(value: unknown): value is ListingAction {
  return value === "applied" || value === "cant_fit";
}

function requiredString(value: unknown, field: string, maximumLength = 500): string {
  if (typeof value !== "string") throw new DashboardValidationError(`${field} must be a string`);
  const normalized = value.trim();
  if (!normalized) throw new DashboardValidationError(`${field} is required`);
  if (normalized.length > maximumLength) throw new DashboardValidationError(`${field} is too long`);
  return normalized;
}

function optionalString(value: unknown, field: string, maximumLength = 2_000): string | null {
  if (value === undefined || value === null || value === "") return null;
  return requiredString(value, field, maximumLength);
}

function optionalHttpUrl(value: unknown, field: string): string | null {
  const normalized = optionalString(value, field);
  if (!normalized) return null;
  try {
    const canonical = canonicalizeUrl(normalized);
    if (!/^https?:$/i.test(new URL(canonical).protocol)) throw new DashboardValidationError(`${field} must be an HTTP(S) URL`);
    return canonical;
  } catch (error) {
    if (error instanceof DashboardValidationError) throw error;
    throw new DashboardValidationError(error instanceof Error ? error.message : String(error));
  }
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request as AsyncIterable<Buffer | string>) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 100_000) throw new DashboardValidationError("Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function recordListingAction(
  request: IncomingMessage,
  response: ServerResponse,
  databasePath: string,
): Promise<void> {
  try {
    if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
    let body: Record<string, unknown>;
    const rawBody = await readRequestBody(request);
    try {
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } catch {
      throw new DashboardValidationError("Request body must be valid JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new DashboardValidationError("Request body must be a JSON object");
    if (!isListingType(body.listingType)) throw new DashboardValidationError("listingType must be internship or grind");
    if (!isListingAction(body.action)) throw new DashboardValidationError("action must be applied or cant_fit");
    const listingType = body.listingType;
    const action = body.action;
    const listingId = requiredString(body.listingId, "listingId");
    const company = requiredString(body.company, "company");
    const title = requiredString(body.title, "title");
    let actionContext: ListingActionContext = {
      applicationUrl: optionalHttpUrl(body.applicationUrl, "applicationUrl"),
      postingUrl: optionalHttpUrl(body.postingUrl, "postingUrl"),
      jobId: optionalString(body.jobId, "jobId"),
      location: optionalString(body.location, "location"),
    };
    if (listingType === "grind" && !Object.values(actionContext).some(Boolean)) {
      try {
        const board = await readBoardSnapshot();
        const job = board.jobs.find((candidate) => candidate.id === listingId);
        if (job) {
          actionContext = {
            applicationUrl: job.link,
            postingUrl: job.link,
            jobId: job.jobId,
            location: job.location,
          };
        }
      } catch {
        // The action itself remains valid if the read-only live board is
        // temporarily unavailable; the listing key is still recorded.
      }
    }
    const listingKey = listingActionKey(listingType, listingId);
    const createdAt = new Date().toISOString();
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 30000");
      database.exec("BEGIN IMMEDIATE");
      try {
        // Keep schema creation/migration under the same write reservation as
        // the action.  A dashboard request can race a scout constructor or
        // another action request on a legacy database.
        ensureListingActionSchema(database);
        let internship: Internship | null = null;
        if (listingType === "internship") {
          const row = database.prepare("SELECT payload_json FROM internships WHERE id = @id").get({ id: listingId }) as unknown as { payload_json: string } | undefined;
          if (row) {
            try {
              internship = InternshipSchema.parse(JSON.parse(row.payload_json));
            } catch {
              internship = null;
            }
          }
        }
        const resolvedActionContext = mergeListingActionContext(actionContext, internship);
        database.prepare(`
          INSERT INTO listing_actions (
            listing_key, listing_type, listing_id, action, company, normalized_company, title,
            application_url, posting_url, job_id, location, created_at
          ) VALUES (
            @listingKey, @listingType, @listingId, @action, @company, @normalizedCompany, @title,
            @applicationUrl, @postingUrl, @jobId, @location, @createdAt
          )
          ON CONFLICT(listing_key) DO UPDATE SET
            action = excluded.action,
            company = excluded.company,
            normalized_company = excluded.normalized_company,
            title = excluded.title,
            application_url = COALESCE(excluded.application_url, listing_actions.application_url),
            posting_url = COALESCE(excluded.posting_url, listing_actions.posting_url),
            job_id = COALESCE(excluded.job_id, listing_actions.job_id),
            location = COALESCE(excluded.location, listing_actions.location),
            application_status = CASE
              WHEN excluded.action = 'applied' AND listing_actions.action <> 'applied' THEN 'pending'
              ELSE listing_actions.application_status
            END,
            application_stage = CASE
              WHEN excluded.action = 'applied' AND listing_actions.action <> 'applied' THEN 'applied'
              ELSE listing_actions.application_stage
            END,
            created_at = excluded.created_at
        `).run({
          listingKey,
          listingType,
          listingId,
          action,
          company,
          normalizedCompany: normalizeCompanyIdentity(company),
          title,
          applicationUrl: resolvedActionContext.applicationUrl ?? null,
          postingUrl: resolvedActionContext.postingUrl ?? null,
          jobId: resolvedActionContext.jobId ?? null,
          location: resolvedActionContext.location ?? null,
          createdAt,
        });
        replaceListingActionIdentities(database, listingKey, listingType, listingId, company, title, internship, resolvedActionContext);
        const countRow = database.prepare(`
          SELECT COUNT(*) AS count
          FROM listing_actions
          WHERE action = 'applied'
        `).get() as unknown as { count: number | bigint };
        const listingAction: ListingActionRecord = {
          listingKey,
          listingType,
          listingId,
          action,
          company,
          title,
          createdAt,
        };
        const payload = {
          ok: true,
          listingAction,
          appliedRoleCount: Number(countRow.count),
          closedCount: readClosedCount(database),
          hiddenCount: readHiddenCount(database),
        };
        database.exec("COMMIT");
        jsonResponse(response, 200, payload);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

function undoListingAction(
  request: IncomingMessage,
  requestUrl: URL,
  response: ServerResponse,
  databasePath: string,
): void {
  try {
    if (!existsSync(databasePath)) throw new Error(`Database not found: ${databasePath}`);
    const listingType = requestUrl.searchParams.get("listingType");
    if (!isListingType(listingType)) throw new DashboardValidationError("listingType must be internship or grind");
    const listingId = requiredString(requestUrl.searchParams.get("listingId"), "listingId");
    const listingKey = listingActionKey(listingType, listingId);
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout = 30000");
      database.exec("BEGIN IMMEDIATE");
      try {
        ensureListingActionSchema(database);
        const result = database.prepare(`
          DELETE FROM listing_actions WHERE listing_key = @listingKey
        `).run({ listingKey });
        database.prepare("DELETE FROM listing_action_identities WHERE listing_key = @listingKey").run({ listingKey });
        const countRow = database.prepare(`
          SELECT COUNT(*) AS count
          FROM listing_actions
          WHERE action = 'applied'
        `).get() as unknown as { count: number | bigint };
        const payload = {
          ok: true,
          removed: Number(result.changes) > 0,
          listingKey,
          appliedRoleCount: Number(countRow.count),
          closedCount: readClosedCount(database),
          hiddenCount: readHiddenCount(database),
        };
        database.exec("COMMIT");
        jsonResponse(response, 200, payload);
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    } finally {
      database.close();
    }
  } catch (error) {
    const status = error instanceof DashboardValidationError ? 400 : 503;
    jsonResponse(response, status, { error: error instanceof Error ? error.message : String(error) }, { request });
  }
}

function startConfiguredSourceScan(
  databasePath: string,
  settings: ScoutSettings,
  trigger: Exclude<DashboardScanTrigger, "existing" | null>,
  sourcesToCrawl = readConfiguredSourceUrlsAtPath(databasePath),
): boolean {
  recordFinalizedCancellations(finalizeCancellationRequests(databasePath));
  if (activeScan?.cancellation.signal.aborted) activeScan = null;
  if (activeScan) return false;

  const existingRun = readRunningRun(databasePath);
  if (isFreshRunningRun(existingRun)) {
    scanState = {
      status: "RUNNING",
      trigger: "existing",
      startedAt: existingRun?.started_at ?? null,
      finishedAt: null,
      runId: existingRun?.id ?? null,
      error: null,
      currentSources: [],
    };
    return false;
  }

  const startedAt = new Date().toISOString();
  scanState = {
    status: "RUNNING",
    trigger,
    startedAt,
    finishedAt: null,
    runId: null,
    error: null,
    currentSources: [],
  };
  const cancellation = new AbortController();
  let execution: Promise<ScoutExecution | null>;
  try {
    const scoutOptions: ScoutRunOptions = {
      sources: sourcesToCrawl,
      settings,
      cancellationSignal: cancellation.signal,
      onRunStarted: rememberScanRunId,
      onSourceStarted: rememberScanSourceStart,
      onSourceSettled: rememberScanSourceSettled,
      // Let persistRun finish its synchronous legacy result projection and
      // allow its export writes to be queued before the read-side prewarm
      // consumes CPU. The durable commit notification remains immediate, but
      // the expensive observer starts at the next event-loop turn.
      onRunCommitted: (runId) => {
        setImmediate(() => schedulePostRunFastDashboardPrewarm(databasePath, `run:${runId}`));
      },
      filters: {
        categories: [],
        newOnly: false,
        minScore: settings.minRelevanceScore,
      },
    };
    const runner = dashboardScoutRunnerForTests;
    execution = runner
      ? runner(scoutOptions)
      : (dashboardCrawlLauncherForTests ?? launchDashboardCrawlWorker)(scoutOptions);
  } catch (error) {
    // `runScout` is async and normally reports setup failures through its
    // promise. Keep this guard for injected runners and future synchronous
    // setup so startup cannot lose its listener to an uncaught throw.
    scanState = {
      ...scanState,
      status: "FAILED",
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
  const currentScan: ActiveScan = { execution, cancellation };
  activeScan = currentScan;
  void execution.then(
    (result) => {
      if (activeScan !== currentScan) return;
      const latestRunId = result?.persisted.runId ?? readLatestRunId(databasePath);
      scanState = {
        ...scanState,
        status: "COMPLETED",
        finishedAt: new Date().toISOString(),
        runId: latestRunId,
        error: null,
        currentSources: [],
      };
      if (latestRunId !== null) {
        setImmediate(() => schedulePostRunFastDashboardPrewarm(databasePath, `run:${latestRunId}`));
      }
    },
    (error: unknown) => {
      if (activeScan !== currentScan) return;
      scanState = {
        ...scanState,
        status: "FAILED",
        finishedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
        currentSources: [],
      };
      console.error(`[DASHBOARD SCAN FAILED] ${scanState.error}`);
    },
  ).finally(() => {
    if (activeScan !== currentScan) return;
    activeScan = null;
    const queued = queuedSourceScan;
    queuedSourceScan = null;
    if (queued) {
      setImmediate(() => {
        try {
          startConfiguredSourceScan(queued.databasePath, queued.settings, "refresh", queued.sources);
        } catch (error) {
          scanState = {
            ...scanState,
            status: "FAILED",
            finishedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          };
          console.error(`[DASHBOARD QUEUED SCAN FAILED] ${scanState.error}`);
        }
      });
    }
  });
  return true;
}

function startDashboardStartupScan(databasePath: string, settings: ScoutSettings): boolean {
  if (process.env.DASHBOARD_SKIP_STARTUP_SCAN === "1") {
    console.log("[DASHBOARD SCAN] Startup scan disabled by DASHBOARD_SKIP_STARTUP_SCAN");
    return false;
  }
  try {
    const started = startConfiguredSourceScan(databasePath, settings, "startup");
    console.log(started
      ? `[DASHBOARD SCAN] Checking all ${readConfiguredSourceUrlsAtPath(databasePath).length} configured sources`
      : "[DASHBOARD SCAN] An existing source check is already running");
    return started;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    scanState = {
      ...scanState,
      status: "FAILED",
      finishedAt: new Date().toISOString(),
      error: message,
    };
    console.error(`[DASHBOARD SCAN START FAILED] ${message}`);
    return false;
  }
}

export function startDashboardStartupScanForTests(databasePath: string, settings: ScoutSettings): boolean {
  return startDashboardStartupScan(databasePath, settings);
}

export async function requestHandler(request: IncomingMessage, response: ServerResponse, databasePath: string): Promise<void> {
  const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
  const pathname = requestUrl.pathname;
  if (await handleAuthRequest(request, response, requestUrl)) return;
  if (await handlePreferenceRequest(request, response, requestUrl, databasePath)) return;
  if (pathname === "/api/changes" || pathname === "/api/status") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "Only GET is supported for dashboard status" }, { request });
      return;
    }
    await serveFastChanges(request, response, databasePath);
    return;
  }
  if (pathname === "/api/roles") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "Only GET is supported for paginated roles" }, { request });
      return;
    }
    await serveFastRoles(request, response, databasePath, requestUrl);
    return;
  }
  if (pathname.startsWith("/api/roles/")) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "Only GET is supported for role details" }, { request });
      return;
    }
    const segments = pathname.split("/").filter(Boolean);
    if (segments.length !== 4) {
      jsonResponse(response, 404, { error: "Role detail route requires listing type and id" }, { request });
      return;
    }
    let listingType: string;
    let listingId: string;
    try {
      listingType = decodeURIComponent(segments[2] ?? "");
      listingId = decodeURIComponent(segments[3] ?? "");
    } catch {
      jsonResponse(response, 400, { error: "Invalid role route" }, { request });
      return;
    }
    await serveFastRoleDetail(request, response, databasePath, listingType, listingId);
    return;
  }
  if (pathname === "/api/applications") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "Only GET is supported for applications" }, { request });
      return;
    }
    await serveApplications(request, response, databasePath);
    return;
  }
  if (pathname === "/api/applications/status") {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Use POST to update an application status" }, { request });
      return;
    }
    await updateApplicationStage(request, response, databasePath);
    invalidateDashboardDataCache();
    return;
  }
  if (pathname === "/api/actions") {
    if (request.method === "DELETE") {
      undoListingAction(request, requestUrl, response, databasePath);
      invalidateDashboardDataCache();
      return;
    }
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Use POST to save or DELETE to undo a listing decision" }, { request });
      return;
    }
    await recordListingAction(request, response, databasePath);
    invalidateDashboardDataCache();
    return;
  }
  if (pathname === "/api/data") {
    if (request.method !== "GET" && request.method !== "HEAD") {
      jsonResponse(response, 405, { error: "Only GET is supported for /api/data" }, { request });
      return;
    }
    try {
      if (dashboardDataCache !== null && dashboardDataCache.postingAgeWindow === dashboardPostingAgeKey()) {
        startBackgroundDashboardDataRefresh(databasePath);
        jsonResponseBody(response, 200, dashboardDataCache.body, { request });
        return;
      }
      const payload = await startDashboardDataRefresh(databasePath);
      jsonResponse(response, 200, payload, { request });
    } catch (error) {
      jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) }, { request });
    }
    return;
  }
  if (pathname === "/api/terminate") {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Use POST to terminate the current crawl" }, { request });
      return;
    }
    try {
      const reconciledRunIds = finalizeCancellationRequests(databasePath);
      recordFinalizedCancellations(reconciledRunIds);
      const termination = requestRunTermination(databasePath);
      const runId = termination.runId ?? reconciledRunIds[0] ?? null;
      if (termination.runId) recordFinalizedCancellations([termination.runId]);
      const finalized = termination.finalized || reconciledRunIds.length > 0;
      invalidateDashboardDataCache();
      jsonResponse(response, 200, {
        ok: true,
        runId,
        requested: termination.requested || reconciledRunIds.length > 0,
        finalized,
        message: runId ? "Run terminated." : "No crawl is currently running.",
      });
    } catch (error) {
      jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) }, { request });
    }
    return;
  }
  if (pathname === "/api/sources") {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Use POST to add a source" }, { request });
      return;
    }
    await addConfiguredSource(request, response, databasePath);
    return;
  }
  if (pathname === "/api/refresh" || pathname === "/api/scan") {
    if (request.method !== "POST") {
      jsonResponse(response, 405, { error: "Use POST to check every configured source" }, { request });
      return;
    }
    try {
      const started = startConfiguredSourceScan(databasePath, dashboardSettings, "refresh");
      // Refresh is write-side run control. Return immediately and let the
      // regular version poll observe completed crawl data; do not rebuild the
      // legacy full snapshot in this mutation response.
      jsonResponse(response, started ? 202 : 200, {
        started,
        scan: scanPayload(readRunningRun(databasePath), undefined, databasePath),
      }, { request, cacheControl: "no-store" });
    } catch (error) {
      // A locked/unavailable database is an operational failure, not a client
      // validation error. Keep the mutation response small and actionable;
      // the next refresh can retry once the owning scout releases the lock.
      jsonResponse(response, 503, { error: error instanceof Error ? error.message : String(error) }, { request, cacheControl: "no-store" });
    }
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    jsonResponse(response, 405, { error: "Only GET is supported" }, { request });
    return;
  }
  await serveStatic(request, response, pathname);
}

function cliValue(name: string, fallback: string): string {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value ?? fallback;
}

const port = Number.parseInt(cliValue("--port", process.env.DASHBOARD_PORT ?? "4173"), 10);
const host = cliValue("--host", process.env.DASHBOARD_HOST ?? "127.0.0.1");
const databasePath = resolve(cliValue("--database", process.env.SCOUT_DATABASE_PATH ?? DEFAULT_DATABASE));
const outputDirectory = resolve(cliValue("--output-dir", process.env.SCOUT_OUTPUT_DIR ?? dirname(databasePath)));
const dashboardSettings = resolveSettings({ databasePath, outputDirectory });

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("--port must be between 1 and 65535");

const isDashboardEntrypoint = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDashboardEntrypoint) {
  try {
    ensureListingActionsTable(databasePath);
  } catch (error) {
    // Do not let a transient migration lock turn into a silent loss of the
    // automatic dashboard startup path. The request server can still serve
    // reads against the already-created schema, while the error is visible
    // and manual/scheduled run control can retry through its normal path.
    console.error(`[DASHBOARD STARTUP MIGRATION FAILED] ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ensurePreferenceSchema(databasePath);
  } catch (error) {
    console.error(`[PREFERENCE MIGRATION FAILED] ${error instanceof Error ? error.message : String(error)}`);
  }
  const server = createServer((request, response) => {
    requestHandler(request, response, databasePath).catch((error: unknown) => {
      jsonResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
    });
  });
  server.on("close", () => {
    stopDashboardRunWatcher();
    closeFastDatabaseRevisionTrackers();
  });

  const listen = (): void => {
    server.listen(port, host, () => {
      console.log(`Internship dashboard listening at http://${host}:${port}`);
      console.log(`Reading ${databasePath}`);
      startDashboardRunWatcher(databasePath);
      startDashboardStartupScan(databasePath, dashboardSettings);
    });
  };
  // Build the compact index from the exact runtime DB/output configuration
  // before accepting HTTP requests. The prewarm deliberately uses only the
  // durable board projection; crawler startup and live-board refresh remain
  // outside this boundary. Before listening, reconcile the successful
  // prewarm revision against a suppressed watcher baseline so a durable
  // external commit in that narrow handoff cannot be mistaken for covered
  // content. Any failure/timeout falls back to normal on-demand construction,
  // so startup remains available on legacy or damaged stores.
  void prewarmFastDashboardIndex(databasePath)
    .then((succeeded) => prepareDashboardRunWatcherAfterPrewarm(databasePath, succeeded))
    .catch((error: unknown) => {
      // Keep the startup continuation alive even if a future prewarm change
      // introduces an error outside its normal bounded fallback handling.
      console.error(`[DASHBOARD PREWARM FAILED] ${error instanceof Error ? error.message : String(error)}`);
      return prepareDashboardRunWatcherAfterPrewarm(databasePath, false);
    })
    .finally(listen);
}
