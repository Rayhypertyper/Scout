/*
 * Small browser independent primitives used by the jobs feed.  Keeping these
 * concerns outside app.js makes the cancellation and scroll-root contracts
 * testable without booting the dashboard or constructing a listing fixture.
 */

function abortError() {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted", "AbortError");
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function signalReason(signal) {
  return signal?.reason || abortError();
}

function removeQueuedJob(queue, job) {
  const index = queue.indexOf(job);
  if (index >= 0) queue.splice(index, 1);
}

/**
 * Run async work with a fixed number of active requests.  A shared signal can
 * cancel both queued and in flight work; queued jobs are rejected immediately
 * so a filter change never leaves stale prefetch promises behind the pool.
 */
export function createRequestPool({ concurrency = 2 } = {}) {
  const limit = Math.max(1, Math.floor(Number(concurrency) || 1));
  const queue = [];
  let active = 0;
  let disposed = false;

  const pump = () => {
    while (!disposed && active < limit && queue.length) {
      const job = queue.shift();
      if (!job || job.settled) continue;
      if (job.signal?.aborted) {
        job.settled = true;
        job.reject(signalReason(job.signal));
        continue;
      }
      job.started = true;
      active += 1;
      Promise.resolve()
        .then(() => job.task(job.signal))
        .then(job.resolve, job.reject)
        .finally(() => {
          job.signal?.removeEventListener?.("abort", job.onAbort);
          active -= 1;
          job.settled = true;
          pump();
        });
    }
  };

  const run = (task, { signal } = {}) => {
    if (typeof task !== "function") return Promise.reject(new TypeError("A request task is required"));
    if (disposed) return Promise.reject(abortError());
    if (signal?.aborted) return Promise.reject(signalReason(signal));

    return new Promise((resolve, reject) => {
      const job = {
        task,
        signal,
        resolve,
        reject,
        started: false,
        settled: false,
        onAbort: null,
      };
      job.onAbort = () => {
        if (job.started || job.settled) return;
        removeQueuedJob(queue, job);
        job.settled = true;
        reject(signalReason(signal));
        pump();
      };
      signal?.addEventListener?.("abort", job.onAbort, { once: true });
      queue.push(job);
      pump();
    });
  };

  const cancelPending = (reason = abortError()) => {
    while (queue.length) {
      const job = queue.shift();
      if (!job || job.settled) continue;
      job.settled = true;
      job.signal?.removeEventListener?.("abort", job.onAbort);
      job.reject(reason);
    }
  };

  return {
    run,
    cancelPending,
    dispose() {
      disposed = true;
      cancelPending();
    },
    get activeCount() { return active; },
    get pendingCount() { return queue.length; },
  };
}

export function appendBoundedHistory(history, entry, maxEntries = 50, keyOf = (value) => value?.listingKey ?? value) {
  const limit = Math.max(1, Math.floor(Number(maxEntries) || 1));
  const key = keyOf(entry);
  const next = (Array.isArray(history) ? history : []).filter((value) => keyOf(value) !== key);
  next.push(entry);
  return next.slice(-limit);
}

export function pageIsVisible(documentRef = typeof document === "undefined" ? null : document) {
  return !documentRef || documentRef.visibilityState !== "hidden";
}

/**
 * Wait for a visible-page delay without leaving a timer alive after the page
 * is backgrounded. The result tells periodic callers whether they should
 * poll ("timer"), wait for visibility ("hidden"), or perform a catch-up
 * refresh immediately after a visibility transition ("visible").
 */
export function waitForVisibilityOrDelay({
  documentRef = typeof document === "undefined" ? null : document,
  delay = 0,
  setTimeoutImpl = typeof setTimeout === "function" ? setTimeout : null,
  clearTimeoutImpl = typeof clearTimeout === "function" ? clearTimeout : null,
} = {}) {
  const waitMs = Math.max(0, Number(delay) || 0);
  if (!documentRef?.addEventListener) {
    return new Promise((resolve) => {
      if (setTimeoutImpl) setTimeoutImpl(() => resolve("timer"), waitMs);
      else resolve("timer");
    });
  }

  return new Promise((resolve) => {
    let timer = null;
    let settled = false;
    const cleanup = () => {
      documentRef.removeEventListener?.("visibilitychange", onVisibilityChange);
      if (timer !== null && clearTimeoutImpl) clearTimeoutImpl(timer);
      timer = null;
    };
    const finish = (reason) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(reason);
    };
    const onVisibilityChange = () => {
      if (pageIsVisible(documentRef)) finish("visible");
      else finish("hidden");
    };
    documentRef.addEventListener("visibilitychange", onVisibilityChange);
    if (!pageIsVisible(documentRef)) return;
    if (setTimeoutImpl) timer = setTimeoutImpl(() => finish("timer"), waitMs);
    else finish("timer");
  });
}

