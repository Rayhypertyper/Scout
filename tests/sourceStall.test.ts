import { afterEach, describe, expect, it } from "vitest";

import { InternshipCrawler, setSourceStallTimeoutsForTests } from "../src/crawler/crawler.js";
import { resolveSettings } from "../src/config/settings.js";
import { currentSourceAbortSignal } from "../src/domain/cancellation.js";
import type { SourceCrawlResult } from "../src/domain/types.js";
import { sleep } from "../src/utils/async.js";
import { Logger } from "../src/utils/logger.js";

const FAST = "https://example.com/fast";
const SLOW = "https://example.com/slow";
const ISOLATED_SLOW = "https://hiringcafe.com/";

function emptyResult(sourceUrl: string, pagesVisited = 1): SourceCrawlResult {
  return {
    sourceUrl,
    pagesVisited,
    potentialPostingsInspected: 0,
    jobs: [],
    failures: [],
    closedPages: [],
    completed: true,
    coverageComplete: false,
    status: "no_internships_found",
  };
}

async function hangUntilSourceAbort(): Promise<never> {
  const signal = currentSourceAbortSignal();
  await new Promise<never>((_, reject) => {
    if (!signal) {
      reject(new Error("missing per-source abort signal"));
      return;
    }
    const fail = (): void => {
      reject(signal.reason instanceof Error ? signal.reason : new Error("source aborted"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
  throw new Error("unreachable");
}

afterEach(() => {
  setSourceStallTimeoutsForTests(null);
});

describe("source stall skip and retry", () => {
  it("aborts a stalled source, lets siblings finish, then retries the stalled source once", async () => {
    setSourceStallTimeoutsForTests(40, 40);
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    const attempts = new Map<string, number>();
    (crawler as unknown as { crawlSource: (sourceUrl: string) => Promise<SourceCrawlResult> }).crawlSource = async (sourceUrl) => {
      attempts.set(sourceUrl, (attempts.get(sourceUrl) ?? 0) + 1);
      if (sourceUrl === SLOW) await hangUntilSourceAbort();
      return emptyResult(sourceUrl);
    };

    const result = await crawler.crawl([FAST, SLOW]);
    expect(attempts.get(FAST)).toBe(1);
    expect(attempts.get(SLOW)).toBe(2);
    expect(result.sourceResults).toHaveLength(2);
    expect(result.sourceResults[0]?.completed).toBe(true);
    expect(result.sourceResults[1]?.status).toBe("source_unavailable");
  });

  it("records an unavailable source after the deferred retry still exceeds its budget", async () => {
    setSourceStallTimeoutsForTests(30, 30);
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    let attempts = 0;
    (crawler as unknown as { crawlSource: (sourceUrl: string) => Promise<SourceCrawlResult> }).crawlSource = async (sourceUrl) => {
      attempts += 1;
      if (sourceUrl === SLOW) await hangUntilSourceAbort();
      return emptyResult(sourceUrl);
    };

    const result = await crawler.crawl([SLOW]);
    expect(attempts).toBe(2);
    expect(result.sourceResults[0]?.completed).toBe(false);
    expect(result.sourceResults[0]?.status).toBe("source_unavailable");
    expect(result.sourceResults[0]?.failures[0]?.errorType).toBe("timeout");
    expect(result.sourceResults[0]?.failures[0]?.message).toContain("stalled");
    expect(result.sourceResults[0]?.coverageNotes?.[0]).toContain("crawl continued");
  });

  it("applies the watchdog to isolated source phases", async () => {
    setSourceStallTimeoutsForTests(30, 30);
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    let attempts = 0;
    (crawler as unknown as { crawlSource: (sourceUrl: string) => Promise<SourceCrawlResult> }).crawlSource = async () => {
      attempts += 1;
      return hangUntilSourceAbort();
    };

    const result = await crawler.crawl([ISOLATED_SLOW]);
    expect(attempts).toBe(2);
    expect(result.sourceResults[0]?.status).toBe("source_unavailable");
  });

  it("does not stall a source that keeps emitting progress", async () => {
    setSourceStallTimeoutsForTests(40, 40);
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    let slowAttempts = 0;
    (crawler as unknown as {
      crawlSource: (
        sourceUrl: string,
        knownUrls: string[],
        onProgress?: (progress: { pagesVisited: number; potentialPostingsInspected: number; internshipsDiscovered: number; completed: boolean }) => Promise<void> | void,
      ) => Promise<SourceCrawlResult>;
    }).crawlSource = async (sourceUrl, _known, onProgress) => {
      if (sourceUrl !== SLOW) return emptyResult(sourceUrl);
      slowAttempts += 1;
      for (let page = 1; page <= 6; page += 1) {
        await onProgress?.({
          pagesVisited: page,
          potentialPostingsInspected: 0,
          internshipsDiscovered: 0,
          completed: false,
        });
        await sleep(15);
      }
      return emptyResult(sourceUrl, 6);
    };

    const result = await crawler.crawl([SLOW]);
    expect(slowAttempts).toBe(1);
    expect(result.sourceResults).toHaveLength(1);
    expect(result.sourceResults[0]?.status).toBe("no_internships_found");
  });

  it("detaches an adapter promise that ignores the source abort", async () => {
    setSourceStallTimeoutsForTests(25, 25);
    const crawler = new InternshipCrawler(resolveSettings(), new Logger("error"));
    (crawler as unknown as { crawlSource: (sourceUrl: string) => Promise<SourceCrawlResult> }).crawlSource = async () =>
      new Promise<SourceCrawlResult>(() => undefined);

    const result = await crawler.crawl([SLOW]);
    expect(result.sourceResults[0]?.status).toBe("source_unavailable");
  });
});
