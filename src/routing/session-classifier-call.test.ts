import { getEventListeners } from "node:events";
import assert from "node:assert/strict";
import { test } from "node:test";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import {
  answerEvents,
  assistantMessage,
  errorEvents,
  fakeSessionRegistry,
  type StreamScript,
} from "../fixtures/session-model-registry.ts";
import type { RegistryModel } from "../types/pi-extension.ts";
import { CLASSIFIER_SYSTEM_PROMPT } from "./classifier-reply.ts";
import { sessionClassifierModelCall, type SessionClassifierCallReport } from "./session-classifier-call.ts";
import {
  CLASSIFIER_MAX_OUTPUT_TOKENS,
  classifyTier,
  loadClassifierChain,
  ProviderOutOfUsageError,
  type HopOutcomeKind,
  type TierClassification,
} from "./tier-classifier.ts";

// Seam 1 of the in-session classifier call: a fake of pi's session model
// registry (`find`, and `streamSimple` playing a scripted event stream) drives
// the call, alone and through `classifyTier`, so the hop outcomes the fallback
// chain records are asserted the same way as for any other model call.

const HAIKU = "anthropic/claude-haiku-4-5";
const HAIKU_LOW = `${HAIKU}:low`;
const TASK = "Add a CSV export button to the reports page and wire it to the existing export service.";

function answer(tier: string): string {
  return JSON.stringify({
    tier,
    risk: { level: "none", reasons: [] },
    ambiguity: "clear",
    complexity: "medium",
    kindOfWork: "implement",
    why: `fake says ${tier}`,
  });
}

function allowance() {
  const catalog = buildCatalog({ modelIds: [HAIKU] });
  return { owner: new TaskAllowanceOwner(newTaskLedger({ taskId: "in-session-classifier" })), catalog };
}

async function classifyWith(scripts: readonly StreamScript[], timeoutMs = 5_000) {
  const registry = fakeSessionRegistry(scripts);
  const budget = allowance();
  const record: TierClassification = await classifyTier(
    { task: TASK, role: "worker", paths: [] },
    {
      chain: loadClassifierChain({ model: HAIKU_LOW, timeoutMs, fallback: [] }),
      callModel: sessionClassifierModelCall(registry),
      allowance: budget,
    },
  );
  return { record, registry, budget };
}

function hopOutcomes(record: TierClassification): [string, HopOutcomeKind][] {
  return record.hops.map((hop) => [hop.hop, hop.outcome]);
}

// ---------------------------------------------------------------------------
// The happy path, the request and the reply
// ---------------------------------------------------------------------------

test("the session call streams one request through the registry with the classifier's system prompt, the prompt, no tools, the output limit and the rung's effort", async () => {
  const registry = fakeSessionRegistry([{ events: answerEvents(answer("standard")) }]);
  const controller = new AbortController();
  await sessionClassifierModelCall(registry)("the prompt", HAIKU_LOW, controller.signal);

  assert.deepEqual(registry.finds, [["anthropic", "claude-haiku-4-5"]]);
  assert.equal(registry.calls.length, 1);
  const [call] = registry.calls;
  assert.equal(call?.model.id, "claude-haiku-4-5");
  assert.equal(call?.context.systemPrompt, CLASSIFIER_SYSTEM_PROMPT);
  assert.deepEqual(call?.context.messages.map((message) => [message.role, message.content]), [["user", "the prompt"]]);
  assert.deepEqual(Object.keys(call?.context ?? {}).sort(), ["messages", "systemPrompt"], "no tools in the context");
  assert.equal(call?.options?.maxTokens, CLASSIFIER_MAX_OUTPUT_TOKENS);
  assert.equal(call?.options?.reasoning, "low");
  assert.equal(call?.options?.signal, controller.signal);
});

test("the session call returns the final text, pi's reported cost and the usage without the cost", async () => {
  const usage = { input: 900, output: 80, cacheRead: 10, cacheWrite: 5, totalTokens: 995, cost: { total: 0.0012 } };
  const registry = fakeSessionRegistry([{ events: answerEvents(answer("standard"), { usage }) }]);
  const reply = await sessionClassifierModelCall(registry)("p", HAIKU_LOW, new AbortController().signal);
  assert.deepEqual(reply, {
    text: answer("standard"),
    reportedUsd: 0.0012,
    usage: { input: 900, output: 80, cacheRead: 10, cacheWrite: 5, totalTokens: 995 },
  });
});

