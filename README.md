# Internship Scout

Internship Scout is a deterministic TypeScript/Node.js crawler that starts from company career pages, university recruiting pages, individual job URLs, or GitHub internship-list repositories. It is HTTP-first: known structured adapters and shared HTTP/static parsing run before any browser fallback. It keeps roles with meaningful programming work, resolves the closest stable application page, and remembers results in SQLite.

It never fills or submits an application form.

## Requirements and installation

- Node.js 24 or newer (the database uses the built-in `node:sqlite` driver)
- npm
- Chromium installed through Playwright

```bash
npm install
npx playwright install chromium
```

Copying `.env.example` is optional for crawler-only runs. Copy it (or provide the
same variables through your process manager) before using the account
authentication routes; the defaults still write the database and exports under
`./output`.

## Configure sources

Edit [`src/config/sources.ts`](src/config/sources.ts):

```ts
export const SOURCES = [
  "https://company.example/careers",
  "https://github.com/example/internship-list",
  "https://boards.greenhouse.io/example",
];
```

Add or remove URLs only in that array; crawler code does not need to change. For one-off runs, repeat `--source` on the command line. Command-line sources replace the configured list for that run.

## Run the scout

```bash
npm run scout
```

For a raw, page-faithful snapshot of the Toronto CSJobs internship section,
including every visible card and rendered page text, run:

```bash
npm run crawl:csjobs:toronto
```

This writes `output/csjobs-toronto/page-snapshot.json` and
`output/csjobs-toronto/page-internships.csv`. It caches the page and uses
conditional validators on later runs; the normal `npm run scout -- --source
https://csjobs.ca/internships/toronto` command continues to fetch and
incrementally verify detail pages.

For the Intern List/Jobright feed, use the dedicated structured crawl:

```bash
npm run crawl:intern-list -- "https://www.intern-list.com/?k=swe"
```

It retrieves the page context and the selected U.S. category feed, first
probing one small page, then requesting the feed's advertised total when
possible and using bounded offset pages for larger feeds. The root/default view
uses the configured software feed and its **Canada** tab route; explicit
`?k=...` URLs select their configured category feeds. Each feed is validated
independently.
Responses are cached with the shared retry/rate-limit transport, records are
deduplicated by Jobright ID. The recurring scout consumes a durable
Jobright-to-employer/ATS destination cache and does not open Jobright detail
pages during the crawl. The separate bounded resolver reads each rendered
detail page's exact **Original Job Post** anchor href and incrementally fills
that cache. Listings whose employer/ATS destination is not cached are omitted
rather than emitting a Jobright detail URL. The output is marked incomplete unless
every feed's total and unique retrieved IDs agree. Results are written under
`output/intern-list-crawl/`.

### Run automatically on macOS

The crawler can run independently of ChatGPT through macOS `launchd`. Install the
included LaunchAgent once from the project directory:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp scripts/com.internshipmatic.scout.plist "$HOME/Library/LaunchAgents/"
cp scripts/com.internshipmatic.jobright.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.internshipmatic.scout.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.internshipmatic.jobright.plist"
```

It starts at 7:00 AM local time and then runs every 90 minutes through 11:30
PM. It does not start crawls between midnight and 7:00 AM. The Mac must be on
and the user must be logged in, but ChatGPT does not need to be open. Logs are
written to
`output/live/launchd.stdout.log` and `output/live/launchd.stderr.log`.
The LaunchAgent runs the compiled build in `dist/`; `npm run scout` also builds
before starting so manual/scheduled invocations cannot execute a stale bundle.
Run `npm run build` explicitly after changing TypeScript source or source
configuration when using the LaunchAgent.

The companion Jobright resolver LaunchAgent runs 30 minutes before each scout
slot. It has a separate 20-minute cap and writes only the durable destination
cache, so a slow Jobright page cannot extend or block the crawl.

The dashboard's one startup scan is disabled by the checked-in dashboard
LaunchAgent; its compact-index prewarm does not perform a crawl. Prewarm
failures or timeouts do not disable crawling. The recurring schedule is owned
by this scout LaunchAgent, and both it and the dashboard honor the same
heartbeat lease so they cannot start duplicate crawls. `DASHBOARD_SKIP_STARTUP_SCAN=1`
is an explicit switch used by the dashboard LaunchAgent and local/test runs.

The scheduled source list includes Useno's public
`https://www.useno.app/internship-masterlist` page. Its dedicated parser selects
the software and data categories, excludes early-career rows and locations
outside Canada, the United States, and remote work, and writes the filtered
snapshot to `output/useno-internship-masterlist.json`. Run
`npm run crawl:useno-masterlist` to collect that source independently. The
legacy Summer 2027 parser and `npm run crawl:useno` command remain available for
historical snapshots.

