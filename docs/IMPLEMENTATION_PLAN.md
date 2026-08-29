# Internship Scout implementation plan

## Architecture

The application is a TypeScript command-line program with six boundaries:

1. **Configuration and schemas** validate sources, crawler limits, filters, and every extracted internship with Zod.
2. **Crawler** maintains a per-source priority queue, checks robots.txt, rate-limits by origin, retries transient failures, reuses one Playwright browser, and falls back to static HTTP when possible.
3. **Extractors** turn pages into job candidates. Provider-specific adapters handle Greenhouse, Lever, Workday, Ashby, and GitHub; the generic adapter handles structured job data and semantic HTML.
4. **Analysis** extracts qualifications, authorization, dates, locations, and technologies, then independently verifies internship status and meaningful programming work.
5. **Persistence** canonicalizes and deduplicates candidates, stores their source provenance in SQLite, and compares content hashes across crawl runs to label records `NEW`, `UPDATED`, `UNCHANGED`, or `REMOVED_OR_CLOSED` without deleting history.
6. **Presentation** applies CLI filters and writes deterministic JSON/CSV files plus a readable console summary.

## Delivery sequence

1. Define the domain model, defaults, configuration file, logging, URL normalization, and CLI.
2. Build the browser/static fetcher, priority queue, link scorer, robots/rate-limit/retry controls, pagination/load-more support, and application-link resolver.
3. Build generic and provider-specific extraction plus all parsers and classifiers.
4. Add SQLite migrations, run lifecycle logic, deduplication, provenance, failure recording, and output writers.
5. Add saved HTML fixtures and unit/integration coverage for the critical extraction and lifecycle paths.
6. Compile, lint, test, run a deterministic local sample twice, and inspect the generated records and direct application URLs.

## Safety and operational constraints

- The crawler never fills or submits an application form.
- It does not bypass CAPTCHAs, authentication, robots.txt, or access controls.
- Crawl breadth is bounded per source and recruiting-domain traversal is allowlisted by relationship and ATS identity.
- Missing fields remain null, unknown, or empty; inferred data is limited to normalized fields and relevance explanations.
- A failed source does not stop other sources, and every terminal fetch failure is persisted.
