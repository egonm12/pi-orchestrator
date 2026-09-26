import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { BackgroundCalls } from "./background.ts";

// The report tool (ADR 0008): a worker's own messages to the agent that
// delegated to it. Every worker gets it, whatever its agent definition's
// `tools:` list says. Progress is shown at once and reaches the delegating
// session at its next turn without starting one. Only a background worker may
// ask a question: it starts a turn when the orchestrator is idle, is steered in
// after the orchestrator's current tool call otherwise, and blocks the worker
// until a subagents_message reply, an abort or a `/subagents stop`, without a
// time limit.

export const REPORT_TOOL = "report";

/** The custom message type of a worker's report in the delegating session. */
export const WORKER_REPORT = "subagents-report";

export type ReportKind = "progress" | "question";

/** Where one worker's reports go. Without `question`, the worker may only report progress. */
export interface WorkerReports {
  readonly progress: (delegationId: string, text: string) => void;
  /** Resolves with the answer; rejects when `signal` fires, as the worker's abort does. */
  readonly question?: (delegationId: string, text: string, signal: AbortSignal | undefined) => Promise<string>;
}

/** A report message's `details`. */
export interface WorkerReportDetails {
  readonly delegationId: string;
  readonly kind: ReportKind;
  readonly text: string;
}

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** The worker-side `report` tool, as an extension the worker loads. */
export function reportExtension(reports: WorkerReports): InlineExtension {
  const kinds: readonly ReportKind[] = reports.question === undefined ? ["progress"] : ["progress", "question"];
  const description = reports.question === undefined
    ? "Send the agent that delegated to you a short progress note. It does not interrupt that agent, and you go on at once. Put your results in your final reply, not here."
    : "Send the orchestrator a short report. kind progress: a progress note that does not interrupt it; you go on at once. " +
      "kind question: ask something only it can answer; you wait until it replies, and the reply is the tool result. Put your results in your final reply, not here.";
  return {
    name: "subagents-report",
    factory: (pi) => pi.registerTool({
      name: REPORT_TOOL,
      label: "Report",
      description,
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...kinds], description: "progress, or question to wait for an answer." },
          text: { type: "string", description: "The progress note or the question." },
        },
        required: ["kind", "text"],
        additionalProperties: false,
      } as unknown as ToolParameters,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { kind, text } = params as { kind: ReportKind; text: string };
        if (!text || !kinds.includes(kind)) throw new Error(`report requires text and a kind: ${kinds.join(" or ")}`);
        const delegationId = ctx.sessionManager.getSessionId();
        if (kind === "progress" || reports.question === undefined) {
          reports.progress(delegationId, text);
          return { content: [{ type: "text", text: "Progress sent." }], details: undefined };
        }
        const answer = await reports.question(delegationId, text, signal);
        return { content: [{ type: "text", text: `The orchestrator answered: ${answer}` }], details: undefined };
      },
    }),
  };
}

/** Reports from the workers of one subagents call, delivered into the delegating
 *  session. Only a background call's workers, given `backgroundCalls`, may ask. */
export function workerReports(pi: ExtensionAPI, ctx: ExtensionContext, backgroundCalls: BackgroundCalls | undefined): WorkerReports {
  const send = (delegationId: string, kind: ReportKind, content: string, text: string, options: Parameters<ExtensionAPI["sendMessage"]>[1]) => {
    const details: WorkerReportDetails = { delegationId, kind, text };
    pi.sendMessage({ customType: WORKER_REPORT, content, display: true, details }, options);
  };
  return {
    progress(delegationId, text) {
      // A busy session appends the message only when its turn ends; show it now.
      if (ctx.hasUI && !ctx.isIdle()) ctx.ui.notify(`Worker ${delegationId}: ${text}`, "info");
      send(delegationId, "progress", `Worker ${delegationId} reports progress:\n\n${text}`, text, { triggerTurn: false });
    },
    ...(backgroundCalls === undefined ? {} : {
      question(delegationId: string, text: string, signal: AbortSignal | undefined) {
        // Registered before the message goes out, so no reply can come first.
        const answer = backgroundCalls.question(delegationId, signal);
        send(delegationId, "question", `Worker ${delegationId} asks, and waits for the answer:\n\n${text}\n\n` +
          `Answer with subagents_message and the id ${delegationId}.`, text, { triggerTurn: true, deliverAs: "steer" });
        return answer;
      },
    }),
  };
}
