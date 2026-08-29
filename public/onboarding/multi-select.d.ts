export type SearchActiveDirection = "next" | "previous" | "first" | "last";

export interface SearchMultiSelectConfig<T> {
  input: HTMLInputElement;
  list: HTMLElement;
  selectedList: HTMLElement;
  options?: readonly T[];
  keyForOption?: (option: T) => unknown;
  labelForOption?: (option: T) => unknown;
  detailForOption?: (option: T) => unknown;
  emptyLabel?: string;
  noResultsLabel?: string;
  emptyOptionsLabel?: string;
  selectionContext?: string;
  maximum?: number;
  onChange?: (values: T[]) => void;
}

export interface SearchMultiSelectController<T> {
  values(): T[];
  setOptions(options: readonly T[]): void;
  setValues(options: readonly T[]): void;
  focus(): void;
  close(): void;
}

export interface SelectionTransition {
  keys: string[];
  selected: boolean;
  changed: boolean;
  blocked: boolean;
}

export function createSelectorOptionId(instanceId: string, ordinal: number): string;
export function activeDescendantOptionId(
  activeKey: string | null,
  visibleKeys: readonly string[],
  idsByKey: Map<string, string> | Record<string, string>,
): string | null;
export function selectionAfterToggle(keys: readonly string[], key: string, maximum?: number): SelectionTransition;
export function nextActiveKey(keys: readonly string[], activeKey: string | null, direction: SearchActiveDirection): string | null;
export function createSearchMultiSelect<T>(config: SearchMultiSelectConfig<T>): SearchMultiSelectController<T>;
