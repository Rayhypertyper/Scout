import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { chromium, type Browser, type BrowserContext, type Page, type Request, type Response } from "playwright";

import {
  BUDGET_METRICS,
  evaluateBudgets,
  median,
  parseBudgetConfig,
  type BenchmarkPhase,
  type BudgetEvaluation,
  type PerformanceBudgetConfig,
} from "./budget.js";

const PROJECT_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_DATABASE = join(PROJECT_ROOT, "output", "live", "internships.db");
const DEFAULT_BOARD_CACHE = join(PROJECT_ROOT, "output", "live", "source-cache", "grind-job-board.json");
const DEFAULT_BUDGET = join(PROJECT_ROOT, "scripts", "performance", "budget.json");
const DEFAULT_JSON_OUTPUT = join(PROJECT_ROOT, "output", "performance", "dashboard-latest.json");
const SERVER_ENTRYPOINT = join(PROJECT_ROOT, "dist", "src", "dashboard.js");
const NETWORK_GUARD = join(PROJECT_ROOT, "scripts", "performance", "no-external-network.mjs");
const DEFAULT_TIMEOUT_MS = 30_000;

interface CliOptions {
  sourceDatabase: string;
  sourceBoardCache: string;
  budgetPath: string;
  jsonOutput: string;
  coldRepeats: number;
  warmRepeats: number;
  timeoutMs: number;
  skipBuild: boolean;
  strictUnsupported: boolean;
}

interface InteractionMetric {
  status: "measured" | "unsupported";
  durationMs?: number;
  resultCount?: number;
  requestUrl?: string;
  requestTtfbMs?: number | null;
  requestCompletionMs?: number | null;
  responseBodyBytes?: number | null;
  responseTransferBytes?: number | null;
  reason?: string;
}

interface SampleMetrics {
  timeToUsableCardsMs: number | null;
  shellFcpMs: number | null;
  lcpMs: number | null;
  apiListTtfbMs: number | null;
  apiListCompletionMs: number | null;
  apiListBodyBytes: number | null;
  apiListTransferBytes: number | null;
  changesTtfbMs: number | null;
  changesCompletionMs: number | null;
  changesBodyBytes: number | null;
  changesTransferBytes: number | null;
  initialJsBodyBytes: number | null;
  initialJsTransferBytes: number | null;
  initialApiBodyBytes: number | null;
  initialApiTransferBytes: number | null;
  initialBodyBytes: number | null;
  initialTransferBytes: number | null;
  requestCount: number | null;
  initialRolesRequestCount: number | null;
  initialChangesRequestCount: number | null;
  legacyApiDataRequests: number | null;
  initialJobsTransferred: number | null;
  totalJobsAvailable: number | null;
  initialCardsRendered: number | null;
  domNodes: number | null;
  cls: number | null;
  searchInteractionMs: number | null;
  categoryInteractionMs: number | null;
  filterInteractionMs: number | null;
  tabInteractionMs: number | null;
  loadMoreMs: number | null;
  detailFetchMs: number | null;
  detailOpenMs: number | null;
  warmReloadMs: number | null;
}

interface Sample extends SampleMetrics {
  repeat: number;
  capturedAt: string;
  initialTransferComplete: boolean;
  initialTransferMissingResponses: number;
  interactions: {
    search: InteractionMetric;
    category: InteractionMetric;
    filter: InteractionMetric;
    tab: InteractionMetric;
    loadMore: InteractionMetric;
    detail: InteractionMetric;
  };
  requestFacts: {
    initialRolesRequests: number;
    initialChangesRequests: number;
    initialDetailRequests: number;
    legacyApiDataRequests: number;
    browserExternalRequests: number;
    initialWaterfall: Array<{
      url: string;
      resourceType: string;
      status: number | null;
      requestStartedAtMs: number;
      responseStartedAtMs: number | null;
      responseCompletedAtMs: number | null;
      bodyBytes: number | null;
      transferBytes: number | null;
      requestStartedBeforeCards: boolean;
    }>;
  };
  unsupported: Array<{ metric: string; reason: string }>;
}

interface PhaseResult {
  phase: BenchmarkPhase;
  repeats: number;
  samples: Sample[];
  median: SampleMetrics;
  budget: BudgetEvaluation;
}

interface BenchmarkOutput {
  schemaVersion: 1;
  benchmark: {
    name: "dashboard-production-frozen-fixture";
    capturedAt: string;
    node: string;
    browser: string;
    playwright: string;
    sourceDatabase: string;
    sourceBoardCache: string;
    coldRepeats: number;
    warmRepeats: number;
    timeoutMs: number;
  };
  isolation: {
    database: "serialized temporary SQLite copy";
    boardCache: "temporary copied cache";
    startupCrawl: "blocked by fresh synthetic RUNNING row";
    externalFetch: "non-loopback fetch rejected in dashboard child process";
    externalWrites: "dashboard points only at temporary database/output paths";
    cleanup: "temporary fixture removed in finally";
  };
  startup: {
    coldServerReadyMs: number[];
    coldServerReadyMedianMs: number;
    coldServerReadyMinMs: number;
    coldServerReadyMaxMs: number;
    warmServerReadyMs: number;
    warmPrewarmMs: number;
  };
  requestFacts: {
    browserExternalRequests: number;
    blockedExternalFetchAttempts: number;
    legacyApiDataRequests: number;
    duplicateInitialRolesRequests: number;
    eagerInitialDetailRequests: number;
  };
  phases: Record<BenchmarkPhase, PhaseResult>;
  unsupported: Array<{ phase: BenchmarkPhase; metric: string; reason: string }>;
  overallBudgetStatus: "pass" | "fail" | "incomplete";
}