Only one crawl may own a database at a time, even when the dashboard and
launchd are both enabled. A crawl has a hard 45-minute wall-clock limit, and a
heartbeat-stale run is recovered after 20 minutes without a heartbeat. A requested
termination finalizes the run as `FAILED`, and a crawl cannot close a listing
that it rediscovered in the same pass.

Each source has a five-minute wall-clock budget on the normal pass. A source that
exceeds it is aborted and deferred until all other sources finish; it receives one
15-minute retry at the end, and an exhausted retry is recorded as unavailable so
the rest of the run can still complete. Emitting progress does not extend these
budgets.

Run ownership is enforced by SQLite before a run is created, and the active
run renews a heartbeat lease while it crawls. The keep-alive relaunch therefore
waits for the current process to exit before starting the next crawl. A
dashboard restart or manual invocation observes the existing run and exits
without starting a second writer. If a process dies, a later run may recover
only an expired lease; the old process is also rejected if it later tries to
persist results. A user-requested cancellation is the exception: its durable
cancellation marker makes stale workers stop and lets the dashboard safely
finalize that specific run.

To stop it:

```bash
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.internshipmatic.scout.plist"
```

Examples:

```bash
npm run scout -- --location canada
npm run scout -- --location usa --category swe --category backend
npm run scout -- --category ml,ai --min-score 80
npm run scout -- --new-only
npm run scout -- --source https://company.example/careers --max-pages 50 -v
```

Run `npm run scout -- --help` for every option. Important crawl controls are `--max-depth`, `--max-pages`, `--http-concurrency` (24), `--browser-concurrency` (4), `--per-domain-concurrency` (3), `--timeout`, `--page-timeout`, and `--retries` (2). Staged defaults are connect 3s, read 7s, navigation 10s, selector 5s; identity-only detail rechecks use `detailRecheckTtlMs`. Their programmatic defaults live in [`src/config/settings.ts`](src/config/settings.ts).

Supported category filters are:

```text
swe frontend backend fullstack mobile qa devops cloud data ml ai
security embedded quant research other-code
```

A role can have more than one category, and uncategorized fallback roles receive
`other-code`. The legacy input alias `other` is accepted and normalized to
`other-code` for compatibility. Raw ingestion keeps only roles meeting the configured
category and target-geography rules. The explicit `--location` filter then
checks raw and normalized city, province/state, country, and remote-scope values.
In particular, `Remote`, `Remote Canada`, `Remote US`, and `Remote North America`
remain distinct; unspecified remote work is still treated as remote for
eligibility, not as a claim about worldwide hiring.

## Output

Every successful run writes:

- `output/live/internships.json` — validated structured records
- `output/live/internships.csv` — the same fields in spreadsheet-friendly form
- `output/live/internships.db` — persistent SQLite history
- a console summary with new, changed, unchanged, and closed counts

Missing posting fields are not invented. They remain `null`, `unknown`, or an empty array. Required and preferred qualifications are separate, as are education, graduation, experience, work-authorization, and sponsorship statements.

## Local results dashboard

Start the local dashboard from the project directory:

```bash
npm run dashboard
```

