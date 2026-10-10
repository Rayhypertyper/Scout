export function createTodayController(options: {
  authClient: { csrfHeaders(): Promise<Record<string, string>> };
  getSavedRoles(): Array<Record<string, unknown>>;
  saveRole(role: Record<string, unknown>): void;
}): {
  load(options?: { force?: boolean }): Promise<unknown>;
  render(): void;
  reset(userId: string | null): void;
};
