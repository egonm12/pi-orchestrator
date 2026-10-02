import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerSlots } from "./worker-slots.ts";

test("slots go to waiting workers first come first served as running ones release them", async () => {
  const slots = new WorkerSlots(2);
  const order: string[] = [];
  const take = (name: string) => slots.acquire().then((release) => { order.push(name); return release!; });
  const a = await take("a"), b = await take("b");
  const c = take("c"), d = take("d");
  await Promise.resolve();
  assert.deepEqual(order, ["a", "b"]);
  assert.equal(slots.queued, 2);
  a();
  a();
  const releaseC = await c;
  assert.deepEqual(order, ["a", "b", "c"], "a second release of the same slot frees nothing more");
  assert.equal(slots.running, 2);
  b();
  (await d)();
  releaseC();
  assert.equal(slots.running, 0);
});

test("an aborted wait leaves the queue holding no slot, and a raised limit starts waiting workers", async () => {
  const slots = new WorkerSlots(1);
  const first = (await slots.acquire())!;
  const controller = new AbortController();
  const aborted = slots.acquire(controller.signal);
  const next = slots.acquire();
  controller.abort();
  assert.equal(await aborted, undefined);
  assert.equal(slots.queued, 1);
  assert.equal(await slots.acquire(controller.signal), undefined, "an already aborted signal never waits");
  slots.setLimit(2);
  (await next)!();
  first();
  assert.equal(slots.running, 0);
});
