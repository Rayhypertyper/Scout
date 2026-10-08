import type { ScoutSettings } from "../domain/schemas.js";
import type { CrawlResult, SourceCrawlResult } from "../domain/types.js";
import { InternshipDatabase } from "../database/db.js";
import { usenoMasterlistJob } from "../crawler/crawler.js";
import type { UsenoMasterlistCrawlArtifact } from "../crawler/useno.js";
import { validateUsenoInternshipMasterlist } from "../extractors/useno.js";
import { deduplicateJobs } from "../deduplication/deduplicate.js";
import { writeJsonOutput } from "../output/json.js";
import { writeCsvOutput } from "../output/csv.js";

/** Import a reviewed crawl artifact through the same run lease and persistence path as live crawling. */
export async function importUsenoMasterlist(artifact: UsenoMasterlistCrawlArtifact, settings: ScoutSettings) {
  validateUsenoInternshipMasterlist(artifact);
  if (artifact.retrieval.httpStatus !== 200 || !artifact.inventory || artifact.inventory.rawRoleCount < artifact.totalRecords) {
    throw new Error("Useno import requires a successful crawl artifact with explicit inventory coverage.");
  }
  if (!Number.isFinite(Date.parse(artifact.retrievedAt)) || Date.now() - Date.parse(artifact.retrievedAt) > 24 * 60 * 60 * 1000) {
    throw new Error("Useno import artifact must have been collected within the last 24 hours.");
  }
  const database = new InternshipDatabase(settings.databasePath);
  let runId: number | null = null;
  try {
    runId = database.startRun({ sources: [artifact.sourceUrl], settings, filters: { categories: [], newOnly: false, minScore: 60 } });
    const now = new Date().toISOString();
    const jobs = deduplicateJobs(artifact.listings.map((listing) => usenoMasterlistJob(listing, artifact.sourceUrl, now)));
    const source: SourceCrawlResult = {
      sourceUrl: artifact.sourceUrl,
      pagesVisited: artifact.inventory.retrievalUrls.length,
      potentialPostingsInspected: artifact.totalRecords,
      jobs,
      failures: [],
      closedPages: ["https://www.useno.app/internship-masterlist", "https://www.useno.app/resources/internship-masterlist"].map((url) => ({
        url, reason: "Invalid historical application URL: the source masterlist is not an individual job posting.", statusCode: null,
      })),
      completed: true,
      // A capped feed can add/update roles but never close unseen history.
      coverageComplete: artifact.inventory.coverageComplete && !artifact.inventory.previewCapped,
      status: "success", httpStatus: 200, attempts: artifact.retrieval.attempts,
      directApplicationLinks: artifact.inventory.directApplicationLinks,
      retrievalMethod: "Useno paginated public feed artifact and employer ATS recovery",
      retrievalMode: "configured_url", retrievalUrls: artifact.inventory.retrievalUrls,
      coverageNotes: [
        `Imported ${artifact.totalRecords} eligible rows from ${artifact.inventory.rawRoleCount} public roles in ${artifact.inventory.feedPages} feed pages.`,
        `${artifact.inventory.directApplicationLinks} direct employer links recovered; ${artifact.inventory.unresolvedApplicationLinks} rows retain individual Useno listing links.`,
        "The public feed is account-limited; unseen historical rows were retained and employer availability remains unverified.",
      ],
    };
    database.recordSourceStart(runId, artifact.sourceUrl, now);
    database.persistSourceResult(runId, source);
    const crawl: CrawlResult = {
      sourcesRequested: 1, sourcesCompleted: 1, sourcesSuccessful: 1, sourcesPartiallyCompleted: 0, sourcesFailed: 0,
      pagesVisited: source.pagesVisited, potentialPostingsInspected: source.potentialPostingsInspected,
      jobs, failures: [], closedPages: source.closedPages, completedSourceUrls: source.coverageComplete ? [source.sourceUrl] : [], sourceResults: [source],
    };
    const persisted = database.persistRun(runId, crawl, settings.closedAfterMisses);
    const [jsonPath, csvPath] = await Promise.all([
      writeJsonOutput(settings.outputDirectory, persisted.internships),
      writeCsvOutput(settings.outputDirectory, persisted.internships),
    ]);
    return { runId, sourceRows: artifact.totalRecords, canonicalRows: jobs.length, persisted, jsonPath, csvPath };
  } catch (error) {
    if (runId !== null) database.markRunFailed(runId, error);
    throw error;
  } finally { database.close(); }
}
