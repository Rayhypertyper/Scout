import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";

import { request } from "playwright";

import { MIN_LISTING_SCORE } from "./config/thresholds.js";
import { isAggregatorUrl, redactSensitiveUrl } from "./utils/url.js";
import { classifyLinkResponse, type VerificationState } from "./verification/linkStatus.js";

type LinkType = "application" | "posting";

interface LinkRow {
  id: string;
  company: string;
  title: string;
  linkTypes: LinkType[];
  url: string;
}

interface LinkVerification {
  id: string;
  company: string;
  title: string;
  linkTypes: LinkType[];
  requestedUrl: string;
  finalUrl: string | null;
  statusCode: number | null;
  state: VerificationState;
  direct: boolean;
  checkedAt: string;
  error: string | null;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function mapConcurrent<T, R>(values: T[], concurrency: number, operation: (value: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      const value = values[index];
      if (value !== undefined) results[index] = await operation(value);
    }
  }));
  return results;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      database: { type: "string", default: "output/live/internships.db" },
      output: { type: "string", default: "output/final-report/link-verification.json" },
      concurrency: { type: "string", default: "6" },
      timeout: { type: "string", default: "20000" },
      delay: { type: "string", default: "500" },
    },
  });
  const concurrency = Number.parseInt(values.concurrency, 10);
  const timeout = Number.parseInt(values.timeout, 10);
  const delay = Number.parseInt(values.delay, 10);
  if (![concurrency, timeout, delay].every(Number.isSafeInteger) || concurrency < 1 || timeout < 1 || delay < 0) {
    throw new Error("concurrency, timeout, and delay must be valid integers.");
  }
  const database = new DatabaseSync(values.database, { readOnly: true });
  const rawRows = database.prepare(`
    SELECT id, company, title, 'application' AS link_type, application_url AS url
    FROM internships
    WHERE availability_status = 'open'
      AND CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) >= @minimumScore
    UNION ALL
    SELECT id, company, title, 'posting' AS link_type, posting_url AS url
    FROM internships
    WHERE availability_status = 'open'
      AND CAST(json_extract(payload_json, '$.relevanceScore') AS INTEGER) >= @minimumScore
    ORDER BY url
  `).all({ minimumScore: MIN_LISTING_SCORE }) as unknown as Array<{ id: string; company: string; title: string; link_type: LinkType; url: string }>;
  const rows = [...rawRows.reduce((byUrl, row) => {
    const existing = byUrl.get(row.url);
    if (existing) {
      if (!existing.linkTypes.includes(row.link_type)) existing.linkTypes.push(row.link_type);
    } else {
      byUrl.set(row.url, {
        id: row.id,
        company: row.company,
        title: row.title,
        linkTypes: [row.link_type],
        url: row.url,
      });
    }
    return byUrl;
  }, new Map<string, LinkRow>()).values()].sort((left, right) => left.url.localeCompare(right.url));
  database.close();
  const groups = new Map<string, LinkRow[]>();
  for (const row of rows) {
    const hostname = new URL(row.url).hostname;
    groups.set(hostname, [...(groups.get(hostname) ?? []), row]);
  }
  const context = await request.newContext({
    userAgent: "InternshipScout/1.0 (+respectful link verifier)",
    extraHTTPHeaders: { Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8" },
  });
  try {
    const nested = await mapConcurrent([...groups.values()], concurrency, async (group) => {
      const results: LinkVerification[] = [];
      for (const [index, row] of group.entries()) {
        if (index > 0) await wait(delay);
        const checkedAt = new Date().toISOString();
        try {
          const response = await context.get(row.url, { failOnStatusCode: false, timeout });
          const statusCode = response.status();
          const finalUrl = response.url();
          const contentType = response.headers()["content-type"] ?? "";
          const body = /(?:html|json|text)/i.test(contentType) ? (await response.text()).slice(0, 500_000) : "";
          results.push({
            id: row.id,
            company: row.company,
            title: row.title,
            linkTypes: row.linkTypes,
            requestedUrl: redactSensitiveUrl(row.url),
            finalUrl: redactSensitiveUrl(finalUrl),
            statusCode,
            state: classifyLinkResponse(statusCode, finalUrl, body),
            direct: !isAggregatorUrl(finalUrl),
            checkedAt,
            error: null,
          });
        } catch (error) {
          results.push({
            id: row.id,
            company: row.company,
            title: row.title,
            linkTypes: row.linkTypes,
            requestedUrl: redactSensitiveUrl(row.url),
            finalUrl: null,
            statusCode: null,
            state: "failed",
            direct: !isAggregatorUrl(row.url),
            checkedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return results;
    });
    const results = nested.flat();
    const counts: Record<VerificationState, number> = { reachable: 0, closed: 0, "access-controlled": 0, failed: 0 };
    for (const result of results) counts[result.state] += 1;
    const report = {
      generatedAt: new Date().toISOString(),
      checked: results.length,
      directDestinations: results.filter(({ direct }) => direct).length,
      aggregatorDestinations: results.filter(({ direct }) => !direct).length,
      counts,
      results,
    };
    await mkdir(dirname(values.output), { recursive: true });
    await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    process.stdout.write(`${JSON.stringify({ ...report, results: undefined }, null, 2)}\n`);
  } finally {
    await context.dispose();
  }
}

await main();
