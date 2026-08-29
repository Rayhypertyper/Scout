import { describe, expect, it } from "vitest";

import { canonicalizeUrl, extractJobId, isAggregatorUrl, isAtsUrl, isCompanyLandingUrl, isJobrightJobUrl, isJobrightUrl, isLinkedInJobUrl, normalizedJobUrl, redactSensitiveText, redactSensitiveUrl } from "../src/utils/url.js";

describe("URL normalization", () => {
  it("removes fragments, trailing slashes, and tracking parameters", () => {
    expect(canonicalizeUrl("https://Example.com/jobs/123/?utm_source=list&gh_src=abc&visit=related-role#apply"))
      .toBe("https://example.com/jobs/123");
  });

  it("preserves non-tracking parameters", () => {
    expect(canonicalizeUrl("https://example.com/search?query=software&page=2"))
      .toBe("https://example.com/search?page=2&query=software");
    expect(canonicalizeUrl("https://boards.greenhouse.io/acme?gh_jid=987654&utm_source=list"))
      .toBe("https://boards.greenhouse.io/acme?gh_jid=987654");
    expect(canonicalizeUrl("https://example.com/jobs?jobId=123&utm_source=list&ref=partner"))
      .toBe("https://example.com/jobs?jobId=123");
    expect(canonicalizeUrl("https://github.com/acme/internships/blob/main/README.md?ref=summer&utm_source=list"))
      .toBe("https://github.com/acme/internships/blob/main/README.md?ref=summer");
  });

  it("recognizes ATS hosts and job IDs", () => {
    expect(isAtsUrl("https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Intern_R1234")).toBe(true);
    expect(extractJobId("https://boards.greenhouse.io/acme/jobs/987654")).toBe("987654");
    expect(extractJobId("https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Intern_RQ225401")).toBe("RQ225401");
    expect(extractJobId("https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Intern_RQ225401-1")).toBe("RQ225401");
    expect(extractJobId("https://acme.wd5.myworkdayjobs.com/jobs/job/Toronto/Intern_R26_4907")).toBe("R26_4907");
    expect(isAtsUrl("https://simplify.jobs/p/example/job")).toBe(false);
    expect(isAggregatorUrl("https://simplify.jobs/p/example/job")).toBe(true);
    expect(isCompanyLandingUrl("https://www.dreamworkhq.com/c/southstatebank.com")).toBe(true);
    expect(isCompanyLandingUrl("https://www.dreamworkhq.com/job/613e0503-940a-456d-b9b1-c01ee630c494")).toBe(false);
    expect(isJobrightUrl("https://jobright.ai/minisites-jobs/intern/us/swe?embed=true")).toBe(true);
    expect(isJobrightJobUrl("https://jobright.ai/jobs/info/abc123?visit=related-role")).toBe(true);
    expect(isJobrightJobUrl("https://jobright.ai/jobs/software-engineer-intern-jobs-in-united-states")).toBe(true);
    expect(isJobrightJobUrl("https://swan-api.jobright.ai/swan/mini-sites/list")).toBe(false);
    expect(isJobrightJobUrl("https://jobright.ai/minisites-jobs/intern/us/swe?embed=true")).toBe(false);
    expect(normalizedJobUrl("https://jobs.ashbyhq.com/acme/abc/application"))
      .toBe("https://jobs.ashbyhq.com/acme/abc");
    expect(normalizedJobUrl("https://jobs.ashbyhq.com/acme/abc/application?embed=true"))
      .toBe("https://jobs.ashbyhq.com/acme/abc");
    expect(isLinkedInJobUrl("https://ca.linkedin.com/jobs/view/software-engineer-intern-123456789")).toBe(true);
    expect(isLinkedInJobUrl("https://www.linkedin.com/company/example")).toBe(false);
  });

  it("removes ephemeral credentials from canonical sources and diagnostics", () => {
    const tokenized = "https://interninsider.me/internships/new?mcp_token=secret-value&session=abc123&utm_source=chatgpt.com";
    expect(canonicalizeUrl(tokenized)).toBe("https://interninsider.me/internships/new");
    expect(redactSensitiveUrl(tokenized)).toContain("mcp_token=%5BREDACTED%5D");
    expect(redactSensitiveUrl(tokenized)).not.toContain("secret-value");
    expect(redactSensitiveText(`request ${tokenized} Authorization: Bearer secret-value`)).not.toContain("secret-value");
  });
});
