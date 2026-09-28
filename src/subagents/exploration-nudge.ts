import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { DEFAULT_EXPLORATION_NUDGE, loadSubagentsSettings } from "./settings.ts";
import { classifyToolCall, type ToolCallKind } from "./tool-call-kind.ts";

// The orchestrator's exploration nudge (ADR 0013, superseding ADR 0005's
// budget): after the owner's `orchestrator.subagents.explorationNudge`
// exploratory calls in one user prompt, the result of each further one ends
// with a reminder to hand the rest to a worker. No call is ever denied.
// Read-only and unrecognised calls count (tool-call-kind.ts); builds, test
// runs, commits, edits and delegation never do, and a spot check of a
// worker's Result counts like any other read. The count starts again at each
// user prompt, not at each model turn: a run a message starts (a background
// call's completion notice, a worker's question) and a user message another
// extension sends go on counting the last prompt's calls.
//
// Calls are counted as pi hands them to tool_call, in the order the model
// made them, and the nudge joins the call's result in tool_result. A call
// another extension blocks gets no tool_result, so it gets no nudge either.
//
// The nudge lives in the subagents extension, beside the protocol that
// explains it, because it points the orchestrator at the `subagents` tool:
// without that extension there is nothing to hand the research to.

/** Whether a call of `kind` counts toward the nudge. */
function countsAsExploration(kind: ToolCallKind): boolean {
  return kind === "read-only" || kind === "unrecognised";
}

/** The nudge after `count` exploratory calls in one user prompt. */
function explorationNudgeText(count: number): string {
  return `${count} exploratory call${count === 1 ? "" : "s"} this prompt: consider handing the rest to a worker.`;
}

/** One orchestrator session's count of exploratory calls in the current user prompt. */
class ExplorationCount {
  #threshold: number;
  #used = 0;
  /** The nudge each counted call past the threshold waits to have added to
   *  its result, by tool call id. A user prompt typed while calls run leaves
   *  their nudges in place; a new session drops what a blocked call left. */
  readonly #pending = new Map<string, string>();

  constructor(threshold: number) {
    this.#threshold = threshold;
  }

  /** Exploratory calls per user prompt before the nudge starts. */
  get threshold(): number {
    return this.#threshold;
  }

  /** A new session: a fresh count under `threshold`, and no nudge due. */
  reset(threshold: number): void {
    this.userPrompt(threshold);
    this.#pending.clear();
  }

  /** A user prompt starts: a fresh count under `threshold`. */
  userPrompt(threshold: number): void {
    this.#threshold = threshold;
    this.#used = 0;
  }

  /** Counts the call `toolCallId` of `kind`; past the threshold, its result is due a nudge. */
  called(toolCallId: string, kind: ToolCallKind): void {
    if (!countsAsExploration(kind)) return;
    this.#used++;
    if (this.#used > this.#threshold) this.#pending.set(toolCallId, explorationNudgeText(this.#used));
  }

  /** The nudge the call `toolCallId`'s result is due, once; `undefined` when none. */
  takeNudge(toolCallId: string): string | undefined {
    const text = this.#pending.get(toolCallId);
    this.#pending.delete(toolCallId);
    return text;
  }
}

/** Hooks the nudge into this extension's session. It binds only the
 *  orchestrator's own session: a worker, a forked worker or a pi-subagents
 *  child loads this extension too, and is never nudged. The threshold is read
 *  from settings at the session's start and at each user prompt; a settings
 *  failure keeps the default and is logged once. Returns the threshold, which
 *  the protocol names. */
export function registerExplorationNudge(pi: ExtensionAPI, logOnce: (line: string) => void): { readonly threshold: number } {
  const count = new ExplorationCount(DEFAULT_EXPLORATION_NUDGE);
  const threshold = (cwd: string): number => {
    try {
      const loaded = loadSubagentsSettings(personalAgentDir(), cwd);
      for (const key of loaded.ignoredProjectKeys) logOnce(`ignored project settings key ${key}`);
      return loaded.settings.explorationNudge;
    } catch (error) {
      logOnce(`exploration nudge: ${String(error).split(/\r?\n/, 1)[0]}; using ${DEFAULT_EXPLORATION_NUDGE}`);
      return DEFAULT_EXPLORATION_NUDGE;
    }
  };
  pi.on("session_start", (_event, ctx) => {
    if (isOrchestratorSession(ctx)) count.reset(threshold(ctx.cwd));
  });
  // Every prompt the user sends is a user prompt, one typed while the
  // orchestrator runs included. A user message another extension sends is not.
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && isOrchestratorSession(ctx)) count.userPrompt(threshold(ctx.cwd));
  });
  pi.on("tool_call", (event, ctx) => {
    if (isOrchestratorSession(ctx)) count.called(event.toolCallId, classifyToolCall(event.toolName, event.input));
    return undefined;
  });
  pi.on("tool_result", (event, ctx) => {
    if (!isOrchestratorSession(ctx)) return undefined;
    const text = count.takeNudge(event.toolCallId);
    return text === undefined ? undefined : { content: [...event.content, { type: "text", text }] };
  });
  return count;
}
