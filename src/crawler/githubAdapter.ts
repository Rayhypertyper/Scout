import type { FetchFailure, PageSnapshot } from "../domain/types.js";
import { extractPublicBoardJobs } from "../extractors/publicBoards.js";
import { canonicalizeUrl, redactSensitiveUrl } from "../utils/url.js";
import type { Logger } from "../utils/logger.js";
import { HttpClient, HttpRequestError } from "./http.js";
import { mapBounded } from "./staticAdapters.js";

interface RepositoryEntry {
  name?: unknown;
  path?: unknown;
  type?: unknown;
  download_url?: unknown;
}

interface RepositoryMetadata {
  default_branch?: unknown;
  html_url?: unknown;
}

export interface GitHubAdapterResult {
  snapshots: PageSnapshot[];
  retrievalMethod: string;
  retrievalUrls: string[];
  attempts: number;
  httpStatus: number | null;
  notes: string[];
  failures?: FetchFailure[];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export interface GitHubRepositoryParts {
  owner: string;
  repository: string;
  requestedPath: string | null;
  branch: string | null;
}

export function repositoryParts(sourceUrl: string): GitHubRepositoryParts | null {
  const url = new URL(canonicalizeUrl(sourceUrl));
  if (!/(^|\.)github\.com$/i.test(url.hostname)) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0];
  const repository = parts[1]?.replace(/\.git$/i, "");
  if (!owner || !repository) return null;
  if (parts[2] === "blob" || parts[2] === "tree") {
    // GitHub's web route is /owner/repo/(blob|tree)/<ref>/<path>. A ref may
    // contain slashes, so query ?ref= is preferred when present; otherwise we
    // use the first segment and let the metadata default branch resolve normal
    // URLs. The raw/API fallback below still handles nested file paths.
    const routeParts = parts.slice(3);
    const requestedRef = url.searchParams.get("ref")?.trim() || null;
    const branch = requestedRef ?? routeParts[0] ?? null;
    const requestedPath = routeParts.slice(1).join("/") || null;
    return { owner, repository, requestedPath, branch };
  }
  return { owner, repository, requestedPath: null, branch: null };
}

function isMarkdownFile(entry: RepositoryEntry): boolean {
  const name = stringValue(entry.name)?.toLocaleLowerCase() ?? "";
  if (entry.type !== "file" || !/\.(?:md|markdown|mdown)$/i.test(name)) return false;
  return true;
}

function isRepositoryDirectory(entry: RepositoryEntry): boolean {
  return entry.type === "dir" && Boolean(stringValue(entry.path));
}

function jsonValue(body: string): unknown {
  try { return JSON.parse(body) as unknown; } catch { return null; }
}

function encodeRepositoryPath(path: string): string {
  return path.split("/").filter(Boolean).map((part) => encodeURIComponent(part)).join("/");
}

function entriesFrom(body: string): RepositoryEntry[] {
  const parsed = jsonValue(body);
  return Array.isArray(parsed) ? parsed.filter((value): value is RepositoryEntry => typeof value === "object" && value !== null) : [];
}

function snapshotFromMarkdown(markdown: string, rawUrl: string, title: string): PageSnapshot {
  return {
    requestedUrl: rawUrl,
    url: rawUrl,
    status: 200,
    contentType: "text/markdown",
    title,
    html: `<pre>${markdown.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</pre>`,
    text: markdown,
    links: [],
    fetchedAt: new Date().toISOString(),
  };
}

export class GitHubSourceAdapter {
  public constructor(
    private readonly logger: Logger,
    private readonly http: HttpClient,
  ) {}

  public canHandle(sourceUrl: string): boolean {
    try { return /(^|\.)github\.com$/i.test(new URL(sourceUrl).hostname); } catch { return false; }
  }

