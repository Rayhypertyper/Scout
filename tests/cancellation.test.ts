import { describe, expect, it } from "vitest";

import { CrawlCancelledError, CrawlDeadlineExceededError, SourceStalledError, throwIfAborted } from "../src/domain/cancellation.js";

describe("throwIfAborted", () => {
  it("rethrows a source stall instead of wrapping it as user cancellation", () => {
    const controller = new AbortController();
    const stall = new SourceStalledError("https://example.com/jobs", 3_000);
    controller.abort(stall);
    expect(() => throwIfAborted(controller.signal)).toThrow(stall);
    try {
      throwIfAborted(controller.signal);
    } catch (error) {
      expect(error).toBe(stall);
      expect(error).not.toBeInstanceOf(CrawlCancelledError);
    }
  });

  it("wraps a generic abort as crawl cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(CrawlCancelledError);
  });

  it("preserves the hard crawl deadline reason", () => {
    const controller = new AbortController();
    const deadline = new CrawlDeadlineExceededError(45 * 60_000);
    controller.abort(deadline);
    expect(() => throwIfAborted(controller.signal)).toThrow(deadline);
  });

  it("does nothing when the signal is missing or live", () => {
    expect(() => throwIfAborted(undefined)).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
  });
});
