import { dirname, resolve } from "node:path";

import { collectUsenoInternshipMasterlist } from "../src/crawler/useno.js";
import { USENO_INTERNSHIP_MASTERLIST_URL } from "../src/extractors/useno.js";
import { resolveSettings } from "../src/config/settings.js";
import { HttpClient } from "../src/crawler/http.js";
import { RobotsManager } from "../src/crawler/robots.js";
import { Logger } from "../src/utils/logger.js";

const sourceUrl = process.argv[2] ?? USENO_INTERNSHIP_MASTERLIST_URL;
const outputPath = resolve(process.argv[3] ?? "output/useno-internship-masterlist.json");
const settings = resolveSettings({ outputDirectory: dirname(outputPath), timeoutMs: 30_000, userAgent: "InternshipScout/1.0 (+respectful job discovery crawler)" });
const logger = new Logger("warn");
const http = new HttpClient(settings, logger);
const robots = new RobotsManager(settings.userAgent, settings.timeoutMs, logger, http);
const { artifact } = await collectUsenoInternshipMasterlist({ sourceUrl, settings, http, robots, logger, outputPath });
console.log(`Retrieved ${artifact.totalRecords} eligible listings across ${artifact.selectedCategories.length} Useno tabs.`);
console.log(`Wrote ${outputPath}`);
