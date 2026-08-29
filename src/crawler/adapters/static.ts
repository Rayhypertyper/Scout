import type { PageSnapshot } from "../../domain/types.js";
import { canonicalizeUrl } from "../../utils/url.js";
import type { Logger } from "../../utils/logger.js";
import { HttpClient, type HttpResponseSnapshot } from "../http.js";
import { snapshotFromHttp } from "../staticAdapters.js";
import { adapterFailure, type AdapterContext, type SourceAdapter, type SourceAdapterResult } from "./types.js";

export function snapshotFromStructuredJson(response: HttpResponseSnapshot, value: unknown, url = response.url): PageSnapshot {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const escaped = body.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return {
    requestedUrl: response.requestedUrl,
    url: canonicalizeUrl(url),
    status: response.status,
    contentType: response.contentType || "application/json",
    title: "",
    html: `<pre>${escaped}</pre>`,
    text: body,
    links: [],
    attempts: response.attempts,
    fromCache: response.fromCache,
    fetchedAt: new Date().toISOString(),
  };
}

export type StaticUrlMatcher = (sourceUrl: string) => boolean;

/** Generic HTTP-first HTML adapter for a declared route/host. */
export class StaticHTMLAdapter implements SourceAdapter {
  public readonly name = "Static HTML";
  public readonly strategy = "static_html" as const;

  public constructor(
    private readonly http: HttpClient,
    private readonly logger: Logger,
    private readonly matcher: StaticUrlMatcher = () => true,
  ) {}

  public canHandle(sourceUrl: string): boolean {
    try {
      return /^https?:$/i.test(new URL(sourceUrl).protocol) && this.matcher(sourceUrl);
    } catch {
      return false;
    }
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    try {
      const response = await this.http.get(sourceUrl, { cache: true });
      const snapshot = snapshotFromHttp(response);
      this.logger.debug("ADAPTER", `Static HTML fetched ${sourceUrl}`);
      const shellOnly = isJavascriptShell(snapshot);
      if (shellOnly) {
        return {
          snapshots: [snapshot],
          retrievalMethod: "direct static HTTP (JavaScript shell)",
          retrievalUrls: [snapshot.url],
          attempts: response.attempts,
          httpStatus: response.status,
          notes: ["The HTTP response is a JavaScript shell without meaningful listing/detail content; browser rendering may be required."],
          failures: [],
          strategy: "browser_required",
          browserRequired: true,
        };
      }
      return {
        snapshots: [snapshot],
        retrievalMethod: "direct static HTTP",
        retrievalUrls: [snapshot.url],
        attempts: response.attempts,
        httpStatus: response.status,
        notes: [],
        failures: [],
        strategy: "static_html",
      };
    } catch (error) {
      return {
        snapshots: [],
        retrievalMethod: "direct static HTTP",
        retrievalUrls: [sourceUrl],
        attempts: error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0,
        httpStatus: error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null,
        notes: [error instanceof Error ? error.message : String(error)],
        failures: [adapterFailure(sourceUrl, sourceUrl, error, error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null)],
        strategy: "static_html",
      };
    }
  }
}

export { StaticHTMLAdapter as StaticHtmlAdapter };

function isJavascriptShell(snapshot: PageSnapshot): boolean {
  if (!/html|xhtml/i.test(snapshot.contentType) && !/<(?:html|body|script)\b/i.test(snapshot.html)) return false;
  const meaningfulText = snapshot.text.replace(/\s+/g, " ").trim();
  const hasLinks = snapshot.links.length > 0;
  const hasAppShell = /<(?:div|main)\b[^>]*(?:id|class)=["'][^"']*(?:root|app|__next|gatsby)[^"']*["'][^>]*>\s*<\/(?:div|main)>/i.test(snapshot.html)
    || /(?:__next_f|webpackJsonp|vite|react-root|ng-version)/i.test(snapshot.html);
  return meaningfulText.length < 180 && !hasLinks && hasAppShell;
}

export interface JsonAdapterOptions<T = unknown> {
  name?: string;
  matcher?: StaticUrlMatcher;
  endpoint?: (sourceUrl: string) => string;
  parse?: (value: T, response: HttpResponseSnapshot, sourceUrl: string) => PageSnapshot[];
}

/** Generic structured JSON adapter. Parsing is deterministic and injectable. */
export class JSONAdapter<T = unknown> implements SourceAdapter {
  public readonly strategy = "structured_endpoint" as const;
  public readonly name: string;
  private readonly matcher: StaticUrlMatcher;
  private readonly endpoint: (sourceUrl: string) => string;
  private readonly parse: (value: T, response: HttpResponseSnapshot, sourceUrl: string) => PageSnapshot[];

  public constructor(
    private readonly context: AdapterContext | HttpClient,
    options: JsonAdapterOptions<T> = {},
  ) {
    this.name = options.name ?? "JSON";
    this.matcher = options.matcher ?? (() => true);
    this.endpoint = options.endpoint ?? ((sourceUrl) => sourceUrl);
    this.parse = options.parse ?? ((value, response) => [snapshotFromStructuredJson(response, value)]);
  }

  private get http(): HttpClient {
    return "http" in this.context ? this.context.http : this.context;
  }

  public canHandle(sourceUrl: string): boolean {
    try {
      return /^https?:$/i.test(new URL(sourceUrl).protocol) && this.matcher(sourceUrl);
    } catch {
      return false;
    }
  }

  public async collect(sourceUrl: string): Promise<SourceAdapterResult> {
    const endpoint = this.endpoint(sourceUrl);
    try {
      const response = await this.http.get(endpoint, {
        cache: true,
        headers: { accept: "application/json,text/json;q=0.9" },
      });
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.body) as T;
      } catch (error) {
        return {
          snapshots: [],
          retrievalMethod: `${this.name} endpoint`,
          retrievalUrls: [endpoint],
          attempts: response.attempts,
          httpStatus: response.status,
          notes: [`${this.name} endpoint returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`],
          failures: [adapterFailure(sourceUrl, endpoint, error, response.status)],
          strategy: "structured_endpoint",
        };
      }
      const snapshots = this.parse(parsed as T, response, sourceUrl);
      return {
        snapshots,
        retrievalMethod: `${this.name} structured endpoint`,
        retrievalUrls: snapshots.length > 0 ? snapshots.map(({ url }) => url) : [endpoint],
        attempts: response.attempts,
        httpStatus: response.status,
        notes: [],
        failures: [],
        strategy: "structured_endpoint",
      };
    } catch (error) {
      const statusCode = error instanceof Error && "statusCode" in error && typeof error.statusCode === "number" ? error.statusCode : null;
      return {
        snapshots: [],
        retrievalMethod: `${this.name} structured endpoint`,
        retrievalUrls: [endpoint],
        attempts: error instanceof Error && "attempts" in error && typeof error.attempts === "number" ? error.attempts : 0,
        httpStatus: statusCode,
        notes: [error instanceof Error ? error.message : String(error)],
        failures: [adapterFailure(sourceUrl, endpoint, error, statusCode)],
        strategy: "structured_endpoint",
      };
    }
  }
}

export { JSONAdapter as JsonAdapter };
