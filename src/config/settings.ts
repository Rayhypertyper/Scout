import "./env.js";

import { resolve } from "node:path";

import { ScoutSettingsSchema, type ScoutSettings } from "../domain/schemas.js";
import { MIN_LISTING_SCORE } from "./thresholds.js";
import { resolveScoutEditionConfig, scoutEditionFromEnvironment } from "./edition.js";

export const DEFAULT_SETTINGS: ScoutSettings = ScoutSettingsSchema.parse({
  edition: scoutEditionFromEnvironment(),
  databasePath: process.env.SCOUT_DATABASE_PATH ?? "./output/internships.db",
  outputDirectory: process.env.SCOUT_OUTPUT_DIR ?? "./output",
  verbose: process.env.SCOUT_LOG_LEVEL === "debug",
  minRelevanceScore: scoutEditionFromEnvironment() === "personal" ? MIN_LISTING_SCORE : 0,
});

export function resolveSettings(overrides: Partial<ScoutSettings> = {}): ScoutSettings {
  const edition = resolveScoutEditionConfig(overrides.edition ?? DEFAULT_SETTINGS.edition).edition;
  const settings = ScoutSettingsSchema.parse({
    ...DEFAULT_SETTINGS,
    ...overrides,
    edition,
    minRelevanceScore: overrides.minRelevanceScore
      ?? (edition === "personal" ? MIN_LISTING_SCORE : 0),
  });
  return {
    ...settings,
    // `concurrency` predates the separate HTTP/browser budgets. Keep it as a
    // compatibility alias for callers that still configure the old option.
    browserConcurrency: overrides.browserConcurrency ?? overrides.concurrency ?? settings.browserConcurrency,
    databasePath: resolve(settings.databasePath),
    outputDirectory: resolve(settings.outputDirectory),
  };
}