  public async collect(sourceUrl: string): Promise<GitHubAdapterResult> {
    this.logger.debug("GITHUB", `Collecting ${redactSensitiveUrl(sourceUrl)} through API/raw transport.`);
    const parts = repositoryParts(sourceUrl);
    if (!parts) {
      return { snapshots: [], retrievalMethod: "GitHub API", retrievalUrls: [], attempts: 0, httpStatus: 400, notes: ["The GitHub URL did not identify a repository."] };
    }
    const apiBase = `https://api.github.com/repos/${encodeURIComponent(parts.owner)}/${encodeURIComponent(parts.repository)}`;
    const notes: string[] = [];
    const failures: FetchFailure[] = [];
    let attempts = 0;
    let lastStatus: number | null = null;
    let branch = parts.branch;
    let apiSucceeded = false;
    let entries: RepositoryEntry[] = [];
    const token = process.env.GITHUB_TOKEN?.trim();
    const authHeaders: HeadersInit = token ? { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } : { accept: "application/vnd.github+json" };

    try {
      const metadataResponse = await this.http.get(apiBase, { headers: authHeaders });
      attempts += metadataResponse.attempts;
      lastStatus = metadataResponse.status;
      const metadata = jsonValue(metadataResponse.body) as RepositoryMetadata | null;
      branch ??= stringValue(metadata?.default_branch);
      if (branch) {
        const rootResponse = await this.http.get(`${apiBase}/contents/?ref=${encodeURIComponent(branch)}`, { headers: authHeaders });
        attempts += rootResponse.attempts;
        lastStatus = rootResponse.status;
        entries = entriesFrom(rootResponse.body);
        apiSucceeded = true;
      }
    } catch (error) {
      if (error instanceof HttpRequestError) {
        attempts += error.attempts + 1;
        lastStatus = error.statusCode;
        const rateRemaining = error.headers["x-ratelimit-remaining"];
        const rateReset = error.headers["x-ratelimit-reset"];
        if (rateRemaining === "0") {
          notes.push(`GitHub API rate limit exhausted${rateReset ? ` until ${new Date(Number(rateReset) * 1_000).toISOString()}` : ""}; using raw files.`);
        } else {
          notes.push(`GitHub API was unavailable (${error.message}); using raw files where possible.`);
        }
      } else {
        notes.push(`GitHub API failed; using raw files where possible.`);
      }
    }

    const files = new Map<string, RepositoryEntry>();
    if (parts.requestedPath) files.set(parts.requestedPath, { name: parts.requestedPath.split("/").pop(), path: parts.requestedPath, type: "file" });
    for (const entry of entries) {
      if (isMarkdownFile(entry)) {
        const path = stringValue(entry.path);
        if (path) files.set(path, entry);
      }
    }

    // A small bounded directory walk catches repos that keep their list in an
    // `internships/` or `jobs/` folder without turning GitHub into a crawler.
    if (apiSucceeded && branch) {
      const ref = branch;
      const directories = entries.filter(isRepositoryDirectory).slice(0, 8);
      const directoryResults = await mapBounded(directories, 4, async (directory) => {
        const path = stringValue(directory.path);
        if (!path) return { path: "", entries: [] as RepositoryEntry[] };
        const response = await this.http.get(`${apiBase}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`, { headers: authHeaders });
        return { path, entries: entriesFrom(response.body), attempts: response.attempts, status: response.status };
      });
      for (const [index, result] of directoryResults.entries()) {
        const path = stringValue(directories[index]?.path);
        if (!path) continue;
        if (result.status === "fulfilled") {
          attempts += result.value.attempts ?? 0;
          lastStatus = result.value.status ?? lastStatus;
          for (const entry of result.value.entries) {
            if (!isMarkdownFile(entry)) continue;
            const filePath = stringValue(entry.path);
            if (filePath) files.set(filePath, entry);
          }
        } else {
          const reason = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
          notes.push(`Could not inspect GitHub directory ${path}: ${reason.message}`);
          failures.push({
            sourceUrl,
            url: `${apiBase}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(ref)}`,
            errorType: reason instanceof HttpRequestError ? reason.errorType : "http_error",
            message: reason.message,
            statusCode: reason instanceof HttpRequestError ? reason.statusCode : null,
            retryCount: reason instanceof HttpRequestError ? reason.attempts : 0,
            occurredAt: new Date().toISOString(),
          });
        }
      }
    }

    if (!branch) branch = "main";
    if (files.size === 0) {
      for (const path of ["README.md", "README-2027.md", "INTERNSHIPS.md", "INTERN.md", "JOBS.md", "NEWGRAD.md"]) {
        files.set(path, { name: path, path, type: "file" });
      }
    }

    const fileEntries = [...files.entries()];
    const fileResults = await mapBounded(fileEntries, 6, async ([path, entry]) => {
      const rawUrl = `https://raw.githubusercontent.com/${parts.owner}/${parts.repository}/${encodeURIComponent(branch).replaceAll("%2F", "/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
      let markdown: string | null = null;
      // Repository listings expose download_url for public files. Prefer it
      // to spending a second API quota unit per file; synthetic/requested
      // paths without that field use the API content endpoint first to retain
      // support for private authenticated repositories.
      const downloadUrl = stringValue(entry.download_url);
      if (downloadUrl) {
        try {
          const response = await this.http.get(downloadUrl, { cache: true });
          markdown = response.body;
          return { path, entry, rawUrl, markdown, attempts: response.attempts, status: response.status };
        } catch (error) {
          if (!(error instanceof HttpRequestError && error.statusCode === 404)) {
            throw new Error(`Could not retrieve ${redactSensitiveUrl(downloadUrl)}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
          }
        }
      }
      if (apiSucceeded) {
        try {
          const response = await this.http.get(`${apiBase}/contents/${encodeRepositoryPath(path)}?ref=${encodeURIComponent(branch)}`, { headers: authHeaders });
          const payload = jsonValue(response.body) as { content?: unknown; encoding?: unknown } | null;
          if (payload?.encoding === "base64" && typeof payload.content === "string") {
            markdown = Buffer.from(payload.content.replace(/\s+/g, ""), "base64").toString("utf8");
          } else if (response.contentType.includes("text") || response.body.startsWith("#") || response.body.includes("|")) {
            markdown = response.body;
          }
          if (markdown) return { path, entry, rawUrl, markdown, attempts: response.attempts, status: response.status };
        } catch {
          notes.push(`GitHub API file fetch failed for ${path}; trying raw content.`);
        }
      }
      const response = await this.http.get(rawUrl, { cache: true });
      markdown = response.body;
      return { path, entry, rawUrl, markdown, attempts: response.attempts, status: response.status };
    });
    const snapshots: PageSnapshot[] = [];
    const retrievalUrls: string[] = [];
    for (const [index, result] of fileResults.entries()) {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        notes.push(`Could not retrieve a GitHub Markdown file: ${reason}`);
        const entry = fileEntries[index];
        const path = entry?.[0] ?? "unknown";
        const rawUrl = `https://raw.githubusercontent.com/${parts.owner}/${parts.repository}/${encodeURIComponent(branch).replaceAll("%2F", "/")}/${path.split("/").map(encodeURIComponent).join("/")}`;
        const cause = result.reason instanceof Error && result.reason.cause instanceof HttpRequestError ? result.reason.cause : result.reason instanceof HttpRequestError ? result.reason : null;
        failures.push({
          sourceUrl,
          url: rawUrl,
          errorType: cause?.errorType ?? "http_error",
          message: result.reason instanceof Error ? result.reason.message : String(result.reason),
          statusCode: cause?.statusCode ?? null,
          retryCount: cause?.attempts ?? 0,
          occurredAt: new Date().toISOString(),
        });
        continue;
      }
      attempts += result.value.attempts;
      lastStatus = result.value.status;
      if (!result.value.markdown?.trim()) continue;
      snapshots.push(snapshotFromMarkdown(result.value.markdown, result.value.rawUrl, stringValue(result.value.entry.name) ?? result.value.path));
      retrievalUrls.push(result.value.rawUrl);
    }

    const jobs = snapshots.flatMap((snapshot) => extractPublicBoardJobs(snapshot));
    if (jobs.length === 0) notes.push("Retrieved GitHub Markdown files but no parseable internship table rows were found.");
    const result = {
      snapshots,
      retrievalMethod: apiSucceeded ? (token ? "GitHub REST API (authenticated)" : "GitHub REST API") : "raw.githubusercontent.com",
      retrievalUrls,
      attempts,
      httpStatus: lastStatus,
      notes,
      failures,
    };
    this.logger.debug("GITHUB", `Retrieved ${snapshots.length} Markdown files from ${parts.owner}/${parts.repository}.`);
    return result;
  }
}

export { GitHubSourceAdapter as GitHubAdapter };