interface CapturedRequest {
  request: Request;
  startedAt: number;
  response?: Response;
  bodyBytes: number | null;
  bodyText: string | null;
  transferBytes: number | null;
  status: number | null;
}

interface RunningServer {
  child: ChildProcess;
  baseUrl: string;
  readyMs: number;
  output: () => string;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nowMs(): number {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(name);
}

function parseOptions(argv: string[]): CliOptions {
  const sourceDatabase = resolve(argument(argv, "--database") ?? DEFAULT_DATABASE);
  const sourceBoardCache = resolve(argument(argv, "--board-cache") ?? DEFAULT_BOARD_CACHE);
  const budgetPath = resolve(argument(argv, "--budget") ?? DEFAULT_BUDGET);
  const jsonOutput = resolve(argument(argv, "--json-output") ?? DEFAULT_JSON_OUTPUT);
  return {
    sourceDatabase,
    sourceBoardCache,
    budgetPath,
    jsonOutput,
    coldRepeats: parsePositiveInteger(argument(argv, "--cold-repeats") ?? "5", "--cold-repeats"),
    warmRepeats: parsePositiveInteger(argument(argv, "--warm-repeats") ?? "5", "--warm-repeats"),
    timeoutMs: parsePositiveInteger(argument(argv, "--timeout-ms") ?? String(DEFAULT_TIMEOUT_MS), "--timeout-ms"),
    skipBuild: hasFlag(argv, "--skip-build"),
    strictUnsupported: hasFlag(argv, "--strict-unsupported"),
  };
}

async function runCommand(command: string, args: string[], label: string): Promise<void> {
  const child = spawn(command, args, {
    cwd: PROJECT_ROOT,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-8_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  await new Promise<void>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`${label} failed (code=${code ?? "null"}, signal=${signal ?? "none"})\n${output}`));
    });
  });
}

async function findFreePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = probe.address();
  await new Promise<void>((resolvePromise) => probe.close(() => resolvePromise()));
  if (!address || typeof address === "string") throw new Error("Could not allocate a local benchmark port");
  return address.port;
}

async function copyDatabaseSnapshot(sourcePath: string, destinationPath: string): Promise<void> {
  if (!existsSync(sourcePath)) throw new Error(`Database not found: ${sourcePath}`);
  const source = new DatabaseSync(sourcePath, { readOnly: true });
  let snapshot: Uint8Array;
  try {
    snapshot = source.serialize();
  } finally {
    source.close();
  }
  await mkdir(dirname(destinationPath), { recursive: true });
  await writeFile(destinationPath, snapshot);
}

/** Add a fresh lease so dashboard startup treats the copied DB as already scanning. */
function addSyntheticRunningRow(databasePath: string): void {
  const database = new DatabaseSync(databasePath);
  try {
    const columns = new Set((database.prepare("PRAGMA table_info(crawl_runs)").all() as unknown as Array<{ name: string }>).map((row) => row.name));
    if (!columns.has("status") || !columns.has("started_at") || !columns.has("options_json") || !columns.has("sources_requested")) {
      throw new Error("Copied database does not contain the expected crawl_runs columns");
    }
    const fields = ["started_at", "status", "options_json", "sources_requested"];
    const values = ["@startedAt", "'RUNNING'", "@options", "0"];
    if (columns.has("heartbeat_at")) {
      fields.splice(1, 0, "heartbeat_at");
      values.splice(1, 0, "@heartbeatAt");
    }
    const now = new Date().toISOString();
    database.prepare(`INSERT INTO crawl_runs (${fields.join(", ")}) VALUES (${values.join(", ")})`).run({
      startedAt: now,
      heartbeatAt: now,
      options: JSON.stringify({ benchmark: true, externalNetwork: "blocked" }),
    });
  } finally {
    database.close();
  }
}

async function createFixture(root: string, sourceDatabase: string, sourceBoardCache: string, name: string): Promise<{ databasePath: string; boardCachePath: string; outputDirectory: string }> {
  if (!existsSync(sourceBoardCache)) throw new Error(`Board cache not found: ${sourceBoardCache}`);
  const fixtureRoot = join(root, name);
  const databasePath = join(fixtureRoot, "output", "live", "internships.db");
  const boardCachePath = join(fixtureRoot, "output", "live", "source-cache", "grind-job-board.json");
  const outputDirectory = dirname(databasePath);
  await copyDatabaseSnapshot(sourceDatabase, databasePath);
  await mkdir(dirname(boardCachePath), { recursive: true });
  await writeFile(boardCachePath, await readFile(sourceBoardCache));
  addSyntheticRunningRow(databasePath);
  return { databasePath, boardCachePath, outputDirectory };
}

async function startServer(fixture: { databasePath: string; boardCachePath: string; outputDirectory: string }, timeoutMs: number): Promise<RunningServer> {
  const port = await findFreePort();
  const startedAt = nowMs();
  const child = spawn(process.execPath, [
    "--import", NETWORK_GUARD,
    SERVER_ENTRYPOINT,
    "--host", "127.0.0.1",
    "--port", String(port),
    "--database", fixture.databasePath,
    "--output-dir", fixture.outputDirectory,
  ], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      INTERNSHIPMATIC_ROOT: PROJECT_ROOT,
      SCOUT_DATABASE_PATH: fixture.databasePath,
      SCOUT_OUTPUT_DIR: fixture.outputDirectory,
      GRIND_JOB_BOARD_CACHE_PATH: fixture.boardCachePath,
      GRIND_JOB_BOARD_CONVEX_URL: "http://127.0.0.1:9",
      DASHBOARD_HOST: "127.0.0.1",
      DASHBOARD_PORT: String(port),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const append = (chunk: Buffer): void => {
    output = `${output}${chunk.toString("utf8")}`.slice(-12_000);
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const exit = new Promise<number | null>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code));
    child.once("error", () => resolvePromise(null));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = nowMs() + timeoutMs;
  try {
    while (nowMs() < deadline) {
      const exited = await Promise.race([exit.then(() => true), sleep(50).then(() => false)]);
      if (exited) throw new Error(`Dashboard server exited before readiness\n${output}`);
      try {
        const response = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(500) });
        if (response.ok) break;
      } catch {
        // The listener may still be starting.
      }
    }
    if (nowMs() >= deadline) throw new Error(`Timed out waiting for dashboard server\n${output}`);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exit, sleep(1_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([exit, sleep(1_000)]);
    }
    throw error;
  }
  const readyMs = nowMs() - startedAt;
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    const stopped = await Promise.race([exit.then(() => true), sleep(3_000).then(() => false)]);
    if (!stopped) {
      child.kill("SIGKILL");
      await Promise.race([exit, sleep(1_000)]);
    }
  };
  return { child, baseUrl, readyMs, output: () => output, stop };
}

