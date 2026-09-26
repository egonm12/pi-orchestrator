import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { publishServedRung } from "../router/served-rungs.ts";
import { elapsedMs, WorkerBoard, workerBoard, type BoardWorker, type WorkerSession } from "./worker-board.ts";

// The worker board's own seam: the feed the subagents extension writes into
// and the read side later views use. The subagents extension's tests show real
// workers reaching it (extension.test.ts); here the worker sessions are fakes
// that emit pi's session events, and the clock is a counter.

function clock(start = 1_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

/** A worker session as runWorker hands it over: its ids and an event stream a test drives. */
function fakeSession(sessionId: string, sessionFile: string | undefined = `/sessions/${sessionId}.jsonl`) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: WorkerSession = {
    sessionId, sessionFile, effort: "medium", messages: () => [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { session, emit: (event: object) => { for (const listener of listeners) listener(event as AgentSessionEvent); }, listeners };
}

const shape = (workers: readonly BoardWorker[]) => workers.map((worker) => ({ task: worker.task, parent: worker.parentDelegationId, state: worker.state }));

test("foreground, background and nested workers appear, each nested worker right after its parent", () => {
  const board = new WorkerBoard();
  const lead = board.add({ callId: "call-1", background: false, task: "Lead the work", agent: "lead", model: { kind: "routed" } });
  const other = board.add({ callId: "call-1", background: false, task: "Other foreground item", model: { kind: "routed" } });
  const background = board.add({ callId: "call-2", background: true, task: "Background item", delegationId: "bg-1", model: { kind: "routed" } });
  lead.started();
  lead.session(fakeSession("lead-1").session);
  const nested = board.add({ callId: "nested-call", background: false, task: "Nested item", parentDelegationId: "lead-1", model: { kind: "routed" } });

  assert.deepEqual(shape(board.workers()), [
    { task: "Lead the work", parent: undefined, state: "running" },
    { task: "Nested item", parent: "lead-1", state: "queued" },
    { task: "Other foreground item", parent: undefined, state: "queued" },
    { task: "Background item", parent: undefined, state: "queued" },
  ]);
  const nestedWorker = board.worker(nested.id)!;
  assert.equal(nestedWorker.parentId, lead.id);
  assert.equal(nestedWorker.background, false);
  assert.equal(board.worker(background.id)!.background, true);
  assert.equal(board.worker(background.id)!.delegationId, "bg-1");
  assert.equal(board.worker(lead.id)!.delegationId, "lead-1");
  assert.equal(board.worker(lead.id)!.agent, "lead");
  assert.equal(board.worker(lead.id)!.sessionFile, "/sessions/lead-1.jsonl");
  assert.equal(board.byDelegation("lead-1")?.id, lead.id);
  assert.equal(board.worker(other.id)!.callId, "call-1");
});

test("a worker moves from queued to running, a background worker to asking and back, and each ends in its end state with when it ended", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const completes = board.add({ callId: "call", background: true, task: "Completes", delegationId: "bg-1", model: { kind: "routed" } });
  const fails = board.add({ callId: "call", background: false, task: "Fails", model: { kind: "routed" } });
  const aborts = board.add({ callId: "call", background: false, task: "Aborted while running", model: { kind: "routed" } });
  const neverStarts = board.add({ callId: "call", background: false, task: "Aborted while queued", model: { kind: "routed" } });
  const state = (id: string) => board.worker(id)!.state;
  assert.equal(state(completes.id), "queued");
  assert.equal(board.worker(completes.id)!.startedAt, undefined);

  time.advance(500);
  completes.started();
  completes.session(fakeSession("bg-1").session);
  assert.equal(state(completes.id), "running");
  assert.equal(board.worker(completes.id)!.startedAt, 1_500);
  board.asking("bg-1", true);
  assert.equal(state(completes.id), "asking");
  board.asking("bg-1", false);
  assert.equal(state(completes.id), "running");
  time.advance(2_000);
  completes.ended({ state: "completed", sessionFile: "/sessions/bg-1.jsonl" });
  assert.equal(state(completes.id), "completed");
  assert.equal(board.worker(completes.id)!.endedAt, 3_500);
  assert.equal(elapsedMs(board.worker(completes.id)!, 99_999), 2_000, "a finished worker's elapsed time stops at its end");

  fails.started();
  fails.session(fakeSession("fg-1").session);
  board.asking("fg-1", true);
  assert.equal(state(fails.id), "running", "only a background worker can be asking");
  fails.ended({ state: "failed", error: "the worker's model call failed" });
  assert.equal(state(fails.id), "failed");
  assert.equal(board.worker(fails.id)!.error, "the worker's model call failed");

  aborts.started();
  time.advance(100);
  assert.equal(elapsedMs(board.worker(aborts.id)!, time.now()), 100, "a running worker's elapsed time runs on");
  aborts.ended({ state: "aborted" });
  neverStarts.ended({ state: "aborted" });
  assert.equal(state(aborts.id), "aborted");
  assert.equal(state(neverStarts.id), "aborted");
  assert.equal(elapsedMs(board.worker(neverStarts.id)!, time.now()), undefined, "a worker that never started has no elapsed time");

  assert.deepEqual(board.workers().map((worker) => worker.state), ["completed", "failed", "aborted", "aborted"], "finished workers stay on the board");
});

test("a routed worker is routing until its first request, then shows each rung that served it, escalation included; forks and preserved models stay fixed", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const routed = board.add({ callId: "call", background: false, task: "Routed", model: { kind: "routed" } });
  const fork = board.add({ callId: "call", background: false, task: "Fork", model: { kind: "fork", model: "anthropic/claude-opus-5", effort: "high" } });
  const preserved = board.add({ callId: "call", background: false, task: "Preserved", agent: "scout", model: { kind: "preserved", model: "anthropic/claude-haiku-4-5" } });
  const resumed = board.add({ callId: "call", background: false, task: "Resumed", delegationId: "old-1",
    model: { kind: "routed", pin: { model: "anthropic/claude-haiku-4-5", effort: "low" } } });
  routed.started();
  routed.session(fakeSession("routed-1").session);
  assert.deepEqual(board.worker(routed.id)!.model, { kind: "routing" }, "routing before the first request");

  time.advance(10);
  board.served({ delegationId: "routed-1", model: "anthropic/claude-sonnet-5", effort: "medium", escalation: { from: "mechanical", to: "standard" } });
  board.served({ delegationId: "routed-1", model: "anthropic/claude-sonnet-5", effort: "medium", escalation: { from: "mechanical", to: "standard" } });
  board.served({ delegationId: "compaction-summary", model: "anthropic/claude-haiku-4-5", effort: "low" });
  time.advance(10);
  board.served({ delegationId: "routed-1", model: "anthropic/claude-opus-5", effort: "high" });
  assert.deepEqual(board.worker(routed.id)!.model, { kind: "routed", rungs: [
    { model: "anthropic/claude-sonnet-5", effort: "medium", since: 1_010, escalation: { from: "mechanical", to: "standard" } },
    { model: "anthropic/claude-opus-5", effort: "high", since: 1_020 },
  ] }, "each rung once, in order, the latest last; a request of no worker changes nothing");

  routed.ended({ state: "completed" });
  board.served({ delegationId: "routed-1", model: "anthropic/claude-haiku-4-5", effort: "low" });
  assert.equal((board.worker(routed.id)!.model as { rungs: readonly unknown[] }).rungs.length, 2, "a finished worker's history is closed");

  assert.deepEqual(board.worker(fork.id)!.model, { kind: "fork", model: "anthropic/claude-opus-5", effort: "high" });
  assert.deepEqual(board.worker(preserved.id)!.model, { kind: "preserved", model: "anthropic/claude-haiku-4-5" });
  preserved.started();
  preserved.session(fakeSession("preserved-1").session);
  assert.deepEqual(board.worker(preserved.id)!.model, { kind: "preserved", model: "anthropic/claude-haiku-4-5", effort: "medium" },
    "a definition without a thinking level runs on the session's own effort");
  assert.deepEqual(board.worker(resumed.id)!.model, { kind: "routed", rungs: [{ model: "anthropic/claude-haiku-4-5", effort: "low", since: 1_000 }] },
    "a resumed worker keeps its pin, so it is known before its first request");
});

