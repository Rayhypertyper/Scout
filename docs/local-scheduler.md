# Local automatic crawling

The `com.internshipmatic.scout` macOS user launch agent runs `dist/src/scheduler.js`
continuously. launchd starts it at login and restarts it if it exits. It checks
once a minute, 24 hours a day while the Mac is awake, and starts a separate
crawler process when the last successful full-catalog crawl started at least
90 minutes ago. A recent partial/manual crawl does not count as a full refresh.
Fresh database leases prevent overlapping crawls, including manual runs.
Failures retry after five minutes. Workers exceeding the crawler's 45-minute
limit plus one minute of grace are stopped so they cannot block all later runs.

Closing the browser does not stop crawling. Sleep, shutdown, logout, or loss
of internet can prevent fresh results. The scheduler catches up after login
or wake; data will remain older until crawling succeeds. The 90-minute cadence
is a start-time target, not a guarantee that every source successfully refreshes.
Running while the Mac is off requires a separate always-on computer/server.

To install or update from the project root:

```sh
node scripts/build-scheduler.mjs
python3 scripts/install-local-scheduler.py
```

The standalone scheduler build uses the existing compiled crawler. A normal
successful `npm run build` also builds the scheduler. The installer preserves
existing log paths and saves the previous agent configuration beside its plist
as `com.internshipmatic.scout.plist.before-supervised-scheduler`.

Check the live service with `launchctl print gui/$(id -u)/com.internshipmatic.scout`.
The installed service currently logs under `~/Library/Logs/Internshipmatic/`.
