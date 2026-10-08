# Local automatic crawling

The `com.internshipmatic.scout` macOS user launch agent runs `dist/src/scheduler.js`
continuously. launchd starts it at login and restarts it if it exits. It checks
once a minute and starts a separate crawler process when the last successful
full-catalog crawl started at least 90 minutes ago. A recent partial/manual
crawl does not count as a full refresh. Fresh database leases prevent
overlapping crawls, including manual runs. Failures retry after five minutes.
Workers exceeding the crawler's 45-minute limit plus one minute of grace are
stopped so they cannot block all later runs.

On macOS, a due crawl starts only when `pmset -g systemstate` reports CPU plus
Graphics or Audio capability. macOS maintenance dark wakes report CPU without
either capability, so the scheduler waits and checks again on its next minute
tick. If the probe fails or returns an unrecognized result, the scheduler also
waits and logs the change once. A result delivered more than 1.5 seconds after
the probe starts is discarded as stale, including when macOS suspended the
probe's timer. The check uses system power capabilities, not display state,
lock state, or battery power: normal full-wake operation on battery and AC can
both start a crawl. Other platforms keep their existing scheduling behavior.

Each active macOS crawl holds a bounded `caffeinate -i -s -w <worker PID>`
assertion. This prevents idle sleep and prevents system sleep while on AC from
suspending requests and exhausting the 45-minute deadline. `caffeinate -s` is
valid only on AC; the scheduler gate prevents a new crawl from starting in a
battery-powered dark wake. The display can sleep normally. The assertion ends
when the crawl finishes, fails, or its worker exits; the computer can sleep
between scheduled runs.

Closing the browser does not stop crawling. Forced sleep, shutdown, logout, or loss
of internet can prevent fresh results. The scheduler catches up after login
or wake; data will remain older until crawling succeeds. The 90-minute cadence
is a start-time target, not a guarantee that every source successfully refreshes.
Running while the Mac is off requires a separate always-on computer/server.

To install or update from the project root:

```sh
node scripts/build-scheduler.mjs
python3 scripts/install-local-scheduler.py
```

The standalone scheduler build uses the existing compiled crawler and compiles
both the scheduler and its macOS power-state helper. A normal successful
`npm run build` also builds the scheduler. The installer preserves
existing log paths and saves the previous agent configuration beside its plist
as `com.internshipmatic.scout.plist.before-supervised-scheduler`.

Check the live service with `launchctl print gui/$(id -u)/com.internshipmatic.scout`.
The installed service currently logs under `~/Library/Logs/Internshipmatic/`.

Intern List's Jobright mini-sites feed was retired on October 6, 2026. The
catalog now uses public GitHub inventories with direct employer links; saved
Intern List entries are excluded from scheduling. The legacy
`com.internshipmatic.jobright` agent exits without network or browser work,
and its existing destination cache remains available for historical postings.
Both Intern List diagnostic entrypoints also exit without probing the old
endpoint. See [the replacement inventory](source-replacement-2026-10-06.md).
