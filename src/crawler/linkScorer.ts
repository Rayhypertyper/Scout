import type { LinkCandidate } from "../domain/types.js";
import { isAtsUrl, isGithubUrl } from "../utils/url.js";

const POSITIVE: Array<{ pattern: RegExp; points: number }> = [
  { pattern: /\bintern(?:ship)?s?\b/i, points: 45 },
  { pattern: /\bco[ -]?ops?\b/i, points: 42 },
  { pattern: /\b(?:student|university|early[ -]?career|new[ -]?grad)\b/i, points: 28 },
  { pattern: /\b(?:software|developer|engineering|technology|data|machine[ -]?learning|artificial[ -]?intelligence)\b/i, points: 22 },
  { pattern: /\b(?:careers?|jobs?|positions?|openings?|opportunities)\b/i, points: 18 },
  { pattern: /\bapply(?: now)?\b/i, points: 25 },
  { pattern: /\b(?:requisition|job posting|job details?)\b/i, points: 18 },
];

const NEGATIVE: Array<{ pattern: RegExp; points: number }> = [
  { pattern: /\b(?:privacy|terms|legal|cookie|accessibility)\b/i, points: -100 },
  { pattern: /\b(?:press|blog|investors?|news|about[ -]?us|social media)\b/i, points: -55 },
  { pattern: /\b(?:login|log in|sign[ -]?up|register|account)\b/i, points: -70 },
  { pattern: /\b(?:facebook|instagram|twitter|x\.com|linkedin|youtube)\b/i, points: -100 },
];

const BLOCKED_EXTENSIONS = /\.(?:png|jpe?g|gif|webp|svg|ico|pdf|zip|mp4|mp3|css|js|xml)(?:$|\?)/i;

export interface ScoredLink {
  score: number;
  reason: string;
}

export function scoreLink(link: LinkCandidate, currentUrl: string): ScoredLink {
  const evidence = `${link.text} ${link.url.replace(/[-_/]+/g, " ")}`;
  if (BLOCKED_EXTENSIONS.test(link.url) || /^(?:mailto|tel|javascript):/i.test(link.url)) {
    return { score: -1000, reason: "non-page resource" };
  }
  let score = 0;
  const reasons: string[] = [];
  for (const rule of POSITIVE) {
    if (rule.pattern.test(evidence)) {
      score += rule.points;
      reasons.push(`+${rule.points}`);
    }
  }
  for (const rule of NEGATIVE) {
    if (rule.pattern.test(evidence)) {
      score += rule.points;
      reasons.push(String(rule.points));
    }
  }
  if (isAtsUrl(link.url)) {
    score += 35;
    reasons.push("ATS +35");
  }
  if (/\/(?:jobs?|positions?|requisitions?)\/[^/?#]+/i.test(link.url)) {
    score += 32;
    reasons.push("job path +32");
  }
  if (
    isGithubUrl(currentUrl)
    && /\/(?:blob|tree)\//i.test(link.url)
    && /(?:\.(?:md|markdown)(?:$|\?)|\b(?:intern|job|listing|roles?|readme|data)\b)/i.test(link.url)
  ) {
    score += 30;
    reasons.push("GitHub list +30");
  }
  if (/(?:[?&]page=\d+|\/page\/\d+)/i.test(link.url)) {
    score += 25;
    reasons.push("page parameter +25");
  }
  if (/\b(?:next|load more|show more|view all)\b/i.test(evidence)) {
    score += 12;
    reasons.push("pagination +12");
  }
  if (/#[^/]*$/.test(link.url)) score -= 5;
  return { score, reason: reasons.join(", ") || "neutral" };
}

export function looksLikeRecruitingLink(link: LinkCandidate): boolean {
  return /\b(?:intern|co[ -]?op|student|university|career|job|position|opening|apply|software|engineering|developer)\b/i.test(`${link.text} ${link.url}`)
    || isAtsUrl(link.url);
}
