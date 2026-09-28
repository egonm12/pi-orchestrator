import assert from "node:assert/strict";
import { test } from "node:test";
import { ExplorationBudget } from "./exploration-budget.ts";
import type { ToolCallKind } from "./tool-call-kind.ts";

// The orchestrator's exploration budget (ADR 0005): a number of exploratory
// calls per user prompt, then a deny that tells it to delegate. Only the owner
// lifts it, for one user prompt.

const DENIED = "pi-orchestrator: 3 exploratory calls this prompt. Hand the rest of the research to a worker with `subagents`.";

/** What `budget` answers to each call, in order: `undefined` lets it run. */
function calls(budget: ExplorationBudget, kinds: readonly ToolCallKind[]): (string | undefined)[] {
  return kinds.map((kind) => budget.check(kind));
}

test("the call after the threshold is denied with the delegate instruction, and so is every later one", () => {
  const budget = new ExplorationBudget(3);
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only", "read-only", "read-only"]),
    [undefined, undefined, undefined, DENIED, DENIED]);
});

test("the count starts again at each user prompt, with the threshold read for it", () => {
  const budget = new ExplorationBudget(3);
  calls(budget, ["read-only", "read-only", "read-only"]);
  budget.userPrompt(1);
  assert.deepEqual(calls(budget, ["read-only", "read-only"]),
    [undefined, "pi-orchestrator: 1 exploratory call this prompt. Hand the rest of the research to a worker with `subagents`."]);
  assert.equal(budget.threshold, 1);
});

test("actions are never counted; unrecognised bash is", () => {
  const budget = new ExplorationBudget(2);
  assert.deepEqual(calls(budget, ["edit", "build-test", "version-control", "delegation", "other", "edit", "build-test"]), Array(7).fill(undefined));
  assert.deepEqual(calls(budget, ["unrecognised", "read-only", "unrecognised", "edit"]),
    [undefined, undefined, "pi-orchestrator: 2 exploratory calls this prompt. Hand the rest of the research to a worker with `subagents`.", undefined]);
});

test("a spot check of a Result counts like any other exploratory call", () => {
  const budget = new ExplorationBudget(3);
  // A delegation, then three reads of what the worker says it changed.
  assert.deepEqual(calls(budget, ["read-only", "read-only", "delegation", "read-only", "read-only"]), [undefined, undefined, undefined, undefined, DENIED]);
});

test("budget off while a prompt runs lifts it for the rest of that prompt only", () => {
  const budget = new ExplorationBudget(3);
  calls(budget, ["read-only", "read-only", "read-only"]);
  assert.equal(budget.lift({ running: true }), "pi-orchestrator: exploration budget off for the rest of this prompt.");
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only", "read-only"]), Array(4).fill(undefined));
  budget.userPrompt(3);
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only", "read-only"]), [undefined, undefined, undefined, DENIED]);
});

test("budget off while the orchestrator is idle lifts it for the next user prompt, not for a run before it", () => {
  const budget = new ExplorationBudget(3);
  calls(budget, ["read-only", "read-only", "read-only"]);
  assert.equal(budget.lift({ running: false }), "pi-orchestrator: exploration budget off for the next prompt.");
  // A background completion notice starts a run: no user prompt, so neither the count nor the lift moves.
  assert.deepEqual(calls(budget, ["read-only"]), [DENIED]);
  budget.userPrompt(3);
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only", "read-only"]), Array(4).fill(undefined));
  budget.userPrompt(3);
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only", "read-only"]), [undefined, undefined, undefined, DENIED]);
});

test("a new session starts with a fresh count and no lift", () => {
  const budget = new ExplorationBudget(3);
  calls(budget, ["read-only", "read-only", "read-only"]);
  budget.lift({ running: false });
  budget.reset(2);
  assert.deepEqual(calls(budget, ["read-only", "read-only", "read-only"]),
    [undefined, undefined, "pi-orchestrator: 2 exploratory calls this prompt. Hand the rest of the research to a worker with `subagents`."]);
  budget.userPrompt(2);
  assert.equal(calls(budget, ["read-only", "read-only", "read-only"])[2], "pi-orchestrator: 2 exploratory calls this prompt. Hand the rest of the research to a worker with `subagents`.");
});
