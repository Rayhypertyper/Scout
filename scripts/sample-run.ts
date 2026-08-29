import { rm } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { join } from "node:path";

import { resolveSettings } from "../src/config/settings.js";
import { MIN_LISTING_SCORE } from "../src/config/thresholds.js";
import type { ScoutRunOptions } from "../src/domain/types.js";
import { runScout } from "../src/scout.js";

function send(response: ServerResponse, body: string, status = 200, contentType = "text/html; charset=utf-8"): void {
  response.writeHead(status, { "content-type": contentType });
  response.end(body);
}

function jobPage(baseUrl: string, job: {
  id: string;
  company: string;
  title: string;
  location: string;
  description: string;
}): string {
  return `<!doctype html>
<html>
  <head>
    <title>${job.title} — ${job.company}</title>
    <script type="application/ld+json">
      ${JSON.stringify({
        "@context": "https://schema.org",
        "@type": "JobPosting",
        title: job.title,
        identifier: { "@type": "PropertyValue", value: job.id },
        hiringOrganization: { "@type": "Organization", name: job.company },
        jobLocation: {
          "@type": "Place",
          address: { "@type": "PostalAddress", addressLocality: job.location.split(",")[0], addressRegion: job.location.split(",")[1], addressCountry: "Canada" },
        },
        description: job.description,
        datePosted: "2027-01-15",
        validThrough: "2027-03-15T23:59:59Z",
        url: `${baseUrl}/jobs/${job.id}`,
      })}
    </script>
  </head>
  <body><main><h1>${job.title}</h1><a href="/apply/${job.id}">Apply Now</a></main></body>
</html>`;
}

const softwareDescription = `
  <h2>Responsibilities</h2>
  <ul><li>Develop TypeScript and Node.js APIs for distributed systems.</li><li>Write automated tests and debug production software.</li></ul>
  <h2>Required Qualifications</h2>
  <ul><li>Currently pursuing a Bachelor's degree in Computer Science.</li><li>Experience with TypeScript, SQL, and Git.</li><li>Must be authorized to work in Canada.</li></ul>
  <h2>Preferred Qualifications</h2><ul><li>Experience with AWS and Docker.</li></ul>
  <p>This is a 12-week Summer 2027 internship. We do not provide visa sponsorship.</p>`;

const dataDescription = `
  <h2>What you'll do</h2>
  <ul><li>Build Python and SQL data pipelines on AWS.</li><li>Implement and test Airflow services for machine learning data.</li></ul>
  <h2>Minimum Qualifications</h2>
  <ul><li>Currently enrolled in a Bachelor's or Master's degree in Computer Science.</li><li>Must return to school after the co-op.</li></ul>
  <h2>Preferred Qualifications</h2><ul><li>Knowledge of Docker and Spark.</li></ul>
  <p>This Fall 2027 co-op lasts four months and is hybrid.</p>`;

const marketingDescription = `
  <h2>Responsibilities</h2><ul><li>Create social media campaigns and coordinate brand events.</li><li>Perform lead generation research.</li></ul>
  <h2>Requirements</h2><ul><li>Currently pursuing a business degree.</li></ul>
  <p>This is a Summer 2027 internship.</p>`;

