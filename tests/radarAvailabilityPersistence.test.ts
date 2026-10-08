import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { Internship } from "../src/domain/schemas.js";
import type { ScoutRunOptions, SourceCrawlResult } from "../src/domain/types.js";
import { analyzed, makeInternship } from "./helpers.js";

const SOURCE = "https://earlycareerradar.com/summer-internships?locations=all";
const PRIOR_VERIFIED_AT = "2026-08-01T12:00:00.000Z";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function options(databasePath: string): ScoutRunOptions {
  return {
    sources: [SOURCE],
    settings: resolveSettings({ databasePath, outputDirectory: join(databasePath, "output") }),
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
}

function radarJob(jobId: string, availabilityStatus: Internship["availabilityStatus"], lastVerifiedAt: string): Internship {
  return makeInternship({
    id: `internship-${jobId}`,
    jobId,
    company: "Bosch",
    title: "AI Application Intern",
    applicationUrl: `https://jobs.smartrecruiters.com/BoschGroup/${jobId}/ai-application-intern`,
    postingUrl: `https://earlycareerradar.com/jobs/${jobId}`,
    sourceUrl: SOURCE,
    sources: [SOURCE],
    description: "Early Career Radar's Summer Internships feed lists this role. The employer's full description is not available in the feed.",
    availabilityStatus,
    lastVerifiedAt,
  });
}

function sourceResult(job: Internship): SourceCrawlResult {
  return {
    sourceUrl: SOURCE,
    pagesVisited: 1,
    potentialPostingsInspected: 1,
    jobs: [analyzed(job)],
    failures: [],
    closedPages: [],
    completed: true,
    coverageComplete: true,
    status: "success",
  };
}

function readPersistedRow(databasePath: string, postingUrl: string): {
  availability_status: string;
  last_seen_at: string;
  source_last_seen_at: string;
  last_checked_at: string;
  last_verified_at: string;
  payload_json: string;
} {
  const raw = new DatabaseSync(databasePath);
  try {
    return raw.prepare(`
      SELECT i.availability_status, i.last_seen_at, i.last_checked_at, i.last_verified_at, i.payload_json,
             source_link.last_seen_at AS source_last_seen_at
      FROM internships i
      JOIN internship_sources source_link ON source_link.internship_id = i.id
      WHERE i.posting_url = @postingUrl
    `).get({ postingUrl }) as {
      availability_status: string;
      last_seen_at: string;
      source_last_seen_at: string;
      last_checked_at: string;
      last_verified_at: string;
      payload_json: string;
    };
  } finally {
    raw.close();
  }
}

function expectUnknownState(database: InternshipDatabase, databasePath: string, job: Internship): void {
  const state = database.classifyListing(SOURCE, {
    canonicalUrl: job.postingUrl,
    postingUrl: job.postingUrl,
    externalJobId: job.jobId,
    providerIdentity: "early-career-radar",
  });
  expect(state.disposition).toBe("possibly_changed");
  expect(state.validatorsMatch).toBe(false);
  expect(state.record?.availabilityStatus).toBe("unknown");
  expect(state.record?.internship?.availabilityStatus).toBe("unknown");

  const row = readPersistedRow(databasePath, job.postingUrl);
  const payload = JSON.parse(row.payload_json) as Internship;
  expect(row.availability_status).toBe("unknown");
  expect(payload.availabilityStatus).toBe("unknown");
  expect(row.last_verified_at).toBe(PRIOR_VERIFIED_AT);
  expect(payload.lastVerifiedAt).toBe(PRIOR_VERIFIED_AT);
  expect(Date.parse(row.last_seen_at)).toBeGreaterThan(Date.parse(PRIOR_VERIFIED_AT));
  expect(Date.parse(row.source_last_seen_at)).toBeGreaterThan(Date.parse(PRIOR_VERIFIED_AT));
  expect(Date.parse(row.last_checked_at)).toBeGreaterThan(Date.parse(PRIOR_VERIFIED_AT));
}

describe("Early Career Radar availability persistence", () => {
  it("keeps an unknown ready-job sighting unknown without advancing employer verification", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-radar-availability-ready-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "test.db");
    const database = new InternshipDatabase(databasePath);

    try {
      const firstRun = database.startRun(options(databasePath));
      database.persistReadyJobs(firstRun, [analyzed(radarJob("job-radar-811", "open", PRIOR_VERIFIED_AT))]);
      database.markRunFailed(firstRun, "baseline complete");

      const runId = database.startRun(options(databasePath));
      const observed = radarJob("job-radar-811", "unknown", "2026-10-05T20:00:00.000Z");
      database.persistReadyJobs(runId, [analyzed(observed)]);

      expectUnknownState(database, databasePath, observed);
    } finally {
      database.close();
    }
  });

  it("keeps source-result observations unknown and preserves ordinary verified-open persistence", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-radar-availability-source-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "test.db");
    const database = new InternshipDatabase(databasePath);

    try {
      const runId = database.startRun(options(databasePath));
      const observed = radarJob("job-radar-812", "unknown", PRIOR_VERIFIED_AT);
      database.persistSourceResult(runId, sourceResult(observed));
      expectUnknownState(database, databasePath, observed);

      const verifiedOpen = makeInternship({
        id: "verified-open-role",
        jobId: "REQ-VERIFIED-2027",
        company: "Verified Employer",
        title: "Software Intern",
        applicationUrl: "https://boards.greenhouse.io/verified/jobs/2027/apply",
        postingUrl: "https://boards.greenhouse.io/verified/jobs/2027",
        sourceUrl: SOURCE,
        sources: [SOURCE],
        availabilityStatus: "open",
        lastVerifiedAt: PRIOR_VERIFIED_AT,
      });
      database.persistReadyJobs(runId, [analyzed(verifiedOpen)]);

      const state = database.classifyListing(SOURCE, {
        canonicalUrl: verifiedOpen.postingUrl,
        postingUrl: verifiedOpen.postingUrl,
        externalJobId: verifiedOpen.jobId,
      });
      expect(state.record?.availabilityStatus).toBe("open");
      const row = readPersistedRow(databasePath, verifiedOpen.postingUrl);
      expect(row.availability_status).toBe("open");
      expect((JSON.parse(row.payload_json) as Internship).availabilityStatus).toBe("open");
      expect(row.last_seen_at).toBe(PRIOR_VERIFIED_AT);
      expect(row.source_last_seen_at).toBe(PRIOR_VERIFIED_AT);
      expect(row.last_checked_at).toBe(PRIOR_VERIFIED_AT);
    } finally {
      database.close();
    }
  });
});
