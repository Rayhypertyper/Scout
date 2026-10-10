# Crawl error investigation — October 10, 2026

All 53 pasted error entries were reconciled to 53 unique failed_pages rows in the live database. Each entry received its own GPT-6 Luna worker (53 workers total, up to three running concurrently because this session has four total agent slots). The code changes address timeout budgets, alternate retrieval, cached outage recovery, failure classification, and retry accounting. They were compiled for the next scheduled worker. Historical audit rows were preserved.

The incident spans crawls #800–802. Crawls #800 and #801 exceeded their wall-clock limits; #802 settled with source-level errors. The logs establish transport failures but do not establish whether the underlying trigger was the local network, an upstream edge, or another connectivity interruption. It would be inaccurate to attribute all errors to one cause, or to claim that these changes eliminate future network outages.

## Recovery evidence and source retention

The latest completed crawls #803–805 already had zero recorded failures for every affected source **before this patch**. That historical recovery is independent evidence that the URLs/feeds did not need blanket deletion. It is not a post-patch live validation. The database was opened read-only; source-history evidence is saved in [evidence.json](../output/crawl-remediation-2026-10-10/evidence.json).

Keep didtheboysgrindleetcodetoday.com. Its latest crawl refreshed all 30 company feeds and found 41 qualifying jobs from 3,379 board records, with complete coverage. Over the three-week lookback, 348 source runs were recorded and 344 completed, with 13079 summed discoveries across runs (repeated observations, not unique new jobs). The condition for removing a source that has returned nothing for weeks is not met.

