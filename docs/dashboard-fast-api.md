# Dashboard fast API

The dashboard read path has a compact, server-filtered contract. The legacy
`/api/data` snapshot remains available during client migration, but new clients
should use these routes.

## `GET /api/roles`

Query parameters:

- `tab`: `main`, `canada`, or `summer` (default `summer`, matching the initial dashboard view).
- `status`: `open`, `new`, `updated`, `all`, or `closed` (default `open`).
- `q` (or `search`): server-side case-insensitive search over the same card/search fields as the current dashboard.
- `category`: a category value, or `all` (default `all`).
- `season`: `winter`, `spring`, `summer`, `fall`, `unknown`, or `all` (default `all`). The `unknown` value selects roles without a detected internship season.
- `sort`: `relevance`, `posted`, `season`, `recent`, `last-seen`, or `company` (default `relevance`). Season sorting groups roles in Winter → Spring → Summer → Fall order, then leaves unknown seasons last.
- `limit`: page size, default 8 and bounded to `1..100` (zero, negative, and
  non-integer values are rejected with `400`).
- `offset`: stable offset into the sorted result, default 0.

The response is `dashboard.roles.v1`:

```json
{
  "contract": "dashboard.roles.v1",
  "version": "...",
  "filters": { "tab": "summer", "status": "open", "category": null, "season": null, "search": "", "sort": "relevance" },
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

Returns `dashboard.changes.v1` with the current opaque `version`, scan/run
status, and lightweight live-board status. Send the returned `ETag` as
`If-None-Match` on the next poll; an unchanged version returns `304` with no
body. Validators are weak semantic ETags so the same logical JSON can be
revalidated across gzip/Brotli and identity representations. `GET` and `HEAD`
are supported; responses include `Content-Length` and vary only on
`Accept-Encoding`. Brotli/gzip are selected using standard wildcard and
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
switch; the checked-in dashboard and scout launch agents do not set it. The
recurring 90-minute schedule belongs to the scout launch agent, while the
dashboard owns only its one startup check and explicit `/api/refresh` or
`/api/scan` requests. Both paths use the same heartbeat lease and refuse a
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
