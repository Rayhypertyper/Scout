import type { Category } from "../domain/schemas.js";
import { DEFAULT_RELEVANCE_RULES, type RelevanceRule, type RelevanceRules, withRelevanceRules } from "../config/relevanceRules.js";
import { decodeHtmlEntities, oneLine, stripDiacritics } from "../utils/text.js";

export interface ListingRelevanceInput {
  title: string;
  department?: string | null;
  team?: string | null;
  snippet?: string | null;
  descriptionSnippet?: string | null;
}

export type ListingRoutingDecision = "fast-reject" | "slow-path";

export interface ListingRelevanceResult {
  /** A bounded 0..100 score. It is intentionally not a final role score. */
  score: number;
  titleScore: number;
  departmentScore: number;
  snippetScore: number;
  categories: Category[];
  matchedPositive: string[];
  matchedNegative: string[];
  ambiguous: boolean;
  mixedSignal: boolean;
  /** True only for a clearly irrelevant function with no technical evidence. */
  clearlyIrrelevant: boolean;
  /** True when a detail page should be fetched for full classification. */
  shouldFetchDetail: boolean;
  decision: ListingRoutingDecision;
  reason: string;
}

const MAX_SNIPPET_LENGTH = 4_096;
const DEFAULT_MINIMUM_SCORE = 18;

function normalized(value: string | null | undefined, maximum = MAX_SNIPPET_LENGTH): string {
  return stripDiacritics(oneLine(decodeHtmlEntities(value ?? "")).slice(0, maximum)).toLocaleLowerCase();
}

function escapedTerm(term: string): string {
  const compact = normalized(term, 160).trim();
  if (!compact) return "(?!)";
  const escaped = compact.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  // A trailing space in a configuration item (e.g. `hr `) is a convenience
  // for authors, not part of the match. Use token boundaries around normal
  // words while allowing punctuation-heavy terms such as C++.
  const trimmed = escaped.replace(/\\s\+?$/, "");
  const startsWord = /^[a-z0-9]/i.test(compact);
  const endsWord = /[a-z0-9]$/i.test(compact);
  return `${startsWord ? "\\b" : ""}${trimmed}${endsWord ? "\\b" : ""}`;
}

function matches(text: string, rule: RelevanceRule): boolean {
  return new RegExp(escapedTerm(rule.term), "i").test(text);
}

function scoreRules(text: string, rules: RelevanceRule[]): { score: number; matches: RelevanceRule[] } {
  const matched = rules.filter((rule) => matches(text, rule));
  // Multiple variants of the same family should not make a title exceed the
  // bounded range merely because it says both “software engineer” and
  // “developer”. Capping each field also keeps this pass cheap and stable.
  const score = matched.reduce((sum, rule) => sum + rule.weight, 0);
  return { score, matches: matched };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/**
 * Cheap listing-level relevance classification. It intentionally errs toward
 * fetching details: ambiguous technology, research, and interdisciplinary
 * titles are sent to the slow path even when their score is below the normal
 * feed threshold. Only a title that is clearly nontechnical and lacks any
 * technical evidence is rejected before detail retrieval.
 */
export function scoreListingRelevance(
  input: ListingRelevanceInput,
  options: { rules?: Partial<RelevanceRules>; minimumScore?: number } = {},
): ListingRelevanceResult {
  const rules = withRelevanceRules(options.rules);
  const title = normalized(input.title, 500);
  const department = normalized([input.department, input.team].filter(Boolean).join(" "), 500);
  const snippet = normalized(input.snippet ?? input.descriptionSnippet, MAX_SNIPPET_LENGTH);

  const titlePositive = scoreRules(title, rules.titlePositive);
  const titleAmbiguous = scoreRules(title, rules.titleAmbiguous);
  const titleNegative = scoreRules(title, rules.titleNegative);
  const departmentPositive = scoreRules(department, rules.departmentPositive);
  const departmentNegative = scoreRules(department, rules.departmentNegative);
  const snippetPositive = scoreRules(snippet, rules.snippetPositive);
  const snippetNegative = scoreRules(snippet, rules.snippetNegative);

  // Title is intentionally dominant. Department/team and snippets provide
  // corroboration but cannot erase a strong technical title on their own.
  const titleScore = Math.min(100, titlePositive.score + Math.min(34, titleAmbiguous.score) - Math.min(100, titleNegative.score));
  const departmentScore = Math.min(34, departmentPositive.score) - Math.min(50, departmentNegative.score);
  const snippetScore = Math.min(28, snippetPositive.score) - Math.min(36, snippetNegative.score);
  const score = clamp(titleScore + departmentScore + snippetScore);

  const positiveRules = [...titlePositive.matches, ...titleAmbiguous.matches, ...departmentPositive.matches, ...snippetPositive.matches];
  const negativeRules = [...titleNegative.matches, ...departmentNegative.matches, ...snippetNegative.matches];
  const categories = [...new Set(positiveRules.flatMap((rule) => rule.categories ?? []))];
  const hasTechnicalEvidence = positiveRules.length > 0;
  const hasAmbiguousEvidence = titleAmbiguous.matches.length > 0 || departmentPositive.matches.length > 0 || snippetPositive.matches.length > 0;
  const mixedSignal = negativeRules.length > 0 && hasTechnicalEvidence;
  const clearlyIrrelevant = negativeRules.length > 0 && !hasTechnicalEvidence && !hasAmbiguousEvidence;
  const minimumScore = options.minimumScore ?? DEFAULT_MINIMUM_SCORE;
  // Unknown/neutral titles are retained for detail parsing. The minimum score
  // is useful to callers for prioritisation, but it must not become an early
  // coverage filter: many legitimate interdisciplinary internships have no
  // obvious keyword in their short listing title.
  const shouldFetchDetail = !clearlyIrrelevant || mixedSignal || score >= minimumScore;
  const decision: ListingRoutingDecision = shouldFetchDetail ? "slow-path" : "fast-reject";

  const matchedPositive = [...new Set(positiveRules.map((rule) => rule.term))];
  const matchedNegative = [...new Set(negativeRules.map((rule) => rule.term))];
  const reasonParts = [
    `title ${titleScore >= 0 ? "+" : ""}${titleScore}`,
    `department ${departmentScore >= 0 ? "+" : ""}${departmentScore}`,
    `snippet ${snippetScore >= 0 ? "+" : ""}${snippetScore}`,
  ];
  if (matchedPositive.length > 0) reasonParts.push(`positive: ${matchedPositive.join(", ")}`);
  if (matchedNegative.length > 0) reasonParts.push(`negative: ${matchedNegative.join(", ")}`);
  if (mixedSignal) reasonParts.push("mixed technical/interdisciplinary signal; detail review retained");
  if (clearlyIrrelevant) reasonParts.push("clearly irrelevant function with no technical evidence");

  return {
    score,
    titleScore,
    departmentScore,
    snippetScore,
    categories,
    matchedPositive,
    matchedNegative,
    ambiguous: hasAmbiguousEvidence,
    mixedSignal,
    clearlyIrrelevant,
    shouldFetchDetail,
    decision,
    reason: `${score}/100 (${reasonParts.join("; ")})`,
  };
}

// Naming aliases make the small API easy to discover from pipeline code while
// preserving one implementation and one deterministic ruleset.
export const cheapListingRelevance = scoreListingRelevance;
export const classifyListing = scoreListingRelevance;
export const listingRelevanceScore = scoreListingRelevance;
export { DEFAULT_RELEVANCE_RULES };
