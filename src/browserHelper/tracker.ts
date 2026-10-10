import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

import { ensureAccountActionSchema } from "../database/accountActions.js";
import {
  listingActionKey,
  replaceListingActionIdentities,
  type ListingType,
} from "../database/actions.js";
import { InternshipSchema, type Internship } from "../domain/schemas.js";
import {
  GRIND_JOB_BOARD_SOURCE_URL,
  grindJobToInternship,
  type GrindJobBoardSnapshot,
} from "../integrations/grindJobBoard.js";
import { normalizeCompanyIdentity } from "../utils/text.js";
import { canonicalizeUrl } from "../utils/url.js";
import { sha256 } from "../utils/hash.js";
import { ResumeProfileError } from "../resume/profile.js";
import type { BrowserHelperApplicationResult, BrowserHelperApplicationSubmission } from "./http.js";

interface StoredInternshipRow {
  id: string;
  payload_json: string;
}

interface ResolvedListing {
  listingType: ListingType;
  listingId: string;
  company: string;
  title: string;
  internship: Internship | null;
}

type GrindSnapshotReader = () => Promise<GrindJobBoardSnapshot>;

function safeApplicationUrl(value: string): string {
  let canonical: string;
  try {
    canonical = canonicalizeUrl(value.trim());
  } catch {
    throw new ResumeProfileError(400, "applicationUrl must be a valid HTTP or HTTPS URL.");
  }
  const parsed = new URL(canonical);
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) {
    throw new ResumeProfileError(400, "applicationUrl must be a valid HTTP or HTTPS URL.");
  }
  return canonical;
}

function applicationUrlIdentity(value: string): string {
  const canonical = canonicalizeUrl(value.trim());
  try {
    const parsed = new URL(value);
    const token = parsed.searchParams.get("token");
    if (/\/embed\/job_app\/?$/i.test(parsed.pathname) && token) {
      return `${canonical}|embedded:${sha256(token).slice(0, 24)}`;
    }
  } catch {
    // canonicalizeUrl below already validates ordinary URL syntax.
  }
  return canonical;
}

function canonicalMatches(left: string | null | undefined, expectedIdentity: string): boolean {
  if (!left) return false;
  try {
    return applicationUrlIdentity(left) === expectedIdentity;
  } catch {
    return false;
  }
}

function parseStoredInternship(row: StoredInternshipRow | undefined): Internship | null {
  if (!row) return null;
  try {
    return InternshipSchema.parse(JSON.parse(row.payload_json) as unknown);
  } catch {
    return null;
  }
}

function findInternshipById(database: DatabaseSync, id: string): Internship | null {
  const row = database.prepare("SELECT id, payload_json FROM internships WHERE id = @id").get({ id }) as StoredInternshipRow | undefined;
  return parseStoredInternship(row);
}

function findInternshipByUrl(database: DatabaseSync, urlIdentity: string): ResolvedListing | null {
  const rows = database.prepare("SELECT id, payload_json FROM internships ORDER BY id").all() as unknown as StoredInternshipRow[];
  for (const row of rows) {
    const internship = parseStoredInternship(row);
    if (!internship) continue;
    if (![internship.applicationUrl, internship.postingUrl].some((candidate) => canonicalMatches(candidate, urlIdentity))) continue;
    return {
      listingType: "internship",
      listingId: row.id,
      company: internship.company,
      title: internship.title,
      internship,
    };
  }
  return null;
}

async function resolveKnownListing(
  database: DatabaseSync,
  submission: BrowserHelperApplicationSubmission,
  urlIdentity: string,
  readGrindSnapshot: GrindSnapshotReader,
): Promise<ResolvedListing | null> {
  if (submission.listingType && submission.listingId) {
    if (submission.listingType === "internship") {
      const internship = findInternshipById(database, submission.listingId);
      if (!internship) throw new ResumeProfileError(404, "The Scout listing could not be found.");
      return {
        listingType: "internship",
        listingId: submission.listingId,
        company: internship.company,
        title: internship.title,
        internship,
      };
    }
    let board: GrindJobBoardSnapshot;
    try {
      board = await readGrindSnapshot();
    } catch {
      throw new ResumeProfileError(503, "Scout could not verify this live board listing right now.");
    }
    const job = board.jobs.find((candidate) => candidate.id === submission.listingId);
    if (!job) throw new ResumeProfileError(404, "The Scout listing could not be found.");
    const internship = grindJobToInternship(job, GRIND_JOB_BOARD_SOURCE_URL);
    return {
      listingType: "grind",
      listingId: job.id,
      company: job.company,
      title: job.title,
      internship,
    };
  }

  const internshipMatch = findInternshipByUrl(database, urlIdentity);
  if (internshipMatch) return internshipMatch;

  let board: GrindJobBoardSnapshot;
  try {
    board = await readGrindSnapshot();
  } catch {
    return null;
  }
  const job = board.jobs.find((candidate) => canonicalMatches(candidate.link, urlIdentity));
  if (!job) return null;
  return {
    listingType: "grind",
    listingId: job.id,
    company: job.company,
    title: job.title,
    internship: grindJobToInternship(job, GRIND_JOB_BOARD_SOURCE_URL),
  };
}

