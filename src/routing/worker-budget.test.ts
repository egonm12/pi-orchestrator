import assert from "node:assert/strict";
import test from "node:test";
import { createAutoModelRouter, setCarriedClassification } from "../router/auto-model.ts";
import { orchestratorProtocol } from "../subagents/orchestrator-protocol.ts";
import { HANDLING_CRITERIA } from "./handling-criteria.ts";
import { applyWorkerBudget, delegatesAtTier, WORKER_BUDGET_SECTION, workerBudget } from "./worker-budget.ts";
import type { TierClassification } from "./tier-classifier.ts";

function event(forceSystemPrompt?: string) {
  return { systemPromptOptions: { sections: {} as Record<string, string | null>, ...(forceSystemPrompt === undefined ? {} : { forceSystemPrompt }) } } as never as
    { systemPromptOptions: { sections: Record<string, string | null>; forceSystemPrompt?: string } };
}

function tools(active: string[]) {
  const state = { active, set: 0 };
  return { state, pi: { getActiveTools: () => state.active, setActiveTools: (names: string[]) => { state.active = names; state.set++; } } };
}

test("only mechanical and standard workers get a budget; elevated, critical and an unknown tier keep delegating", () => {
  assert.equal(delegatesAtTier("mechanical"), false);
  assert.equal(delegatesAtTier("standard"), false);
  assert.equal(delegatesAtTier("elevated"), true);
  assert.equal(delegatesAtTier("critical"), true);
  assert.equal(delegatesAtTier(undefined), true);
  assert.equal(workerBudget("elevated"), undefined);
  assert.equal(workerBudget(undefined), undefined);
  assert.match(workerBudget("mechanical")!, /about 8 tool calls/);
  assert.match(workerBudget("standard")!, /about 25 tool calls/);
  assert.match(workerBudget("standard")!, /you cannot start workers of your own/);
});

test("a simple-tier worker loses its delegation tools and gets the budget section", () => {
  const e = event();
  const { state, pi } = tools(["read", "bash", "subagents", "subagents_status", "subagents_message"]);
  assert.equal(applyWorkerBudget(e as never, pi, "mechanical"), undefined);
  assert.deepEqual(state.active, ["read", "bash"]);
  assert.equal(e.systemPromptOptions.sections[WORKER_BUDGET_SECTION], workerBudget("mechanical"));
});

test("an elevated worker keeps its tools and its prompt", () => {
  const e = event();
  const { state, pi } = tools(["read", "subagents"]);
  assert.equal(applyWorkerBudget(e as never, pi, "elevated"), undefined);
  assert.equal(state.set, 0);
  assert.deepEqual(e.systemPromptOptions.sections, {});
});

test("a forced prompt gets the budget appended once", () => {
  const { pi } = tools(["read"]);
  const result = applyWorkerBudget(event("FORCED") as never, pi, "standard");
  assert.equal(result?.systemPrompt, `FORCED\n\n<${WORKER_BUDGET_SECTION}>\n${workerBudget("standard")}\n</${WORKER_BUDGET_SECTION}>`);
  assert.equal(applyWorkerBudget(event(result!.systemPrompt!) as never, pi, "standard"), undefined);
});

test("workerTier reads a retry's carried tier, else the saved pin's, and never throws", async () => {
  const router = createAutoModelRouter({} as never);
  const remove = setCarriedClassification("worker-carried", { tier: "standard" } as TierClassification);
  try {
    assert.equal(await router.workerTier("worker-carried", {} as never), "standard");
  } finally { remove(); }
  assert.equal(await router.workerTier("worker-none", { sessionManager: { getBranch: () => [] } } as never), undefined);
  assert.equal(await router.workerTier("worker-broken", { sessionManager: { getBranch: () => { throw new Error("no branch"); } } } as never), undefined);
});

test("the protocol and the handling criteria make self the default and drop the two-command trigger", () => {
  const protocol = orchestratorProtocol(20, "low");
  assert.doesNotMatch(protocol, /more than two exploratory commands/);
  assert.match(protocol, /Do the work yourself when you can/);
  assert.match(protocol, /Taking a few minutes is no reason to delegate/);
  assert.match(HANDLING_CRITERIA, /^Self is the default/);
  assert.match(HANDLING_CRITERIA, /Running for minutes is not a reason to delegate/);
});