test("through classifyTier, a streamed answer decides the hop and settles the allowance with the reported cost", async () => {
  const usage = { input: 900, output: 80, cacheRead: 0, cacheWrite: 0, totalTokens: 980, cost: { total: 0.0021 } };
  const { record, budget } = await classifyWith([{ events: answerEvents(answer("standard"), { usage }) }]);
  assert.equal(record.cause, `model:${HAIKU_LOW}`);
  assert.equal(record.tier, "standard");
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "decided"]]);
  assert.equal(record.hops[0]?.allowance?.settlement, "settled");
  const ledger = budget.owner.snapshot();
  assert.deepEqual(ledger.settled.map((charge) => [charge.label, charge.model, charge.reportedUsd]), [["classifier", HAIKU, 0.0021]]);
  assert.equal(ledger.open.length, 0);
});

// ---------------------------------------------------------------------------
// The thinking level: pi's `--thinking` clamp, then `off` sends no reasoning
// ---------------------------------------------------------------------------

async function reasoningFor(rung: string, models?: readonly RegistryModel[]) {
  const registry = fakeSessionRegistry([{ events: answerEvents(answer("standard")) }], models);
  await sessionClassifierModelCall(registry)("p", rung, new AbortController().signal);
  const options = registry.calls[0]?.options ?? {};
  return "reasoning" in options ? options.reasoning : "absent";
}

test("the rung's effort maps to pi's reasoning option as `pi --thinking` clamps it", async () => {
  const noMap: RegistryModel = { provider: "anthropic", id: "no-map", reasoning: true };
  const noReasoning: RegistryModel = { provider: "anthropic", id: "plain", reasoning: false };
  const withMax: RegistryModel = { provider: "anthropic", id: "with-max", reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } };
  const noOff: RegistryModel = { provider: "anthropic", id: "no-off", reasoning: true, thinkingLevelMap: { off: null } };
  const models = [noMap, noReasoning, withMax, noOff];
  assert.equal(await reasoningFor("anthropic/no-map:low", models), "low");
  assert.equal(await reasoningFor("anthropic/no-map:minimal", models), "minimal");
  assert.equal(await reasoningFor("anthropic/no-map:off", models), "absent", "off sends no reasoning");
  assert.equal(await reasoningFor("anthropic/plain:high", models), "absent", "a model without reasoning runs with thinking off");
  assert.equal(await reasoningFor("anthropic/no-map:xhigh", models), "high", "xhigh is clamped down to the highest supported level");
  assert.equal(await reasoningFor("anthropic/with-max:max", models), "max");
  assert.equal(await reasoningFor("anthropic/no-off:off", models), "minimal", "off is clamped up when the model cannot turn thinking off");
});

// ---------------------------------------------------------------------------
// Error mapping: the same outcomes as the subprocess call
// ---------------------------------------------------------------------------

test("a provider out of usage is a ProviderOutOfUsageError and the hop is out-of-usage", async () => {
  const registry = fakeSessionRegistry([{ events: errorEvents("You're out of extra usage.") }]);
  await assert.rejects(
    sessionClassifierModelCall(registry)("p", HAIKU_LOW, new AbortController().signal),
    (error: unknown) => error instanceof ProviderOutOfUsageError && /pi classifier call ended with error: You're out of extra usage\./.test(error.message),
  );
  const { record, budget } = await classifyWith([{ events: errorEvents("You're out of extra usage.") }]);
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "out-of-usage"], ["keywords", "decided"]]);
  assert.equal(record.cause, "keywords");
  assert.equal(budget.owner.snapshot().open.length, 0, "the failed hop's reservation is settled");
});

test("a throttle (429 rate_limit_error) is out-of-usage, as the subprocess call maps it", async () => {
  const throttled = '429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed the rate limit"}}';
  const { record } = await classifyWith([{ events: errorEvents(throttled) }]);
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "out-of-usage"], ["keywords", "decided"]]);
});

test("a provider refusal that is not about usage is an error hop, not out-of-usage", async () => {
  const refusal = '400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long"}}';
  const registry = fakeSessionRegistry([{ events: errorEvents(refusal) }]);
  await assert.rejects(
    sessionClassifierModelCall(registry)("p", HAIKU_LOW, new AbortController().signal),
    (error: unknown) => error instanceof Error && !(error instanceof ProviderOutOfUsageError) && /prompt is too long/.test(error.message),
  );
  const { record } = await classifyWith([{ events: errorEvents(refusal) }]);
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "error"], ["keywords", "decided"]]);
  assert.match(record.hops[0]?.detail ?? "", /pi classifier call ended with error: .*prompt is too long/);
});