/** Record a user-confirmed application; this endpoint never interacts with an ATS form. */
export async function recordBrowserHelperApplication(
  databasePath: string,
  userId: string,
  submission: BrowserHelperApplicationSubmission,
  readGrindSnapshot: GrindSnapshotReader,
): Promise<BrowserHelperApplicationResult> {
  if (submission.confirmedSubmitted !== true) {
    throw new ResumeProfileError(400, "Confirm that the application was submitted before recording it.");
  }
  if (Boolean(submission.listingId) !== Boolean(submission.listingType)) {
    throw new ResumeProfileError(400, "listingType and listingId must be provided together.");
  }
  const canonicalUrl = safeApplicationUrl(submission.applicationUrl);
  const urlIdentity = applicationUrlIdentity(submission.applicationUrl);
  if (!existsSync(databasePath)) throw new ResumeProfileError(503, "Scout could not save this application to your tracker. Try again.");
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA busy_timeout = 30000");
    const resolved = await resolveKnownListing(database, submission, urlIdentity, readGrindSnapshot);
    const listingType = resolved?.listingType ?? "internship";
    const listingId = resolved?.listingId ?? `browser-helper-${createUrlIdentity(urlIdentity)}`;
    const listingKey = listingActionKey(listingType, listingId);
    const company = resolved?.company ?? submission.company.trim();
    const title = resolved?.title ?? submission.title.trim();
    const internship = resolved?.internship ?? null;
    const location = submission.location?.trim()
      || (internship?.location.length ? internship.location.join(" · ") : null);
    const postingUrl = internship?.postingUrl ?? canonicalUrl;
    const createdAt = new Date().toISOString();

    database.exec("BEGIN IMMEDIATE");
    try {
      ensureAccountActionSchema(database);
      const existing = database.prepare(`
        SELECT action FROM user_listing_actions
        WHERE user_id = @userId AND listing_key = @listingKey
      `).get({ userId, listingKey }) as { action: string } | undefined;
      const alreadyLogged = existing?.action === "applied";
      database.prepare(`
        INSERT INTO user_listing_actions (
          user_id, listing_key, listing_type, listing_id, action, company, normalized_company, title,
          application_url, posting_url, job_id, location, created_at
        ) VALUES (
          @userId, @listingKey, @listingType, @listingId, 'applied', @company, @normalizedCompany, @title,
          @applicationUrl, @postingUrl, @jobId, @location, @createdAt
        )
        ON CONFLICT(user_id, listing_key) DO UPDATE SET
          action = 'applied',
          company = CASE WHEN user_listing_actions.action = 'applied' THEN user_listing_actions.company ELSE excluded.company END,
          normalized_company = CASE WHEN user_listing_actions.action = 'applied' THEN user_listing_actions.normalized_company ELSE excluded.normalized_company END,
          title = CASE WHEN user_listing_actions.action = 'applied' THEN user_listing_actions.title ELSE excluded.title END,
          application_url = COALESCE(user_listing_actions.application_url, excluded.application_url),
          posting_url = COALESCE(user_listing_actions.posting_url, excluded.posting_url),
          job_id = COALESCE(user_listing_actions.job_id, excluded.job_id),
          location = COALESCE(user_listing_actions.location, excluded.location),
          application_status = CASE
            WHEN user_listing_actions.action <> 'applied' THEN 'pending'
            ELSE user_listing_actions.application_status
          END,
          application_stage = CASE
            WHEN user_listing_actions.action <> 'applied' THEN 'applied'
            ELSE user_listing_actions.application_stage
          END,
          created_at = CASE
            WHEN user_listing_actions.action <> 'applied' THEN excluded.created_at
            ELSE user_listing_actions.created_at
          END
      `).run({
        userId,
        listingKey,
        listingType,
        listingId,
        company,
        normalizedCompany: normalizeCompanyIdentity(company),
        title,
        applicationUrl: canonicalUrl,
        postingUrl,
        jobId: internship?.jobId ?? null,
        location,
        createdAt,
      });
      replaceListingActionIdentities(database, listingKey, listingType, listingId, company, title, internship, {
        applicationUrl: submission.applicationUrl,
        postingUrl,
        jobId: internship?.jobId ?? null,
        location,
      }, userId);
      database.exec("COMMIT");
      return { listingKey, alreadyLogged };
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } catch (error) {
    if (error instanceof ResumeProfileError) throw error;
    throw new ResumeProfileError(503, "Scout could not save this application to your tracker. Try again.");
  } finally {
    database.close();
  }
}

function createUrlIdentity(url: string): string {
  return sha256(url).slice(0, 40);
}
