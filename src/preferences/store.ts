import { DatabaseSync } from "node:sqlite";

import {
  PreferenceAnswersStorageSchema,
  PreferenceValidationError,
  emptyPreferenceAnswers,
  parseCompletePreferenceAnswers,
  parsePreferenceStep,
  type EligibilityStep,
  type InternshipPreferences,
  type PreferenceAnswers,
  type PreferenceStep,
  type TermStep,
} from "./schema.js";

const PREFERENCE_SCHEMA = `
CREATE TABLE IF NOT EXISTS user_internship_preferences (
  user_id TEXT PRIMARY KEY,
  preferences_json TEXT NOT NULL,
  onboarding_step INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_step BETWEEN 1 AND 3),
  onboarding_completed INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
`;

const LEGACY_TIMESTAMP = "1970-01-01T00:00:00.000Z";

/** Persistence failures are kept distinct from auth-provider failures. */
export class PreferenceStorageError extends Error {
  constructor(message = "Internship preferences are temporarily unavailable.", options?: ErrorOptions) {
    super(message, options);
    this.name = "PreferenceStorageError";
  }
}

interface PreferenceRow {
  preferences_json: string;
  onboarding_step: number;
  onboarding_completed: number;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

function openDatabase(databasePath: string): DatabaseSync {
  let database: DatabaseSync | undefined;
  try {
    database = new DatabaseSync(databasePath);
    database.exec("PRAGMA busy_timeout = 30000");
    database.exec(PREFERENCE_SCHEMA);

    // The preference table was introduced after the main listings database.
    // Keep startup non-destructive if a process is upgraded while an older
    // preference table is already present.
    const columns = new Set(
      (database.prepare("PRAGMA table_info(user_internship_preferences)").all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
    const additions: Array<[string, string]> = [
      ["preferences_json", "TEXT NOT NULL DEFAULT '{}'"],
      ["onboarding_step", "INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_step BETWEEN 1 AND 3)"],
      ["onboarding_completed", "INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_completed IN (0, 1))"],
      ["created_at", `TEXT NOT NULL DEFAULT '${LEGACY_TIMESTAMP}'`],
      ["updated_at", `TEXT NOT NULL DEFAULT '${LEGACY_TIMESTAMP}'`],
      ["completed_at", "TEXT"],
    ];
    for (const [name, definition] of additions) {
      if (!columns.has(name)) database.exec(`ALTER TABLE user_internship_preferences ADD COLUMN ${name} ${definition}`);
    }
    database.exec(`
      CREATE INDEX IF NOT EXISTS idx_user_internship_preferences_completed
        ON user_internship_preferences(onboarding_completed, updated_at)
    `);
    return database;
  } catch (error) {
    try { database?.close(); } catch { /* Preserve the original migration failure. */ }
    if (error instanceof PreferenceStorageError) throw error;
    throw new PreferenceStorageError(undefined, { cause: error });
  }
}

function safeUserId(userId: string): string {
  const normalized = userId.trim();
  if (!normalized || normalized.length > 255) throw new Error("A valid authenticated user ID is required.");
  return normalized;
}

function rowAnswers(row: PreferenceRow | undefined): PreferenceAnswers {
  if (!row) return emptyPreferenceAnswers();
  try {
    const result = PreferenceAnswersStorageSchema.safeParse(JSON.parse(row.preferences_json));
    return result.success ? result.data : emptyPreferenceAnswers();
  } catch {
    return emptyPreferenceAnswers();
  }
}

function publicPreferences(row: PreferenceRow | undefined): InternshipPreferences {
  const step = row?.onboarding_step === 2 || row?.onboarding_step === 3 ? row.onboarding_step : 1;
  return {
    ...rowAnswers(row),
    currentStep: step,
    onboardingCompleted: row?.onboarding_completed === 1,
    createdAt: row?.created_at ?? null,
    updatedAt: row?.updated_at ?? null,
    completedAt: row?.completed_at ?? null,
  };
}

function readRow(database: DatabaseSync, userId: string): PreferenceRow | undefined {
  return database.prepare(`
    SELECT preferences_json, onboarding_step, onboarding_completed, created_at, updated_at, completed_at
    FROM user_internship_preferences
    WHERE user_id = @userId
  `).get({ userId }) as PreferenceRow | undefined;
}

export function ensurePreferenceSchema(databasePath: string): void {
  const database = openDatabase(databasePath);
  database.close();
}

export function readInternshipPreferences(databasePath: string, userId: string): InternshipPreferences {
  const normalizedUserId = safeUserId(userId);
  const database = openDatabase(databasePath);
  try {
    return publicPreferences(readRow(database, normalizedUserId));
  } catch (error) {
    if (error instanceof PreferenceStorageError) throw error;
    throw new PreferenceStorageError(undefined, { cause: error });
  } finally {
    database.close();
  }
}

function mergeStep(
  current: PreferenceAnswers,
  step: 1 | 2 | 3,
  input: TermStep | PreferenceStep | EligibilityStep,
): PreferenceAnswers {
  if (step === 1) return { ...current, ...(input as TermStep) };
  if (step === 2) return { ...current, ...(input as PreferenceStep) };
  return { ...current, ...(input as EligibilityStep) };
}

export function saveInternshipPreferenceStep(
  databasePath: string,
  userId: string,
  step: 1 | 2 | 3,
  value: unknown,
  now = new Date(),
): InternshipPreferences {
  const normalizedUserId = safeUserId(userId);
  const parsed = parsePreferenceStep(step as 1 & 2 & 3, value) as TermStep | PreferenceStep | EligibilityStep;
  const timestamp = now.toISOString();
  const database = openDatabase(databasePath);
  let transactionStarted = false;
  try {
    database.exec("BEGIN IMMEDIATE");
    transactionStarted = true;
    const existing = readRow(database, normalizedUserId);
    const answers = mergeStep(rowAnswers(existing), step, parsed);
    const completed = step === 3 ? true : existing?.onboarding_completed === 1;
    const validatedAnswers = completed ? parseCompletePreferenceAnswers(answers) : answers;
    const candidateStep = step === 1 ? 2 : 3;
    const nextStep = (completed
      ? 3
      : Math.max(existing?.onboarding_step ?? 1, candidateStep)) as 1 | 2 | 3;
    const completedAt = completed ? (existing?.completed_at ?? timestamp) : null;
    const values = {
      userId: normalizedUserId,
      preferencesJson: JSON.stringify(validatedAnswers),
      onboardingStep: nextStep,
      onboardingCompleted: completed ? 1 : 0,
      createdAt: existing?.created_at ?? timestamp,
      updatedAt: timestamp,
      completedAt,
    };
    // An explicit update/insert works with both the current schema and a
    // legacy table that predates the user_id primary-key constraint.
    if (existing) {
      database.prepare(`
        UPDATE user_internship_preferences
        SET preferences_json = @preferencesJson,
            onboarding_step = @onboardingStep,
            onboarding_completed = @onboardingCompleted,
            updated_at = @updatedAt,
            completed_at = @completedAt
        WHERE user_id = @userId
      `).run({
        userId: values.userId,
        preferencesJson: values.preferencesJson,
        onboardingStep: values.onboardingStep,
        onboardingCompleted: values.onboardingCompleted,
        updatedAt: values.updatedAt,
        completedAt: values.completedAt,
      });
    } else {
      database.prepare(`
        INSERT INTO user_internship_preferences (
          user_id, preferences_json, onboarding_step, onboarding_completed, created_at, updated_at, completed_at
        ) VALUES (
          @userId, @preferencesJson, @onboardingStep, @onboardingCompleted, @createdAt, @updatedAt, @completedAt
        )
      `).run(values);
    }
    const saved = readRow(database, normalizedUserId);
    database.exec("COMMIT");
    transactionStarted = false;
    return publicPreferences(saved);
  } catch (error) {
    if (transactionStarted) {
      try { database.exec("ROLLBACK"); } catch { /* Preserve the original failure. */ }
    }
    if (error instanceof PreferenceValidationError) throw error;
    if (error instanceof PreferenceStorageError) throw error;
    throw new PreferenceStorageError(undefined, { cause: error });
  } finally {
    database.close();
  }
}
