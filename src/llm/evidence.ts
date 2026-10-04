import type { FieldEvidence, Internship } from "../domain/schemas.js";
import { FieldEvidenceSchema } from "../domain/schemas.js";
import { decodeHtmlEntities, normalizeIdentity, oneLine } from "../utils/text.js";

function comparable(value: string): string {
  return normalizeIdentity(oneLine(decodeHtmlEntities(value)));
}

function readField(internship: Internship, field: string): unknown {
  const segments = field.replace(/\[(\d+)\]/g, ".$1").split(".").filter(Boolean);
  let value: unknown = internship;
  for (const segment of segments) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

function alignedValue(value: string, selected: unknown, field: string): boolean {
  if (typeof selected === "number" && Number.isFinite(selected)) selected = String(selected);
  if (typeof selected === "object" && selected !== null && "min" in selected && "max" in selected) {
    if (typeof selected.min === "number" && typeof selected.max === "number") selected = `${selected.min}-${selected.max}`;
  }
  if (typeof selected !== "string") return false;
  const expected = comparable(value);
  const actual = comparable(selected);
  if (!expected || !actual) return false;
  if (expected === actual) return true;
  return field === "description" && actual.includes(expected);
}

/**
 * Drop stale model evidence after analysis, deduplication, or reprocessing and
 * remap indexed list paths to the item that still carries the evidenced value.
 */
export function alignFieldEvidence(internship: Internship, records: readonly FieldEvidence[] = internship.provenance): FieldEvidence[] {
  const output: FieldEvidence[] = [];
  for (const evidence of records) {
    let field = evidence.field;
    const arrayMatch = /^(.*)\[(\d+)\](.*)$/.exec(field);
    if (arrayMatch) {
      const key = arrayMatch[1]!;
      const suffix = arrayMatch[3]!;
      const selected = readField(internship, key);
      if (!Array.isArray(selected)) continue;
      const itemValue = (item: unknown): unknown => suffix
        ? readField(item as Internship, suffix.replace(/^\./, ""))
        : item;
      const index = selected.findIndex((item) => alignedValue(evidence.value, itemValue(item), field));
      if (index < 0) continue;
      field = `${key}[${index}]${suffix}`;
    } else if (!alignedValue(evidence.value, readField(internship, field), field)) {
      continue;
    }
    const parsed = FieldEvidenceSchema.safeParse({ ...evidence, field });
    if (parsed.success) output.push(parsed.data);
  }
  return output.filter((item, index) => output.findIndex((candidate) => candidate.field === item.field
    && candidate.value === item.value && candidate.pageUrl === item.pageUrl
    && candidate.start === item.start && candidate.end === item.end) === index);
}
