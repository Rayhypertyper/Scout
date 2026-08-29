import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { compareBenchmarks, formatBenchmarkComparison, type BenchmarkInput } from "../src/observability/benchmark.js";

async function readJson(path: string, runName?: string): Promise<BenchmarkInput> {
  const text = await readFile(path, "utf8");
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  if (!runName) return value as Record<string, unknown>;
  const runsValue: unknown = (value as { runs?: unknown }).runs;
  if (!Array.isArray(runsValue)) throw new Error(`Benchmark file ${path} does not contain named runs; omit --run selection.`);
  const runs = runsValue as unknown[];
  const selected: unknown = runs.find((run: unknown) => run && typeof run === "object" && !Array.isArray(run) && (run as { name?: unknown }).name === runName);
  if (!selected || typeof selected !== "object" || Array.isArray(selected)) throw new Error(`Benchmark run '${runName}' was not found in ${path}.`);
  return selected as Record<string, unknown>;
}

function argument(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export async function runBenchmark(argv = process.argv.slice(2)): Promise<void> {
  const beforePath = argument(argv, "--before");
  const afterPath = argument(argv, "--after");
  const beforeRun = argument(argv, "--before-run") ?? argument(argv, "--run");
  const afterRun = argument(argv, "--after-run");
  if (!beforePath || !afterPath) {
    throw new Error("Usage: npm run benchmark -- --before before.json --after after.json [--before-run name --after-run name]");
  }
  const [before, after] = await Promise.all([readJson(beforePath, beforeRun), readJson(afterPath, afterRun)]);
  process.stdout.write(`${formatBenchmarkComparison(compareBenchmarks(before, after))}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  runBenchmark().catch((error: unknown) => {
    console.error(`[BENCHMARK] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
