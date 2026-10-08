import { redactSensitiveText } from "./url.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LoggerOptions {
  now?: () => string;
  sink?: (line: string) => void;
}

const ranks: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_DIAGNOSTIC_STRING_LENGTH = 512;
const MAX_DIAGNOSTIC_INPUT_LENGTH = 4_096;
const MAX_DIAGNOSTIC_FIELD_NAME_LENGTH = 96;
const MAX_DIAGNOSTIC_DEPTH = 8;
const MAX_DIAGNOSTIC_NODES = 128;
const MAX_DIAGNOSTIC_ENTRIES = 32;
const MAX_DIAGNOSTIC_ARRAY_ITEMS = 32;
const MAX_LOG_LINE_LENGTH = 8_192;
const REDACTED = "[REDACTED]";
const URL_FIELD = /(?:url|uri|href)$/i;
const SENSITIVE_FIELD_PARTS = [
  "query",
  "token",
  "secret",
  "password",
  "passwd",
  "authorization",
  "cookie",
  "apikey",
  "session",
  "signature",
  "credential",
  "supabasekey",
  "servicekey",
  "servicerole",
  "privatekey",
] as const;

function boundedInput(value: string, maxLength = MAX_DIAGNOSTIC_INPUT_LENGTH): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

function bounded(value: string): string {
  return value.length > MAX_DIAGNOSTIC_STRING_LENGTH
    ? value.slice(0, MAX_DIAGNOSTIC_STRING_LENGTH)
    : value;
}

/** Keep the URL's useful path while removing credentials, query parameters, and fragments. */
export function redactDiagnosticUrl(value: string): string {
  try {
    const url = new URL(boundedInput(value));
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return `${url.origin}${url.pathname || "/"}`;
  } catch {
    // Do not route invalid URL text back through URL recognition: doing so
    // would recurse on malformed schemes (for example `https://%zz`).
    return "[Invalid URL]";
  }
}

function redactDiagnosticText(value: string): string {
  const input = boundedInput(value);
  const withUrlsSanitized = input.replace(/https?:\/\/[^\s<>"')]+/gi, (candidate) => {
    const trailing = candidate.match(/[),.;!?]+$/)?.[0] ?? "";
    const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
    return `${redactDiagnosticUrl(url)}${trailing}`;
  });
  const withSecretsSanitized = redactSensitiveText(withUrlsSanitized)
    .replace(/(\b(?:password|passwd|secret|token|api[_-]?key|authorization|cookie)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, `$1${REDACTED}`);
  return bounded(withSecretsSanitized);
}

