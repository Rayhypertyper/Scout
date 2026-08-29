import type { PageSnapshot, RawJob } from "../domain/types.js";
import { isKnownNonProductionJobBoard } from "../config/nonProductionSources.js";
import { extractAshbyJob } from "./ashby.js";
import { extractByteDanceJob } from "./bytedance.js";
import { extractGenericJobs } from "./generic.js";
import { extractGreenhouseJob } from "./greenhouse.js";
import { extractJobrightJobs } from "./jobright.js";
import { extractLeverJob } from "./lever.js";
import { extractOracleHcmJob } from "./oracleHcm.js";
import { extractPublicBoardJobs } from "./publicBoards.js";
import { extractWorkdayJob } from "./workday.js";

const specializedExtractors = [
  extractGreenhouseJob,
  extractLeverJob,
  extractWorkdayJob,
  extractAshbyJob,
  extractByteDanceJob,
  extractOracleHcmJob,
];

export { isKnownNonProductionJobBoard } from "../config/nonProductionSources.js";
export { discoverPublicBoardLinks } from "./publicBoards.js";

export function extractJobs(snapshot: PageSnapshot): RawJob[] {
  if (isKnownNonProductionJobBoard(snapshot.url)) return [];
  const publicBoardJobs = extractPublicBoardJobs(snapshot);
  if (publicBoardJobs.length > 0) return publicBoardJobs;
  const jobrightJobs = extractJobrightJobs(snapshot);
  if (jobrightJobs.length > 0) return jobrightJobs;
  for (const extractor of specializedExtractors) {
    const result = extractor(snapshot);
    if (result) return [result];
  }
  return extractGenericJobs(snapshot);
}
