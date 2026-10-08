import { execFile } from "node:child_process";

export type MacPowerState = "full-wake" | "dark-wake" | "unknown";

export const MAC_POWER_PROBE_TIMEOUT_MS = 1_500;
export const MAC_POWER_PROBE_MAX_BUFFER_BYTES = 4_096;

interface PowerProbeOptions {
  now?: () => number;
  run?: (callback: (error: Error | null, stdout: string) => void) => void;
}

/**
 * Classify the system capabilities reported by `pmset -g systemstate`.
 * Apple PowerManagement treats CPU without Graphics or Audio as dark wake;
 * a running system needs CPU plus Graphics or Audio to count as full wake.
 */
export function parseMacPowerState(output: string): MacPowerState {
  const capabilitiesLine = output.split(/\r?\n/).find((line) =>
    /^Current System Capabilities are:/i.test(line.trim()));
  if (!capabilitiesLine) return "unknown";

  const capabilities = capabilitiesLine.trim().replace(/^Current System Capabilities are:\s*/i, "").trim();
  if (!capabilities) return "unknown";
  const names = new Set(capabilities.split(/\s+/).map((name) => name.toLowerCase()));
  if (!names.has("cpu")) return "unknown";
  return names.has("graphics") || names.has("audio") ? "full-wake" : "dark-wake";
}

/** Read the small current-state report only; never scan the potentially large pmset history. */
export function readMacPowerState(options: PowerProbeOptions = {}): Promise<MacPowerState> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const run = options.run ?? ((callback: (error: Error | null, stdout: string) => void) => {
    execFile("/usr/bin/pmset", ["-g", "systemstate"], {
      encoding: "utf8",
      timeout: MAC_POWER_PROBE_TIMEOUT_MS,
      maxBuffer: MAC_POWER_PROBE_MAX_BUFFER_BYTES,
    }, (error, stdout) => callback(error, stdout));
  });
  return new Promise((resolve) => {
    run((error, stdout) => {
      const elapsedMs = now() - startedAt;
      resolve(error || elapsedMs < 0 || elapsedMs > MAC_POWER_PROBE_TIMEOUT_MS
        ? "unknown"
        : parseMacPowerState(stdout));
    });
  });
}
