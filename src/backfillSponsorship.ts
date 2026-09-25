import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { internshipContentHash } from "./classification/analyzeJob.js";
import { InternshipSchema, type SponsorshipState } from "./domain/schemas.js";
import { extractQualificationDetails } from "./parsing/qualifications.js";

interface InternshipPayloadRow {
  id: string;
  payload_json: string;
  content_hash: string;
}

interface PendingSponsorshipUpdate {
  id: string;
  originalPayload: string;
  originalContentHash: string;
  payload: string;
  contentHash: string;
}

type JsonRecord = Record<string, unknown>;

export interface SponsorshipBackfillResult {
  scanned: number;
  changed: number;
  skippedConcurrentUpdates: number;
  statuses: Record<SponsorshipState, number>;
}

export interface SponsorshipEvidenceRestoreResult {
  scanned: number;
  projectedChanges: number;
  restored: number;
  skippedMissingBackup: number;
  skippedChangedListing: number;
  skippedConcurrentUpdates: number;
}

interface SponsorshipEvidenceRow extends InternshipPayloadRow {
  job_id: string | null;
  company: string;
  normalized_company: string;
  title: string;
  normalized_title: string;
  location_key: string;
  application_url: string;
  posting_url: string;
  canonical_url: string | null;
  canonical_application_url: string | null;
  canonical_posting_url: string | null;
  external_job_id: string | null;
  provider_identity: string | null;
}

