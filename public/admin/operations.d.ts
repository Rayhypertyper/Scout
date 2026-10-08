export const OPERATIONS_ENDPOINT: string;
export const OPERATIONS_REFRESH_MS: number;

export class OperationsAccessError extends Error {
  readonly code: string;
  constructor(message?: string);
}

export class OperationsRequestError extends Error {
  readonly code: string;
  constructor(message?: string);
}

export type OperationsPayload = Record<string, unknown>;

export function escapeHtml(value: unknown): string;
export function diagnosticText(value: unknown): string;
export function normalizeOperationsPayload(payload: unknown): OperationsPayload | null;
export function readOperations(fetchImpl?: (input: string, init?: RequestInit) => Promise<Response>): Promise<OperationsPayload>;
export function formatDuration(value: unknown): string;
export function formatRelativeTime(value: unknown, now?: number): string;
export function renderOperationsMarkup(
  payload: unknown,
  options?: { now?: number; exact?: boolean },
): string;
export function renderOperationsLoadingMarkup(): string;
