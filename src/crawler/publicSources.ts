import { canonicalizeUrl, sameSite } from "../utils/url.js";

export interface PublicSourceFallback {
  url: string;
  reason: string;
}

export type KnownSourceStrategy = "github_api" | "greenhouse_api" | "lever_api" | "workday_http" | "static_http" | "browser_required";

/** The saved project URL redirects to this canonical Early Career Radar host. */
const EARLY_CAREER_RADAR_CANONICAL_HOST = "earlycareerradar.com";
const EARLY_CAREER_RADAR_REDIRECT_HOST = "internship-radar-2027.yuxhuang.com";

function earlyCareerRadarHost(value: string): string | null {
  try {
    const host = new URL(canonicalizeUrl(value)).hostname.replace(/^www\./i, "");
    return host === EARLY_CAREER_RADAR_CANONICAL_HOST || host === EARLY_CAREER_RADAR_REDIRECT_HOST ? host : null;
  } catch {
    return null;
  }
}

export function isEarlyCareerRadarSource(sourceUrl: string): boolean {
  try {
    const url = new URL(canonicalizeUrl(sourceUrl));
    const host = url.hostname.replace(/^www\./i, "");
    const listingPath = url.pathname.replace(/\/+$/, "") || "/";
    return (host === EARLY_CAREER_RADAR_CANONICAL_HOST && listingPath === "/summer-internships")
      || (host === EARLY_CAREER_RADAR_REDIRECT_HOST && (listingPath === "/" || listingPath === "/summer-internships"));
  } catch {
    return false;
  }
}

export function isCsJobsTorontoSource(sourceUrl: string): boolean {
  try {
    const url = new URL(canonicalizeUrl(sourceUrl));
    const host = url.hostname.replace(/^www\./i, "");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return host === "csjobs.ca" && path === "/internships/toronto";
  } catch {
    return false;
  }
}

export function isHiringCafeSource(sourceUrl: string): boolean {
  try {
    return new URL(canonicalizeUrl(sourceUrl)).hostname.replace(/^www\./i, "") === "hiringcafe.com";
  } catch {
    return false;
  }
}

/** Treat the redirect and canonical hosts as one crawl boundary. */
export function earlyCareerRadarSameSite(left: string, right: string): boolean {
  if (sameSite(left, right)) return true;
  return earlyCareerRadarHost(left) !== null && earlyCareerRadarHost(right) !== null;
}

/**
 * Return the preferred deterministic transport for a known source. This is a
 * pure routing hint; callers must still enforce robots.txt and treat a failed
 * structured endpoint as eligible for the next lower-cost strategy.
 */
export function knownSourceStrategy(sourceUrl: string): KnownSourceStrategy {
  try {
    const url = new URL(canonicalizeUrl(sourceUrl));
    const host = url.hostname.replace(/^www\./i, "");
    if (host === "github.com") return "github_api";
    if (/(?:^|\.)boards\.greenhouse\.(?:io|com)$/i.test(host)) return "greenhouse_api";
    if (/(?:^|\.)jobs\.lever\.co$/i.test(host)) return "lever_api";
    if (/myworkdayjobs\.com$/i.test(host)) return "workday_http";
    if (PROBE_STATIC_HOSTS.some((pattern) => pattern.test(host))) return "static_http";
  } catch {
    return "browser_required";
  }
  return "browser_required";
}

const PROBE_STATIC_HOSTS = [
  /(?:^|\.)applybolt\.app$/i,
  /(?:^|\.)hiringcafe\.com$/i,
  /(?:^|\.)interninsider\.me$/i,
  /(?:^|\.)wellfound\.com$/i,
  /(?:^|\.)csjobs\.ca$/i,
];

/**
 * Returns a public, equivalent entry point for sources whose configured page
 * is commonly blocked or rate-limited. These are deliberately fixed public
 * documents/routes; the crawler still checks robots.txt before fetching them.
 */
export function publicSourceFallbacks(sourceUrl: string): PublicSourceFallback[] {
  const url = new URL(canonicalizeUrl(sourceUrl));
  const host = url.hostname.replace(/^www\./i, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (host === "github.com") {
    const parts = path.split("/").filter(Boolean);
    const owner = parts[0]?.toLocaleLowerCase();
    const repository = parts[1]?.toLocaleLowerCase();
    if (owner === "hanzili" && repository === "canada_sde_intern_position") {
      return [{
        url: "https://raw.githubusercontent.com/hanzili/canada_sde_intern_position/main/README.md",
        reason: "the repository's public raw README",
      }];
    }
    if (owner === "speedyapply" && repository === "2027-swe-college-jobs") {
      return [{
        url: "https://raw.githubusercontent.com/speedyapply/2027-SWE-College-Jobs/main/INTERN_INTL.md",
        reason: "the repository's public raw international internship list",
      }];
    }
    if (owner === "vanshb03" && repository === "summer2027-internships") {
      return [{
        url: "https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/dev/README.md",
        reason: "the repository's public raw README on its published branch",
      }];
    }
  }

  if (host === "csjobs.ca" && /^\/internships\/toronto$/i.test(path)) {
    return [{
      url: "https://csjobs.ca/jobs",
      reason: "CSJobs' public all-jobs route linked from the listing page",
    }];
  }

  if (host === "applybolt.app" && path === "/jobs/2027-all-internships") {
    return [{
      url: "https://www.applybolt.app/jobs/2027-internships",
      reason: "ApplyBolt's public 2027 internships route",
    }];
  }

  if (host === "hiringcafe.com" && path === "/") {
    return [
      {
        url: "https://hiringcafe.com/jobs/canada",
        reason: "HiringCafe's public Canada search route",
      },
      {
        url: "https://hiringcafe.com/jobs/united-states",
        reason: "HiringCafe's public United States search route",
      },
    ];
  }

  return [];
}

export function publicSourceFallback(sourceUrl: string): PublicSourceFallback | null {
  return publicSourceFallbacks(sourceUrl)[0] ?? null;
}

export function largeListingSourcePageFloor(sourceUrl: string): number | null {
  const url = new URL(canonicalizeUrl(sourceUrl));
  const host = url.hostname.replace(/^www\./i, "");
  const path = url.pathname.replace(/\/+$/, "") || "/";

  // Keep complete public listing expansions within their known source bounds
  // when browser fallback is required instead of truncating them at the
  // ordinary per-source page ceiling.
  if (isEarlyCareerRadarSource(sourceUrl)) return 2_000;
  if (host === "wellfound.com" && /^\/location\/canada-startups$/i.test(path)) return 2_000;
  if (host === "csjobs.ca" && (/^\/internships\/toronto$/i.test(path) || path === "/jobs")) return 450;
  if (host === "applybolt.app" && /^\/jobs\/2027(?:-all)?-internships$/i.test(path)) return 5_000;
  if (host === "hiringcafe.com" && (path === "/" || /^\/jobs\/(?:canada|united-states)$/i.test(path))) return 4_000;
  return null;
}
