/**
 * Security and government-suitability wording is unusually inconsistent in
 * job feeds. Keep this detector independent from the output layer so it can
 * be used while extracting authorization evidence and when publishing data.
 */
const HYPHEN_VARIANTS = /[‐‑‒–—−]/gu;
const CLEARANCE_REFERENCE = String.raw`(?:security\s*[-/]?\s*clearance|(?:security\s+)?clearance\s+(?:level|status|type|eligibility|eligible|required|requirement|needed|necessary)|(?:secret|top\s+secret|confidential|q|l|ts\s*[-/]?\s*sci|sci|sap|ssbi|naclc|public\s+trust|special\s+access\s+program)(?:\s+level)?\s+(?:security\s+)?clearance|(?:dod|d\.o\.d\.|department\s+of\s+defense|federal|government|national\s+security|security\s+suitability)\s+clearance|(?:clearable|clearance\s+eligible|security\s+suitability|suitability\s+clearance)|(?:ts\s*[-/]?\s*sci|sci|sap|ssbi|naclc|public\s+trust)\b|classified\s+(?:access|information|systems?|programs?)|(?:security\s+clearance\s*[/&,]|[/&,]\s*security\s+clearance)\s*(?:background\s+)?(?:check|investigation))`;
const CLEARANCE_REFERENCE_PATTERN = new RegExp(`\\b${CLEARANCE_REFERENCE}\\b`, "iu");
const STRONG_CLEARANCE_PATTERN = new RegExp(String.raw`\b(?:(?:secret|top\s+secret|confidential|q|l|ts\s*[-/]?\s*sci|sci|sap|ssbi|naclc|public\s+trust|special\s+access\s+program)(?:\s+level)?\s+(?:security\s+)?clearance|(?:dod|d\.o\.d\.|department\s+of\s+defense|federal|government|national\s+security)\s+clearance|clearance\s*(?:level|status|type)?\s*:\s*(?!none\b|n/?a\b|not\s+(?:required|needed|applicable)\b)[a-z0-9/ +.-]*[a-z0-9]|(?:security\s+clearance|clearance)\s*[/&,]\s*(?:background\s+)?(?:check|investigation)|(?:ts\s*[-/]?\s*sci|sci|sap|ssbi|naclc|public\s+trust)\b|classified\s+(?:access|information|systems?|programs?)|clearable)\b`, "iu");
const REQUIRED_SIGNAL_PATTERN = /\b(?:required|required to|requirement|requires?|must|mandatory|need(?:s|ed)?|necessary|obtain|maintain|possess|hold|have|eligible|eligibility|qualif(?:y|ied)|ability to|able to|willing to|subject to|contingent(?: upon)?|condition(?: of)?|pass|undergo|secure|sponsor(?:ship)?)\b/iu;
const POSSESSION_STATUS_PATTERN = /\b(?:active|current|valid|existing)\s+(?:(?:secret|top\s+secret|confidential|q|l|ts\s*[-/]?\s*sci|sci|sap|ssbi|naclc|public\s+trust)\s+)?(?:security\s+)?clearance\b|\b(?:security\s+)?clearance\s+(?:is\s+)?(?:active|current|valid|existing)\b/iu;
const NOT_REQUIRED_PATTERNS = [
  /\b(?:no|without|never|neither)\b[^.!?;\n]{0,100}\b(?:security\s*[-/]?\s*clearance|clearance|public\s+trust|ts\s*[-/]?\s*sci)\b/iu,
  /\b(?:security\s*[-/]?\s*clearance|clearance|public\s+trust|ts\s*[-/]?\s*sci)\b[^.!?;\n]{0,100}\b(?:not required|not needed|not necessary|not applicable|none|n\/?a|optional)\b/iu,
  /\b(?:does not|doesn['’]?t|is not|isn['’]?t|do not|don['’]?t|cannot|can['’]?t)\s+(?:require|need|necessitate|involve)\b[^.!?;\n]{0,100}\b(?:security\s*[-/]?\s*clearance|clearance|public\s+trust)\b/iu,
  /\b(?:not required|not needed|not necessary|not applicable|none|n\/?a|optional)\b[^.!?;\n]{0,100}\b(?:to obtain|to maintain|for|a|an)?\s*(?:security\s*[-/]?\s*clearance|clearance|public\s+trust)\b/iu,
  /\b(?:not subject to|outside the scope of)\b[^.!?;\n]{0,80}\b(?:security\s*[-/]?\s*clearance|clearance|public\s+trust)\b/iu,
];
const SOFT_ONLY_PATTERN = /\b(?:preferred|preferable|desired|nice[ -]+to[ -]+have|bonus|plus|asset|advantage|optional)\b/iu;

function normalizeClearanceText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(HYPHEN_VARIANTS, "-")
    .replace(/[ \t\f\v]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

function clearanceUnits(text: string): string[] {
  const units = text.split(/\n+/u).flatMap((line) => line.split(/[.!?;|]+/u)).map((unit) => unit.trim()).filter(Boolean);
  const result = new Set(units);
  for (let index = 0; index < units.length; index += 1) {
    const current = units[index];
    if (!current || (!CLEARANCE_REFERENCE_PATTERN.test(current) && !STRONG_CLEARANCE_PATTERN.test(current))) continue;
    const previous = units[index - 1];
    const next = units[index + 1];
    if (previous) result.add(`${previous} ${current}`);
    if (next) result.add(`${current} ${next}`);
  }
  return [...result];
}

function isExplicitlyNotRequired(unit: string): boolean {
  return NOT_REQUIRED_PATTERNS.some((pattern) => pattern.test(unit));
}

function isSoftOnly(unit: string): boolean {
  return SOFT_ONLY_PATTERN.test(unit) && !REQUIRED_SIGNAL_PATTERN.test(unit);
}

/** Return true when a posting contains a positive clearance requirement. */
export function hasSecurityClearanceRequirement(text: string): boolean {
  if (!text) return false;
  const normalized = normalizeClearanceText(text);
  if (!CLEARANCE_REFERENCE_PATTERN.test(normalized) && !STRONG_CLEARANCE_PATTERN.test(normalized)) return false;
  return clearanceUnits(normalized).some((unit) => {
    if ((!CLEARANCE_REFERENCE_PATTERN.test(unit) && !STRONG_CLEARANCE_PATTERN.test(unit))
      || isExplicitlyNotRequired(unit)
      || isSoftOnly(unit)) return false;
    return STRONG_CLEARANCE_PATTERN.test(unit)
      || POSSESSION_STATUS_PATTERN.test(unit)
      || REQUIRED_SIGNAL_PATTERN.test(unit);
  });
}
