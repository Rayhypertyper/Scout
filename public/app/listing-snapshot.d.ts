export const LISTING_SNAPSHOT_KEY: string;
export const LISTING_SNAPSHOT_MAX_AGE_MS: number;
interface SnapshotOptions {
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  now?: number;
}
export interface ListingSnapshot {
  items: Array<Record<string, unknown>>;
  savedAt: number;
  pagination: { limit: number; offset: number; total: number; hasMore: false; nextOffset: null };
}
export function readListingSnapshot(key: string, options?: SnapshotOptions): ListingSnapshot | null;
export function rememberListingSnapshot(key: string, payload: unknown, options?: SnapshotOptions): boolean;
export function clearListingSnapshots(options?: SnapshotOptions): void;
