export function normalizeWhitespace(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
}

export function oneLine(value: string): string {
  return normalizeWhitespace(value).replace(/\n+/g, " ");
}

export function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\"",
  };
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (entity, token: string) => {
    if (token.startsWith("#")) {
      const hexadecimal = token[1]?.toLocaleLowerCase() === "x";
      const codePoint = Number.parseInt(token.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      try {
        return Number.isSafeInteger(codePoint) ? String.fromCodePoint(codePoint) : entity;
      } catch {
        return entity;
      }
    }
    return named[token.toLocaleLowerCase()] ?? entity;
  });
}

export function stripDiacritics(value: string): string {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function cleanListItem(value: string): string {
  return oneLine(value.replace(/^[\s•·▪◦*-]+/, "").replace(/^\d+[.)]\s*/, ""));
}

export function uniqueStrings(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = cleanListItem(raw);
    const key = value.toLocaleLowerCase().replace(/[.!;:]+$/, "");
    if (value && !seen.has(key)) {
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

export function textLines(value: string): string[] {
  return uniqueStrings(normalizeWhitespace(value).split(/\n+/));
}

export function sentences(value: string): string[] {
  const units = normalizeWhitespace(value)
    .split(/\n+|[•·▪◦]\s*/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9])/));
  return uniqueStrings(units);
}

export function normalizeIdentity(value: string): string {
  return stripDiacritics(oneLine(value))
    .toLocaleLowerCase()
    .replace(/\b(internship|intern|co-?op|student)\b/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function normalizeCompanyIdentity(value: string): string {
  const normalized = stripDiacritics(oneLine(decodeHtmlEntities(value)))
    .toLocaleLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(?:incorporated|inc|corporation|corp|company|limited|ltd|llc|lp|plc)\b(?:\s+[a-z]{1,4})?\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const compact = normalized.replace(/\s+/g, "");
  if (["chase", "jpmorganchase", "jpmorganchaseandco"].includes(compact)) return "jpmorgan chase";
  if (normalized.startsWith("castleton commodities ")) return "castleton commodities";
  if (["plus", "plusai"].includes(compact)) return "plus";
  if (["tenstorrent", "tenstorrentuniversity"].includes(compact)) return "tenstorrent";
  if (["wd", "westerndigital"].includes(compact)) return "western digital";
  return normalized;
}

export function normalizeRoleIdentity(value: string): string {
  return normalizeIdentity(decodeHtmlEntities(value))
    .replace(/\bengineering\b/g, "engineer")
    .replace(/\bdevelopment\b/g, "developer")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, maximum: number): string {
  if (value.length <= maximum) return value;
  return `${value.slice(0, Math.max(0, maximum - 1)).trimEnd()}…`;
}
