export type PreferenceStep = 1 | 2 | 3;

export interface PreferenceTerm {
  term: string;
  year: number;
  [key: string]: unknown;
}

export interface PreferenceCity {
  name: string;
  country: string;
  region?: string;
  [key: string]: unknown;
}

export interface RegionalAnswers {
  canada: string | null;
  unitedStates: string | null;
  [key: string]: unknown;
}

export interface PreferenceState {
  terms: PreferenceTerm[];
  countries: string[];
  cities: PreferenceCity[];
  remote: boolean;
  roleCategories: string[];
  technologies: string[];
  degree: string | null;
  graduationYear: number | null;
  graduationYearOrLater: boolean;
  workAuthorization: RegionalAnswers;
  sponsorship: RegionalAnswers;
  onboardingCompleted: boolean;
  currentStep: PreferenceStep;
  createdAt?: string | null;
  updatedAt?: string | null;
  completedAt?: string | null;
  [key: string]: unknown;
}

export interface SubmissionGate {
  enter(): boolean;
  leave(): void;
  isActive(): boolean;
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export interface GraduationYearOption {
  value: string;
  label: string;
}

export interface TermsStepPayload {
  terms: PreferenceTerm[];
}

export interface SearchStepPayload {
  countries: string[];
  cities: PreferenceCity[];
  remote: boolean;
  roleCategories: string[];
  technologies: string[];
}

export interface EligibilityStepPayload {
  degree: string | null;
  graduationYear: number | null;
  graduationYearOrLater: boolean;
  workAuthorization: RegionalAnswers;
  sponsorship: RegionalAnswers;
}

export type PreferenceStepPayload = TermsStepPayload | SearchStepPayload | EligibilityStepPayload;

export function createSubmissionGate(): SubmissionGate;
export function requiredCountries(state: unknown): string[];
export function stepForField(field: unknown): PreferenceStep;
export function validationIssuesForStep(step: unknown, state: unknown): ValidationIssue[];
export function payloadForStep(step: unknown, state: unknown): PreferenceStepPayload;
export function previousStepState<T>(step: unknown, state: T): { step: number; state: T };
export function emptyState(): PreferenceState;
export function normalizePreferenceState(value?: unknown): PreferenceState;
export function mergePreferenceState(previous: unknown, next: unknown): PreferenceState;
export function mergeSavedStepState(previous: unknown, next: unknown, step: unknown): PreferenceState;
export function graduationYearOptions(values?: readonly unknown[], selectedYear?: unknown): GraduationYearOption[];