const usage = (input: number, output: number, cost: number) => ({ input, output, cacheRead: 10, cacheWrite: 5, totalTokens: input + output + 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });
const assistant = (text: string, extra: object = {}) => ({ role: "assistant", content: [{ type: "text", text }], ...extra });

test("turns, tokens, cost and the current tool or latest text follow the worker's session events, and views get a change signal", () => {
  const board = new WorkerBoard();
  const changes: (string | undefined)[] = [];
  const unsubscribe = board.subscribe((worker) => { changes.push(worker?.state); });
  const feed = board.add({ callId: "call", background: false, task: "Busy", model: { kind: "routed" } });
  feed.started();
  const { session, emit, listeners } = fakeSession("busy-1");
  feed.session(session);
  const worker = () => board.worker(feed.id)!;
  assert.deepEqual({ turns: worker().turns, tokens: worker().tokens, cost: worker().cost, text: worker().text, tool: worker().tool },
    { turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, text: "", tool: undefined });

  emit({ type: "turn_start" });
  emit({ type: "message_update", message: assistant("Looking") });
  emit({ type: "message_update", message: assistant("Looking at the config") });
  assert.equal(worker().text, "Looking at the config");
  emit({ type: "message_end", message: assistant("Looking at the config", { usage: usage(100, 20, 0.01) }) });
  emit({ type: "message_end", message: { role: "user", content: "not the worker's reply" } });
  emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
  emit({ type: "tool_execution_start", toolCallId: "t2", toolName: "bash" });
  assert.equal(worker().tool, "bash", "the latest tool still running");
  emit({ type: "tool_execution_end", toolCallId: "t2", toolName: "bash" });
  assert.equal(worker().tool, "read");
  emit({ type: "tool_execution_end", toolCallId: "t1", toolName: "read" });
  assert.equal(worker().tool, undefined);
  emit({ type: "turn_start" });
  emit({ type: "message_end", message: assistant("Done", { usage: usage(200, 30, 0.02) }) });

  assert.equal(worker().turns, 2);
  assert.deepEqual(worker().tokens, { input: 300, output: 50, cacheRead: 20, cacheWrite: 10, total: 380 });
  assert.ok(Math.abs(worker().cost - 0.03) < 1e-12, String(worker().cost));
  assert.equal(worker().text, "Done");

  const signalled = changes.length;
  assert.ok(signalled >= 10, `every change is signalled, got ${signalled}`);
  emit({ type: "message_update", message: assistant("Done") });
  assert.equal(changes.length, signalled, "an event that changes nothing is not signalled");

  feed.ended({ state: "completed" });
  assert.equal(changes.at(-1), "completed");
  assert.equal(listeners.size, 0, "the board lets go of a finished worker's session");
  unsubscribe();
  board.add({ callId: "call", background: false, task: "After", model: { kind: "routed" } });
  assert.equal(changes.at(-1), "completed", "an unsubscribed view gets no more signals");
});

