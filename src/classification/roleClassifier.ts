import type { Category } from "../domain/schemas.js";
import { uniqueStrings } from "../utils/text.js";
import { extractTechnologies } from "./technologyExtractor.js";
export {
  cheapListingRelevance,
  classifyListing,
  listingRelevanceScore,
  scoreListingRelevance,
} from "./listingRelevance.js";
export type { ListingRelevanceInput, ListingRelevanceResult, ListingRoutingDecision } from "./listingRelevance.js";

export interface InternshipDetection {
  isInternship: boolean;
  reason: string;
}

export interface RelevanceResult {
  score: number;
  reason: string;
  categories: Category[];
  technologies: string[];
}

export const SCORING_FACTOR_MULTIPLIER = 0.75;

function reduceFactor(points: number): number {
  return Math.round(points * SCORING_FACTOR_MULTIPLIER);
}

export const MISSING_INTERNSHIP_PENALTY = reduceFactor(60);
export const INTERNSHIP_TITLE_BONUS = reduceFactor(45);
export const SUMMER_2027_BONUS = reduceFactor(35);
const STRONG_SOFTWARE_TITLE_BONUS = reduceFactor(38);
const AMBIGUOUS_TECH_TITLE_BONUS = reduceFactor(16);
const PROGRAMMING_RESPONSIBILITY_CAP = reduceFactor(32);
const TECHNOLOGY_SCORE_CAP = reduceFactor(22);
const SOFTWARE_QUALIFICATION_BONUS = reduceFactor(10);
const NON_CODE_TITLE_PENALTY = reduceFactor(55);
const NON_CODE_CONTEXT_PENALTY = reduceFactor(30);

const INTERNSHIP_TITLE = /\b(?:intern(?:s|ship(?:s)?)?|co[ -]?ops?|cooperative education|students?|undergrad(?:uate)?s?|graduates?|university|college|campus|placement|work[- ]?term|summer (?:analyst|associate|program)|industrial placement)\b/i;
const EXPLICIT_INTERNSHIP_TITLE = /\b(?:intern(?:s|ship(?:s)?)?|co[ -]?ops?|cooperative education|student(?:s)?[ -](?:program|role|position|placement|opportunity)|undergrad(?:uate)?[s ]+(?:program|role|position|placement|opportunity)|graduate[s ]+(?:program|role|position|placement|opportunity)|summer (?:analyst|associate|program)|industrial placement|work[- ]?term)\b/i;
const DIRECT_INTERNSHIP_TERM = /\b(?:intern(?:s|ship(?:s)?)?|co[ -]?ops?|cooperative education)\b/i;
const INTERNSHIP_CONTEXT = /\b(?:this|the|an?)\s+(?:paid\s+)?(?:intern(?:s|ship(?:s)?)?|co[ -]?ops?|cooperative education|student(?:s)?[ -](?:program|role|position|placement|opportunity)|undergrad(?:uate)?[s ]+(?:program|role|position|placement|opportunity)|graduate[s ]+(?:program|role|position|placement|opportunity)|summer (?:analyst|associate|program)|industrial placement|work[- ]?term)\s+(?:role|position|opportunity|term|placement)\b|\b(?:intern(?:s|ship(?:s)?)?|co[ -]?ops?|cooperative education)\s+(?:role|position|opportunity|term|placement)\b|\b(?:this|the|that)\s+(?:role|position|opportunity)\s+is\s+(?:an?\s+)?(?:intern|internship|co[ -]?op|coop|student placement|work[- ]?term)\b|\b(?:this|the|that)\s+(?:is|was|will be)\b[^.\n]{0,40}\b(?:intern|internship|co[ -]?op|coop|student placement|work[- ]?term)\b|\bas\s+an?\s+intern\b|\b(?:for|during|after|before)\s+(?:an?\s+)?(?:intern|internship|co[ -]?op|coop|student placement|work[- ]?term)\b|\b(?:currently\s+)?(?:enrolled|studying|attending|pursuing)\b[^.\n]{0,80}\b(?:student|degree|undergrad(?:uate)?|graduate|university|college|school|program)\b|\b(?:student|undergrad(?:uate)?|graduate)\s+(?:role|position|program|placement|opportunity|term)\b|\b(?:return(?:ing)?|back)\s+to\s+(?:school|university|college)\b|\b(?:academic|school|university|college)\s+(?:term|year|schedule)\b/i;
const RELATED_INTERNSHIP_CONTEXT = /\b(?:for|open\s+to|available\s+to|intended\s+for)\s+(?:current\s+)?(?:students?|undergrad(?:uate)?s?|graduates?)\b|\b(?:university|college|campus)\s+(?:program|placement|recruiting|role|position|opportunity)\b|\b(?:work[- ]?term|placement\s+year|summer\s+(?:analyst|associate|program)|industrial\s+placement)\b/i;
const SUMMER_2027 = /\b(?:summer(?:\s+of)?\s+2027|2027\s+summer)\b/i;
const PERMANENT_TITLE = /\b(?:senior|staff|principal|lead|manager|director|permanent|full[ -]?time)\b/i;

