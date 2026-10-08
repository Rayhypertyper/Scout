# Intern List partial runs — 2026-10-04

## Findings from the run matching the reported counts

The live SQLite database is `output/live/internships.db`. The reported 13/4/0/13 counts match run 705, which started at 2026-10-04 23:14:35 UTC and finished at 23:18:17 UTC; this was the latest saved full crawl before the targeted refresh documented below. The overall crawl completed all 23 sources. It recorded 292 HTTP requests, 7,675 cache hits, no browser navigations, and no retryable failures.

| Configured URL | Structured rows inspected | API coverage note | Accepted roles (`jobs_discovered`) | Qualified listings without a verified employer destination | Duration |
| --- | ---: | --- | ---: | ---: | ---: |
| `/` (default SWE) | 5,597 US + 718 Canada = 6,315 | Both snapshots reported complete | 13 | 3,684 | 20.9 s |
| `?k=swe` | 5,597 US + 718 Canada = 6,315 | Same SWE and Canada feeds as `/` | 13 | 3,684 | 17.3 s |
| `?k=aiml` | 1,306 US + 718 Canada = 2,024 | Both snapshots reported complete | 4 | 651 | 19.3 s |
| `?k=eng` | 21,333 rows across 23 snapshots | 21,315 unique IDs against the final advertised total of 21,329; 18 duplicate rows in the live list | 0 | 5,780 | 52.9 s |

Every row had HTTP 200, `failure_count=0`, `last_error=null`, and `completed=1`; there are no `failed_pages` for these four sources in run 705. Their source status is nevertheless `partial` and `coverage_complete=0`. The same status pattern is present in the prior full run 704, about 90 minutes earlier. No HTTP transport error or timeout was recorded, and the historical offset walk did not establish whether all 14 absent IDs were duplicates. Separately, the generic HTTP response limit would have truncated the engineering feed if the adapter had attempted it as one bulk response; the historical adapter avoided that request because its bulk threshold was lower, as detailed below.

The counts describe different stages. The API row totals are records returned by Jobright. `potential_postings_inspected` is the number of extracted records passed into analysis. `jobs_discovered` is the accepted role count after the internship signal, technical relevance threshold, supported-location checks, and required employer/ATS destination check. The adapter note explicitly says that 3,684 SWE, 651 AI/ML, and 5,780 engineering listings pass its “qualifying Jobright listing” checks but lack a verified employer destination in the local resolver cache. The production crawl is cache-only for these Jobright links; it does not open every Jobright details page. This leaves only 13/4/0 accepted rows on those sources and causes `crawlHttpSource` to label the result `partial` even when its structured feed request succeeded.

Run 705's engineering feed took the bounded offset path because its advertised 21,330 rows exceeded the adapter's 15,000-row bulk threshold. The HTTP client separately had a second barrier to using a single response: by default it slices response text to 12,000,000 JavaScript string code units before JSON parsing (`src/crawler/http.ts`). The measured full engineering JSON is 16,870,373 code units / 16,896,924 UTF-8 bytes, so raising only the adapter's bulk threshold would still leave that payload invalid under the generic parser limit. The historical adapter did not attempt that oversized bulk request; it inspected 21,333 rows in 23 returned offset snapshots and reported 21,315 unique IDs against a final advertised total of 21,329. The stored note attributed the difference to duplicate windows, but that run did not establish that all 14 absent IDs were duplicates. A fresh live inventory fetch later returned 21,337 distinct engineering IDs, confirming that the list is mutable and the historical gap cannot be dismissed as duplicates. The old run recorded no failed page and no timeout. Its raw-record budget was 15,000 plus up to 64 offsets of 1,000 records (79,000), above this feed size; the bulk threshold and generic response parsing limit were the barriers to a single stable snapshot.

The source configuration intentionally contains four URLs. The root URL and `?k=swe` both map to the same US SWE category. In the pre-fix adapter, the visible Canada tab was added only for `swe` and `aiml`; `?k=eng` received no Canada feed. Live UI inspection confirmed that clicking Canada on all four URLs selects the same Canada engineering/development feed.

## Why “partial” is displayed

