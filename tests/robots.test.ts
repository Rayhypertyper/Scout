import { afterEach, describe, expect, it, vi } from "vitest";

import { RobotsManager } from "../src/crawler/robots.js";
import type { HttpClient, HttpResponseSnapshot } from "../src/crawler/http.js";
import { Logger } from "../src/utils/logger.js";

afterEach(() => vi.restoreAllMocks());

describe("robots policy matching", () => {
  it("selects the configured crawler group and preserves Crawl-delay", async () => {
    const response: HttpResponseSnapshot = {
      requestedUrl: "https://robots.example/robots.txt",
      url: "https://robots.example/robots.txt",
      status: 200,
      contentType: "text/plain",
      body: [
        "User-agent: *",
        "Disallow: /wildcard",
        "",
        "User-agent: CustomCrawler",
        "Disallow: /private",
        "Crawl-delay: 2",
      ].join("\n"),
      headers: {},
      attempts: 1,
      fromCache: false,
    };
    const get = vi.fn(async () => response);
    const manager = new RobotsManager("Mozilla/5.0 CustomCrawler/1.0", 30_000, new Logger("error"), { get } as unknown as HttpClient);

    await expect(manager.check("https://robots.example/private/job")).resolves.toEqual({ allowed: false, crawlDelayMs: 2_000 });
    await expect(manager.check("https://robots.example/wildcard/job")).resolves.toEqual({ allowed: true, crawlDelayMs: 2_000 });
    expect(get).toHaveBeenCalledTimes(1);
  });
});
