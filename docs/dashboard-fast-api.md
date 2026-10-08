# Dashboard fast API

The dashboard read path has a compact, server-filtered contract. The legacy
`/api/data` snapshot is retired and returns `410 Gone` for all methods, without
reading SQLite, refreshing live sources, or building the full payload. The
current frontend uses the routes below.

Return visits to the public all-internships view paint a local preview before
waiting for the network. The browser stores up to six exact filter views, with
40 public card records per view, for at most seven days. It excludes account
actions, matching evaluations, account counts, authentication data, descriptions,
and crawl diagnostics. Matches still require the verified account and are not
persisted in this preview cache. Applying, hiding, or undoing a role clears the
previews, and an empty live result removes its old preview.

The UI labels previews `Updating listings…`, replaces them with the live head,
and resumes pagination only with the live revision. Failed revalidation retains
the preview with `Showing saved listings`; later visible polls retry. Polling
does not restart a pending head request. Hidden pages pause polling and check
immediately when visible again. The public `/jobs?view=all` HTML does not contact
the authentication provider, and dashboard fonts are served locally.

`tests/returnVisitBrowser.test.ts` checks a four-hour-old preview against a
ten-second live response, replacement by fresh cards, and failed revalidation.
Run it with `RUN_BROWSER_E2E=1 npx vitest run tests/returnVisitBrowser.test.ts`.

`/api/applications` is still used by the application tracker. Reads require a
server-verified, email-confirmed session. `/api/actions` (POST/DELETE) and
`/api/applications/status` (POST) also require that session, same-origin access,
and a CSRF token. Applications, action aliases, hidden roles, counts, validators,
and caches are scoped to the authenticated account. Public role/status reads
use an empty action scope for anonymous users.

SQLite account actions live in `user_listing_actions` and
`user_listing_action_identities`, with composite keys including `user_id`.
Startup copies previously owned rows into this store once. Unowned rows are
preserved in `legacy_listing_actions_quarantine`; they are never assigned to
the first user. The original local action store remains available to offline
tools, but HTTP routes cannot read it. Migration requires a server restart and
runs inside the existing startup write transaction.

For this installation, Ray has explicitly confirmed ownership of all historical
applications. The restored records and ongoing ownership instruction are
documented in [Application ownership and recovery](application-ownership.md).

## `GET /api/roles`

Query parameters:

- `tab`: `main`, `canada`, `summer`, `internship`, `quant`, or `non-intern` (default `canada`, matching the initial dashboard view).
- `status`: `open`, `new`, `updated`, `all`, or `closed` (default `open`).
- `q` (or `search`): server-side case-insensitive search over the same card/search fields as the current dashboard.
- `category`: a category value, or `all` (default `all`).
- `season`: `winter`, `spring`, `summer`, `fall`, `unknown`, or `all` (default `all`). The `unknown` value selects roles without a detected internship season.
- `sort`: `relevance`, `posted`, `season`, `recent`, `last-seen`, or `company` (default `posted`). Posted sorting orders the displayed date newest first, using `postingDate`, then `firstSeenAt`, then `discoveredAt`; unknown dates remain last. Season sorting groups roles in Winter → Spring → Summer → Fall order, then leaves unknown seasons last.
- `limit`: page size, default 8 and bounded to `1..100` (zero, negative, and
  non-integer values are rejected with `400`).
- `offset`: stable offset into the sorted result, default 0.

The response is `dashboard.roles.v1`:

```json
{
  "contract": "dashboard.roles.v1",
  "version": "...",
  "contentVersion": "...",
  "filters": { "tab": "canada", "status": "open", "category": null, "season": null, "search": "", "sort": "posted" },
  "filterMeta": { "tabs": [], "tabCounts": {}, "categories": [], "seasons": [], "statuses": [], "sorts": [] },
  "stats": {},
  "counts": {},
  "appliedRoleCount": 0,
  "scan": {},
  "pagination": { "limit": 8, "offset": 0, "total": 0, "hasMore": false, "nextOffset": null },
  "items": []
}
```

Each item contains card fields only: identity, company/title, locations,
application/posting/source links, technologies/categories, lifecycle and
availability, timing, score/reason, and action context. Descriptions,
qualifications, normalized location structures, crawl diagnostics, and action
collections are intentionally omitted.

The crawler commits usable listings as soon as each listing's extraction and
application-link checks finish. Optional facts that cannot be found remain
unknown. Publication does not wait for sibling detail requests, source
settlement, or the full crawl. Missing-listing reconciliation still happens
only after complete source coverage has been established at the end of a run.

Both `/api/roles` and `/api/changes` include `contentVersion`, which identifies
the catalog and action content independently of crawl heartbeat/progress
updates. The browser checks every five seconds while visible and reloads the
head of the list when that content changes, including during an active crawl.
A temporary cached response retains its own content revision, and the browser
retries until its rows catch up. Offset pages from different content revisions
restart from the head instead of leaving newly inserted roles unseen.

