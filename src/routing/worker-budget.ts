import type { BeforeAgentStartEvent, BeforeAgentStartEventResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { RiskTier } from "./tiers.ts";

// The worker budget (ADR 0021): a routed worker whose task the classifier put
// on a simple tier, mechanical or standard, gets a section in its system
// prompt with a tool-call budget, and loses its delegation tools. Session data
// showed such workers taking a median of 32 turns, and delegating again, for
// work that needed a handful. Elevated and critical workers keep both: their
// work may need the room, and they may delegate one level deeper (ADR 0016).
// The budget is guidance, never a hard stop: the worker replies with a partial
// Result when it runs past it, and the orchestrator decides how to go on.

/** Whether the owner's personal settings leave the worker budget on: `orchestrator.routing.workerBudget`, true by
 *  default. Anything but a boolean throws, naming the key. */
export function workerBudgetFromSettings(personal: unknown): boolean {
  const routing = (personal as { orchestrator?: { routing?: { workerBudget?: unknown } } } | undefined)?.orchestrator?.routing;
  const raw = typeof routing === "object" && routing !== null ? routing.workerBudget : undefined;
  if (raw === undefined) return true;
  if (typeof raw !== "boolean") throw new Error(`orchestrator.routing.workerBudget must be true or false; got ${JSON.stringify(raw)}.`);
  return raw;
}

/** The worker budget's section name in a worker's system prompt. */
export const WORKER_BUDGET_SECTION = "worker_budget";

/** The tools a worker on a simple tier loses: those that start, check on or steer its own workers. */
export const DELEGATION_TOOL_NAMES: readonly string[] = ["subagents", "subagents_status", "subagents_message"];

/** Per simple tier: the tool calls a worker aims to finish within, and the count past which it stops and replies. */
export const WORKER_BUDGETS: Readonly<Partial<Record<RiskTier, { readonly aim: number; readonly stop: number }>>> = {
  mechanical: { aim: 8, stop: 15 },
  standard: { aim: 25, stop: 50 },
};

/** Whether a worker on `tier` may delegate: only elevated and critical workers, and a worker whose tier is unknown. */
export function delegatesAtTier(tier: RiskTier | undefined): boolean {
  return tier === undefined || WORKER_BUDGETS[tier] === undefined;
}

/** The worker budget section for a worker on `tier`, or `undefined` when its tier has no budget. */
export function workerBudget(tier: RiskTier | undefined): string | undefined {
  const budget = tier === undefined ? undefined : WORKER_BUDGETS[tier];
  if (budget === undefined) return undefined;
  const kind = tier === "mechanical" ? "small, clear and easy to check" : "routine work with tests or review to catch a mistake";
  return [
    "# Worker budget",
    "",
    `Your task was classified ${tier}: ${kind}. Do it yourself: you cannot start workers of your own.`,
    "Take the shortest path to the result the task asks for. Batch independent reads and searches into one turn instead of one per turn.",
    `Aim to finish within about ${budget.aim} tool calls. If you reach about ${budget.stop} and are not done, stop and reply with your ` +
      "Result so far and what is left; the orchestrator decides how to go on.",
  ].join("\n");
}

/** A worker's `before_agent_start` step once its tier is known: on a simple tier it drops the delegation tools from
 *  the active set and adds the budget section. When an earlier handler forced the whole prompt, the section is
 *  appended to it, as the orchestrator protocol does (orchestrator-protocol.ts). */
export function applyWorkerBudget(event: Pick<BeforeAgentStartEvent, "systemPromptOptions">,
  pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, tier: RiskTier | undefined): BeforeAgentStartEventResult | undefined {
  if (!delegatesAtTier(tier)) {
    const active = pi.getActiveTools();
    const kept = active.filter((name) => !DELEGATION_TOOL_NAMES.includes(name));
    if (kept.length !== active.length) pi.setActiveTools(kept);
  }
  const budget = workerBudget(tier);
  if (budget === undefined) return undefined;
  event.systemPromptOptions.sections[WORKER_BUDGET_SECTION] = budget;
  const forced = event.systemPromptOptions.forceSystemPrompt;
  if (forced === undefined || forced.includes(budget)) return undefined;
  return { systemPrompt: `${forced}\n\n<${WORKER_BUDGET_SECTION}>\n${budget}\n</${WORKER_BUDGET_SECTION}>` };
}