/** Recursively copy diagnostics into a bounded, credential-safe JSON shape. */
export function redactDiagnostic(value: unknown): unknown {
  const activePath = new WeakSet<object>();
  let visitedNodes = 0;
  const isSensitiveField = (key: string): boolean => {
    // Very long keys are not useful diagnostics and could hide a sensitive
    // suffix beyond the bounded normalization work, so redact their values.
    if (key.length > MAX_DIAGNOSTIC_FIELD_NAME_LENGTH) return true;
    const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    return SENSITIVE_FIELD_PARTS.some((part) => normalized.includes(part));
  };
  const visit = (current: unknown, key = "", depth = 0): unknown => {
    visitedNodes += 1;
    if (visitedNodes > MAX_DIAGNOSTIC_NODES || depth > MAX_DIAGNOSTIC_DEPTH) return "[Truncated]";
    if (isSensitiveField(key)) return REDACTED;
    if (typeof current === "string") {
      return URL_FIELD.test(key) ? bounded(redactDiagnosticUrl(current)) : redactDiagnosticText(current);
    }
    if (typeof current === "number" || typeof current === "boolean" || current === null || current === undefined) return current;
    if (current instanceof Error) return redactDiagnosticText(current.message);
    if (current instanceof Date) return Number.isNaN(current.getTime()) ? "[Invalid Date]" : current.toISOString();
    if (Array.isArray(current)) {
      if (activePath.has(current)) return "[Circular]";
      activePath.add(current);
      const length = Math.min(current.length, MAX_DIAGNOSTIC_ARRAY_ITEMS);
      const copy: unknown[] = [];
      for (let index = 0; index < length && visitedNodes < MAX_DIAGNOSTIC_NODES; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
        copy.push(descriptor && "value" in descriptor ? visit(descriptor.value, "", depth + 1) : null);
      }
      if (current.length > length || visitedNodes >= MAX_DIAGNOSTIC_NODES) copy.push("[Truncated]");
      activePath.delete(current);
      return copy;
    }
    if (typeof current === "object") {
      if (activePath.has(current)) return "[Circular]";
      activePath.add(current);
      const copy = Object.create(null) as Record<string, unknown>;
      let entries = 0;
      for (const childKey in current) {
        if (!Object.prototype.hasOwnProperty.call(current, childKey)) continue;
        if (entries >= MAX_DIAGNOSTIC_ENTRIES || visitedNodes >= MAX_DIAGNOSTIC_NODES) {
          copy["[truncated]"] = "[Truncated]";
          break;
        }
        entries += 1;
        const safeKey = childKey.slice(0, MAX_DIAGNOSTIC_FIELD_NAME_LENGTH);
        try {
          const descriptor = Object.getOwnPropertyDescriptor(current, childKey);
          if (descriptor && "value" in descriptor) copy[safeKey] = visit(descriptor.value, childKey, depth + 1);
          else copy[safeKey] = "[Unavailable]";
        } catch {
          copy[safeKey] = "[Unavailable]";
        }
      }
      activePath.delete(current);
      return copy;
    }
    if (typeof current === "bigint") return current.toString();
    if (typeof current === "symbol") return current.description ? `[Symbol(${current.description})]` : "[Symbol]";
    if (typeof current === "function") return "[Function]";
    return "[Unknown]";
  };
  return visit(value);
}

export class Logger {
  private readonly now: () => string;
  private readonly sink: ((line: string) => void) | undefined;

  public constructor(private readonly minimum: LogLevel = "info", options: LoggerOptions = {}) {
    this.now = options.now ?? (() => new Date().toISOString());
    this.sink = options.sink;
  }

  public debug(tag: string, message: string): void {
    this.write("debug", tag, message);
  }

  public info(tag: string, message: string): void {
    this.write("info", tag, message);
  }

  public warn(tag: string, message: string): void {
    this.write("warn", tag, message);
  }

  public error(tag: string, message: string): void {
    this.write("error", tag, message);
  }

  public event(level: LogLevel, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (ranks[level] < ranks[this.minimum]) return;
    const redacted = redactDiagnostic(fields);
    const safeFields = redacted && typeof redacted === "object" && !Array.isArray(redacted)
      ? redacted as Record<string, unknown>
      : { value: redacted };
    const timestamp = boundedInput(this.now(), 128);
    const safeEvent = boundedInput(event, 128);
    let line = JSON.stringify({ ...safeFields, timestamp, level, event: safeEvent });
    if (line.length > MAX_LOG_LINE_LENGTH) {
      line = JSON.stringify({ timestamp, level, event: safeEvent, diagnostics: "[Truncated]" });
    }
    this.emit(level, line);
  }

  private write(level: LogLevel, tag: string, message: string): void {
    if (ranks[level] < ranks[this.minimum]) return;
    const safeTag = boundedInput(tag, 64).toLocaleUpperCase();
    const timestamp = boundedInput(this.now(), 128);
    const line = `[${safeTag}] [${timestamp}] ${redactDiagnosticText(message)}`;
    this.emit(level, line);
  }

  private emit(level: LogLevel, line: string): void {
    if (this.sink) {
      this.sink(line);
    } else if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.log(line);
  }
}
