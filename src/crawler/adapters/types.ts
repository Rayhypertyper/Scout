import type { FetchFailure, PageSnapshot } from "../../domain/types.js";
import type { ScoutSettings } from "../../domain/schemas.js";
import type { Logger } from "../../utils/logger.js";
import type { HttpClient } from "../http.js";

/** The retrieval order is part of the adapter contract. */
export type RetrievalStrategy = "structured_endpoint" | "direct_http" | "static_html" | "browser_required";

export interface AdapterContext {
  settings: ScoutSettings;
  logger: Logger;
  http: HttpClient;
}

export interface SourceAdapterResult {
  snapshots: PageSnapshot[];
  retrievalMethod: string;
  retrievalUrls: string[];
  attempts: number;
  httpStatus: number | null;
  notes: string[];
  failures: FetchFailure[];
  strategy: RetrievalStrategy;
  /** True only when ordinary HTTP cannot expose the useful source content. */
  browserRequired?: boolean;
}

/**
 * Lightweight source adapter boundary consumed by the central crawler.
 * Adapters return PageSnapshots for compatibility with the existing
 * deterministic extractors; they do not launch Playwright themselves.
 */
export interface SourceAdapter {
  readonly name: string;
  readonly strategy: RetrievalStrategy;
  canHandle(sourceUrl: string): boolean;
  collect(sourceUrl: string): Promise<SourceAdapterResult>;
}

export function adapterFailure(
  sourceUrl: string,
  url: string,
  error: unknown,
  statusCode: number | null = null,
): FetchFailure {
  const structured = error && typeof error === "object" ? error as { errorType?: unknown; attempts?: unknown } : null;
  return {
    sourceUrl,
    url,
    errorType: typeof structured?.errorType === "string" ? structured.errorType : "http_error",
    message: error instanceof Error ? error.message : String(error),
    statusCode,
    retryCount: typeof structured?.attempts === "number" ? structured.attempts : 0,
    occurredAt: new Date().toISOString(),
  };
}
