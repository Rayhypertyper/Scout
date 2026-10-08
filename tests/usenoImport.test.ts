import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { resolveSettings } from "../src/config/settings.js";
import { extractUsenoInternshipMasterlist } from "../src/extractors/useno.js";
import { importUsenoMasterlist } from "../src/integrations/usenoMasterlistImport.js";
import type { UsenoMasterlistCrawlArtifact } from "../src/crawler/useno.js";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function artifact(company: string, requisition: number): UsenoMasterlistCrawlArtifact {
  const sourceUrl = "https://www.useno.app/resources/internship-masterlist";
  const rows = [["Software Engineering Intern", company, "Toronto, ON", "Hybrid", `https://job-boards.greenhouse.io/maple/jobs/${requisition}`, "2026-10-06", "Internship", "CA", "Ontario", "software", 1, 0, `greenhouse:maple:${requisition}`]];
  return {
    ...extractUsenoInternshipMasterlist(`<main><h1>Internship Index</h1><script id="ml-data">${JSON.stringify({ roles: rows })}</script></main>`, sourceUrl),
    retrieval: { requestedUrl: sourceUrl, finalUrl: sourceUrl, httpStatus: 200, contentType: "text/html", attempts: 1, fromCache: false, etag: null, lastModified: null, contentLength: null },
    inventory: { rawRoleCount: 1, declaredTotal: 10, previewCapped: true, coverageComplete: false, feedPages: 1, directApplicationLinks: 1, unresolvedApplicationLinks: 0, retrievalUrls: [sourceUrl] },
  };
}

it("publishes imported listings and keeps unseen history when the public feed is capped", async () => {
  const directory = mkdtempSync(join(tmpdir(), "useno-import-"));
  directories.push(directory);
  const settings = resolveSettings({ databasePath: join(directory, "jobs.db"), outputDirectory: directory, closedAfterMisses: 1 });
  const first = await importUsenoMasterlist(artifact("First Employer", 1001), settings);
  const second = await importUsenoMasterlist(artifact("Second Employer", 1002), settings);
  expect(first.sourceRows).toBe(1);
  expect(second.persisted.internships).toHaveLength(1);
  const reader = new DatabaseSync(settings.databasePath, { readOnly: true });
  try {
    expect(reader.prepare("SELECT status FROM crawl_runs ORDER BY id DESC LIMIT 1").get()?.status).toBe("COMPLETED");
    expect(reader.prepare("SELECT COUNT(*) AS count FROM internships").get()?.count).toBe(2);
    const original = reader.prepare("SELECT availability_status, miss_count FROM internships WHERE company = ?").get("First Employer");
    expect(original).toMatchObject({ availability_status: "open", miss_count: 0 });
    expect(reader.prepare("SELECT coverage_complete FROM source_run_results WHERE run_id = ?").get(second.runId)?.coverage_complete).toBe(0);
  } finally { reader.close(); }
});