/**
 * Gate periodic work on page visibility and on the caller's current state.
 * The visibility event performs one immediate refresh, so a hidden tab catches
 * up without a burst of stale interval callbacks when it becomes visible.
 */
export function createVisibilityScheduler({
  documentRef = typeof document === "undefined" ? null : document,
  pollInterval = 5_000,
  tickInterval = 1_000,
  onPoll = () => {},
  onTick = () => {},
  onVisible = () => {},
  onHidden = () => {},
  shouldPoll = () => true,
  shouldTick = () => true,
  setIntervalImpl = typeof setInterval === "function" ? setInterval : null,
  clearIntervalImpl = typeof clearInterval === "function" ? clearInterval : null,
} = {}) {
  let pollTimer = null;
  let tickTimer = null;
  let started = false;
  let wasVisible = pageIsVisible(documentRef);

  const clearTimers = () => {
    if (clearIntervalImpl) {
      if (pollTimer !== null) clearIntervalImpl(pollTimer);
      if (tickTimer !== null) clearIntervalImpl(tickTimer);
    }
    pollTimer = null;
    tickTimer = null;
  };
  const startTimers = () => {
    if (!started || !pageIsVisible(documentRef) || !setIntervalImpl) return;
    if (pollTimer === null) pollTimer = setIntervalImpl(poll, pollInterval);
    if (tickTimer === null) tickTimer = setIntervalImpl(tick, tickInterval);
  };

  const poll = () => {
    if (pageIsVisible(documentRef) && shouldPoll()) onPoll();
  };
  const tick = () => {
    if (pageIsVisible(documentRef) && shouldTick()) onTick();
  };
  const onVisibilityChange = () => {
    const visible = pageIsVisible(documentRef);
    if (visible === wasVisible) return;
    wasVisible = visible;
    if (!visible) {
      clearTimers();
      onHidden();
      return;
    }
    startTimers();
    poll();
    tick();
    onVisible();
  };

  return {
    start() {
      if (started) return;
      started = true;
      wasVisible = pageIsVisible(documentRef);
      documentRef?.addEventListener?.("visibilitychange", onVisibilityChange);
      startTimers();
    },
    stop() {
      if (!started) return;
      started = false;
      documentRef?.removeEventListener?.("visibilitychange", onVisibilityChange);
      clearTimers();
      wasVisible = pageIsVisible(documentRef);
    },
    poll,
    tick,
    get started() { return started; },
  };
}

function computedOverflowY(root, windowRef) {
  const computed = windowRef?.getComputedStyle?.(root)?.overflowY;
  return computed || root?.style?.overflowY || "";
}

/**
 * Desktop uses an internal scrolling panel.  On narrow layouts the panel is
 * intentionally overflow-visible and the document is the scroll container.
 */
export function resolveFeedScrollTarget(root, windowRef = typeof window === "undefined" ? null : window) {
  if (!root) return windowRef;
  const overflowY = computedOverflowY(root, windowRef);
  const hasInternalOverflow = Number(root.scrollHeight) > Number(root.clientHeight);
  if (overflowY && !["visible", "clip"].includes(overflowY) && (hasInternalOverflow || overflowY === "scroll" || overflowY === "auto")) return root;
  return windowRef || root;
}

