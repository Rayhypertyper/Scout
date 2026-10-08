import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { MAC_POWER_PROBE_MAX_BUFFER_BYTES, MAC_POWER_PROBE_TIMEOUT_MS, parseMacPowerState, readMacPowerState } from "../src/config/macPowerState.js";
import { RUN_MAX_DURATION_MS, activeRunMaxDurationMs } from "../src/config/runLock.js";
import { CRAWL_INTERVAL_MS, CRAWL_RETRY_MS, createSchedulerTick, isCrawlDue, type SchedulerRuntime } from "../src/scheduler.js";

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

  it("keeps the existing cadence, retry delay, and hard run limit", () => {
    expect(CRAWL_INTERVAL_MS).toBe(90 * 60_000);
    expect(CRAWL_RETRY_MS).toBe(5 * 60_000);
    expect(activeRunMaxDurationMs()).toBe(RUN_MAX_DURATION_MS);
    expect(RUN_MAX_DURATION_MS).toBe(45 * 60_000);
  });
});

describe("macOS scheduled crawl power gate", () => {
  it("classifies documented system capabilities without using display state", () => {
    expect(parseMacPowerState("Current Power State: 4\nCurrent System Capabilities are: CPU Graphics Audio Network\n")).toBe("full-wake");
    expect(parseMacPowerState("Current System Capabilities are: CPU Audio Network")).toBe("full-wake");
    expect(parseMacPowerState("Current System Capabilities are: CPU Graphics Network")).toBe("full-wake");
    expect(parseMacPowerState("Current System Capabilities are: CPU Network")).toBe("dark-wake");
    expect(parseMacPowerState("Display State: Off\nCurrent System Capabilities are: CPU Graphics Audio Network")).toBe("full-wake");
    expect(parseMacPowerState("Current System Capabilities are: Graphics Audio Network")).toBe("unknown");
    expect(parseMacPowerState("Current System Capabilities are:")).toBe("unknown");
    expect(parseMacPowerState("Current Power State: 4")).toBe("unknown");
    expect(MAC_POWER_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(2_000);
    expect(MAC_POWER_PROBE_MAX_BUFFER_BYTES).toBe(4_096);
  });

  it("rejects a successful result delivered after the power probe deadline", async () => {
    let currentTime = 1_000;
    let completeProbe: ((error: Error | null, stdout: string) => void) | undefined;
    const result = readMacPowerState({
      now: () => currentTime,
      run: (callback) => { completeProbe = callback; },
    });
    expect(completeProbe).toBeDefined();
    currentTime += MAC_POWER_PROBE_TIMEOUT_MS + 1;
    completeProbe?.(null, "Current System Capabilities are: CPU Graphics Audio Network");
    await expect(result).resolves.toBe("unknown");
  });

  it("does not probe or defer when the catalog cadence is not due", async () => {
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawnMock = vi.fn(() => worker);
    const probePowerState = vi.fn(async () => "dark-wake" as const);
    const log = { log: vi.fn(), error: vi.fn() };
    const tick = createSchedulerTick("db.sqlite", "output", {
      platform: "darwin",
      probePowerState,
      databaseCrawlDue: () => false,
      spawnWorker: spawnMock as unknown as NonNullable<SchedulerRuntime["spawnWorker"]>,
      log,
      now: () => now,
    });

    await tick();
    expect(probePowerState).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(log.log).not.toHaveBeenCalled();
  });

  it("defers a dark-wake tick and starts on the next confirmed full-wake tick", async () => {
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawnMock = vi.fn((...args: Parameters<NonNullable<SchedulerRuntime["spawnWorker"]>>) => {
      void args;
      return worker;
    });
    const isDue = vi.fn(() => true);
    const log = { log: vi.fn(), error: vi.fn() };
    const states = ["dark-wake", "full-wake"] as const;
    let stateIndex = 0;
    const probePowerState = vi.fn(async () => states[stateIndex++] ?? "full-wake");
    const tick = createSchedulerTick("db.sqlite", "output", {
      platform: "darwin",
      probePowerState,
      databaseCrawlDue: isDue,
      spawnWorker: spawnMock as unknown as NonNullable<SchedulerRuntime["spawnWorker"]>,
      log,
      now: () => now,
    });

    await tick();
    expect(spawnMock).not.toHaveBeenCalled();
    expect(isDue).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledTimes(1);

    await tick();
    expect(probePowerState).toHaveBeenCalledTimes(2);
    expect(isDue).toHaveBeenCalledTimes(3);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(spawnMock.mock.calls[0]?.[2]).toMatchObject({ stdio: "inherit" });
    expect(log.log).toHaveBeenCalledWith("[SCHEDULER] macOS full wake confirmed; scheduled crawling resumed.");
  });

  it("fails closed on a probe error, logs once per state, then retries next tick without backoff", async () => {
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawnMock = vi.fn(() => worker);
    const isDue = vi.fn(() => true);
    const log = { log: vi.fn(), error: vi.fn() };
    const probePowerState = vi.fn()
      .mockRejectedValueOnce(new Error("pmset unavailable"))
      .mockResolvedValueOnce("unknown" as const)
      .mockResolvedValueOnce("full-wake" as const);
    const tick = createSchedulerTick("db.sqlite", "output", {
      platform: "darwin",
      probePowerState,
      databaseCrawlDue: isDue,
      spawnWorker: spawnMock as unknown as NonNullable<SchedulerRuntime["spawnWorker"]>,
      log,
      now: () => now,
    });

    await tick();
    await tick();
    expect(isDue).toHaveBeenCalledTimes(2);
    expect(spawnMock).not.toHaveBeenCalled();
    expect(log.log).toHaveBeenCalledTimes(1);
    expect(log.log).toHaveBeenCalledWith("[SCHEDULER] Deferring scheduled crawl: macOS full wake could not be confirmed.");

    await tick();
    expect(probePowerState).toHaveBeenCalledTimes(3);
    expect(isDue).toHaveBeenCalledTimes(4);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps non-macOS scheduling ungated", async () => {
    const worker = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) }) as unknown as ChildProcess;
    const spawnMock = vi.fn(() => worker);
    const probePowerState = vi.fn(async () => "dark-wake" as const);
    const tick = createSchedulerTick("db.sqlite", "output", {
      platform: "linux",
      probePowerState,
      databaseCrawlDue: () => true,
      spawnWorker: spawnMock as unknown as NonNullable<SchedulerRuntime["spawnWorker"]>,
      now: () => now,
    });

    await tick();
    expect(probePowerState).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing 45-minute worker deadline plus one-minute grace", async () => {
    const killWorker = vi.fn(() => true);
    const worker = Object.assign(new EventEmitter(), { kill: killWorker }) as unknown as ChildProcess;
    const spawnMock = vi.fn(() => worker);
    let currentTime = now;
    const tick = createSchedulerTick("db.sqlite", "output", {
      platform: "linux",
      databaseCrawlDue: () => true,
      spawnWorker: spawnMock as unknown as NonNullable<SchedulerRuntime["spawnWorker"]>,
      now: () => currentTime,
    });

    await tick();
    currentTime += RUN_MAX_DURATION_MS + 60_000 - 1;
    await tick();
    expect(killWorker).not.toHaveBeenCalled();
    currentTime += 1;
    await tick();
    expect(killWorker).toHaveBeenCalledWith("SIGKILL");
  });
});