test("a running worker's live session reaches views: its messages and its events as they come", () => {
  const board = new WorkerBoard();
  const feed = board.add({ callId: "call", background: false, task: "Live", model: { kind: "routed" } });
  assert.equal(board.live(feed.id), undefined, "a queued worker has no session yet");
  feed.started();
  const fake = fakeSession("live-1");
  const messages = [assistant("hello")] as unknown as ReturnType<WorkerSession["messages"]>;
  feed.session({ ...fake.session, messages: () => messages });
  const live = board.live(feed.id)!;
  assert.equal(live.messages(), messages);
  const seen: string[] = [];
  const stop = live.subscribe((event) => { seen.push(event.type); });
  fake.emit({ type: "turn_start" });
  stop();
  fake.emit({ type: "turn_end" });
  assert.deepEqual(seen, ["turn_start"]);
  feed.ended({ state: "completed" });
  assert.equal(board.live(feed.id), undefined, "a finished worker's transcript is its session file");
});

test("finished workers stay for the session: the same session keeps its board, a new orchestrator session starts empty", () => {
  const board = new WorkerBoard();
  board.startSession("session-1");
  const feed = board.add({ callId: "call", background: false, task: "First session", model: { kind: "routed" } });
  feed.ended({ state: "completed" });
  board.startSession("session-1");
  assert.equal(board.workers().length, 1, "a reload of the same session keeps its workers");
  const signals: (BoardWorker | undefined)[] = [];
  board.subscribe((worker) => { signals.push(worker); });
  const running = board.add({ callId: "call", background: false, task: "Still running", model: { kind: "routed" } });
  running.started();
  const fake = fakeSession("running-1");
  running.session(fake.session);
  signals.length = 0;
  board.startSession("session-2");
  assert.deepEqual(board.workers(), []);
  assert.deepEqual(signals, [undefined], "views hear that the whole board changed");
  fake.emit({ type: "turn_start" });
  running.ended({ state: "aborted" });
  assert.deepEqual(signals, [undefined], "a worker of the old session no longer signals");
});

test("the process has one board, which hears the rungs the router serves", () => {
  const board = workerBoard();
  assert.equal(workerBoard(), board);
  board.startSession(`board-test-${Date.now()}`);
  const feed = board.add({ callId: "call", background: false, task: "Routed", model: { kind: "routed" } });
  feed.started();
  feed.session(fakeSession("global-1").session);
  publishServedRung({ delegationId: "global-1", model: "anthropic/claude-haiku-4-5", effort: "low" });
  assert.deepEqual((board.worker(feed.id)!.model as { rungs: readonly { model: string }[] }).rungs.map((rung) => rung.model), ["anthropic/claude-haiku-4-5"]);
  feed.ended({ state: "completed" });
});
