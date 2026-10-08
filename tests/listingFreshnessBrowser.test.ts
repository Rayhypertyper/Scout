import { describe, expect, it } from "vitest";
import { chromium } from "playwright";

import { createAuthenticatedHarness } from "./authenticatedHarness.js";

describe("live listing publication in the browser", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")("refreshes the head during a crawl and retries a stale catalog response", async () => {
    const harness = await createAuthenticatedHarness();
    let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
    try {
      if (harness.transport !== "network") throw new Error("Browser verification requires a loopback listener.");
      harness.useSession("complete");
      const base = JSON.parse((await harness.request("/api/roles?view=all&tab=canada&season=all&limit=1")).text) as {
        items: Array<Record<string, unknown>>;
        [key: string]: unknown;
      };
      if (!base.items[0]) throw new Error("The browser fixture returned no seed role.");
      const role = { ...base.items[0], company: "X", sourceUrl: "", sources: [], applicationUrl: "", postingUrl: "", internshipTerm: "Summer", seasons: ["summer"] };
      const old = { ...role, id: "old-role", listingId: "old-role", title: "Already visible software internship" };
      const ready = { ...role, id: "ready-role", listingId: "ready-role", title: "Just published software internship" };
      let content = 1;
      let status = 1;
      let staleOnce = false;
      let polls = 0;
      let freshPolls = 0;
      let headRequests = 0;
      const scan = { active: true, status: "RUNNING", runId: 123, startedAt: new Date().toISOString(), currentSources: [] };
      browser = await chromium.launch({ headless: true });
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: "rr-e2e-session", value: harness.sessions.complete, url: harness.baseUrl }]);
      await context.route("https://logos.hunter.io/**", (route) => route.abort());
      await context.route("https://www.google.com/**", (route) => route.abort());
      const page = await context.newPage();
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.route("**/api/changes", async (route) => {
        polls += 1;
        const etag = `"status-${status}"`;
        if (route.request().headers()["if-none-match"] === etag) {
          await route.fulfill({ status: 304, headers: { ETag: etag } });
          return;
        }
        if (content === 2) freshPolls += 1;
        await route.fulfill({ contentType: "application/json", headers: { ETag: etag }, body: JSON.stringify({
          ...base, version: `status-${status}`, contentVersion: `cards-${content}`, scan, status: scan,
        }) });
      });
      await page.route("**/api/roles?**", async (route) => {
        const query = new URL(route.request().url()).searchParams;
        const offset = Number(query.get("offset") || 0);
        const tab = query.get("tab");
        if (tab === "canada" && offset === 0) headRequests += 1;
        const stale = content === 2 && staleOnce && tab === "canada";
        if (stale) staleOnce = false;
        const items = content === 1 || stale ? [old] : [ready, old];
        await route.fulfill({ contentType: "application/json", body: JSON.stringify({
          ...base, version: stale ? "status-1" : `status-${status}`, contentVersion: `cards-${stale ? 1 : content}`,
          scan, status: scan, items: offset === 0 ? items : [],
          pagination: { total: items.length, offset, limit: 40, hasMore: false, nextOffset: null },
        }) });
      });
      await page.goto(`${harness.baseUrl}/jobs?view=all&tab=canada`, { waitUntil: "domcontentloaded" });
      await page.getByText("Already visible software internship", { exact: true }).waitFor({ timeout: 8_000 }).catch(async (error: unknown) => {
        throw new Error(`${error instanceof Error ? error.message : String(error)} ${JSON.stringify({ errors, url: page.url(), body: (await page.locator("body").innerText()).slice(0, 1800) })}`);
      });
      const headsBefore = headRequests;
      status = 2;
      const pollsBefore = polls;
      await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThan(pollsBefore);
      expect(headRequests).toBe(headsBefore);
      content = 2;
      status = 3;
      staleOnce = true;
      await page.getByText("Just published software internship", { exact: true }).waitFor({ timeout: 15_000 });
      expect(freshPolls).toBeGreaterThanOrEqual(2);
      expect(headRequests).toBeGreaterThan(headsBefore);
      await context.close();
    } finally {
      await browser?.close();
      await harness.close();
    }
  }, 35_000);
});
