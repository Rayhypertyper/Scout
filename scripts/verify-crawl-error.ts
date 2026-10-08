import { readFile, writeFile, access } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  EARLY_CAREER_RADAR_LISTING_URL,
  EarlyCareerRadarAdapter,
  earlyCareerRadarDetailUrl,
  parseEarlyCareerRadarEmbeddedJobs,
  parseEarlyCareerRadarJobs,
} from "../src/crawler/adapters/earlyCareerRadar.js";
import type { HttpClient, HttpResponseSnapshot } from "../src/crawler/http.js";
import type { EarlyCareerRadarJob } from "../src/crawler/adapters/earlyCareerRadar.js";
import type { Logger } from "../src/utils/logger.js";
import { canonicalizeUrl } from "../src/utils/url.js";

interface ErrorRecord {
  id: number;
  sourceLabel: string;
  dateLabel: string;
  crawlId: number | null;
  url: string;
  message: string;
}

interface ErrorManifest {
  recordCount: number;
  records: ErrorRecord[];
}

interface RadarInventory {
  sourceUrl: string;
  httpStatus: number;
  retrievedAtUtc: string;
  completeness: {
    parsedFeedRows: number;
    uniqueIds: number;
    applyUrlRows: number;
  };
  records: Record<string, unknown>[];
}

const DEFAULT_OUTPUT_DIR = "output/error-remediation-2026-10-05";
const manifestPath = resolve(DEFAULT_OUTPUT_DIR, "error-manifest.json");
const inventoryPath = resolve(DEFAULT_OUTPUT_DIR, "early-career-radar-inventory.json");
const snapshotPath = resolve(DEFAULT_OUTPUT_DIR, "early-career-radar-page.html");

function cliValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] ?? null : null;
}

function requiredRecordId(): number {
  const value = cliValue("--record");
  const id = value ? Number(value) : NaN;
  if (!Number.isInteger(id) || id < 1) throw new Error("Usage: tsx scripts/verify-crawl-error.ts --record N [--output path]");
  return id;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function exactApplicationUrl(record: Record<string, unknown>): string | null {
  return typeof record.applyUrl === "string" && record.applyUrl.trim() ? record.applyUrl : null;
}

function normalizedUrlKey(value: string): string | null {
  try {
    return canonicalizeUrl(value);
  } catch {
    return null;
  }
}

/** Stable identity aliases for ATS routes whose login/job path may vary. */
function stableAtsIdentity(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const path = decodeURIComponent(url.pathname);
    if (host.includes("icims.com")) {
      const job = path.match(/\/jobs?\/(\d+)(?:\/|$)/i)?.[1];
      return job ? `${host}:icims:${job}` : null;
    }
    if (/myworkdayjobs\.com$/.test(host)) {
      const tail = path.split("/").filter(Boolean).at(-1) ?? "";
      const id = tail.match(/(?:_|-)([A-Za-z0-9-]{5,})$/)?.[1];
      return id ? `${host}:workday:${id.toLowerCase()}` : null;
    }
    if (host.includes("oraclecloud.com")) {
      const match = path.match(/\/CandidateExperience\/([^/]+)\/sites\/([^/]+)\/job\/([^/]+)/i);
      return match?.[1] && match[2] && match[3]
        ? `${host}:oracle:${match[1].toLowerCase()}:${match[2].toLowerCase()}:${match[3].toLowerCase()}`
        : null;
    }
    if (host.includes("smartrecruiters.com")) {
      const parts = path.split("/").filter(Boolean);
      const [company, job] = parts;
      return company && job ? `${host}:smart:${company.toLowerCase()}:${job.toLowerCase()}` : null;
    }
    if (/greenhouse\.io$/.test(host)) {
      const id = path.match(/\/jobs?\/(\d+)(?:\/|$)/i)?.[1];
      return id ? `${host}:greenhouse:${id}` : null;
    }
    if (host === "jobs.lever.co") {
      const parts = path.split("/").filter(Boolean);
      const [company, job] = parts;
      return company && job ? `${host}:lever:${company.toLowerCase()}:${job.toLowerCase()}` : null;
    }
  } catch {
    return null;
  }
  return null;
}

function isICimsLoginRewrite(raw: string, mapped: string): boolean {
  try {
    const original = new URL(raw);
    const candidate = new URL(mapped);
    return original.hostname === candidate.hostname
      && /^\/jobs\/\d+\/login\/?$/i.test(original.pathname)
      && /^\/jobs\/\d+\/job\/?$/i.test(candidate.pathname)
      && candidate.searchParams.get("mobile") === "true"
      && candidate.searchParams.get("needsRedirect") === "false";
  } catch {
    return false;
  }
}