Then open [http://127.0.0.1:4173](http://127.0.0.1:4173). The checked-in
dashboard LaunchAgent disables an automatic crawl at startup. The **Check all
sources** button launches the full crawl in a separate scout worker and returns
immediately, so slow network/browser work cannot block the dashboard's HTTP
event loop. The dashboard watches the worker's SQLite run and refreshes its
compact index after the worker finishes.
The **Add source** button accepts a public careers page, ATS listing, job board,
or GitHub internship list and saves it to the dashboard's SQLite source catalog.
It is included in the current crawl when idle, or queued behind an active crawl.
Source extraction is deterministic—known ATS/API adapters, HTML/JSON-LD,
Markdown, and bounded browser fallback—so an LLM is not required. Login-only,
canvas-only, or heavily custom pages may still produce no roles.
The crawl persists newly discovered, updated, and closed roles in SQLite. The
page shows open/new/updated/closed roles, searches across descriptions and
technologies, keeps direct-apply, original-posting, and discovery-source links
together, and flags roles first discovered in the last 16 hours with a prominent `NEW
ROLE · Found in the last 16 hours` banner and highlighted card. The dashboard waits for an existing crawl if the background launchd
scout is already checking the sources. Use `--port 4174` if port 4173 is already
in use. While a crawl is active, the **Terminate run** button signals the
owning scout process, finalizes the run as `FAILED · TERMINATED`, leaves
already-persisted results intact, and immediately makes **Refresh** available
for a new run. The **Sources** panel shows each source's crawl duration, page
count, and roles found for the latest run. The CLI's `SOURCE HEALTH` table
reports the same duration breakdown.

Clicking **APPLIED** or **CAN'T FIT** marks that posting as handled and records
the decision, and removes the posting from the default dashboard and `/api/roles`
results. The raw database retains the historical record. The decision is stored with the
posting/application URL context, matches source copies on later scans, and
survives listing-ID changes while keeping separate requisitions for the same
employer visible.
Press **Ctrl+Z** (or **Cmd+Z** on macOS) to undo the most recent decision and show
the listing again.

The dashboard applies fixed title, relevance, location, eligibility, freshness,
content, link, and handled policies before roles appear in the active list.
These exclusions are part of ingestion and list construction; they are not
user-configurable dashboard checkboxes. Historical records remain available in SQLite
for lifecycle tracking, while excluded roles are absent from normal dashboard
and API results.

The dashboard reports crawler closures separately from listings hidden with
**CAN'T FIT**. A listing shown as closed by the crawler was not hidden by a
user decision.

The dashboard also folds the read-only Jobs board at
[`didtheboysgrindleetcodetoday.com/jobs`](https://didtheboysgrindleetcodetoday.com/jobs)
into the same **Open roles** list, search, filters, and actions as every other
source. The normal crawler and dashboard use the board's first-party structured
feed rather than the login-gated UI: they load current postings for all 30
tracked companies, keep last-known jobs when a company feed is temporarily
unavailable, and never store or send account credentials. The crawler writes a
durable board cache under `<output-dir>/source-cache/grind-job-board.json`,
rediscovers a rotated Convex host from the board's own bundle after a complete
feed failure, and records source timing/coverage in SQLite. **Check all sources**
forces a fresh Jobs-board sync as well as the normal crawler scan.

To keep the dashboard available automatically after login, install its optional
LaunchAgent once:

```bash
mkdir -p "$HOME/Library/LaunchAgents"
cp scripts/com.internshipmatic.dashboard.plist "$HOME/Library/LaunchAgents/"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.internshipmatic.dashboard.plist"
```

The lifecycle values mean:

- `NEW`: not matched to a prior record
- `UPDATED`: material extracted content changed, or a closed role reopened
- `UNCHANGED`: rediscovered with the same stable content hash
- `REMOVED_OR_CLOSED`: the direct page explicitly closed/expired or repeatedly disappeared from successfully scanned sources

Closed records remain in SQLite. A page missed once is retained to avoid transient false closures; `closedAfterMisses` controls the threshold. Explicit 404/410 and closure language take effect immediately.

## Account authentication

Scout uses Supabase Auth for email/password accounts, email verification,
password recovery, and persistent cookie sessions. The application never stores
passwords in its SQLite database and does not require a Supabase service-role
key. Auth tokens are handled only by the Node server through `@supabase/ssr`.

The repository also includes a reproducible Supabase database security contract
under [`supabase/`](supabase/README.md). It enables RLS on the account-owned
Postgres tables, revokes `anon` access, grants only the operations needed by
`authenticated`, uses `auth.uid()` ownership checks for all four operations,
and includes pgTAP allow/deny coverage. Run `supabase test db` after applying
the migration. The crawler’s operational records are still in a server-private
SQLite file and are not exposed through the Supabase Data API; Supabase RLS
does not apply to those SQLite tables.

Copy the authentication values from the Supabase project settings into the
environment used to start the dashboard:

```dotenv
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_your_key
AUTH_SITE_URL=http://127.0.0.1:4173
AUTH_TRUST_PROXY=0
AUTH_ALLOW_INSECURE_HTTP=0
```

`SUPABASE_ANON_KEY` remains a legacy fallback when the project has not yet
migrated to publishable keys. Never use `SUPABASE_SERVICE_ROLE_KEY` in this app.
Set `AUTH_TRUST_PROXY=1` only behind a trusted proxy that overwrites
`X-Forwarded-For`; use HTTPS for both `AUTH_SITE_URL` and `SUPABASE_URL` in
production. Keep `AUTH_ALLOW_INSECURE_HTTP=0`; setting it to `1` is reserved
for local proxy/emulator testing and explicitly opts out of that transport
check.

Auth typography is self-hosted from the official Vercel `geist@1.7.2` package:
the static WOFF2 files live under [`public/fonts/geist`](public/fonts/geist), with
the SIL Open Font License 1.1 in
[`LICENSE.txt`](public/fonts/geist/LICENSE.txt) and package/file provenance in
[`README.md`](public/fonts/geist/README.md). The auth stylesheet declares
same-origin `@font-face` sources and the HTML preloads critical weights.
Keep remote font imports out of the auth shell; its self-only CSP with
`font-src 'self'` and `style-src 'self'` is verified with the shipped assets.
System fallbacks remain for resilience.

In the Supabase dashboard:

1. Enable the email/password provider and require email confirmation.
2. Set the Supabase **Site URL** to the deployed `AUTH_SITE_URL`.
3. Add the local and production `/auth/callback` URLs to the redirect allow
   list (for example `http://127.0.0.1:4173/auth/callback`) using the provider's
   path/query matching syntax so the app's local `next` query is accepted. The
   app validates `next` as an internal path; do not allow arbitrary external
   destinations.
4. In the **Confirm sign up** email template, point the verification action to:

   ```html
   <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=email&amp;next=/post-login">Verify email address</a>
   ```

5. In the **Reset password** template, point the recovery action to:

   ```html
   <a href="{{ .SiteURL }}/auth/callback?token_hash={{ .TokenHash }}&amp;type=recovery&amp;next=/reset-password">Reset password</a>
   ```

6. Configure a production SMTP provider before launch and disable email link
   tracking. This app exchanges a single-use callback on its first request; if a
   mail system prefetches links, use Supabase's OTP template flow or disable that
   prefetch rather than relying on an intermediary confirmation page.

The user-facing routes are `/signup`, `/verify-email`, `/login`,
`/forgot-password`, `/reset-password`, and the protected `/account` page.
`/auth/callback` accepts Supabase token-hash and PKCE code callbacks. Authenticated
users pass through the internal `/post-login` handoff, which directs first-time
users to `/onboarding` and returning users to `/jobs?view=all&tab=main&sort=posted`.
`/onboarding`, `/preferences`, and match APIs are also protected account routes.
Protected onboarding, preference, and match APIs use the server-side
`getUser()` check and require a confirmed email; an unverified Supabase session
is treated as anonymous for account-specific data.

Mutation endpoints require a same-origin request and the server-issued CSRF token
echoed in the `X-CSRF-Token` header (bound to an HTTP-only cookie). Production
sessions use secure, HTTP-only, SameSite cookies with refresh-token rotation;
authenticated and callback responses are private and non-cacheable. Login,
signup, email resend, recovery, reset, and logout actions also have server-side
rate limits in addition to Supabase's provider limits.

## How crawling works

For each source the crawler:

1. Tries a known structured adapter (Greenhouse, Lever, Workday, GitHub raw/API), then direct HTTP/static HTML/JSON parsing.
2. Collects listing snapshots first; canonicalizes, deduplicates, and conservatively scores candidates before scheduling detail requests.
3. Uses SQLite identity/validator state to emit lightweight sightings for unchanged listings and fetch only new, changed, or retryable details.
4. Scores anchors and URLs for internship, student, engineering, software, career, job, and apply terms while penalizing unrelated corporate links.
5. Uses a bounded streaming HTTP worker queue so slow URLs do not block unrelated work.
6. Falls back to one persistent Chromium generation with reusable contexts/pages when the HTTP response is a JavaScript shell or otherwise lacks useful job evidence. GitHub pages remain API/raw-content only, and the recurring crawl consumes the durable Jobright destination cache instead of opening uncached Jobright detail pages.
7. Resolves redirects from an Apply link with a read-only GET. The separate bounded Jobright resolver reads only the rendered **Original job post** href and uses that employer/ATS destination; it never clicks Apply, fills inputs, or issues a form submission.

Application destination checks are ingestion gates. Explicit unavailable-page
wording and unverified LinkedIn destinations are excluded from active results;
a genuinely closed page is marked closed by the crawler's availability
lifecycle.

At most one Chromium generation is launched per crawl, and contexts/pages are reused with browser concurrency bounded at four. Images, media, fonts, analytics, and ads are blocked while JavaScript remains enabled. HTTP and browser concurrency are separate; each origin has its own semaphore and adaptive rate limiter. Transient timeouts, 429s, 5xx responses, and page crashes use exponential backoff; a 429 `Retry-After` value is honored when supplied. Terminal failures are written to `failed_pages`, and other sources continue. Ordinary structured HTTP sources avoid Chromium.

`robots.txt` is checked per origin and its crawl delay is honored when present. The crawler does not bypass CAPTCHAs, login walls, bot defenses, or access controls.

## GitHub repository support

GitHub repositories are API/raw-content only: rendered GitHub pages are never opened in Chromium. Public raw Markdown, repository API metadata, linked `.md` files, and table rows are parsed into company, role, location, posting date, job ID, and application URL fields, and the linked company/ATS destination is retained as the posting/application target. The configured GitHub origin is robots-checked before adapter work; API/raw subdomains are treated as the provider's documented public transport endpoints and are not recursively robots-fetched.

The crawl database records whether each source was retrieved through its configured URL or a public alternate, plus the alternate URLs and coverage notes.

## Extractors and classification

Provider adapters cover Greenhouse, Lever, Workday, and Ashby conventions. SmartRecruiters, Jobvite, iCIMS, Taleo, Eightfold, RippleMatch, Simplify-linked pages, and custom portals first use direct HTTP/static parsing, then rendered link traversal only when a JS shell or dynamic interaction genuinely requires it. The generic extractor prefers Schema.org `JobPosting` JSON-LD and otherwise isolates semantic job content, removes navigation/footer/cookie material, recognizes section headings, and preserves bullets.

Classification does not rely on the title alone. It scores title evidence, coding responsibilities, named technologies, and software qualifications, while applying strong penalties to non-coding functions. Relevance-score factors are multiplied by the configured scoring factor and rounded to whole points: a missing internship/co-op/student-placement signal applies a 45-point penalty; recognized terminology includes intern/internship variants, co-op/coop, student, undergraduate/graduate, university/college, placement, work-term, and related program language. An explicit intern, internship, or co-op term in the title adds a 34-point bonus. A reliable Summer 2027 signal in the title, posting text, qualifications, or extracted date evidence adds a 26-point bonus. Ambiguous titles such as Technology Intern, Systems Intern, Research Intern, Data Intern, and Automation Intern are accepted only when their description supplies programming evidence. The configured minimum relevance score is a hard floor; lower-scoring listings are rejected before persistence. Each accepted record stores its score and a human-readable explanation; roles without a specific classifier category fall back to `other` or `other-code`.

Fixed title, location, eligibility, freshness, content, link, and action
policies are applied before a role is exposed. Titles for new-grad, PhD,
12-month, and excluded years are rejected; a range such as “4-12 month” is
accepted when it includes a standalone four-month option. Roles outside the
configured Canada/United States/remote geography, unavailable destinations,
and handled actions are likewise excluded from the active result set.

## Database schema

SQLite is initialized automatically with these tables:

- `crawl_runs`: options, timing, completion, and aggregate counters
- `sources`: canonical configured source and its most recent scan state
- `internships`: current validated payload, stable hash, availability, and first/last seen metadata
- `internship_sources`: many-to-many provenance and last-seen state
- `run_internships`: per-run lifecycle classification
- `source_run_results`: per-source duration, coverage, retrieval mode, alternate URLs, and coverage notes
- `failed_pages`: URL, error class, HTTP status, retry count, and timestamp
- `source_strategies`: durable adapter/JS decision, latency, failures, and last status
- `listing_sightings`: payload-free listing identities, validators, and unchanged/changed observations
- `crawl_run_metrics`: bounded transport, skip, detail, and runtime counters

Deduplication first compares direct application and posting URLs, then company plus ATS job ID, then normalized company/title/location. When copies collide, the ATS/direct-application record wins and all discovery sources are retained.

## Architecture

```text
src/
  classification/  internship detection, relevance, categories, technologies
  config/          editable sources and validated settings
  crawler/         browser reuse, queue, scoring, public fallbacks, robots, pacing, retries
  database/        SQLite schema and lifecycle persistence
  deduplication/   canonical-record selection and provenance merging
  domain/          Zod schemas and shared types
  extractors/      ATS adapters, public-board feeds, JSON-LD, generic DOM
  output/          filters, JSON, CSV, console
  parsing/         qualifications, locations, dates, work authorization
```

The implementation rationale and delivery plan are in [`docs/IMPLEMENTATION_PLAN.md`](docs/IMPLEMENTATION_PLAN.md).

## Tests and deterministic sample

```bash
npm run typecheck
npm run lint
npm test
npm run sample
npm run build
```

Tests use saved Greenhouse, Lever, Workday, and generic fixtures and cover
relevance, fixed title/score/location/source exclusions, internship detection,
technology recognition, qualification separation, authorization, URL
canonicalization, deduplication, and database lifecycle transitions.

`npm run sample` starts a temporary local career site, renders a JavaScript “Load more jobs” result, follows a duplicate listing, filters a Marketing Intern, resolves Apply redirects to stable form URLs, and runs twice against one SQLite database. It fails unless the first scan produces two `NEW` software internships and the second produces the same two as `UNCHANGED`.

## Known limitations

- Career sites and ATS markup change; provider adapters may need selector updates even though JSON-LD and generic fallbacks reduce that risk.
- CAPTCHAs, authentication-only portals, aggressive bot protection, and pages forbidden by robots.txt are recorded but not bypassed. Public alternate routes are used only when they independently pass the robots check.
- Some non-Jobright aggregators expose an internal application form instead of a public employer URL. In that case the listing URL remains the honest application destination; the scout will not create an account or submit personal data to reveal a hidden link. Jobright listings remain fail-closed when their Original job post href cannot be resolved, while previously verified direct employer/ATS URLs are reused when available.
- Workday and similar portals sometimes expose results only through tenant-specific APIs or search interactions; the crawler tries direct HTTP first and uses a bounded rendered fallback when useful content is genuinely dynamic, but does not reverse-engineer private APIs.
- Location normalization is intentionally strongest for Canada and the United States; postings outside the configured geography are excluded from active results.
- Classification is deterministic and explainable rather than LLM-backed. Unusual roles may require new signals or a lower discovery threshold.
- An Apply control implemented only as an opaque JavaScript POST cannot be safely resolved; in that case the stable posting URL is retained.
