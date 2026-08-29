export type BenchmarkPhase = "cold" | "warm";

/** Numeric fields emitted by the dashboard benchmark. */
export const BUDGET_METRICS = [
  "timeToUsableCardsMs",
  "shellFcpMs",
  "lcpMs",
  "apiListTtfbMs",
  "apiListCompletionMs",
  "apiListBodyBytes",
  "apiListTransferBytes",
  "changesTtfbMs",
  "changesCompletionMs",
  "changesBodyBytes",
  "changesTransferBytes",
  "initialJsBodyBytes",
  "initialJsTransferBytes",
  "initialApiBodyBytes",
  "initialApiTransferBytes",
  "initialBodyBytes",
  "initialTransferBytes",
  "requestCount",
  "initialRolesRequestCount",
  "initialChangesRequestCount",
  "legacyApiDataRequests",
  "initialJobsTransferred",
  "totalJobsAvailable",
  "initialCardsRendered",
  "domNodes",
  "cls",
  "searchInteractionMs",
  "categoryInteractionMs",
  "filterInteractionMs",
  "tabInteractionMs",
  "loadMoreMs",
  "detailFetchMs",
  "detailOpenMs",
  "warmReloadMs",
] as const;

export type BudgetMetric = (typeof BUDGET_METRICS)[number];

export interface BudgetRule {
  max?: number;
  min?: number;
  rationale?: string;
}

export type BudgetPhase = Partial<Record<BudgetMetric, number | BudgetRule | null>>;

export interface PerformanceBudgetConfig {
  schemaVersion: 1;
  calibration?: {
    capturedAt?: string;
    source?: string;
    notes?: string;
  };
  phases: Record<BenchmarkPhase, BudgetPhase>;
}

export interface BudgetCheck {
  metric: BudgetMetric;
  actual: number | null;
  rule: BudgetRule | null;
  status: "pass" | "fail" | "unsupported" | "not-configured";
  reason?: string;
}

export interface BudgetEvaluation {
  phase: BenchmarkPhase;
  status: "pass" | "fail" | "incomplete";
  checks: BudgetCheck[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
  return value;
}

function parseRule(value: unknown, label: string): number | BudgetRule | null {
  if (value === null) return null;
  if (typeof value === "number") return finiteNumber(value, label);
  if (!isRecord(value)) throw new Error(`${label} must be a number, rule object, or null`);
  const rule: BudgetRule = {};
  if (value.max !== undefined) rule.max = finiteNumber(value.max, `${label}.max`);
  if (value.min !== undefined) rule.min = finiteNumber(value.min, `${label}.min`);
  if (value.rationale !== undefined) {
    if (typeof value.rationale !== "string") throw new Error(`${label}.rationale must be a string`);
    rule.rationale = value.rationale;
  }
  if (rule.max === undefined && rule.min === undefined) {
    throw new Error(`${label} must define max and/or min`);
  }
  if (rule.max !== undefined && rule.min !== undefined && rule.min > rule.max) {
    throw new Error(`${label}.min cannot be greater than ${label}.max`);
  }
  return rule;
}

/**
 * Parse and validate a checked-in budget file. Null disables a metric until a
 * final post-optimization calibration has established a stable ceiling.
 */
export function parseBudgetConfig(value: unknown): PerformanceBudgetConfig {
  if (!isRecord(value)) throw new Error("Performance budget must be a JSON object");
  if (value.schemaVersion !== 1) throw new Error("Performance budget schemaVersion must be 1");
  if (!isRecord(value.phases)) throw new Error("Performance budget must contain phases");

  const phases: Record<BenchmarkPhase, BudgetPhase> = { cold: {}, warm: {} };
  for (const phase of ["cold", "warm"] as const) {
    const rawPhase = value.phases[phase];
    if (!isRecord(rawPhase)) throw new Error(`Performance budget phase '${phase}' must be an object`);
    const parsed: BudgetPhase = {};
    for (const [metric, rawRule] of Object.entries(rawPhase)) {
      if (!(BUDGET_METRICS as readonly string[]).includes(metric)) {
        throw new Error(`Unknown performance budget metric '${metric}' in ${phase}`);
      }
      parsed[metric as BudgetMetric] = parseRule(rawRule, `${phase}.${metric}`);
    }
    phases[phase] = parsed;
  }

  const calibration = value.calibration;
  if (calibration !== undefined && !isRecord(calibration)) throw new Error("calibration must be an object");
  return {
    schemaVersion: 1,
    ...(calibration ? {
      calibration: {
        ...(typeof calibration.capturedAt === "string" ? { capturedAt: calibration.capturedAt } : {}),
        ...(typeof calibration.source === "string" ? { source: calibration.source } : {}),
        ...(typeof calibration.notes === "string" ? { notes: calibration.notes } : {}),
      },
    } : {}),
    phases,
  };
}

function normalizeRule(rule: number | BudgetRule | null): BudgetRule | null {
  if (rule === null) return null;
  return typeof rule === "number" ? { max: rule } : rule;
}

function numericMetric(metrics: Record<string, unknown>, metric: BudgetMetric): number | null {
  const value = metrics[metric];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Evaluate median metrics against one phase's configured rules. */
export function evaluateBudgets(
  phase: BenchmarkPhase,
  metrics: Record<string, unknown>,
  config: PerformanceBudgetConfig,
): BudgetEvaluation {
  const checks: BudgetCheck[] = [];
  const phaseRules = config.phases[phase];
  for (const metric of BUDGET_METRICS) {
    if (!(metric in phaseRules)) continue;
    const rule = normalizeRule(phaseRules[metric] ?? null);
    const actual = numericMetric(metrics, metric);
    if (rule === null) {
      checks.push({ metric, actual, rule: null, status: "not-configured", reason: "Budget is disabled until calibration." });
      continue;
    }
    if (actual === null) {
      checks.push({ metric, actual: null, rule, status: "unsupported", reason: "Metric was not available in this run." });
      continue;
    }
    const overMax = rule.max !== undefined && actual > rule.max;
    const underMin = rule.min !== undefined && actual < rule.min;
    checks.push({
      metric,
      actual,
      rule,
      status: overMax || underMin ? "fail" : "pass",
      ...(overMax ? { reason: `Actual ${actual} exceeds max ${rule.max}.` } : {}),
      ...(underMin ? { reason: `Actual ${actual} is below min ${rule.min}.` } : {}),
    });
  }
  const hasFailure = checks.some((check) => check.status === "fail");
  const hasUnsupported = checks.some((check) => check.status === "unsupported");
  return { phase, status: hasFailure ? "fail" : hasUnsupported ? "incomplete" : "pass", checks };
}

export function median(values: readonly (number | null | undefined)[]): number | null {
  const finite = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value)).toSorted((a, b) => a - b);
  if (finite.length === 0) return null;
  const middle = Math.floor(finite.length / 2);
  return finite.length % 2 === 1 ? finite[middle] ?? null : ((finite[middle - 1] ?? 0) + (finite[middle] ?? 0)) / 2;
}
