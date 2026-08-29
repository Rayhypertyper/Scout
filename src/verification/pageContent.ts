export type PageContentState = "not-found" | "closed";

export interface PageContentClassification {
  state: PageContentState;
  reason: string;
}

// These patterns describe an error/status page, not ordinary wording inside a
// valid job description such as "applications remain open until the position
// is filled" or "until the requisition is closed".
const PAGE_CONTENT_PATTERNS: Array<{ pattern: RegExp; state: PageContentState; reason: string }> = [
  {
    pattern: /\bthe page you(?: are|['’]re) (?:looking for|seeking) (?:doesn['’]?t|does not|cannot|can['’]?t) exist\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\bthe page you(?: are|['’]re) (?:looking for|seeking) (?:couldn['’]?t|could not|cannot|can['’]?t) be found\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\b(?:the )?(?:requested )?(?:page|resource) (?:doesn['’]?t|does not|cannot|can['’]?t) exist\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\b(?:page|resource) (?:not found|couldn['’]?t be found|could not be found|cannot be found|can['’]?t be found)\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\b(?:this|the) (?:page|resource) (?:is|has been|was) (?:removed|unavailable|not available)\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\b(?:this|the) (?:job|position|listing|opportunity|requisition) (?:doesn['’]?t|does not|cannot|can['’]?t) exist\b/i,
    state: "not-found",
    reason: "Job not found",
  },
  {
    pattern: /\b(?:this|the) (?:job|position|listing|opportunity|requisition) (?:couldn['’]?t|could not|cannot|can['’]?t) be found\b/i,
    state: "not-found",
    reason: "Job not found",
  },
  {
    pattern: /\b(?:we|our system) (?:couldn['’]?t|could not|cannot|can['’]?t) find (?:the |this |that )?(?:requested )?(?:page|resource|job|position|listing|opportunity|requisition)\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\bpage\s+not\s+found\b|\b404\s+not\s+found\b/i,
    state: "not-found",
    reason: "Page not found",
  },
  {
    pattern: /\b(?:this|the) (?:job|position|listing|opportunity|requisition) (?:is|has been|was) no longer available\b/i,
    state: "closed",
    reason: "Job no longer available",
  },
  {
    pattern: /\b(?:this|the) (?:job|position|listing|opportunity|requisition) has expired\b/i,
    state: "closed",
    reason: "Job expired",
  },
  {
    pattern: /\b(?:this|the) (?:job|position|listing|opportunity|requisition|posting) has been (?:removed|closed)\b/i,
    state: "closed",
    reason: "Job posting removed or closed",
  },
  {
    pattern: /\bno longer accepting applications\b/i,
    state: "closed",
    reason: "No longer accepting applications",
  },
];

export function classifyPageContent(body: string): PageContentClassification | null {
  return PAGE_CONTENT_PATTERNS.find(({ pattern }) => pattern.test(body)) ?? null;
}

export function hasNotFoundPageContent(body: string): boolean {
  return classifyPageContent(body)?.state === "not-found";
}

export function hasUnavailablePageContent(body: string): boolean {
  return classifyPageContent(body) !== null;
}