test("an unparseable reply is schema-invalid, and a reply with only thinking is too", async () => {
  const nonsense = await classifyWith([{ events: answerEvents("I would say this is a standard task.") }]);
  assert.deepEqual(hopOutcomes(nonsense.record), [[HAIKU_LOW, "schema-invalid"], ["keywords", "decided"]]);
  const thinkingOnly = await classifyWith([{
    events: [{ type: "done", reason: "stop", message: assistantMessage({ content: [{ type: "thinking", thinking: "standard" }] }) }],
  }]);
  assert.deepEqual(hopOutcomes(thinkingOnly.record), [[HAIKU_LOW, "schema-invalid"], ["keywords", "decided"]]);
});

test("missing auth, reported as pi reports it (an error event), is an error hop, not out-of-usage", async () => {
  // pi 0.87.1 wraps request setup, auth included, in pi-ai's `lazyStream`, so a
  // missing API key ends the stream with an `error` event, never a throw.
  const noAuth = 'No API key found for "anthropic"';
  const registry = fakeSessionRegistry([{ events: errorEvents(noAuth) }]);
  await assert.rejects(
    sessionClassifierModelCall(registry)("p", HAIKU_LOW, new AbortController().signal),
    (error: unknown) => error instanceof Error && !(error instanceof ProviderOutOfUsageError) && /No API key found for "anthropic"/.test(error.message),
  );
  const { record } = await classifyWith([{ events: errorEvents(noAuth) }]);
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "error"], ["keywords", "decided"]]);
  assert.match(record.hops[0]?.detail ?? "", /pi classifier call ended with error: No API key found for "anthropic"/);
});

test("a synchronous throw from streamSimple (defensive), a model the registry lacks and a stream with no final message are error hops", async () => {
  const thrown = await classifyWith([{ throws: "streamSimple threw before returning a stream" }]);
  assert.deepEqual(hopOutcomes(thrown.record), [[HAIKU_LOW, "error"], ["keywords", "decided"]]);
  assert.match(thrown.record.hops[0]?.detail ?? "", /streamSimple threw before returning a stream/);

  const registry = fakeSessionRegistry([], []);
  await assert.rejects(
    sessionClassifierModelCall(registry)("p", HAIKU_LOW, new AbortController().signal),
    /pi's model registry has no anthropic\/claude-haiku-4-5/,
  );
  assert.equal(registry.calls.length, 0, "nothing is streamed for a model the registry lacks");

  const unfinished = await classifyWith([{ events: [{ type: "start" }, { type: "text_delta", delta: "{" }] }]);
  assert.deepEqual(hopOutcomes(unfinished.record), [[HAIKU_LOW, "error"], ["keywords", "decided"]]);
  assert.match(unfinished.record.hops[0]?.detail ?? "", /no final assistant message/);
});

// ---------------------------------------------------------------------------
// The timeout aborts the stream
// ---------------------------------------------------------------------------

test("the hop's timeout aborts the stream's signal and the hop is a timeout", async () => {
  const started = performance.now();
  const { record, registry, budget } = await classifyWith([{ hangUntilAborted: true }], 50);
  assert.ok(performance.now() - started < 2_000, "the hop did not wait for the stream");
  assert.deepEqual(hopOutcomes(record), [[HAIKU_LOW, "timeout"], ["keywords", "decided"]]);
  const signal = registry.calls[0]?.options?.signal;
  assert.ok(signal, "the stream was given the hop's signal");
  assert.equal(signal.aborted, true, "the stream's signal was aborted");
  assert.equal(budget.owner.snapshot().open.length, 0);
});

test("the call returns as soon as its signal aborts, even if the stream never ends", async () => {
  const neverEnds: AsyncIterable<never> = { [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }) };
  const registry = fakeSessionRegistry([]);
  const call = sessionClassifierModelCall({ ...registry, streamSimple: () => neverEnds });
  const controller = new AbortController();
  const pending = call("p", HAIKU_LOW, controller.signal);
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, /pi classifier call aborted/);
});

// ---------------------------------------------------------------------------
// The report: time to first token and total, for the router's probe line
// ---------------------------------------------------------------------------

