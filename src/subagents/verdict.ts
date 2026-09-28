import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { attachVerdict, REVIEW_VERDICTS, type ReviewVerdict } from "../routing/verdicts.ts";
import { stateDir } from "../router/extension.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { delegationRouting, editingDelegationProblem, gateAction, type EditingDelegationProblem } from "./quality-gate.ts";
import { reviewerProblem } from "./review.ts";

// The subagents_verdict tool (ADR 0010): the orchestrator records its verdict
// on an editing delegation, whether it came from its own spot check or a
// reviewer's Result. The verdict is attached to the delegation's decision
// record (../routing/verdicts.ts), which the routing report counts; a later
// verdict on the same delegation replaces the earlier one there. Only the
// orchestrator's session may record one, and only on an editing delegation
// of its own that has finished. Where the gate action is a reviewer
// (./quality-gate.ts), a verdict must name a completed review of the same
// delegation (./review.ts); a verdict naming one is taken at any tier.

export const SUBAGENTS_VERDICT_TOOL = "subagents_verdict";

/** The tool's input. A raised gate level joins it later. */
interface VerdictInput {
  readonly delegationId: string;
  readonly verdict: ReviewVerdict;
  readonly reason: string;
  /** The reviewer delegation whose Result the verdict rests on. */
  readonly reviewer?: string;
}

const USAGE = `${SUBAGENTS_VERDICT_TOOL} requires a delegationId, a verdict of accept or request_changes, and a reason`;

function verdictInput(params: unknown): VerdictInput {
  const { delegationId, verdict, reason, reviewer } = (params ?? {}) as Record<string, unknown>;
  if (typeof delegationId !== "string" || delegationId.trim() === "" || !REVIEW_VERDICTS.includes(verdict as ReviewVerdict) ||
    typeof reason !== "string" || reason.trim() === "") throw new Error(USAGE);
  if (reviewer !== undefined && (typeof reviewer !== "string" || reviewer.trim() === "")) {
    throw new Error(`${SUBAGENTS_VERDICT_TOOL}: a reviewer, when given, is the review delegation's id`);
  }
  return { delegationId: delegationId.trim(), verdict: verdict as ReviewVerdict, reason: reason.trim(),
    ...(reviewer === undefined ? {} : { reviewer: reviewer.trim() }) };
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

/** Registers `subagents_verdict` for the orchestrator's session. */
export function registerSubagentsVerdictTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SUBAGENTS_VERDICT_TOOL,
    label: "Subagents verdict",
    description: "Record your verdict on an editing delegation once it has finished: accept, or request_changes, with the reason. " +
      "Judge the Result first, by your own spot check or a reviewer's Result. A later verdict on the same delegation replaces the earlier one. " +
      "An elevated or critical delegation, or one without a tier, needs a reviewer: name the finished review delegation as `reviewer`. " +
      "A delegation that did not edit gets no verdict.",
    parameters: {
      type: "object",
      properties: {
        delegationId: { type: "string", description: "The editing delegation's id, as its Result names it." },
        verdict: { type: "string", enum: [...REVIEW_VERDICTS], description: "accept, or request_changes when the work falls short." },
        reason: { type: "string", description: "What you checked and what you found." },
        reviewer: { type: "string", description: "Optional: the delegation id of the completed review (a subagents item with review) this verdict rests on." },
      },
      required: ["delegationId", "verdict", "reason"],
      additionalProperties: false,
    } as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const refusal = (why: string) => new Error(`${SUBAGENTS_VERDICT_TOOL}: ${why}`);
      if (!isOrchestratorSession(ctx)) throw refusal("only the orchestrator records verdicts");
      const { delegationId: id, verdict, reason, reviewer } = verdictInput(params);
      const recordDir = join(stateDir(), "routing");
      const records = readRoutingRecords(recordDir);
      const checked = editingDelegationProblem(ctx, records, id);
      if (checked.problem !== undefined) throw refusal(problemText(id, checked.problem));
      const { edits } = checked;
      if (reviewer !== undefined) {
        const why = reviewerProblem(ctx, reviewer, id, records);
        if (why !== undefined) throw refusal(why);
      } else {
        const { tier } = delegationRouting(records, id);
        if (gateAction(tier) === "reviewer") {
          throw refusal(`delegation ${id} is ${tier ?? "without a tier, so it is gated as elevated,"} and needs an independent reviewer: ` +
            `start one with a subagents item whose review is ${id}, judge its Result, then name it here as reviewer`);
        }
      }
      attachVerdict({ recordDir, delegationId: id, verdict, reason, refreshStatePath: join(stateDir(), "refresh-state.json") });
      const replaced = edits.verdict === undefined ? "" : ` It replaces the earlier ${edits.verdict}.`;
      const reviewed = reviewer === undefined ? "" : `, reviewed by delegation ${reviewer}`;
      return { content: [{ type: "text", text: `Recorded ${verdict} on delegation ${id}${reviewed}.${replaced}` }], details: undefined };
    },
  });
}