async function installLayoutShiftObserver(page: Page): Promise<void> {
  // Keep this init script as a string: tsx's browser callback serialization can
  // otherwise leave its private __name helper in the page context.
  await page.addInitScript(`
    (() => {
      const marker = { layoutShifts: [], lcpEntries: [], apiBodies: {} };
      Object.defineProperty(window, "__internshipmaticBenchmark", { value: marker, configurable: true });
      try {
        new PerformanceObserver(function(list) {
          for (const entry of list.getEntries()) {
            if (typeof entry.value === "number") marker.layoutShifts.push({ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput === true });
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        try {
          new PerformanceObserver(function(list) {
            for (const entry of list.getEntries()) {
              if (typeof entry.value === "number") marker.layoutShifts.push({ startTime: entry.startTime, value: entry.value, hadRecentInput: entry.hadRecentInput === true });
            }
          }).observe({ entryTypes: ["layout-shift"] });
        } catch { /* unsupported browser metric */ }
      }
      try {
        new PerformanceObserver(function(list) {
          for (const entry of list.getEntries()) marker.lcpEntries.push({ startTime: entry.startTime, size: entry.size || 0 });
        }).observe({ type: "largest-contentful-paint", buffered: true });
      } catch { /* unsupported browser metric */ }
      const originalFetch = window.fetch.bind(window);
      window.fetch = function(input, init) {
        const rawUrl = typeof input === "string" ? input : input && typeof input === "object" && "url" in input ? input.url : String(input);
        const responsePromise = originalFetch(input, init);
        return responsePromise.then(function(response) {
          try {
            const parsed = new URL(rawUrl, window.location.href);
            if (parsed.pathname.startsWith("/api/")) {
              response.clone().text().then(function(text) { marker.apiBodies[parsed.pathname] = text; });
            }
          } catch { /* benchmark marker only */ }
          return response;
        });
      };
    })();
  `);
}

function clsFromEntries(entries: Array<{ startTime: number; value: number; hadRecentInput: boolean }>): number | null {
  const shifts = entries.filter((entry) => !entry.hadRecentInput).toSorted((left, right) => left.startTime - right.startTime);
  if (shifts.length === 0) return null;
  let sessionStart = shifts[0]?.startTime ?? 0;
  let previous = sessionStart;
  let sessionValue = 0;
  let maximum = 0;
  for (const shift of shifts) {
    if (shift.startTime - previous > 1_000 || shift.startTime - sessionStart > 5_000) {
      maximum = Math.max(maximum, sessionValue);
      sessionStart = shift.startTime;
      sessionValue = shift.value;
    } else {
      sessionValue += shift.value;
    }
    previous = shift.startTime;
  }
  return Math.max(maximum, sessionValue);
}

function pathnameOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ""; }
}

function isLoopbackUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ["127.0.0.1", "localhost", "[::1]", "::1"].includes(parsed.hostname);
  } catch { return false; }
}

function requestTiming(capture: CapturedRequest): { ttfbMs: number | null; completionMs: number | null } {
  const timing = capture.request.timing();
  return {
    ttfbMs: timing.requestStart >= 0 && timing.responseStart >= timing.requestStart ? timing.responseStart - timing.requestStart : null,
    completionMs: timing.requestStart >= 0 && timing.responseEnd >= timing.requestStart ? timing.responseEnd - timing.requestStart : null,
  };
}

async function settleCapture(capture: CapturedRequest): Promise<void> {
  if (!capture.response) return;
  try {
    await capture.response.finished();
    capture.status = capture.response.status();
    const sizes = await capture.request.sizes();
    if (sizes.responseBodySize >= 0) capture.transferBytes = sizes.responseBodySize + Math.max(0, sizes.responseHeadersSize);
    if (sizes.responseBodySize >= 0) capture.bodyBytes = sizes.responseBodySize;
    try {
      const body = await capture.response.body();
      capture.bodyBytes = body.byteLength;
      capture.bodyText = body.toString("utf8");
    } catch {
      // Encoded sizes remain valid if the browser has released the body.
    }
  } catch {
    // Leave response metrics explicitly unsupported rather than estimating.
  }
}

/**
 * Wait briefly for requests that began during the initial navigation to emit
 * their response event, then drain every response that is available.  The
 * changes poll intentionally runs after the role list is usable, so it can
 * still be in flight at that marker.  A bounded wait makes its contribution
 * to the initial waterfall observable without allowing a broken endpoint to
 * hang the whole benchmark.
 */
async function settleCaptures(captures: readonly CapturedRequest[], timeoutMs: number): Promise<void> {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline && captures.some((capture) => !capture.response)) await sleep(10);
  await Promise.allSettled(captures.filter((capture) => capture.response).map((capture) => settleCapture(capture)));
}

