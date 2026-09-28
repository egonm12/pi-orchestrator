import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { attachVerdict, REVIEW_VERDICTS, type ReviewVerdict } from "../routing/verdicts.ts";
import { stateDir } from "../router/extension.ts";
import { delegationEdits } from "./editing.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { hasEnded, workerBoard } from "./worker-board.ts";
import { isRunningWorkerSession } from "./worker-sessions.ts";
import { workerSessionDir } from "./worker.ts";

// The subagents_verdict tool (ADR 0010): the orchestrator records its verdict
// on an editing delegation, whether it came from its own spot check or a
// reviewer's Result. The verdict is attached to the delegation's decision
// record (../routing/verdicts.ts), which the routing report counts; a later
// verdict on the same delegation replaces the earlier one there. Only the
// orchestrator's session may record one, and only on an editing delegation
// of its own that has finished.

export const SUBAGENTS_VERDICT_TOOL = "subagents_verdict";

/** The tool's input. A reviewer's delegation id and a raised gate level join it later. */
interface VerdictInput {
  readonly delegationId: string;
  readonly verdict: ReviewVerdict;
  readonly reason: string;
}

const USAGE = `${SUBAGENTS_VERDICT_TOOL} requires a delegationId, a verdict of accept or request_changes, and a reason`;

function verdictInput(params: unknown): VerdictInput {
  const { delegationId, verdict, reason } = (params ?? {}) as Record<string, unknown>;
  if (typeof delegationId !== "string" || delegationId.trim() === "" || !REVIEW_VERDICTS.includes(verdict as ReviewVerdict) ||
    typeof reason !== "string" || reason.trim() === "") throw new Error(USAGE);
  return { delegationId: delegationId.trim(), verdict: verdict as ReviewVerdict, reason: reason.trim() };
}

/** Whether this orchestrator session started the delegation `id`: its board
 *  lists it, or its saved worker sessions hold it. */
function isOwnDelegation(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string): boolean {
  if (workerBoard().byDelegation(id) !== undefined) return true;
  try {
    return SessionManager.findById(ctx.cwd, id, workerSessionDir(ctx.sessionManager)) !== undefined;
  } catch { return false; }
}

/** Registers `subagents_verdict` for the orchestrator's session. */
export function registerSubagentsVerdictTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SUBAGENTS_VERDICT_TOOL,
    label: "Subagents verdict",
    description: "Record your verdict on an editing delegation once it has finished: accept, or request_changes, with the reason. " +
      "Judge the Result first, by your own spot check or a reviewer's Result. A later verdict on the same delegation replaces the earlier one. " +
      "A delegation that did not edit gets no verdict.",
    parameters: {
      type: "object",
      properties: {
        delegationId: { type: "string", description: "The editing delegation's id, as its Result names it." },
        verdict: { type: "string", enum: [...REVIEW_VERDICTS], description: "accept, or request_changes when the work falls short." },
        reason: { type: "string", description: "What you checked and what you found." },
      },
      required: ["delegationId", "verdict", "reason"],
      additionalProperties: false,
    } as Parameters<ExtensionAPI["registerTool"]>[0]["parameters"],
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const refusal = (why: string) => new Error(`${SUBAGENTS_VERDICT_TOOL}: ${why}`);
      if (!isOrchestratorSession(ctx)) throw refusal("only the orchestrator records verdicts");
      const { delegationId: id, verdict, reason } = verdictInput(params);
      const board = workerBoard().byDelegation(id);
      if (isRunningWorkerSession(id) || (board !== undefined && !hasEnded(board))) {
        throw refusal(`delegation ${id} is still running; judge its Result once it has finished`);
      }
      const recordDir = join(stateDir(), "routing");
      const records = readRoutingRecords(recordDir);
      const edits = delegationEdits(records, id);
      if (edits.kind === "nested") {
        throw refusal(`delegation ${id} is a worker's own worker; its edits count for delegation ${edits.delegationId}, so record the verdict there`);
      }
      if (edits.kind === "none") {
        const known = isOwnDelegation(ctx, id) || records.some((record) => record.delegationId === id);
        throw refusal(known ? `delegation ${id} did not edit; a research Result is checked but gets no verdict` : `unknown delegation id ${id}`);
      }
      if (edits.orchestratorSession !== ctx.sessionManager.getSessionId()) throw refusal(`delegation ${id} belongs to another orchestrator session`);
      attachVerdict({ recordDir, delegationId: id, verdict, reason, refreshStatePath: join(stateDir(), "refresh-state.json") });
      const replaced = edits.verdict === undefined ? "" : ` It replaces the earlier ${edits.verdict}.`;
      return { content: [{ type: "text", text: `Recorded ${verdict} on delegation ${id}.${replaced}` }], details: undefined };
    },
  });
}
