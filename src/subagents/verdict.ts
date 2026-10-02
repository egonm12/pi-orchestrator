import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRoutingRecordsJudging, UnreadableDelegationRecordError, VERDICTS, type SkippedRoutingRecordLine, type Verdict } from "../routing/decision-record.ts";
import type { GateLevelRaise } from "../routing/decision-record.ts";
import { attachVerdict } from "../routing/verdicts.ts";
import { stateDir } from "../router/extension.ts";
import type { GateLevels } from "./gate-level.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { delegationRouting, editingDelegationProblem, gateAction, hasQualityGate, isHigherGateLevel, RAISE_GATE_LEVELS, type EditingDelegationProblem,
  type GateLevel } from "./quality-gate.ts";
import { isSameRungReview, reviewerProblem } from "./review.ts";
import { planRetry, planText, retrySetup } from "./retry.ts";

// The subagents_verdict tool (ADR 0010): the orchestrator records its verdict
// on an editing delegation, whether it came from its own spot check or a
// reviewer's Result. The verdict is attached to the delegation's decision
// record (../routing/verdicts.ts), which the routing report counts; a later
// verdict on the same delegation replaces the earlier one there. Only the
// orchestrator's session may record one, and only on an editing delegation
// of its own that has finished. Where the gate action at the gate level in
// force (./gate-level.ts) is a reviewer (./quality-gate.ts), a verdict must
// name a completed review of the same delegation (./review.ts); a verdict
// naming one is taken at any tier, and one resting on a same-rung review says
// so in its record. A delegation whose gate action is none needs no verdict,
// and still takes one. The orchestrator may raise the gate level for this one
// delegation, with a reason, never lower it (ADR 0011): the verdict is then
// held to the raised level, and its record names the raise. A request_changes
// reply names the effort ladder's next rung for a retry (./retry.ts), or says
// the ladder cannot place the delegation, or why no retry may start. It reads
// the record folder past lines of other delegations it cannot validate, and
// names them in its reply, so one foreign or torn line does not block every
// verdict; a line of the judged delegation or its reviewer that it cannot
// validate refuses the verdict, which cannot be judged without it
// (pi-orchestrator-zb6t).
//
// At gate level off there is no quality gate, so the tool leaves the
// orchestrator's active tools while that level is in force, and refuses a call
// that reaches it anyway. The level is read as each prompt starts its run and
// whenever `/pi-orchestrator gate` sets it (./gate-level.ts).

export const SUBAGENTS_VERDICT_TOOL = "subagents_verdict";

/** The tool's input. */
interface VerdictInput {
  readonly delegationId: string;
  readonly verdict: Verdict;
  readonly reason: string;
  /** The reviewer delegation whose Result the verdict rests on. */
  readonly reviewer?: string;
  /** A gate level above the one in force for this delegation, and why. */
  readonly raise?: { readonly level: GateLevel; readonly reason: string };
}

const USAGE = `${SUBAGENTS_VERDICT_TOOL} requires a delegationId, a verdict of accept or request_changes, and a reason`;

function verdictInput(params: unknown): VerdictInput {
  const { delegationId, verdict, reason, reviewer, gateLevel, gateLevelReason } = (params ?? {}) as Record<string, unknown>;
  if (typeof delegationId !== "string" || delegationId.trim() === "" || !VERDICTS.includes(verdict as Verdict) ||
    typeof reason !== "string" || reason.trim() === "") throw new Error(USAGE);
  if (reviewer !== undefined && (typeof reviewer !== "string" || reviewer.trim() === "")) {
    throw new Error(`${SUBAGENTS_VERDICT_TOOL}: a reviewer, when given, is the review delegation's id`);
  }
  if (gateLevel !== undefined && !RAISE_GATE_LEVELS.includes(gateLevel as GateLevel)) {
    throw new Error(`${SUBAGENTS_VERDICT_TOOL}: a gateLevel, when given, is one of ${RAISE_GATE_LEVELS.join(", ")}`);
  }
  if ((gateLevel === undefined) !== (gateLevelReason === undefined) || (gateLevelReason !== undefined && (typeof gateLevelReason !== "string" || gateLevelReason.trim() === ""))) {
    throw new Error(`${SUBAGENTS_VERDICT_TOOL}: a raised gateLevel needs a gateLevelReason saying why, and a gateLevelReason needs a gateLevel`);
  }
  return { delegationId: delegationId.trim(), verdict: verdict as Verdict, reason: reason.trim(),
    ...(reviewer === undefined ? {} : { reviewer: reviewer.trim() }),
    ...(gateLevel === undefined ? {} : { raise: { level: gateLevel as GateLevel, reason: (gateLevelReason as string).trim() } }) };
}

