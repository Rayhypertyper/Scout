import type { UsenoMasterlistListing } from "../extractors/useno.js";
import { normalizeCompanyIdentity } from "../utils/text.js";
import { extractJobId, isAggregatorUrl, normalizedJobUrl, safeCanonicalizeUrl, sameSite } from "../utils/url.js";
import { currentSourceAbortSignal, throwIfAborted } from "../domain/cancellation.js";
import { Semaphore } from "../utils/async.js";
import type { HttpClient } from "./http.js";
import { load } from "cheerio";

export interface UsenoApplicationCandidate {
  company: string;
  applicationUrl: string;
  availabilityStatus?: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function string(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

function employerUrl(value: unknown): string | null {
  const url = typeof value === "string" && value.trim() ? safeCanonicalizeUrl(value) : null;
  return url && !isAggregatorUrl(url) && !sameSite(url, "https://www.useno.app") ? url : null;
}

function providerMatches(provider: string, url: URL): boolean {
  const domains: Record<string, string> = {
    greenhouse: "greenhouse.io", ashby: "ashbyhq.com", lever: "lever.co",
    workday: "myworkdayjobs.com", icims: "icims.com", "oracle-orc": "oraclecloud.com",
    smartrecruiters: "smartrecruiters.com", workable: "workable.com", bamboohr: "bamboohr.com", adp: "adp.com",
  };
  const domain = domains[provider];
  return Boolean(domain && (url.hostname === domain || url.hostname.endsWith(`.${domain}`)));
}

/** Match exact requisitions within one employer and ATS; short numeric IDs collide globally. */
export function matchUsenoKnownApplication(listing: UsenoMasterlistListing, candidates: UsenoApplicationCandidate[]): string | null {
  const [provider, , ...parts] = listing.sourceJobId?.split(":") ?? [];
  const requisition = parts.join(":");
  if (!provider || !requisition) return null;
  const matches = candidates.flatMap((candidate) => {
    if (candidate.availabilityStatus === "closed") return [];
    const url = employerUrl(candidate.applicationUrl);
    if (!url || !providerMatches(provider, new URL(url))) return [];
    if (normalizeCompanyIdentity(candidate.company) !== normalizeCompanyIdentity(listing.company)) return [];
    const parsed = new URL(url);
    const escaped = requisition.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const exactPathId = new RegExp(`(?:^|[/_])${escaped}(?:$|[/_])`, "i").test(decodeURIComponent(parsed.pathname));
    const exactQueryId = [...parsed.searchParams.values()].some((value) => value.toLowerCase() === requisition.toLowerCase());
    const extracted = extractJobId(url)?.toLowerCase() === requisition.toLowerCase();
    return exactPathId || exactQueryId || extracted ? [url] : [];
  });
  const distinct = new Set(matches.map(normalizedJobUrl));
  return distinct.size === 1 ? matches[0] ?? null : null;
}

/** Recover links only from exact saved identities or current public employer API responses. */
export class UsenoApplicationResolver {
  private readonly byCompany = new Map<string, UsenoApplicationCandidate[]>();
  private readonly requests = new Map<string, Promise<unknown>>();
  private readonly lane = new Semaphore(6);

  public constructor(private readonly http: HttpClient, candidates: UsenoApplicationCandidate[] = []) {
    for (const candidate of candidates) {
      if (!employerUrl(candidate.applicationUrl)) continue;
      const key = normalizeCompanyIdentity(candidate.company);
      const rows = this.byCompany.get(key) ?? [];
      rows.push(candidate);
      this.byCompany.set(key, rows);
    }
  }

  public async resolve(listing: UsenoMasterlistListing): Promise<UsenoMasterlistListing> {
    if (!sameSite(listing.applicationUrl, "https://www.useno.app")) return listing;
    const candidates = this.byCompany.get(normalizeCompanyIdentity(listing.company)) ?? [];
    const known = matchUsenoKnownApplication(listing, candidates);
    if (known) return { ...listing, applicationUrl: known };
    return this.lane.use(async () => {
      throwIfAborted(currentSourceAbortSignal());
      const recovered = await this.lookup(listing, candidates);
      return recovered ? { ...listing, applicationUrl: recovered } : listing;
    }, currentSourceAbortSignal());
  }

  private async json(url: string, body?: unknown): Promise<unknown> {
    const key = `${url}\n${body === undefined ? "" : JSON.stringify(body)}`;
    let pending = this.requests.get(key);
    if (!pending) {
      pending = (async (): Promise<unknown> => {
        try {
          const options = { cache: true, timeoutMs: 12_000, retryCount: 0, headers: { accept: "application/json" } };
          const response = body === undefined ? await this.http.get(url, options) : await this.http.postJson(url, body, options);
          if (response.status !== 200 || response.stale) return null;
          return JSON.parse(response.body) as unknown;
        } catch {
          throwIfAborted(currentSourceAbortSignal());
          return null;
        }
      })();
      this.requests.set(key, pending);
    }
    return pending;
  }

  private async lookup(listing: UsenoMasterlistListing, candidates: UsenoApplicationCandidate[]): Promise<string | null> {
    const [provider, tenant, ...parts] = listing.sourceJobId?.split(":") ?? [];
    const id = parts.join(":");
    if (!provider || !tenant || !id || !/^[a-z0-9-]+$/i.test(tenant)) return null;
    if (provider === "workday") return this.workday(id, listing.title, candidates);
    if (provider === "icims") return this.icims(id, listing.title, candidates);
    if (provider === "oracle-orc") return this.oracle(id, candidates);
    const tenants = new Set<string>();
    for (const candidate of candidates) {
      const url = new URL(candidate.applicationUrl);
      if (!providerMatches(provider, url)) continue;
      const token = url.pathname.split("/").filter(Boolean)[0];
      if (token && /^[a-z0-9_-]+$/i.test(token)) tenants.add(token);
    }
    tenants.add(tenant);
    tenants.add(tenant.replaceAll("-", ""));
    for (const token of [...tenants].slice(0, 3)) {
      if (provider === "greenhouse") {
        const data = record(await this.json(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(token)}/jobs`));
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        const job = jobs.map(record).find((job) => string(job?.id) === id);
        const url = employerUrl(job?.absolute_url);
        if (url) return url;
      } else if (provider === "ashby") {
        const data = record(await this.json(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(token)}`));
        const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
        for (const value of jobs) {
          const job = record(value);
          const url = employerUrl(job?.applyUrl) ?? employerUrl(job?.jobUrl);
          if (url && new URL(url).pathname.split("/").includes(id)) return url;
        }
      } else if (provider === "lever") {
        const job = record(await this.json(`https://api.lever.co/v0/postings/${encodeURIComponent(token)}/${encodeURIComponent(id)}?mode=json`));
        const url = employerUrl(job?.applyUrl) ?? employerUrl(job?.hostedUrl);
        if (string(job?.id) === id && url) return url;
      } else if (provider === "workable") {
        const job = record(await this.json(`https://apply.workable.com/api/v2/accounts/${encodeURIComponent(token)}/jobs/${encodeURIComponent(id)}`));
        if (string(job?.shortcode) === id) return `https://apply.workable.com/${encodeURIComponent(token)}/j/${encodeURIComponent(id)}/`;
      } else if (provider === "smartrecruiters") {
        const job = record(await this.json(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(token)}/postings/${encodeURIComponent(id)}`));
        const url = employerUrl(job?.applyUrl) ?? employerUrl(job?.postingUrl);
        if (url && (string(job?.id) === id || new URL(url).pathname.split("/").some((part) => part === id || part.startsWith(`${id}-`)))) return url;
        const company = record(job?.company);
        if (string(job?.id) === id && string(company?.identifier)) return `https://jobs.smartrecruiters.com/${encodeURIComponent(string(company?.identifier))}/${encodeURIComponent(id)}`;
      }
    }
    return null;
  }

  private async icims(id: string, title: string, candidates: UsenoApplicationCandidate[]): Promise<string | null> {
    const origins = new Set(candidates.filter((candidate) => providerMatches("icims", new URL(candidate.applicationUrl))).map((candidate) => new URL(candidate.applicationUrl).origin));
    for (const origin of [...origins].slice(0, 2)) {
      const url = `${origin}/jobs/${encodeURIComponent(id)}/job`;
      try {
        const response = await this.http.get(url, { cache: true, timeoutMs: 12_000, retryCount: 0 });
        if (response.status !== 200 || !response.url.includes(`/jobs/${id}/`)) continue;
        const $ = load(response.body);
        const titles = $("script[type='application/ld+json']").toArray().flatMap((element) => {
          try {
            const data: unknown = JSON.parse($(element).text());
            return (Array.isArray(data) ? data : [data]).map(record).filter((job) => job?.["@type"] === "JobPosting").map((job) => string(job?.title));
          } catch { return []; }
        });
        const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
        if (titles.some((value) => clean(value) === clean(title))) return url;
      } catch { throwIfAborted(currentSourceAbortSignal()); }
    }
    return null;
  }

  private async oracle(id: string, candidates: UsenoApplicationCandidate[]): Promise<string | null> {
    const boards = new Map<string, URL>();
    for (const candidate of candidates) {
      const url = new URL(candidate.applicationUrl);
      if (providerMatches("oracle-orc", url) && /\/sites\/[^/]+\/job\//.test(url.pathname)) boards.set(url.origin, url);
    }
    for (const url of [...boards.values()].slice(0, 2)) {
      const job = record(await this.json(`${url.origin}/hcmRestApi/resources/latest/recruitingCEJobRequisitions/${encodeURIComponent(id)}?onlyData=true`));
      if (string(job?.Id) !== id && string(job?.RequisitionNumber) !== id) continue;
      if (!string(job?.Title)) continue;
      url.pathname = url.pathname.replace(/\/job\/[^/]+\/?$/, `/job/${encodeURIComponent(id)}`);
      url.search = "";
      return url.href;
    }
    return null;
  }

  private async workday(id: string, title: string, candidates: UsenoApplicationCandidate[]): Promise<string | null> {
    const boards = new Map<string, { origin: string; tenant: string; site: string }>();
    for (const candidate of candidates) {
      const url = new URL(candidate.applicationUrl);
      if (!providerMatches("workday", url)) continue;
      const parts = url.pathname.split("/").filter(Boolean);
      const jobIndex = parts.indexOf("job");
      const site = (jobIndex < 0 ? parts : parts.slice(0, jobIndex)).find((part) => !/^[a-z]{2}-[a-z]{2}$/i.test(part));
      const tenant = url.hostname.split(".")[0];
      if (site && tenant) boards.set(`${url.origin}/${site}`, { origin: url.origin, tenant, site });
    }
    for (const { origin, tenant, site } of [...boards.values()].slice(0, 2)) {
      for (const searchText of [id, title]) {
        const data = record(await this.json(`${origin}/wday/cxs/${encodeURIComponent(tenant)}/${encodeURIComponent(site)}/jobs`, {
          appliedFacets: {}, limit: 20, offset: 0, searchText,
        }));
        if (!data) break;
        const postings = Array.isArray(data.jobPostings) ? data.jobPostings : [];
        for (const value of postings) {
          const posting = record(value);
          const externalPath = string(posting?.externalPath);
          if (!externalPath.startsWith("/job/")) continue;
          const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const exactId = new RegExp(`_${escapedId}(?:[_-]\\d+)?$`, "i").test(externalPath);
          const url = new URL(`/${encodeURIComponent(site)}${externalPath}`, origin).href;
          if (exactId || extractJobId(url)?.toLowerCase() === id.toLowerCase()) return url;
        }
      }
    }
    return null;
  }
}