test("the call reports time to first token, total time and the reply, or the error", async () => {
  const reports: SessionClassifierCallReport[] = [];
  let clock = 1_000;
  const tick = () => (clock += 100);
  const events = answerEvents(answer("standard"));
  const timed = (async function* () {
    for (const event of events) {
      tick();
      yield event;
    }
  })();
  const registry = fakeSessionRegistry([]);
  const call = sessionClassifierModelCall(
    { ...registry, streamSimple: () => timed },
    { now: () => clock, onCallEnd: (report) => reports.push(report) },
  );
  await call("p", HAIKU_LOW, new AbortController().signal);
  // start at +100, thinking_delta at +200 (first token), text_delta, done at +400.
  assert.equal(reports.length, 1);
  assert.equal(reports[0]?.rung, HAIKU_LOW);
  assert.equal(reports[0]?.firstTokenMs, 200);
  assert.equal(reports[0]?.totalMs, 400);
  assert.equal(reports[0]?.reply?.text, answer("standard"));

  const failing = sessionClassifierModelCall(fakeSessionRegistry([{ events: errorEvents("socket hang up") }]), { onCallEnd: (report) => reports.push(report) });
  await assert.rejects(failing("p", HAIKU_LOW, new AbortController().signal));
  assert.match(reports[1]?.error ?? "", /socket hang up/);
  assert.equal(reports[1]?.reply, undefined);
});

test("aborted calls close consumers promptly and never inspect or request late events", { timeout: 2000 }, async () => {
  for (const close of ["hang", "reject", "throw"] as const) {
    for (let repeat = 0; repeat < 8; repeat++) {
      let nextCalls = 0;
      let returns = 0;
      let reads = 0;
      let settle!: (value: IteratorResult<import("../types/pi-extension.ts").AssistantMessageEvent>) => void;
      const controller = new AbortController();
      const stream = { [Symbol.asyncIterator]: () => ({
        next() { nextCalls++; return new Promise<IteratorResult<import("../types/pi-extension.ts").AssistantMessageEvent>>((resolve) => { settle = resolve; }); },
        return(): Promise<IteratorResult<import("../types/pi-extension.ts").AssistantMessageEvent>> {
          returns++;
          if (close === "throw") throw new Error("close failed");
          return close === "reject" ? Promise.reject(new Error("close failed")) : new Promise(() => {});
        },
      }) };
      const reports: SessionClassifierCallReport[] = [];
      const call = sessionClassifierModelCall({ ...fakeSessionRegistry([]), streamSimple: () => stream }, { onCallEnd: (r) => reports.push(r) });
      const pending = call("p", HAIKU_LOW, controller.signal);
      const rejected = assert.rejects(pending, /pi classifier call aborted/);
      controller.abort();
      await rejected;
      settle({ done: false, value: { get type() { reads++; return "text_delta" as const; }, delta: "late" } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(nextCalls, 1, "no second next after abort");
      assert.equal(reads, 0, "late event is not processed");
      assert.equal(returns, 1, "close requested without waiting");
      assert.equal(reports.length, 1);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
    }
  }
});

test("abort during stream creation requests close without starting next", async () => {
  const controller = new AbortController();
  let nextCalls = 0;
  let closed = 0;
  const call = sessionClassifierModelCall({ ...fakeSessionRegistry([]), streamSimple: () => {
    controller.abort();
    return { [Symbol.asyncIterator]: () => ({
      next: async () => { nextCalls++; return { done: true as const, value: undefined }; },
      return: async () => { closed++; return { done: true as const, value: undefined }; },
    }) };
  } });
  await assert.rejects(call("p", HAIKU_LOW, controller.signal), /aborted/);
  assert.equal(nextCalls, 0);
  assert.equal(closed, 1);
});

test("a pending next rejection after abort is handled", async () => {
  const controller = new AbortController();
  let rejectNext!: (error: Error) => void;
  const call = sessionClassifierModelCall({ ...fakeSessionRegistry([]), streamSimple: () => ({
    [Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<never>>((_, reject) => { rejectNext = reject; }) }),
  }) });
  const pending = call("p", HAIKU_LOW, controller.signal);
  const rejected = assert.rejects(pending, /aborted/);
  controller.abort();
  await rejected;
  rejectNext(new Error("late provider rejection"));
  await new Promise((resolve) => setImmediate(resolve));
});
