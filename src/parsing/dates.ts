import { sentences } from "../utils/text.js";

export interface TemporalDetails {
  internshipTerm: string | null;
  internshipYear: string | null;
  duration: string | null;
  postingDate: string | null;
  deadline: string | null;
  salary: string | null;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return sentences(text).find((unit) => pattern.test(unit)) ?? null;
}

const MONTH = "(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)";
const EXPLICIT_DATE = `(?:20\\d{2}[-/]\\d{1,2}(?:[-/]\\d{1,2})?|${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+20\\d{2})?|\\d{1,2}\\s+${MONTH}(?:\\s+20\\d{2})?|(?:today|yesterday|\\d+\\s+(?:hours?|days?|weeks?)\\s+ago))`;
const DURATION = "(?:\\d{1,2}(?:\\s*(?:-|–|to)\\s*\\d{1,2})?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)[ -]?(?:week|month)s?";
const SERIALIZED_PAGE_MARKER = /(?:self\.__next_f|dangerouslySetInnerHTML|job-tag--|className|children|\$L\d+)/i;
const SHORT_RELATIVE_DATE = /^(?:today|yesterday|\d+\s*(?:hours?|days?|weeks?)\s+ago|\d+\s*[dwmy])\b/i;

export function containsExplicitDate(value: string): boolean {
  return new RegExp(`\\b${EXPLICIT_DATE}\\b`, "i").test(value)
    || /\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)\s+[A-Z][a-z]{2}\s+\d{1,2}.*\b20\d{2}\b/.test(value);
}

/**
 * Keep a previously extracted posting age/date only when it is a compact
 * value. Older static crawls accidentally stored serialized Next.js payloads
 * after a visible age, so recover that leading age or fall back to the date
 * found in the description.
 */
export function sanitizePostingDate(value: string | null | undefined, fallback: string | null = null): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return fallback;
  if (trimmed.length <= 240 && !SERIALIZED_PAGE_MARKER.test(trimmed)) return trimmed;
  return SHORT_RELATIVE_DATE.exec(trimmed)?.[0] ?? fallback;
}

function internshipYear(title: string, text: string): string | null {
  const titleYear = /\b(20[2-3]\d)\b/.exec(title)?.[1];
  if (titleYear) return titleYear;
  const patterns = [
    /\b(?:starting|start) date\s*:?\s*[^.\n]{0,30}\b(20[2-3]\d)\b/i,
    /\b(?:spring|summer|fall|autumn|winter)\s+(20[2-3]\d)\b/i,
    /\b(20[2-3]\d)\s+(?:spring|summer|fall|autumn|winter)\b/i,
    /\b(?:internship|co-?op|placement)\s+(?:program\s+)?(?:for\s+)?(20[2-3]\d)\b/i,
    /\b(20[2-3]\d)\s+(?:internship|co-?op|placement)\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text)?.[1];
    if (match) return match;
  }
  return null;
}

function internshipTerm(title: string, text: string): string | null {
  const titleTerm = /\b(spring|summer|fall|autumn|winter)\b/i.exec(title)?.[1];
  const contextual = firstMatch(text, /\b(?:internship|co-?op|placement|program)\b[^.]{0,80}\b(?:spring|summer|fall|autumn|winter)\b|\b(?:spring|summer|fall|autumn|winter)\b[^.]{0,80}\b(?:internship|co-?op|placement|program)\b/i);
  const term = titleTerm ?? (contextual ? /\b(spring|summer|fall|autumn|winter)\b/i.exec(contextual)?.[1] : undefined);
  return term ? `${term[0]?.toLocaleUpperCase() ?? ""}${term.slice(1).toLocaleLowerCase()}` : null;
}

export function extractTemporalDetails(text: string, title = ""): TemporalDetails {
  const postingPattern = new RegExp(`\\b(?:posting date|date posted|posted(?: on)?)\\s*:?\\s*${EXPLICIT_DATE}\\b`, "i");
  const deadlinePattern = new RegExp(`\\b(?:application deadline|priority application date|apply by|applications? close|closing date)\\s*:?\\s*[^.\\n]{0,40}\\b${EXPLICIT_DATE}\\b`, "i");
  const durationPattern = new RegExp(`\\b(?:duration\\s*:?\\s*${DURATION}|${DURATION}[^.\\n]{0,35}(?:internship|co-?op|placement|program)|(?:internship|co-?op|placement|program)[^.\\n]{0,35}${DURATION}|from\\s+${MONTH}\\s+(?:to|through)\\s+${MONTH})\\b`, "i");
  return {
    internshipTerm: internshipTerm(title, text),
    internshipYear: internshipYear(title, text),
    duration: firstMatch(`${title}\n${text}`, durationPattern),
    postingDate: firstMatch(text, postingPattern),
    deadline: firstMatch(text, deadlinePattern),
    salary: firstMatch(text, /(?:[$€£]\s?\d[\d,.]*(?:\s?(?:-|–|to)\s?[$€£]?\s?\d[\d,.]*)?\s?(?:per|\/)\s?(?:hour|year|annum)|\bCAD\s?\$?\d[\d,.]*|\bUSD\s?\$?\d[\d,.]*)/i),
  };
}
