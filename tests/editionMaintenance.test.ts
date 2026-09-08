import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PERSONAL_EDITION_CONFIG, PUBLIC_EDITION_CONFIG } from "../src/config/edition.js";
import { resolveSettings } from "../src/config/settings.js";
import { InternshipDatabase } from "../src/database/db.js";
import type { CrawlResult } from "../src/domain/types.js";
import { filterFinalReportInternships } from "../src/finalReport.js";
import { reprocessStoredInternships } from "../src/reprocessStoredInternships.js";
import { analyzed, makeInternship } from "./helpers.js";

function marketingRole() {
  return makeInternship({
    id: "marketing-role", company: "Campaign Labs", title: "Marketing Intern",
    description: "This paid summer internship supports marketing campaigns, customer interviews, brand research, and weekly campaign reports.",
    responsibilities: ["Plan marketing campaigns."], requiredQualifications: ["Currently enrolled in a university degree."],
    preferredQualifications: [], educationRequirements: [], technologies: [], categories: ["other-internship"], relevanceScore: 0,
  });
}

describe("edition-safe maintenance", () => {
  it("reprocesses low-scoring canonical roles without deleting them or their provenance", () => {
    const directory = mkdtempSync(join(tmpdir(), "scout-edition-maintenance-"));
    const databasePath = join(directory, "internships.db");
    const role = marketingRole();
    const jobs = [analyzed(role)];
    const crawl: CrawlResult = {
      sourcesRequested: 1, sourcesCompleted: 1, sourcesSuccessful: 1, sourcesPartiallyCompleted: 0,
      sourcesFailed: 0, pagesVisited: 1, potentialPostingsInspected: 1,
      jobs, failures: [], closedPages: [], completedSourceUrls: [role.sourceUrl],
      sourceResults: [{
        sourceUrl: role.sourceUrl, pagesVisited: 1, potentialPostingsInspected: 1,
        jobs, failures: [], closedPages: [], completed: true, coverageComplete: true,
      }],
    };
    try {
      let database = new InternshipDatabase(databasePath);
      let runId: number;
      try {
        runId = database.startRun({
          sources: [role.sourceUrl],
          settings: resolveSettings({ edition: "public", databasePath, outputDirectory: join(directory, "output") }),
          filters: { categories: [], newOnly: false, minScore: 0 },
        });
        database.persistRun(runId, crawl, 2);
      } finally {
        database.close();
      }

      expect(reprocessStoredInternships(databasePath)).toBe(1);
      database = new InternshipDatabase(databasePath);
      try {
        const persisted = database.getRunInternships(runId);
        expect(persisted).toHaveLength(1);
        expect(persisted[0]).toMatchObject({ id: role.id, categories: ["other-internship"], sources: [role.sourceUrl] });
        expect(persisted[0]!.relevanceScore).toBeLessThan(60);
        expect(database.getKnownUrlsBySource([role.sourceUrl]).get(role.sourceUrl)).toContain(role.applicationUrl);
      } finally {
        database.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("applies the title policy to reports without relaxing dead-link checks", () => {
    const technical = makeInternship({ id: "technical-role" });
    const marketing = marketingRole();
    const closed = makeInternship({ id: "closed-role", availabilityStatus: "closed" });
    const unverified = makeInternship({ id: "unverified-role", applicationUrl: "https://www.linkedin.com/jobs/view/123456789" });
    const roles = [technical, marketing, closed, unverified];

    expect(filterFinalReportInternships(roles, null, PERSONAL_EDITION_CONFIG)).toEqual([technical]);
    expect(filterFinalReportInternships(roles, null, PUBLIC_EDITION_CONFIG)).toEqual([technical]);
    expect(filterFinalReportInternships(roles, null)).toEqual([technical]);
  });
});
