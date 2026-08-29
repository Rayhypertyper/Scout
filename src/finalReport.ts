import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { readConfiguredSources } from "./config/sourceCatalog.js";
import { MIN_LISTING_SCORE } from "./config/thresholds.js";
import { InternshipSchema, type Internship } from "./domain/schemas.js";
import { writeCsvOutput } from "./output/csv.js";
import { writeJsonOutput } from "./output/json.js";
import { hasVerifiedLinkedInDestinations, readVerifiedLinkedInUrls } from "./output/linkEligibility.js";
import { sanitizeInternshipForExport } from "./output/sanitize.js";
import { isListingContentAllowed } from "./output/eligibility.js";
import { isAllowedPostingLocation } from "./parsing/locations.js";
import { uniqueStrings } from "./utils/text.js";
import { canonicalizeUrl, isAggregatorUrl, redactSensitiveUrl } from "./utils/url.js";

interface CrawlRunRow {
  id: number;
  started_at: string;
  finished_at: string | null;
  sources_requested: number;
  sources_completed: number;
  pages_visited: number;
  potential_postings_inspected: number;
  internships_discovered: number;
  new_count: number;
  updated_count: number;
  unchanged_count: number;
  closed_count: number;
}

interface SourceResultRow {
  url: string;
  completed: number;
  pages_visited: number;
  potential_postings_inspected: number;
  jobs_discovered: number;
  failure_count: number;
  duration_ms: number | null;
  retrieval_mode: "configured_url" | "public_alternate";
  retrieval_urls_json: string;
  coverage_notes_json: string;
}

interface SourceCountRow {
  url: string;
  internship_count: number;
}

interface FailureRow {
  source_url: string;
  error_type: string;
  status_code: number | null;
  count: number;
}

function scalarNumber(database: DatabaseSync, sql: string, parameters: Record<string, string | number> = {}): number {
  const row = database.prepare(sql).get(parameters) as { value: number | bigint } | undefined;
  return Number(row?.value ?? 0);
}

function hasDatabaseColumn(database: DatabaseSync, table: string, column: string): boolean {
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function formatDurationMs(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "time unavailable";
  if (value < 1000) return `${Math.round(value)} ms`;
  const seconds = value / 1000;
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
  const totalSeconds = Math.round(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}m ${String(totalSeconds % 60).padStart(2, "0")}s`;
}

function textOrUnknown(value: string | null | undefined): string {
  return value?.trim() || "Unknown";
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function bulletList(values: string[]): string {
  const normalized = uniqueStrings(values.map(oneLine).filter(Boolean));
  return normalized.length > 0 ? normalized.map((value) => `- ${value}`).join("\n") : "- Unknown";
}

function countries(internship: Internship): string[] {
  return [...new Set(internship.normalizedLocations
    .map(({ country }) => country)
    .filter((country): country is string => Boolean(country)))];
}

export function internshipMarkdown(
  internship: Internship,
  index: number,
): string {
  const safe = sanitizeInternshipForExport(internship);
  return [
    `## ${index + 1}. ${oneLine(safe.company)} — ${oneLine(safe.title)}`,
    "",
    `Company: ${oneLine(safe.company)}`,
    `Role: ${oneLine(safe.title)}`,
    `Location: ${safe.location.length > 0 ? safe.location.map(oneLine).join("; ") : "Unknown"}`,
    `Country: ${countries(safe).join(", ") || "Unknown"}`,
    `Work arrangement: ${safe.remoteStatus}`,
    `Category: ${safe.categories.join(", ")}`,
    `Relevance: ${safe.relevanceScore}/100 — ${oneLine(safe.relevanceReason)}`,
    `Posted: ${textOrUnknown(safe.postingDate)}`,
    `Deadline: ${textOrUnknown(safe.deadline)}`,
    `Term: ${textOrUnknown(safe.internshipTerm)}`,
    `Internship year: ${textOrUnknown(safe.internshipYear)}`,
    `Salary: ${textOrUnknown(safe.salary)}`,
    "",
    "Required qualifications:",
    bulletList(safe.requiredQualifications),
    "",
    "Preferred qualifications:",
    bulletList(safe.preferredQualifications),
    "",
    "Education / graduation requirements:",
    bulletList([...safe.educationRequirements, ...safe.graduationRequirements]),
    "",
    "University-year / returning-to-school requirements:",
    bulletList([...safe.graduationRequirements, ...safe.educationRequirements].filter(
      (value) => /(?:first|second|third|fourth|freshman|sophomore|junior|senior|return(?:ing)? to|year of (?:study|school)|university year)/i.test(value),
    )),
    "",
    "Work authorization / sponsorship:",
    bulletList([
      ...safe.workAuthorizationRequirements,
      ...(safe.sponsorshipInformation ? [safe.sponsorshipInformation] : []),
    ]),
    "",
    "Technologies:",
    bulletList(safe.technologies),
    "",
    "DIRECT APPLY:",
    safe.applicationUrl,
    "",
    "Original job posting:",
    safe.postingUrl,
    "",
    "Discovered through:",
    bulletList(safe.sources),
    "",
  ].join("\n");
}

