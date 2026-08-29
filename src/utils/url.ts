const TRACKING_PARAMETERS = new Set([
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "gh_src",
  "source",
  "ref",
  "referrer",
  "tracking",
  "trk",
  "visit",
  "fbclid",
  "gclid",
  "embed",
  "mc_cid",
  "mc_eid",
  "oly_enc_id",
  "oly_anon_id",
  "vero_id",
  "yclid",
  "msclkid",
  "_ga",
  "_gl",
]);

/**
 * Parameters which identify a requisition or a version of a source document.
 * Keep these even when an upstream board also classifies them as a referral
 * parameter.  This list is intentionally narrow: dropping an arbitrary
 * `id`/`key` parameter can collapse two real requisitions.
 */
const IDENTITY_PARAMETERS = new Set([
  "jobid",
  "job_id",
  "gh_jid",
  "reqid",
  "requisitionid",
  "requisition_id",
  "positionid",
  "position_id",
  "postingid",
  "posting_id",
  "externaljobid",
  "external_job_id",
]);

export const canonicalIdentityQueryParameters = IDENTITY_PARAMETERS;

const SENSITIVE_QUERY_PARAMETERS = new Set([
  "token",
  "access_token",
  "auth",
  "authorization",
  "key",
  "api_key",
  "apikey",
  "mcp_token",
  "session",
  "session_id",
  "secret",
  "signature",
  "credential",
]);

const ATS_HOST_PATTERNS = [
  /(^|\.)greenhouse\.io$/i,
  /(^|\.)lever\.co$/i,
  /(^|\.)myworkdayjobs\.com$/i,
  /(^|\.)ashbyhq\.com$/i,
  /(^|\.)smartrecruiters\.com$/i,
  /(^|\.)jobvite\.com$/i,
  /(^|\.)icims\.com$/i,
  /(^|\.)taleo\.net$/i,
  /(^|\.)eightfold\.ai$/i,
  /(^|\.)ripplematch\.com$/i,
];

const AGGREGATOR_HOST_PATTERNS = [
  /(^|\.)applybolt\.app$/i,
  /(^|\.)hiringcafe\.com$/i,
  /(^|\.)interninsider\.me$/i,
  /(^|\.)jobright\.ai$/i,
  /(^|\.)simplify\.jobs$/i,
  /(^|\.)wellfound\.com$/i,
];

export function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function canonicalizeUrl(value: string, base?: string): string {
  const url = base ? new URL(value, base) : new URL(value);
  url.hash = "";
  const hostname = url.hostname.toLocaleLowerCase();
  const githubTransportUrl = /(?:^|\.)github\.com$|(?:^|\.)api\.github\.com$|(?:^|\.)raw\.githubusercontent\.com$/i.test(hostname);
  for (const key of [...url.searchParams.keys()]) {
    const normalizedKey = key.toLocaleLowerCase();
    // `ref` selects a Git branch/tag for GitHub content and is therefore not
    // disposable tracking data.  A referral `ref` on ordinary job boards is
    // intentionally removed.  Known ATS IDs are preserved regardless of
    // their case, while arbitrary parameters remain untouched.
    const requiredIdentity = IDENTITY_PARAMETERS.has(normalizedKey)
      || (githubTransportUrl && normalizedKey === "ref");
    if ((TRACKING_PARAMETERS.has(normalizedKey) && !requiredIdentity) || SENSITIVE_QUERY_PARAMETERS.has(normalizedKey)) {
      // Sensitive query parameters are ephemeral credentials, not part of a
      // source identity. Removing them also prevents them from reaching the
      // database, cache keys, output files, or subsequent browser requests.
      url.searchParams.delete(key);
    }
  }
  url.hostname = hostname;
  if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
    url.port = "";
  }
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  url.searchParams.sort();
  return url.toString();
}

export function safeCanonicalizeUrl(value: string, base?: string): string | null {
  try {
    const url = canonicalizeUrl(value, base);
    return isHttpUrl(url) ? url : null;
  } catch {
    return null;
  }
}

export function isAtsUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return ATS_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

export function isAggregatorUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname;
    return AGGREGATOR_HOST_PATTERNS.some((pattern) => pattern.test(hostname));
  } catch {
    return false;
  }
}

/** A Jobright detail/slug page whose UI can link to the employer's original post. */
export function isJobrightJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(?:^|\.)jobright\.ai$/i.test(url.hostname)
      && /^\/jobs\/[^/]+/i.test(url.pathname);
  } catch {
    return false;
  }
}