function record(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

function sponsorshipConflict(conflict: unknown): boolean {
  return record(conflict).key === "sponsorship";
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as JsonRecord).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function nonSponsorshipPayload(value: unknown): JsonRecord {
  const payload = { ...record(value) };
  delete payload.sponsorshipInformation;
  const details = record(payload.qualificationDetails);
  if (payload.qualificationDetails && typeof payload.qualificationDetails === "object" && !Array.isArray(payload.qualificationDetails)) {
    const nonSponsorshipDetails = { ...details };
    delete nonSponsorshipDetails.sponsorship;
    // Conflicts are preserved from the current row by the repair. They may
    // legitimately differ from the snapshot, so they do not identify the
    // listing whose raw evidence is being restored.
    delete nonSponsorshipDetails.conflicts;
    if (Object.keys(nonSponsorshipDetails).length > 0) payload.qualificationDetails = nonSponsorshipDetails;
    else delete payload.qualificationDetails;
  }
  return payload;
}

function sameListing(left: SponsorshipEvidenceRow, right: SponsorshipEvidenceRow, leftPayload: unknown, rightPayload: unknown): boolean {
  return [
    "job_id",
    "company",
    "normalized_company",
    "title",
    "normalized_title",
    "location_key",
    "application_url",
    "posting_url",
    "canonical_url",
    "canonical_application_url",
    "canonical_posting_url",
    "external_job_id",
    "provider_identity",
  ].every((key) => left[key as keyof SponsorshipEvidenceRow] === right[key as keyof SponsorshipEvidenceRow])
    && stableJson(nonSponsorshipPayload(leftPayload)) === stableJson(nonSponsorshipPayload(rightPayload));
}

function restorePayloadEvidence(currentValue: unknown, backupValue: unknown): JsonRecord {
  const current = { ...record(currentValue) };
  const backup = record(backupValue);
  if (Object.hasOwn(backup, "sponsorshipInformation")) {
    current.sponsorshipInformation = backup.sponsorshipInformation;
  } else {
    delete current.sponsorshipInformation;
  }
  return current;
}

/**
 * Refresh only sponsorship evidence in an already-open SQLite database.
 * Unknown legacy payload keys are retained by operating directly on the JSON
 * record instead of parsing and rebuilding it through the current schema.
 */
export function backfillSponsorship(database: DatabaseSync): SponsorshipBackfillResult {
  database.exec("PRAGMA busy_timeout = 30000");
  const result: SponsorshipBackfillResult = {
    scanned: 0,
    changed: 0,
    skippedConcurrentUpdates: 0,
    statuses: { available: 0, unavailable: 0, required: 0, unknown: 0 },
  };
  const pendingUpdates: PendingSponsorshipUpdate[] = [];
  const rows = database.prepare("SELECT id, payload_json, content_hash FROM internships").iterate() as Iterable<InternshipPayloadRow>;
  for (const row of rows) {
    result.scanned += 1;
    const payload = record(JSON.parse(row.payload_json));
    const details = record(payload.qualificationDetails);
    const text = [
      typeof payload.description === "string" ? payload.description : "",
      ...strings(payload.requiredQualifications),
      ...strings(payload.preferredQualifications),
      ...strings(payload.workAuthorizationRequirements),
      typeof payload.sponsorshipInformation === "string" ? payload.sponsorshipInformation : "",
    ].join("\n");
    const extracted = extractQualificationDetails(text);
    const oldConflicts: unknown[] = Array.isArray(details.conflicts) ? details.conflicts as unknown[] : [];
    const sponsorshipConflicts = extracted.conflicts.filter((conflict) => conflict.key === "sponsorship");
    const nextConflicts = [
      ...oldConflicts.filter((conflict) => !sponsorshipConflict(conflict)),
      ...sponsorshipConflicts,
    ];
    const nextDetails: JsonRecord = {
      ...details,
      sponsorship: extracted.sponsorship,
      conflicts: nextConflicts,
    };
    const nextPayload: JsonRecord = {
      ...payload,
      // sponsorshipInformation is source evidence. Keep it as input only;
      // extracting into the same field makes repeated passes feed generated
      // text back into itself and can grow the evidence on every retry.
      qualificationDetails: nextDetails,
    };
    result.statuses[extracted.sponsorship] += 1;
    const payloadJson = JSON.stringify(nextPayload);
    if (payloadJson === row.payload_json) continue;

    // Hash the schema-normalized shape used on the next database read, but
    // keep the raw payload serialization so legacy/unknown keys survive.
    pendingUpdates.push({
      id: row.id,
      originalPayload: row.payload_json,
      originalContentHash: row.content_hash,
      payload: payloadJson,
      contentHash: internshipContentHash(InternshipSchema.parse(nextPayload)),
    });
  }

  if (pendingUpdates.length === 0) return result;
  // Scan and classify outside the write reservation so active database users
  // are blocked only while changed payloads are applied.
  database.exec("BEGIN IMMEDIATE");
  try {
    const update = database.prepare("UPDATE internships SET payload_json = @payload, content_hash = @contentHash WHERE id = @id AND payload_json = @originalPayload AND content_hash = @originalContentHash");
    for (const pending of pendingUpdates) {
      const updateResult = update.run({
        id: pending.id,
        originalPayload: pending.originalPayload,
        originalContentHash: pending.originalContentHash,
        payload: pending.payload,
        contentHash: pending.contentHash,
      });
      if (Number(updateResult.changes) === 1) result.changed += 1;
      else result.skippedConcurrentUpdates += 1;
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Keep the original error if rollback itself fails.
    }
    throw error;
  }
}

/**
 * Restore only raw sponsorshipInformation from a pre-backfill snapshot when
 * the listing's other payload and identity fields still match. The default is
 * a read-only projection; pass apply=true to perform optimistic writes.
 */
export function restoreSponsorshipInformation(
  database: DatabaseSync,
  backupDatabase: DatabaseSync,
  options: { apply?: boolean } = {},
): SponsorshipEvidenceRestoreResult {
  database.exec("PRAGMA busy_timeout = 30000");
  const result: SponsorshipEvidenceRestoreResult = {
    scanned: 0,
    projectedChanges: 0,
    restored: 0,
    skippedMissingBackup: 0,
    skippedChangedListing: 0,
    skippedConcurrentUpdates: 0,
  };
  const columns = "id, payload_json, content_hash, job_id, company, normalized_company, title, normalized_title, location_key, application_url, posting_url, canonical_url, canonical_application_url, canonical_posting_url, external_job_id, provider_identity";
  const backupForId = backupDatabase.prepare(`SELECT ${columns} FROM internships WHERE id = ?`);
  const pending: Array<{
    id: string;
    payload: string;
    contentHash: string;
    originalPayload: string;
    originalContentHash: string;
    row: SponsorshipEvidenceRow;
  }> = [];
  const rows = database.prepare(`SELECT ${columns} FROM internships`).iterate() as Iterable<SponsorshipEvidenceRow>;
  for (const row of rows) {
    result.scanned += 1;
    const backupRow = backupForId.get(row.id) as SponsorshipEvidenceRow | undefined;
    if (!backupRow) {
      result.skippedMissingBackup += 1;
      continue;
    }
    const currentPayload = record(JSON.parse(row.payload_json));
    const backupPayload = record(JSON.parse(backupRow.payload_json));
    if (!sameListing(row, backupRow, currentPayload, backupPayload)) {
      result.skippedChangedListing += 1;
      continue;
    }
    const nextPayload = restorePayloadEvidence(currentPayload, backupPayload);
    const payloadJson = JSON.stringify(nextPayload);
    if (payloadJson === row.payload_json) continue;
    result.projectedChanges += 1;
    pending.push({
      id: row.id,
      payload: payloadJson,
      contentHash: internshipContentHash(InternshipSchema.parse(nextPayload)),
      originalPayload: row.payload_json,
      originalContentHash: row.content_hash,
      row,
    });
  }

  if (!options.apply || pending.length === 0) return result;
  database.exec("BEGIN IMMEDIATE");
  try {
    const update = database.prepare("UPDATE internships SET payload_json = @payload, content_hash = @contentHash WHERE id = @id AND payload_json = @originalPayload AND content_hash = @originalContentHash AND job_id IS @jobId AND company IS @company AND normalized_company IS @normalizedCompany AND title IS @title AND normalized_title IS @normalizedTitle AND location_key IS @locationKey AND application_url IS @applicationUrl AND posting_url IS @postingUrl AND canonical_url IS @canonicalUrl AND canonical_application_url IS @canonicalApplicationUrl AND canonical_posting_url IS @canonicalPostingUrl AND external_job_id IS @externalJobId AND provider_identity IS @providerIdentity");
    for (const item of pending) {
      const updateResult = update.run({
        id: item.id,
        payload: item.payload,
        contentHash: item.contentHash,
        originalPayload: item.originalPayload,
        originalContentHash: item.originalContentHash,
        jobId: item.row.job_id,
        company: item.row.company,
        normalizedCompany: item.row.normalized_company,
        title: item.row.title,
        normalizedTitle: item.row.normalized_title,
        locationKey: item.row.location_key,
        applicationUrl: item.row.application_url,
        postingUrl: item.row.posting_url,
        canonicalUrl: item.row.canonical_url,
        canonicalApplicationUrl: item.row.canonical_application_url,
        canonicalPostingUrl: item.row.canonical_posting_url,
        externalJobId: item.row.external_job_id,
        providerIdentity: item.row.provider_identity,
      });
      if (Number(updateResult.changes) === 1) result.restored += 1;
      else result.skippedConcurrentUpdates += 1;
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      // Keep the original error if rollback itself fails.
    }
    throw error;
  }
}

function main(): void {
  const { values } = parseArgs({ options: {
    database: { type: "string" },
    "restore-sponsorship-information-from": { type: "string" },
    apply: { type: "boolean", default: false },
  } });
  if (!values.database) throw new Error("Pass --database <path>; this script has no live-database default.");
  const restoreFrom = values["restore-sponsorship-information-from"];
  const database = new DatabaseSync(values.database, { readOnly: Boolean(restoreFrom) && !values.apply });
  try {
    if (restoreFrom) {
      const backup = new DatabaseSync(restoreFrom, { readOnly: true });
      try {
        process.stdout.write(`${JSON.stringify(restoreSponsorshipInformation(database, backup, { apply: values.apply }))}\n`);
      } finally {
        backup.close();
      }
    } else {
      process.stdout.write(`${JSON.stringify(backfillSponsorship(database))}\n`);
    }
  } finally {
    database.close();
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedFile === import.meta.url) main();
