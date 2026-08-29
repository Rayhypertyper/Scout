import { canonicalizeUrl } from "../utils/url.js";

/**
 * Sources from the temporary 80-company SWE job-board expansion.
 *
 * These URLs remain in historical crawl records, but are no longer active
 * crawler sources and should not be presented as current provenance in the
 * dashboard.
 */
export const REMOVED_SWE_JOB_BOARD_SOURCES = [
  // S+
  "https://www.metacareers.com/jobs/?q=software%20engineering%20intern",
  "https://jobs.lever.co/palantir",
  "https://careers.snowflake.com/us/en/search-results",
  "https://jobs.bytedance.com/en/position",
  "https://careers.twosigma.com/careers",
  "https://www.citadel.com/careers/open-opportunities/",
  "https://job-boards.greenhouse.io/scaleai",
  "https://www.coreweave.com/careers",
  "https://jobs.ashbyhq.com/anduril",
  "https://jobs.ashbyhq.com/perplexity",
  "https://jobs.ashbyhq.com/xai",
  "https://mistral.ai/careers/",
  "https://jobs.ashbyhq.com/cohere",
  "https://apply.workable.com/huggingface/",
  "https://job-boards.greenhouse.io/figma",
  "https://jobs.ashbyhq.com/vercel",
  "https://www.cloudflare.com/careers/jobs/",
  "https://www.notion.so/careers",
  "https://jobs.ashbyhq.com/ramp",
  "https://www.rippling.com/careers",

  // S
  "https://www.shopify.com/careers",
  "https://about.gitlab.com/jobs/",
  "https://www.mongodb.com/careers",
  "https://www.elastic.co/about/careers",
  "https://careers.amd.com/careers-home/",
  "https://www.qualcomm.com/company/careers",
  "https://careers.arm.com/",
  "https://jobs.cisco.com/",
  "https://careers.servicenow.com/",
  "https://workday.wd5.myworkdayjobs.com/Workday",
  "https://careers.linkedin.com/jobs",
  "https://www.lifeatspotify.com/jobs",
  "https://www.fastly.com/about/careers/current-openings",
  "https://www.confluent.io/about/careers/",
  "https://www.cockroachlabs.com/careers/open-positions/",
  "https://www.hashicorp.com/careers/open-positions",
  "https://github.com/about/careers",
  "https://www.redditinc.com/careers",
  "https://www.box.com/en-us/about-us/careers",
  "https://jobs.dropbox.com/",

  // A
  "https://www.twilio.com/en-us/company/jobs",
  "https://www.hubspot.com/careers",
  "https://www.okta.com/company/careers/",
  "https://careers.zoom.us/",
  "https://instacart.careers/",
  "https://www.lyft.com/careers",
  "https://www.brex.com/careers",
  "https://www.samsara.com/company/careers/roles",
  "https://plaid.com/careers/",
  "https://www.affirm.com/careers",
  "https://careers.robinhood.com/",
  "https://asana.com/jobs",
  "https://airtable.com/careers",
  "https://careers.toasttab.com/",
  "https://gusto.com/about/careers",
  "https://launchdarkly.com/careers/",
  "https://www.benchling.com/careers",
  "https://miro.com/careers/",
  "https://www.grammarly.com/jobs",
  "https://www.circle.com/en/careers",

  // High B
  "https://www.digitalocean.com/careers",
  "https://www.pagerduty.com/careers/",
  "https://newrelic.com/about/careers",
  "https://careers.unity.com/",
  "https://www.epicgames.com/site/en-US/careers",
  "https://www.ea.com/careers",
  "https://www.autodesk.com/careers",
  "https://www.zillowgroupcareers.com/",
  "https://www.wayfair.com/careers",
  "https://www.etsy.com/careers",
  "https://jobs.ebayinc.com/us/en",
  "https://jobs.intuit.com/",
  "https://block.xyz/careers",
  "https://www.faire.com/careers",
  "https://mercury.com/careers",
  "https://www.chime.com/careers/",
  "https://www.sofi.com/careers/",
  "https://www.deel.com/careers",
  "https://webflow.com/careers",
  "https://www.squarespace.com/about/careers",
] as const;

const removedSWEJobBoardSources = new Set(REMOVED_SWE_JOB_BOARD_SOURCES.map((source) => canonicalizeUrl(source)));

export function isRemovedSWEJobBoardSource(source: string): boolean {
  try {
    return removedSWEJobBoardSources.has(canonicalizeUrl(source));
  } catch {
    return false;
  }
}

export function visibleProvenanceSources(sources: readonly string[]): string[] {
  return sources.filter((source) => !isRemovedSWEJobBoardSource(source));
}
