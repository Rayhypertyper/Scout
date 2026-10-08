import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import { analyzed, makeInternship } from "./helpers.js";

it("reuses verified destinations from historical category aliases in the restored full inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "intern-list-history-"));
  const settings = resolveSettings({ databasePath: join(directory, "internships.db"), outputDirectory: directory });
  const database = new InternshipDatabase(settings.databasePath);
  const source = "https://www.intern-list.com/?k=aiml";
  const destination = "https://careers.example.com/jobs/software-intern-1";
  const jobId = "6ac4813b8ff3fb9b3bc85e25";
  try {
    expect(database.configureSource("https://www.intern-list.com/?k=swe").url).toBe("https://www.intern-list.com/");
    const runId = database.startRun({ sources: [source], settings, filters: { categories: [], newOnly: false, minScore: 0 } });
    database.persistSourceResult(runId, {
      sourceUrl: source, pagesVisited: 1, potentialPostingsInspected: 1,
      jobs: [analyzed(makeInternship({ sourceUrl: source, sources: [source], jobId, applicationUrl: destination, postingUrl: destination }))],
      failures: [], closedPages: [], completed: true, coverageComplete: true, status: "success",
    });
    expect(database.getJobrightDestinations("https://www.intern-list.com/").get(jobId)).toBe(destination);
    expect(database.getJobrightDestinations("https://other.example/jobs").has(jobId)).toBe(false);
    expect(() => database.recordJobrightDestination("https://jobright.ai/jobs/info/not-an-employer", "https://www.intern-list.com/swe-intern-list/placeholder", null)).toThrow(/employer|aggregator|destination/iu);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
