import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import { createAuthenticatedHarness } from "./authenticatedHarness.js";
import { LISTING_SNAPSHOT_KEY } from "../public/app/listing-snapshot.js";

describe("instant listings after idle", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")("paints a four-hour-old preview before a ten-second refresh, then replaces it", async () => {
    const harness = await createAuthenticatedHarness();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      if (harness.transport !== "network") throw new Error("Browser verification requires loopback access.");
      const base = JSON.parse((await harness.request("/api/roles?view=all&tab=canada&season=all&limit=1")).text) as {
        items: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
      if (!base.items[0]) throw new Error("Missing seed card.");
      const old = { ...base.items[0], id: "saved-card", listingId: "saved-card", title: "Previously loaded software internship", internshipTerm: "Summer", seasons: ["summer"] };
      const fresh = { ...old, id: "fresh-card", listingId: "fresh-card", title: "Freshly published software internship" };
      let returning = false;
      let failRefresh = false;
      let headRequests = 0;
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const errors: string[] = [];
      const externalRequests: string[] = [];
      await context.route("**/*", async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== harness.baseUrl) {
          externalRequests.push(url.href);
          await route.abort();
          return;
        }
        if (url.pathname === "/api/roles") {
          if (Number(url.searchParams.get("offset") || 0) === 0 && url.searchParams.get("tab") === "canada") headRequests += 1;
          if (returning) await new Promise((resolve) => setTimeout(resolve, 10_000));
          if (failRefresh) {
            await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Temporarily unavailable" }) });
            return;
          }
          await route.fulfill({ contentType: "application/json", body: JSON.stringify({
            ...base, filters: { view: "all" }, version: returning ? "v2" : "v1", contentVersion: returning ? "c2" : "c1",
            items: [returning ? fresh : old], pagination: { limit: 40, offset: 0, total: 1, hasMore: false, nextOffset: null },
          }) });
          return;
        }
        if (url.pathname === "/api/changes") {
          await route.fulfill({ contentType: "application/json", body: JSON.stringify({
            ...base, version: returning ? "v2" : "v1", contentVersion: returning ? "c2" : "c1",
          }) });
          return;
        }
        await route.continue();
      });
      let page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      const jobs = `${harness.baseUrl}/jobs?view=all&tab=canada`;
      await page.goto(jobs, { waitUntil: "domcontentloaded" });
      await page.getByText(String(old.title), { exact: true }).waitFor({ timeout: 4_000 }).catch(async (error: unknown) => {
        throw new Error(`${String(error)} ${JSON.stringify({ errors, headRequests, body: (await page.locator("body").innerText()).slice(0, 2000) })}`);
      });
      await page.waitForFunction((key) => Boolean(localStorage.getItem(key)), LISTING_SNAPSHOT_KEY);
      await page.evaluate((key) => {
        const snapshot = JSON.parse(localStorage.getItem(key) || "{}") as { entries: Array<{ savedAt: number }> };
        snapshot.entries.forEach((entry) => { entry.savedAt -= 4 * 60 * 60 * 1_000; });
        localStorage.setItem(key, JSON.stringify(snapshot));
      }, LISTING_SNAPSHOT_KEY);
      await page.close();

      returning = true;
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      const headsBefore = headRequests;
      const started = Date.now();
      await page.goto(jobs, { waitUntil: "domcontentloaded" });
      await page.getByText(String(old.title), { exact: true }).waitFor({ timeout: 1_000 });
      const previewMs = Date.now() - started;
      expect(previewMs).toBeLessThan(1_000);
      expect(await page.locator("#jobs-status").innerText()).toContain("Updating listings…");
      await page.getByText(String(fresh.title), { exact: true }).waitFor({ timeout: 12_000 });
      expect(await page.getByText(String(old.title), { exact: true }).count()).toBe(0);
      expect(headRequests - headsBefore).toBe(1);
      console.log(`[RETURN VISIT] Four-hour-old preview visible in ${previewMs}ms while the live request took 10 seconds.`);

      // A subsequent network failure must keep the last usable feed visible.
      await page.close();
      failRefresh = true;
      page = await context.newPage();
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(jobs, { waitUntil: "domcontentloaded" });
      await page.getByText(String(fresh.title), { exact: true }).waitFor({ timeout: 1_000 });
      await expect.poll(() => page.locator("#jobs-status").innerText(), { timeout: 12_000 }).toContain("Showing saved listings");
      expect(await page.getByText(String(fresh.title), { exact: true }).isVisible()).toBe(true);
      expect(await page.locator("#role-list .error-state").count()).toBe(0);
      expect(errors).toEqual([]);
      expect(externalRequests.filter((url) => url.includes("fonts.googleapis") || url.includes("fonts.gstatic"))).toEqual([]);
      await context.close();
    } finally {
      await browser?.close();
      await harness.close();
    }
  }, 35_000);
});