/** Why `id` takes no verdict. */
function problemText(id: string, problem: EditingDelegationProblem): string {
  switch (problem.kind) {
    case "running": return `delegation ${id} is still running; judge its Result once it has finished`;
    case "nested": return `delegation ${id} is a worker's own worker; its edits count for delegation ${problem.delegationId}, so record the verdict there`;
    case "research": return `delegation ${id} did not edit; a research Result is checked but gets no verdict`;
    case "unknown": return `unknown delegation id ${id}`;
    case "other-session": return `delegation ${id} belongs to another orchestrator session`;
  }
}

/** Why the gate level `level` does not raise the level in force, `from`, or `undefined` when it does. */
function raiseProblem(from: GateLevel, level: GateLevel): string | undefined {
  if (isHigherGateLevel(level, from)) return undefined;
  const higher = RAISE_GATE_LEVELS.filter((candidate) => isHigherGateLevel(candidate, from));
  return `the gate level is ${from}, and a verdict may only raise it for its delegation, never lower it` +
    (higher.length === 0 ? `: ${from} is the highest` : `: name ${higher.join(" or ")}, or leave gateLevel out`);
}

/** What a retry of `id` would do now, with `feedback` as its task, as a request_changes reply says it. */
function nextClimb(ctx: Parameters<typeof retrySetup>[0], id: string, feedback: string, recordDir: string): string {
  let records;
  try { records = readRoutingRecordsJudging(recordDir, [id]).records; } catch (error) {
    if (!(error instanceof UnreadableDelegationRecordError)) throw error;
    return `No retry can be planned: ${error.message}.`;
  }
  let task: string;
  try { task = retrySetup(ctx, id, feedback, records).task; } catch (error) {
    const message = (error as Error).message;
    return `${message.charAt(0).toUpperCase()}${message.slice(1)}.`;
  }
  const plan = planRetry(ctx.sessionManager.getSessionId(), id, records, task, new Date());
  if (plan.kind === "refused") return `A retry is refused: ${plan.why}.`;
  return `${planText(plan)} To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`;
}

/** The reply's note on the lines of other delegations this session cannot read, or "" when there are none. */
function skippedNote(skipped: readonly SkippedRoutingRecordLine[]): string {
  if (skipped.length === 0) return "";
  const shown = skipped.slice(0, 3).map((line) => `${line.file}:${line.line}`).join(", ");
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return ` Skipped ${skipped.length} routing record line${skipped.length === 1 ? "" : "s"} of other delegations that this session cannot read ` +
    `(${shown}${more}); /reload may be needed.`;
}

/** Takes `subagents_verdict` out of `pi`'s active tools at gate level off and
 *  puts it back at any other level, in the orchestrator's session only. It is
 *  put back only when this switch took it out, so a loadout that never had it
 *  stays as it is. */
export class VerdictToolSwitch {
  #removed = false;

  sync(pi: Pick<ExtensionAPI, "getActiveTools" | "setActiveTools">, level: GateLevel): void {
    const active = pi.getActiveTools();
    const isActive = active.includes(SUBAGENTS_VERDICT_TOOL);
    if (!hasQualityGate(level)) {
      if (!isActive) return;
      pi.setActiveTools(active.filter((name) => name !== SUBAGENTS_VERDICT_TOOL));
      this.#removed = true;
    } else if (this.#removed) {
      this.#removed = false;
      if (!isActive) pi.setActiveTools([...active, SUBAGENTS_VERDICT_TOOL]);
    }
  }
}

/** Registers `subagents_verdict` for the orchestrator's session, active only
 *  while the gate level in force is not off. */
