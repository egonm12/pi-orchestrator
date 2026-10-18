import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { emitHandlingDecision } from "../routing/effort-decisions.ts";
import { registerExplorationNudge } from "./exploration-nudge.ts";
import { markWorkerSession } from "./worker-sessions.ts";

// The exploration nudge judged per prompt (ADR 0020): a fake pi records the
// hooks the nudge registers, and the handling verdict arrives on the shared
// handling-decision channel, as the router extension emits it.

const SESSION = "orchestrator-session";
const SAFETY_LIMIT = 20;

type Handler = (event: unknown, ctx: unknown) => unknown;

/** A fake pi that keeps each hook's handlers and fires them in order. */
function fakePi() {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on: (name: string, handler: Handler) => { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  };
  const fire = (name: string, event: unknown, ctx: unknown): unknown => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = handler(event, ctx) ?? result;
    return result;
  };
  return { pi: pi as unknown as ExtensionAPI, fire };
}

/** A project folder and an empty personal agent folder, so the defaults apply. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "exploration-nudge-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  return {
    cwd: join(root, "project"),
    cleanup: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One user prompt typed in the orchestrator, judged `handling` (or not judged when undefined). */
function userPrompt(fire: (name: string, event: unknown, ctx: unknown) => unknown, ctx: unknown, handling?: "self" | "delegate"): void {
  fire("input", { source: "interactive", text: "Look around" }, ctx);
  if (handling !== undefined) {
    emitHandlingDecision({ sessionId: SESSION, timestamp: "2026-10-14T10:00:00.000Z", handling, source: "judged", reason: "test", judgeModel: "anthropic/claude-haiku-5-5:low" });
  }
}

/** One read call; the nudge the result ends with, or `undefined` when none. */
function readCall(fire: (name: string, event: unknown, ctx: unknown) => unknown, ctx: unknown, id: string): string | undefined {
  fire("tool_call", { toolCallId: id, toolName: "read", input: { path: "README.md" } }, ctx);
  const result = fire("tool_result", { toolCallId: id, content: [{ type: "text", text: "contents" }] }, ctx) as
    { content: { type: string; text: string }[] } | undefined;
  return result === undefined ? undefined : result.content.at(-1)?.text;
}

test("a self prompt gets no nudge through the 20-call safety limit, and one from the 21st call", () => {
  const box = sandbox();
  try {
    const { pi, fire } = fakePi();
    registerExplorationNudge(pi, () => {});
    const ctx = { cwd: box.cwd, sessionManager: { getSessionId: () => SESSION } };
    userPrompt(fire, ctx, "self");
    const texts = Array.from({ length: SAFETY_LIMIT + 1 }, (_, index) => readCall(fire, ctx, `call-${index + 1}`));
    assert.deepEqual(texts.slice(0, SAFETY_LIMIT), Array(SAFETY_LIMIT).fill(undefined));
    assert.match(texts[SAFETY_LIMIT]!, /^21 exploratory calls this prompt/);
  } finally { box.cleanup(); }
});

test("a delegate prompt is reminded at its first exploratory call, with the reason", () => {
  const box = sandbox();
  try {
    const { pi, fire } = fakePi();
    registerExplorationNudge(pi, () => {});
    const ctx = { cwd: box.cwd, sessionManager: { getSessionId: () => SESSION } };
    userPrompt(fire, ctx, "delegate");
    assert.equal(readCall(fire, ctx, "call-1"), "1 exploratory call this prompt: the handling judge chose delegate, so hand this prompt to a worker.");
    assert.equal(readCall(fire, ctx, "call-2"), "2 exploratory calls this prompt: the handling judge chose delegate, so hand this prompt to a worker.");
  } finally { box.cleanup(); }
});

test("a worker's calls are never nudged, even when a delegate verdict names its session", () => {
  const box = sandbox();
  try {
    const { pi, fire } = fakePi();
    registerExplorationNudge(pi, () => {});
    const orchestratorCtx = { cwd: box.cwd, sessionManager: { getSessionId: () => SESSION } };
    const worker = "worker-session";
    markWorkerSession(worker);
    const workerCtx = { cwd: box.cwd, sessionManager: { getSessionId: () => worker } };
    userPrompt(fire, orchestratorCtx, "delegate");
    fire("input", { source: "interactive", text: "Work" }, workerCtx);
    emitHandlingDecision({ sessionId: worker, timestamp: "2026-10-14T10:00:00.000Z", handling: "delegate", source: "judged", reason: "test", judgeModel: "anthropic/claude-haiku-5-5:low" });
    const texts = Array.from({ length: 3 }, (_, index) => readCall(fire, workerCtx, `worker-call-${index + 1}`));
    assert.deepEqual(texts, [undefined, undefined, undefined]);
  } finally { box.cleanup(); }
});

test("each user prompt starts its own count, and an unjudged prompt keeps the self safety limit", () => {
  const box = sandbox();
  try {
    const { pi, fire } = fakePi();
    registerExplorationNudge(pi, () => {});
    const ctx = { cwd: box.cwd, sessionManager: { getSessionId: () => SESSION } };
    userPrompt(fire, ctx, "delegate");
    assert.match(readCall(fire, ctx, "first-1")!, /^1 exploratory call this prompt: the handling judge chose delegate/);
    userPrompt(fire, ctx);
    const texts = Array.from({ length: SAFETY_LIMIT }, (_, index) => readCall(fire, ctx, `second-${index + 1}`));
    assert.deepEqual(texts, Array(SAFETY_LIMIT).fill(undefined));
  } finally { box.cleanup(); }
});

test("a handling verdict starts a new count even for a prompt another extension sent, such as a forced prompt", () => {
  const box = sandbox();
  try {
    const { pi, fire } = fakePi();
    registerExplorationNudge(pi, () => {});
    const ctx = { cwd: box.cwd, sessionManager: { getSessionId: () => SESSION } };
    userPrompt(fire, ctx, "self");
    for (let index = 1; index <= 5; index++) readCall(fire, ctx, `before-${index}`);
    // An extension's message does not start a count, so only the verdict marks the forced prompt.
    emitHandlingDecision({ sessionId: SESSION, timestamp: "2026-10-14T10:05:00.000Z", handling: "delegate", source: "forced", reason: "owner override", judgeModel: "forced" });
    assert.equal(readCall(fire, ctx, "forced-1"), "1 exploratory call this prompt: the handling judge chose delegate, so hand this prompt to a worker.");
  } finally { box.cleanup(); }
});
