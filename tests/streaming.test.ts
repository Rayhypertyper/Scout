import { describe, expect, it } from "vitest";

import { BoundedAsyncQueue } from "../src/utils/async.js";

describe("bounded streaming queues", () => {
  it("promotes multiple blocked producers after draining capacity", async () => {
    const queue = new BoundedAsyncQueue<number>(2);
    await queue.push(1);
    await queue.push(2);
    const second = queue.push(3);
    const third = queue.push(4);
    await Promise.resolve();
    expect(queue.size).toBe(2);
    expect(await queue.drain()).toEqual([1, 2]);
    await Promise.all([second, third]);
    expect(await queue.pop()).toBe(3);
    expect(await queue.pop()).toBe(4);
  });

  it("closes waiting consumers without leaving worker promises blocked", async () => {
    const queue = new BoundedAsyncQueue<string>(2);
    const consumer = queue.pop();
    queue.close();
    await expect(consumer).resolves.toBeUndefined();
    await expect(queue.pop()).resolves.toBeUndefined();
  });

  it("rejects blocked producers with an Error on cancellation", async () => {
    const queue = new BoundedAsyncQueue<number>(1);
    await queue.push(1);
    const blocked = queue.push(2);
    queue.cancel("cancelled by test");
    await expect(blocked).rejects.toThrow("cancelled by test");
  });

  it("rejects waiting consumers when the owning source is aborted", async () => {
    const controller = new AbortController();
    const queue = new BoundedAsyncQueue<number>(1, undefined, controller.signal);
    const waiting = queue.pop();
    controller.abort(new Error("source timed out"));
    await expect(waiting).rejects.toThrow("source timed out");
  });
});