Catalog builds use a coherent WAL read snapshot so continuous listing writes
can advance the visible catalog between polls. Action, identity, verification,
and database-file changes still invalidate unsafe snapshots. Date-only posting
dates display calendar precision (`Today`, `1d ago`) instead of inventing an
hour count from midnight.

Fixed title, relevance, location, eligibility, freshness, content, link, and
handled policies are applied before the list is constructed. Excluded and
handled roles are absent from active list results; SQLite retains the historical
record for lifecycle tracking.

## `GET /api/roles/:listingType/:listingId`

`listingType` is `internship` or `grind`. A role is looked up directly by
listing identity (it does not rebuild the list index). It is returned as
`dashboard.role.v1` with the full description, qualifications, provenance,
links, and metadata needed by the details view. Only a missing role returns
`404`.

The detail `version`/ETag is scoped to that role plus the minimal action,
verification, run, and board context needed by the details view; it need
not equal the list snapshot version.

## `GET /api/changes` (also `/api/status`)

Both role-list and changes responses include `failures24h`: every individual
`failed_pages` record from the rolling past 24 hours, newest first (then highest
ID for matching timestamps), across all crawl runs. Each record includes `id`,
`run_id`, `source_url`, the failed page `url`, `error_type`, `status_code`,
`message`, `retry_count`, and `occurred_at`. The list is neither grouped nor
limited; `errors24h` equals its length. Failure details renders these records.
The existing `failures` field still contains grouped latest-run diagnostics.
Response validators include the 24-hour failure IDs so expiration updates the
list even when no crawl or database write occurs.

Returns `dashboard.changes.v1` with the current opaque `version`, scan/run
status, and lightweight live-board status. Send the returned `ETag` as
`If-None-Match` on the next poll; an unchanged version returns `304` with no
body. Validators are weak semantic ETags so the same logical JSON can be
revalidated across gzip/Brotli and identity representations. `GET` and `HEAD`
are supported; responses include `Content-Length` and vary on
`Accept-Encoding` and `Cookie`. Brotli/gzip are selected using standard wildcard and
quality-value negotiation for bodies at least 1 KiB. A `304` has no payload
framing headers; `200`/`HEAD` representations carry `Content-Length`.
Responses are private
and revalidated (`private, no-cache, must-revalidate`). The version covers
role/action aggregates, every exposed latest-run progress/error/finish field,
scan state, live-board status/attempts, and the resolved link-verification
artifact revision. It also includes the server's local calendar day so clients
automatically revalidate at midnight when relative posting labels change.
The SQLite data revision is included as a final invalidation boundary for
legacy writers that change payload fields without refreshing `content_hash`.
The latest run is read after that revision boundary; if a progress, heartbeat,
error, status, or finish commit crosses the read, the post-read check retries
from a fresh snapshot (up to the same bounded limit used for list
construction). Detail and changes responses perform the same post-read
revision check, returning `503` rather than mixing run status with an older
validator during persistent write churn.

The `updated` status is intentionally narrower than a raw lifecycle check: it
contains only roles that are currently open, eligible for the selected tab, not
marked NEW in the 16-hour banner window, and whose lifecycle is
`UPDATED`.

The `new` status likewise excludes closed roles: it requires the listing to
still be inside that 16-hour NEW window and currently open, with the same tab
and eligibility rules as the other filters.

Tab membership follows the fixed dashboard tabs: **All** contains active roles
that pass the crawler's hard policies, **Canada** selects roles in the target
Canadian geography, and **Summer** selects internship/co-op roles with the
configured Summer placement signal. These tabs may overlap.

List construction rechecks the SQLite revision after reading role rows. A
concurrent commit causes the in-progress snapshot to be discarded and retried
up to a bounded limit, so returned cards and `version` cannot describe
different database revisions.

The server prewarms this compact index from the resolved `--database` and
`--output-dir` configuration before it starts accepting HTTP requests. The
prewarm is read-only and uses the durable board projection; it never starts a
crawler or performs a live board request. It has a bounded 15-second startup
wait and falls back to normal on-demand construction if the database is
missing, busy, or otherwise cannot be prewarmed. Set
`DASHBOARD_SKIP_FAST_PREWARM=1` only when deliberately trading first-request
latency for immediate listen startup. A recent durable board cache is reused
while its configured cache TTL is valid; revalidation resumes after the TTL.
Verification-artifact reads use nonblocking handles and bounded deadlines.
Startup verification work is not coalesced into request reads, so a stalled
FIFO or damaged artifact can only fail prewarm; it cannot strand later list,
detail, or changes requests. Requests fall back to the existing null
verification projection after their bounded read deadline until the artifact
becomes readable again.