The crawler defines successful coverage as `status === "success"`. For structured Intern List results, `crawlHttpSource` changes the status to `partial` when it found qualifying Jobright records without a verified destination. This is independent of adapter page failures, so the source can have `completed=1`, HTTP 200, and zero failures while `coverage_complete=0`.

That distinction protects lifecycle history: only source URLs with `coverageComplete=true` are passed to the database's missing-listing reconciliation. The adapter fix adds an internal `inventoryComplete` signal so an exhausted feed can be distinguished from an incomplete inventory; it does not turn an unresolved-role `partial` result into `coverageComplete=true`. Thus partial feeds still upsert newly accepted records and retain existing rows and history without marking absent rows closed. Run history and per-source outcomes remain additive in the existing database. A complete empty feed can be represented as `no_internships_found` with complete coverage, while unresolved listings or incomplete offsets remain partial.

There is also a freshness caveat. The HTTP client persists POST response bodies under the configured output directory and serves them for six hours by default. In run 705, root, SWE, and AI/ML each have `attempts=0`, while the prior run 704 recorded the same feed counts; this is consistent with those snapshots being served from cache. An uncached refresh must override `cacheTtlMs` to zero. The normal CLI does not expose that setting.

## Bounded refresh procedure

Call `runScout` with only the four configured source URLs, the existing live database/output paths, `cacheTtlMs: 0`, `maxDepth: 0`, and `maxPagesPerSource: 1`. `maxDepth: 0` prevents following discovered links; the structured adapter still retrieves every API snapshot, and `crawlHttpSource` raises its page floor to the returned snapshot count. Each URL therefore visits its two structured snapshots (selected US feed and shared Canada feed) instead of being capped at one page. The fixed adapter allows up to 94,000 raw rows per feed (30,000 exact-total rows plus 64 bounded 1,000-row offsets), or 188,000 rows per configured URL with its two feeds; this is above the current inventories without launching job-detail navigation.

The equivalent direct invocation is:

```sh
node --import tsx -e 'import { resolveSettings } from "./src/config/settings.ts"; import { runScout } from "./src/scout.ts"; const sources = ["https://www.intern-list.com/", "https://www.intern-list.com/?k=aiml", "https://www.intern-list.com/?k=eng", "https://www.intern-list.com/?k=swe"]; runScout({ sources, settings: resolveSettings({ databasePath: "output/live/internships.db", outputDirectory: "output/live", cacheTtlMs: 0, maxDepth: 0, maxPagesPerSource: 1, httpConcurrency: 8, browserConcurrency: 1, perDomainConcurrency: 2, retryCount: 1, timeoutMs: 30_000 }), filters: { categories: [], newOnly: false, minScore: 60 } }).catch((error) => { console.error(error); process.exitCode = 1; });'
```

The source adapter coalesces duplicate categories, so root and `?k=swe` do not require duplicate feed downloads. Do not use `scripts/crawl-intern-list.ts` for this refresh: it writes a standalone JSON artifact instead of importing roles to the live database, and it invokes the browser Original-post resolver for every extracted listing. The separately scheduled `jobrightResolver` also navigates Jobright pages; it should not be run as part of this bounded database refresh. Report cached verified destinations separately from total API rows and accepted roles.

## Fresh live inventory — direct fetch

The live UI tabs and raw category inventories were checked independently of the SQLite refresh. Each Canada click selected the shared Canada engineering/development feed. The bounded live fetch was uncached (`fromCache=false`) and completed at 2026-10-04 23:59:56.492 UTC (7:59:56 p.m. Toronto time). It returned:

| Feed | Unique job IDs |
| --- | ---: |
| US SWE (root and `?k=swe`) | 5,592 |
| US AI/ML | 1,306 |
| US engineering/development | 21,337 |
| Canada engineering/development | 718 |
| Distinct US union | 26,921 |
| US/Canada overlap | 12 |
| Distinct US + Canada union | 27,627 |

The engineering inventory returned the full 21,337-row bulk response. This direct feed check avoids conflating source coverage with the crawler's 12 MB response-body cache limit. The captured summary and raw payloads are in [coverage.json](../output/intern-list-investigation-2026-10-04/coverage.json) and the adjacent `intern-*-bulk.json` files. These counts are raw feed inventory, not accepted/eligible roles and not yet imported into `output/live/internships.db`. No Jobright Original-post pages were opened for this check.

