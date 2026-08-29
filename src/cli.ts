import { parseArgs } from "node:util";

import { CategorySchema, type Category, type ScoutSettings } from "./domain/schemas.js";
import { MIN_LISTING_SCORE } from "./config/thresholds.js";

export interface ParsedCli {
  sources: string[];
  filters: {
    location?: string;
    categories: Category[];
    newOnly: boolean;
    minScore: number;
  };
  settings: Partial<ScoutSettings>;
  help: boolean;
}

function integerFlag(name: string, value: string | undefined, minimum: number, maximum: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`--${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return parsed;
}

export function parseCli(argv: string[]): ParsedCli {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      source: { type: "string", multiple: true },
      location: { type: "string" },
      category: { type: "string", multiple: true },
      "new-only": { type: "boolean", default: false },
      "min-score": { type: "string" },
      "max-depth": { type: "string" },
      "max-pages": { type: "string" },
      timeout: { type: "string" },
      "page-timeout": { type: "string" },
      concurrency: { type: "string" },
      "http-concurrency": { type: "string" },
      "browser-concurrency": { type: "string" },
      "per-domain-concurrency": { type: "string" },
      "detail-recheck-ttl": { type: "string" },
      "connect-timeout": { type: "string" },
      "read-timeout": { type: "string" },
      "navigation-timeout": { type: "string" },
      "selector-timeout": { type: "string" },
      retries: { type: "string" },
      database: { type: "string" },
      "output-dir": { type: "string" },
      verbose: { type: "boolean", short: "v", default: false },
      headed: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const categories = (values.category ?? []).flatMap((value) => value.split(",")).filter(Boolean).map((value) => CategorySchema.parse(value));
  const minScore = integerFlag("min-score", values["min-score"], 0, 100) ?? MIN_LISTING_SCORE;
  const settings: Partial<ScoutSettings> = {
    verbose: values.verbose,
    headless: !values.headed,
    minRelevanceScore: minScore,
  };
  const maxDepth = integerFlag("max-depth", values["max-depth"], 0, 12);
  const maxPagesPerSource = integerFlag("max-pages", values["max-pages"], 1, 10_000);
  const timeoutMs = integerFlag("timeout", values.timeout, 1_000, 300_000);
  const pageTimeoutMs = integerFlag("page-timeout", values["page-timeout"], 1_000, 600_000);
  const concurrency = integerFlag("concurrency", values.concurrency, 1, 20);
  const httpConcurrency = integerFlag("http-concurrency", values["http-concurrency"], 1, 64);
  const browserConcurrency = integerFlag("browser-concurrency", values["browser-concurrency"], 1, 16);
  const perDomainConcurrency = integerFlag("per-domain-concurrency", values["per-domain-concurrency"], 1, 16);
  const detailRecheckTtlMs = integerFlag("detail-recheck-ttl", values["detail-recheck-ttl"], 0, 31_536_000_000);
  const connectTimeoutMs = integerFlag("connect-timeout", values["connect-timeout"], 250, 120_000);
  const readTimeoutMs = integerFlag("read-timeout", values["read-timeout"], 500, 300_000);
  const navigationTimeoutMs = integerFlag("navigation-timeout", values["navigation-timeout"], 1_000, 300_000);
  const selectorTimeoutMs = integerFlag("selector-timeout", values["selector-timeout"], 250, 120_000);
  const retryCount = integerFlag("retries", values.retries, 0, 8);
  if (maxDepth !== undefined) settings.maxDepth = maxDepth;
  if (maxPagesPerSource !== undefined) settings.maxPagesPerSource = maxPagesPerSource;
  if (timeoutMs !== undefined) settings.timeoutMs = timeoutMs;
  if (pageTimeoutMs !== undefined) settings.pageTimeoutMs = pageTimeoutMs;
  if (concurrency !== undefined) settings.concurrency = concurrency;
  if (httpConcurrency !== undefined) settings.httpConcurrency = httpConcurrency;
  if (browserConcurrency !== undefined) settings.browserConcurrency = browserConcurrency;
  if (perDomainConcurrency !== undefined) settings.perDomainConcurrency = perDomainConcurrency;
  if (detailRecheckTtlMs !== undefined) settings.detailRecheckTtlMs = detailRecheckTtlMs;
  if (connectTimeoutMs !== undefined) settings.connectTimeoutMs = connectTimeoutMs;
  if (readTimeoutMs !== undefined) settings.readTimeoutMs = readTimeoutMs;
  if (navigationTimeoutMs !== undefined) settings.navigationTimeoutMs = navigationTimeoutMs;
  if (selectorTimeoutMs !== undefined) settings.selectorTimeoutMs = selectorTimeoutMs;
  if (retryCount !== undefined) settings.retryCount = retryCount;
  if (values.database) settings.databasePath = values.database;
  if (values["output-dir"]) settings.outputDirectory = values["output-dir"];
  return {
    sources: values.source ?? [],
    filters: {
      ...(values.location ? { location: values.location } : {}),
      categories,
      newOnly: values["new-only"],
      minScore,
    },
    settings,
    help: values.help,
  };
}

export function helpText(): string {
  return `Internship Scout

Usage:
  npm run scout
  npm run scout -- --source https://company.example/careers

Filters:
  --location <text>       Canada, USA, a province/state, or a city
  --category <category>   Repeat or comma-separate: swe, frontend, backend,
                          fullstack, mobile, qa, devops, cloud, data, ml, ai,
                          security, embedded, quant, research, other-code, other
  --new-only              Only emit records first seen in this run
  --min-score <0-100>     Optional relevance threshold (default: 0)

Crawl controls:
  --source <url>          Override configured sources; repeatable
  --max-depth <n>         Maximum navigation depth
  --max-pages <n>         Maximum pages per source
  --timeout <ms>          General request ceiling
  --page-timeout <ms>     Hard limit for one browser page (default: 15000)
  --concurrency <n>       Compatibility alias for concurrent browser pages
  --http-concurrency <n>  Concurrent HTTP requests (default: 24)
  --browser-concurrency <n> Concurrent browser pages (default: 4)
  --per-domain-concurrency <n> Per-origin request/page limit (default: 3)
  --connect-timeout <ms>  Connect budget (default: 3000)
  --read-timeout <ms>     Read budget (default: 7000)
  --navigation-timeout <ms> Browser navigation budget (default: 10000)
  --selector-timeout <ms> Dynamic selector wait (default: 5000)
  --detail-recheck-ttl <ms> Identity-only detail recheck TTL
  --retries <n>           Retry count for transient failures
  --database <path>       SQLite path
  --output-dir <path>     JSON/CSV directory
  --headed                Show Chromium while crawling
  -v, --verbose           Debug logs
  -h, --help              Show this help
`;
}
