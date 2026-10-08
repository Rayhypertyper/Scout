# Scout editions: implementation and filter audit

Implemented on August 30, 2026. One crawler and one canonical job representation support both editions. No separate per-user crawl or permanent personal/public code fork was added.

## Run locally

```sh
npm run dashboard:dev
```

Open `http://127.0.0.1:4173/jobs`. The compact **Local edition** select shows the active Public or Personal edition. Changing it posts to the local server, updates the server's in-memory profile and score defaults, invalidates edition-sensitive caches, then reloads the application. It does not edit an environment file or just toggle frontend components.

To inspect the UI without starting a crawl or refreshing the live board:

```sh
DASHBOARD_SKIP_STARTUP_SCAN=1 DASHBOARD_SKIP_LIVE_BOARD=1 npm run dashboard:dev
```

Both views use the same configured database and sources. Switching does not create, delete, or recrawl jobs. Jobs previously skipped by personal acquisition become available after a subsequent public crawl, not merely after switching the UI. Already-running scans finish with their captured edition; queued and future scans use the new edition. Restarting the server restores `SCOUT_EDITION` (or the safe Public default).

## Fixed production deployments

```sh
NODE_ENV=production SCOUT_EDITION=personal npm run dashboard
NODE_ENV=production SCOUT_EDITION=public npm run dashboard
```

Use the appropriate command in separate server deployments with their own database/output configuration. These are configuration examples, not deployments performed by this change. Keep the personal deployment private to its owner or trusted administrators.

`SCOUT_EDITION` is resolved server-side to a typed profile in `src/config/edition.ts`. Missing or invalid values resolve to Public. Production always returns 404 for both reads and writes to `/api/dev/edition`, even if `SCOUT_ENABLE_EDITION_SWITCHER=true` was accidentally set. No switcher markup is present in the static HTML.

Outside production, the switcher is available for the plain local dashboard when `NODE_ENV` is unset and no switcher setting is supplied, for `NODE_ENV=development`, or when `SCOUT_ENABLE_EDITION_SWITCHER=true`. It also requires a loopback network peer and loopback Host header. Missing peer information, remote hosts, cross-origin writes, mismatched ports, and cross-site browser requests fail closed. Forwarded headers cannot grant access. IPv4 and IPv6 loopback are supported. Invalid switch requests return 400 without changing the active edition. The endpoint is never cached.

The local control is process-wide, not an account setting. All tabs on that local server share it; each reload reads the active server edition. It is not a public-user feature or an authorization mechanism for a public admin account.

## Pipeline audit: before and after

The inspected checkout already had a conditional `shouldFetchDetail` result in the listing scorer, rather than an unconditional `true`. However, the generic HTTP and static-detail call sites used relevance for diagnostics/prioritization and did not turn that result into the requested edition-specific network policy. Browser discovery also lacked this policy. The new acquisition decision is the authoritative routing boundary; the scorer's legacy routing fields are retained for compatibility.

| Stage | Existing filters/behavior | Refactored responsibility |
| --- | --- | --- |
| Discovery | URL/protocol normalization, robots, link relevance/host/depth budgets, source-specific discovery, deduplication, title/department/snippet scoring | Universal safety remains. Personal-only conservative acquisition is applied before expensive details; Public retains candidates regardless of personal relevance. |
| Detail fetching | HTTP/cache/validator/known-URL paths, source adapters, browser fallback, unavailable-page and direct-destination checks | Shared paths remain. Known canonical jobs stay on lifecycle/cache verification paths. Fully structured feed records are not rejected just to claim network savings. |
| Classification | Category and qualification extraction mixed with title exclusions, technical score/category admission, and Canada/US/remote restrictions | Both editions explicitly pass the same canonical admission: score floor 0, nontechnical internships tagged `other-internship`, personal title exclusions disabled. Geography is recorded rather than globally rejected. |
| Persistence | Global score-60 admission and score-based deletion when opening the DB; the reprocessing command also deleted low-score records | Canonical retention is independent of personal visibility. Startup and reprocessing no longer delete low-score jobs. Reprocessing preserves a valid fallback category. Existing schema, lifecycle, and provenance relations remain. |
| Display/export | Technical + placement vocabulary, excluded titles, score, security clearance, geography and authorization rules; user matching on stored jobs | Personal retains its compatibility visibility rules. Public All shows the broader canonical corpus. Matches uses the existing authenticated preferences and eligibility engine. Report and link-verification selection now respect the edition. Deadline caches also distinguish editions. |

## Hard-coded rule ownership

