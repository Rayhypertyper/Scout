import { canonicalizeUrl, normalizedJobUrl } from "../utils/url.js";

/**
 * Public company/ATS destinations verified for aggregator records whose Apply
 * controls require an account. Keys are exact aggregator job IDs, so an
 * override cannot leak onto a similarly titled listing.
 */
const EXACT_APPLICATION_OVERRIDE_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["https://jobright.ai/jobs/info/6a91d9989864261ccd29f558", "https://jobs.intuit.com/job/mountain-view/summer-2027-software-engineering-intern-full-stack/27595/99856180864?jr_id=6a91d9989864261ccd29f558"],
  ["https://jobright.ai/jobs/info/68e6e8c41852e62f0082056d", "https://www.amazon.jobs/en/jobs/3104589/robotics-applied-scientist-ii-intern-co-op-2026-robotics-manipulation-perception-motion-planning-autonomous-mobile-robots-computer-vision-machine-learning-controls-and-more"],
  ["https://jobright.ai/jobs/info/6a5eff6d470d4126fdeaca09", "https://amazon.jobs/en/jobs/10412530/software-development-engineer-intern-aws-data-services-fall-2026-us"],
  ["https://jobright.ai/jobs/info/692fb5c0fa28370be26ad070", "https://www.amazon.jobs/en/jobs/3136266/robotics-software-development-engineer-intern-co-op-2026"],
  ["https://jobright.ai/jobs/info/6a55b3922ce8bf79a139f963", "https://www.amazon.jobs/en/jobs/3116030/software-development-engineer-internship-fall-2026-us"],
  ["https://jobright.ai/jobs/info/6a79ae49a26ccc369f83a7df", "https://www.ycombinator.com/companies/one-robot/jobs/tJSlTgB-machine-learning-intern"],
  ["https://jobright.ai/jobs/info/6a10f1de9fdbf21f36cb1a04", "https://jobs.lever.co/plus-2/b4f750e7-0148-41f0-b2b1-ff054450a320"],
  ["https://jobright.ai/jobs/info/6a56921ef7517b519ad5687c", "https://careers.rivian.com/careers-home/jobs/29851?lang=en-us"],
  ["https://jobright.ai/jobs/info/6a55f31cf7517b519ad5221c", "https://ats.rippling.com/rippling/jobs/82c13e8f-ae96-4c60-a872-c0ddf9eb0781"],
  ["https://jobright.ai/jobs/info/6a071a32078fec52738a90b2", "https://job-boards.greenhouse.io/tenstorrentuniversity/jobs/4968215007"],
  ["https://jobright.ai/jobs/info/6a4c26c24f64ba41dcb5eb38", "https://www.bluerivertechnology.com/job/?gh_jid=7947246"],
  ["https://jobright.ai/jobs/info/6a6a7ac616c69119640fe97b", "https://tetramem.hrmdirect.com/employment/job-opening.php?nohd=&req=3404209&req_loc=813128"],
  ["https://jobright.ai/jobs/info/6a7ab6f5a26ccc369f83f354", "https://www.tesla.com/careers/search/job/internship-applied-ai-engineer-ai-hardware-fall-2026--262946"],
  ["https://jobright.ai/jobs/info/698d46c70f6f7e7a2ce919f7", "https://www.amazon.jobs/en/jobs/3179209/software-development-engineer-fall-intern-military-veteran"],
  ["https://jobright.ai/jobs/info/6a7be90fecfd29770753b1db", "https://automationanywhere.wd5.myworkdayjobs.com/en-US/AutomationAnywhereJobs/job/SDET-Intern_JR1311"],
  ["https://jobright.ai/jobs/info/6a5ffce76e0c3c7c7d3da557", "https://osv-cci.wd1.myworkdayjobs.com/en-US/CCICareers/job/Stamford-CT/Data-Science-Machine-Learning-Internship--Summer-2027-_R1344"],
  ["https://jobright.ai/jobs/info/69ff8357c4b08448a0b185e4", "https://apply.workable.com/eluvio/j/F70F3473E7/apply/"],
  ["https://jobright.ai/jobs/info/6a55f03a392ae330b30e7f54", "https://jobs.ashbyhq.com/human-computer-lab/7d13ae27-1f02-4d9b-8d39-e3d9d67df705"],
  ["https://jobright.ai/jobs/info/6a7b6fc7ecf5194164fbdef3", "https://www.object.tech/jobs/machine-learning-eng-intern"],
  ["https://jobright.ai/jobs/info/6a50754d397d8d353c28eb23", "https://ats.rippling.com/spreeai/jobs/aa087086-dd4b-42be-a499-051546655e97"],
  ["https://jobright.ai/jobs/info/6a5e8ac567b2850e77df1e91", "https://jobs.smartrecruiters.com/WesternDigital/744000138727213-summer-2027-software-engineering-internship"],
  ["https://interninsider.me/internships/ancestry/machine-learning-engineer-co-op-3fa190f6-aa31-4d31-932a-b03099136fdb", "https://careers.ancestry.com/jobs/machine-learning-engineer-co-op-lehi-utah-united-states-f380d23f-b767-462c-a787-959a4c4e5cb8"],
  ["https://interninsider.me/internships/iko-north-america/data-engineer-co-op-29d44cad-8fec-4157-af75-92e8786a9fc5", "https://iko.wd3.myworkdayjobs.com/en-US/IKO_Careers/job/Mississauga-ON/Data-Engineer-Co-Op_REQ-13629"],
  ["https://simplify.jobs/p/28053adc-4960-4b2a-8386-71e1aba8148e/Quantitative-Developer-Intern", "https://job-boards.greenhouse.io/walleyecapital-external-students/jobs/4679168006"],
  ["https://jobright.ai/jobs/info/6a62dda199515267a6f00561", "https://jobs.ashbyhq.com/quadrillion-labs/a4acc44c-31ce-41a0-ab44-2500487b4d05"],
  ["https://jobright.ai/jobs/info/6a70bcdbe2b7476e7b20a819", "https://www.samsara.com/company/careers/roles/8082091?gh_board=samsara&gh_jid=8082091"],
  ["https://jobright.ai/jobs/info/6a600e2d33ef5c58b4001914", "https://group.bnpparibas/en/careers/job-offer/2027-summer-assistant-vice-president-internship-corporate-functions-analytics-lab-machine-learning-engineer"],
  ["https://jobright.ai/jobs/info/6a30578ceace377055eb5c2d", "https://careers-cotiviti.icims.com/jobs/19341/job?mobile=true&needsRedirect=false"],
  ["https://jobright.ai/jobs/info/693c8a77aa598a08c3ed5e37", "https://job-boards.greenhouse.io/tenstorrentuniversity/jobs/4501164007"],
  ["https://jobright.ai/jobs/info/6a7bb3003b399d106e4d8057", "https://cccis.wd1.myworkdayjobs.com/broadbean_external/job/Chicago-Green-St-IL/R-D---Data-Science-Internship-Fall-2026_0014841"],
  ["https://jobright.ai/jobs/info/6a7ba17e3b399d106e4d7c2f", "https://salesforce.wd12.myworkdayjobs.com/External_Career_Site/job/California---San-Francisco/Software-Engineering-Intern---Future-Pathways_JR355842"],
  ["https://jobright.ai/jobs/info/6a79e3669ee17f276dbeff4f", "https://joinbytedance.com/search/7671291260529821957"],
  ["https://jobright.ai/jobs/info/6a7ae05bb17cba5690368438", "https://joinbytedance.com/search/7672382828525832501"],
  ["https://jobright.ai/jobs/info/6a7b50fb77e6b569c61bfb57", "https://joinbytedance.com/search/7672386983965100341"],
  ["https://jobright.ai/jobs/info/6a79e376bb6ca93ae5618997", "https://joinbytedance.com/search/7671105026009925893"],
  ["https://jobright.ai/jobs/info/6a7ae0609ee17f276dbf439c", "https://joinbytedance.com/search/7672392998231050549"],
  ["https://jobright.ai/jobs/info/6a6b0e4b32f9300c3a3dc892", "https://joinbytedance.com/search/7535171166420453639"],
  ["https://jobright.ai/jobs/info/6a7b4dbeb933773d16be665f", "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1001/job/210773869"],
  ["https://jobright.ai/jobs/info/6a6beef9c00ae03109f86a52", "https://careers.newyorklife.com/careers/job/43612543"],
  ["https://jobright.ai/jobs/info/6a6db0b3ad0fe2053db9c954", "https://careers.newyorklife.com/careers/job/43624352"],
  ["https://jobright.ai/jobs/info/6a7bda3db933773d16be966a", "https://careers.ibm.com/careers/JobDetail?jobId=128513"],
  ["https://jobright.ai/jobs/info/6a7ad6a0ab1385611f900364", "https://careers.tiktokusds.com/usds/position/7671509975932324149/detail"],
  ["https://jobright.ai/jobs/info/6a7ba2faecfd29770753a513", "https://www.linkedin.com/jobs/view/software-engineer-intern-at-timbersync-4452696205"],
];

