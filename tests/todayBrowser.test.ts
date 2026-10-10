import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";
import { InternshipDatabase } from "../src/database/db.js";
import { resolveSettings } from "../src/config/settings.js";
import { ensureTodaySchema, recordTodayVisit } from "../src/dashboard/today.js";
import { createAuthenticatedHarness } from "./authenticatedHarness.js";
import { analyzed, makeInternship } from "./helpers.js";

// Today page integration is intentionally dormant; re-enable this suite with the feature.
describe.skip("Today browser experience", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")("shows only new listings with working actions, refresh, and empty/error states on desktop and mobile", async () => {
    const harness = await createAuthenticatedHarness();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      if (harness.transport !== "network") throw new Error("Browser verification requires loopback access.");
      const now = Date.now();
      const source = "https://example.test/today-fixtures";
      const companies = ["Northstar Labs", "Cedar Software", "Orbit Systems", "Maple Technologies", "Harbour Labs", "Juniper Software"];
      const jobs = Array.from({ length: 60 }, (_, index) => makeInternship({
        id: `today-${index}`, jobId: `TODAY-${index}`, company: companies[index % companies.length]!,
        title: index === 0 ? "Fall Software Engineering Intern" : "Software Engineering Intern",
        internshipTerm: index === 0 ? "Fall" : "Summer", sourceUrl: source, sources: [source],
        applicationUrl: `https://jobs.example.test/today-${index}/apply`, postingUrl: `https://jobs.example.test/today-${index}`,
        discoveredAt: new Date(now - (index + 1) * 60_000).toISOString(), lastVerifiedAt: new Date(now - 60_000).toISOString(),
      }));
      const db = new InternshipDatabase(harness.databasePath);
      const settings = resolveSettings({ databasePath: harness.databasePath, outputDirectory: "/tmp/scout-today-fixture-output" });
      const run = db.startRun({ sources: [source], settings, filters: { categories: [], newOnly: false, minScore: 60 } });
      const analyzedJobs = jobs.map(analyzed);
      db.persistRun(run, { sourcesRequested: 1, sourcesCompleted: 1, sourcesSuccessful: 1, sourcesPartiallyCompleted: 0, sourcesFailed: 0,
        pagesVisited: 1, potentialPostingsInspected: jobs.length, jobs: analyzedJobs, failures: [], closedPages: [], completedSourceUrls: [source],
        sourceResults: [{ sourceUrl: source, pagesVisited: 1, potentialPostingsInspected: jobs.length, jobs: analyzedJobs, failures: [], closedPages: [], completed: true, coverageComplete: true }],
      }, 2);
      db.close();
      const raw = new DatabaseSync(harness.databasePath);
      try {
        ensureTodaySchema(raw);
        for (let index = 0; index < jobs.length; index += 1) {
          raw.prepare("UPDATE internships SET first_seen_at = ? WHERE id = ?")
            .run(new Date(now - (index + 1) * 60_000).toISOString(), `today-${index}`);
        }
      } finally { raw.close(); }
      const dashboard = await import("../src/dashboard.js");
      dashboard.clearDashboardDataCacheForTests();
      browser = await chromium.launch({ headless: true });
      const screenshots = resolve(".impeccable/review");
      mkdirSync(screenshots, { recursive: true });
      for (const viewport of [{ width: 1440, height: 1000 }, { width: 390, height: 844 }]) {
        const visits = new DatabaseSync(harness.databasePath);
        recordTodayVisit(visits, "e2e-complete-user", new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), [], now - 2 * 24 * 60 * 60 * 1000 + 1000);
        // Reset the checkpoint between viewports after the previous UI visit.
        visits.prepare("UPDATE user_today_visits SET visited_at = ? WHERE user_id = ?")
          .run(new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(), "e2e-complete-user");
        visits.close();
        const context = await browser.newContext({ viewport, timezoneId: "America/Toronto", reducedMotion: "reduce" });
        await context.addCookies([{ name: "rr-e2e-session", value: harness.sessions.complete, url: harness.baseUrl }]);
        const externalRequests: string[] = [];
        const modelRequests: string[] = [];
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== harness.baseUrl) { externalRequests.push(url.origin); await route.abort(); }
          else {
            if (/\/api\/.*(?:draft|generate)/.test(url.pathname)) modelRequests.push(url.pathname);
            await route.continue();
          }
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto(`${harness.baseUrl}/today`, { waitUntil: "domcontentloaded" });
        await page.getByText("60 listings", { exact: true }).waitFor({ timeout: 8000 });
        expect(await page.locator(".today-row").count()).toBe(60);
        expect(await page.locator(".today-row h3").first().innerText()).toBe("Fall Software Engineering Intern");
        expect(await page.locator(".today-row a").first().getAttribute("href")).toBe("https://jobs.example.test/today-0");
        expect(await page.locator(".today-signals, .today-briefing, [data-today-application]").count()).toBe(0);
        expect(await page.locator("#role-list").isVisible()).toBe(false);
        expect(await page.locator("[data-nav='today']").getAttribute("aria-current")).toBe("page");
        const width = await page.evaluate(() => Math.max(document.body.scrollWidth, document.documentElement.scrollWidth));
        expect(width).toBeLessThanOrEqual(viewport.width);
        await page.screenshot({ path: resolve(screenshots, viewport.width > 1000 ? "today-listings-desktop.png" : "today-listings-mobile.png"), animations: "disabled" });
        const save = page.locator("[data-today-save]").first();
        await save.click();
        expect(await save.getAttribute("aria-pressed")).toBe("true");
        expect(await page.locator(":focus").getAttribute("data-today-focus")).toBe("internship:today-0:save");
        await save.click();
        expect(await save.getAttribute("aria-pressed")).toBe("false");
        await page.route("**/api/today", async (route) => {
          const response = await route.fetch();
          const payload = await response.json() as { newListings: Array<{ title: string }> };
          payload.newListings[0]!.title = "Updated Software Engineering Intern";
          await route.fulfill({ response, json: payload });
        });
        await save.focus();
        const refresh = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/today");
        await page.evaluate(() => document.querySelector<HTMLButtonElement>("#today-refresh")?.click());
        await refresh;
        await page.waitForFunction(() => document.querySelector("#today-content")?.getAttribute("aria-busy") === "false");
        expect(await page.locator(".today-row h3").first().innerText()).toBe("Updated Software Engineering Intern");
        expect(await page.locator(":focus").getAttribute("data-today-focus")).toBe("internship:today-0:save");
        expect(await page.locator(".today-row").count()).toBe(60);
        await page.unroute("**/api/today");
        await page.route("**/api/today", (route) => route.fulfill({ status: 503, json: { error: "Test connection failure." } }));
        await page.locator("#today-refresh").click();
        await expect.poll(() => page.locator("#today-status").innerText()).toContain("Your previous listings are still shown.");
        expect(await page.locator(".today-row").count()).toBe(60);
        await page.unroute("**/api/today");
        await page.route("**/api/today", async (route) => {
          const response = await route.fetch();
          const payload = await response.json() as { counts: { newListings: number }; newListings: unknown[] };
          payload.counts.newListings = 0; payload.newListings = [];
          await route.fulfill({ response, json: payload });
        });
        await page.locator("#today-refresh").click();
        await page.getByText("You’re up to date.", { exact: true }).waitFor();
        expect(await page.locator(".today-empty a").getAttribute("href")).toContain("view=all");
        expect(errors).toEqual([]);
        expect(externalRequests).toEqual([]);
        expect(modelRequests).toEqual([]);
        await context.close();
      }
    } finally {
      await browser?.close();
      await harness.close();
    }
  }, 40_000);
});
