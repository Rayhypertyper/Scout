import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

import { createRequestPool, createScrollLoadTrigger, createVirtualWindow, createVisibilityScheduler, pageIsVisible, resolveFeedScrollTarget, waitForVisibilityOrDelay } from "../public/app/feed-performance.js";
import { createAuthenticatedHarness } from "./authenticatedHarness.js";

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function exportedNumber(name: string): number | undefined {
  const match = new RegExp(`export const ${name}\\s*=\\s*(\\d+)\\s*;`).exec(source("public/app.js"));
  const value = match?.[1];
  return value === undefined ? undefined : Number(value);
}

function requiredExportedNumber(name: string): number {
  const value = exportedNumber(name);
  if (value === undefined) throw new Error(`public/app.js must export numeric constant ${name}.`);
  return value;
}

const BACKGROUND_PAGE_SIZE = requiredExportedNumber("BACKGROUND_PAGE_SIZE");
const EXPECTED_PREFETCH_TAB_LIMIT = 2;
const EXPECTED_PREFETCH_REQUEST_LIMIT = 4;

afterEach(() => vi.restoreAllMocks());

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Scout feed runtime primitives", () => {
  it("keeps prefetch concurrency bounded and starts queued work after a slot settles", async () => {
    const pool = createRequestPool({ concurrency: 2 });
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    let active = 0;
    let peak = 0;
    const tasks = gates.map((gate, index) => pool.run(async () => {
      active += 1;
      peak = Math.max(peak, active);
      const result = await gate.promise;
      active -= 1;
      return `${index}:${result}`;
    }));

    await vi.waitFor(() => expect(pool.activeCount).toBe(2));
    expect(pool.pendingCount).toBe(1);
    expect(peak).toBe(2);
    gates[0]!.resolve("done");
    await vi.waitFor(() => expect(pool.pendingCount).toBe(0));
    expect(pool.pendingCount).toBe(0);
    gates[1]!.resolve("done");
    gates[2]!.resolve("done");
    await expect(Promise.all(tasks)).resolves.toEqual(["0:done", "1:done", "2:done"]);
    expect(peak).toBe(2);
    expect(pool.activeCount).toBe(0);
  });

  it("rejects queued prefetch on intent cancellation without starting it", async () => {
    const pool = createRequestPool({ concurrency: 1 });
    const controller = new AbortController();
    const first = deferred<void>();
    let started = 0;
    const running = pool.run(async () => {
      started += 1;
      await first.promise;
    }, { signal: controller.signal });
    const queued = pool.run(async () => {
      started += 1;
    }, { signal: controller.signal });

    await vi.waitFor(() => expect(started).toBe(1));
    controller.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(1);
    first.resolve();
    await expect(running).resolves.toBeUndefined();
  });

  it("pauses interval work while hidden and refreshes once on visibility restore", () => {
    const listeners = new Map<string, () => void>();
    const documentRef = {
      visibilityState: "visible",
      addEventListener: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    };
    const intervals: Array<() => void> = [];
    const clearIntervalImpl = vi.fn();
    const onPoll = vi.fn();
    const onTick = vi.fn();
    const onHidden = vi.fn();
    const scheduler = createVisibilityScheduler({
      documentRef,
      onPoll,
      onTick,
      onHidden,
      setIntervalImpl: vi.fn((callback: () => void) => {
        intervals.push(callback);
        return intervals.length;
      }),
      clearIntervalImpl,
    });

    scheduler.start();
    expect(intervals).toHaveLength(2);
    documentRef.visibilityState = "hidden";
    listeners.get("visibilitychange")?.();
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(clearIntervalImpl).toHaveBeenCalledTimes(2);
    // A duplicate hidden event is idempotent and does not keep waking the
    // page or clear already-cleared timer handles again.
    listeners.get("visibilitychange")?.();
    expect(onHidden).toHaveBeenCalledTimes(1);
    expect(clearIntervalImpl).toHaveBeenCalledTimes(2);
    intervals[0]?.();
    intervals[1]?.();
    expect(onPoll).not.toHaveBeenCalled();
    expect(onTick).not.toHaveBeenCalled();

    documentRef.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    expect(intervals).toHaveLength(4);
    listeners.get("visibilitychange")?.();
    expect(onPoll).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledTimes(1);
    scheduler.stop();
    expect(clearIntervalImpl).toHaveBeenCalledTimes(4);
    expect(documentRef.removeEventListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("waits on visibility instead of keeping a hidden scan timer alive", async () => {
    const listeners = new Map<string, () => void>();
    const documentRef = {
      visibilityState: "visible",
      addEventListener: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    };
    const timers: Array<() => void> = [];
    const setTimeoutImpl = vi.fn((callback: () => void) => {
      timers.push(callback);
      return timers.length;
    });
    const clearTimeoutImpl = vi.fn();

    const visibleDelay = waitForVisibilityOrDelay({ documentRef, delay: 1_500, setTimeoutImpl, clearTimeoutImpl });
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    documentRef.visibilityState = "hidden";
    listeners.get("visibilitychange")?.();
    await expect(visibleDelay).resolves.toBe("hidden");
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);

    const hiddenWait = waitForVisibilityOrDelay({ documentRef, delay: 1_500, setTimeoutImpl, clearTimeoutImpl });
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    documentRef.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    await expect(hiddenWait).resolves.toBe("visible");
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it("chooses the document on mobile overflow-visible layouts and the panel on desktop", () => {
    const windowRef = { getComputedStyle: vi.fn((element: { style?: { overflowY?: string } }) => ({ overflowY: element.style?.overflowY || "" })) };
    const documentRef = { visibilityState: "visible", documentElement: { clientHeight: 800 } };
    const mobileRoot = { style: { overflowY: "visible" }, scrollHeight: 1_500, clientHeight: 800 };
    const desktopRoot = { style: { overflowY: "auto" }, scrollHeight: 1_500, clientHeight: 800 };
    const windowTarget = { addEventListener: vi.fn() };
    expect(resolveFeedScrollTarget(mobileRoot, windowTarget)).toBe(windowTarget);
    expect(resolveFeedScrollTarget(desktopRoot, windowTarget)).toBe(desktopRoot);
    expect(windowRef.getComputedStyle).not.toHaveBeenCalled();
    expect(pageIsVisible(documentRef)).toBe(true);
  });

  it("coalesces fallback scrolls and removes the old root listener when rebound", async () => {
    const listeners = new Map<string, Set<() => void>>();
    const add = vi.fn((name: string, listener: () => void) => {
      const set = listeners.get(name) || new Set<() => void>();
      set.add(listener);
      listeners.set(name, set);
    });
    const remove = vi.fn((name: string, listener: () => void) => listeners.get(name)?.delete(listener));
    const root = {
      style: { overflowY: "auto" },
      scrollHeight: 1_200,
      clientHeight: 600,
      getBoundingClientRect: () => ({ bottom: 600 }),
      addEventListener: add,
      removeEventListener: remove,
    };
    const windowRef = {
      innerHeight: 800,
      addEventListener: add,
      removeEventListener: remove,
    };
    const sentinel = { getBoundingClientRect: () => ({ top: 650 }) };
    const frames: Array<() => void> = [];
    const nearEnd = vi.fn();
    const trigger = createScrollLoadTrigger({
      root,
      windowRef,
      sentinel,
      frameRequest: vi.fn((callback: () => void) => {
        frames.push(callback);
        return frames.length;
      }),
      frameCancel: vi.fn(),
      onNearEnd: nearEnd,
    });

    trigger.start();
    expect(trigger.scrollTarget).toBe(root);
    expect(frames).toHaveLength(1);
    [...(listeners.get("scroll") || [])][0]?.();
    [...(listeners.get("scroll") || [])][0]?.();
    expect(frames).toHaveLength(1);
    frames.shift()?.();
    expect(nearEnd).toHaveBeenCalledTimes(1);
    trigger.stop();
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
    expect(remove).toHaveBeenCalledWith("resize", expect.any(Function));
    await Promise.resolve();
  });

  it("keeps a bounded variable-height window and reports an off-window focus pin", () => {
    const virtual = createVirtualWindow({ itemCount: 1_000, estimatedItemHeight: 100, overscan: 2, maxRendered: 20 });
    virtual.measure(0, 220);
    virtual.measure(10, 280);
    const window = virtual.range({ scrollTop: 1_000, viewportHeight: 500 });
    expect(window.start).toBeGreaterThan(0);
    expect(window.end - window.start).toBeLessThanOrEqual(20);
    expect(window.total).toBe(100_300);

    const focused = virtual.range({ scrollTop: 80_000, viewportHeight: 500, focusedIndex: 10 });
    expect(focused.indices).not.toContain(10);
    expect(focused.pinnedIndex).toBe(10);
    expect(focused.end - focused.start).toBeLessThanOrEqual(20);
    expect(focused.total - focused.after).toBe(virtual.offsetFor(focused.end));
    expect(virtual.itemCount).toBe(1_000);
  });

  it("keeps height lookup efficient after measuring a prolonged 5,000-row session", () => {
    const virtual = createVirtualWindow({ itemCount: 5_000, estimatedItemHeight: 136, overscan: 8, maxRendered: 96 });
    for (let index = 0; index < virtual.itemCount; index += 1) virtual.measure(index, 112 + (index % 5) * 17);
    const window = virtual.range({ scrollTop: virtual.offsetFor(4_900), viewportHeight: 600 });
    expect(window.end - window.start).toBeLessThanOrEqual(96);
    expect(window.start).toBeGreaterThan(4_800);
    expect(window.total).toBeGreaterThan(500_000);
  });

  it("caps each speculative prefetch cycle before it reaches every inactive tab", () => {
    expect(exportedNumber("PREFETCH_TAB_LIMIT")).toBe(EXPECTED_PREFETCH_TAB_LIMIT);
    expect(exportedNumber("PREFETCH_REQUEST_LIMIT")).toBe(EXPECTED_PREFETCH_REQUEST_LIMIT);
    expect(EXPECTED_PREFETCH_TAB_LIMIT).toBeLessThan(6);
  });

  it("defers dashboard motion vendor requests until a usable feed paints", () => {
    const app = source("public/app.js");
    const index = source("public/index.html");
    expect(index).not.toContain('/vendor/gsap.min.js');
    expect(index).not.toContain('/vendor/ScrollTrigger.min.js');
    expect(app).toContain('import("./landing-motion.js")');
    expect(app).toContain('state.settings.motion === "reduced"');
    expect(app).toContain("requestAnimationFrame");
  });

  it("uses an event wait for scan completion instead of hidden polling sleeps", () => {
    const app = source("public/app.js");
    expect(app).toContain("waitForVisibilityOrDelay");
    expect(app).not.toContain("await wait(SCAN_POLL_INTERVAL_MS)");
  });
});

describe("Scout feed browser runtime", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "keeps 5,000 retained roles available behind a bounded desktop/mobile window",
    async () => {
      const harness = await createAuthenticatedHarness();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        if (harness.transport !== "network") {
          throw new Error("Feed browser runtime requires an ephemeral loopback listener.");
        }
        harness.useSession("complete");
        const seed = JSON.parse((await harness.request("/api/roles?view=all&tab=canada&sort=posted&limit=1")).text) as {
          items: Array<Record<string, unknown>>;
        };
        const seedRole = seed.items[0];
        if (!seedRole) throw new Error("The authenticated harness returned no seed role.");
        const roles = Array.from({ length: 5_000 }, (_, index) => ({
          ...seedRole,
          id: `runtime-${index}`,
          listingId: `runtime-${index}`,
          jobId: `RUNTIME-${index}`,
          title: `Software Engineering Intern ${index}`,
          // Keep this browser fixture loopback-only. A one-character company
          // and empty provenance produce the fallback logo without external
          // favicon/Hunter requests for thousands of cards.
          company: "X",
          applicationUrl: "",
          postingUrl: "",
          sourceUrl: "",
          sources: [],
          internshipTerm: "Summer",
          internshipYear: "2027",
          seasons: ["summer"],
          location: ["Toronto, ON, Canada"],
        }));
        const basePayload = JSON.parse((await harness.request("/api/roles?view=all&tab=canada&sort=posted&limit=1")).text) as Record<string, unknown>;
        let fixtureCount = 5_000;
        let appendFixture = false;
        const roleRequests: Array<{ tab: string; offset: number; limit: number }> = [];

        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          await context.addCookies([{
            name: "rr-e2e-session",
            value: harness.sessions.complete,
            url: harness.baseUrl,
          }]);
          await context.route("https://logos.hunter.io/**", (route) => route.abort());
          await context.route("https://www.google.com/s2/favicons**", (route) => route.abort());
          const page = await context.newPage();
          await page.route("**/api/roles*", async (route) => {
            const url = new URL(route.request().url());
            if (url.pathname !== "/api/roles") {
              if (url.pathname.startsWith("/api/roles/")) {
                await route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: JSON.stringify({ contract: "dashboard.role.v1", role: roles[0] }),
                });
                return;
              }
              await route.continue();
              return;
            }
            const tab = url.searchParams.get("tab") || "canada";
            const offset = Number(url.searchParams.get("offset") || 0);
            const limit = Number(url.searchParams.get("limit") || 0);
            roleRequests.push({ tab, offset, limit });
            const active = tab === "canada";
            const pageItems = active
              ? appendFixture && offset === 0
                ? roles.slice(0, 120)
                : appendFixture
                  ? roles.slice(offset, offset + Math.min(BACKGROUND_PAGE_SIZE, roles.length - offset))
                  : roles.slice(0, fixtureCount)
              : roles.slice(offset, offset + 20);
            const total = active && appendFixture ? 5_000 : active ? fixtureCount : 5_000;
            const nextOffset = offset + pageItems.length < total ? offset + pageItems.length : null;
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: JSON.stringify({
                ...basePayload,
                version: "runtime-fixture-v1",
                view: "all",
                pagination: {
                  limit: pageItems.length,
                  offset,
                  total,
                  hasMore: nextOffset !== null,
                  nextOffset,
                },
                items: pageItems,
              }),
            });
          });

          const waitForCards = async (): Promise<void> => {
            try {
              await page.locator("#role-list .job-card[data-listing-key]").first().waitFor({ state: "visible", timeout: 8_000 });
            } catch (error) {
              throw new Error(`${error instanceof Error ? error.message : String(error)}\nrole-list: ${await page.locator("#role-list").innerText().catch(() => "<missing>")}`, { cause: error });
            }
            await page.waitForFunction(() => document.querySelectorAll("#role-list .job-card[data-listing-key]").length > 0);
            await page.waitForTimeout(180);
          };
          const loadFixture = async (count: number, append = false): Promise<void> => {
            fixtureCount = count;
            appendFixture = append;
            roleRequests.length = 0;
            await page.goto(`${harness.baseUrl}/jobs?view=all&tab=canada&sort=posted`, { waitUntil: "domcontentloaded" });
            await waitForCards();
          };

          await loadFixture(40);
          const cardMarkup = await page.locator("#role-list .job-card[data-listing-key]").first().evaluate((element) => element.outerHTML);
          const fortyMetrics = await page.evaluate(() => ({
            cards: document.querySelectorAll("#role-list .job-card[data-listing-key]").length,
            nodes: document.querySelectorAll("*").length,
          }));
          const full120Nodes = await page.evaluate((markup) => {
            const clone = document.body.cloneNode(true) as HTMLElement;
            const list = clone.querySelector("#role-list");
            if (list) list.innerHTML = Array.from({ length: 120 }, () => markup).join("");
            return clone.querySelectorAll("*").length;
          }, cardMarkup);
          expect(fortyMetrics.cards).toBe(40);

          await loadFixture(120);
          const oneTwentyMetrics = await page.evaluate(() => ({
            cards: document.querySelectorAll("#role-list .job-card[data-listing-key]").length,
            nodes: document.querySelectorAll("*").length,
            setSize: document.querySelector("#role-list .job-card[data-listing-key]")?.getAttribute("aria-setsize"),
          }));
          expect(oneTwentyMetrics.cards).toBeLessThanOrEqual(96);
          expect(oneTwentyMetrics.setSize).toBe("120");

          await loadFixture(5_000);
          const initialMetrics = await page.evaluate(() => ({
            cards: document.querySelectorAll("#role-list .job-card[data-listing-key]").length,
            nodes: document.querySelectorAll("*").length,
            setSize: document.querySelector("#role-list .job-card[data-listing-key]")?.getAttribute("aria-setsize"),
            countText: document.querySelector("#jobs-status")?.textContent || "",
          }));
          expect(initialMetrics.cards).toBeLessThanOrEqual(96);
          expect(initialMetrics.setSize).toBe("5000");
          expect(initialMetrics.countText).toContain("5,000");
          const inactiveRequests = roleRequests.filter(({ tab }) => tab !== "canada");
          expect(new Set(inactiveRequests.map(({ tab }) => tab)).size).toBeLessThanOrEqual(EXPECTED_PREFETCH_TAB_LIMIT);
          expect(inactiveRequests.length).toBeLessThanOrEqual(EXPECTED_PREFETCH_REQUEST_LIMIT);

          const firstCard = page.locator("#role-list .job-card[data-listing-key]").first();
          const firstKey = await firstCard.getAttribute("data-listing-key");
          await firstCard.locator("[data-open-role-detail]").click();
          await page.locator("#role-detail-panel").waitFor({ state: "visible", timeout: 8_000 });
          await page.waitForTimeout(100);
          expect(await page.locator("#role-list .job-card[data-listing-key]").count()).toBeLessThanOrEqual(96);
          await page.locator("#load-more-sentinel").scrollIntoViewIfNeeded();
          await page.waitForTimeout(120);
          expect(await page.locator("#role-list .job-card[data-listing-key]").count()).toBeLessThanOrEqual(96);
          await page.locator("#close-role-detail").click();
          await page.waitForTimeout(150);
          const afterDetailClose = await page.evaluate(() => {
            const rectSnapshot = (element: Element | null) => {
              if (!element) return null;
              const { top, right, bottom, left, width, height } = element.getBoundingClientRect();
              return { top, right, bottom, left, width, height };
            };
            return {
              keys: [...document.querySelectorAll("#role-list .job-card[data-listing-key]")].slice(0, 3).map((row) => row.getAttribute("data-listing-key")),
              positions: [...document.querySelectorAll("#role-list .job-card[data-listing-key]")].slice(0, 3).map((row) => row.getAttribute("aria-posinset")),
              rootScrollTop: document.querySelector<HTMLElement>("#jobs-scroll")?.scrollTop ?? null,
              rootRect: rectSnapshot(document.querySelector("#jobs-scroll")),
              listRect: rectSnapshot(document.querySelector("#role-list")),
              topSpacer: document.querySelector("[data-feed-virtual-spacer='top']")?.getAttribute("style") || "",
              active: document.activeElement?.outerHTML?.slice(0, 180) || document.activeElement?.nodeName || "",
            };
          });
          expect(await page.locator(`#role-list .job-card[data-listing-key="${firstKey}"]`).count(), JSON.stringify(afterDetailClose)).toBe(1);

          const boundary = page.locator("#role-list .job-card[data-listing-key]").last();
          const boundaryPosition = Number(await boundary.getAttribute("aria-posinset"));
          await boundary.locator("[data-open-role-detail]").focus();
          await page.keyboard.press("j");
          await page.waitForTimeout(120);
          const keyboardState = await page.evaluate(() => ({
            position: Number(document.activeElement?.closest("[aria-posinset]")?.getAttribute("aria-posinset")),
            active: document.activeElement?.outerHTML?.slice(0, 220) || document.activeElement?.nodeName || "",
            cards: [...document.querySelectorAll("#role-list .job-card[data-listing-key]")].slice(0, 4).map((row) => ({
              key: row.getAttribute("data-listing-key"),
              position: row.getAttribute("aria-posinset"),
            })),
          }));
          expect(keyboardState.position, JSON.stringify({ boundaryPosition, ...keyboardState })).toBe(boundaryPosition + 1);
          expect(await page.locator("#role-list .job-card[data-listing-key]").count()).toBeLessThanOrEqual(96);

          const lastRendered = page.locator("#role-list .job-card[data-listing-key]").last();
          const firstControl = lastRendered.locator("button, a").first();
          await firstControl.focus();
          const lastRenderedKey = await lastRendered.getAttribute("data-listing-key");
          await page.keyboard.press("Tab");
          expect(await page.evaluate(() => document.activeElement?.closest(".job-card")?.getAttribute("data-listing-key"))).toBe(lastRenderedKey);
          const lastControl = page.locator("#role-list .job-card[data-listing-key]").last().locator("button, a").last();
          await lastControl.focus();
          await page.keyboard.press("Tab");
          await page.waitForTimeout(120);
          const tabPosition = await page.evaluate(() => Number(document.activeElement?.closest("[aria-posinset]")?.getAttribute("aria-posinset")));
          expect(tabPosition).toBeGreaterThan(boundaryPosition);

          await loadFixture(120, true);
          await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>("#jobs-scroll");
            if (root && getComputedStyle(root).overflowY !== "visible") {
              root.scrollTop = root.scrollHeight;
              root.dispatchEvent(new Event("scroll", { bubbles: true }));
            } else window.scrollTo(0, document.documentElement.scrollHeight);
          });
          try {
            await page.waitForFunction(() => document.querySelector("#jobs-status")?.textContent?.includes("160") || false, null, { timeout: 8_000 });
          } catch (error) {
            const appendDebug = {
              requests: roleRequests.map(({ tab, offset, limit }) => ({ tab, offset, limit })),
              page: await page.evaluate(() => {
                const root = document.querySelector<HTMLElement>("#jobs-scroll");
                const rect = document.querySelector("#load-more-sentinel")?.getBoundingClientRect();
                return {
                  status: document.querySelector("#jobs-status")?.textContent || "",
                  root: root ? { scrollTop: root.scrollTop, scrollHeight: root.scrollHeight, clientHeight: root.clientHeight } : null,
                  sentinel: rect ? { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left, width: rect.width, height: rect.height } : null,
                };
              }),
            };
            throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify(appendDebug)}`, { cause: error });
          }
          expect(roleRequests.some(({ tab, offset }) => tab === "canada" && offset === 120)).toBe(true);
          expect(await page.locator("#role-list .job-card[data-listing-key]").count()).toBeLessThanOrEqual(96);
          await page.locator("#role-list .job-card[aria-posinset='1']").scrollIntoViewIfNeeded().catch(async () => {
            await page.evaluate(() => window.scrollTo(0, 0));
          });
          await page.waitForTimeout(120);
          const afterAppendTop = await page.evaluate(() => {
            const root = document.querySelector<HTMLElement>("#jobs-scroll");
            const cards = [...document.querySelectorAll("#role-list .job-card[data-listing-key]")];
            return {
              firstPosition: cards[0]?.getAttribute("aria-posinset"),
              positions: cards.slice(0, 3).map((card) => card.getAttribute("aria-posinset")),
              rootScrollTop: root?.scrollTop ?? null,
              rootScrollHeight: root?.scrollHeight ?? null,
              overflowY: root ? getComputedStyle(root).overflowY : "",
              active: document.activeElement?.outerHTML?.slice(0, 160) || document.activeElement?.nodeName || "",
              documentScrollTop: window.scrollY,
              bodyText: document.querySelector("#jobs-status")?.textContent || "",
            };
          });
          expect(afterAppendTop.firstPosition, JSON.stringify(afterAppendTop)).toBe("1");

          const metrics = await page.evaluate(() => {
            const root = document.querySelector("#jobs-scroll");
            return {
              viewport: { width: window.innerWidth, height: window.innerHeight },
              overflowY: root ? getComputedStyle(root).overflowY : "",
              documentHeight: document.documentElement.scrollHeight,
              cards: document.querySelectorAll("#role-list .job-card[data-listing-key]").length,
              nodes: document.querySelectorAll("*").length,
            };
          });
          expect(metrics.cards).toBeLessThanOrEqual(96);
          expect(metrics.nodes).toBeLessThan(full120Nodes);
          expect(fortyMetrics.nodes).toBeGreaterThan(0);
          expect(initialMetrics.nodes).toBeGreaterThan(0);

        } finally {
          await context.close().catch(() => {});
        }
      } finally {
        await browser?.close();
        await harness.close();
      }
    },
    60_000,
  );

  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "uses the document scroll root on mobile while retaining the desktop panel root",
    async () => {
      const harness = await createAuthenticatedHarness();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        if (harness.transport !== "network") throw new Error("Feed browser runtime requires an ephemeral loopback listener.");
        browser = await chromium.launch({ headless: true });
        for (const viewport of [{ width: 1280, height: 900 }, { width: 360, height: 800 }]) {
          const context = await browser.newContext({ viewport });
          try {
            await context.addCookies([{
              name: "rr-e2e-session",
              value: harness.sessions.complete,
              url: harness.baseUrl,
            }]);
            const page = await context.newPage();
            await page.goto(`${harness.baseUrl}/jobs`, { waitUntil: "domcontentloaded" });
            await page.locator("#role-list .job-card[data-listing-key]").first().waitFor({ state: "visible", timeout: 8_000 });
            const metrics = await page.evaluate(() => {
              const root = document.querySelector("#jobs-scroll");
              return {
                width: window.innerWidth,
                overflowY: root ? getComputedStyle(root).overflowY : "",
                rootHeight: root?.getBoundingClientRect().height || 0,
              };
            });
            expect(metrics.rootHeight).toBeGreaterThan(0);
            if (viewport.width < 700) expect(metrics.overflowY).toBe("visible");
            else expect(metrics.overflowY).toBe("auto");
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser?.close();
        await harness.close();
      }
    },
    45_000,
  );
});
