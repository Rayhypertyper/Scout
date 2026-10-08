# ApplyBolt public internship crawl

The configured source is `https://www.applybolt.app/jobs/2027-all-internships`.
Its table points to public ApplyBolt job pages, whose `job-direct-applylink`
anchors expose the employer or ATS application URL. The parser also supports
the older `job-seo-applylink` markup and normalizes the board's SF/NYC location
abbreviations.

The static adapter reads the advertised page count and fetches pagination with
bounded workers. It collects every discovered posting before normal role and
location classification. Its safety bounds are 500 listing pages and 25,000
detail candidates, replacing the former 30-page and 500-detail truncation.
The inventory and advertised count are saved in
`output/live/applybolt-inventory.json` when using the live configuration.

Each detail response is parsed and published as it arrives. An explicit
employer/ATS link is retained directly; application forms need not be opened
to discover their destinations. Wrapper links still use the existing resolver.
Consumed detail bodies are released, and the HTTP client's memory cache is
bounded while its disk cache remains available for future runs.
ApplyBolt requests receive a 30-second budget so a transient slow response does
not repeatedly hit the default ten-second connect/read ceiling.

A failed pagination request, a safety-bound truncation, or fewer unique
postings than the source advertises leaves coverage incomplete. Healthy rows
still reach the board, but absence in this crawl cannot close existing jobs.
Live boards can change between page requests, so a count gap is reported even
when all pagination requests succeed.

Run through the normal persistence flow:

```sh
npm run scout -- --source https://www.applybolt.app/jobs/2027-all-internships
```

Focused regression coverage verifies discovery beyond both former limits,
partial pagination, current employer-link markup, SF location classification,
and streaming publication without opening the employer application form.
