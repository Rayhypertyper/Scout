const QUANT_TITLE_PATTERN = /\b(?:quant|quantitative|trade|trader|trading)\b/i;
const INTERNSHIP_TITLE_PATTERN = /(?:^|[^a-z])intern(?:ship)?s?(?=$|[^a-z])|(?:^|[^a-z])co[\s\-–—‑]*op(?=$|[^a-z])/i;
const INTERNSHIP_SIGNAL_PATTERN = /\b(?:intern(?:s|ship(?:s)?)?|co[\s-]?ops?|cooperative education|student(?:s)?\s+(?:role|position|program|placement|opportunity|term)|undergrad(?:uate)?s?\s+(?:program|role|position|placement|opportunity)|graduate[s]?\s+(?:program|role|position|placement|opportunity)|university|college|campus|placement|work[- ]?term|summer (?:analyst|associate|program)|industrial placement)\b/i;
const DIRECT_INTERNSHIP_TERM_PATTERN = /\b(?:intern(?:s|ship(?:s)?)?|co[\s-]?ops?|cooperative education)\b/i;
const STRONG_SOFTWARE_TITLE_PATTERN = /\b(?:software|developer|front[ -]?end|back[ -]?end|full[ -]?stack|mobile|ios|android|sdet|test automation|automation engineer|qa engineer|devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|data engineer|machine learning|ml engineer|ai engineer|computer vision|nlp|embedded software|firmware|security engineer|cybersecurity|quantitative developer|research engineer|robotics software)\b/i;
const SUMMER_2027_PATTERN = /\b(?:summer(?:\s+of)?\s+2027|2027\s+summer)\b/i;

export const ROLE_TABS = ["main", "canada", "summer", "internship", "quant", "non-intern"];

export function isCanadaRole(role) {
  return (role.normalizedLocations || []).some((location) => (
    location.remoteScope === "canada"
    || ["canada", "canadian"].includes(String(location.country || "").toLowerCase())
  ));
}

export function isQuantRole(role) {
  return (role.categories || []).includes("quant") || QUANT_TITLE_PATTERN.test(String(role.title || ""));
}

export function isSummerRole(role) {
  const title = String(role.title || "").normalize("NFKC");
  const postingText = [
    role.description,
    ...(role.responsibilities || []),
    ...(role.requiredQualifications || []),
    ...(role.preferredQualifications || []),
  ].filter(Boolean).join("\n");
  const summerText = [title, postingText, role.internshipTerm, role.internshipYear]
    .filter(Boolean)
    .join("\n");
  return (INTERNSHIP_SIGNAL_PATTERN.test(title)
    || DIRECT_INTERNSHIP_TERM_PATTERN.test(postingText)
    || INTERNSHIP_SIGNAL_PATTERN.test(postingText))
    && STRONG_SOFTWARE_TITLE_PATTERN.test(title)
    && SUMMER_2027_PATTERN.test(summerText);
}

export function isInternshipRole(role) {
  return INTERNSHIP_TITLE_PATTERN.test(String(role.title || "").normalize("NFKC"))
    || Boolean(role.internshipTerm);
}

export function roleMatchesTab(role, tab) {
  if (tab === "canada") return isCanadaRole(role) && isInternshipRole(role);
  const quant = isQuantRole(role);
  if (tab === "quant") return quant;
  if (quant) return false;
  const internship = isInternshipRole(role);
  if (tab === "summer") return isSummerRole(role);
  if (tab === "internship") return internship;
  if (tab === "non-intern") return !internship;
  return true;
}
