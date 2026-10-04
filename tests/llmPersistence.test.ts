import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { analyzeRawJob } from "../src/classification/analyzeJob.js";
import { deduplicateJobs, internshipQuality } from "../src/deduplication/deduplicate.js";
import { InternshipDatabase } from "../src/database/db.js";
import { FieldEvidenceSchema, InternshipSchema, type FieldEvidence, type Internship } from "../src/domain/schemas.js";
import type { CrawlResult, ScoutRunOptions } from "../src/domain/types.js";
import { sha256 } from "../src/utils/hash.js";
import { analyzed, makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function evidence(field: string, value: string, pageText: string, pageUrl = "https://boards.greenhouse.io/northstar/jobs/100"): FieldEvidence {
  const start = pageText.indexOf(value);
  if (start < 0) throw new Error(`Fixture text does not contain ${value}`);
  return FieldEvidenceSchema.parse({
    field,
    value,
    provider: "gemini",
    model: "gemini-2.5-flash",
    pageUrl,
    contentHash: sha256(pageText),
    quote: value,
    start,
    end: start + value.length,
  });
}

function crawl(job: Internship): CrawlResult {
  const candidate = analyzed(job);
  return {
    sourcesRequested: 1,
    sourcesCompleted: 1,
    sourcesSuccessful: 1,
    sourcesPartiallyCompleted: 0,
    sourcesFailed: 0,
    pagesVisited: 1,
    potentialPostingsInspected: 1,
    jobs: [candidate],
    failures: [],
    closedPages: [],
    completedSourceUrls: [job.sourceUrl],
    sourceResults: [{
      sourceUrl: job.sourceUrl,
      pagesVisited: 1,
      potentialPostingsInspected: 1,
      jobs: [candidate],
      failures: [],
      closedPages: [],
      completed: true,
      coverageComplete: true,
    }],
  };
}

function runOptions(databasePath: string, outputDirectory: string): ScoutRunOptions {
  return {
    sources: ["https://example.com/careers"],
    settings: resolveSettings({ databasePath, outputDirectory }),
    filters: { categories: [], newOnly: false, minScore: 60 },
  };
}

describe("LLM field evidence persistence", () => {
  it("defaults missing provenance on legacy internship payloads", () => {
    const legacyPayload: Record<string, unknown> = { ...makeInternship() };
    delete legacyPayload.provenance;

    expect(InternshipSchema.parse(legacyPayload).provenance).toEqual([]);
  });

  it.each(["gemini", "openai"] as const)("carries %s evidence through analysis and preserves it through SQLite refreshes", async (provider) => {
    const description = [
      "Software Engineer Intern. Develop and test production software services using Python and TypeScript.",
      "Currently pursuing a Computer Science degree. This is a full-time internship program in Toronto, Ontario.",
      "Compensation is $42/hour for this twelve-week internship.",
    ].join(" ");
    const salaryEvidence = FieldEvidenceSchema.parse({
      ...evidence("salary", "$42/hour", description),
      provider,
      model: provider === "openai" ? "gpt-6-luna" : "gemini-2.5-flash",
    });
    const raw = await analyzeRawJob({
      company: "Northstar Labs",
      title: "Software Engineer Intern",
      locations: ["Toronto, ON, Canada"],
      description,
      salary: "$42/hour",
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
      sourceProvider: "greenhouse",
      provenance: [salaryEvidence],
    }, "https://example.com/careers", 60, async (url) => url);

    expect(raw.accepted).toBe(true);
    if (!raw.accepted) return;
    expect(raw.value.internship.salary).toBe("$42/hour");
    expect(raw.value.internship.provenance).toEqual([salaryEvidence]);

    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-llm-evidence-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "test.db");
    const options = runOptions(databasePath, join(directory, "output"));
    const database = new InternshipDatabase(databasePath);
    try {
      const firstRun = database.startRun(options);
      expect(database.persistRun(firstRun, crawl(raw.value.internship), 2).internships[0]?.provenance).toEqual([salaryEvidence]);

      // A later deterministic refresh has no new model evidence. The stored
      // evidence should remain attached to the unchanged salary field.
      const refreshed = makeInternship({
        ...raw.value.internship,
        provenance: [],
        lastVerifiedAt: "2027-01-02T00:00:00.000Z",
      });
      const secondRun = database.startRun(options);
      const persisted = database.persistRun(secondRun, crawl(refreshed), 2).internships[0];
      expect(persisted?.salary).toBe("$42/hour");
      expect(persisted?.provenance).toEqual([salaryEvidence]);
    } finally {
      database.close();
    }
  });

  it("keeps evidence attached to the correct qualification item after analysis normalization", async () => {
    const description = "Software Engineer Intern. Build production software with Python and TypeScript. Full-time internship program in Toronto, Ontario.";
    const requirements = [
      "Currently pursuing a Computer Science degree.",
      "Must return to school after the internship.",
    ];
    const quote = requirements[1]!;
    const itemEvidence = evidence("requiredQualifications[1]", quote, `${description} ${requirements.join(" ")}`);
    const result = await analyzeRawJob({
      company: "Northstar Labs",
      title: "Software Engineer Intern",
      locations: ["Toronto, ON, Canada"],
      description,
      requiredQualifications: requirements,
      postingUrl: "https://boards.greenhouse.io/northstar/jobs/100",
      sourceProvider: "greenhouse",
      provenance: [itemEvidence],
    }, "https://example.com/careers", 60, async (url) => url);

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.value.internship.requiredQualifications).toContain(quote);
    expect(result.value.internship.provenance).toContainEqual(expect.objectContaining({
      field: "requiredQualifications[1]",
      value: quote,
      quote,
    }));
  });

  it("keeps lower-quality duplicate evidence only when it still supports the merged field value", () => {
    const pageText = "Compensation: $42/hour. Compensation: $99/hour.";
    const primary = makeInternship({
      description: `Develop and test production software services. ${"Use Python and TypeScript to deliver reliable features. ".repeat(20)}`,
      requiredQualifications: [
        "Currently pursuing a Computer Science degree.",
        "Experience with software development.",
        "Strong debugging skills.",
      ],
      preferredQualifications: ["Experience with Python.", "Experience with cloud software."],
      salary: "$42/hour",
      provenance: [],
    });
    const lowerQuality = makeInternship({
      ...primary,
      description: "Develop and test production software services using Python and TypeScript.",
      requiredQualifications: ["Currently pursuing a Computer Science degree."],
      preferredQualifications: [],
      salary: "$42/hour",
      provenance: [
        evidence("salary", "$42/hour", pageText),
        evidence("salary", "$99/hour", pageText),
      ],
    });
    expect(internshipQuality(primary)).toBeGreaterThan(internshipQuality(lowerQuality));

    const merged = deduplicateJobs([analyzed(primary), analyzed(lowerQuality)]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.internship.salary).toBe("$42/hour");
    expect(merged[0]?.internship.provenance).toEqual([evidence("salary", "$42/hour", pageText)]);
  });

  it("remaps nested indexed qualification evidence after duplicate arrays merge", () => {
    const primary = makeInternship({
      ...makeInternship(),
      description: `Develop and test production software services. ${"Use Python and TypeScript to deliver reliable features. ".repeat(20)}`,
      qualificationDetails: {
        ...makeInternship().qualificationDetails,
        graduationYears: [2029],
        degreeRequirements: ["Computer Science"],
      },
      provenance: [],
    });
    const secondaryText = "Graduating in 2028. Degree requirement: Statistics.";
    const secondary = makeInternship({
      ...primary,
      description: "Develop and test production software services using Python and TypeScript.",
      qualificationDetails: {
        ...primary.qualificationDetails,
        graduationYears: [2028],
        degreeRequirements: ["Statistics"],
      },
      provenance: [
        evidence("qualificationDetails.graduationYears[0]", "2028", secondaryText),
        evidence("qualificationDetails.degreeRequirements[0]", "Statistics", secondaryText),
      ],
    });

    const merged = deduplicateJobs([analyzed(primary), analyzed(secondary)]);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.internship.qualificationDetails.graduationYears).toEqual([2029, 2028]);
    expect(merged[0]?.internship.qualificationDetails.degreeRequirements).toEqual(["Computer Science", "Statistics"]);
    expect(merged[0]?.internship.provenance).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: "qualificationDetails.graduationYears[1]", value: "2028" }),
      expect.objectContaining({ field: "qualificationDetails.degreeRequirements[1]", value: "Statistics" }),
    ]));
  });
});
