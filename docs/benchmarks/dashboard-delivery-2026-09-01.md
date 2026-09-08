# Dashboard delivery benchmark

This report records the dashboard HTTP delivery audit on the shared dirty
working tree. The before run was captured before this delivery pass changed
application code. The browser benchmark was not used to manufacture Web Vitals:
the checkout contained concurrent dashboard extraction/refactor work, and the
role feed replay could not reach a stable ready state. The direct probe below
is deterministic and does not use a database, browser, external network, or
production write.

The machine readable artifacts are
[`dashboard-delivery-before-2026-08-31.json`](./dashboard-delivery-before-2026-08-31.json)
and
[`dashboard-delivery-after-2026-09-01.json`](./dashboard-delivery-after-2026-09-01.json).
The frozen pre-edit source copy is `/private/tmp/scout-delivery-before-IVoYeO`;
the separate asset worker snapshot is `/tmp/scout-asset-loading-before.saZNNO`.

## Measurements

The same 17,701 byte, 40-role JSON body was used for both runs.

| Signal | Before | After | Interpretation |
| --- | ---: | ---: | --- |
| JSON identity body/wire | 17,701 / 17,701 B | 17,701 / 17,701 B | Body unchanged. |
| JSON Brotli wire | 582 B, quality 11 | 662 B, quality 5 | The selected setting adds about 14% wire bytes. |
| JSON Brotli compression median/p95 | 22.3847 / 24.5195 ms | 0.0513 / 0.0570 ms | Same-process synchronous miss cost falls by roughly 400x. |
| JSON gzip wire | 915 B | 915 B | No payload change in this fixture. |
| `/jobs/` HTML identity | 63,590 B | 66,569 B | After includes validated query versions for every local startup asset. |
| `app.js` identity | 258,981 B | 299,671 B | Current public asset edits were concurrent; this increase is not attributed to delivery code. |
| `styles.css` identity | 52,216 B | 53,329 B | Same concurrent asset caveat. |
| `redesign.css` identity | 86,513 B | 95,617 B | Same concurrent asset caveat. |
| Current index HTML plus local startup graph | Not present in the old graph | 682,022 B decoded / 108,852 B Brotli | Sum of the transformed document plus its 12 local startup references in the final after artifact; this is not a browser waterfall. |

The before helper emitted uncompressed static responses with no ETag or
encoding negotiation. The after helper emits weak SHA-256 ETags, `Vary:
Accept-Encoding` for compressible static content, and `Vary: Accept-Encoding,
Cookie` for request-shaped dashboard JSON. A matching validator returns 304
without a payload or content coding. HEAD returns no payload and omits
`Content-Encoding` and `Content-Length` when a coded GET would be selected; an
identity HEAD retains the raw length. It does not populate the encoded
representation cache. HTML remains `no-store`; unversioned static files remain `no-cache`; an
immutable policy is used only when a query token is exactly 12 lowercase hex
characters and matches the served content hash.

The before JSON HEAD probe still returned a Brotli-coded length for a HEAD
request; the after probe omits `Content-Encoding` and `Content-Length` when a
coded GET would be selected, while an identity HEAD retains the raw length.
Dashboard JSON remains `Cache-Control: no-store`, so the representation cache
is an in-process CPU optimization and never a public or authenticated response
cache.

The after probe observed two encoded JSON representations (1,577 bytes total,
two hits and two misses) within a 128-entry, 4 MiB bound. Its static cache held
30 files and 15 transformed assets/templates (2,121,769 bytes), below separate
128-file, 8 MiB file and 32-entry, 4 MiB template bounds. File fingerprints include
device, inode, size, mtime, and ctime; a changed asset invalidates its body and
the dependent transformed template. Metadata and realpath checks still run on
each request to preserve path and symlink safety, while warm requests avoid
re-reading and re-hashing unchanged bodies.

HTML transformation now inspects local, query-free startup `script src`,
`link href`, `img src`, and `img`/`source srcset` references: stylesheets, icons
(including mask and Apple touch icons), manifests, preloads, modulepreloads,
images, and fonts. Navigation links, external URLs, and inline markup remain
untouched. CSS font URLs are rewritten with the same full font hash used by
HTML preloads, so the preload and stylesheet request share a cache key. The
template dependency key contains the source hash and every referenced asset's
full hash, so a change to `redesign.css`, `catalog-freshness.css`, an image, or
`themed-select.js` causes the next HTML response to carry the new version.
The delivery transform also follows the known landing motion graph: absolute
or same-directory dynamic imports and the motion vendor list receive hashes.
Other relative or runtime-discovered module graphs remain ETag-revalidated
because there is no build manifest.

The static and JSON security policies now allow local fonts with
`font-src 'self' data:` and no longer grant `fonts.googleapis.com` or
`fonts.gstatic.com`; the existing image origins remain unchanged. Authenticated
JSON remains `no-store`, and no API contract consolidation was attempted. When
`AUTH_SITE_URL` is absent, canonical metadata accepts only validated loopback
Host values and falls back to `http://127.0.0.1:4173`; arbitrary Host headers
cannot poison canonical or sitemap output.

## Reproduction and verification

Run the deterministic probe with:

```sh
npm run perf:delivery -- /tmp/dashboard-delivery.json
```

The following checks passed on the final delivery files:

- `npx vitest run tests/dashboardDeliveryPerformance.test.ts tests/publicSeo.test.ts` — 12 tests passed.
- The delivery, asset-loading, public SEO, and legal suites remain green after
  the follow-up changes; the delivery test covers CSS font reuse, image/srcset
  hashes, landing-motion dependencies, stale versions, and Host fallback.
- The delivery, dashboard budget, client fast-path, and feed primitive suites
  together passed 58 tests with 2 intentionally skipped.
- Targeted ESLint for the delivery modules, harness, and delivery tests.
- Isolated strict TypeScript checking for `src/dashboard/http.ts`,
  `src/dashboard/static.ts`, `scripts/performance/delivery.ts`, and the
  dashboard harness.

The full checkout still has unrelated concurrent failures. `npm run typecheck`
reports missing `boundedBrowserResponseText` in `src/crawler/browser.ts`,
strictness/declaration errors in `tests/frontendAssetLoading.test.ts`, and
operations test errors. `npm run build` is blocked by the same crawler symbol.
`tests/dashboardFast.test.ts` currently has 24 passing and 15 failing tests due
to the in-progress dashboard response/refactor changes; its delivery Vary
assertions now match the intended cookie-aware contract. No new browser FCP,
LCP, CLS, INP, or field CWV values are claimed until the shared dashboard
source and build are coherent. The old August 8-role/44 KiB/700-node budget
ceilings remain active regression signals in `scripts/performance/budget.json`;
the 40-role contract is documented there without turning the uncalibrated
current tree into a passing browser budget.
