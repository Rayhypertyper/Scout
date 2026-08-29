# Production dashboard performance benchmark

This harness measures the built Internshipmatic dashboard against a frozen
local production fixture. It is intended for repeatable before/after checks,
not live monitoring. It does not crawl configured sources, call the live board,
write the production database, install dependencies, or make external network
requests.

## Prerequisites

- Node 24 or newer.
- Existing installed dependencies, including Playwright 1.62.1 and its
  Chromium browser. The harness never installs packages or browsers.
- A readable production database at `output/live/internships.db`.
- A readable frozen board cache at
  `output/live/source-cache/grind-job-board.json`.

The database and board cache are inputs only. The harness serializes SQLite
into a temporary copy and copies the board cache before starting each cold
server and once for the warm server.

## Invocation

The checked-in default is five cold and five warm repeats:

```sh
npm run perf:dashboard
```

This builds the production bundle, starts local dashboard servers as needed,
uses headless Chromium at the representative desktop viewport `1280x720`,
prints a median table, and writes JSON to
`output/performance/dashboard-latest.json`.

For an explicit calibration artifact:

```sh
npm run perf:dashboard -- \
  --cold-repeats 5 --warm-repeats 5 \
  --json-output /tmp/dashboard-performance.json
```

When iterating only on the harness, reuse an already-built `dist/` bundle:

```sh
npm run perf:dashboard -- --skip-build \
  --cold-repeats 5 --warm-repeats 5
```

`--database`, `--board-cache`, `--budget`, and `--timeout-ms` override the
corresponding defaults. `--strict-unsupported` returns exit code 2 when a
configured metric is unavailable. A budget regression returns exit code 1.
Disabled and unsupported metrics are kept in JSON and called out in the
human output; no placeholder values are invented.

## Isolation and lifecycle

1. The harness builds `dist/` (unless `--skip-build` is supplied).
2. For each cold repeat it creates a unique temporary fixture, serializes the
   source SQLite database into it, copies the board cache, and inserts a fresh
   synthetic `RUNNING` crawl row. Dashboard startup therefore takes its
   existing-run path instead of starting a configured-source crawl.
3. The child server receives only temporary database/output paths and the
   copied board cache through `GRIND_JOB_BOARD_CACHE_PATH`.
4. The child process is started with `no-external-network.mjs`; any non-loopback
   `fetch` throws a clearly marked `[BENCHMARK NETWORK BLOCKED]` error. The
   browser context also blocks service workers and records any non-loopback
   browser requests.
5. Cold repeats restart the server and use a fresh browser context. Warm
   repeats use one fixture, server, Chromium context, and an unreported warm-up
   navigation before the recorded navigations. This warms the dashboard's
   in-process compact roles/index path while preserving a new page navigation
   for each recorded warm sample.
6. Every page, context, server, browser, and temporary fixture is closed or
   removed in `finally` blocks, including benchmark failures. Only the chosen
   JSON output is written outside the temporary root.

The JSON `startup` section keeps process lifecycle timings separate from page
navigation metrics. `coldServerReadyMs` contains one duration per cold server,
from child-process spawn until a loopback `/` request returns 200.
`coldServerReadyMedianMs`, `coldServerReadyMinMs`, and
`coldServerReadyMaxMs` summarize those samples. `warmServerReadyMs` is the
corresponding single warm-server duration, and `warmPrewarmMs` is the
unreported warm-up navigation to usable cards. None of these values is
included in the phase page medians or regression budgets.

The benchmark never calls `/api/refresh`, `/api/scan`, `/api/actions`, or any
external production endpoint. A fresh fixture is used for every cold sample;
the source database and board cache are never modified.

## Metrics

Each phase includes every sample and a median over finite values. Timings are
milliseconds; byte counts are integers. Initial metrics include requests that
started before the first usable card, and the harness waits briefly for their
response events before marking the aggregate complete.

