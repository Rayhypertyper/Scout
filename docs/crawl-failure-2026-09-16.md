# September 16 crawler stalls

Recent runs repeatedly stopped after the four Intern List feeds, CSJobs, and
Did the Boys Grind Leetcode Today: 92–94 discovered roles with six of 23 sources
complete. Both remaining worker slots then entered Early Career Radar.

A CPU profile of live worker 4065 showed repeated URL normalization and listing
identity construction inside the candidate deduplication loop. The loop compared
every candidate against all preceding candidates. At thousands of listings this
blocked Node's event loop, preventing heartbeats, source watchdogs, and the run
deadline from firing. The dashboard consequently marked runs stale, and the
external scheduler eventually killed the worker. Runs that progressed further
also encountered internet-disconnected errors and the 45-minute hard deadline.

Fixes:

- Index lightweight candidates by URL, company/requisition ID, and individual
  company/title/location aliases, while retaining the existing pairwise match
  guards and first-record behavior.
- Reuse the indexed matcher for cached/new/changed role counting at source
  finalization. A third live profile found the same all-pairs behavior there.
- Replace repeated candidate array searches with a URL map.
- Probe SQLite's identity indexes before joining source history. A second live
  CPU profile identified the old source-wide lookup as the next bottleneck.
- Yield to the event loop every 32 cached candidates so timers and cancellation
  remain responsive.

Validation: 91 tests across nine relevant suites passed, including a 5,000-item
operation-count regression, identity-matching checks, an indexed query-plan
check, incremental persistence, and source timeout tests. Changed files pass
ESLint and the diff whitespace check. The compiled deduplicator processed 5,000
unique Radar-shaped candidates in 122 ms. The rewritten lookup performed 1,000
missing-identity probes against the live database in 134 ms.

The full TypeScript build has existing errors in edition, acquisition, and
public-egress-proxy modules. The three broader test failures in runControl,
runtimePerformance, and sourceOrchestration were reproduced in a temporary copy
with the original crawler and deduplication code. The changed runtime modules
were compiled directly; the crawler entry point imports successfully.

The scheduled service was restarted with the fixes. Verification run 399 passed
the 92-role stopping point (4,056 roles) before being explicitly stopped to apply
the second fix. That restart is recorded in its error message rather than being
presented as a successful crawl. Run 400 then reached 4,822 roles but exposed the finalization bottleneck. It was
explicitly stopped with that reason recorded. Run 401 verifies all fixes together.

Run 401 completed the main Early Career Radar source and advanced to nine completed
sources / 9,744 discovered roles by 18:09 UTC, with a current heartbeat. This
confirms recovery through both previously blocking stages for that source. The filtered
Radar variant and remaining catalog
was still running at that checkpoint, with some employer-site HTTP timeouts.
