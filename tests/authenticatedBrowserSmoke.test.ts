import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { createAuthenticatedHarness } from "./authenticatedHarness.js";

describe("authenticated onboarding browser smoke", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "renders onboarding on desktop and mobile with keyboard-only focus movement",
    async () => {
      const harness = await createAuthenticatedHarness();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        if (harness.transport !== "network") {
          throw new Error("Browser smoke requires an ephemeral loopback listener; the harness is using its in-process fallback.");
        }
        browser = await chromium.launch({ headless: true });
        for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
          const context = await browser.newContext({ viewport });
          try {
            await context.addCookies([{
              name: "rr-e2e-session",
              value: harness.sessions.incomplete,
              url: harness.baseUrl,
            }]);
            const page = await context.newPage();
            await page.goto(`${harness.baseUrl}/onboarding`, { waitUntil: "domcontentloaded" });
            expect(await page.locator("#preference-form").isVisible()).toBe(true);
            expect(await page.locator("#step-count").textContent()).toBe("1 of 3");
            await page.keyboard.press("Tab");
            expect(await page.locator(":focus").getAttribute("href")).toBe("#preference-form");
            await page.keyboard.press("Tab");
            expect(await page.locator(":focus").getAttribute("aria-label")).toBe("Scout home");
            await page.keyboard.press("Tab");
            expect(await page.locator(":focus").getAttribute("href")).toBe("/account");
            await page.keyboard.press("Tab");
            expect(await page.evaluate(() => document.activeElement?.id)).toBe("term-season");
          } finally {
            await context.close();
          }
        }
      } finally {
        await browser?.close();
        await harness.close();
      }
    },
  );

  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")(
    "keeps the jobs feed reachable, filterable, and actionable across mobile and desktop",
    async () => {
      const harness = await createAuthenticatedHarness();
      let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
      try {
        if (harness.transport !== "network") {
          throw new Error("Jobs browser smoke requires an ephemeral loopback listener; the harness is using its in-process fallback.");
        }
        browser = await chromium.launch({ headless: true });
        const activeBrowser = browser;
        const mobileContext = await activeBrowser.newContext({ viewport: { width: 360, height: 800 } });
        try {
          await mobileContext.addCookies([{
            name: "rr-e2e-session",
            value: harness.sessions.complete,
            url: harness.baseUrl,
          }]);
          const page = await mobileContext.newPage();
          const consoleErrors: string[] = [];
          page.on("pageerror", (error) => consoleErrors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(`${message.text()} [${message.location().url}]`);
          });
          page.on("response", (response) => {
            if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`);
          });
          await page.goto(`${harness.baseUrl}/jobs`, { waitUntil: "domcontentloaded" });
          const roleRows = page.locator("#role-list .job-card[data-listing-key]");
          await roleRows.first().waitFor({ state: "visible", timeout: 8_000 });
          await page.waitForTimeout(250);

          const mobileMetrics = await page.evaluate(() => {
            const panel = document.querySelector(".jobs-panel");
            const scroll = document.querySelector("#jobs-scroll");
            const first = document.querySelector("#role-list .job-card[data-listing-key]");
            const rect = (element: Element | null) => {
              if (!element) return null;
              const box = element.getBoundingClientRect();
              return { width: box.width, height: box.height, bottom: box.bottom };
            };
            return {
              panel: rect(panel),
              first: rect(first),
              documentHeight: document.documentElement.scrollHeight,
              documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
              jobsScrollTop: scroll instanceof HTMLElement ? scroll.scrollTop : null,
              jobsOverflowY: scroll ? getComputedStyle(scroll).overflowY : "",
            };
          });
          expect(mobileMetrics.panel?.height ?? 0).toBeGreaterThan(0);
          expect(mobileMetrics.first?.height ?? 0).toBeGreaterThan(0);
          expect(mobileMetrics.documentHeight).toBeGreaterThan(800);
          expect(mobileMetrics.documentWidth).toBeLessThanOrEqual(360);
          expect(mobileMetrics.jobsScrollTop).toBe(0);
          expect(mobileMetrics.jobsOverflowY).toBe("visible");

          await page.locator("[data-nav='settings']").click();
          await page.locator("#settings-view").waitFor({ state: "visible" });
          expect(await page.locator("#more-filters-button").count()).toBe(0);
          expect(await page.locator("#settings-filters-panel").isVisible()).toBe(true);
          expect(await page.locator("#status-filter").isVisible()).toBe(true);
          await page.locator("[data-nav='dashboard']").click();
          await roleRows.first().waitFor({ state: "visible", timeout: 8_000 });

          const waitForRolePresence = async (key: string, present: boolean): Promise<void> => {
            const deadline = Date.now() + 8_000;
            while (Date.now() < deadline) {
              const count = await page.locator(`#featured-match [data-listing-key="${key}"], #role-list .job-card[data-listing-key="${key}"]`).count();
              if ((count > 0) === present) return;
              await page.waitForTimeout(100);
            }
            throw new Error(`Timed out waiting for ${key} to be ${present ? "present" : "absent"}.`);
          };

          // The featured card is the head of the same queue as the table. Keep
          // its decision hidden across the background refresh, then verify
          // Ctrl+Z restores it without waiting for the network response.
          const featuredRole = page.locator("#featured-match [data-listing-key]").first();
          await featuredRole.waitFor({ state: "visible", timeout: 8_000 });
          const featuredKey = await featuredRole.getAttribute("data-listing-key");
          expect(featuredKey).not.toBeNull();
          await featuredRole.locator("[data-listing-action='cant_fit']").click();
          expect(await page.locator(`#featured-match [data-listing-key="${featuredKey}"], #role-list .job-card[data-listing-key="${featuredKey}"]`).count()).toBe(0);
          await page.waitForTimeout(500);
          await waitForRolePresence(featuredKey!, false);
          await page.keyboard.press("Control+Z");
          await waitForRolePresence(featuredKey!, true);

          const firstRow = roleRows.first();
          const firstKey = await firstRow.getAttribute("data-listing-key");
          expect(firstKey).not.toBeNull();
          await firstRow.scrollIntoViewIfNeeded();
          const firstRowBox = await firstRow.boundingBox();
          expect(firstRowBox).not.toBeNull();
          expect(firstRowBox?.y ?? 0).toBeGreaterThanOrEqual(0);
          expect((firstRowBox?.y ?? 0) + (firstRowBox?.height ?? 0)).toBeLessThanOrEqual(800);
          const applied = firstRow.locator(".job-card-actions [data-listing-action='applied']");
          const cantFit = firstRow.locator(".job-card-actions [data-listing-action='cant_fit']");
          expect(await applied.count()).toBe(1);
          expect(await cantFit.count()).toBe(1);
          expect((await applied.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          expect((await cantFit.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);

          await applied.click();
          expect(await page.locator(`#role-list .job-card[data-listing-key="${firstKey}"]`).count()).toBe(0);
          await waitForRolePresence(firstKey!, false);
          await page.keyboard.press("Control+Z");
          await waitForRolePresence(firstKey!, true);

          const dismissRow = roleRows.nth(1);
          const dismissKey = await dismissRow.getAttribute("data-listing-key");
          expect(dismissKey).not.toBeNull();
          await dismissRow.scrollIntoViewIfNeeded();
          const dismissButton = dismissRow.locator(".job-card-actions [data-listing-action='cant_fit']");
          expect((await dismissButton.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          await dismissButton.click();
          expect(await page.locator(`#role-list .job-card[data-listing-key="${dismissKey}"]`).count()).toBe(0);
          await waitForRolePresence(dismissKey!, false);
          await page.waitForTimeout(500);
          await waitForRolePresence(dismissKey!, false);
          await page.keyboard.press("Control+Z");
          await waitForRolePresence(dismissKey!, true);

          const clearAll = page.locator(".clear-filters-button");
          await clearAll.scrollIntoViewIfNeeded();
          expect((await clearAll.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
          expect((await clearAll.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(44);
          await clearAll.click();
          await page.waitForTimeout(250);

          const lastRow = roleRows.last();
          await lastRow.scrollIntoViewIfNeeded();
          const lastRowBox = await lastRow.boundingBox();
          expect(lastRowBox).not.toBeNull();
          expect(lastRowBox?.y ?? 0).toBeGreaterThanOrEqual(0);
          expect((lastRowBox?.y ?? 0) + (lastRowBox?.height ?? 0)).toBeLessThanOrEqual(800);
          expect(await page.locator("#jobs-scroll").evaluate((element) => (element as HTMLElement).scrollTop)).toBe(0);
          expect(consoleErrors).toEqual([]);
        } finally {
          await mobileContext.close();
        }

        const desktopContext = await activeBrowser.newContext({ viewport: { width: 1280, height: 900 } });
        try {
          await desktopContext.addCookies([{
            name: "rr-e2e-session",
            value: harness.sessions.complete,
            url: harness.baseUrl,
          }]);
          const page = await desktopContext.newPage();
          const consoleErrors: string[] = [];
          page.on("pageerror", (error) => consoleErrors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") consoleErrors.push(`${message.text()} [${message.location().url}]`);
          });
          page.on("response", (response) => {
            if (response.status() >= 400) consoleErrors.push(`${response.status()} ${response.url()}`);
          });
          await page.goto(`${harness.baseUrl}/jobs`, { waitUntil: "domcontentloaded" });
          await page.locator("#role-list .job-card[data-listing-key]").first().waitFor({ state: "visible", timeout: 8_000 });
          await page.locator("[data-nav='settings']").click();
          await page.locator("#settings-view").waitFor({ state: "visible" });
          expect(await page.locator("#more-filters-button").count()).toBe(0);
          expect(await page.locator("#settings-filters-panel").isVisible()).toBe(true);
          expect(await page.locator("#status-filter").isVisible()).toBe(true);
          await page.locator("[data-nav='dashboard']").click();
          await page.locator("#role-list .job-card[data-listing-key]").first().waitFor({ state: "visible", timeout: 8_000 });
          const desktopMetrics = await page.evaluate(() => ({
            panelHeight: document.querySelector(".jobs-panel")?.getBoundingClientRect().height ?? 0,
            feedHeight: document.querySelector("#jobs-scroll")?.getBoundingClientRect().height ?? 0,
            feedOverflowY: document.querySelector("#jobs-scroll") ? getComputedStyle(document.querySelector("#jobs-scroll")!).overflowY : "",
            documentWidth: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth),
          }));
          expect(desktopMetrics.panelHeight).toBeGreaterThan(0);
          expect(desktopMetrics.feedHeight).toBeGreaterThan(0);
          expect(desktopMetrics.feedOverflowY).toBe("auto");
          expect(desktopMetrics.documentWidth).toBeLessThanOrEqual(1280);
          expect(consoleErrors).toEqual([]);
        } finally {
          await desktopContext.close();
        }
      } finally {
        await browser?.close();
        await harness.close();
      }
    },
    30_000,
  );
});
