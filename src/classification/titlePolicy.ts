const EXCLUDED_JOB_TITLE_RULES = [
  { label: "2026", matches: (title: string) => title.includes("2026") && !title.includes("2027") },
  { label: "new grad", matches: (title: string) => /\bnew[\s-]+grad(?:uate)?s?\b/i.test(title) },
  { label: "PhD", matches: (title: string) => /\bph\.?\s*d\.?\b/i.test(title) },
  {
    label: "12 months without a standalone 4",
    matches: (title: string) => /\b12\s*[-‐‑‒–—]?\s*months?\b/i.test(title) && !/\b4\b/.test(title),
  },
] as const;

export function excludedJobTitleReason(title: string): string | null {
  return EXCLUDED_JOB_TITLE_RULES.find(({ matches }) => matches(title))?.label ?? null;
}

export function isExcludedJobTitle(title: string): boolean {
  return excludedJobTitleReason(title) !== null;
}
