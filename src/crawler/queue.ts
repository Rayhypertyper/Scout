import type { CrawlQueueItem } from "../domain/types.js";
import { BoundedAsyncQueue } from "../utils/async.js";

interface StoredItem {
  sequence: number;
  item: CrawlQueueItem;
}

export class PriorityQueue {
  private readonly items: StoredItem[] = [];
  private sequence = 0;

  public get size(): number {
    return this.items.length;
  }

  public push(item: CrawlQueueItem): void {
    this.items.push({ item, sequence: this.sequence++ });
    this.items.sort((left, right) => right.item.priority - left.item.priority || left.sequence - right.sequence);
  }

  public pop(): CrawlQueueItem | undefined {
    return this.items.shift()?.item;
  }
}

/**
 * Bounded FIFO queue for streaming crawl stages. Kept next to PriorityQueue
 * so callers can use the existing URL priority queue for discovery while
 * detail/analyze workers use explicit backpressure and cancellation.
 */
export class CrawlQueue<T> extends BoundedAsyncQueue<T> {}
