import { resolve } from "node:path";

import { ScoutSettingsSchema, type ScoutSettings } from "../domain/schemas.js";

export const DEFAULT_SETTINGS: ScoutSettings = ScoutSettingsSchema.parse({
  databasePath: process.env.SCOUT_DATABASE_PATH ?? "./output/internships.db",
  outputDirectory: process.env.SCOUT_OUTPUT_DIR ?? "./output",
  verbose: process.env.SCOUT_LOG_LEVEL === "debug",
});

export function resolveSettings(overrides: Partial<ScoutSettings> = {}): ScoutSettings {
  const settings = ScoutSettingsSchema.parse({ ...DEFAULT_SETTINGS, ...overrides });
  return {
    ...settings,
    // `concurrency` predates the separate HTTP/browser budgets. Keep it as a
    // compatibility alias for callers that still configure the old option.
    browserConcurrency: overrides.browserConcurrency ?? overrides.concurrency ?? settings.browserConcurrency,
    databasePath: resolve(settings.databasePath),
    outputDirectory: resolve(settings.outputDirectory),
  };
}
