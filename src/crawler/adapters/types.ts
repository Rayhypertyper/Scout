import type { ClosedPage, FetchFailure, PageSnapshot, RawJob, SourceInventoryPart } from "../../domain/types.js";
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
  /**
   * True only when the adapter exhausted its source inventory. This is
   * independent of relevance filtering and downstream detail/application URL
   * resolution, which may still make the crawl result partial.
   */
  inventoryComplete?: boolean;
  /** Exact number of selected inventory rows parsed, before any retained-prefix limit. */
  inventoryCount?: number;
  /**
   * Maximum number of raw listings represented by the returned snapshots.
   * Adapters may set this only when their retrieval path applies its own
   * finite, source-specific bound. Generic sources retain the crawler's
   * conservative default.
   */
  maxRawListings?: number;
  /** True only when ordinary HTTP cannot expose the useful source content. */
  browserRequired?: boolean;
  inventoryParts?: SourceInventoryPart[];
  /** Physical pages collected before constructing compact inventory snapshots. */
  retrievedPages?: number;
  detailPagesFetched?: number;
  closedPages?: ClosedPage[];
  /** Retrieved source records missing fields needed for usable publication. */
  incompleteJobs?: RawJob[];
}

export interface AdapterCollectOptions {
  /** Keeps the source activity lease alive during a large HTTP inventory. */
  onProgress?: (retrievedPages: number) => Promise<void>;
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
  collect(sourceUrl: string, options?: AdapterCollectOptions): Promise<SourceAdapterResult>;
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
