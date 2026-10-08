import { spawn } from "node:child_process";
import type { Logger } from "../utils/logger.js";

interface WakeLockProcess {
  once(event: "error", listener: (error: Error) => void): this;
  kill(signal?: NodeJS.Signals): boolean;
}
interface WakeLockOptions {
  platform?: NodeJS.Platform;
  pid?: number;
  spawn?: (command: string, args: string[], options: { stdio: "ignore" }) => WakeLockProcess;
}

/** Keep macOS from suspending an active crawl between maintenance wakes.
 * -i prevents idle sleep; -s also covers AC-powered system sleep. The display
 * may sleep normally. -w releases the assertion if the owning worker dies,
 * and the returned cleanup releases it immediately when this crawl settles.
 */
export function holdSystemAwakeForCrawl(logger: Logger, options: WakeLockOptions = {}): () => void {
  if ((options.platform ?? process.platform) !== "darwin") return () => undefined;
  try {
    const helper = (options.spawn ?? spawn)("/usr/bin/caffeinate", ["-i", "-s", "-w", String(options.pid ?? process.pid)], { stdio: "ignore" });
    helper.once("error", () => logger.warn("SLEEP", "Unable to hold a macOS sleep assertion for this crawl."));
    let released = false;
    return () => {
      if (released) return;
      released = true;
      helper.kill("SIGTERM");
    };
  } catch {
    logger.warn("SLEEP", "Unable to start the macOS crawl sleep assertion.");
    return () => undefined;
  }
}
