import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { holdSystemAwakeForCrawl } from "../src/config/wakeLock.js";
import { Logger } from "../src/utils/logger.js";

describe("crawl sleep assertion", () => {
  it("ties the macOS assertion to the worker PID and releases it once on settlement", () => {
    const helper = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const spawn = vi.fn(() => helper);
    const release = holdSystemAwakeForCrawl(new Logger("error"), { platform: "darwin", pid: 1234, spawn });
    expect(spawn).toHaveBeenCalledWith("/usr/bin/caffeinate", ["-i", "-s", "-w", "1234"], { stdio: "ignore" });
    release();
    release();
    expect(helper.kill).toHaveBeenCalledTimes(1);
    expect(helper.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not invoke a macOS helper on other platforms", () => {
    const spawn = vi.fn(() => { throw new Error("unexpected invocation"); });
    holdSystemAwakeForCrawl(new Logger("error"), { platform: "linux", spawn })();
    expect(spawn).not.toHaveBeenCalled();
  });

  it("leaves deterministic crawling available if the sleep helper cannot start", () => {
    const helper = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const release = holdSystemAwakeForCrawl(new Logger("error"), { platform: "darwin", spawn: () => helper });
    expect(() => helper.emit("error", new Error("unavailable"))).not.toThrow();
    expect(() => release()).not.toThrow();
  });
});