Latest affected source results (#805):

| Source | Qualifying jobs | Recorded failures | Coverage | Source status |
| --- | ---: | ---: | --- | --- |
| [csjobs.ca](https://csjobs.ca/internships/toronto) | 23 | 0 | Complete | success |
| [didtheboysgrindleetcodetoday.com](https://didtheboysgrindleetcodetoday.com/jobs) | 41 | 0 | Complete | success |
| [earlycareerradar.com](https://earlycareerradar.com/summer-internships?locations=all) | 5388 | 0 | Complete | success |
| [github.com](https://github.com/DereC4/internships-and-newgrad) | 2419 | 0 | Complete | success |
| [github.com](https://github.com/SimplifyJobs/Summer2027-Internships) | 1 | 0 | Complete | success |
| [www.intern-list.com](https://www.intern-list.com/) | 0 | 0 | Incomplete | partial |
| [www.useno.app](https://www.useno.app/resources/internship-masterlist) | 1152 | 0 | Incomplete | success |
| [zshah101.github.io](https://zshah101.github.io/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships) | 1174 | 0 | Complete | success |

Useno remains incomplete because its public anonymous feed exposes only a preview of the advertised inventory. Intern List also remains partial: public pages can expose placeholder titles, broken Apply anchors, retired Load More routes, or application destinations requiring sign-in. A lack of transport failures does not establish complete, usable inventory. Neither source's incompleteness was hidden or upgraded to trusted coverage.

## Applied remedies

| Code | Affected entries | Investigation and disposition |
| --- | --- | --- |
| U | 01, 35 | Useno root and first-party feed pagination inherited a roughly 10-second timeout from the general client. Added an explicit 30-second budget to both resource collectors and paginated feed requests. Pagination tests verify the request budgets. |
| R | 02 | Radar HTML and API failures were flattened into one generic HTTP error, losing transport types and attempt totals; cache=false discarded outage recovery. Requests now revalidate a stored public response, retain expired data only on eligible transport failure, preserve both typed failure paths, count their attempts, and propagate cancellation before fallback. Stale inventory stays incomplete. |
| G | 03–32 | All 30 company calls to the same Convex endpoint failed in #802. Each row displayed the **60 retries summed across all feeds**, rather than its own two retries, and fetch failures were labeled HTTP errors without a response status. The client now records each feed's attempts and network/timeout/access/rate-limit/HTTP/parse type, uses a one-second exponential backoff, keeps successfully cached company data during partial outages, and propagates cancellation. The crawler reports per-feed retries and marks partial snapshots stale/incomplete. |
| Z | 33–34 | zshah's dashboard is the full inventory; its README is a limited fallback. Dashboard and GitHub requests now have a 30-second budget. The actual dashboard failure remains a typed failure even if the limited README succeeds, so deferred retries and incomplete coverage remain visible. A malformed/truncated dashboard export is reported as a parse error. |
| I | 36–42, 47–53 | Detail, listing, root, and sitemap requests suffered transport failures during the same incident window. Narrowed Intern List to at most two concurrent HTTP requests per hostname; enabled existing stale-if-error recovery for successful prior public responses. Corrected exhausted-request totals to include the initial request. Stale root/tab/listing/sitemap/detail inventory parts remain incomplete. Missing cached data still yields a real failure; malformed public records are not invented. |
| H | 43–45 | Raw GitHub file timeouts previously ended file retrieval even when the contents API was available. A transient download failure now tries the contents API, then the raw fallback, with explicit 30-second budgets and complete attempt accounting. Cancellation/deadline/watchdog errors propagate through every fallback. All paths exhausting still produces a typed file failure. |
| C | 46 | This specific CSJobs detail URL already had a 30-second timeout, three retries, two-request origin lane, and stale-if-error recovery. Extending retries further or deleting the source was not justified. The exact page was opened successfully in the in-app browser; later source runs recovered with complete coverage. Existing CSJobs discovery/fallback tests pass. |

An additional read-only review found stale Intern List inventory parts could remain individually marked complete despite the top-level incomplete flag. This was repaired for root, SSR tab, listing pagination, sitemap and dependent details, with four focused regression cases.

## Every pasted error

Numbers follow the pasted report's order. Request links are the exact URLs from the full pasted entry. The final column is later **source-level** recovery, not proof that the same detail URL was fetched again. Original historical retry counts below are preserved; new Convex failures report per-feed counts.

| Error | Source / exact failed request | Crawl | Recorded failure | Remedy | Later source evidence |
| ---: | --- | ---: | --- | --- | --- |
| 01 | [Useno masterlist](https://www.useno.app/resources/internship-masterlist) | 802 | timeout; 2 retries | U | #805: 1152 jobs; 0 failures; coverage incomplete |
| 02 | [Early Career Radar listing](https://earlycareerradar.com/summer-internships?locations=all) | 802 | http_error; 0 retries | R | #805: 5388 jobs; 0 failures; coverage complete |
| 03 | [Grind / Jane Street](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 04 | [Grind / Coinbase](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 05 | [Grind / DoorDash](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 06 | [Grind / Roblox](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 07 | [Grind / Netflix](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 08 | [Grind / Adobe](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 09 | [Grind / Uber](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 10 | [Grind / Discord](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 11 | [Grind / Duolingo](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 12 | [Grind / Datadog](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 13 | [Grind / Airbnb](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 14 | [Grind / Pinterest](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 15 | [Grind / GM](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 16 | [Grind / Netsmart](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 17 | [Grind / H&R Block](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 18 | [Grind / OPPD](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 19 | [Grind / Anthropic](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 20 | [Grind / OpenAI](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 21 | [Grind / Apple](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 22 | [Grind / Databricks](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 23 | [Grind / Stripe](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 24 | [Grind / Salesforce](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 25 | [Grind / NVIDIA](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 26 | [Grind / Google](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 27 | [Grind / T-Mobile](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 28 | [Grind / WellSky](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 29 | [Grind / Atlassian](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 30 | [Grind / Microsoft](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 31 | [Grind / Amazon](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 32 | [Grind / Garmin](https://bright-shrimp-175.convex.cloud/api/query) | 802 | http_error; 60 retries | G | #805: 41 jobs; 0 failures; coverage complete |
| 33 | [zshah dashboard / combined source result](https://zshah101.github.io/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships) | 801 | source_unavailable; 3 retries | Z | #805: 1174 jobs; 0 failures; coverage complete |
| 34 | [zshah / README.md](https://raw.githubusercontent.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships/main/README.md) | 801 | timeout; 2 retries | Z | #805: 1174 jobs; 0 failures; coverage complete |
| 35 | [Useno masterlist](https://www.useno.app/resources/internship-masterlist) | 801 | timeout; 2 retries | U | #805: 1152 jobs; 0 failures; coverage incomplete |
| 36 | [Intern List / Medpace feasibility informatics](https://www.intern-list.com/data-science-internships/feasibility_informatics_internship_co_op_spring_2027_at_medpace_77901437) | 801 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 37 | [Intern List / Deltek data science](https://www.intern-list.com/data-science-internships/data_science_intern_customer_analytics_and_data_enablement_at_deltek_34538393) | 801 | timeout; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 38 | [Intern List / Xcel Energy data science](https://www.intern-list.com/data-science-internships/data_science_intern_co_mn_at_xcel_energy_18487974) | 801 | timeout; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 39 | [Intern List / Roche industrial placement](https://www.intern-list.com/data-science-internships/data_science_industrial_placement_multiple_roles_within_biostats_data_management_real_world_data_and_more_at_roche_73876044) | 801 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 40 | [Intern List / Nokia data science](https://www.intern-list.com/data-science-internships/data_science_co_op_intern_at_nokia_97305728) | 801 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 41 | [Intern List / Booz Allen Honolulu](https://www.intern-list.com/da-intern-list/university_2027_summer_games_data_scientist_intern_honolulu_hi_at_booz_allen_hamilton_50198459) | 801 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 42 | [Intern List / Booz Allen Huntsville](https://www.intern-list.com/da-intern-list/university_2027_summer_games_data_scientist_intern_huntsville_al_at_booz_allen_hamilton_61273132) | 801 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 43 | [Simplify / README.md](https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md) | 800 | timeout; 2 retries | H | #805: 1 jobs; 0 failures; coverage complete |
| 44 | [Simplify / README-Inactive.md](https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README-Inactive.md) | 800 | timeout; 2 retries | H | #805: 1 jobs; 0 failures; coverage complete |
| 45 | [DereC4 / README.md](https://raw.githubusercontent.com/DereC4/internships-and-newgrad/main/README.md) | 800 | timeout; 2 retries | H | #805: 2419 jobs; 0 failures; coverage complete |
| 46 | [CSJobs / Resource Innovations job 391431](https://csjobs.ca/jobs/391431/energy-engineering-intern-at-resource-innovations) | 800 | timeout; 3 retries | C | #805: 23 jobs; 0 failures; coverage complete |
| 47 | [Intern List / project management](https://www.intern-list.com/pm-intern-list) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 48 | [Intern List / accounting and finance](https://www.intern-list.com/accounting-and-finance-intern-list) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 49 | [Intern List / data analyst](https://www.intern-list.com/da-intern-list) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 50 | [Intern List / software engineering](https://www.intern-list.com/swe-intern-list) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 51 | [Intern List / marketing](https://www.intern-list.com/mkt-intern-list) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 52 | [Intern List / sitemap.xml](https://www.intern-list.com/sitemap.xml) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |
| 53 | [Intern List / root](https://www.intern-list.com/) | 800 | network_error; 1 retries | I | #805: 0 jobs; 0 failures; coverage incomplete |

The full original entry, exact matched failure row and later source result for each error are preserved in [errors.json](../output/crawl-remediation-2026-10-10/errors.json). Individual worker memos are in [agent-notes](../output/crawl-remediation-2026-10-10/agent-notes/). Some early memos lacked nested request text or consulted an older database; the reconciled evidence above supersedes those historical-data claims.

## Validation and runtime readiness

- 159 focused tests passed in 20 files: 145 crawler/HTTP/cache/source-health tests in 18 files, plus 14 adapter routing/discovery tests in two files. This includes the 30-feed outage, per-feed retries/types, raw-to-API fallback, exhausted fallback accounting, cancellation, stale cache recovery, conservative coverage, Intern List concurrency and Useno pagination budgets.
- TypeScript type checking passed; the production build passed; ESLint passed for all 15 edited source/test files; git diff --check passed.
- Compiled dist/src/index.js dependencies contain these changes. The scheduler starts a fresh index.js worker each run, so the next scheduled crawl loads the compiled repairs. No live run was interrupted and no historical failure rows were rewritten.
- The exact CSJobs job 391431 page loaded in @Browser. The Medpace Intern List detail also loaded; its visible heading was the placeholder “Heading” and Apply Now pointed to the page's # anchor, confirming an independent public-data defect.

Validation logs are saved beside the evidence. No new full live crawl was launched after the patch; recovery evidence above predates these changes.

The broad npm test run recorded 1,045 passing tests, 49 failures, and 31 skipped tests. One failure was a temporary-directory cleanup race in the HTTP test harness; cleanup retries were added, and the final HTTP suite passes. The remaining 48 assertions concern existing UI/operations/database-fixture/source-configuration/disabled-parser/scheduler expectations outside this repair. Their files and counts are listed below; the full suite was not rerun after the final focused fixes. Global lint also encounters existing frontend declaration/extension-fixture errors; edited files pass their scoped lint check.

| Full-suite failure file | Failed tests in the broad run |
| --- | ---: |
| tests/accessibilityMarkup.test.ts | 5 |
| tests/crawlerLlmFallback.test.ts | 5 |
| tests/frontendAssetLoading.test.ts | 3 |
| tests/frontendFeedPerformance.test.ts | 3 |
| tests/http.test.ts | 1 |
| tests/legal.test.ts | 3 |
| tests/operations.test.ts | 10 |
| tests/operationsClient.test.ts | 2 |
| tests/ownerAnalytics.test.ts | 3 |
| tests/privacy.test.ts | 4 |
| tests/publicSeo.test.ts | 5 |
| tests/publicSources.test.ts | 3 |
| tests/runControl.test.ts | 1 |
| tests/runtimePerformance.test.ts | 1 |

## Changed implementation files

- src/crawler/useno.ts — request budgets.
- src/crawler/http.ts — explicit revalidation policy, safe in-flight policy identity, Intern List origin concurrency.
- src/crawler/adapters/earlyCareerRadar.ts — cached outage recovery, typed failures, cancellation and stale coverage.
- src/crawler/adapters/internList.ts — cached recovery, attempts and inventory-part completeness.
- src/crawler/githubAdapter.ts — timeout/fallback, failure visibility and attempt/cancellation propagation.
- src/integrations/grindJobBoard.ts — feed-level attempt/type accounting and backoff.
- src/crawler/crawler.ts — Convex failure mapping and conservative stale state. Its already-disabled OpenAI parser fallback was preserved; the unused parameter was renamed for type checking.

The workspace contained unrelated uncommitted work before this task. Those changes were preserved; no broad reset, commit or source-list removal was performed.