const STRONG_SOFTWARE_TITLE = /\b(?:software|developer|front[ -]?end|back[ -]?end|full[ -]?stack|mobile|ios|android|sdet|test automation|automation engineer|qa engineer|devops|site reliability|sre|platform engineer|cloud engineer|infrastructure engineer|data engineer|machine learning|ml engineer|ai engineer|computer vision|nlp|embedded software|firmware|security engineer|cybersecurity|quantitative developer|research engineer|robotics software)\b/i;
const AMBIGUOUS_TECH_TITLE = /\b(?:technology|technical|systems?|data|automation|platform|research|quantitative|robotics|security|engineering)\b/i;
const NON_CODE_TITLE = /\b(?:sales|marketing|human resources|recruit(?:er|ing)|accounting|product manager|business analyst|financial analyst|investment banking|mechanical|civil|chemical|help desk|desktop support|customer support)\b/i;

const PROGRAMMING_ACTIONS = [
  /\b(?:write|writing|develop|developing|build|building|implement|implementing|maintain|maintaining|debug|debugging) (?:[\w -]+ )?(?:code|software|applications?|services?|systems?|features?|apis?|algorithms?|pipelines?)\b/i,
  /\bsoftware (?:development|engineering|testing)\b/i,
  /\b(?:design|develop|consume|test) (?:rest(?:ful)? |web )?apis?\b/i,
  /\b(?:test automation|automated testing|unit tests?|integration tests?|ci\s*\/\s*cd)\b/i,
  /\b(?:data pipelines?|distributed systems?|machine learning models?|computer vision|natural language processing)\b/i,
  /\bprogramming (?:language|experience|skills?)\b/i,
];

const NON_CODE_CONTEXT = /\b(?:cold call|lead generation|social media campaign|accounts payable|financial reporting|talent acquisition|recruiting pipeline|customer tickets?|hardware assembly|mechanical design)\b/i;

const CATEGORY_RULES: Array<{ category: Category; pattern: RegExp }> = [
  { category: "frontend", pattern: /\b(?:front[ -]?end|react|angular|vue|user interface|web ui)\b/i },
  { category: "backend", pattern: /\b(?:back[ -]?end|server[ -]?side|api development|microservices?|distributed systems?)\b/i },
  { category: "fullstack", pattern: /\bfull[ -]?stack\b/i },
  { category: "mobile", pattern: /\b(?:mobile|ios|android|swift|kotlin)\b/i },
  { category: "qa", pattern: /\b(?:qa|quality assurance|sdet|test automation|software test)\b/i },
  { category: "devops", pattern: /\b(?:devops|site reliability|sre|ci\s*\/\s*cd|release engineering)\b/i },
  { category: "cloud", pattern: /\b(?:cloud engineering|aws|azure|gcp|kubernetes|infrastructure as code)\b/i },
  { category: "data", pattern: /\b(?:data engineer|data science|data pipeline|etl|analytics engineering|sql)\b/i },
  { category: "ml", pattern: /\b(?:machine learning|deep learning|tensorflow|pytorch|ml engineer)\b/i },
  { category: "ai", pattern: /\b(?:artificial intelligence|applied ai|ai engineer|computer vision|natural language processing|\bnlp\b|large language model|\bllm)\b/i },
  { category: "security", pattern: /\b(?:cybersecurity|security engineer|application security|penetration test|security automation)\b/i },
  { category: "embedded", pattern: /\b(?:embedded|firmware|microcontroller|real[ -]?time operating|robotics software)\b/i },
  { category: "quant", pattern: /\b(?:quantitative developer|quant developer|algorithmic trading|quantitative research)\b/i },
  { category: "research", pattern: /\b(?:research engineer|research intern|applied scientist|technical research)\b/i },
  { category: "swe", pattern: /\b(?:software engineer(?:ing)?|software developer|software development|developer intern|programmer)\b/i },
];

export function hasInternshipSignal(title: string, description: string, additionalText = ""): boolean {
  const postingText = `${positionText(description)}\n${positionText(additionalText)}`;
  return INTERNSHIP_TITLE.test(title.trim()) || DIRECT_INTERNSHIP_TERM.test(postingText) || INTERNSHIP_CONTEXT.test(postingText) || RELATED_INTERNSHIP_CONTEXT.test(postingText);
}

export function hasStrongSoftwareTitle(title: string): boolean {
  return STRONG_SOFTWARE_TITLE.test(title.trim());
}

export function hasSummer2027Signal(text: string): boolean {
  return SUMMER_2027.test(text);
}

function positionText(value: string): string {
  const footer = /\b(?:site|website|page)\s+footer\b/i.exec(value);
  if (!footer) return value;
  const sentenceStart = Math.max(
    value.lastIndexOf(".", footer.index),
    value.lastIndexOf("!", footer.index),
    value.lastIndexOf("?", footer.index),
  ) + 1;
  return value.slice(0, sentenceStart);
}

