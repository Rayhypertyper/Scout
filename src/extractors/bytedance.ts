import type { PageSnapshot, RawJob } from "../domain/types.js";
import { normalizeWhitespace, uniqueStrings } from "../utils/text.js";
import { extractJobId } from "../utils/url.js";
import { sectionsFromText } from "./helpers.js";

function isByteDanceCareersUrl(value: string): boolean {
  const url = new URL(value);
  return /(?:^|\.)(?:joinbytedance\.com|jobs\.bytedance\.com|careers\.tiktokusds\.com)$/i.test(url.hostname)
    && /\/(?:search|position)\/\d+(?:\/detail)?\/?$/i.test(url.pathname);
}

function nextValue(lines: string[], label: string): string | undefined {
  const index = lines.findIndex((line) => line.toLocaleLowerCase() === label.toLocaleLowerCase());
  return index >= 0 ? lines[index + 1] : undefined;
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

export function extractByteDanceJob(snapshot: PageSnapshot): RawJob | null {
  if (!isByteDanceCareersUrl(snapshot.url)) return null;
  const text = normalizeWhitespace(snapshot.text);
  const lines = text.split(/\n+/).map((line) => line.trim()).filter(Boolean);
  const isUsds = /(?:^|\.)careers\.tiktokusds\.com$/i.test(new URL(snapshot.url).hostname);
  const locationIndex = lines.findIndex((line) => /^Location:$/i.test(line));
  const title = locationIndex > 0
    ? lines[locationIndex - 1]
    : isUsds
      ? snapshot.title.replace(/\s+-\s+TikTok$/i, "").trim()
      : snapshot.title.trim();
  const usdsLocation = /\n([A-Za-z][A-Za-z .'-]{1,80})(?:Intern|Regular)(?:R&D|Product|Operations|Corporate|Design)/i.exec(text)?.[1];
  const description = between(text, /\nResponsibilities\n/i, /\n(?:About Us|About USDS|Apply to this job|Company\nAbout)\n/i);
  if (!title || description.length < 100 || !/\b(?:intern|co[ -]?op|student)\b/i.test(`${title}\n${description}`)) return null;
  const company = isUsds
    ? "TikTok USDS Joint Venture"
    : "ByteDance";
  const sections = sectionsFromText(description);
  const salary = /(?:hourly rate range|base salary range)[^$]{0,100}(\$[\d,.]+\s*(?:-|–|to)\s*\$?[\d,.]+[^\n.]*)/i
    .exec(text)?.[1]?.replace(/[.\s]+$/, "");
  return {
    company,
    title,
    locations: nextValue(lines, "Location:")
      ? [nextValue(lines, "Location:") ?? ""]
      : (usdsLocation ? [usdsLocation] : []),
    description,
    ...sections,
    requiredQualifications: listBetween(description, /\nMinimum Qualifications?(?:\(s\))?:?\s*\n/i, /\nPreferred Qualifications?(?:\(s\))?:?|\nJob Information/i),
    preferredQualifications: listBetween(description, /\nPreferred Qualifications?(?:\(s\))?:?\s*\n/i, /\n(?:By submitting an application|Job Information)/i),
    applicationUrl: snapshot.url,
    postingUrl: snapshot.url,
    jobId: nextValue(lines, "Job Code:") ?? /Job ID:\s*([A-Z0-9]+)/i.exec(text)?.[1] ?? extractJobId(snapshot.url) ?? undefined,
    salary,
    sourceProvider: "bytedance-careers",
  };
}