The existing extractor parsed every fresh row without extraction drops. Its lightweight relevance pass retained 5,579 SWE, 1,301 AI/ML, 21,264 US engineering, and 718 Canada engineering listings for deeper role review; it fast-rejected 13, 5, 73, and 0 respectively. These are early routing counts, not final internship or eligibility counts. The detail is in [listing-relevance.json](../output/intern-list-investigation-2026-10-04/listing-relevance.json).

The measured engineering response finished in 2.369 seconds including the adapter's probe, bulk retrieval, and parsing. This is one observed timing, not a deadline guarantee. The bounded production path is an exact-total bulk request capped at 30,000 rows with an opt-in 48 MB response-body limit for the Intern List POST only; ordinary HTTP keeps the existing 12 MB limit. The response stays out of the disk cache because it exceeds the unchanged 12 MB cache-write threshold. Within a crawl, the adapter's shared category promise avoids repeating the same feed request for root and explicit SWE URLs.

## Fresh targeted database refresh

Run 707 refreshed only the four Intern List URLs above in the existing live database with `cacheTtlMs: 0`, `maxDepth: 0`, and `maxPagesPerSource: 1`. It ran from 2026-10-05 00:29:25.937 UTC through 00:31:19.921 UTC (8:29:25–8:31:19 p.m. Toronto time on October 4). The initial sandbox-only attempt, run 706, was denied network access and recorded four `source_unavailable` outcomes with zero inspected rows; the network-enabled rerun below superseded those source-health rows. Neither run opened a browser. Run 707 is the latest completed run, all four sources settled, and no other configured sources were run.

The feeds changed between the uncached inventory capture at 23:59 UTC and this refresh. In run 707, every returned bulk row had a unique ID and matched the advertised total:

| Configured URL | US feed rows / unique IDs | Shared Canada rows / unique IDs | Extracted rows inspected by that URL | Accepted roles | Qualifying roles without cached destination | Failures | Source result |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| `/` (default SWE) | 5,589 / 5,589 | 720 / 720 | 6,309 | 13 | 3,678 | 0 | partial; coverage incomplete |
| `?k=aiml` | 1,303 / 1,303 | 720 / 720 | 2,023 | 4 | 647 | 0 | partial; coverage incomplete |
| `?k=eng` | 21,332 / 21,332 | 720 / 720 | 22,052 | 0 | 5,860 | 0 | partial; coverage incomplete |
| `?k=swe` | 5,589 / 5,589 | 720 / 720 | 6,309 | 13 | 3,678 | 0 | partial; coverage incomplete |

Each source note confirms the selected US feed and shared Canada feed were fully fetched. The adapter made nine network requests in total, recorded zero cache hits and zero browser navigations, visited eight structured snapshots, and inspected 36,693 source rows across the four configured URLs. The total counts repeated Canada rows once per configured URL and repeated SWE rows for root and `?k=swe`; they are not a unique cross-category role count. All four `completed` flags are true, but all four final statuses are `partial` and `coverage_complete=0` because qualifying Jobright listings lack verified employer destinations in the durable resolver cache. Anonymous Original-post pages were not opened. The refresh discovered 30 accepted source-role appearances (13, 4, 0, 13); 13 were unchanged, zero were new or updated, and zero were closed. As designed, none of these partial sources participated in missing-listing reconciliation, so their previous rows and lifecycle history remain intact.

Engineering took 109.2 seconds to classify its 22,052 rows; the full targeted run took 113.7 seconds. This is the cost of analyzing the full feed inventory, not of visiting thousands of employer pages. The adapter/crawler and HTTP focused tests passed 45/45, and the production build and scoped lint passed. The saved run output is [targeted-refresh-network.log](../output/intern-list-investigation-2026-10-04/targeted-refresh-network.log). The unsuccessful sandbox attempt is [targeted-refresh.log](../output/intern-list-investigation-2026-10-04/targeted-refresh.log).
