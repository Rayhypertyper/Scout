import type { PageSnapshot, RawJob } from "../domain/types.js";
import { normalizeWhitespace, uniqueStrings } from "../utils/text.js";
import { extractJobId } from "../utils/url.js";
import { companyFromEvidence, companyFromUrl, sectionsFromText } from "./helpers.js";

function isOracleHcmDetail(value: string): boolean {
  const url = new URL(value);
  return /(?:^|\.)oraclecloud\.com$/i.test(url.hostname)
    && /\/hcmUI\/CandidateExperience\/[^?#]+\/job\/[^/]+(?:\/[^/]+)?\/?$/i.test(url.pathname);
}

function between(text: string, start: RegExp, end: RegExp): string {
  const startMatch = start.exec(text);
  if (!startMatch) return "";
  const remainder = text.slice(startMatch.index + startMatch[0].length);
  const endMatch = end.exec(remainder);
  return (endMatch ? remainder.slice(0, endMatch.index) : remainder).trim();
}

function listBetween(text: string, start: RegExp, end: RegExp): string[] {
  return uniqueStrings(between(text, start, end).split(/\n+/));
}

export function extractOracleHcmJob(snapshot: PageSnapshot): RawJob | null {
  if (!isOracleHcmDetail(snapshot.url)) return null;
  const text = normalizeWhitespace(snapshot.text);
  const header = between(text, /(?:^|\n)View More Jobs\n/i, /\n(?:APPLY NOW|JOB INFORMATION|JOB DESCRIPTION)\n/i).split(/\n+/).filter(Boolean);
  const headerTitle = header.find((line) => !/^(?:trending|[A-Z][a-z]+(?:, [A-Z]{2})?, .+)$/i.test(line));
  const title = headerTitle ?? snapshot.title.replace(/\s+-\s+.+ Careers(?: loaded)?$/i, "").trim();
  const location = header.find((line) => line !== title && !/^trending$/i.test(line));
  const detailedLocations = listBetween(text, /\nLocations\n/i, /\n(?:Apply Before|Job Schedule|Base Pay\/Salary|JOB DESCRIPTION)\n/i)
    .filter((line) => !/:$|\b(?:locations? you may join|job information)\b/i.test(line));
  const description = between(text, /\nJOB DESCRIPTION\n/i, /\n(?:ABOUT US|APPLY NOW|JOB INFO)\n/i);
  if (!title || description.length < 100 || !/\b(?:intern(?:ship)?|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const siteCompany = snapshot.title.startsWith(`${title} - `)
    ? snapshot.title.slice(title.length + 3).replace(/\s+Careers(?: loaded)?$/i, "")
    : "";
  const cleanedSiteCompany = siteCompany
    .replace(/\s+Candidate Experience page$/i, "")
    .replace(/^JPMC$/i, "JPMorganChase");
  const sections = sectionsFromText(description);
  const requiredQualifications = listBetween(
    description,
    /\nWe are looking for the following:\s*\n/i,
    /\nDesired Skills(?: \(Nice-to-have\))?:\s*\n/i,
  );
  const preferredQualifications = listBetween(
    description,
    /\nDesired Skills(?: \(Nice-to-have\))?:\s*\n/i,
    /\nInternship duration/i,
  );
  return {
    company: companyFromEvidence(cleanedSiteCompany, description, companyFromUrl(snapshot.url)),
    title,
    locations: detailedLocations.length > 0 ? detailedLocations : (location ? [location] : []),
    description,
    ...sections,
    requiredQualifications: requiredQualifications.length > 0 ? requiredQualifications : sections.requiredQualifications,
    preferredQualifications: preferredQualifications.length > 0 ? preferredQualifications : sections.preferredQualifications,
    responsibilities: listBetween(description, /\nSome areas of interest are:\s*\n/i, /\nWe are looking for the following:/i),
    applicationUrl: snapshot.url,
    postingUrl: snapshot.url,
    jobId: /\nJob Identification\n([^\n]+)/i.exec(text)?.[1]?.trim() ?? extractJobId(snapshot.url) ?? undefined,
    postingDate: /\nPosting Date\n([^\n]+)/i.exec(text)?.[1]?.trim(),
    deadline: /\nApply Before\n([^\n]+)/i.exec(text)?.[1]?.trim(),
    salary: between(text, /\nBase Pay\/Salary\n/i, /\nJOB DESCRIPTION\n/i)
      || /(?:expected pay range|hourly range)[^$]{0,100}(\$[\d,.]+\s*(?:-|–|to)\s*\$?[\d,.]+\s*\/\s*hour(?:ly)?)/i.exec(description)?.[1],
    sourceProvider: "oracle-hcm",
  };
}
