import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";

import { scoreListingRelevance } from "../src/classification/listingRelevance.js";
import { deduplicateListings, listingIdentityMatches } from "../src/deduplication/deduplicate.js";
import { GitHubSourceAdapter } from "../src/crawler/githubAdapter.js";
import { HttpClient } from "../src/crawler/http.js";
import { resolveSettings } from "../src/config/settings.js";
import { canonicalizeUrl } from "../src/utils/url.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function httpClient(overrides: Record<string, unknown> = {}): HttpClient {
  const directory = mkdtempSync(join(tmpdir(), "internshipmatic-optimization-"));
  temporaryDirectories.push(directory);
  const settings = resolveSettings({
    outputDirectory: directory,
    databasePath: join(directory, "crawl.db"),
    retryCount: 0,
    perHostDelayMs: 0,
    ...overrides,
  });
  return new HttpClient(settings, new Logger("error"));
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith(".ts") ? [path] : [];
  });
}

describe("adversarial optimization contracts", () => {
  it("preserves meaningful query parameters while removing tracking and credentials", () => {
    const normalized = canonicalizeUrl(
      "https://Example.com/jobs?ID=primary&id=secondary&query=software&page=2&utm_source=feed&Authorization=secret&ref=partner#apply",
    );
    const parsed = new URL(normalized);
    expect(parsed.hostname).toBe("example.com");
    expect(parsed.searchParams.get("query")).toBe("software");
    expect(parsed.searchParams.get("page")).toBe("2");
    expect(parsed.searchParams.get("ID")).toBe("primary");
    expect(parsed.searchParams.get("id")).toBe("secondary");
    expect(parsed.searchParams.has("utm_source")).toBe(false);
    expect(parsed.searchParams.has("Authorization")).toBe(false);
    expect(parsed.searchParams.has("ref")).toBe(false);
  });

  it("collapses tracker-only copies but never merges distinct requisition identities", () => {
    const first = {
      company: "Northstar Labs",
      title: "Software Engineering Intern",
      location: "Toronto, ON, Canada",
      postingUrl: "https://jobs.example.com/jobs/REQ-100?utm_source=github",
    };
    const trackerCopy = {
      ...first,
      postingUrl: "https://jobs.example.com/jobs/REQ-100?utm_medium=referral&fbclid=abc",
    };
    const distinct = {
      ...first,
      postingUrl: "https://jobs.example.com/jobs/REQ-101?utm_medium=referral",
    };

    expect(listingIdentityMatches(first, trackerCopy)).toBe(true);
    expect(listingIdentityMatches(first, distinct)).toBe(false);
    expect(deduplicateListings([first, trackerCopy, distinct])).toHaveLength(2);
  });

  it("keeps neutral, mixed, and nontechnical wording on the detail path", () => {
    const neutral = scoreListingRelevance({ title: "Product Systems Student Associate" });
    const mixed = scoreListingRelevance({ title: "Marketing Technology Intern", department: "Software Platform" });
    const nontechnical = scoreListingRelevance({ title: "Marketing Intern" });

    expect(neutral.shouldFetchDetail).toBe(true);
    expect(neutral.decision).toBe("slow-path");
    expect(mixed.shouldFetchDetail).toBe(true);
    expect(mixed.mixedSignal).toBe(true);
    expect(nontechnical.clearlyIrrelevant).toBe(true);
    expect(nontechnical.decision).toBe("fast-reject");
    expect(nontechnical.shouldFetchDetail).toBe(false);
  });

  it("uses GitHub API/raw transport on API failure and never asks for browser rendering", async () => {
    const markdown = [
      "# Internship list",
      "| Company | Role | Location | Apply |",
      "| --- | --- | --- | --- |",
      "| Acme | Software Engineering Intern | Toronto, Canada | [Apply](https://jobs.acme.example/100) |",
    ].join("\n");
    const requests: string[] = [];
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === "https://api.github.com/repos/acme/internships") {
        return new Response("forbidden", { status: 403 });
      }
      if (url === "https://raw.githubusercontent.com/acme/internships/main/README.md") {
        return new Response(markdown, { status: 200, headers: { "content-type": "text/markdown" } });
      }
      throw new Error(`unexpected transport ${url}`);
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), httpClient());
    const result = await adapter.collect("https://github.com/acme/internships/blob/main/README.md");

    expect(result.snapshots).toHaveLength(1);
    expect(result.retrievalMethod).toBe("raw.githubusercontent.com");
    expect(requests.every((url) => url.includes("api.github.com") || url.includes("raw.githubusercontent.com"))).toBe(true);
    expect(requests.some((url) => url.startsWith("https://github.com/"))).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("discovers Markdown roles in neutral repository paths without filename or directory keywords", async () => {
    const markdown = "| Company | Role | Location | Apply |\n| --- | --- | --- | --- |\n| Acme | Facilities Associate | Toronto | [Apply](https://jobs.acme.example/facilities-1) |";
    const requests: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push(url);
      if (url === "https://api.github.com/repos/acme/opportunities") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/acme/opportunities/contents?ref=main") {
        return new Response(JSON.stringify([
          { name: "opportunities.md", path: "opportunities.md", type: "file" },
          { name: "community", path: "community", type: "dir" },
        ]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/acme/opportunities/contents/community?ref=main") {
        return new Response(JSON.stringify([{ name: "roles.md", path: "community/roles.md", type: "file" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/acme/opportunities/contents/opportunities.md?ref=main"
        || url === "https://api.github.com/repos/acme/opportunities/contents/community/roles.md?ref=main") {
        return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected transport ${url}`);
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), httpClient());

    const result = await adapter.collect("https://github.com/acme/opportunities");

    expect(result.snapshots).toHaveLength(2);
    expect(requests).toContain("https://api.github.com/repos/acme/opportunities/contents/community?ref=main");
    expect(result.notes).not.toContain(expect.stringContaining("no parseable internship"));
  });

  it("does not treat a 304 without a cached representation as a successful empty document", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 304 }));
    const http = httpClient({ cacheTtlMs: 0 });

    await expect(http.get("https://cache.example/jobs/missing", { cache: false })).rejects.toMatchObject({
      statusCode: 304,
      errorType: "http_error",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps production runtime free of LLM/agent/embedding dependencies and imports", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      dependencies?: Record<string, unknown>;
    };
    const forbiddenDependency = /(?:^|[-_.])(openai|langchain|llama|anthropic|google-generative-ai|embedding|agent)(?:$|[-_.])/i;
    expect(Object.keys(packageJson.dependencies ?? {}).filter((name) => forbiddenDependency.test(name))).toEqual([]);

    const forbiddenImport = /(?:from\s*["']|import\s*\(\s*["'])[^"']*(?:openai|langchain|llama|anthropic|google-generative-ai|embedding|agent)[^"']*["']/i;
    const violations = sourceFiles(join(process.cwd(), "src"))
      .filter((path) => forbiddenImport.test(readFileSync(path, "utf8")))
      .map((path) => path.replace(`${process.cwd()}/`, ""));
    expect(violations).toEqual([]);
  });
});
