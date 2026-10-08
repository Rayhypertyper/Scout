import "../src/config/env.js";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveSettings } from "../src/config/settings.js";
import { INTERN_LIST_SOURCE_URL } from "../src/config/internListSource.js";
import { InternListAdapter } from "../src/crawler/adapters/internList.js";
import { HttpClient } from "../src/crawler/http.js";
import { RobotsManager } from "../src/crawler/robots.js";
import { extractJobs } from "../src/extractors/index.js";
import { Logger } from "../src/utils/logger.js";

export async function crawlInternList(): Promise<void> {
  const argument = (name: string): string | undefined => {
    const index = process.argv.indexOf(name);
    if (index < 0) return undefined;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    return value;
  };
  const requestedMax = argument("--max-detail-pages");
  const maxDetailPages = requestedMax === undefined ? 10_000 : Number(requestedMax);
  if (!Number.isSafeInteger(maxDetailPages) || maxDetailPages < 0) throw new Error("--max-detail-pages must be a nonnegative integer.");
  const outputDirectory = resolve(argument("--output-dir") ?? "output/intern-list-public");
  // Share the ordinary HTTP cache so the subsequent scheduled crawl can reuse
  // these verified public responses without repeating all detail requests.
  const cacheDirectory = argument("--cache-dir");
  const settings = resolveSettings({ ...(cacheDirectory ? { outputDirectory: cacheDirectory } : {}), perHostDelayMs: 100, retryCount: 1 });
  const logger = new Logger("info");
  const http = new HttpClient(settings, logger);
  const robots = new RobotsManager(settings.userAgent, settings.readTimeoutMs, logger, http);
  http.attachRobotsPolicy((url) => robots.check(url));
  const result = await new InternListAdapter(http, logger, { maxDetailPages }).collect(INTERN_LIST_SOURCE_URL);
  const jobs = result.snapshots.flatMap(extractJobs);
  await mkdir(outputDirectory, { recursive: true });
  const { snapshots: _snapshots, incompleteJobs, ...inventory } = result;
  void _snapshots;
  await writeFile(resolve(outputDirectory, "inventory.json"), JSON.stringify({ checkedAt: new Date().toISOString(), sourceUrl: INTERN_LIST_SOURCE_URL, ...inventory }, null, 2));
  await writeFile(resolve(outputDirectory, "jobs.json"), JSON.stringify(jobs, null, 2));
  await writeFile(resolve(outputDirectory, "incomplete-jobs.json"), JSON.stringify(incompleteJobs ?? [], null, 2));
  console.log(JSON.stringify({ outputDirectory, jobs: jobs.length, incompleteJobs: incompleteJobs?.length ?? 0, detailPages: result.inventoryParts?.find((part) => part.id === "details"), tabs: result.inventoryParts?.filter((part) => part.kind === "tab").length, coverageComplete: result.inventoryComplete, failures: result.failures.length }, null, 2));
  if (result.snapshots.length === 0) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  crawlInternList().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
}