export async function readFinalReportVerifiedLinkedInUrls(outputDirectory: string): Promise<Set<string> | null> {
  return readVerifiedLinkedInUrls(join(outputDirectory, "link-verification.json"));
}

function sourceOutcome(row: SourceResultRow): "successful" | "partial" | "failed" {
  if (row.completed === 0) return "failed";
  return row.failure_count > 0 ? "partial" : "successful";
}

function requireRun(database: DatabaseSync, runId: number): CrawlRunRow {
  const row = database.prepare(`
    SELECT id, started_at, finished_at, sources_requested, sources_completed, pages_visited,
           potential_postings_inspected, internships_discovered, new_count, updated_count,
           unchanged_count, closed_count
    FROM crawl_runs WHERE id = @runId AND status = 'COMPLETED'
  `).get({ runId }) as unknown as CrawlRunRow | undefined;
  if (!row) throw new Error(`Completed crawl run ${runId} was not found.`);
  return row;
}

function newestFullRunId(database: DatabaseSync, configuredSources: string[]): number {
  const rows = database.prepare(`
    SELECT id FROM crawl_runs
    WHERE status = 'COMPLETED' AND sources_requested = @sourceCount
    ORDER BY id DESC
  `).all({ sourceCount: configuredSources.length }) as unknown as Array<{ id: number | bigint }>;
  const configured = new Set(configuredSources.map((source) => canonicalizeUrl(source)));
  const sourceUrls = database.prepare(`
    SELECT s.url FROM source_run_results sr JOIN sources s ON s.id = sr.source_id
    WHERE sr.run_id = @runId
  `);
  for (const row of rows) {
    const runId = Number(row.id);
    const observed = new Set((sourceUrls.all({ runId }) as unknown as Array<{ url: string }>).map(({ url }) => url));
    if (observed.size === configured.size && [...configured].every((url) => observed.has(url))) return runId;
  }
  throw new Error(`No completed crawl containing all ${configuredSources.length} configured sources was found.`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: "string", default: "output/live/internships.db" },
      "output-dir": { type: "string", default: "output/final-report" },
      "verification-run": { type: "string" },
      "session-start-run": { type: "string", default: "7" },
    },
  });
  const database = new DatabaseSync(values.database, { readOnly: true });
  try {
    const verifiedLinkedInUrls = await readFinalReportVerifiedLinkedInUrls(values["output-dir"]);
    const configuredSources = readConfiguredSources(database);
    const verificationRunId = values["verification-run"]
      ? Number.parseInt(values["verification-run"], 10)
      : newestFullRunId(database, configuredSources);
    const sessionStartRunId = Number.parseInt(values["session-start-run"], 10);
    if (!Number.isSafeInteger(verificationRunId) || !Number.isSafeInteger(sessionStartRunId)) {
      throw new Error("Run IDs must be integers.");
    }
    const verificationRun = requireRun(database, verificationRunId);
    const sessionStartRun = requireRun(database, sessionStartRunId);
    const openRows = database.prepare(`
      SELECT payload_json FROM internships
      WHERE availability_status = 'open'
        AND CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) >= @minimumScore
      ORDER BY CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) DESC,
               COALESCE(json_extract(payload_json, '$.postingDate'), '') DESC,
               company COLLATE NOCASE, title COLLATE NOCASE
    `).all({ minimumScore: MIN_LISTING_SCORE }) as unknown as Array<{ payload_json: string }>;
    const openInternships = openRows
      .map(({ payload_json: payload }) => InternshipSchema.parse(JSON.parse(payload)))
      .filter(isListingContentAllowed)
      .filter((internship) => hasVerifiedLinkedInDestinations(internship, verifiedLinkedInUrls))
      .filter(({ normalizedLocations, remoteStatus }) => isAllowedPostingLocation(normalizedLocations, remoteStatus));
    const sessionNew = openInternships.filter(({ discoveredAt }) => discoveredAt >= sessionStartRun.started_at);
    const durationColumn = hasDatabaseColumn(database, "source_run_results", "duration_ms")
      ? "sr.duration_ms"
      : "NULL AS duration_ms";
    const sourceResults = database.prepare(`
      SELECT s.url, sr.completed, sr.pages_visited, sr.potential_postings_inspected,
             sr.jobs_discovered, sr.failure_count, ${durationColumn}, sr.retrieval_mode,
             sr.retrieval_urls_json, sr.coverage_notes_json
      FROM source_run_results sr JOIN sources s ON s.id = sr.source_id
      WHERE sr.run_id = @runId
      ORDER BY sr.jobs_discovered DESC, s.url
    `).all({ runId: verificationRunId }) as unknown as SourceResultRow[];
    const sourceCounts = database.prepare(`
      SELECT s.url, COUNT(DISTINCT i.id) AS internship_count
      FROM internship_sources link
      JOIN sources s ON s.id = link.source_id
      JOIN internships i ON i.id = link.internship_id
      WHERE i.availability_status = 'open'
      GROUP BY s.id, s.url ORDER BY internship_count DESC, s.url
    `).all() as unknown as SourceCountRow[];
    const failures = database.prepare(`
      SELECT COALESCE(s.url, '(unknown)') AS source_url, f.error_type, f.status_code, COUNT(*) AS count
      FROM failed_pages f LEFT JOIN sources s ON s.id = f.source_id
      WHERE f.run_id = @runId
      GROUP BY source_url, f.error_type, f.status_code
      ORDER BY count DESC, source_url
    `).all({ runId: verificationRunId }) as unknown as FailureRow[];
    const outcomes = { successful: 0, partial: 0, failed: 0 };
    for (const row of sourceResults) outcomes[sourceOutcome(row)] += 1;
    const closedValid = scalarNumber(database, `
      SELECT COUNT(*) AS value FROM internships
      WHERE availability_status = 'closed'
        AND posting_url NOT LIKE '%job-boards.greenhouse.io/cssmerge/%'
        AND first_seen_at >= @sessionStart
    `, { sessionStart: sessionStartRun.started_at });
    const quarantined = scalarNumber(database, `
      SELECT COUNT(*) AS value FROM internships
      WHERE availability_status = 'closed'
        AND posting_url LIKE '%job-boards.greenhouse.io/cssmerge/%'
        AND first_seen_at >= @sessionStart
    `, { sessionStart: sessionStartRun.started_at });
    const configuredSourceSet = new Set(configuredSources.map((source) => canonicalizeUrl(source)));
    const configuredSourceCounts = sourceCounts.filter(({ url }) => configuredSourceSet.has(url));
    const summary = {
      generatedAt: new Date().toISOString(),
      database: values.database,
      verificationRun: {
        id: verificationRun.id,
        startedAt: verificationRun.started_at,
        finishedAt: verificationRun.finished_at,
        sourcesProvided: verificationRun.sources_requested,
        sourcesSuccessfullyScanned: outcomes.successful,
        sourcesPartiallyScanned: outcomes.partial,
        sourcesFailed: outcomes.failed,
        pagesVisited: verificationRun.pages_visited,
        potentialPostingsInspected: verificationRun.potential_postings_inspected,
        validInternshipsObserved: verificationRun.internships_discovered,
        lifecycle: {
          NEW: verificationRun.new_count,
          UPDATED: verificationRun.updated_count,
          UNCHANGED: verificationRun.unchanged_count,
          CLOSED: verificationRun.closed_count,
        },
      },
      finalState: {
        openValidInternships: openInternships.length,
        newOpenInternshipsSinceRun: sessionNew.length,
        sessionStartRunId,
        closedValidInternships: closedValid,
        quarantinedFalsePositives: quarantined,
        primaryBoardHostedApplicationUrlsWithoutPublicEmployerAts: openInternships.filter(({ applicationUrl }) => isAggregatorUrl(applicationUrl)).length,
        primaryBoardHostedPostingUrlsWithoutPublicEmployerAts: openInternships.filter(({ postingUrl }) => isAggregatorUrl(postingUrl)).length,
      },
      topSources: configuredSourceCounts.slice(0, 10).map((row) => ({
        url: redactSensitiveUrl(row.url),
        internshipCount: row.internship_count,
      })),
    };

    await mkdir(values["output-dir"], { recursive: true });
    await Promise.all([
      writeJsonOutput(values["output-dir"], openInternships),
      writeCsvOutput(values["output-dir"], openInternships),
      writeFile(join(values["output-dir"], "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8"),
      writeFile(join(values["output-dir"], "new-internships.md"), [
        "# All new retained internship listings",
        "",
        `Generated: ${summary.generatedAt}`,
        `Session start run: ${sessionStartRunId}`,
        `Open internships first discovered in this scouting session: ${sessionNew.length}`,
        "",
        ...sessionNew.map((internship, index) => internshipMarkdown(internship, index)),
      ].join("\n"), "utf8"),
      writeFile(join(values["output-dir"], "source-report.md"), [
        "# Source crawl report",
        "",
        `Verification run: ${verificationRunId}`,
        `Sources: ${sourceResults.length} (${outcomes.successful} successful, ${outcomes.partial} partial, ${outcomes.failed} failed)` ,
        "",
        "## Per-source results",
        "",
        ...sourceResults.map((row) => {
          const mode = row.retrieval_mode === "public_alternate" ? "public alternate" : "configured URL";
          const notes = (() => {
            try {
              const parsed = JSON.parse(row.coverage_notes_json) as unknown;
              return Array.isArray(parsed) && parsed.length > 0 ? `; ${parsed.join("; ")}` : "";
            } catch {
              return "";
            }
          })();
          return `- ${redactSensitiveUrl(row.url)} — ${formatDurationMs(row.duration_ms)}; ${sourceOutcome(row)} via ${mode}; ${row.pages_visited} pages; ${row.potential_postings_inspected} postings inspected; ${row.jobs_discovered} valid; ${row.failure_count} failed pages${notes}`;
        }),
        "",
        "## Sources producing the most current internships",
        "",
        ...configuredSourceCounts.map((row) => `- ${redactSensitiveUrl(row.url)} — ${row.internship_count}`),
        "",
        "## Recorded failures in verification run",
        "",
        ...(failures.length > 0
          ? failures.map((row) => `- ${redactSensitiveUrl(row.source_url)} — ${row.error_type}${row.status_code ? ` HTTP ${row.status_code}` : ""}: ${row.count}`)
          : ["- None"]),
        "",
        "## Parser and crawler fixes applied during the live crawl",
        "",
        "- Added embedded Intern List country/category discovery for both Canada and the United States.",
        "- Added and hardened direct-application resolution for aggregator Apply controls and exact public employer/ATS matches.",
        "- Added dynamic-detail waits and extraction fixes for Oracle HCM, IBM Careers, TikTok USDS, ByteDance, and New York Life.",
        "- Fixed Jobright hidden/closed handling, exact verified closures, provider-aware deduplication, company/title normalization, and qualification-section leakage.",
        "- Promoted verified employer/ATS destinations to both direct-application and original-posting fields while preserving every discovery source.",
        "- Quarantined a Greenhouse integration sandbox false positive instead of treating it as a production internship.",
        "",
        "## Sites requiring or using custom handling",
        "",
        "- Intern List embedded regional/category feeds; Jobright; Workday; Greenhouse; Lever; Ashby; Oracle HCM; ByteDance/TikTok USDS; IBM Careers.",
        "- TimberSync's original posting is LinkedIn onsite-apply; LinkedIn disallows this crawler via robots.txt, so its public structured posting was verified separately and the robots failure was preserved.",
        "- Two startup roles are hosted and applied to directly on Wellfound; no separate public employer ATS/posting was available for those roles.",
        "- CAPTCHA, login-wall, and access-control failures were recorded and skipped; no access control was bypassed.",
        "",
      ].join("\n"), "utf8"),
    ]);
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  } finally {
    database.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
