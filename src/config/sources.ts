/**
 * Add or remove starting URLs here. The crawler itself does not need to change.
 * URLs may point at company career pages, individual jobs, or GitHub repositories.
 */

export const SOURCES: string[] = [
  "https://csjobs.ca/internships/toronto",
  "https://didtheboysgrindleetcodetoday.com/jobs",
  "https://earlycareerradar.com/summer-internships?locations=country%3ACanada%7Cus&years=1st+year%2C2nd+year%2C3rd+year%2C4th+year%2CAny+undergraduate+year%2CUndergraduate+%E2%80%94+year+not+stated%2CNot+stated",
  "https://github.com/DereC4/internships-and-newgrad",
  "https://github.com/SimplifyJobs/Summer2027-Internships",
  "https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/data-science-ai-machine-learning.md",
  "https://github.com/SuryaHarikrishnan/2027-internship-tracker/blob/master/listings/software-engineering.md",
  "https://github.com/dreamworkhq/Tech-Internships-2027",
  "https://github.com/hanzili/canada_sde_intern_position",
  "https://github.com/michelleokolie/canada-tech-internships-summer-2027",
  "https://github.com/negarprh/Canadian-Tech-Internships-2027/blob/main/README.md",
  "https://github.com/speedyapply/2027-SWE-College-Jobs",
  "https://github.com/speedyapply/2027-SWE-College-Jobs/blob/main/INTERN_INTL.md",
  "https://github.com/vanshb03/Summer2027-Internships",
  "https://github.com/zshah101/Automated-List-Of-Summer-2027-and-Fall-2026-Tech-Internships",
  "https://interninsider.me/internships/new",
  "https://www.applybolt.app/jobs/2027-all-internships",
  // Keep the root and explicit category pages scheduled. The Intern List
  // adapter deduplicates their shared structured feeds and follows the Canada
  // tab for the SWE and AI/ML pages.
  "https://www.intern-list.com/",
  "https://www.intern-list.com/?k=swe",
  "https://www.intern-list.com/?k=aiml",
  "https://www.intern-list.com/?k=eng",
  // Useno's public masterlist is parsed from its structured payload. The
  // dedicated adapter checks the Software Engineering & Technology and Data,
  // AI & Analytics tabs and keeps only Canada/U.S. locations.
  "https://www.useno.app/internship-masterlist",
];
