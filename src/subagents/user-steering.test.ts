import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BackgroundCalls, type BackgroundMessageMode } from "./background.ts";
import { WorkerBoard } from "./worker-board.ts";
import { USER_STEER, UserSteering, userSteeringNote } from "./user-steering.ts";

// User steering (bean mj35) on a real board and real background calls, with
// a fake pi that records what the orchestrator's session is sent.

function setup() {
  const sent: { message: Parameters<ExtensionAPI["sendMessage"]>[0]; options: Parameters<ExtensionAPI["sendMessage"]>[1] }[] = [];
  const pi = { sendMessage: (message: never, options: never) => { sent.push({ message, options }); } } as unknown as Pick<ExtensionAPI, "sendMessage">;
  const calls = new BackgroundCalls(() => {});
  const board = new WorkerBoard();
  const received: { text: string; mode: BackgroundMessageMode }[] = [];
  const progress: { task: string; status: "queued" | "running" }[] = [{ task: "Background", status: "running" }, { task: "Queued", status: "queued" }];
  calls.start({ callId: "call-1", progress: progress as never, delegationIds: ["d1", "d2"] });
  calls.registerWorker("d1", async (text, mode) => { received.push({ text, mode }); });
  const background = board.add({ callId: "call-1", background: true, task: "Background", label: "research: lockfile", delegationId: "d1", model: { kind: "routed" } });
  background.started();
  board.add({ callId: "call-1", background: true, task: "Queued", delegationId: "d2", model: { kind: "routed" } });
  const foreground = board.add({ callId: "call-2", background: false, task: "Foreground", model: { kind: "routed" } });
  foreground.started();
  return { steering: new UserSteering(pi, calls, board), calls, board, sent, received, background };
}

test("only a running background worker takes the user's messages: not a queued, foreground or finished one", () => {
  const { steering, board, background } = setup();
  const [running, queued, foreground] = board.workers();
  assert.deepEqual([running, queued, foreground].map((worker) => steering.accepts(worker!)), [true, false, false]);
  background.ended({ state: "completed" });
  assert.equal(steering.accepts(board.worker(running!.id)!), false);
});

test("a user steer reaches the worker as subagents_message's does, tells the orchestrator without a turn, and is kept for its Result", async () => {
  const { steering, board, sent, received } = setup();
  const worker = board.workers()[0]!;
  await steering.send(worker, "Check the lockfile", "steer");
  await steering.send(worker, "Then run the tests", "followUp");
  assert.deepEqual(received, [{ text: "Check the lockfile", mode: "steer" }, { text: "Then run the tests", mode: "followUp" }]);
  assert.deepEqual(sent.map(({ message, options }) => [message.customType, message.content, options]), [
    [USER_STEER, 'The user steered worker d1 (research: lockfile) directly: "Check the lockfile" (mode steer)', { triggerTurn: false }],
    [USER_STEER, 'The user steered worker d1 (research: lockfile) directly: "Then run the tests" (mode followUp)', { triggerTurn: false }],
  ]);
  assert.deepEqual(steering.steers(worker.id), [{ text: "Check the lockfile", mode: "steer", answer: false }, { text: "Then run the tests", mode: "followUp", answer: false }]);
  assert.equal(steering.sentByUser(worker, "Check the lockfile"), true);
  assert.equal(steering.sentByUser(worker, "From the orchestrator"), false);
  await assert.rejects(steering.send(board.workers()[1]!, "Too early", "steer"), /no running background worker has the delegation id d2/);
  assert.equal(sent.length, 2, "a refused message tells the orchestrator nothing");
});

test("the user's message to an asking worker answers its question, and the orchestrator hears it as an answer", async () => {
  const { steering, calls, board, sent, received } = setup();
  const answer = calls.question("d1", undefined);
  await steering.send(board.workers()[0]!, "Use config.json", "steer");
  assert.equal(await answer, "Use config.json");
  assert.deepEqual(received, [], "the answer goes to the question, not into the session");
  assert.equal(sent[0]?.message.content, 'The user answered the question of worker d1 (research: lockfile) directly: "Use config.json"');
  assert.equal(userSteeringNote(steering.steers(board.workers()[0]!.id)),
    'User steering: the user messaged this worker directly from its transcript view. These came from the user, not from you:\n- answer to its question: "Use config.json"');
});
