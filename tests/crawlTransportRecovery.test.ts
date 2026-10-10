import { describe, expect, it } from "vitest";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipCrawler } from "../src/crawler/crawler.js";
import { GRIND_JOB_BOARD_FEEDS, GRIND_JOB_BOARD_SOURCE_URL, GrindJobBoardClient, type GrindJobBoardSnapshot } from "../src/integrations/grindJobBoard.js";
import { Logger } from "../src/utils/logger.js";

describe("Convex source failure records", () => {
  it("reports each of the 30 exhausted company requests with its own retry count and transport type", async () => {
    const snapshot: GrindJobBoardSnapshot = {
      sourceUrl: GRIND_JOB_BOARD_SOURCE_URL, status: "stale", jobs: [], jobCount: 0,
      freshCount: 0, companyCount: 30, companiesSynced: 30, companiesRefreshed: 0,
      lastAttemptAt: "2026-10-10T02:31:29.292Z", lastSuccessfulSyncAt: "2026-10-09T20:00:00.000Z",
      cacheTtlMinutes: 5, attempts: 90, retrievalUrl: "https://bright-shrimp-175.convex.cloud/api/query",
      failures: GRIND_JOB_BOARD_FEEDS.map((feed, index) => ({
        ...feed, message: index % 2 ? "The operation was aborted due to timeout" : "fetch failed",
        errorType: index % 2 ? "timeout" : "network", statusCode: null, retryCount: 2,
      })),
    };
    const client = { getSnapshot: async () => snapshot } as unknown as GrindJobBoardClient;
    const crawler = new InternshipCrawler(resolveSettings({ respectRobotsTxt: false }), new Logger("error"), { grindJobBoardClient: client });
    const result = (await crawler.crawl([GRIND_JOB_BOARD_SOURCE_URL])).sourceResults[0]!;
    expect(result.failures).toHaveLength(30);
    expect(result.failures.every((failure) => failure.retryCount === 2)).toBe(true);
    expect(result.failures[0]).toMatchObject({ errorType: "network_error", message: "Garmin: fetch failed" });
    expect(result.failures[1]).toMatchObject({ errorType: "timeout", message: "Amazon: The operation was aborted due to timeout" });
    expect(result).toMatchObject({ attempts: 90, status: "partial", stale: true, completed: false, coverageComplete: false, closedPages: [] });
    expect(result.metrics?.retryableFailures).toBe(30);
  });
});
