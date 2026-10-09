import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWorkerSlot, withoutWorkerSlot, WorkerSlots } from "./worker-slots.ts";

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

test("overlapping waits of one worker give its slot up once and take it back once", async () => {
  const slots = new WorkerSlots(1);
  const dispose = registerWorkerSlot("overlap", slots, (await slots.acquire())!);
  let endFirst!: () => void, endSecond!: () => void;
  const first = withoutWorkerSlot("overlap", undefined, () => new Promise<void>((resolve) => { endFirst = resolve; }));
  const second = withoutWorkerSlot("overlap", undefined, () => new Promise<void>((resolve) => { endSecond = resolve; }));
  assert.equal(slots.running, 0);
  endFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slots.running, 0, "the slot comes back only when the last wait ends");
  endSecond();
  await Promise.all([first, second]);
  assert.equal(slots.running, 1);
  dispose();
  assert.equal(slots.running, 0);
});

test("a lease disposed during a wait takes no slot back when the wait ends", async () => {
  const slots = new WorkerSlots(1);
  const dispose = registerWorkerSlot("disposed", slots, (await slots.acquire())!);
  let end!: () => void;
  const wait = withoutWorkerSlot("disposed", undefined, () => new Promise<void>((resolve) => { end = resolve; }));
  dispose();
  end();
  await wait;
  assert.equal(slots.running, 0);
});

test("a wait that starts while the worker queues to take its slot back holds no slot during that wait", async () => {
  const slots = new WorkerSlots(1);
  const dispose = registerWorkerSlot("staggered", slots, (await slots.acquire())!);
  let endFirst!: () => void, endSecond!: () => void;
  const first = withoutWorkerSlot("staggered", undefined, () => new Promise<void>((resolve) => { endFirst = resolve; }));
  const other = (await slots.acquire())!;
  endFirst();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(slots.queued, 1, "the first wait queues to take the slot back");
  const second = withoutWorkerSlot("staggered", undefined, () => new Promise<void>((resolve) => { endSecond = resolve; }));
  other();
  await first;
  assert.equal(slots.running, 0, "the second wait holds no slot");
  const child = await Promise.race([slots.acquire(), new Promise<undefined>((resolve) => setTimeout(resolve, 200, undefined))]);
  assert.ok(child !== undefined, "a child of the second wait gets the free slot");
  child();
  endSecond();
  await second;
  assert.equal(slots.running, 1, "the worker holds one slot once the last wait ends");
  dispose();
  assert.equal(slots.running, 0);
});
