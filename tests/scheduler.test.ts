import { describe, expect, it } from "vitest";
import { CRAWL_INTERVAL_MS, isCrawlDue } from "../src/scheduler.js";

const now = Date.parse("2026-09-13T12:00:00Z");
const sources = ["https://a.example", "https://b.example"];
function run(age: number, status = "COMPLETED", requested = sources) {
  return { started_at: new Date(now - age).toISOString(), finished_at: new Date(now - age + 60_000).toISOString(),
    heartbeat_at: new Date(now - 60_000).toISOString(), status, options_json: JSON.stringify({ sources: requested }) };
}
describe("unattended crawl freshness", () => {
  it("catches up on first launch and after sleep or shutdown", () => {
    expect(isCrawlDue([], sources, now)).toBe(true);
    expect(isCrawlDue([run(2 * 86400_000)], sources, now)).toBe(true);
  });
  it("runs at the 90-minute boundary, measured from crawl start", () => {
    expect(isCrawlDue([run(CRAWL_INTERVAL_MS - 1)], sources, now)).toBe(false);
    expect(isCrawlDue([run(CRAWL_INTERVAL_MS)], sources, now)).toBe(true);
  });
  it("does not mistake a partial scan for a catalog refresh", () => {
    expect(isCrawlDue([run(10 * 60_000, "COMPLETED", sources.slice(0, 1))], sources, now)).toBe(true);
  });
  it("respects live leases and recovers expired runs", () => {
    expect(isCrawlDue([run(10 * 60_000, "RUNNING")], sources, now)).toBe(false);
    expect(isCrawlDue([run(60 * 60_000, "RUNNING")], sources, now)).toBe(true);
    expect(isCrawlDue([{ ...run(30 * 60_000, "RUNNING"), heartbeat_at: new Date(now - 25 * 60_000).toISOString() }], sources, now)).toBe(true);
  });
  it("backs off failures without waiting another 90 minutes", () => {
    expect(isCrawlDue([run(2 * 60_000, "FAILED")], sources, now)).toBe(false);
    expect(isCrawlDue([run(7 * 60_000, "FAILED")], sources, now)).toBe(true);
  });
});