const EXACT_APPLICATION_OVERRIDES = new Map<string, string>(
  EXACT_APPLICATION_OVERRIDE_ENTRIES.map(([source, target]) => [normalizedJobUrl(source), target] as const),
);

const KNOWN_CLOSED_AGGREGATOR_POSTINGS = new Set([
  // The original Greenhouse requisition now redirects to the Blue Sky board
  // with error=true and no longer appears among its current openings.
  "https://jobright.ai/jobs/info/69da8f9e9f97a42dc9c296ed",
  // Exact listings verified against the original employer boards. The roles
  // are absent/closed there even though an aggregator can still render a copy.
  "https://jobright.ai/jobs/info/6a7b8a2aecfd297707539ca3", // Fullbay
  "https://jobright.ai/jobs/info/6a7bec6183621355407a84c8", // Philo Homes
  "https://jobright.ai/jobs/info/6a77c63a67a1ad0bc53cce34", // Postman
  "https://jobright.ai/jobs/info/6a7605b37b3417772ade6359", // Epic
  "https://jobright.ai/jobs/info/6a6cdd58acb0a61f9dbc7964", // Persona
  "https://jobright.ai/jobs/info/6a7b256fecfd2977075371aa", // Quantbot Technologies
  "https://jobright.ai/jobs/info/6a7b256db933773d16be5785", // Quantbot Technologies
  "https://jobright.ai/jobs/info/6a6bfaa9acb0a61f9dbc3c2c", // Heliux
  "https://jobright.ai/jobs/info/6a51bc1602522b5b722ea89b", // Williams-Sonoma — stated Fall 2025 term is over
].map(normalizedJobUrl));

export function directApplicationOverride(value: string): string | null {
  try {
    const target = EXACT_APPLICATION_OVERRIDES.get(normalizedJobUrl(value));
    return target ? canonicalizeUrl(target) : null;
  } catch {
    return null;
  }
}

export function knownClosedAggregatorPosting(value: string): boolean {
  try {
    return KNOWN_CLOSED_AGGREGATOR_POSTINGS.has(normalizedJobUrl(value));
  } catch {
    return false;
  }
}