async function waitForRequest(
  captures: Map<Request, CapturedRequest>,
  predicate: (capture: CapturedRequest) => boolean,
  after: number,
  timeoutMs: number,
): Promise<CapturedRequest | null> {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    const capture = [...captures.values()].find((candidate) => candidate.startedAt >= after && predicate(candidate));
    if (capture?.response) {
      await settleCapture(capture);
      return capture;
    }
    await sleep(10);
  }
  return null;
}

async function waitForRolesReady(page: Page, timeoutMs: number, minimumCards = 1): Promise<void> {
  await page.waitForFunction((minimum) => (
    !document.querySelector("#role-list .loading-state")
      && document.querySelectorAll("#role-list .role-card").length >= minimum
  ), minimumCards, { timeout: timeoutMs });
}

async function dispatchControl(page: Page, control: string, value: string, eventName: string): Promise<void> {
  await page.evaluate(({ control: selector, value: nextValue, eventName: event }) => {
    const element = document.querySelector(selector);
    if (!element) return;
    if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) element.value = nextValue;
    element.dispatchEvent(new Event(event, { bubbles: true }));
  }, { control, value, eventName });
}

async function measureRolesInteraction(
  page: Page,
  captures: Map<Request, CapturedRequest>,
  action: () => Promise<void>,
  timeoutMs: number,
  minimumCards = 1,
): Promise<InteractionMetric> {
  const started = nowMs();
  await action();
  const request = await waitForRequest(captures, (capture) => pathnameOf(capture.request.url()) === "/api/roles", started, timeoutMs);
  if (!request) return { status: "unsupported", reason: "No /api/roles request observed" };
  try { await waitForRolesReady(page, timeoutMs, minimumCards); } catch {
    return { status: "unsupported", reason: "Roles response did not render usable cards before timeout" };
  }
  const timing = request ? requestTiming(request) : { ttfbMs: null, completionMs: null };
  return {
    status: "measured",
    durationMs: nowMs() - started,
    resultCount: await page.locator("#role-list .role-card").count(),
    requestUrl: request.request.url(),
    requestTtfbMs: timing.ttfbMs,
    requestCompletionMs: timing.completionMs,
    responseBodyBytes: request.bodyBytes,
    responseTransferBytes: request.transferBytes,
  };
}

