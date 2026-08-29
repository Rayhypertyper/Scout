# Useno internship masterlist crawl

The scheduled source
`https://www.useno.app/internship-masterlist` is parsed from its public
`ml-data` JSON payload. The parser selects the configured Software and Data,
AI & Analytics categories and retains complete rows only when they describe an
internship in Canada, the United States, or an accepted remote scope. Rows
marked early-career, outside the target geography, or in other categories are
excluded before they become source listings.

Run it independently with:

```sh
npm run crawl:useno-masterlist
```

The default artifact is `output/useno-internship-masterlist.json`. The normal
crawler records each eligible row as a source-backed listing while explicitly
marking employer descriptions and qualifications as unavailable from this
masterlist; its linked employer page is not fetched by the Useno source pass.
`defaultVisibleCount` describes complete rows in the selected categories before
target-location filtering, while `eligibleCount` and `skippedLocationCount`
document the hard geography rules. Excluded rows do not enter the active
listing set.
