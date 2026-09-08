# Scout refactor dependency and staging plan

The existing entry points remain `src/dashboard.ts` and `public/app.js`. They
keep their current routes, bootstrapping, and runtime exports while extracted
modules own cohesive behavior behind explicit interfaces.

1. Establish a working-tree baseline and record the current server/client
   export sets, route ordering, static asset behavior, and test results.
2. Extract leaf dependencies first: server HTTP/encoding, static serving,
   query and serialization helpers; then client API, URL state, pagination,
   and rendering utilities. Leaf modules must not import their entry points.
3. Extract backend route families (roles/details, applications/actions,
   source and scan status) and frontend feature controllers (feed/filters,
   applications/watchlist, notifications/settings, source health, and scan
   controls). Keep shared state at the shell boundary and pass dependencies
   through small interfaces to avoid cycles.
4. Move boundary tests to the extracted modules and replace source-text
   assumptions with runtime export, API, static-module, and state-isolation
   checks. Retain the existing database, crawler, markup, and stylesheet
   behavior unless a boundary requires a mechanical import change.
5. After each stage, run typecheck, lint, focused tests, and the full suite;
   finish with build and the opt-in authenticated browser smoke. Compare the
   baseline export and route/static manifests before handoff.

Dependency direction:

```text
dashboard entrypoint -> route modules -> query/serialization/http leaves
                    -> auth/preferences/analytics adapters
                    -> database and crawler services

app entrypoint -> feature controllers -> API/state/rendering leaves
               -> existing browser modules and DOM
```

Routes, API contracts, cache validators, content types, module loading, and
the public client behavior are acceptance boundaries for every stage.
