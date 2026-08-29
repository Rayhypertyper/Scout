import type { Category } from "../domain/schemas.js";

/** A small, serialisable rule so deployments can replace the defaults without
 * shipping a classifier or model. Matching is case-insensitive substring on
 * token boundaries (the scorer escapes these values before building regexes).
 */
export interface RelevanceRule {
  term: string;
  weight: number;
  categories?: Category[];
}

export interface RelevanceRules {
  titlePositive: RelevanceRule[];
  titleAmbiguous: RelevanceRule[];
  titleNegative: RelevanceRule[];
  departmentPositive: RelevanceRule[];
  departmentNegative: RelevanceRule[];
  snippetPositive: RelevanceRule[];
  snippetNegative: RelevanceRule[];
}

const rule = (term: string, weight: number, categories?: Category[]): RelevanceRule => categories
  ? { term, weight, categories }
  : { term, weight };

/**
 * Conservative defaults for listing pages.  Strong title terms are enough to
 * route a listing to the detail path; ambiguous terms are deliberately weaker
 * and never trigger a pre-detail rejection by themselves.
 */
export const DEFAULT_RELEVANCE_RULES: RelevanceRules = {
  titlePositive: [
    rule("software engineer", 72, ["swe"]),
    rule("software engineering", 72, ["swe"]),
    rule("software developer", 72, ["swe"]),
    rule("software development", 64, ["swe"]),
    rule("frontend", 68, ["frontend"]),
    rule("front-end", 68, ["frontend"]),
    rule("backend", 68, ["backend"]),
    rule("back-end", 68, ["backend"]),
    rule("full stack", 68, ["fullstack"]),
    rule("full-stack", 68, ["fullstack"]),
    rule("developer", 64, ["swe"]),
    rule("programmer", 60, ["swe"]),
    rule("qa automation", 64, ["qa"]),
    rule("test automation", 64, ["qa"]),
    rule("sdet", 64, ["qa"]),
    rule("data engineer", 66, ["data"]),
    rule("data science", 66, ["data"]),
    rule("machine learning", 68, ["ml"]),
    rule("ml engineer", 68, ["ml"]),
    rule("artificial intelligence", 66, ["ai"]),
    rule("ai engineer", 66, ["ai"]),
    rule("cybersecurity", 64, ["security"]),
    rule("security engineer", 64, ["security"]),
    rule("embedded software", 66, ["embedded", "swe"]),
    rule("firmware", 62, ["embedded"]),
    rule("devops", 62, ["devops"]),
    rule("site reliability", 62, ["devops"]),
    rule("sre", 58, ["devops"]),
    rule("cloud engineer", 62, ["cloud"]),
    rule("platform engineer", 58, ["cloud"]),
    rule("automation engineer", 58, ["other-code"]),
    rule("robotics software", 62, ["embedded", "swe"]),
    rule("quantitative developer", 62, ["quant"]),
    rule("research engineer", 58, ["research"]),
  ],
  titleAmbiguous: [
    rule("technology", 30),
    rule("technical", 30),
    rule("engineering", 28),
    rule("systems", 27),
    rule("platform", 26),
    rule("automation", 26),
    rule("data", 25, ["data"]),
    rule("research", 24, ["research"]),
    rule("robotics", 30, ["embedded"]),
    rule("security", 30, ["security"]),
    rule("quantitative", 26, ["quant"]),
  ],
  titleNegative: [
    rule("marketing", 78),
    rule("human resources", 82),
    rule("hr ", 78),
    rule("recruiting", 82),
    rule("recruiter", 82),
    rule("legal", 82),
    rule("attorney", 82),
    rule("accounting", 78),
    rule("accountant", 78),
    rule("sales", 78),
    rule("business development", 70),
    rule("communications", 76),
    rule("public relations", 76),
    rule("customer support", 74),
    rule("help desk", 74),
  ],
  departmentPositive: [
    rule("software", 26, ["swe"]),
    rule("engineering", 22),
    rule("developer", 26, ["swe"]),
    rule("development", 22, ["swe"]),
    rule("data science", 24, ["data"]),
    rule("machine learning", 25, ["ml"]),
    rule("artificial intelligence", 25, ["ai"]),
    rule("cybersecurity", 24, ["security"]),
    rule("platform", 20, ["cloud"]),
    rule("infrastructure", 22, ["cloud"]),
    rule("qa", 22, ["qa"]),
  ],
  departmentNegative: [
    rule("marketing", 42),
    rule("human resources", 45),
    rule("legal", 45),
    rule("accounting", 42),
    rule("sales", 42),
    rule("communications", 42),
  ],
  snippetPositive: [
    rule("write code", 14),
    rule("develop software", 14),
    rule("programming", 12),
    rule("software development", 12),
    rule("api", 10),
    rule("automated testing", 11, ["qa"]),
    rule("data pipeline", 12, ["data"]),
    rule("machine learning", 12, ["ml"]),
    rule("cloud", 9, ["cloud"]),
    rule("python", 8),
    rule("typescript", 8),
    rule("java", 8),
    rule("c++", 8),
    rule("sql", 7),
  ],
  snippetNegative: [
    rule("cold calling", 28),
    rule("social media campaign", 26),
    rule("accounts payable", 26),
    rule("talent acquisition", 28),
    rule("customer tickets", 24),
    rule("financial reporting", 24),
  ],
};

/** Merge a partial deployment override with the deterministic defaults. */
export function withRelevanceRules(overrides: Partial<RelevanceRules> = {}): RelevanceRules {
  return {
    titlePositive: overrides.titlePositive ?? DEFAULT_RELEVANCE_RULES.titlePositive,
    titleAmbiguous: overrides.titleAmbiguous ?? DEFAULT_RELEVANCE_RULES.titleAmbiguous,
    titleNegative: overrides.titleNegative ?? DEFAULT_RELEVANCE_RULES.titleNegative,
    departmentPositive: overrides.departmentPositive ?? DEFAULT_RELEVANCE_RULES.departmentPositive,
    departmentNegative: overrides.departmentNegative ?? DEFAULT_RELEVANCE_RULES.departmentNegative,
    snippetPositive: overrides.snippetPositive ?? DEFAULT_RELEVANCE_RULES.snippetPositive,
    snippetNegative: overrides.snippetNegative ?? DEFAULT_RELEVANCE_RULES.snippetNegative,
  };
}
