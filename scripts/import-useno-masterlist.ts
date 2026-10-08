import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolveSettings } from "../src/config/settings.js";
import { importUsenoMasterlist } from "../src/integrations/usenoMasterlistImport.js";
import type { UsenoMasterlistCrawlArtifact } from "../src/crawler/useno.js";

const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  database: { type: "string" }, "output-dir": { type: "string" },
} });
if (!positionals[0]) throw new Error("Pass the saved Useno masterlist JSON artifact path.");
const artifact = JSON.parse(await readFile(positionals[0], "utf8")) as UsenoMasterlistCrawlArtifact;
const settings = resolveSettings({ ...(values.database ? { databasePath: values.database } : {}), ...(values["output-dir"] ? { outputDirectory: values["output-dir"] } : {}) });
const result = await importUsenoMasterlist(artifact, settings);
console.log(JSON.stringify({ runId: result.runId, sourceRows: result.sourceRows, canonicalRows: result.canonicalRows,
  counts: result.persisted.counts,
  jsonPath: result.jsonPath, csvPath: result.csvPath }, null, 2));