export function registerSubagentsVerdictTool(pi: ExtensionAPI, gateLevels: GateLevels): void {
  const toolSwitch = new VerdictToolSwitch();
  const sync = (ctx: ExtensionContext) => { if (isOrchestratorSession(ctx)) toolSwitch.sync(pi, gateLevels.inForce(ctx).level); };
  pi.on("session_start", (_event, ctx) => { sync(ctx); });
  pi.on("before_agent_start", (_event, ctx) => { sync(ctx); });
  gateLevels.onSet(sync);
  pi.registerTool({
    name: SUBAGENTS_VERDICT_TOOL,
    label: "Subagents verdict",
    description: "Record your verdict on an editing delegation once it has finished: accept, or request_changes, with the reason. " +
      "Judge the Result first, by your own spot check or a reviewer's Result. A later verdict on the same delegation replaces the earlier one. " +
      "Where the gate level in force, as the orchestrator protocol names it, calls for a reviewer, name the finished review delegation as `reviewer`. " +
      "You may raise the gate level for this one delegation with `gateLevel` and `gateLevelReason`, never lower it; the verdict is then held to the raised level. " +
      "A request_changes reply names the effort ladder's next rung for a retry, or says why there is none. " +
      "A delegation that did not edit gets no verdict.",
    parameters: {
      type: "object",
      properties: {
        delegationId: { type: "string", description: "The editing delegation's id, as its Result names it." },
        verdict: { type: "string", enum: [...VERDICTS], description: "accept, or request_changes when the work falls short." },
        reason: { type: "string", description: "What you checked and what you found." },
        reviewer: { type: "string", description: "Optional: the delegation id of the completed review (a subagents item with review) this verdict rests on." },
        gateLevel: { type: "string", enum: [...RAISE_GATE_LEVELS], description: "Optional: a gate level above the one in force, for this delegation only." },
        gateLevelReason: { type: "string", description: "Why you raise the gate level; required with gateLevel." },
      },
      required: ["delegationId", "verdict", "reason"],
      additionalProperties: false,
    } as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const refusal = (why: string) => new Error(`${SUBAGENTS_VERDICT_TOOL}: ${why}`);
      if (!isOrchestratorSession(ctx)) throw refusal("only the orchestrator records verdicts");
      const { delegationId: id, verdict, reason, reviewer, raise } = verdictInput(params);
      const recordDir = join(stateDir(), "routing");
      const failClosed = <T>(read: () => T): T => {
        try { return read(); } catch (error) {
          if (!(error instanceof UnreadableDelegationRecordError)) throw error;
          throw refusal(`the verdict on delegation ${id} is refused: ${error.message}`);
        }
      };
      const { records, skipped } = failClosed(() => readRoutingRecordsJudging(recordDir, reviewer === undefined ? [id] : [id, reviewer]));
      const checked = editingDelegationProblem(ctx, records, id);
      if (checked.problem !== undefined) throw refusal(problemText(id, checked.problem));
      const { edits } = checked;
      const inForce = gateLevels.inForce(ctx).level;
      if (!hasQualityGate(inForce)) throw refusal("the gate level is off, so there is no quality gate and no verdict to record");
      if (raise !== undefined) {
        const why = raiseProblem(inForce, raise.level);
        if (why !== undefined) throw refusal(why);
      }
      const level = raise?.level ?? inForce;
      let sameRungReview = false;
      if (reviewer !== undefined) {
        const why = reviewerProblem(ctx, reviewer, id, records);
        if (why !== undefined) throw refusal(why);
        sameRungReview = isSameRungReview(ctx, reviewer, id, records);
      } else {
        const { tier } = delegationRouting(records, id);
        if (gateAction(tier, level) === "reviewer") {
          throw refusal(`delegation ${id} is ${tier ?? "without a tier, so it is gated as elevated,"} and needs an independent reviewer at the ${level} gate level: ` +
            `start one with a subagents item whose review is ${id}, judge its Result, then name it here as reviewer`);
        }
      }
      const gateLevelRaise: GateLevelRaise | undefined = raise === undefined ? undefined : { from: inForce, to: raise.level, reason: raise.reason };
      failClosed(() => attachVerdict({ recordDir, delegationId: id, verdict, reason, sameRungReview, ...(gateLevelRaise === undefined ? {} : { gateLevelRaise }),
        refreshStatePath: join(stateDir(), "refresh-state.json") }));
      const replaced = edits.verdict === undefined ? "" : ` It replaces the earlier ${edits.verdict}.`;
      const reviewed = reviewer === undefined ? "" : `, reviewed by delegation ${reviewer}${sameRungReview ? " on the delegation's own rung (a same-rung review)" : ""}`;
      const raised = gateLevelRaise === undefined ? "" : `, with its gate level raised from ${gateLevelRaise.from} to ${gateLevelRaise.to}`;
      const next = verdict === "request_changes" ? ` ${nextClimb(ctx, id, reason, recordDir)}` : "";
      return { content: [{ type: "text", text: `Recorded ${verdict} on delegation ${id}${reviewed}${raised}.${replaced}${next}${skippedNote(skipped)}` }], details: undefined };
    },
  });
}
