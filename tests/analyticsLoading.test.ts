import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
// Execute the shipped loading functions with a small DOM/transport harness;
// a hung role request and auth bootstrap must not gate the analytics read.
const loadingSource = [
  source.slice(source.indexOf("function crawlStatCount("), source.indexOf("function normalizeCompanyName(")),
  source.slice(source.indexOf("function renderCrawlStatistics("), source.indexOf("function renderRoleTabs(")),
  source.slice(source.indexOf("async function readJsonResponse(response)"), source.indexOf("function applyRolesPayload(")),
  source.slice(source.indexOf("function isAnalyticsView()"), source.indexOf("async function syncChanges(")),
  source.slice(source.indexOf("async function initialLoad()"), source.lastIndexOf('if (typeof document !== "undefined")')),
].join("\n");

function harness(view = "analytics") {
  const node = () => ({ hidden: false, textContent: "", dataset: { error: "false" }, setAttribute: vi.fn() });
  const nodes = new Map(["#analytics-load-status", "#analytics-load-message", "#analytics-retry", "#analytics-view", "#crawl-statistics", "#analytics-account-status"].map((selector) => [selector, { ...node(), innerHTML: "" }]));
  const state = { activeView: view, data: null as Record<string, unknown> | null, analyticsReady: false, analyticsRequest: null,
    analyticsEtag: null, analyticsAccountRequest: null, analyticsAccount: null as Record<string, unknown> | null,
    analyticsData: null, auth: { status: "loading", user: null as { id: string } | null },
    rolesContentVersion: null, statusVersion: null, scanning: false, watchlistRoles: [] };
  const fetch = vi.fn();
  const loadInitialRoles = vi.fn(() => new Promise(() => undefined));
  const renderChrome = vi.fn();
  const timers = new Map<number, () => void>();
  const context = createContext({ state, fetch, loadInitialRoles, renderChrome, AbortController,
    $: (selector: string) => nodes.get(selector), document: { visibilityState: "visible" },
    authClient: { bootstrap: () => new Promise(() => undefined) },
    window: { location: { pathname: "/jobs", search: "?view=all" } },
    formatNumber: (value: number) => value.toLocaleString("en-US"), escapeHtml: (value: unknown) => String(value),
    restoreTheme: vi.fn(), restoreUiStateFromUrl: vi.fn(), readWatchlistRoles: () => [], renderWatchlistCount: vi.fn(),
    renderNavigation: vi.fn(), renderViewChrome: vi.fn(),
    rememberRunHistory: (runs: unknown[]) => runs,
    applyRememberedSourceHealth: (payload: unknown) => payload,
    mergeDashboardStats: (previous: object, next: object) => ({ ...previous, ...next }),
    invalidateRoleListingState: vi.fn(), isScanActive: () => false,
    setTimeout: (callback: () => void) => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: (id: number) => timers.delete(id),
  });
  runInContext(loadingSource, context);
  return { state, nodes, fetch, loadInitialRoles, renderChrome, timers,
    initialLoad: () => runInContext("initialLoad()", context) as Promise<void>,
    sync: () => runInContext("syncAnalytics({force: true})", context) as Promise<boolean>,
    syncAccount: () => runInContext("syncAnalyticsAccount()", context) as Promise<boolean>,
    renderStatistics: () => runInContext("renderCrawlStatistics(state.data)", context) as void,
  };
}

const snapshot = { contract: "dashboard.analytics.v1", version: "v1", stats: { open: 2709, new: 104, updated: 694, closed: 19269, hidden: 4 },
  appliedRoleCount: 7, latestRun: { id: 805 }, runs: [{ id: 805 }], sources: [{ url: "https://example.test" }], sourceResults: [], failures24h: [] };
const readyResponse = () => new Response(JSON.stringify(snapshot), { headers: { "Content-Type": "application/json", ETag: '"analytics-v1"' } });