| Metric | Meaning |
| --- | --- |
| `timeToUsableCardsMs` | Navigation start to the first rendered `.role-card`. |
| `shellFcpMs`, `lcpMs` | Browser paint timings, when Chromium exposes them. |
| `apiListTtfbMs`, `apiListCompletionMs` | `/api/roles` request-start to first byte and response completion. |
| `apiListBodyBytes`, `apiListTransferBytes` | Decoded and wire sizes for the compact roles page. |
| `changesTtfbMs`, `changesCompletionMs`, `changesBodyBytes`, `changesTransferBytes` | Equivalent metrics for `/api/changes`. |
| `initialJs*`, `initialApi*`, `initial*` | Body and wire totals for initial JavaScript, API, and all initial responses. |
| `requestCount` | Requests started before cards became usable. |
| `initialJobsTransferred`, `totalJobsAvailable` | Items in the first roles page and its reported pagination total. |
| `initialCardsRendered`, `domNodes` | Cards and all DOM elements at the usability marker. |
| `cls` | Session-window cumulative layout shift, excluding recent-input shifts. |
| `searchInteractionMs` | Company search, including the app's debounce and resulting roles request/render. |
| `categoryInteractionMs`, `filterInteractionMs`, `tabInteractionMs` | Representative category, status, and tab transitions, including their roles request/render. |
| `loadMoreMs` | Loading and appending the second eight-card page. |
| `detailFetchMs`, `detailOpenMs` | Lazy detail response completion and summary-open to visible detail content. |
| `warmReloadMs` | Recorded warm navigation to usable cards. |

Interaction objects additionally retain request URL, TTFB, completion, body,
and transfer values. Each sample has an `unsupported` list. INP is reported
there only when Event Timing entries are unavailable; the harness does not
substitute a click duration or invent an INP value.

## JSON and request facts

The machine-readable output has this shape:

```text
{
  schemaVersion,
  benchmark,
  isolation,
  startup,
  requestFacts,
  phases: {
    cold: { repeats, samples[], median, budget },
    warm: { repeats, samples[], median, budget }
  },
  unsupported[],
  overallBudgetStatus
}
```

`requestFacts` aggregates all recorded samples and makes the isolation
contract auditable:

- `browserExternalRequests` and `blockedExternalFetchAttempts` must remain
  zero;
- `legacyApiDataRequests` must remain zero;
- `duplicateInitialRolesRequests` must remain zero (one initial `/api/roles`
  request per sample);
- `eagerInitialDetailRequests` must remain zero (details are fetched only
  after a card is opened).

Every sample also preserves `requestFacts.initialWaterfall`, including URL and
query parameters, resource type, status, navigation-relative request-start /
response-start / response-end timestamps, decoded body bytes, wire transfer
bytes, and whether the request began before cards became usable. This is the
quickest way to diagnose an unexpected request, timing, or payload regression.

## Regression budgets

[`budget.json`](./budget.json) is calibrated from the final optimized
application's five-repeat distributions. It gives stable timings and payloads
measured headroom, while keeping contract checks strict for one paginated roles
request, one changes request, eight initial items, no legacy endpoint, and the
bounded card DOM. `totalJobsAvailable` is intentionally reported but not
budgeted because it varies with the frozen dataset's current filterable rows.

The benchmark evaluates configured rules against phase medians. A phase is
`fail` when a configured max/min is exceeded, `incomplete` when a configured
metric is unavailable, and `pass` otherwise. Set a metric to `null` while
calibrating an intentionally unsupported browser metric, then replace it with
a measured ceiling once the protocol supports it. Keep the fixture, viewport,
browser version, and repeat count unchanged when comparing application
revisions; recalibrate after an intentional contract or environment change.

## Interpretation

Cold timings include starting a production server over a copied SQLite file and
building its in-process index. Warm timings use the same server after an
unreported warm-up navigation. Startup readiness and warm-up navigation are
reported separately under `startup`, so a slower prewarm does not get hidden
inside the recorded warm page timings. No CPU or network throttling is applied.
Wire
sizes come from Playwright request sizes and body sizes are decoded response
bytes; compressed API responses therefore have materially smaller transfer
than body values. Compare the optimized results to the controlled baseline in
the performance report, and treat data-dependent totals or unsupported browser
metrics as incomparable rather than forcing a percentage.