export function detectInternship(title: string, description: string, additionalText = ""): InternshipDetection {
  const normalizedTitle = title.trim();
  if (INTERNSHIP_TITLE.test(normalizedTitle)) {
    if (PERMANENT_TITLE.test(normalizedTitle) && !EXPLICIT_INTERNSHIP_TITLE.test(normalizedTitle)) {
      return { isInternship: false, reason: "The title describes a permanent or senior role, not a student placement." };
    }
    return { isInternship: true, reason: "The job title explicitly identifies an internship, co-op, or student program." };
  }
  const postingText = `${positionText(description)}\n${positionText(additionalText)}`;
  if (DIRECT_INTERNSHIP_TERM.test(postingText) || INTERNSHIP_CONTEXT.test(postingText) || RELATED_INTERNSHIP_CONTEXT.test(postingText)) {
    return { isInternship: true, reason: "The posting itself contains internship, co-op, or student-placement language." };
  }
  return { isInternship: false, reason: "No position-specific internship, co-op, or student-program signal was found." };
}

export function classifyRole(title: string, description: string, qualificationText = "", additionalText = ""): RelevanceResult {
  const combined = `${title}\n${description}\n${qualificationText}\n${additionalText}`;
  const technologies = extractTechnologies(combined);
  const reasons: string[] = [];
  let score = 0;

  const hasPlacementSignal = hasInternshipSignal(title, description, `${qualificationText}\n${additionalText}`);
  if (!hasPlacementSignal) {
    score -= MISSING_INTERNSHIP_PENALTY;
    reasons.push(`missing internship/co-op/student-placement signal penalty (-${MISSING_INTERNSHIP_PENALTY})`);
  }

  const hasSummer2027Signal = SUMMER_2027.test(combined);
  if (hasPlacementSignal && hasSummer2027Signal) {
    score += SUMMER_2027_BONUS;
    reasons.push(`Summer 2027 target bonus (+${SUMMER_2027_BONUS})`);
  } else if (hasSummer2027Signal) {
    reasons.push("Summer 2027 signal ignored because the posting lacks internship/co-op/student-placement terminology");
  }

  if (DIRECT_INTERNSHIP_TERM.test(title)) {
    score += INTERNSHIP_TITLE_BONUS;
    reasons.push(`internship/co-op title bonus (+${INTERNSHIP_TITLE_BONUS})`);
  }

  if (hasStrongSoftwareTitle(title)) {
    score += STRONG_SOFTWARE_TITLE_BONUS;
    reasons.push(`software-focused title (+${STRONG_SOFTWARE_TITLE_BONUS})`);
  } else if (AMBIGUOUS_TECH_TITLE.test(title)) {
    score += AMBIGUOUS_TECH_TITLE_BONUS;
    reasons.push(`potentially technical title (+${AMBIGUOUS_TECH_TITLE_BONUS})`);
  }

  const actionCount = PROGRAMMING_ACTIONS.filter((pattern) => pattern.test(description)).length;
  if (actionCount > 0) {
    const actionScore = Math.min(PROGRAMMING_RESPONSIBILITY_CAP, reduceFactor(actionCount * 9 + 8));
    score += actionScore;
    reasons.push(`${actionCount} programming-responsibility signal${actionCount === 1 ? "" : "s"} (+${actionScore})`);
  }

  if (technologies.length > 0) {
    const technologyScore = Math.min(TECHNOLOGY_SCORE_CAP, reduceFactor(technologies.length * 4));
    score += technologyScore;
    reasons.push(`${technologies.length} named software technolog${technologies.length === 1 ? "y" : "ies"} (+${technologyScore})`);
  }

  if (/\b(?:computer science|software engineering|computer engineering|data structures|algorithms|programming)\b/i.test(qualificationText)) {
    score += SOFTWARE_QUALIFICATION_BONUS;
    reasons.push(`software-related qualification (+${SOFTWARE_QUALIFICATION_BONUS})`);
  }

  if (NON_CODE_TITLE.test(title)) {
    score -= NON_CODE_TITLE_PENALTY;
    reasons.push(`non-software title penalty (-${NON_CODE_TITLE_PENALTY})`);
  }
  if (NON_CODE_CONTEXT.test(description) && actionCount === 0) {
    score -= NON_CODE_CONTEXT_PENALTY;
    reasons.push(`non-programming responsibilities penalty (-${NON_CODE_CONTEXT_PENALTY})`);
  }

  score = Math.max(0, Math.min(100, Math.round(score)));
  const categories = uniqueStrings(
    CATEGORY_RULES.filter(({ pattern }) => pattern.test(combined)).map(({ category }) => category),
  ) as Category[];
  if (categories.length === 0 && score >= 45) categories.push("other-code");

  const reason = reasons.length > 0 ? `${score}/100: ${reasons.join("; ")}.` : "0/100: no meaningful programming signals were found.";
  return { score, reason, categories, technologies };
}
