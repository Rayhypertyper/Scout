export const RECENT_LISTING_WINDOW_MS: number;
export function isNewSinceLastScan(role: unknown, data: unknown): boolean;
export function isWithinRecentListingWindow(value: unknown, now?: number): boolean;
export function isRecentListing(role: unknown, data: unknown, now?: number): boolean;
