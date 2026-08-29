import { describe, expect, it } from "vitest";

import { evaluateBudgets, median, parseBudgetConfig } from "../scripts/performance/budget.js";

describe("dashboard performance budget parsing", () => {
  it("accepts numeric ceilings, rule objects, and disabled metrics", () => {
    const config = parseBudgetConfig({
      schemaVersion: 1,
      phases: {
        cold: { timeToUsableCardsMs: 3_000, cls: { max: 0.6, rationale: "fixture" }, searchInteractionMs: null },
        warm: { requestCount: { min: 1, max: 10 } },
      },
    });
    expect(config.phases.cold.timeToUsableCardsMs).toBe(3_000);
    expect(config.phases.cold.cls).toEqual({ max: 0.6, rationale: "fixture" });
    expect(config.phases.cold.searchInteractionMs).toBeNull();
  });

  it("rejects unknown metrics and contradictory ranges", () => {
    expect(() => parseBudgetConfig({
      schemaVersion: 1,
      phases: { cold: { madeUpMetric: 1 }, warm: {} },
    })).toThrow(/Unknown performance budget metric/);
    expect(() => parseBudgetConfig({
      schemaVersion: 1,
      phases: { cold: { requestCount: { min: 4, max: 2 } }, warm: {} },
    })).toThrow(/cannot be greater/);
  });

  it("accepts the paginated-list, waterfall, and lazy-detail metrics", () => {
    const config = parseBudgetConfig({
      schemaVersion: 1,
      phases: {
        cold: {
          apiListCompletionMs: { max: 2_000 },
          initialApiTransferBytes: { max: 5_000 },
          initialRolesRequestCount: { max: 1 },
          detailFetchMs: { max: 300 },
        },
        warm: {
          changesTransferBytes: { max: 1_500 },
          warmReloadMs: { max: 400 },
        },
      },
    });
    expect(evaluateBudgets("cold", {
      apiListCompletionMs: 1_250,
      initialApiTransferBytes: 3_350,
      initialRolesRequestCount: 1,
      detailFetchMs: 120,
    }, config).status).toBe("pass");
    expect(evaluateBudgets("warm", {
      changesTransferBytes: 700,
      warmReloadMs: 210,
    }, config).status).toBe("pass");
  });
});

describe("dashboard performance budget evaluation", () => {
  const config = parseBudgetConfig({
    schemaVersion: 1,
    phases: {
      cold: { timeToUsableCardsMs: 3_000, initialCardsRendered: { min: 1 }, cls: null },
      warm: { requestCount: 10 },
    },
  });

  it("passes maxima/minima and reports disabled rules separately", () => {
    const evaluation = evaluateBudgets("cold", {
      timeToUsableCardsMs: 2_500,
      initialCardsRendered: 3,
      cls: 0.8,
    }, config);
    expect(evaluation.status).toBe("pass");
    expect(evaluation.checks.find((check) => check.metric === "timeToUsableCardsMs")?.status).toBe("pass");
    expect(evaluation.checks.find((check) => check.metric === "initialCardsRendered")?.status).toBe("pass");
    expect(evaluation.checks.find((check) => check.metric === "cls")?.status).toBe("not-configured");
  });

  it("fails actionable regressions and does not invent missing values", () => {
    const evaluation = evaluateBudgets("warm", { requestCount: 14 }, config);
    expect(evaluation.status).toBe("fail");
    expect(evaluation.checks[0]).toMatchObject({ metric: "requestCount", actual: 14, status: "fail" });

    const unsupported = evaluateBudgets("cold", { initialCardsRendered: null }, config);
    expect(unsupported.checks.find((check) => check.metric === "timeToUsableCardsMs")?.status).toBe("unsupported");
    expect(unsupported.checks.find((check) => check.metric === "initialCardsRendered")?.status).toBe("unsupported");
    expect(unsupported.checks.find((check) => check.metric === "cls")?.status).toBe("not-configured");
    expect(unsupported.status).toBe("incomplete");
  });

  it("computes medians while ignoring unsupported samples", () => {
    expect(median([null, 8, 2, 4])).toBe(4);
    expect(median([null, undefined])).toBeNull();
  });
});