async function loadConverter(): Promise<((job: EarlyCareerRadarJob, sourceUrl: string) => unknown) | null> {
  const converterPath = resolve("src/crawler/earlyCareerRadarRecovery.ts");
  try {
    await access(converterPath);
  } catch {
    return null;
  }
  const converterModule = await import(pathToFileURL(converterPath).href) as Record<string, unknown>;
  const converter = converterModule.earlyCareerRadarJobToRawJob;
  return typeof converter === "function"
    ? converter as (job: EarlyCareerRadarJob, sourceUrl: string) => unknown
    : null;
}

async function verifyRecord(record: ErrorRecord, inventory: RadarInventory, snapshotHtml: string): Promise<Record<string, unknown>> {
  const allJobs = parseEarlyCareerRadarJobs({ jobs: inventory.records }) ?? [];
  const jobsById = new Map(allJobs.map((job) => [job.id, job]));
  const matched = new Map<string, { job: EarlyCareerRadarJob; match: "exact_apply_url" | "stable_ats_identity" }>();
  for (const raw of inventory.records) {
    const id = typeof raw.id === "string" ? raw.id : null;
    const applyUrl = exactApplicationUrl(raw);
    if (!id || !applyUrl) continue;
    const match = normalizedUrlKey(applyUrl) === normalizedUrlKey(record.url)
      ? "exact_apply_url"
      : stableAtsIdentity(applyUrl) !== null && stableAtsIdentity(applyUrl) === stableAtsIdentity(record.url)
        ? "stable_ats_identity"
        : null;
    if (match) {
      const job = jobsById.get(id);
      if (job) matched.set(id, { job, match });
    }
  }

  if (record.id === 95) {
    const sourceUrl = inventory.sourceUrl;
    const response: HttpResponseSnapshot = {
      requestedUrl: sourceUrl,
      url: sourceUrl,
      status: inventory.httpStatus,
      contentType: "text/html; charset=utf-8",
      body: snapshotHtml,
      headers: {},
      attempts: 1,
      fromCache: false,
    };
    const client = { get: async () => response } as unknown as HttpClient;
    const logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined } as unknown as Logger;
    const collection = await new EarlyCareerRadarAdapter(client, logger).collect(sourceUrl);
    const parsed = parseEarlyCareerRadarEmbeddedJobs(snapshotHtml);
    const parsedIds = parsed?.map(({ id }) => id) ?? [];
    const expectedLinks = (parsed ?? []).map(({ id }) => earlyCareerRadarDetailUrl(id)).sort();
    const collectionLinks = collection.snapshots[0]?.links.map(({ url }) => canonicalizeUrl(url)).sort() ?? [];
    const uniqueIds = new Set(parsedIds);
    const sourceLimitFailures = collection.failures.filter(({ errorType }) => errorType === "source_limit");
    const cap = collection.maxRawListings ?? null;
    const checks = {
      capturedSnapshotParses: Boolean(parsed),
      capturedRowsMatchInventory: parsedIds.length === inventory.completeness.parsedFeedRows
        && uniqueIds.size === inventory.completeness.uniqueIds,
      everyParsedRowHasCanonicalLink: collectionLinks.length === expectedLinks.length
        && collectionLinks.every((url, index) => url === expectedLinks[index]),
      noSourceLimitFailure: sourceLimitFailures.length === 0,
      adapterReportsCompleteInventory: collection.inventoryComplete === true,
      safetyCapCoversCurrentFeed: cap !== null && cap >= parsedIds.length,
    };
    const passed = Object.values(checks).every(Boolean);
    return {
      record,
      verificationKind: "complete_feed_against_captured_snapshot",
      verifiedAt: new Date().toISOString(),
      status: passed ? "verified" : "incomplete",
      verified: passed,
      currentFeed: {
        sourceUrl,
        retrievedAtUtc: inventory.retrievedAtUtc,
        rowCount: parsedIds.length,
        uniqueIdCount: uniqueIds.size,
        canonicalDetailLinks: collectionLinks.length,
        sourceSafetyCap: cap,
        exactApplyUrlCount: parsed?.filter(({ applyUrl }) => Boolean(applyUrl)).length ?? 0,
        descriptionFieldCount: parsed?.filter(({ description }) => Boolean(description)).length ?? 0,
        inventoryComplete: collection.inventoryComplete === true,
        failures: collection.failures,
        notes: collection.notes,
      },
      checks,
      limitations: ["This evidence verifies the captured public feed and adapter inventory cap; it does not claim employer details were fetched."],
      evidenceFiles: [inventoryPath, snapshotPath],
    };
  }

  if (record.id >= 9 && record.id <= 94) {
    const converter = await loadConverter();
    const recovered: Record<string, unknown>[] = [];
    for (const { job, match } of matched.values()) {
      const converted = converter ? converter(job, inventory.sourceUrl) : null;
      if (!objectRecord(converted)) {
        recovered.push({
          id: job.id,
          match,
          recovered: false,
          reason: converter ? "converter returned no RawJob object" : "source-specific converter is not available yet",
        });
        continue;
      }
      const rawApplyUrl = job.applyUrl ?? earlyCareerRadarDetailUrl(job.id);
      const applicationUrl = typeof converted.applicationUrl === "string" ? converted.applicationUrl : null;
      const postingUrl = typeof converted.postingUrl === "string" ? converted.postingUrl : null;
      const factualFieldsRetained = converted.company === job.company && converted.title === job.title;
      const applicationUrlRetained = (applicationUrl !== null && normalizedUrlKey(rawApplyUrl) === normalizedUrlKey(applicationUrl))
        || isICimsLoginRewrite(rawApplyUrl, applicationUrl ?? "");
      const postingIdentityRetained = postingUrl !== null
        && canonicalizeUrl(postingUrl) === canonicalizeUrl(earlyCareerRadarDetailUrl(job.id));
      recovered.push({
        id: job.id,
        match,
        recovered: factualFieldsRetained && applicationUrlRetained && postingIdentityRetained,
        sourceCompany: job.company,
        sourceTitle: job.title,
        mappedCompany: converted.company ?? null,
        mappedTitle: converted.title ?? null,
        rawApplyUrl,
        mappedApplicationUrl: applicationUrl,
        postingUrl,
        postingIdentityRetained,
        factualFieldsRetained,
        applicationUrlRetained,
      });
    }
    const missingMatches = matched.size === 0;
    const recoveredCount = recovered.filter((item) => item.recovered === true).length;
    return {
      record,
      verificationKind: "feed_row_to_raw_job_without_employer_fetch",
      verifiedAt: new Date().toISOString(),
      status: missingMatches ? "unmatched" : recoveredCount === matched.size ? "verified" : "incomplete",
      verified: !missingMatches && recoveredCount === matched.size,
      matchedRows: [...matched.values()].map(({ job, match }) => ({ id: job.id, match, applyUrl: job.applyUrl ?? null, postingUrl: earlyCareerRadarDetailUrl(job.id) })),
      recovered,
      totals: { matched: matched.size, recovered: recoveredCount, parsedInventoryRows: inventory.records.length },
      converterAvailable: converter !== null,
      externalRequestsMade: 0,
      limitations: missingMatches ? ["No exact application URL or supported stable ATS identity matched the captured inventory."] : [],
      evidenceFiles: [inventoryPath, snapshotPath],
    };
  }

  return {
    record,
    verificationKind: "source_specific_evidence_required",
    verifiedAt: new Date().toISOString(),
    status: "unsupported_source",
    verified: false,
    evidenceFiles: [manifestPath],
    limitations: ["This helper currently implements Early Career Radar feed and record recovery checks only."],
  };
}

async function main(): Promise<void> {
  const id = requiredRecordId();
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ErrorManifest;
  const record = manifest.records.find((candidate) => candidate.id === id);
  if (!record) throw new Error(`Record ${id} was not found in ${manifestPath}`);
  const inventory = JSON.parse(await readFile(inventoryPath, "utf8")) as RadarInventory;
  const snapshotHtml = await readFile(snapshotPath, "utf8");
  if (inventory.sourceUrl !== EARLY_CAREER_RADAR_LISTING_URL) {
    throw new Error(`Inventory source ${inventory.sourceUrl} does not match configured source ${EARLY_CAREER_RADAR_LISTING_URL}`);
  }
  const outputPath = resolve(cliValue("--output") ?? resolve(DEFAULT_OUTPUT_DIR, `error-${String(id).padStart(3, "0")}.json`));
  if (!cliValue("--output")) {
    try {
      await access(outputPath);
      throw new Error(`Refusing to overwrite existing record evidence: ${outputPath}. Pass --output to choose a separate path.`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
    }
  }
  const report = await verifyRecord(record, inventory, snapshotHtml);
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ outputPath, status: report.status, verified: report.verified }));
}

await main();
