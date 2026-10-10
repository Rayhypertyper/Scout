import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveSettings } from "../src/config/settings.js";
import { GitHubSourceAdapter, repositoryParts } from "../src/crawler/githubAdapter.js";
import { HttpClient, HttpRequestError } from "../src/crawler/http.js";
import { extractPublicBoardJobs } from "../src/extractors/publicBoards.js";
import { Logger } from "../src/utils/logger.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("GitHub source adapter", () => {
  it("reads an explicitly configured Markdown file without crawling sibling lists or digests", async () => {
    const get = vi.fn(async (url: string) => ({
      requestedUrl: url, url, status: 200, attempts: 1, fromCache: false,
      contentType: "application/json", headers: {},
      body: url.endsWith("/repo") ? JSON.stringify({ default_branch: "main" })
        : JSON.stringify({ encoding: "base64", content: Buffer.from("# Current internships").toString("base64") }),
    }));
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    const result = await adapter.collect("https://github.com/test/repo/blob/main/listings/software.md");
    expect(result.snapshots).toHaveLength(1);
    expect(result.retrievalUrls).toEqual(["https://raw.githubusercontent.com/test/repo/main/listings/software.md"]);
    expect(get.mock.calls.map(([url]) => url)).toEqual([
      "https://api.github.com/repos/test/repo",
      "https://api.github.com/repos/test/repo/contents/listings/software.md?ref=main",
    ]);
  });

  it("skips digest and archive directories while retaining current listing directories", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-github-inventory-"));
    temporaryDirectories.push(directory);
    const get = vi.fn(async (url: string) => ({
      requestedUrl: url, url, status: 200, attempts: 1, fromCache: false, contentType: "application/json", headers: {},
      body: url.endsWith("/repo") ? JSON.stringify({ default_branch: "main" })
        : /\/contents\/?\?ref=/.test(url) ? JSON.stringify([
          { name: "README.md", path: "README.md", type: "file" },
          ...["digests", "archive", "archived", "listings"].map((path) => ({ name: path, path, type: "dir" })),
        ]) : url.includes("/contents/listings?") ? JSON.stringify([{ name: "intern.md", path: "listings/intern.md", type: "file" }])
          : JSON.stringify({ encoding: "base64", content: Buffer.from("# Current internships").toString("base64") }),
    }));
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);
    const result = await adapter.collect("https://github.com/test/repo");
    expect(result.snapshots).toHaveLength(2);
    expect(get.mock.calls.map(([url]) => url).some((url) => /digests|archive/.test(url))).toBe(false);
    expect(result.retrievalUrls.some((url) => url.includes("listings/intern.md"))).toBe(true);
  });
  it("strips the branch segment when a blob route supplies an explicit ref", () => {
    expect(repositoryParts("https://github.com/test/repo/blob/main/README.md?ref=dev")).toEqual({
      owner: "test",
      repository: "repo",
      requestedPath: "README.md",
      branch: "dev",
    });
  });

  it("uses REST/raw transport and parses a repository Markdown table without Playwright", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-github-"));
    temporaryDirectories.push(directory);
    const markdown = [
      "# Summer 2027 internships",
      "| Company | Title | Location | Apply |",
      "| --- | --- | --- | --- |",
      "| Acme | Software Engineering Intern | Toronto, Canada | [Apply](https://jobs.example.com/acme/123) |",
    ].join("\n");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.github.com/repos/test/repo") {
        return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/test/repo/contents?ref=main") {
        return new Response(JSON.stringify([{ name: "README.md", path: "README.md", type: "file" }]), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url === "https://api.github.com/repos/test/repo/contents/README.md?ref=main") {
        return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`Unexpected request ${url}`);
    });
    const settings = resolveSettings({ outputDirectory: directory, databasePath: join(directory, "test.db"), retryCount: 0 });
    const adapter = new GitHubSourceAdapter(new Logger("error"), new HttpClient(settings, new Logger("error")));
    const result = await adapter.collect("https://github.com/test/repo");

    expect(result.retrievalMethod).toBe("GitHub REST API");
    expect(result.snapshots).toHaveLength(1);
    expect(extractPublicBoardJobs(result.snapshots[0]!)).toHaveLength(1);
    expect(fetchMock.mock.calls.map(([input]) => typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url)
      .every((url) => url.includes("api.github.com") || url.includes("raw.githubusercontent.com"))).toBe(true);
  });

  it("surfaces partial per-file failures while retaining successful Markdown files", async () => {
    const directory = mkdtempSync(join(tmpdir(), "internshipmatic-github-partial-"));
    temporaryDirectories.push(directory);
    const markdown = "| Company | Title | Location | Apply |\n| --- | --- | --- | --- |\n| Acme | Software Engineering Intern | Toronto | [Apply](https://jobs.example.com/acme/123) |";
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.github.com/repos/test/repo") return new Response(JSON.stringify({ default_branch: "main" }), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://api.github.com/repos/test/repo/contents?ref=main") return new Response(JSON.stringify([
        { name: "INTERNSHIPS.md", path: "INTERNSHIPS.md", type: "file" },
        { name: "MISSING-INTERN.md", path: "MISSING-INTERN.md", type: "file" },
      ]), { status: 200, headers: { "content-type": "application/json" } });
      if (url === "https://api.github.com/repos/test/repo/contents/INTERNSHIPS.md?ref=main") return new Response(JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }), { status: 200, headers: { "content-type": "application/json" } });
      if (url.includes("MISSING-INTERN.md")) return new Response("missing", { status: 404 });
      throw new Error(`Unexpected request ${url}`);
    });
    const settings = resolveSettings({ outputDirectory: directory, databasePath: join(directory, "test.db"), retryCount: 0, perHostDelayMs: 0 });
    const adapter = new GitHubSourceAdapter(new Logger("error"), new HttpClient(settings, new Logger("error")));
    const result = await adapter.collect("https://github.com/test/repo");

    expect(result.snapshots).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.notes.some((note) => note.includes("Markdown file"))).toBe(true);
  });

  it("recovers a transient download_url failure through the contents API", async () => {
    const markdown = "# Internship listings";
    const get = vi.fn(async (url: string) => {
      if (url.endsWith("/repo")) return { status: 200, attempts: 1, body: JSON.stringify({ default_branch: "main" }), contentType: "application/json" };
      if (url.endsWith("/contents/?ref=main")) return { status: 200, attempts: 1, body: JSON.stringify([
        { name: "README.md", path: "README.md", type: "file", download_url: "https://raw.githubusercontent.com/test/repo/main/README.md" },
      ]), contentType: "application/json" };
      if (url.startsWith("https://raw.githubusercontent.com/")) throw new HttpRequestError("temporary network failure", null, 2, "network_error");
      if (url.endsWith("/contents/README.md?ref=main")) return { status: 200, attempts: 1, body: JSON.stringify({ encoding: "base64", content: Buffer.from(markdown).toString("base64") }), contentType: "application/json" };
      throw new Error(`Unexpected request ${url}`);
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);

    const result = await adapter.collect("https://github.com/test/repo");

    expect(result.snapshots).toHaveLength(1);
    expect(result.snapshots[0]?.text).toBe(markdown);
    expect(result.failures).toEqual([]);
    expect(result.attempts).toBe(6);
  });

  it("reports the final raw HTTP failure and accumulated attempts when every file path fails", async () => {
    const get = vi.fn(async (url: string) => {
      if (url.endsWith("/repo")) return { status: 200, attempts: 1, body: JSON.stringify({ default_branch: "main" }), contentType: "application/json" };
      if (url.endsWith("/contents/?ref=main")) return { status: 200, attempts: 1, body: JSON.stringify([
        { name: "README.md", path: "README.md", type: "file", download_url: "https://raw.githubusercontent.com/test/repo/main/README.md" },
      ]), contentType: "application/json" };
      if (url.startsWith("https://raw.githubusercontent.com/")) throw new HttpRequestError("raw service unavailable", 503, 2, "http_error");
      if (url.endsWith("/contents/README.md?ref=main")) throw new HttpRequestError("contents API unavailable", 502, 3, "http_error");
      throw new Error(`Unexpected request ${url}`);
    });
    const adapter = new GitHubSourceAdapter(new Logger("error"), { get } as unknown as HttpClient);

    const result = await adapter.collect("https://github.com/test/repo");

    expect(result.snapshots).toHaveLength(0);
    expect(result.failures).toHaveLength(1);
    expect(result.failures?.[0]).toMatchObject({ errorType: "http_error", statusCode: 503, retryCount: 9 });
    expect(result.attempts).toBe(12);
    expect(result.failures?.[0]?.message).toContain("raw service unavailable");
  });
});