| Bucket | Rules | Decision |
| --- | --- | --- |
| A — universal safety/quality | HTTP(S) URL validation and canonicalization; tracking/credential stripping; robots; access-control and CAPTCHA handling; depth/page/source budgets; deduplication; dead/unavailable destinations; known sandbox exclusion; complete job evidence; objective internship detection; verified LinkedIn destinations | Remain shared because they establish safe retrieval, identity, or trustworthy listing facts, not a user's interests. |
| B — canonical classification | Role category, technologies, raw/normalized locations, remote scope, term/year/duration, education/graduation/enrollment, work authorization and sponsorship, security-clearance evidence, quality score, provenance, lifecycle | Remain shared extraction. A US-citizenship requirement, foreign location, or low technical score does not itself remove the canonical job. Clearance recognition is reused from the shared parser; no duplicate preference schema was introduced. |
| C — edition acquisition | Strong nontechnical title evidence with no technical or ambiguous corroboration | Personal may avoid a new detail request. Public does not use this reject. Source configuration remains server/operator configuration, never derived from an individual user's preferences. |
| D — user matching/visibility | Term/year; country/city/remote; category and technology interests; degree, graduation, study year/enrollment/returning to school; work authorization; sponsorship | Existing persisted preferences and eligibility rules are reused. Confirmed hard eligibility failures are excluded; soft preference fit and missing evidence are ranked/reported separately. Legacy personal title/year/duration, technical-keyword, clearance and regional gates remain an explicit downstream compatibility policy, not public canonical admission. |

No new account preference fields were added in the edition work. The main move was separating existing user preference evaluation from global crawler/storage admission. In particular, the fixed title rules (`2026` without `2027`, new-grad, PhD, and 12-month wording), technical-only score floor, and regional/clearance compatibility are no longer global public-corpus rules.

## Exact early-rejection conditions

Personal acquisition rejects only when all of the following hold:

1. The profile allows high-confidence early rejection.
2. The existing relevance rules report clearly irrelevant evidence.
3. At least one negative rule matches the **title**, not just a department or snippet.
4. No positive technical title rule matches.
5. No ambiguous title rule matches.
6. No positive department/team or snippet rule matches.
7. The candidate is not an already-known canonical identity needing lifecycle verification.

There is no score-threshold-only reject. Technology, Engineering, Research, Systems, Technical, and Automation Intern stay on the detail path. Technical department/snippet evidence rescues otherwise-negative titles. Public keeps even strongly nontechnical candidates. Unknown metadata is not converted into user ineligibility.

This remains a conservative listing-evidence heuristic, not a guarantee of perfect recall. Structured feeds whose full records are already available are classified directly: dropping them would not save a detail request. Existing source selectors and query restrictions still determine what metadata is discoverable.

## Matching, caches, and performance safeguards

Each Matches HTTP request authenticates once, reads the user's preferences once, compiles normalized preference and eligibility sets once, and evaluates the stored roles in memory. Matching does not fetch pages, query preferences inside the role loop, or mutate canonical jobs. Preference edits take effect on the next Matches request without a recrawl. User results are not placed into the shared All-view cache.

The matcher exposes two deliberately separate axes. `eligible` and the
versioned eligibility status mean that no confirmed hard requirement failed;
unknown or conflicting extraction remains visible and does not establish a
positive fit. `matched` is the positive-fit gate used by `compileMatcher` and
the authenticated Matches list. The versioned `matching-v2` score is bounded
to 0–100 and breaks down role category, technology, term, location, relevance,
freshness, and total. Its status is `recommended`,
`recommended_with_uncertainty`, `insufficient_fit`, or `excluded`.

The explanation order is concise positive reasons, uncertainty/conflict,
soft preference mismatches, and insufficient-fit context. Matches cards show
positive reasons first and retain at least one uncertainty when present.
Request-local diagnostics report evaluated, recommended, filtered, hard
excluded, insufficient-fit, and uncertain counts without returning profile
answers or raw posting evidence. These diagnostics are private and are not
persisted with canonical roles.

Default listing regexes are compiled once at module initialization. Custom rule overrides keep their existing API. Existing HTTP and static-adapter identity lookups, content hashes, validators, TTL skips, retries, known URLs, source concurrency, per-host rate limits, browser reuse, cancellation, run locks, and the serialized SQLite writer lane are preserved.

The browser acquisition path does not add one database query per discovered link: if a negative candidate requires a known-identity check, it lazily reads one identity-only URL set for that source, including closed jobs, without parsing stored job bodies. Public and ambiguous/technical candidates do not need that extra lookup. Older custom persistence hooks without the bulk identity API conservatively keep candidates instead of risking a known-job reject.

The edition is included in role, filter, index/inflight, detail ETag, change ETag, and deadline-cache boundaries. Switching invalidates the active index/filter caches. This prevents a previous personal response from being reused as the public representation, including after an `If-None-Match` request.

### Measurements

Run the repeatable CPU comparison with:

```sh
npm run perf:editions
```

The script uses three warmups, fifteen paired samples, and 10,000 operations per sample, and checks equivalent scoring checksums. The baseline side exercises repeated regex/profile compilation; the after side reuses compiled structures. These are local CPU measurements, not a whole-network crawler benchmark or a promise of equivalent wall-clock speedups.

| 10,000 operations, paired median | Repeated setup | Compiled setup | Reduction |
| --- | ---: | ---: | ---: |
| Listing relevance scoring | 612.58 ms | 31.42 ms | 94.9% |
| Stored-role user matching | 66.64 ms | 54.29 ms | 18.5% |

