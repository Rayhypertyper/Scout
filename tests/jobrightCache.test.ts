import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Jobright destination cache", () => {
  it("makes a resolver result available by both Jobright URL and job id", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-"));
    directories.push(directory);
    const databasePath = join(directory, "crawl.db");
    const database = new InternshipDatabase(databasePath);
    database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/abc123",
      "https://careers.example.com/jobs/software-intern-abc123",
    );
    const destinations = database.getJobrightDestinations("https://www.intern-list.com/?k=swe");
    expect(destinations.get("https://jobright.ai/jobs/info/abc123")).toBe("https://careers.example.com/jobs/software-intern-abc123");
    expect(destinations.get("abc123")).toBe("https://careers.example.com/jobs/software-intern-abc123");
    database.close();
  });

  it("promotes a resolved destination into legacy internship and application records", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-promotion-"));
    directories.push(directory);
    const databasePath = join(directory, "crawl.db");
    const sourceUrl = "https://example.com/careers";
    const jobrightUrl = "https://jobright.ai/jobs/info/abc123";
    const destinationUrl = "https://careers.example.com/jobs/software-intern-abc123";
    const settings = resolveSettings({ databasePath, outputDirectory: join(directory, "output") });
    const options: ScoutRunOptions = {
      sources: [sourceUrl],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const internship = makeInternship({
      id: "legacy-jobright",
      jobId: "abc123",
      applicationUrl: jobrightUrl,
      postingUrl: jobrightUrl,
      qualificationDetails: { applicationUrl: jobrightUrl },
    });
    const analyzedJob = analyzed(internship);
    const crawl: CrawlResult = {
      sourcesRequested: 1,
      sourcesCompleted: 1,
      sourcesSuccessful: 1,
      sourcesPartiallyCompleted: 0,
      sourcesFailed: 0,
      pagesVisited: 1,
      potentialPostingsInspected: 1,
      jobs: [analyzedJob],
      failures: [],
      closedPages: [],
      completedSourceUrls: [sourceUrl],
      sourceResults: [{
        sourceUrl,
        pagesVisited: 1,
        potentialPostingsInspected: 1,
        jobs: [analyzedJob],
        failures: [],
        closedPages: [],
        completed: true,
        coverageComplete: true,
      }],
    };
    const database = new InternshipDatabase(databasePath);
    const runId = database.startRun(options);
    database.persistRun(runId, crawl, 2);
    database.recordListingAction(
      "internship",
      internship.id,
      "applied",
      internship.company,
      internship.title,
      { applicationUrl: jobrightUrl, postingUrl: jobrightUrl, jobId: internship.jobId },
    );
    database.recordJobrightDestination(jobrightUrl, destinationUrl);
    database.close();

    const verification = new DatabaseSync(databasePath, { readOnly: true });
    const row = verification.prepare(`
      SELECT application_url, posting_url, payload_json
      FROM internships
      WHERE id = @id
    `).get({ id: internship.id }) as { application_url: string; posting_url: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { qualificationDetails: { applicationUrl: string | null } };
    expect(row.application_url).toBe(destinationUrl);
    expect(row.posting_url).toBe(destinationUrl);
    expect(payload.qualificationDetails.applicationUrl).toBe(destinationUrl);
    const action = verification.prepare(`
      SELECT application_url, posting_url
      FROM listing_actions
      WHERE listing_id = @id
    `).get({ id: internship.id }) as { application_url: string; posting_url: string };
    expect(action.application_url).toBe(destinationUrl);
    expect(action.posting_url).toBe(destinationUrl);
    verification.close();
  });

  it("rejects another aggregator as the cached destination", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-invalid-"));
    directories.push(directory);
    const database = new InternshipDatabase(join(directory, "crawl.db"));
    expect(() => database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/abc123",
      "https://jobright.ai/jobs/info/other",
    )).toThrow("employer or ATS");
    database.close();
  });

  it("remembers recent failed attempts without treating them as destinations", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-jobright-cache-failed-"));
    directories.push(directory);
    const database = new InternshipDatabase(join(directory, "crawl.db"));
    database.recordJobrightDestination(
      "https://jobright.ai/jobs/info/failed123",
      null,
      "Original Job Post anchor was not present",
    );
    expect(database.getJobrightDestinations("https://www.intern-list.com/?k=swe").has("failed123")).toBe(false);
    expect(database.getJobrightResolutionKeys().has("failed123")).toBe(true);
    database.close();
  });
});