/** Any Jobright-hosted URL. Detail-page handling stays in isJobrightJobUrl. */
export function isJobrightUrl(value: string): boolean {
  try {
    return /(?:^|\.)jobright\.ai$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function isLinkedInJobUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return /(^|\.)linkedin\.com$/i.test(url.hostname)
      && /\/jobs(?:-guest)?(?:\/|$)/i.test(url.pathname);
  } catch {
    return false;
  }
}

export function normalizedJobUrl(value: string): string {
  const url = new URL(canonicalizeUrl(value));
  url.pathname = url.pathname.replace(/\/(?:apply|application)\/?$/i, "") || "/";
  return canonicalizeUrl(url.toString());
}

export function organizationTokenFromUrl(value: string): string {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./i, "");
    const pathOrganization = url.pathname.split("/").filter(Boolean)[0] ?? "";
    let token = "";
    if (/myworkdayjobs\.com$/i.test(host)) token = host.split(/\.wd\d*\./i)[0] ?? "";
    else if (/(?:greenhouse\.(?:io|com)|lever\.co|ashbyhq\.com)$/i.test(host)) token = pathOrganization;
    else if (/applytojob\.com$/i.test(host)) token = host.split(".")[0] ?? "";
    else {
      const pieces = host.split(".");
      token = pieces.length >= 2 ? pieces[pieces.length - 2] ?? "" : host;
    }
    return token.toLocaleLowerCase().replace(/[^a-z0-9]+/g, "");
  } catch {
    return "";
  }
}

export function isGithubUrl(value: string): boolean {
  try {
    return /(^|\.)github\.com$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}

export function sameSite(left: string, right: string): boolean {
  try {
    const a = new URL(left).hostname.replace(/^www\./, "");
    const b = new URL(right).hostname.replace(/^www\./, "");
    return a === b || a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
  } catch {
    return false;
  }
}

export function extractJobId(value: string): string | null {
  try {
    const url = new URL(value);
    const parameterKeys = [
      "jobId", "jobid", "job_id", "gh_jid", "reqId", "req_id", "requisitionId", "requisition_id",
      "positionId", "position_id", "postingId", "posting_id", "externalJobId", "external_job_id",
    ];
    const parameter = parameterKeys
      .flatMap((key) => [url.searchParams.get(key), url.searchParams.get(key.toLocaleLowerCase())])
      .find((candidate): candidate is string => Boolean(candidate?.trim()));
    if (parameter) return parameter.trim();

    // Workday frequently embeds the requisition in the final slug rather than
    // exposing a query parameter (for example `_JR-1234`, `_R1234`, or
    // `_RQ225401-1`). The trailing number is often a locale/version suffix,
    // not a different requisition.
    const workdayRequisition = /(?:^|[_-])((?:jr|req|rq|r)[-_]?[a-z0-9]+(?:_[a-z0-9]+)?)(?:[-_]\d+)?$/i.exec(url.pathname.split("/").filter(Boolean).at(-1) ?? "")?.[1];
    if (workdayRequisition) return workdayRequisition;

    // Greenhouse, Lever, and most public ATS routes expose a numeric posting
    // ID in a `/jobs/<id>`/`/positions/<id>` segment.  Keep this before the
    // generic slug fallback so a title slug cannot hide the actual ID.
    const numericSegment = /\/(?:jobs?|positions?|requisitions?|postings?)\/(?:[^/]+\/)?([a-z]?[0-9]{3,})\/?$/i.exec(url.pathname)?.[1];
    if (numericSegment) return numericSegment;

    const patterns = [
      /\/(?:jobs?|positions?|requisitions?)\/(?:[^/]+\/)?([a-z0-9_-]{3,})\/?$/i,
      /\/job\/[^/]+\/([a-z0-9_-]{3,})\/?$/i,
      /\/([jr]?[0-9]{4,})\/?$/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(url.pathname);
      if (match?.[1]) return match[1];
    }
  } catch {
    return null;
  }
  return null;
}

export function hostLabel(value: string): string {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return value;
  }
}

export function redactSensitiveUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|signature|credential|auth|authorization|api[_-]?key|session|(?:^|_)key$)/i.test(key)) {
        url.searchParams.set(key, "[REDACTED]");
      }
    }
    return url.toString();
  } catch {
    return value;
  }
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(/((?:token|access_token|auth(?:orization)?|api[_-]?key|mcp_token|session(?:_id)?|secret|signature)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}