Before listener readiness, the dashboard records the successful prewarm's
SQLite data revision, file generation, content key, and latest-run projection.
It initializes the run watcher in baseline-only mode, reconciles that revision,
and performs at most two bounded startup reconciliation attempts if a durable
role/run commit crossed the prewarm-to-watcher handoff. The watcher is armed
only after this reconciliation, so an unchanged startup does not incur a
second build and a commit in the handoff cannot be silently treated as
prewarmed. The listener-start path is idempotent for the prepared database
generation; it reuses the existing watcher handle/cursor/timer rather than
re-baselining it, then performs one immediate bounded poll so a terminal
commit in the handoff is scheduled before the first request. A deliberate
shutdown, database-path change, or detected file-generation replacement still
creates a fresh watcher.

When the dashboard-owned crawler durably commits a completed run, it starts a
deduped background rebuild for the new role revision before finishing the
legacy export projection. This observer is read-only, uses the same bounded
verification path, never refreshes the live board, and is not awaited by run
control. If it fails or times out, the next request performs the normal
coherent on-demand rebuild; it cannot change the committed run status or serve
cards with a mismatched version.

Because launchd may run the scout in a separate process, the resident dashboard
also polls only the durable `crawl_runs` terminal state every two seconds. It
records the current terminal run as a startup baseline (so startup prewarm is
not immediately repeated), ignores RUNNING heartbeat/progress writes, and
queues one coalesced prewarm when an external run reaches `COMPLETED` or
`FAILED`. The prewarm begins only after the terminal row is visible, and its
SQLite revision/snapshot checks still discard a read that races a final write.
Rapid terminal runs collapse to the newest durable revision; an atomic DB file
replacement or recovery from a missing path is treated as a new generation.
The watcher is read-only, performs no crawler or network work, uses an unref'd
timer, and closes its read handle when the dashboard server closes.

After the listener is ready, the dashboard starts one configured source scan
unless a fresh durable run already owns the database. Startup scan scheduling
is deliberately independent of index prewarm: success, timeout, a missing
verification artifact, and other prewarm failures all continue to the same
run-control path. `DASHBOARD_SKIP_STARTUP_SCAN=1` is an explicit local/test
switch; the dashboard launch agent sets it because the separately supervised
scout scheduler owns automatic catch-up. The scheduler checks freshness every
minute, around the clock, and starts a full crawl when the last successful
full crawl started at least 90 minutes ago. It retries failures after five
minutes and catches up after login or wake. The dashboard owns explicit
`/api/refresh` or `/api/scan` requests. Both paths use the same heartbeat lease and refuse a
second fresh run; expired RUNNING rows are recoverable.

The in-process index cache separates role-card content revisions from dynamic
scan and board status metadata. Changes to status, heartbeat, attempts, or
errors still update the public version/ETag, but can refresh metadata without
reparsing unchanged role cards. Role/action/membership, completed-run
boundary, verification, and board-job changes invalidate the content
projection. A local-day change invalidates the public representation so
relative-date sorting and ETags remain correct; run-only SQLite writes still
change the public revision without forcing a card rebuild.

`scan.active` is lease-aware: a `RUNNING` database row is active only while
its heartbeat (or start time on legacy databases) is within the configured
run-lock window. Stale rows are reported as inactive so a crashed worker does
not disable Refresh indefinitely; a crawler that continues heartbeating may
run for longer than that window.
`scan.terminationRequested` is true only for an active run whose durable
`cancel_requested_at` marker is non-null; uncancelled and legacy rows project
that field as null consistently across `/api/changes`, `/api/refresh`, and
`/api/scan`.

## `POST /api/sources`

Adds a canonical HTTP(S) URL to the durable source catalog and starts a crawl
of that source. Future full crawls include it alongside the existing catalog.
If another dashboard-owned crawl is already active, the source crawl is queued
behind it. The crawler uses deterministic ATS/API,
HTML/JSON-LD, Markdown, and bounded browser extraction; no LLM is involved.

Request body:

```json
{ "url": "https://company.example/careers" }
```

The response is `202` when the crawl starts or is queued, and `200` when the
source is saved while an external run prevents immediate scheduling. Invalid
or credential-bearing URLs return `400`.

Mutations (`/api/actions`, `/api/terminate`, `/api/refresh`, and `/api/scan`)
remain write endpoints and return minimal acknowledgements. Refresh/scan do
not rebuild or embed the legacy full snapshot.

When `DASHBOARD_SKIP_LIVE_BOARD=1` is set, dashboard display and action paths
reuse the cached board projection and make no live-board request. Refresh/scan
does not issue an additional dashboard board request; the configured scout
source scan remains crawler-owned. Startup schema/action-identity migration
uses a busy timeout and one immediate transaction; the scout database
constructor uses the same serialized migration/backfill boundary so concurrent
dashboard/scout starters cannot observe a partial schema or identity
backfill.
