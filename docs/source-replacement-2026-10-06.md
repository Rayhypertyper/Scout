# Intern List public retrieval — October 6, 2026

Only URLs under `https://swan-api.jobright.ai/swan/mini-sites/list` are retired.
HTTP requests, redirects, and browser subrequests to that prefix are blocked
before contacting it. Intern List HTML and public Jobright embed HTML remain
usable through the ordinary robots policy.

Intern List is restored as one configured source. Historical root/category and
embed aliases normalize to that root, including manual scout invocations. The
adapter discovers every country/category pair from `data-job-path` attributes,
reads each embed's validated `__NEXT_DATA__` without executing JavaScript,
follows the five CMS listing collections' actual pagination links, and unions
their detail URLs with the sitemap. The sitemap also includes a data-science
collection whose index page is unavailable.

Records are merged by job identity, with full CMS descriptions preferred over
abbreviated SSR qualifications. Hidden Webflow closed banners are ignored;
visible closed banners provide explicit closure evidence. Repeated
posting/expiry dates are not treated as real deadlines. Benefits remain in the
full description without being folded into required qualifications.

## Live evidence

| Surface | Observed coverage |
| --- | ---: |
| US tabs | 21 |
| Canada tabs | 9 |
| Public CMS listing pages | 15, exhausting five collections |
| Sitemap job detail URLs | 1,518 |
| Retrieved and parsed CMS details | 1,518 |
| Distinct CMS/SSR job records in the latest audit | 2,541 |
| Additional incomplete data-science records | 255 |
| Transport or parse failures after template support | 0 |

The data-science template supplies descriptions, qualifications, locations,
companies and dates, but renders `Heading` as its title and `#` as its Apply
links. These 255 records are saved separately in `incomplete-jobs.json`.
Missing title/application fields are not invented or published as usable jobs.

All 30 tabs advertise more records than their SSR first page exposes. Their
initial advertised totals summed to 68,618 tab memberships, with possible overlaps; first
pages provide 1,497 distinct identities counted within individual tabs. Public
position/count query parameters returned the same first page. The deployed
client implements Load More through the retired endpoint. No working
alternative full-tab pagination route has been verified. Other CMS records
remain useful, but cannot prove exhaustion of each embedded feed.

Overall coverage therefore stays **partial**. Per-tab counts, advertised totals,
detail overlap, failures, bounds and completeness are stored in source strategy
metadata and source-run coverage notes. Partial coverage prevents missing-job
reconciliation. Jobright applications still require a verified employer/ATS
destination. Historical category caches and the independent destination
resolver are reused; anonymous Jobright Apply controls may require sign-in.
Retrieving a record does not automatically make its application usable.

The four supplemental GitHub sources added earlier remain configured:
SpeedyApply US/international AI, Canadian Internship List and Surya hardware.

## Commands and artifacts

```sh
npm run crawl:intern-list -- --output-dir output/intern-list-public
npx tsx scripts/audit-intern-list-coverage.ts --output-dir output/intern-list-public
# Diagnostic bounds explicitly report incomplete detail coverage:
npm run crawl:intern-list -- --max-detail-pages 10 --output-dir output/intern-list-sample
```

`--cache-dir` optionally selects the scout output/cache directory. The default
uses the configured scout output directory. Scripts save `inventory.json`,
`jobs.json`, and `incomplete-jobs.json` through HTTP-only retrieval.

The live audit is in `output/intern-list-public-2026-10-06/`. Full crawler and
persistence validation used an isolated database in `output/intern-list-validation/`:
two category aliases became one source, physical-page and per-part counts
survived persistence, and coverage remained partial. With a cold destination
cache, 904 qualifying records lacked a verified employer URL; zero unusable
applications were published. Public HTML cache entries were also copied into
the scheduled crawler cache for activation.

The production build, scoped lint, and 112 focused tests passed. Live source
run 760 and scheduled run 761 saved all 38 inventory parts (including 30 tabs),
reported 1,565 physical pages, and retained partial coverage. Qualifying roles
without verified employer destinations were excluded from new usable imports;
old Intern List pages are also rejected as employer destinations. Historical
source rows and listings remain intact. The scheduler was reloaded with one
Intern List root in its 23-source catalog and no retired endpoint URLs.