describe("independent analytics loading", () => {
  it.each(["analytics", "sources"])("opens %s with saved statistics and history while auth and listings remain pending", async (view) => {
    const app = harness(view);
    app.fetch.mockResolvedValue(readyResponse());
    await app.initialLoad();
    expect(app.fetch.mock.calls[0]?.[0]).toBe("/api/analytics");
    expect((app.fetch.mock.calls[0]?.[1] as { signal: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
    expect(app.loadInitialRoles).not.toHaveBeenCalled();
    expect(app.renderChrome).toHaveBeenCalledWith(expect.objectContaining(snapshot));
    expect(app.state.analyticsReady).toBe(true);
    expect(app.nodes.get("#analytics-load-status")?.hidden).toBe(true);
    expect(app.timers.size).toBe(0);
  });

  it("shows a recoverable error and retry restores the full summary", async () => {
    const app = harness();
    app.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "Session temporarily unavailable." } }), { status: 503 }));
    await app.initialLoad();
    expect(app.nodes.get("#analytics-load-message")?.textContent).toContain("Session temporarily unavailable.");
    expect(app.nodes.get("#analytics-retry")?.hidden).toBe(false);
    app.fetch.mockResolvedValueOnce(readyResponse());
    await expect(app.sync()).resolves.toBe(true);
    expect(app.state.data?.stats).toEqual(snapshot.stats);
    expect(app.nodes.get("#analytics-load-status")?.hidden).toBe(true);
  });

  it("keeps the previous statistics and history when a refresh fails", async () => {
    const app = harness();
    app.fetch.mockResolvedValueOnce(readyResponse());
    await app.initialLoad();
    app.fetch.mockRejectedValueOnce(new Error("Connection lost."));
    await expect(app.sync()).resolves.toBe(false);
    expect(app.state.data?.stats).toEqual(snapshot.stats);
    expect(app.state.data?.runs).toEqual(snapshot.runs);
    expect(app.nodes.get("#analytics-load-message")?.textContent).toContain("Showing the last analytics snapshot.");
  });

  it("times out a stuck analytics request and permits retry", async () => {
    const app = harness();
    app.fetch.mockImplementationOnce((_path: string, init: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("Aborted")));
    }));
    const pending = app.initialLoad();
    app.timers.values().next().value?.();
    await pending;
    expect(app.nodes.get("#analytics-load-message")?.textContent).toContain("request timed out");
    expect(app.state.analyticsRequest).toBeNull();
    expect(app.nodes.get("#analytics-retry")?.hidden).toBe(false);
  });

  it("loads all historical decision counts independently of crawler statistics", async () => {
    const app = harness();
    app.state.auth = { status: "authenticated", user: { id: "owner" } };
    app.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ contract: "dashboard.analytics-account.v1",
      account: { status: "authenticated", userId: "owner" }, hiddenCount: 2058, appliedRoleCount: 203 })));
    await expect(app.syncAccount()).resolves.toBe(true);
    expect(app.nodes.get("#crawl-statistics")?.innerHTML).toContain("2,058");
    expect(app.nodes.get("#crawl-statistics")?.innerHTML).toContain("203");
    expect(app.nodes.get("#analytics-account-status")?.innerHTML).toContain("Saved counts for your account");
  });

  it("explains a disconnected account without presenting zero saved decisions", () => {
    const app = harness();
    app.state.auth.status = "anonymous";
    app.renderStatistics();
    expect(app.nodes.get("#crawl-statistics")?.innerHTML).toContain('crawl-stat-hidden">\n    <span class="crawl-stat-value">—');
    expect(app.nodes.get("#analytics-account-status")?.innerHTML).toContain("Sign in to see them");
  });

  it("rejects counters from a different account", async () => {
    const app = harness();
    app.state.auth = { status: "authenticated", user: { id: "owner" } };
    app.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ contract: "dashboard.analytics-account.v1",
      account: { status: "authenticated", userId: "someone-else" }, hiddenCount: 2058, appliedRoleCount: 203 })));
    await expect(app.syncAccount()).resolves.toBe(false);
    expect(app.nodes.get("#crawl-statistics")?.innerHTML).not.toContain("2,058");
    expect(app.nodes.get("#analytics-account-status")?.innerHTML).toContain("active account session");
  });
});
