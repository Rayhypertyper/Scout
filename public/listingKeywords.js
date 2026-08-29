const TECHNICAL_LISTING_KEYWORDS = [
  "software",
  "developer",
  "development",
  "frontend",
  "front end",
  "front-end",
  "backend",
  "back end",
  "back-end",
  "full stack",
  "full-stack",
  "fullstack",
  "web",
  "mobile",
  "iOS",
  "Android",
  "data",
  "analytics",
  "machine learning",
  "ML",
  "artificial intelligence",
  "AI",
  "AI/ML",
  "GenAI",
  "generative AI",
  "computer vision",
  "NLP",
  "natural language processing",
  "robotics",
  "autonomy",
  "autonomous",
  "perception",
  "computer science",
  "computer engineering",
  "quality assurance",
  "QA",
  "test",
  "testing",
  "automation",
  "SDET",
  "cloud",
  "DevOps",
  "DevSecOps",
  "site reliability",
  "SRE",
  "platform",
  "infrastructure",
  "systems",
  "network",
  "networking",
  "database",
  "algorithm",
  "algorithmic",
  "graphics",
  "blockchain",
  "scientific computing",
  "information technology",
  "IT",
  "technology",
  "technical",
  "programming",
  "programmer",
];

const PLACEMENT_LISTING_KEYWORDS = [
  "intern",
  "co-op",
  "coop",
  "co op",
  "student",
  "trainee",
  "placement",
  "work term",
  "PEY",
];

const PHRASE_SEPARATOR = "[\\s\\-–—‑]+";
const TOKEN_BOUNDARY = "[\\p{L}\\p{N}_]";

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function keywordExpression(keyword) {
  const normalized = keyword.normalize("NFKC").trim().toLocaleLowerCase();
  if (normalized === "intern") return "intern(?:ship)?s?";
  if (normalized === "co-op" || normalized === "coop" || normalized === "co op") return "co[\\s\\-–—‑]?ops?";
  if (normalized === "student") return "students?";
  if (normalized === "trainee") return "trainees?";
  if (normalized === "placement") return "placements?";
  if (normalized === "work term") return "work" + PHRASE_SEPARATOR + "terms?";
  return normalized.split(/\s+/).map(escapeRegExp).join(PHRASE_SEPARATOR);
}

function compileKeywordPattern(keywords) {
  return new RegExp(
    "(?:^|[^" + TOKEN_BOUNDARY.slice(1, -1) + "])(?:"
      + keywords.map(keywordExpression).join("|")
      + ")(?!" + TOKEN_BOUNDARY + ")",
    "iu",
  );
}

const TECHNICAL_LISTING_PATTERN = compileKeywordPattern(TECHNICAL_LISTING_KEYWORDS);
const PLACEMENT_LISTING_PATTERN = compileKeywordPattern(PLACEMENT_LISTING_KEYWORDS);

function roleArray(value) {
  return Array.isArray(value) ? value : value === undefined || value === null || value === "" ? [] : [value];
}

function listingKeywordText(role) {
  return [
    role?.title,
    role?.description,
    ...roleArray(role?.responsibilities),
    ...roleArray(role?.requiredQualifications),
    ...roleArray(role?.preferredQualifications),
    ...roleArray(role?.educationRequirements),
    ...roleArray(role?.graduationRequirements),
    ...roleArray(role?.experienceRequirements),
    ...roleArray(role?.workAuthorizationRequirements),
    role?.sponsorshipInformation,
    ...roleArray(role?.qualificationDetails?.evidence),
    ...roleArray(role?.technologies),
    ...roleArray(role?.categories),
    role?.internshipTerm,
    role?.duration,
  ].filter((value) => value !== undefined && value !== null && value !== "").join("\n").normalize("NFKC");
}

export function hasRequiredListingKeywords(role) {
  const text = listingKeywordText(role);
  return TECHNICAL_LISTING_PATTERN.test(text) && PLACEMENT_LISTING_PATTERN.test(text);
}