function viewportBottom(target, root, windowRef, documentRef) {
  if (target === root && root?.getBoundingClientRect) return root.getBoundingClientRect().bottom;
  return Number(windowRef?.innerHeight)
    || Number(documentRef?.documentElement?.clientHeight)
    || 0;
}

/**
 * Fallback for browsers without IntersectionObserver and for markup that is
 * temporarily missing its sentinel.  It listens to exactly one scroll root,
 * coalesces events, and asks the caller for one page at a time near the end.
 */
export function createScrollLoadTrigger({
  sentinel,
  root,
  windowRef = typeof window === "undefined" ? null : window,
  documentRef = typeof document === "undefined" ? null : document,
  margin = 360,
  canLoadMore = () => true,
  onNearEnd = () => {},
  frameRequest = null,
  frameCancel = null,
} = {}) {
  let target = null;
  let frame = null;
  let started = false;

  const requestFrame = frameRequest
    || (typeof windowRef?.requestAnimationFrame === "function"
      ? (callback) => windowRef.requestAnimationFrame(callback)
      : (callback) => setTimeout(callback, 0));
  const cancelFrame = frameCancel
    || (typeof windowRef?.cancelAnimationFrame === "function"
      ? (handle) => windowRef.cancelAnimationFrame(handle)
      : (handle) => clearTimeout(handle));

  const check = () => {
    frame = null;
    if (!started || !sentinel || !canLoadMore()) return false;
    const bottom = viewportBottom(target, root, windowRef, documentRef);
    const top = sentinel.getBoundingClientRect?.().top;
    if (!Number.isFinite(top) || top <= bottom + margin) {
      onNearEnd();
      return true;
    }
    return false;
  };
  const schedule = () => {
    if (!started || frame !== null) return;
    frame = requestFrame(check);
  };

  return {
    start() {
      if (started) return;
      started = true;
      target = resolveFeedScrollTarget(root, windowRef);
      target?.addEventListener?.("scroll", schedule, { passive: true });
      windowRef?.addEventListener?.("resize", schedule, { passive: true });
      schedule();
    },
    stop() {
      if (!started) return;
      started = false;
      target?.removeEventListener?.("scroll", schedule);
      windowRef?.removeEventListener?.("resize", schedule);
      if (frame !== null) cancelFrame(frame);
      frame = null;
      target = null;
    },
    check,
    schedule,
    get scrollTarget() { return target; },
    get started() { return started; },
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Calculate a bounded render window while retaining all feed data in memory.
 * Measured row heights override the estimate, which keeps wrapped mobile rows
 * and expanded desktop rows addressable without assuming a fixed card height.
 * If focus is outside the contiguous window, the result exposes a pinned
 * index so the caller can retain that one node without widening the window.
 */
export function createVirtualWindow({
  itemCount = 0,
  estimatedItemHeight = 148,
  overscan = 6,
  maxRendered = 120,
} = {}) {
  let count = Math.max(0, Math.floor(Number(itemCount) || 0));
  let estimate = Math.max(1, Number(estimatedItemHeight) || 1);
  let extra = new Map();
  let deltaTree = [];
  const overscanItems = Math.max(0, Math.floor(Number(overscan) || 0));
  const maxWindow = Math.max(1, Math.floor(Number(maxRendered) || 1));

  const rebuildDeltaTree = () => {
    deltaTree = Array(count + 1).fill(0);
    for (const [index, height] of extra) {
      let cursor = index + 1;
      const delta = height - estimate;
      while (cursor < deltaTree.length) {
        deltaTree[cursor] += delta;
        cursor += cursor & -cursor;
      }
    }
  };
  const addDelta = (index, delta) => {
    let cursor = index + 1;
    while (cursor < deltaTree.length) {
      deltaTree[cursor] += delta;
      cursor += cursor & -cursor;
    }
  };
  const prefixDelta = (exclusiveIndex) => {
    let cursor = Math.min(count, Math.max(0, exclusiveIndex));
    let total = 0;
    while (cursor > 0) {
      total += deltaTree[cursor] || 0;
      cursor -= cursor & -cursor;
    }
    return total;
  };
  rebuildDeltaTree();

  const offsetFor = (index) => {
    const safeIndex = clamp(Math.floor(Number(index) || 0), 0, count);
    return Math.max(0, safeIndex * estimate + prefixDelta(safeIndex));
  };
  const totalHeight = () => offsetFor(count);
  const indexAtOffset = (offset) => {
    const target = clamp(Number(offset) || 0, 0, totalHeight());
    let low = 0;
    let high = count;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (offsetFor(middle + 1) <= target) low = middle + 1;
      else high = middle;
    }
    return clamp(low, 0, Math.max(0, count - 1));
  };

  const setItemCount = (nextCount) => {
    count = Math.max(0, Math.floor(Number(nextCount) || 0));
    extra = new Map([...extra].filter(([index]) => index < count));
    rebuildDeltaTree();
  };
  const measure = (index, height) => {
    const safeIndex = Math.floor(Number(index));
    const safeHeight = Number(height);
    if (safeIndex < 0 || safeIndex >= count || !Number.isFinite(safeHeight) || safeHeight <= 0) return false;
    const previousHeight = extra.get(safeIndex) ?? estimate;
    if (Math.abs(previousHeight - safeHeight) < 0.5) return false;
    extra.set(safeIndex, safeHeight);
    addDelta(safeIndex, safeHeight - previousHeight);
    return true;
  };
  const range = ({ scrollTop = 0, viewportHeight = 0, focusedIndex = null } = {}) => {
    if (!count) return { start: 0, end: 0, before: 0, after: 0, total: 0, indices: [], pinnedIndex: null };
    const firstVisible = indexAtOffset(Math.max(0, Number(scrollTop) || 0));
    const endOffset = Math.max(Number(scrollTop) || 0, Number(scrollTop) + Math.max(0, Number(viewportHeight) || 0));
    const lastVisible = indexAtOffset(endOffset);
    const visibleCount = Math.max(1, lastVisible - firstVisible + 1);
    const requestedStart = Math.max(0, firstVisible - overscanItems);
    const requestedEnd = Math.min(count, lastVisible + 1 + overscanItems);
    let start = requestedStart;
    let end = requestedEnd;
    let pinnedIndex = null;
    if (end - start > maxWindow) {
      const centeredStart = firstVisible - Math.floor((maxWindow - visibleCount) / 2);
      start = clamp(centeredStart, 0, Math.max(0, count - maxWindow));
      end = Math.min(count, start + maxWindow);
    }
    if (Number.isInteger(focusedIndex) && focusedIndex >= 0 && focusedIndex < count
      && (focusedIndex < start || focusedIndex >= end)) {
      // Do not widen a contiguous window across thousands of rows. The caller
      // can keep this one focused node pinned or hand focus to the list root
      // before recycling it; either choice preserves the hard bound.
      pinnedIndex = focusedIndex;
    }
    const before = offsetFor(start);
    const after = Math.max(0, totalHeight() - offsetFor(end));
    return {
      start,
      end,
      before,
      after,
      total: totalHeight(),
      indices: Array.from({ length: end - start }, (_, index) => start + index),
      pinnedIndex,
    };
  };

  return {
    setItemCount,
    measure,
    range,
    offsetFor,
    indexAtOffset,
    get itemCount() { return count; },
    get totalHeight() { return totalHeight(); },
    get estimatedItemHeight() { return estimate; },
    set estimatedItemHeight(value) {
      const nextEstimate = Math.max(1, Number(value) || estimate);
      if (nextEstimate === estimate) return;
      estimate = nextEstimate;
      rebuildDeltaTree();
    },
  };
}
