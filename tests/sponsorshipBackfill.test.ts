import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { backfillSponsorship, restoreSponsorshipInformation } from "../src/backfillSponsorship.js";
import { internshipContentHash } from "../src/classification/analyzeJob.js";
import { InternshipSchema } from "../src/domain/schemas.js";
import { extractQualificationDetails } from "../src/parsing/qualifications.js";
import { makeInternship } from "./helpers.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("sponsorship backfill", () => {
  it("updates only sponsorship fields, preserves legacy keys, and is idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-sponsorship-backfill-"));
    temporaryDirectories.push(directory);
    const database = new DatabaseSync(join(directory, "fixture.db"));
    database.exec("CREATE TABLE internships (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL, company TEXT NOT NULL)");

    const insert = database.prepare("INSERT INTO internships (id, payload_json, content_hash, company) VALUES (?, ?, ?, ?)");
    const add = (
      id: string,
      description: string,
      sponsorship: string,
      extraConflict = false,
      overrides: { company?: string; title?: string; sponsorshipInformation?: string | null } = {},
    ): void => {
      const internship = makeInternship({
        id,
        description,
        ...(overrides.company ? { company: overrides.company } : {}),
        ...(overrides.title ? { title: overrides.title } : {}),
      });
      const payload = JSON.parse(JSON.stringify(internship)) as Record<string, unknown>;
      const details = payload.qualificationDetails as Record<string, unknown>;
      payload.sponsorshipInformation = overrides.sponsorshipInformation ?? null;
      details.sponsorship = sponsorship;
      details.legacyQualificationField = "keep nested legacy data";
      details.conflicts = [
        ...(extraConflict ? [{ key: "graduation", evidence: ["Existing graduation conflict"] }] : []),
        ...(sponsorship !== "unknown" ? [{ key: "sponsorship", evidence: ["Stale sponsorship evidence"] }] : []),
      ];
      payload.legacyPayloadField = { preserve: true };
      insert.run(id, JSON.stringify(payload), `old-${id}`, "Relational company stays fixed");
    };
    const addLegacyPartial = (): void => {
      const internship = makeInternship({
        id: "legacy-partial",
        description: "Visa sponsorship is available for this position.",
      });
      const payload = JSON.parse(JSON.stringify(internship)) as Record<string, unknown>;
      payload.qualificationDetails = {
        sponsorship: "unknown",
        conflicts: [],
        legacyQualificationField: "keep nested legacy data",
      };
      payload.legacyPayloadField = { preserve: true };
      insert.run("legacy-partial", JSON.stringify(payload), "old-legacy-partial", "Relational company stays fixed");
    };

    add("deny", "The company will not pursue visa sponsorship for this position.", "required", true);
    add("offer", "Employer sponsorship is available for eligible candidates.", "unknown");
    add("question", "Will you now or in the future require company sponsorship? * Select yes or no.", "required");
    add("silent", "Build and test production software using Python.", "unknown");
    addLegacyPartial();
    add(
      "recursive-evidence",
      "Sponsorship GoDaddy will not sponsor employment-based visas (e.g., candidates who now or in the future will require H-1B sponsorship) for this position at this level.",
      "unknown",
      false,
      { company: "GoDaddy", title: "Software Development Engineer Intern" },
    );
    add(
      "raw-evidence-only",
      "Build and test production software using Python.",
      "unknown",
      false,
      { sponsorshipInformation: "Visa sponsorship is available for this position." },
    );

    const first = backfillSponsorship(database);
    expect(first).toEqual({
      scanned: 7,
      changed: 6,
      skippedConcurrentUpdates: 0,
      statuses: { available: 3, unavailable: 2, required: 0, unknown: 2 },
    });

    const rows = database.prepare("SELECT id, payload_json, content_hash, company FROM internships ORDER BY id").all() as unknown as Array<{
      id: string;
      payload_json: string;
      content_hash: string;
      company: string;
    }>;
    expect(rows).toHaveLength(7);
    const payloads = new Map(rows.map((row) => [row.id, { row, payload: JSON.parse(row.payload_json) as Record<string, unknown> }]));
    const denial = payloads.get("deny");
    expect((denial?.payload.qualificationDetails as Record<string, unknown>).sponsorship).toBe("unavailable");
    expect((denial?.payload.qualificationDetails as Record<string, unknown>).legacyQualificationField).toBe("keep nested legacy data");
    expect((denial?.payload.qualificationDetails as Record<string, unknown>).conflicts).toEqual([
      { key: "graduation", evidence: ["Existing graduation conflict"] },
    ]);
    expect(denial?.payload.legacyPayloadField).toEqual({ preserve: true });
    expect(denial?.row.content_hash).not.toBe("old-deny");
    expect(rows.every((row) => row.company === "Relational company stays fixed")).toBe(true);
    expect((payloads.get("offer")?.payload.qualificationDetails as Record<string, unknown>).sponsorship).toBe("available");
    expect((payloads.get("question")?.payload.qualificationDetails as Record<string, unknown>).sponsorship).toBe("unknown");
    expect(payloads.get("silent")?.row.content_hash).toBe("old-silent");
    const legacyPartial = payloads.get("legacy-partial");
    const legacyDetails = legacyPartial?.payload.qualificationDetails as Record<string, unknown>;
    expect(legacyDetails.sponsorship).toBe("available");
    expect(legacyDetails.legacyQualificationField).toBe("keep nested legacy data");
    expect(legacyDetails.workAuthorization).toBeUndefined();
    expect(legacyPartial?.payload.legacyPayloadField).toEqual({ preserve: true });
    expect(legacyPartial?.row.content_hash).toBe(
      internshipContentHash(InternshipSchema.parse(legacyPartial?.payload)),
    );
    const recursive = payloads.get("recursive-evidence");
    expect((recursive?.payload.qualificationDetails as Record<string, unknown>).sponsorship).toBe("unavailable");
    expect(recursive?.payload.sponsorshipInformation).toBeNull();
    const rawEvidenceOnly = payloads.get("raw-evidence-only");
    expect((rawEvidenceOnly?.payload.qualificationDetails as Record<string, unknown>).sponsorship).toBe("available");
    expect(rawEvidenceOnly?.payload.sponsorshipInformation).toBe("Visa sponsorship is available for this position.");

    expect(backfillSponsorship(database)).toEqual({
      scanned: 7,
      changed: 0,
      skippedConcurrentUpdates: 0,
      statuses: { available: 3, unavailable: 2, required: 0, unknown: 2 },
    });
    expect(backfillSponsorship(database)).toEqual({
      scanned: 7,
      changed: 0,
      skippedConcurrentUpdates: 0,
      statuses: { available: 3, unavailable: 2, required: 0, unknown: 2 },
    });
    database.close();
  });

  it("projects and optimistically restores only drifted raw evidence from a matching snapshot", () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-sponsorship-repair-"));
    temporaryDirectories.push(directory);
    const live = new DatabaseSync(join(directory, "live.db"));
    const backup = new DatabaseSync(join(directory, "backup.db"));
    const schema = "CREATE TABLE internships (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL, content_hash TEXT NOT NULL, job_id TEXT, company TEXT NOT NULL, normalized_company TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, normalized_title TEXT NOT NULL DEFAULT '', location_key TEXT NOT NULL DEFAULT '', application_url TEXT NOT NULL, posting_url TEXT NOT NULL, canonical_url TEXT, canonical_application_url TEXT, canonical_posting_url TEXT, external_job_id TEXT, provider_identity TEXT)";
    live.exec(schema);
    backup.exec(schema);
    const insert = (database: DatabaseSync, payload: Record<string, unknown>): void => {
      const internship = InternshipSchema.parse(payload);
      database.prepare("INSERT INTO internships (id, payload_json, content_hash, job_id, company, title, application_url, posting_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        internship.id,
        JSON.stringify(payload),
        internshipContentHash(internship),
        internship.jobId,
        internship.company,
        internship.title,
        internship.applicationUrl,
        internship.postingUrl,
      );
    };
    const source = makeInternship({
      id: "repair-match",
      company: "Acme Robotics",
      title: "Software Engineering Intern",
      description: "Visa sponsorship is available for this position. Visa sponsorship for work authorization is not available for this position now or in the future.",
      sponsorshipInformation: null,
    });
    const sourcePayload = JSON.parse(JSON.stringify(source)) as Record<string, unknown>;
    sourcePayload.legacyPayloadField = { preserve: true };
    const sourceDetails = sourcePayload.qualificationDetails as Record<string, unknown>;
    sourceDetails.legacyQualificationField = "preserve nested data";
    sourceDetails.conflicts = [{ key: "graduation", evidence: ["Conflicting graduation year"] }];
    insert(backup, sourcePayload);

    const driftedPayload = JSON.parse(JSON.stringify(sourcePayload)) as Record<string, unknown>;
    const driftedEvidence = `${source.description} ${source.description}`;
    driftedPayload.sponsorshipInformation = driftedEvidence;
    const driftedDetails = driftedPayload.qualificationDetails as Record<string, unknown>;
    driftedDetails.sponsorship = "unknown";
    driftedDetails.conflicts = [
      { key: "graduation", evidence: ["Conflicting graduation year"] },
      ...extractQualificationDetails(source.description).conflicts.filter((conflict) => conflict.key === "sponsorship"),
    ];
    insert(live, driftedPayload);

    const changedSource = makeInternship({
      id: "repair-changed-listing",
      company: "Acme Robotics",
      title: "Data Science Intern",
      description: "Visa sponsorship is available for this position.",
      sponsorshipInformation: null,
    });
    const changedBackupPayload = JSON.parse(JSON.stringify(changedSource)) as Record<string, unknown>;
    insert(backup, changedBackupPayload);
    const changedLivePayload: Record<string, unknown> = {
      ...changedBackupPayload,
      description: "This listing now has a different description and role policy.",
    };
    changedLivePayload.sponsorshipInformation = "Visa sponsorship is available for this position. Visa sponsorship is available for this position.";
    (changedLivePayload.qualificationDetails as Record<string, unknown>).sponsorship = "available";
    insert(live, changedLivePayload);

    const before = live.prepare("SELECT payload_json, content_hash FROM internships WHERE id = ?").get("repair-match") as { payload_json: string; content_hash: string };
    expect(restoreSponsorshipInformation(live, backup)).toEqual({
      scanned: 2,
      projectedChanges: 1,
      restored: 0,
      skippedMissingBackup: 0,
      skippedChangedListing: 1,
      skippedConcurrentUpdates: 0,
    });
    expect(live.prepare("SELECT payload_json, content_hash FROM internships WHERE id = ?").get("repair-match")).toEqual(before);

    expect(restoreSponsorshipInformation(live, backup, { apply: true })).toEqual({
      scanned: 2,
      projectedChanges: 1,
      restored: 1,
      skippedMissingBackup: 0,
      skippedChangedListing: 1,
      skippedConcurrentUpdates: 0,
    });
    const repaired = live.prepare("SELECT payload_json, content_hash FROM internships WHERE id = ?").get("repair-match") as { payload_json: string; content_hash: string };
    const repairedPayload = JSON.parse(repaired.payload_json) as Record<string, unknown>;
    const repairedDetails = repairedPayload.qualificationDetails as Record<string, unknown>;
    expect(repairedPayload.sponsorshipInformation).toBeNull();
    expect(repairedPayload.legacyPayloadField).toEqual({ preserve: true });
    expect(repairedDetails.sponsorship).toBe("unknown");
    expect(repairedDetails.legacyQualificationField).toBe("preserve nested data");
    expect(repairedDetails.conflicts).toEqual([
      { key: "graduation", evidence: ["Conflicting graduation year"] },
      ...extractQualificationDetails(source.description).conflicts.filter((conflict) => conflict.key === "sponsorship"),
    ]);
    expect(repaired.content_hash).toBe(internshipContentHash(InternshipSchema.parse(repairedPayload)));
    expect(backfillSponsorship(live)).toEqual({
      scanned: 2,
      changed: 0,
      skippedConcurrentUpdates: 0,
      statuses: { available: 1, unavailable: 0, required: 0, unknown: 1 },
    });
    expect(restoreSponsorshipInformation(live, backup, { apply: true })).toEqual({
      scanned: 2,
      projectedChanges: 0,
      restored: 0,
      skippedMissingBackup: 0,
      skippedChangedListing: 1,
      skippedConcurrentUpdates: 0,
    });
    live.close();
    backup.close();
  });
});
