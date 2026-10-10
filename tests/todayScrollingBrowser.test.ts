import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

// Today page integration is intentionally dormant; re-enable this suite with the feature.
describe.skip("Today scrolling", () => {
  it.skipIf(process.env.RUN_BROWSER_E2E !== "1")("keeps long role lists reachable on desktop and mobile", async () => {
    const browser = await chromium.launch({ headless: true });
    try {
      const styles = ["styles.css", "redesign.css", "app/today.css"]
        .map((path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8")).join("\n");
      const rows = Array.from({ length: 50 }, (_, index) => `<article class="today-row">
        <span class="today-company-mark" aria-hidden="true">S</span>
        <div><h4>Software Engineering Intern ${index + 1}</h4><p>Sample Company · Toronto, ON</p>
          <div class="today-row-actions"><button type="button">Save role ${index + 1}</button></div>
        </div></article>`).join("");
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        await page.route("**/*", (route) => route.abort());
        await page.setContent(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}</style></head>
          <body><div class="app-shell"><aside class="sidebar">Scout</aside><header class="topbar">Roles</header>
            <main class="main-pane"><section id="today-view" class="today-view">
              <header class="today-header"><h1>Today</h1></header>
              <div class="today-content"><section id="today-queue" class="today-queue">${rows}</section></div>
              <footer class="today-footer"><button type="button">Refresh briefing</button></footer>
            </section></main></div></body></html>`);
        const today = page.locator("#today-view");
        const area = await today.boundingBox();
        expect(area).not.toBeNull();
        expect(area!.y).toBeGreaterThanOrEqual(0);
        expect(area!.y + area!.height).toBeLessThanOrEqual(viewport.height);
        await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
        await page.mouse.wheel(0, 20_000);
        await expect.poll(() => today.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
        const lastRole = await page.locator(".today-row").last().boundingBox();
        expect(lastRole!.y).toBeGreaterThanOrEqual(area!.y);
        expect(lastRole!.y + lastRole!.height).toBeLessThanOrEqual(area!.y + area!.height);
        await page.mouse.wheel(0, -20_000);
        await expect.poll(() => today.evaluate((element) => element.scrollTop)).toBe(0);
        await page.getByRole("button", { name: "Save role 50", exact: true }).focus();
        const lastAction = await page.getByRole("button", { name: "Save role 50", exact: true }).boundingBox();
        expect(lastAction!.y).toBeGreaterThanOrEqual(area!.y);
        expect(lastAction!.y + lastAction!.height).toBeLessThanOrEqual(area!.y + area!.height);
        await page.close();
      }
    } finally { await browser.close(); }
  }, 20_000);
});
