# Useno Summer 2027 crawl

The page `https://www.useno.app/summer-2027-internships` is the legacy Useno
snapshot route. It remains temporarily removed from the normal `SOURCES` list;
scheduled crawls use the current
`https://www.useno.app/internship-masterlist` source instead. The legacy parser
remains available for an explicit manual crawl and records direct application
URLs without opening those outbound links.

Run it with:

```sh
npm run crawl:useno
```

The default output is `output/useno-summer-2027-internships.json`. A custom page
URL and output path can be supplied to the manual command. The manual path
reuses the existing HTTP cache, including `ETag` and `Last-Modified` conditional
requests, and checks `robots.txt` before fetching the page.

The parser fails closed if the page’s displayed total does not equal the parsed row total, if category totals diverge, or if a row is missing company, title, location, or an application URL. It preserves the observed `data-region` value and raw semicolon-delimited locations, including the current `other` region.

The live snapshot captured on August 15, 2026 contains 402 internships in 10 categories and is stored at `output/useno-summer-2027-internships.json`.
