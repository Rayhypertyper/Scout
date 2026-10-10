/**
 * Add or remove starting URLs here. The crawler itself does not need to change.
 * URLs may point at company career pages, individual jobs, or GitHub repositories.
 */

import { ZSHAH_DASHBOARD_URL } from "./zshahSource.js";

export const SOURCES: string[] = [
  "https://www.intern-list.com/",
  "https://csjobs.ca/internships/toronto",
  "https://didtheboysgrindleetcodetoday.com/jobs",
  "https://earlycareerradar.com/summer-internships?locations=all",
  "https://github.com/DereC4/internships-and-newgrad",
  "https://github.com/SimplifyJobs/Summer2027-Internships",
  "https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/data-science-ai-machine-learning.md",
  "https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/software-engineering.md",
  "https://github.com/dreamworkhq/Tech-Internships-2027",
  "https://github.com/jobbie-bot/Summer-2027-Tech-Internships",
  "https://github.com/hanzili/canada_sde_intern_position",
  "https://github.com/michelleokolie/canada-tech-internships-summer-2027",
  "https://github.com/negarprh/Canadian-Tech-Internships-2027/blob/main/README.md",
  "https://github.com/speedyapply/2027-SWE-College-Jobs",
  "https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/INTERN_INTL.md",
  // Supplemental public inventories with direct employer/ATS application links.
  "https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/README.md",
  "https://github.com/speedyapply/2027-AI-College-Jobs/blob/main/INTERN_INTL.md",
  "https://github.com/Bobwillrule/Canadian-Internship-List/blob/main/README.md",
  "https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/hardware-engineering.md",
  "https://github.com/vanshb03/Summer2027-Internships",
  // The dashboard has the full inventory; its README is a bounded fallback.
  ZSHAH_DASHBOARD_URL,
  "https://interninsider.me/internships/new",
  "https://www.applybolt.app/jobs/2027-all-internships",
  // Useno's public masterlist is parsed from its structured payload. The
  // dedicated adapter checks the Software Engineering & Technology and Data,
  // AI & Analytics tabs and keeps only Canada/U.S. locations.
  "https://www.useno.app/resources/internship-masterlist",
];
