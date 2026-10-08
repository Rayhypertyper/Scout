import { canonicalizeUrl } from "../utils/url.js";

export const ZSHAH_REPOSITORY_URL = "https://github.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships";
export const ZSHAH_README_URL = `${ZSHAH_REPOSITORY_URL}/blob/main/README.md`;
export const ZSHAH_DASHBOARD_URL = "https://zshah101.github.io/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships/";
/** Public JSON export linked by both the dashboard and README. */
export const ZSHAH_JOBS_URL = `${ZSHAH_DASHBOARD_URL}api/jobs.json`;

/** One scheduled source for the published dashboard and its README fallback. */
export function isZshahSource(sourceUrl: string): boolean {
  try {
    const canonical = canonicalizeUrl(sourceUrl);
    return [ZSHAH_REPOSITORY_URL, ZSHAH_README_URL, ZSHAH_DASHBOARD_URL]
      .some((url) => canonicalizeUrl(url) === canonical);
  } catch {
    return false;
  }
}

export function configuredSourceUrl(sourceUrl: string): string {
  return canonicalizeUrl(isZshahSource(sourceUrl) ? ZSHAH_DASHBOARD_URL : sourceUrl);
}
