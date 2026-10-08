# Scheduled crawl failures 740–747

## Finding

All eight scheduled catalog runs started during battery-powered macOS DarkWake or SleepService windows and overlapped repeated Maintenance Sleep. The worker’s wall-clock timers, heartbeats, and request progress stopped advancing while the Mac slept, then resumed in short wake windows or after full user wake. Five runs were finalized by the 20-minute stale-heartbeat path; three reached the 45-minute hard-deadline path. The pattern is a scheduler power-state issue, not a shared source-parser defect.

| Run | Persisted outcome | Supporting timing |
| --- | --- | --- |
| 740 | Stale recovery at 40m15s, below the 45m hard limit | Started around 03:01 EDT during SleepService DarkWake; the next observed maintenance wake was at 03:15 and stale cleanup occurred at 03:41. |
| 741 | Hard-deadline failure, finalized after 51m06s | Started at 03:59 during battery DarkWake; progress resumed only in short wakes, with the deadline error recorded at 04:50. |
| 742 | Stale recovery after 33m29s | Started at 05:17 during maintenance DarkWake; Maintenance Sleep began 32 seconds later and stale cleanup coincided with the 05:51 SleepService wake. |
| 743 | Stale recovery after 34m02s | Started at 06:18 during DarkWake; Maintenance Sleep began 26 seconds later and stale cleanup aligned with the 06:52 wake. |
| 744 | Stale recovery after 32m41s | Started at 07:19 during a 45-second maintenance DarkWake; Maintenance Sleep began at 07:20 and stale finalization aligned with the 07:52 wake. |
| 745 | 45m deadline; row finalized after 52m24s | Started at 08:11 during SleepService DarkWake. The nominal deadline passed during Maintenance Sleep and logged at the next wake around 09:04. |
| 746 | Stale recovery after 36m00s | Started at 09:16 during DarkWake; Maintenance Sleep began 21 seconds later and stale recovery occurred at the 09:52 wake. |
| 747 | 45m deadline at 45m00.008s | Started during SleepService DarkWake at 09:58; Maintenance Sleep began 16 seconds later. Full user wake came at 10:40, shortly before the 10:43 deadline. |

The exact in-flight operation and finalizer are not consistently recoverable: stale cleanup clears heartbeat time, unfinished sources have no sealed attempt result, and `pmset` records a generic `caffeinate` process name without proving its parent PID. This does not weaken the directly observed sleep/wake timing.

## Source outcomes

Seven runs (740–744 and 746–747) have no persisted failed-page transport rows. They contain partial Intern List results, unsettled placeholders, or an unfinished source, depending on the run. Those rows do not establish that unfinished sources returned HTTP failures.

Run 745 is the exception at the source-record level: it contains 25 transport-failure rows with no HTTP status across Jobright offsets, GitHub raw files, ApplyBolt, and Useno, plus one HTTP 200 Jobright coverage-validation failure because the returned snapshot was smaller than advertised. Early Career Radar also emitted 448 detail-retry log entries before its result remained unsettled. These are real source-level transport/coverage signals, but the timeline shows that the run’s 45-minute cutoff elapsed during system sleep; they do not establish a parser defect as the run-level cause. Run 739 had previously completed all 22 sources in 12m35s, including Early Career Radar. After full user wake, run 748 completed all 22 sources in 12m25s.

See the per-run evidence in [crawl 740](../output/crawl-investigation-2026-10-06/crawl-740.md), [741](../output/crawl-investigation-2026-10-06/crawl-741.md), [742](../output/crawl-investigation-2026-10-06/crawl-742.md), [743](../output/crawl-investigation-2026-10-06/crawl-743.md), [744](../output/crawl-investigation-2026-10-06/crawl-744.md), [745](../output/crawl-investigation-2026-10-06/crawl-745.md), [746](../output/crawl-investigation-2026-10-06/crawl-746.md), and [747](../output/crawl-investigation-2026-10-06/crawl-747.md).

## Shared fix

The scheduler now checks macOS power capabilities only when a catalog crawl is due. It starts a worker when `pmset -g systemstate` reports CPU plus Graphics or Audio capability. [Apple’s PowerManagement source](https://github.com/apple-oss-distributions/PowerManagement/blob/main/pmconfigd/PMConnection.m) classifies CPU without Graphics and Audio as dark wake; the local `pmset(1)` manual describes `systemstate` as the current power state and capabilities, and the local IOPM header defines those capability bits. The check does not infer sleep from display-off, idle, lock, or battery state, so normal full-wake crawling remains available on battery and AC. Linux and other platforms bypass the new gate.

The probe is capped at 1.5 seconds and 4 KB. Command errors, malformed state, missing CPU capability, and results delivered after the wall-clock bound fail closed as unknown. The scheduler logs only state changes and tries again on its next minute tick without starting the five-minute failure backoff. The existing 90-minute cadence, five-minute retry delay, 20-minute stale lease, and 45-minute worker limit plus one-minute supervisor grace remain in place. After the asynchronous probe, it checks the lease again before spawn to avoid racing a manual crawl.

The active worker assertion remains `caffeinate -i -s -w <pid>`; local `caffeinate(8)` documents that `-s` prevents system sleep only on AC. This gate prevents new workers from being launched in battery maintenance DarkWake. It does not promise that a crawl already running during full wake will survive a later forced or system sleep on battery.

## Verification and deployment state

The source scheduler and power probe passed focused tests, scoped lint, and the production TypeScript build. The standalone build now compiles the new helper with the scheduler and smoke-loads the compiled modules; it does not make build success depend on the current power state. The current local probe returns full wake.

Independent review passed; see [the review report](../output/crawl-investigation-2026-10-06/scheduler-independent-review.md). Before activation at 12:15:59 EDT, `launchctl print` showed the existing LaunchAgent at PID 74151 and a read-only SQLite query showed run 748 completed with no `RUNNING` rows. `launchctl kill SIGTERM` refused with `Not privileged to signal service`; sending SIGTERM to the same-user scheduler PID succeeded, and launchd restarted the unchanged agent as PID 93024 (`runs=8`). The plist was not rewritten. At 12:17:20 EDT, launchd showed PID 93024 running `/Users/rayxu/Documents/Internshipmatic/dist/src/scheduler.js` with the live database path, the latest DB row remained run 748 `COMPLETED`, and the `RUNNING` count remained zero. The compiled scheduler imports `dist/src/config/macPowerState.js`, whose live probe returned `full-wake` after restart. The next catalog due point from run 748's start is about 12:18:51 EDT.

No full crawl was started for verification and no history was changed. The probe’s full-wake result and mocked dark-wake-to-full-wake transitions are verified; the next overnight DarkWake cycle has not yet been observed. Process-list commands `ps` and `pgrep` were denied by macOS permissions, so active-worker checks relied on the LaunchAgent state and the live database’s zero `RUNNING` rows. The scheduler only gates new worker starts; a running battery crawl can still be interrupted by a later forced or system sleep.
