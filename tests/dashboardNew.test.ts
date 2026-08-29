import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import {
  isWithinNewRoleBannerWindow,
  NEW_ROLE_BANNER_MS,
  readNewListingKeys,
} from "../src/dashboardNew.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function sourceResult(source: string, jobs: CrawlResult["jobs"]): CrawlResult["sourceResults"][number] {
  return {
    sourceUrl: source,
    pagesVisited: 1,
    potentialPostingsInspected: jobs.length,
    jobs,
    failures: [],
    closedPages: [],
    completed: true,
    coverageComplete: true,
  };
}

function crawl(source: string, jobs: CrawlResult["jobs"]): CrawlResult {
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: jobs.length,
    jobs,
    failures: [],
    closedPages: [],
    completedSourceUrls: [source],
    sourceResults: [sourceResult(source, jobs)],
  };
}

describe("dashboard banner window", () => {
  it("keeps new listings on the banner for 16 hours across later completed runs", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-dashboard-new-"));
    temporaryDirectories.push(directory);
    const source = "https://example.com/careers";
    const settings = resolveSettings({
      databasePath: join(directory, "crawl.db"),
      outputDirectory: join(directory, "output"),
    });
    const options: ScoutRunOptions = {
      sources: [source],
      settings,
      filters: { categories: [], newOnly: false, minScore: 60 },
    };
    const database = new InternshipDatabase(settings.databasePath);

    try {
      const now = Date.now();
      const firstJob = makeInternship({
        id: "job-1",
        jobId: "REQ-100",
        discoveredAt: new Date(now - 60_000).toISOString(),
      });
      const firstRun = database.startRun(options);
      database.persistRun(firstRun, crawl(source, [analyzed(firstJob)]), 2);

      const secondRun = database.startRun(options);
      database.recordLightweightSightings(secondRun, [{
        sourceUrl: source,
        postingUrl: firstJob.postingUrl,
        externalJobId: firstJob.jobId,
        contentHash: analyzed(firstJob).contentHash,
        state: "unchanged",
        observedOpen: true,
      }]);
      const activeJob = makeInternship({
        id: "job-2",
        jobId: "REQ-200",
        company: "Acme Systems",
        title: "Backend Software Intern",
        applicationUrl: "https://boards.greenhouse.io/acme/jobs/200/apply",
        postingUrl: "https://boards.greenhouse.io/acme/jobs/200",
        discoveredAt: new Date(now).toISOString(),
      });
      database.persistSourceResult(secondRun, sourceResult(source, [analyzed(activeJob)]));

      const reader = new DatabaseSync(settings.databasePath, { readOnly: true });
      try {
        expect(readNewListingKeys(reader, now)).toEqual(["internship:job-1", "internship:job-2"]);
      } finally {
        reader.close();
      }

      database.persistRun(secondRun, {
        ...crawl(source, []),
        jobs: [],
        sourceResults: [],
      }, 2);
      database.close();

      const connection = new DatabaseSync(settings.databasePath);
      try {
        expect(readNewListingKeys(connection, now)).toEqual(["internship:job-1", "internship:job-2"]);
        connection.prepare(`
          UPDATE internships SET first_seen_at = @firstSeenAt WHERE id = 'job-1'
        `).run({ firstSeenAt: new Date(now - NEW_ROLE_BANNER_MS - 60_000).toISOString() });
        expect(readNewListingKeys(connection, now)).toEqual(["internship:job-2"]);
      } finally {
        connection.close();
      }
    } finally {
      try { database.close(); } catch { /* already closed after persistence */ }
    }
  });

  it("treats a listing as new only while first seen is inside the 16-hour window", () => {
    const now = Date.parse("2026-08-19T18:00:00.000Z");
    expect(isWithinNewRoleBannerWindow(new Date(now - NEW_ROLE_BANNER_MS + 1).toISOString(), now)).toBe(true);
    expect(isWithinNewRoleBannerWindow(new Date(now - NEW_ROLE_BANNER_MS).toISOString(), now)).toBe(false);
    expect(isWithinNewRoleBannerWindow(new Date(now + 1_000).toISOString(), now)).toBe(false);
  });
});
