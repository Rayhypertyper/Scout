import { pathToFileURL } from "node:url";

import { parseCli, helpText } from "./cli.js";
import { readConfiguredSourcesAtPath } from "./config/sourceCatalog.js";
import { resolveSettings } from "./config/settings.js";
import { ActiveCrawlRunError } from "./database/db.js";
import { runScout } from "./scout.js";

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const cli = parseCli(argv);
  if (cli.help) {
    console.log(helpText());
    return;
  }
  const settings = resolveSettings(cli.settings);
  await runScout({
    sources: cli.sources.length > 0 ? cli.sources : readConfiguredSourcesAtPath(settings.databasePath),
    settings,
    filters: cli.filters,
  });
}

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  main().catch((error: unknown) => {
    // Calendar launchd intervals and dashboard/manual refreshes can overlap.
    // The database lease is the source of truth; an already-running run is a
    // benign skipped invocation, not a failed scheduled run.
    if (error instanceof ActiveCrawlRunError) {
      console.warn(`[SKIP] ${error.message}`);
      return;
    }
    console.error(`[FATAL] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
