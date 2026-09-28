import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRoutingRecords, type RoutingRecord } from "../routing/decision-record.ts";
import { stateDir } from "../router/extension.ts";
import { unjudgedDelegations, type UnjudgedDelegation } from "./editing.ts";
import type { GateLevels } from "./gate-level.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { delegationRouting, gateAction, type GateLevel } from "./quality-gate.ts";
import { gitSubcommands } from "./tool-call-kind.ts";
import { hasEnded, workerBoard } from "./worker-board.ts";
import { isRunningWorkerSession } from "./worker-sessions.ts";

// The commit gate (ADR 0010): committing unjudged work is the harm the quality
// gate guards against, so while an editing delegation of this orchestrator
// session waits for a verdict (./editing.ts), the orchestrator's git commit and
// git push are denied, with the delegations named. Nothing else is blocked:
// other bash, new delegations (the runtime cannot tell before a worker runs
// whether it will edit) and the final reply go on. A verdict of either kind
// judges a delegation. A delegation whose gate action is none at the gate
// level in force (./quality-gate.ts, ./gate-level.ts) needs no verdict, so it
// never waits: neither the gate nor the notice names it.
//
// At a turn end with delegations waiting, a notice names them. It goes the way
// a worker's progress report does (./report.ts): a custom message sent
// without triggering a turn, which pi appends once the turn's tool results are
// in, and which the model reads at its next request. The turn_end handler
// returns nothing, so it never asks pi to go on: a final reply stays final. A
// notice is sent only when the waiting delegations differ from the last one's,
// and once more at the first turn end after each user prompt, so a notice
// earlier in the context does not repeat on every turn.
//
// Like the exploration nudge, the gate binds only the orchestrator's own
// session: a worker, a forked worker or a pi-subagents child loads this
// extension too, and commits unhindered.

/** The custom message type of the turn-end notice. */
export const UNJUDGED_NOTICE = "subagents-unjudged";

/** A git action the gate denies. */
export type GatedGitAction = "commit" | "push";

/** A git command with its options and their values before the subcommand, for
 *  a command the bash reader cannot follow. */
const GIT_ACTION_TEXT = /(?:^|[\s;&|(`])(?:[^\s;&|(`]*\/)?git(?:[^\S\n]+-[^\s;&|)`]+(?:[^\S\n]+[^-\s;&|)`][^\s;&|)`]*)?)*[^\S\n]+(commit|push)(?=$|[\s;&|)`])/m;

/** The first git commit or git push in a bash command, if any. A command the
 *  bash reader (./tool-call-kind.ts) cannot follow, such as a commit message
 *  from a command substitution, is matched by its text instead: in the safe
 *  direction, a `git ... commit` there is taken for a commit. */
export function gatedGitAction(command: string): GatedGitAction | undefined {
  const subcommands = gitSubcommands(command);
  if (subcommands === undefined) return GIT_ACTION_TEXT.exec(command)?.[1] as GatedGitAction | undefined;
  return subcommands.find((subcommand): subcommand is GatedGitAction => subcommand === "commit" || subcommand === "push");
}

/** "an editing delegation waits" or "2 editing delegations wait", and the delegations. */
function waitingText(labels: readonly string[]): string {
  const count = labels.length === 1 ? "an editing delegation waits" : `${labels.length} editing delegations wait`;
  return `${count} for your verdict: ${labels.join(", ")}`;
}

const RECORD_VERDICTS = "Judge each Result and record its verdict with `subagents_verdict`";

/** Why `git <action>` is denied while the delegations `labels` name wait. */
export function commitDenial(action: GatedGitAction, labels: readonly string[]): string {
  return `pi-orchestrator: git ${action} is denied while ${waitingText(labels)}. ${RECORD_VERDICTS}, then ${action}.`;
}

/** The turn-end notices of one orchestrator session. */
export class UnjudgedNotices {
  /** The waiting delegations the last notice named, or that nothing waited; `undefined` after a user prompt. */
  #last: string | undefined;

  /** A user prompt starts: its first turn end with delegations waiting names them again. */
  userPrompt(): void {
    this.#last = undefined;
  }