async function main(): Promise<void> {
  const outputDirectory = join(process.cwd(), "output", "sample");
  await rm(outputDirectory, { recursive: true, force: true });
  const server = createServer((request, response) => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Sample server did not bind to a TCP port");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const path = new URL(request.url ?? "/", baseUrl).pathname;
    if (path === "/robots.txt") {
      send(response, "User-agent: *\nAllow: /\nCrawl-delay: 0\n", 200, "text/plain");
    } else if (path === "/careers") {
      send(response, `<!doctype html><html><body><main>
        <h1>Student careers</h1>
        <a href="/jobs/NS-1001?utm_source=sample">Software Engineering Intern</a>
        <a href="/jobs/MKT-2001">Marketing Intern</a>
        <a href="/mirror/NS-1001">Software internship duplicate listing</a>
        <div id="more"></div>
        <button id="load">Load more jobs</button>
        <script>
          document.querySelector('#load').addEventListener('click', () => {
            document.querySelector('#more').innerHTML = '<a href="/jobs/MD-3001">Data Engineering Co-op</a>';
            document.querySelector('#load').remove();
          });
        </script>
      </main></body></html>`);
    } else if (path === "/jobs/NS-1001" || path === "/mirror/NS-1001") {
      send(response, jobPage(baseUrl, { id: "NS-1001", company: "Northstar Labs", title: "Software Engineering Intern", location: "Toronto, ON, Canada", description: softwareDescription }));
    } else if (path === "/jobs/MD-3001") {
      send(response, jobPage(baseUrl, { id: "MD-3001", company: "Maple Data Systems", title: "Data Engineering Co-op", location: "Waterloo, ON, Canada", description: dataDescription }));
    } else if (path === "/jobs/MKT-2001") {
      send(response, jobPage(baseUrl, { id: "MKT-2001", company: "Bright Brand", title: "Marketing Intern", location: "Toronto, ON, Canada", description: marketingDescription }));
    } else if (path.startsWith("/apply/")) {
      response.writeHead(302, { location: path.replace("/apply/", "/forms/") });
      response.end();
    } else if (path.startsWith("/forms/")) {
      send(response, "<!doctype html><html><body><main><h1>Application form</h1><form><input name='name'></form></main></body></html>");
    } else {
      send(response, "Not found", 404, "text/plain");
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Sample server did not start");
  const source = `http://127.0.0.1:${address.port}/careers`;
  const settings = resolveSettings({
    databasePath: join(outputDirectory, "internships.db"),
    outputDirectory,
    maxDepth: 3,
    maxPagesPerSource: 20,
    concurrency: 3,
    retryCount: 1,
    timeoutMs: 10_000,
    perHostDelayMs: 0,
    minRelevanceScore: MIN_LISTING_SCORE,
  });
  const options: ScoutRunOptions = {
    sources: [source],
    settings,
    filters: { categories: [], newOnly: false, minScore: MIN_LISTING_SCORE },
  };
  try {
    console.log("\n--- SAMPLE RUN 1 (expect NEW) ---");
    const first = await runScout(options);
    console.log("\n--- SAMPLE RUN 2 (expect UNCHANGED) ---");
    const second = await runScout(options);
    if (first.persisted.counts.NEW !== 2 || second.persisted.counts.UNCHANGED !== 2
      || first.crawl.jobs.length !== 2 || second.crawl.jobs.length !== 2) {
      throw new Error(`Unexpected lifecycle counts: first=${JSON.stringify(first.persisted.counts)} second=${JSON.stringify(second.persisted.counts)}`);
    }
    const firstMetrics = first.crawl.metrics ?? {};
    const secondMetrics = second.crawl.metrics ?? {};
    if ((firstMetrics.newListings ?? 0) !== 2
      || (secondMetrics.newListings ?? 0) !== 0
      || (firstMetrics.detailPagesFetched ?? 0) <= 0
      || (secondMetrics.detailPagesFetched ?? 0) >= (firstMetrics.detailPagesFetched ?? 0)
      || (secondMetrics.detailPagesFetched ?? 0) !== 0
      || (secondMetrics.httpRequests ?? 0) >= (firstMetrics.httpRequests ?? 0)
      || (secondMetrics.unchangedSkips ?? 0) < 2
      || (secondMetrics.browserNavigations ?? 0) > 1) {
      throw new Error(`Incremental fast-path regression: first=${JSON.stringify(firstMetrics)} second=${JSON.stringify(secondMetrics)}`);
    }
    if (second.displayed.some(({ applicationUrl }) => !applicationUrl.includes("/forms/"))) {
      throw new Error("The sample did not resolve a direct application URL.");
    }
    console.log("\nSample verification passed: 2 software internships, direct forms, deduplication, irrelevant-role filtering, and repeat-run state.");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
