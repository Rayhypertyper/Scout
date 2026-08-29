import { dirname, resolve } from "node:path";

import { collectUsenoSummer2027 } from "../src/crawler/useno.js";
import { USENO_SUMMER_2027_URL } from "../src/extractors/useno.js";
import { resolveSettings } from "../src/config/settings.js";
import { HttpClient } from "../src/crawler/http.js";
import { RobotsManager } from "../src/crawler/robots.js";
import { Logger } from "../src/utils/logger.js";

const sourceUrl = process.argv[2] ?? USENO_SUMMER_2027_URL;
const outputPath = resolve(process.argv[3] ?? "output/useno-summer-2027-internships.json");
const settings = resolveSettings({ outputDirectory: dirname(outputPath), timeoutMs: 30_000, userAgent: "InternshipScout/1.0 (+respectful job discovery crawler)" });
const logger = new Logger("warn");
const http = new HttpClient(settings, logger);
const robots = new RobotsManager(settings.userAgent, settings.timeoutMs, logger, http);
const { artifact } = await collectUsenoSummer2027({ sourceUrl, settings, http, robots, logger, outputPath });
console.log(`Retrieved ${artifact.totalRecords} internships across ${artifact.categories.length} categories in one page request.`);
console.log(`Wrote ${outputPath}`);
