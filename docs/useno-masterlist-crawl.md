# Useno internship masterlist crawl

The scheduled source
`https://www.useno.app/resources/internship-masterlist` is parsed from its public
`ml-data` JSON payload and the paginated `/data/internship-index.json` feed linked
by the page. The legacy `/internship-masterlist` URL remains an accepted alias;
the configured source catalog converges both URLs on the resources route. The parser selects the configured Software and Data,
AI & Analytics categories and retains complete rows only when they describe an
internship in Canada, the United States, or an accepted remote scope. Rows
marked early-career, outside the target geography, or in other categories are
excluded before they become source listings.

Run it independently with:

```sh
npm run crawl:useno-masterlist
```

The default artifact is `output/useno-internship-masterlist.json`; the adjacent
`.feed.json` file retains every retrieved public row and pagination metadata.
The normal crawler records each eligible row as a source-backed listing while
explicitly marking employer descriptions and qualifications as unavailable
from this masterlist. It recovers employer links by matching the exact ATS
requisition within the same employer against saved active listings, or by
looking up that requisition in anonymous public employer feeds. Historical
closed records can provide a board address for a fresh lookup, but their links
are never reused as active without that lookup. Supported recovery paths include
Greenhouse, Lever, Ashby, Workday, Workable, SmartRecruiters, iCIMS and Oracle.
Recovery remains bounded and uses the shared HTTP cache, concurrency limits and
cancellation signal. Unresolved rows retain `/internship/<encoded-id>` links;
blank URLs without a source job ID are skipped. A blank URL can never resolve to
the source masterlist.
`defaultVisibleCount` describes complete rows in the selected categories before
target-location filtering, while `eligibleCount` and `skippedLocationCount`
document the hard geography rules. Excluded rows do not enter the active
listing set. Rows in Useno's current published feed retain the existing
source-listed open status; employer availability is not independently guaranteed.

The explicit source-specific crawl authorization covers the first-party JSON
feed despite its advisory robots disallow. The exception applies only to the
same-origin feed linked by the masterlist. Authentication gates, employer robots
policies and ordinary transport controls remain enforced. A capped public feed
always records `coverageComplete: false`, so unseen historical roles cannot be
marked closed from a partial public snapshot. Pagination failures, repeated IDs,
changing totals and stale responses fail the source before publication.

A saved crawl can be imported without repeating its network requests:

```sh
node --import tsx scripts/import-useno-masterlist.ts output/useno-recovery-2026-10-06/masterlist.json --database output/live/internships.db --output-dir output/useno-recovery-2026-10-06
```

The importer validates the artifact, respects the normal crawl lease, uses the
existing canonicalization/deduplication and persistence APIs, and writes an
auditable crawl run. It also retires the invalid historical record whose
application URL was the masterlist itself, while retaining its history. It does
not close legitimate jobs merely because they are absent from the capped feed.

The October 6, 2026 recovery collected all four publicly available pages:
7,768 source rows from a declared corpus of 22,663. The board's existing category
and geography rules retained 1,252 roles. Employer recovery obtained 945 distinct
direct application URLs; 307 rows retained their individual Useno listing link.
The snapshot and import evidence are saved under
`output/useno-recovery-2026-10-06/`.

Import run 756 completed at 5:28 p.m. Toronto time on October 6. Deduplication
produced 1,223 stored Useno-linked jobs: 541 new, 573 updated and 109 unchanged.
After merging with existing board records, 958 jobs have direct employer links
and 265 retain individual Useno links. No legitimate job was closed because of
absence from the capped feed, and no active row retains the masterlist as its
application URL. The live `/api/roles` endpoint served the newly imported AltaGas
listing. The production build, lint for changed code and 70 targeted tests passed.
The source-specific snapshot remains coverage-incomplete because the public feed
does not expose the entire declared corpus.