  /** The notice for a turn end at which `waiting` wait, each named by `label`,
   *  or `undefined` when none wait or the last notice named the same. */
  atTurnEnd(waiting: readonly UnjudgedDelegation[], label: (delegationId: string) => string): string | undefined {
    // A resume that edits again after a verdict is a new wait, so each edit counts by its time.
    const key = waiting.map((delegation) => `${delegation.delegationId}@${delegation.lastEdit}`).join("\n");
    if (key === this.#last) return undefined;
    this.#last = key;
    if (waiting.length === 0) return undefined;
    return `pi-orchestrator: ${waitingText(waiting.map((delegation) => label(delegation.delegationId)))}. ` +
      `${RECORD_VERDICTS}; git commit and git push are denied until then.`;
  }
}

/** "delegation <id>", with its agent and whether it still runs, as far as this
 *  process's worker board knows them. */
function delegationLabel(delegationId: string): string {
  const worker = workerBoard().byDelegation(delegationId);
  const running = isRunningWorkerSession(delegationId) || (worker !== undefined && !hasEnded(worker));
  const notes = [...(worker?.agent === undefined ? [] : [`agent ${worker.agent}`]), ...(running ? ["still running"] : [])];
  return `delegation ${delegationId}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

/** An error's first line, for a deny reason or a log line. */
function firstLine(error: unknown): string {
  return String(error instanceof Error ? error.message : error).split(/\r?\n/, 1)[0]!;
}

/** The editing delegations of `orchestratorSession` in `records`, the record
 *  folder in file order, that wait for a verdict at the gate level `level`:
 *  the unjudged ones (./editing.ts) whose gate action is not none. */
export function waitingForVerdict(records: readonly RoutingRecord[], orchestratorSession: string, level: GateLevel): UnjudgedDelegation[] {
  return unjudgedDelegations(records, orchestratorSession)
    .filter((delegation) => gateAction(delegationRouting(records, delegation.delegationId).tier, level) !== "none");
}

/** The editing delegations of `ctx`'s orchestrator session that wait for a verdict. */
function waiting(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, gateLevels: GateLevels): UnjudgedDelegation[] {
  return waitingForVerdict(readRoutingRecords(join(stateDir(), "routing")), ctx.sessionManager.getSessionId(), gateLevels.inForce(ctx).level);
}

/** Hooks the commit gate and the turn-end notice into this extension's
 *  session. A record folder that cannot be read denies a commit or push, with
 *  the reason, since the gate cannot tell whether one is outstanding; at a
 *  turn end it skips the notice and is logged once. */
export function registerCommitGate(pi: ExtensionAPI, logOnce: (line: string) => void, gateLevels: GateLevels): void {
  const notices = new UnjudgedNotices();
  pi.on("session_start", () => { notices.userPrompt(); });
  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" && isOrchestratorSession(ctx)) notices.userPrompt();
  });
  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "bash" || !isOrchestratorSession(ctx)) return undefined;
    const command = (event.input as { command?: unknown }).command;
    const action = typeof command === "string" ? gatedGitAction(command) : undefined;
    if (action === undefined) return undefined;
    let unjudged: UnjudgedDelegation[];
    try {
      unjudged = waiting(ctx, gateLevels);
    } catch (error) {
      return { block: true, reason: `pi-orchestrator: git ${action} is denied: the edit records cannot be read to tell whether every editing delegation has a verdict (${firstLine(error)}).` };
    }
    return unjudged.length === 0 ? undefined : { block: true, reason: commitDenial(action, unjudged.map((item) => delegationLabel(item.delegationId))) };
  });
  pi.on("turn_end", (_event, ctx) => {
    if (!isOrchestratorSession(ctx)) return;
    try {
      const unjudged = waiting(ctx, gateLevels);
      const notice = notices.atTurnEnd(unjudged, delegationLabel);
      if (notice === undefined) return;
      pi.sendMessage({ customType: UNJUDGED_NOTICE, content: notice, display: true, details: { delegationIds: unjudged.map((item) => item.delegationId) } },
        { triggerTurn: false });
    } catch (error) {
      logOnce(`unjudged delegations notice: ${firstLine(error)}`);
    }
  });
}
