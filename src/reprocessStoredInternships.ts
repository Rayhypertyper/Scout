import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { internshipContentHash } from "./classification/analyzeJob.js";
import { directApplicationOverride } from "./config/directApplicationOverrides.js";
import { MIN_LISTING_SCORE } from "./config/thresholds.js";
import { classifyRole, detectInternship } from "./classification/roleClassifier.js";
import { InternshipSchema } from "./domain/schemas.js";
import { companyFromEvidence, companyFromUrl } from "./extractors/helpers.js";
import { containsExplicitDate, extractTemporalDetails, sanitizePostingDate } from "./parsing/dates.js";
import { extractJobSections, extractQualificationDetails, extractRequirementDetails } from "./parsing/qualifications.js";
import { extractWorkAuthorization } from "./parsing/workAuthorization.js";
import { parseLocations } from "./parsing/locations.js";
import { decodeHtmlEntities, normalizeCompanyIdentity, normalizeRoleIdentity, uniqueStrings } from "./utils/text.js";
import { canonicalizeUrl, isAggregatorUrl } from "./utils/url.js";

interface InternshipRow {
  id: string;
  payload_json: string;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { database: { type: "string", default: "output/live/internships.db" } },
  });
  const database = new DatabaseSync(values.database);
  let changed = 0;
  database.exec("BEGIN IMMEDIATE");
  try {
    database.prepare(`
      DELETE FROM internships
      WHERE CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) < @minimumScore
    `).run({ minimumScore: MIN_LISTING_SCORE });
    const rows = database.prepare("SELECT id, payload_json FROM internships").all() as unknown as InternshipRow[];
    const update = database.prepare(`
      UPDATE internships
      SET company = @company, normalized_company = @normalizedCompany,
          title = @title, normalized_title = @normalizedTitle,
          posting_url = @postingUrl, payload_json = @payload, content_hash = @contentHash
      WHERE id = @id
    `);
    for (const row of rows) {
      const internship = InternshipSchema.parse(JSON.parse(row.payload_json));
      const temporal = extractTemporalDetails(internship.description, internship.title);
      const sections = extractJobSections(internship.description);
      // Reprocessing is allowed to improve extraction, but it must not erase
      // facts that were already recovered by an older parser.
      const responsibilities = uniqueStrings([...internship.responsibilities, ...sections.responsibilities]);
      const requiredQualifications = uniqueStrings([...internship.requiredQualifications, ...sections.requiredQualifications]);
      const preferredQualifications = uniqueStrings([...internship.preferredQualifications, ...sections.preferredQualifications]);
      const qualificationText = [
        ...requiredQualifications,
        ...preferredQualifications,
        ...internship.workAuthorizationRequirements,
        internship.sponsorshipInformation ?? "",
        ...(internship.qualificationDetails?.evidence ?? []),
      ].join("\n");
      const classificationDescription = `${responsibilities.join("\n")}\n${internship.description}`;
      const detection = detectInternship(internship.title, classificationDescription, qualificationText);
      const classification = classifyRole(
        internship.title,
        classificationDescription,
        qualificationText,
        [internship.internshipTerm, internship.internshipYear, internship.duration].filter(Boolean).join("\n"),
      );
      const requirementDetails = extractRequirementDetails(`${qualificationText}\n${internship.description}`);
      const authorization = extractWorkAuthorization(`${qualificationText}\n${internship.description}`);
      const verifiedPostingOverride = directApplicationOverride(internship.postingUrl);
      const postingUrl = verifiedPostingOverride
        ? canonicalizeUrl(verifiedPostingOverride)
        : isAggregatorUrl(internship.postingUrl) && !isAggregatorUrl(internship.applicationUrl)
          ? internship.applicationUrl
          : internship.postingUrl;
      const qualificationDetails = extractQualificationDetails(`${qualificationText}\n${internship.description}`, {
        applicationUrl: internship.applicationUrl,
        deadline: internship.deadline,
      });
      const rawLocations = /(?:^|\.)useno\.app\/internship-masterlist(?:\/|$)/i.test(internship.sourceUrl)
        ? internship.location.slice(0, 1)
        : internship.location;
      const preserveUsenoSourceLocation = /(?:^|\.)useno\.app\/internship-masterlist(?:\/|$)/i.test(internship.sourceUrl);
      const parsedLocations = parseLocations(rawLocations, internship.description);
      const title = decodeHtmlEntities(internship.title);
      const next = InternshipSchema.parse({
        ...internship,
        postingUrl,
        company: companyFromEvidence(
          internship.company,
          internship.description,
          companyFromUrl(internship.applicationUrl),
        ),
        title,
        responsibilities,
        requiredQualifications,
        preferredQualifications,
        technologies: classification.technologies,
        educationRequirements: requirementDetails.education,
        graduationRequirements: requirementDetails.graduation,
        experienceRequirements: requirementDetails.experience,
        workAuthorizationRequirements: authorization.requirements,
        sponsorshipInformation: authorization.sponsorshipInformation,
        qualificationDetails,
        ...(parsedLocations.raw.length > 0 ? {
          location: preserveUsenoSourceLocation ? rawLocations : parsedLocations.raw,
          normalizedLocations: parsedLocations.normalized,
          remoteStatus: parsedLocations.remoteStatus,
        } : {}),
        internshipTerm: temporal.internshipTerm ?? internship.internshipTerm,
        internshipYear: temporal.internshipYear ?? internship.internshipYear,
        duration: temporal.duration ?? internship.duration,
        postingDate: sanitizePostingDate(internship.postingDate, temporal.postingDate),
        deadline: internship.deadline && containsExplicitDate(internship.deadline)
          ? internship.deadline
          : temporal.deadline,
        categories: classification.categories,
        relevanceScore: classification.score,
        relevanceReason: `${classification.reason} ${detection.reason}`,
      });
      const payload = JSON.stringify(next);
      if (payload === row.payload_json) continue;
      update.run({
        id: row.id,
        company: next.company,
        normalizedCompany: normalizeCompanyIdentity(next.company),
        title: next.title,
        normalizedTitle: normalizeRoleIdentity(next.title),
        postingUrl: next.postingUrl,
        payload,
        contentHash: internshipContentHash(next),
      });
      changed += 1;
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  } finally {
    database.close();
  }
  process.stdout.write(`${JSON.stringify({ reprocessed: changed })}\n`);
}

await main();