Raw samples are in `docs/benchmarks/scout-editions-2026-08-30.json`. A prior lower-contention paired run measured 542.23 → 29.26 ms and 57.23 → 49.17 ms; the variation is why these results are reported as CPU microbenchmarks, not end-to-end service guarantees. Before implementation, the separately captured seven-sample local medians were 553.94 ms and 55.92 ms respectively; those are not the paired baseline used in the table.

Deterministic crawler tests additionally prove that an unknown Marketing Intern skips the browser detail navigation in Personal but is detail-fetched in Public, that ambiguous titles are fetched, and that known identities are rechecked. Existing fast-path, cache, run-control, and dashboard performance-budget tests still pass. No live network corpus benchmark was performed.

## Diagnostics and source privacy

`CrawlMetrics` adds `discovered`, `detailFetched`, `earlyRejected`, and `canonicalRolesCreated`, carried into progress/source metrics and the existing metrics ledger. `compileMatcher().diagnostics` supplies request-local `evaluated`, `userMatched` (roles with `matched=true`), and `userFiltered`; Matches responses add bounded hard-exclusion, insufficient-fit, and uncertain counts. These counters are never included in public All responses.

These are pipeline counters, not all unique database inserts. In particular, `canonicalRolesCreated` counts canonical records emitted/retained by a source, including cached records; use the existing run `new_count` for newly inserted jobs. `discovered` is source-path listing evidence, not a global distinct-job count. Detailed reject reasons include field evidence, remain server-side, and are limited to 100 returned reasons per source. Existing HTTP/browser counters remain the source of truth for actual transport work.

Public browser responses omit source URLs/provenance, source health/results/failures, run internals, crawler strategy details, and private relevance diagnostics. List, detail, application, status and change responses use the server capability boundary. Public search also excludes private source text. `/api/data` is retired in every edition and returns 410. `/api/sources`, `/api/refresh`, `/api/scan`, and `/api/terminate` return 404 in Public. The frontend hides source/admin controls using the server capability, but API enforcement—not hiding controls—is the security boundary.

The server-private database and administrator-generated reports still contain provenance and diagnostics by design. They must not be published as public static assets. Public crawling can continue through server/operator workflows; a public browser cannot administer the crawler.

## Verification

- `npm run check`: passed TypeScript, ESLint, and 559 tests across 60 passing files; 2 pre-existing skipped tests remain in 1 skipped file.
- `npm run build`: passed.
- Added edition configuration/default/production-lockout tests, strict local-origin and IPv6 guards, client reload/error behavior tests, public API privacy and edition-cache tests.
- Added actual HTTP preference-edit tests proving one preference read and one matcher compile per Matches request, immediate changed results, no crawler invocation, and unchanged canonical rows/run history.
- Added low-score persistence and reprocessing retention tests, report selection tests, browser detail-count regressions, known/closed identity protection, and edition-aware deadline tests.
- The original checkout had missing/ignored `src/output` source modules that broke typechecking and four test suites. Those source modules were restored and the ignore rule anchored to root `/output/`, so source files are included while generated output remains ignored.
- Live in-app browser QA could not complete: automatic approval was blocked by an account usage limit. The attempted QA server used a separate temporary database, not the user's crawler database. No visual/live-browser success is claimed.

## Deliberately retained architecture debt

1. This is the shared-edition foundation, **not a completed multi-tenant SaaS launch**. Preferences are account-keyed, but existing saved/applied/hidden listing actions and application stages still belong to the single SQLite workspace. They need tenant isolation and authorization before a shared public deployment accepts multiple users' actions.
2. Personal production is an owner/admin deployment. Public crawler administration is disabled rather than replaced with a new administrator-role system.
3. Preference country selection and eligibility taxonomy remain Canada/US-focused. Foreign canonical jobs are retained, but fully supported international matching needs a broader preference taxonomy. Nontechnical roles currently use `other-internship`, not a new profession taxonomy.
4. Source catalogs, provider-specific selectors, owner query parameters, and sparse live-board projections were not redesigned. A broad profile cannot discover jobs excluded by a configured source itself. The sparse live Grind dashboard projection retains its historical gates; stored canonical records use the public policy.
5. Legacy personal hard-coded visibility defaults have not all been converted into editable owner preference fields. They are isolated downstream to preserve the current personal experience. Low-level analyzer compatibility options remain; shared crawler entrypoints explicitly pass the user-independent canonical profile.
6. Existing per-listing identity/cache reads and the broader eligibility engine were not rewritten wholesale. The new matching path avoids preference reads per job and reuses compiled structures; deeper batching or durable per-user result caching would be a separate optimization.
7. Old crawls cannot recover jobs that were never fetched or were previously purged. A subsequent shared public crawl is necessary to populate that missing corpus. Switching alone does not rewrite history.

No commit, deployment, source-catalog migration, or rewrite of the user's existing database was performed. Unrelated in-progress auth, landing-page, onboarding, privacy, and terms changes were preserved.
