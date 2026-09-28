import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerSubcommands, showOwner } from "../init/subcommands.ts";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { DEFAULT_EXPLORATION_BUDGET, loadSubagentsSettings } from "./settings.ts";
import { classifyToolCall, type ToolCallKind } from "./tool-call-kind.ts";

// The orchestrator's exploration budget (ADR 0005): a number of exploratory
// calls per user prompt, the owner's `orchestrator.subagents.explorationBudget`.
// The call after it is denied, with an instruction to hand the research to a
// worker. Read-only and unrecognised calls count (tool-call-kind.ts); builds,
// test runs, commits, edits and delegation never do, and a spot check of a
// worker's Result counts like any other read. The count starts again at each
// user prompt, not at each model turn: a run a message starts (a background
// call's completion notice, a worker's question) goes on counting the last
// prompt's calls. Only the owner lifts the budget, with `/pi-orchestrator
// budget off`, for one user prompt; the model has no way to.
//
// The budget lives in the subagents extension, beside the protocol that
// explains it, because its deny tells the orchestrator to use the `subagents`
// tool: without that extension there is nothing to hand the research to.

/** Whether a call of `kind` counts toward the budget. */
export function countsAsExploration(kind: ToolCallKind): boolean {
  return kind === "read-only" || kind === "unrecognised";
}

/** One orchestrator session's budget. */
export class ExplorationBudget {
  #threshold: number;
  #used = 0;
  /** Which user prompt the owner lifted the budget for, if any. */
  #lifted: "none" | "this prompt" | "next prompt" = "none";

  constructor(threshold: number) {
    this.#threshold = threshold;
  }

  /** Exploratory calls allowed per user prompt. */
  get threshold(): number {
    return this.#threshold;
  }

  /** A new session: a fresh count, no lift, and `threshold`. */
  reset(threshold: number): void {
    this.#threshold = threshold;
    this.#used = 0;
    this.#lifted = "none";
  }

  /** A user prompt starts: a fresh count under `threshold`, and a lift made for this prompt applies. */
  userPrompt(threshold: number): void {
    this.#threshold = threshold;
    this.#used = 0;
    this.#lifted = this.#lifted === "next prompt" ? "this prompt" : "none";
  }

  /** The owner's `budget off`: for the rest of the running prompt, or for the
   *  next user prompt when the orchestrator is idle. Returns what the owner is told. */
  lift({ running }: { readonly running: boolean }): string {
    this.#lifted = running ? "this prompt" : "next prompt";
    return `pi-orchestrator: exploration budget off for ${running ? "the rest of this prompt" : "the next prompt"}.`;
  }

  /** Counts a call of `kind`. Returns the deny reason when it is over the budget, else `undefined`. */
  check(kind: ToolCallKind): string | undefined {
    if (!countsAsExploration(kind) || this.#lifted === "this prompt") return undefined;
    if (this.#used >= this.#threshold) {
      const calls = `${this.#threshold} exploratory call${this.#threshold === 1 ? "" : "s"}`;
      return `pi-orchestrator: ${calls} this prompt. Hand the rest of the research to a worker with \`subagents\`.`;
    }
    this.#used++;
    return undefined;
  }
}

/** Hooks the budget into this extension's session, and adds `/pi-orchestrator
 *  budget off`. It binds only the orchestrator's own session: a worker, a
 *  forked worker or a pi-subagents child loads this extension too, and runs
 *  unbudgeted. The threshold is read from settings at the session's start and
 *  at each user prompt; a settings failure keeps the default and is logged
 *  once. Returns the budget, whose threshold the protocol names. */
export function registerExplorationBudget(pi: ExtensionAPI, logOnce: (line: string) => void): ExplorationBudget {
  const budget = new ExplorationBudget(DEFAULT_EXPLORATION_BUDGET);
  const threshold = (cwd: string): number => {
    try {
      const loaded = loadSubagentsSettings(personalAgentDir(), cwd);
      for (const key of loaded.ignoredProjectKeys) logOnce(`ignored project settings key ${key}`);
      return loaded.settings.explorationBudget;
    } catch (error) {
      logOnce(`exploration budget: ${String(error).split(/\r?\n/, 1)[0]}; using ${DEFAULT_EXPLORATION_BUDGET}`);
      return DEFAULT_EXPLORATION_BUDGET;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (isOrchestratorSession(ctx)) budget.reset(threshold(ctx.cwd));
  });
  // Every prompt the user sends is a user prompt, one typed while the
  // orchestrator runs included. A user message another extension sends is not.
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && isOrchestratorSession(ctx)) budget.userPrompt(threshold(ctx.cwd));
  });
  pi.on("tool_call", (event, ctx) => {
    if (!isOrchestratorSession(ctx)) return undefined;
    const reason = budget.check(classifyToolCall(event.toolName, event.input));
    return reason === undefined ? undefined : { block: true, reason };
  });
  // pi runs an extension command at once, even while the agent runs.
  registerSubcommands(pi, [{
    name: "budget",
    summary: "`budget off` lifts the exploration budget for one prompt",
    run: (rest, ctx) => {
      if (rest !== "off") { showOwner(ctx, "usage: /pi-orchestrator budget off", "warning"); return; }
      showOwner(ctx, budget.lift({ running: !ctx.isIdle() }), "info");
    },
  }]);
  return budget;
}
