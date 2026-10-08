import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { scoreListingRelevance } from "../src/classification/listingRelevance.js";
import { extractJobrightJobRecords } from "../src/extractors/jobright.js";

const directory = resolve("output/intern-list-investigation-2026-10-04");
const coverage = JSON.parse(await readFile(join(directory, "coverage.json"), "utf8")) as {
  capturedAt: string;
  feeds: Array<{
    category: string;
    country: string;
    advertisedTotal: number;
    bulk: { payloadFile: string; returnedRows: number; uniqueIds: number };
  }>;
};

const feedResults = [];
for (const feed of coverage.feeds) {
  const payload = JSON.parse(await readFile(join(directory, feed.bulk.payloadFile), "utf8")) as unknown;
  const jobs = extractJobrightJobRecords(payload);
  const evaluations = jobs.map((job) => {
    const relevance = scoreListingRelevance({ title: job.title ?? "", snippet: job.description ?? "" });
    return {
      jobId: job.jobId,
      title: job.title,
      company: job.company,
      locations: job.locations,
      decision: relevance.decision,
      score: relevance.score,
      categories: relevance.categories,
      matchedPositive: relevance.matchedPositive,
      matchedNegative: relevance.matchedNegative,
      reason: relevance.reason,
    };
  });
  const fastRejects = evaluations.filter(({ decision }) => decision === "fast-reject").length;
  const retainedForDetailReview = evaluations.length - fastRejects;
  feedResults.push({
    category: feed.category,
    country: feed.country,
    expectedSourceRows: feed.advertisedTotal,
    retrievedRows: feed.bulk.returnedRows,
    uniqueSourceIds: feed.bulk.uniqueIds,
    extractedRawJobs: jobs.length,
    extractionDrops: feed.bulk.returnedRows - jobs.length,
    fastRejectedByCheapRelevance: fastRejects,
    retainedForDetailReview,
    evaluations,
  });
}

const artifact = {
  inputCoverageCapturedAt: coverage.capturedAt,
  method: "Existing Jobright structured extractor followed by scoreListingRelevance with its default rules.",
  interpretation: "Retained for detail review is an early relevance routing result, not final internship classification or eligibility.",
  feeds: feedResults,
};
const path = join(directory, "listing-relevance.json");
await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
console.log(JSON.stringify({
  path,
  inputCoverageCapturedAt: artifact.inputCoverageCapturedAt,
  feeds: feedResults.map(({ category, expectedSourceRows, retrievedRows, uniqueSourceIds, extractedRawJobs, extractionDrops, fastRejectedByCheapRelevance, retainedForDetailReview }) => ({
    category,
    expectedSourceRows,
    retrievedRows,
    uniqueSourceIds,
    extractedRawJobs,
    extractionDrops,
    fastRejectedByCheapRelevance,
    retainedForDetailReview,
  })),
}, null, 2));
