import type { PageSnapshot, RawJob } from "../domain/types.js";
import { oneLine } from "../utils/text.js";
import { safeCanonicalizeUrl } from "../utils/url.js";

function text(value: unknown): string {
  return typeof value === "string" ? oneLine(value) : "";
}

/** The dashboard export is ungrouped, unlike its capped HTML/README tables. */
export function extractZshahDashboardInventory(snapshot: PageSnapshot): { jobs: RawJob[]; complete: boolean } {
  let payload: { count?: unknown; jobs?: unknown };
  try {
    const value: unknown = JSON.parse(snapshot.text);
    if (!value || typeof value !== "object" || Array.isArray(value)) return { jobs: [], complete: false };
    payload = value;
  } catch {
    return { jobs: [], complete: false };
  }
  if (!Array.isArray(payload.jobs)) return { jobs: [], complete: false };
  const jobs: RawJob[] = [];
  for (const value of payload.jobs) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const company = text(row.company);
    const title = text(row.title);
    const applicationUrl = safeCanonicalizeUrl(text(row.url), snapshot.url);
    if (!company || !title || !text(row.url) || !applicationUrl || !/^https?:/i.test(applicationUrl)) continue;
    const location = text(row.location);
    const salary = text(row.salary);
    const cycle = row.season_inferred === false && text(row.season) !== "Not stated" ? text(row.season) : "";
    const skills = Array.isArray(row.skills) ? row.skills.map(text).filter(Boolean) : [];
    const sponsorship = row.sponsorship === "citizens-only" ? "Requires U.S. citizenship."
      : row.sponsorship === "no-sponsorship" ? "Work visa sponsorship is not available."
        : row.sponsorship === "offers" ? "The posting states that visa sponsorship is offered." : "";
    const description = [
      `Role: ${title}.`, `Company: ${company}.`,
      location ? `Location: ${location}.` : "",
      cycle ? `List section: ${cycle}.` : "",
      skills.length > 0 ? `Skills: ${skills.join(", ")}.` : "",
      salary ? `Salary: ${salary}.` : "", sponsorship,
    ].filter(Boolean).join(" ");
    jobs.push({
      company, title, locations: location ? [location] : [], description,
      applicationUrl, postingUrl: applicationUrl,
      ...(text(row.id) ? { jobId: text(row.id) } : {}),
      ...(salary ? { salary } : {}),
      ...(text(row.posted_at) ? { postingDate: text(row.posted_at) } : {}),
      sourceProvider: "zshah-dashboard",
    });
  }
  return {
    jobs,
    complete: Number.isSafeInteger(payload.count) && payload.count === payload.jobs.length && jobs.length === payload.jobs.length,
  };
}
