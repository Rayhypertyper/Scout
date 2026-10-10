export interface RequestPool {
  run<T>(task: (signal?: AbortSignal) => T | PromiseLike<T>, options?: { signal?: AbortSignal }): Promise<Awaited<T>>;
  cancelPending(reason?: unknown): void;
  dispose(): void;
  readonly activeCount: number;
  readonly pendingCount: number;
}

export function createRequestPool(options?: { concurrency?: number }): RequestPool;

export function appendBoundedHistory<T>(
  history: readonly T[] | null | undefined,
  entry: T,
  maxEntries?: number,
  keyOf?: (value: T) => unknown,
): T[];

export interface VisibilityDocument {
  readonly visibilityState?: string;
  addEventListener?(type: string, listener: () => void): void;
  removeEventListener?(type: string, listener: () => void): void;
}

export function pageIsVisible(documentRef?: Pick<VisibilityDocument, "visibilityState"> | null): boolean;

export type VisibilityWaitResult = "timer" | "hidden" | "visible";
export type TimerHandle = ReturnType<typeof setTimeout> | number;

export interface VisibilityWaitOptions {
  documentRef?: VisibilityDocument | null;
  delay?: number;
  setTimeoutImpl?: (callback: () => void, delay: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
}

export function waitForVisibilityOrDelay(options?: VisibilityWaitOptions): Promise<VisibilityWaitResult>;

export interface VisibilitySchedulerOptions {
  documentRef?: VisibilityDocument | null;
  pollInterval?: number;
  tickInterval?: number;
  onPoll?: () => void;
  onTick?: () => void;
  onVisible?: () => void;
  onHidden?: () => void;
  shouldPoll?: () => boolean;
  shouldTick?: () => boolean;
  setIntervalImpl?: (callback: () => void, delay: number) => TimerHandle;
  clearIntervalImpl?: (handle: TimerHandle) => void;
}

export interface VisibilityScheduler {
  start(): void;
  stop(): void;
  poll(): void;
  tick(): void;
  readonly started: boolean;
}

export function createVisibilityScheduler(options?: VisibilitySchedulerOptions): VisibilityScheduler;

export interface FeedEventTarget {
  addEventListener?(type: string, listener: () => void, options?: boolean | AddEventListenerOptions): void;
  removeEventListener?(type: string, listener: () => void, options?: boolean | EventListenerOptions): void;
}

export interface FeedScrollRoot extends FeedEventTarget {
  readonly style?: { readonly overflowY?: string };
  readonly scrollHeight?: number;
  readonly clientHeight?: number;
  getBoundingClientRect?: () => Pick<DOMRect, "bottom">;
}

export interface FeedWindowMock extends FeedEventTarget {
  readonly innerHeight?: number;
  getComputedStyle?: (element: FeedScrollRoot) => Pick<CSSStyleDeclaration, "overflowY">;
  requestAnimationFrame?: (callback: FrameRequestCallback) => number;
  cancelAnimationFrame?: (handle: number) => void;
}

export type FeedWindow = Window | FeedWindowMock;

export interface FeedViewportDocument {
  readonly documentElement?: Pick<HTMLElement, "clientHeight">;
}

export function resolveFeedScrollTarget(root: Element | null | undefined, windowRef?: FeedWindow | null): Element | FeedWindow | null;
export function resolveFeedScrollTarget(root: FeedScrollRoot | null, windowRef: FeedWindowMock | null): FeedScrollRoot | FeedWindowMock | null;

export interface ScrollLoadTriggerCommonOptions {
  sentinel?: { getBoundingClientRect?: () => Pick<DOMRect, "top"> } | null;
  documentRef?: FeedViewportDocument | null;
  margin?: number;
  canLoadMore?: () => boolean;
  onNearEnd?: () => void;
  frameRequest?: (callback: () => boolean) => TimerHandle;
  frameCancel?: (handle: TimerHandle) => void;
}

export type ScrollLoadTriggerOptions = ScrollLoadTriggerCommonOptions & (
  | { root?: Element | null; windowRef?: FeedWindow | null }
  | { root: FeedScrollRoot | null; windowRef: FeedWindowMock | null }
);

export interface ScrollLoadTrigger {
  start(): void;
  stop(): void;
  check(): boolean;
  schedule(): void;
  readonly scrollTarget: Element | FeedScrollRoot | FeedWindow | null;
  readonly started: boolean;
}

export function createScrollLoadTrigger(options?: ScrollLoadTriggerOptions): ScrollLoadTrigger;

export interface VirtualWindowOptions {
  itemCount?: number;
  estimatedItemHeight?: number;
  overscan?: number;
  maxRendered?: number;
}

export interface VirtualWindowRangeOptions {
  scrollTop?: number;
  viewportHeight?: number;
  focusedIndex?: number | null;
}

export interface VirtualWindowRange {
  readonly start: number;
  readonly end: number;
  readonly before: number;
  readonly after: number;
  readonly total: number;
  readonly indices: number[];
  readonly pinnedIndex: number | null;
}

export interface VirtualWindow {
  setItemCount(nextCount: number): void;
  measure(index: number, height: number): boolean;
  range(options?: VirtualWindowRangeOptions): VirtualWindowRange;
  offsetFor(index: number): number;
  indexAtOffset(offset: number): number;
  readonly itemCount: number;
  readonly totalHeight: number;
  estimatedItemHeight: number;
}

export function createVirtualWindow(options?: VirtualWindowOptions): VirtualWindow;