async function measurePage(context: BrowserContext, baseUrl: string, repeat: number, timeoutMs: number, warm = false): Promise<Sample> {
  const page = await context.newPage();
  // A missing debounce/request or a broken optional control must not consume
  // the full navigation timeout for every representative interaction. Keep
  // the initial page timeout caller-configurable, but bound interaction waits
  // so a 5x5 run remains predictable and failures are reported as unsupported.
  const interactionTimeoutMs = Math.min(timeoutMs, 5_000);
  page.setDefaultTimeout(interactionTimeoutMs);
  await installLayoutShiftObserver(page);
  const captures = new Map<Request, CapturedRequest>();
  const requestStarted = nowMs();
  page.on("request", (request) => {
    captures.set(request, {
      request,
      startedAt: nowMs(),
      bodyBytes: null,
      bodyText: null,
      transferBytes: null,
      status: null,
    });
  });
  page.on("response", (response) => {
    const capture = captures.get(response.request());
    if (!capture) return;
    capture.response = response;
  });

  try {
    await page.goto(`${baseUrl}/`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForRolesReady(page, timeoutMs);
    const usableAt = nowMs();
    const initial = [...captures.values()].filter((capture) => capture.startedAt <= usableAt);
    await sleep(50);
    await settleCaptures(initial, Math.min(timeoutMs, 5_000));

    const rolesCapture = initial.find((capture) => pathnameOf(capture.request.url()) === "/api/roles");
    const changesCapture = initial.find((capture) => pathnameOf(capture.request.url()) === "/api/changes");
    const apiMarker = await page.evaluate(() => {
      const benchmarkWindow = window as Window & { __internshipmaticBenchmark?: { apiBodies: Record<string, string> } };
      return benchmarkWindow.__internshipmaticBenchmark?.apiBodies ?? {};
    });
    // The marker is keyed by pathname and therefore keeps the last body when
    // the client starts a background page request before the usability marker.
    // Initial jobs must describe the first roles response, while the full
    // request count/waterfall below still records every request that started
    // before cards became usable.
    const rolesBody = rolesCapture?.bodyText ?? apiMarker["/api/roles"] ?? null;
    let initialJobsTransferred: number | null = null;
    let totalJobsAvailable: number | null = null;
    if (rolesBody) {
      try {
        const parsed: unknown = JSON.parse(rolesBody);
        const items = isRecord(parsed) ? parsed.items : undefined;
        const pagination = isRecord(parsed) ? parsed.pagination : undefined;
        initialJobsTransferred = Array.isArray(items) ? items.length : null;
        totalJobsAvailable = isRecord(pagination) && typeof pagination.total === "number" ? pagination.total : null;
      } catch {
        initialJobsTransferred = null;
      }
    }
    const initialTransferMissingResponses = initial.filter((capture) => capture.transferBytes === null).length;
    const initialTransferComplete = initialTransferMissingResponses === 0;
    const sumKnown = (items: readonly CapturedRequest[], selector: (capture: CapturedRequest) => number | null): number | null => {
      if (items.length === 0 || items.some((capture) => selector(capture) === null)) return null;
      return items.reduce((total, capture) => total + (selector(capture) ?? 0), 0);
    };
    const initialBodyBytes = sumKnown(initial, (capture) => capture.bodyBytes);
    const initialTransferBytes = sumKnown(initial, (capture) => capture.transferBytes);
    const initialScripts = initial.filter((capture) => capture.request.resourceType() === "script");
    const initialApis = initial.filter((capture) => pathnameOf(capture.request.url()).startsWith("/api/"));
    const initialRoles = initial.filter((capture) => pathnameOf(capture.request.url()) === "/api/roles");
    const initialChanges = initial.filter((capture) => pathnameOf(capture.request.url()) === "/api/changes");
    const initialJsBodyBytes = sumKnown(initialScripts, (capture) => capture.bodyBytes);
    const initialJsTransferBytes = sumKnown(initialScripts, (capture) => capture.transferBytes);
    const initialApiBodyBytes = sumKnown(initialApis, (capture) => capture.bodyBytes);
    const initialApiTransferBytes = sumKnown(initialApis, (capture) => capture.transferBytes);
    const rolesTiming = rolesCapture ? requestTiming(rolesCapture) : { ttfbMs: null, completionMs: null };
    const changesTiming = changesCapture ? requestTiming(changesCapture) : { ttfbMs: null, completionMs: null };

    await sleep(50);
    const pageMetrics = await page.evaluate(() => {
      const benchmarkWindow = window as Window & {
        __internshipmaticBenchmark?: {
          layoutShifts: Array<{ startTime: number; value: number; hadRecentInput: boolean }>;
          lcpEntries: Array<{ startTime: number; size: number }>;
        };
      };
      const paintEntries = performance.getEntriesByType("paint");
      const fcp = paintEntries.find((entry) => entry.name === "first-contentful-paint");
      const benchmark = benchmarkWindow.__internshipmaticBenchmark;
      return {
        cards: document.querySelectorAll("#role-list .role-card").length,
        domNodes: document.querySelectorAll("*").length,
        clsEntries: benchmark?.layoutShifts ?? [],
        lcpEntries: benchmark?.lcpEntries ?? [],
        shellFcpMs: fcp?.startTime ?? null,
      };
    });
    const firstCompany = await page.locator("#role-list .role-company").first().textContent();
    const interactions: Sample["interactions"] = {
      search: { status: "unsupported", reason: "No representative company was rendered" },
      category: { status: "unsupported", reason: "No category option was available" },
      filter: { status: "unsupported", reason: "Status filter was not found" },
      tab: { status: "unsupported", reason: "Main tab was not found" },
      loadMore: { status: "unsupported", reason: "Load more was not available" },
      detail: { status: "unsupported", reason: "Role detail control was not found" },
    };
    if (firstCompany) {
      interactions.search = await measureRolesInteraction(page, captures, () => dispatchControl(page, "#search-input", firstCompany.trim(), "input"), interactionTimeoutMs);
      await measureRolesInteraction(page, captures, () => dispatchControl(page, "#search-input", "", "input"), interactionTimeoutMs);
    }
    const categoryValue = await page.evaluate(() => {
      const options = [...document.querySelectorAll("#category-filter option")] as HTMLOptionElement[];
      for (const option of options) {
        if (option.value !== "all") return option.value;
      }
      return null;
    });
    if (categoryValue) {
      interactions.category = await measureRolesInteraction(page, captures, () => dispatchControl(page, "#category-filter", categoryValue, "change"), interactionTimeoutMs);
      await measureRolesInteraction(page, captures, () => dispatchControl(page, "#category-filter", "all", "change"), interactionTimeoutMs);
    }
    interactions.filter = await measureRolesInteraction(page, captures, () => dispatchControl(page, "#status-filter", "all", "change"), interactionTimeoutMs);
    await measureRolesInteraction(page, captures, () => dispatchControl(page, "#status-filter", "open", "change"), interactionTimeoutMs);
    interactions.tab = await measureRolesInteraction(page, captures, async () => {
      await page.locator("[data-role-tab='main']").click();
    }, interactionTimeoutMs);
    await measureRolesInteraction(page, captures, async () => {
      await page.locator("[data-role-tab='summer']").click();
    }, interactionTimeoutMs);

    const loadMoreButton = page.locator("button[data-load-more]");
    if (await loadMoreButton.count() > 0) {
      const started = nowMs();
      await loadMoreButton.click();
      const moreRequest = await waitForRequest(captures, (capture) => pathnameOf(capture.request.url()) === "/api/roles" && new URL(capture.request.url()).searchParams.get("offset") === "8", started, interactionTimeoutMs);
      try {
        await page.waitForFunction(() => !document.querySelector("#role-list .loading-state") && document.querySelectorAll("#role-list .role-card").length >= 16, undefined, { timeout: interactionTimeoutMs });
      } catch {
        // Keep the interaction explicitly unsupported if the page did not append.
      }
      if (moreRequest && await page.locator("#role-list .role-card").count() >= 16) {
        const timing = requestTiming(moreRequest);
        interactions.loadMore = {
          status: "measured",
          durationMs: nowMs() - started,
          resultCount: await page.locator("#role-list .role-card").count(),
          requestUrl: moreRequest.request.url(),
          requestTtfbMs: timing.ttfbMs,
          requestCompletionMs: timing.completionMs,
          responseBodyBytes: moreRequest.bodyBytes,
          responseTransferBytes: moreRequest.transferBytes,
        };
      }
    }

    const detail = page.locator("#role-list details[data-detail-key]").first();
    if (await detail.count() > 0) {
      const started = nowMs();
      await detail.locator("summary").click();
      const detailRequest = await waitForRequest(captures, (capture) => {
        const path = pathnameOf(capture.request.url());
        return path.startsWith("/api/roles/") && path !== "/api/roles";
      }, started, interactionTimeoutMs);
      try {
        await detail.locator(".detail-grid").waitFor({ state: "visible", timeout: interactionTimeoutMs });
      } catch {
        // Keep this interaction explicitly unsupported.
      }
      if (detailRequest && await detail.locator(".detail-grid").count() > 0) {
        const timing = requestTiming(detailRequest);
        interactions.detail = {
          status: "measured",
          durationMs: nowMs() - started,
          resultCount: 1,
          requestUrl: detailRequest.request.url(),
          requestTtfbMs: timing.ttfbMs,
          requestCompletionMs: timing.completionMs,
          responseBodyBytes: detailRequest.bodyBytes,
          responseTransferBytes: detailRequest.transferBytes,
        };
      }
    }
    const cls = clsFromEntries(pageMetrics.clsEntries);
    const eventTiming = await page.evaluate(() => {
      const entries = performance.getEntriesByType("event") as Array<PerformanceEntry & { duration?: number }>;
      let maximum = 0;
      let count = 0;
      for (const entry of entries) {
        if (typeof entry.duration === "number" && Number.isFinite(entry.duration)) {
          count += 1;
          maximum = Math.max(maximum, entry.duration);
        }
      }
      if (count > 0) return { status: "measured", valueMs: maximum };
      return { status: "unsupported", reason: "No Event Timing entries were observed; INP is unsupported for this run." };
    });
    const unsupported: Array<{ metric: string; reason: string }> = [];
    if (rolesCapture === undefined) unsupported.push({ metric: "apiListTtfbMs/apiListBodyBytes", reason: "No /api/roles response started before usable cards." });
    if (rolesTiming.ttfbMs === null) unsupported.push({ metric: "apiListTtfbMs", reason: "Playwright did not expose a finite /api/roles response-start timing." });
    if (initialTransferBytes === null) unsupported.push({ metric: "initialTransferBytes", reason: "No initial response bodies were available." });
    if (cls === null) unsupported.push({ metric: "cls", reason: "No layout-shift entries were observed in this browser run." });
    if (pageMetrics.shellFcpMs === null) unsupported.push({ metric: "shellFcpMs", reason: "No first-contentful-paint entry was observed." });
    if (pageMetrics.lcpEntries.length === 0) unsupported.push({ metric: "lcpMs", reason: "No largest-contentful-paint entry was observed." });
    if (eventTiming.status === "unsupported") unsupported.push({ metric: "inp", reason: eventTiming.reason ?? "No Event Timing entries were observed." });
    for (const [name, metric] of Object.entries(interactions)) {
      if (metric.status === "unsupported") unsupported.push({ metric: `${name}InteractionMs`, reason: metric.reason ?? "Interaction could not be measured." });
    }
    const allCaptures = [...captures.values()];
    const initialWaterfall = initial.map((capture) => {
      const timing = requestTiming(capture);
      const requestStartedAtMs = Math.max(0, capture.startedAt - requestStarted);
      return {
        url: capture.request.url(),
        resourceType: capture.request.resourceType(),
        status: capture.status,
        requestStartedAtMs,
        responseStartedAtMs: timing.ttfbMs === null ? null : requestStartedAtMs + timing.ttfbMs,
        responseCompletedAtMs: timing.completionMs === null ? null : requestStartedAtMs + timing.completionMs,
        bodyBytes: capture.bodyBytes,
        transferBytes: capture.transferBytes,
        requestStartedBeforeCards: true,
      };
    });
    const browserExternalRequests = allCaptures.filter((capture) => !isLoopbackUrl(capture.request.url())).length;
    const legacyApiDataRequests = allCaptures.filter((capture) => pathnameOf(capture.request.url()) === "/api/data").length;
    const initialDetailRequests = initial.filter((capture) => pathnameOf(capture.request.url()).startsWith("/api/roles/")).length;
    const warmReloadMs = warm ? usableAt - requestStarted : null;
    return {
      repeat,
      capturedAt: new Date().toISOString(),
      timeToUsableCardsMs: usableAt - requestStarted,
      shellFcpMs: pageMetrics.shellFcpMs,
      lcpMs: pageMetrics.lcpEntries.length > 0 ? Math.max(...pageMetrics.lcpEntries.map((entry) => entry.startTime)) : null,
      apiListTtfbMs: rolesTiming.ttfbMs,
      apiListCompletionMs: rolesTiming.completionMs,
      apiListBodyBytes: rolesCapture?.bodyBytes ?? null,
      apiListTransferBytes: rolesCapture?.transferBytes ?? null,
      changesTtfbMs: changesTiming.ttfbMs,
      changesCompletionMs: changesTiming.completionMs,
      changesBodyBytes: changesCapture?.bodyBytes ?? null,
      changesTransferBytes: changesCapture?.transferBytes ?? null,
      initialJsBodyBytes,
      initialJsTransferBytes,
      initialApiBodyBytes,
      initialApiTransferBytes,
      initialBodyBytes,
      initialTransferBytes,
      requestCount: initial.length,
      initialRolesRequestCount: initialRoles.length,
      initialChangesRequestCount: initialChanges.length,
      legacyApiDataRequests,
      initialJobsTransferred,
      totalJobsAvailable,
      initialCardsRendered: pageMetrics.cards,
      domNodes: pageMetrics.domNodes,
      cls,
      searchInteractionMs: interactions.search.durationMs ?? null,
      categoryInteractionMs: interactions.category.durationMs ?? null,
      filterInteractionMs: interactions.filter.durationMs ?? null,
      tabInteractionMs: interactions.tab.durationMs ?? null,
      loadMoreMs: interactions.loadMore.durationMs ?? null,
      detailFetchMs: interactions.detail.requestCompletionMs ?? null,
      detailOpenMs: interactions.detail.durationMs ?? null,
      warmReloadMs,
      initialTransferComplete,
      initialTransferMissingResponses,
      interactions,
      requestFacts: {
        initialRolesRequests: initialRoles.length,
        initialChangesRequests: initialChanges.length,
        initialDetailRequests,
        legacyApiDataRequests,
        browserExternalRequests,
        initialWaterfall,
      },
      unsupported,
    } satisfies Sample;
  } finally {
    await page.close();
  }
}

function medianMetrics(samples: readonly Sample[]): SampleMetrics {
  const metrics: SampleMetrics = {
    timeToUsableCardsMs: null,
    shellFcpMs: null,
    lcpMs: null,
    apiListTtfbMs: null,
    apiListCompletionMs: null,
    apiListBodyBytes: null,
    apiListTransferBytes: null,
    changesTtfbMs: null,
    changesCompletionMs: null,
    changesBodyBytes: null,
    changesTransferBytes: null,
    initialJsBodyBytes: null,
    initialJsTransferBytes: null,
    initialApiBodyBytes: null,
    initialApiTransferBytes: null,
    initialBodyBytes: null,
    initialTransferBytes: null,
    requestCount: null,
    initialRolesRequestCount: null,
    initialChangesRequestCount: null,
    legacyApiDataRequests: null,
    initialJobsTransferred: null,
    totalJobsAvailable: null,
    initialCardsRendered: null,
    domNodes: null,
    cls: null,
    searchInteractionMs: null,
    categoryInteractionMs: null,
    filterInteractionMs: null,
    tabInteractionMs: null,
    loadMoreMs: null,
    detailFetchMs: null,
    detailOpenMs: null,
    warmReloadMs: null,
  };
  for (const metric of BUDGET_METRICS) {
    metrics[metric] = median(samples.map((sample) => sample[metric]));
  }
  return metrics;
}

function summarizePhase(phase: BenchmarkPhase, samples: Sample[], config: PerformanceBudgetConfig): PhaseResult {
  const summary = medianMetrics(samples);
  return {
    phase,
    repeats: samples.length,
    samples,
    median: summary,
    budget: evaluateBudgets(phase, summary as unknown as Record<string, unknown>, config),
  };
}

function formatMilliseconds(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(1)} ms`;
}

function formatBytes(value: number | null): string {
  return value === null ? "—" : `${(value / 1_000_000).toFixed(2)} MB`;
}

function formatNumber(value: number | null): string {
  return value === null ? "—" : Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function formatTimingDistribution(values: readonly number[]): string {
  const middle = median(values);
  if (middle === null || values.length === 0) return "—";
  return `${formatMilliseconds(middle)} (${formatMilliseconds(Math.min(...values))}–${formatMilliseconds(Math.max(...values))})`;
}

function countBlockedExternalFetches(output: string): number {
  return output.match(/\[BENCHMARK NETWORK BLOCKED\]/g)?.length ?? 0;
}

function printHumanSummary(output: BenchmarkOutput, jsonOutput: string): void {
  const headers = ["phase", "usable", "FCP", "LCP", "list TTFB", "list body", "API xfer", "JS xfer", "total xfer", "reqs", "jobs/cards", "DOM", "CLS", "search", "category", "filter", "tab", "load", "detail"];
  const rows = (["cold", "warm"] as const).map((phase) => {
    const metrics = output.phases[phase].median;
    return [
      phase,
      formatMilliseconds(metrics.timeToUsableCardsMs),
      formatMilliseconds(metrics.shellFcpMs),
      formatMilliseconds(metrics.lcpMs),
      formatMilliseconds(metrics.apiListTtfbMs),
      formatBytes(metrics.apiListBodyBytes),
      formatBytes(metrics.initialApiTransferBytes),
      formatBytes(metrics.initialJsTransferBytes),
      formatBytes(metrics.initialTransferBytes),
      formatNumber(metrics.requestCount),
      `${formatNumber(metrics.initialJobsTransferred)}/${formatNumber(metrics.initialCardsRendered)}`,
      formatNumber(metrics.domNodes),
      formatNumber(metrics.cls),
      formatMilliseconds(metrics.searchInteractionMs),
      formatMilliseconds(metrics.categoryInteractionMs),
      formatMilliseconds(metrics.filterInteractionMs),
      formatMilliseconds(metrics.tabInteractionMs),
      formatMilliseconds(metrics.loadMoreMs),
      formatMilliseconds(metrics.detailOpenMs),
    ];
  });
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => row[index]?.length ?? 0)));
  const renderRow = (row: string[]): string => row.map((value, index) => value.padEnd(widths[index] ?? value.length)).join(" | ");
  console.log("DASHBOARD PERFORMANCE (medians; frozen local production fixture)");
  console.log(renderRow(headers));
  console.log(widths.map((width) => "-".repeat(width)).join("-+-"));
  for (const row of rows) console.log(renderRow(row));
  console.log(`Server ready: cold ${formatTimingDistribution(output.startup.coldServerReadyMs)}; warm ${formatMilliseconds(output.startup.warmServerReadyMs)}; warm prewarm ${formatMilliseconds(output.startup.warmPrewarmMs)}`);
  for (const phase of ["cold", "warm"] as const) {
    const budget = output.phases[phase].budget;
    console.log(`Budget ${phase}: ${budget.status.toUpperCase()} (${budget.checks.length} configured checks)`);
    for (const check of budget.checks.filter((candidate) => candidate.status === "fail" || candidate.status === "unsupported")) {
      console.log(`  ${check.metric}: ${check.status}${check.reason ? ` — ${check.reason}` : ""}`);
    }
  }
  console.log(`JSON: ${jsonOutput}`);
}

async function readBudget(path: string): Promise<PerformanceBudgetConfig> {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  return parseBudgetConfig(parsed);
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (!options.skipBuild) await runCommand("npm", ["run", "build"], "Production build");
  if (!existsSync(SERVER_ENTRYPOINT)) throw new Error(`Production dashboard build not found: ${SERVER_ENTRYPOINT}`);
  const budget = await readBudget(options.budgetPath);
  const temporaryRoot = await mkdtemp(join(resolve("/tmp"), "internshipmatic-dashboard-perf-"));
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch({ headless: true });
    const coldSamples: Sample[] = [];
    const coldServerReadyMs: number[] = [];
    let blockedExternalFetchAttempts = 0;
    for (let repeat = 1; repeat <= options.coldRepeats; repeat += 1) {
      const fixture = await createFixture(temporaryRoot, options.sourceDatabase, options.sourceBoardCache, `cold-${repeat}`);
      const server = await startServer(fixture, options.timeoutMs);
      coldServerReadyMs.push(server.readyMs);
      let context: BrowserContext | null = null;
      let sample: Sample | null = null;
      try {
        context = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 720 } });
        sample = await measurePage(context, server.baseUrl, repeat, options.timeoutMs, false);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}\n${server.output()}`, { cause: error });
      } finally {
        try {
          await context?.close();
        } finally {
          await server.stop();
        }
        blockedExternalFetchAttempts += countBlockedExternalFetches(server.output());
      }
      if (sample) coldSamples.push(sample);
    }

    const warmFixture = await createFixture(temporaryRoot, options.sourceDatabase, options.sourceBoardCache, "warm");
    const warmServer = await startServer(warmFixture, options.timeoutMs);
    const warmServerReadyMs = warmServer.readyMs;
    let warmContext: BrowserContext | null = null;
    const warmSamples: Sample[] = [];
    let warmPrewarmMs: number | null = null;
    try {
      warmContext = await browser.newContext({ serviceWorkers: "block", viewport: { width: 1280, height: 720 } });
      // The unreported navigation warms the dashboard's in-process compact
      // roles/index path; recorded navigations then represent warm paths.
      const warmupSample = await measurePage(warmContext, warmServer.baseUrl, 0, options.timeoutMs, true);
      warmPrewarmMs = warmupSample.timeToUsableCardsMs;
      for (let repeat = 1; repeat <= options.warmRepeats; repeat += 1) {
        warmSamples.push(await measurePage(warmContext, warmServer.baseUrl, repeat, options.timeoutMs, true));
      }
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${warmServer.output()}`, { cause: error });
    } finally {
      try {
        await warmContext?.close();
      } finally {
        await warmServer.stop();
      }
      blockedExternalFetchAttempts += countBlockedExternalFetches(warmServer.output());
    }

    if (warmPrewarmMs === null) throw new Error("Warm prewarm navigation did not produce a usable-card timing");
    const coldServerReadyMedianMs = median(coldServerReadyMs);
    if (coldServerReadyMedianMs === null) throw new Error("Cold server readiness timings were unavailable");

    const phases = {
      cold: summarizePhase("cold", coldSamples, budget),
      warm: summarizePhase("warm", warmSamples, budget),
    } satisfies Record<BenchmarkPhase, PhaseResult>;
    const unsupported = (["cold", "warm"] as const).flatMap((phase) => (
      phases[phase].samples.flatMap((sample) => sample.unsupported.map((item) => ({ phase, ...item })))
    ));
    const overallBudgetStatus = phases.cold.budget.status === "fail" || phases.warm.budget.status === "fail"
      ? "fail"
      : phases.cold.budget.status === "incomplete" || phases.warm.budget.status === "incomplete"
        ? "incomplete"
        : "pass";
    const output: BenchmarkOutput = {
      schemaVersion: 1,
      benchmark: {
        name: "dashboard-production-frozen-fixture",
        capturedAt: new Date().toISOString(),
        node: process.version,
        browser: browser.version(),
        playwright: "1.62.1",
        sourceDatabase: options.sourceDatabase,
        sourceBoardCache: options.sourceBoardCache,
        coldRepeats: options.coldRepeats,
        warmRepeats: options.warmRepeats,
        timeoutMs: options.timeoutMs,
      },
      isolation: {
        database: "serialized temporary SQLite copy",
        boardCache: "temporary copied cache",
        startupCrawl: "blocked by fresh synthetic RUNNING row",
        externalFetch: "non-loopback fetch rejected in dashboard child process",
        externalWrites: "dashboard points only at temporary database/output paths",
        cleanup: "temporary fixture removed in finally",
      },
      startup: {
        coldServerReadyMs,
        coldServerReadyMedianMs,
        coldServerReadyMinMs: Math.min(...coldServerReadyMs),
        coldServerReadyMaxMs: Math.max(...coldServerReadyMs),
        warmServerReadyMs,
        warmPrewarmMs,
      },
      requestFacts: {
        browserExternalRequests: [...coldSamples, ...warmSamples].reduce((total, sample) => total + sample.requestFacts.browserExternalRequests, 0),
        blockedExternalFetchAttempts,
        legacyApiDataRequests: [...coldSamples, ...warmSamples].reduce((total, sample) => total + sample.requestFacts.legacyApiDataRequests, 0),
        duplicateInitialRolesRequests: [...coldSamples, ...warmSamples].reduce((total, sample) => total + Math.max(0, sample.requestFacts.initialRolesRequests - 1), 0),
        eagerInitialDetailRequests: [...coldSamples, ...warmSamples].reduce((total, sample) => total + sample.requestFacts.initialDetailRequests, 0),
      },
      phases,
      unsupported,
      overallBudgetStatus,
    };
    await mkdir(dirname(options.jsonOutput), { recursive: true });
    await writeFile(options.jsonOutput, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    printHumanSummary(output, options.jsonOutput);
    if (overallBudgetStatus === "fail") process.exitCode = 1;
    if (options.strictUnsupported && overallBudgetStatus === "incomplete") process.exitCode = 2;
  } finally {
    try {
      await browser?.close();
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  run().catch((error: unknown) => {
    console.error(`[PERF BENCHMARK] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}

export { clsFromEntries, medianMetrics, parseOptions };
