import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import type { BackgroundCalls } from "./background.ts";
import { CHECK_IN_REPLY_FORMAT, checkInToolResult, parseCheckInReply, type CheckInAnswer, type CheckInSettings } from "./check-in.ts";

// The report tool (ADR 0008): a worker's own messages to the agent that
// delegated to it. Every worker gets it, whatever its agent definition's
// `tools:` list says. Progress is shown at once and reaches the delegating
// session at its next turn without starting one. Only a background worker may
// ask a question: it starts a turn when the orchestrator is idle, is steered in
// after the orchestrator's current tool call otherwise, and blocks the worker
// until a subagents_message reply, an abort or a `/subagents stop`, without a
// time limit. A background worker's check-in (check-in.ts) takes the question's
// path, but goes on by itself when no reply comes within the reply timeout.

export const REPORT_TOOL = "report";

/** The custom message type of a worker's report in the delegating session. */
export const WORKER_REPORT = "subagents-report";

export type ReportKind = "progress" | "question" | "check-in";

/** Where one worker's reports go. Without `question`, the worker may only report progress. */
export interface WorkerReports {
  readonly progress: (delegationId: string, text: string) => void;
  /** Resolves with the answer; rejects when `signal` fires, as the worker's abort does. */
  readonly question?: (delegationId: string, text: string, signal: AbortSignal | undefined) => Promise<string>;
  /** A background worker's check-in: resolves with the orchestrator's decision, or a timeout; rejects as `question` does. */
  readonly checkIn?: (delegationId: string, text: string, signal: AbortSignal | undefined) => Promise<CheckInAnswer>;
}

/** A report message's `details`. */
export interface WorkerReportDetails {
  readonly delegationId: string;
  readonly kind: ReportKind;
  readonly text: string;
}

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** What the worker does with its check-in's answer. */
export interface CheckInHooks {
  readonly waiting: () => void;
  readonly answered: (answer: CheckInAnswer) => void;
}

/** The worker-side `report` tool, as an extension the worker loads. `checkIn` follows its check-ins' answers. */
export function reportExtension(reports: WorkerReports, checkIn?: CheckInHooks): InlineExtension {
  const kinds: readonly ReportKind[] = reports.question === undefined ? ["progress"]
    : reports.checkIn === undefined ? ["progress", "question"] : ["progress", "question", "check-in"];
  const description = reports.question === undefined
    ? "Send the agent that delegated to you a short progress note. It does not interrupt that agent, and you go on at once. Put your results in your final reply, not here."
    : "Send the orchestrator a short report. kind progress: a progress note that does not interrupt it; you go on at once. " +
      "kind question: ask something only it can answer; you wait until it replies, and the reply is the tool result. " +
      (reports.checkIn === undefined ? "" : "kind check-in: when you are asked to check in, say what you have done, what blocks you and your next step; you wait for the orchestrator's decision. ") +
      "Put your results in your final reply, not here.";
  return {
    name: "subagents-report",
    factory: (pi) => pi.registerTool({
      name: REPORT_TOOL,
      label: "Report",
      description,
      parameters: {
        type: "object",
        properties: {
          kind: { type: "string", enum: [...kinds], description: kinds.includes("check-in")
            ? "progress, question to wait for an answer, or check-in when asked to check in." : "progress, or question to wait for an answer." },
          text: { type: "string", description: "The progress note, the question or the check-in." },
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
        if (kind === "check-in" && reports.checkIn !== undefined) {
          checkIn?.waiting();
          let answer: CheckInAnswer;
          try { answer = await reports.checkIn(delegationId, text, signal); }
          catch (error) {
            checkIn?.answered({ decision: "continue" });
            throw error;
          }
          checkIn?.answered(answer);
          return { content: [{ type: "text", text: checkInToolResult(answer) }], details: undefined };
        }
        const answer = await reports.question(delegationId, text, signal);
        // The fallback speaks for itself: no one answered, so no one is named.
        const reply = answer === UNANSWERED_QUESTION ? answer : `The orchestrator answered: ${answer}`;
        return { content: [{ type: "text", text: reply }], details: undefined };
      },
    }),
  };
}

/** The fallback answer a child gets when its delegating worker ends its run
 *  twice without answering (ADR 0016). It says it is a fallback, not an answer. */
export const UNANSWERED_QUESTION = "No answer (fallback): your delegating worker ended its turn without answering your question. " +
  "Go on without an answer: use your best judgement, and say in your Result what you assumed.";

/** Reports from the workers of one subagents call, delivered into the delegating
 *  session. Only a background call's workers, given `backgroundCalls`, may ask,
 *  and check in when `checkIn` is set. */
export function workerReports(pi: ExtensionAPI, ctx: ExtensionContext, backgroundCalls: BackgroundCalls | undefined,
  checkIn?: CheckInSettings): WorkerReports {
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
    ...(backgroundCalls === undefined || checkIn === undefined ? {} : {
      async checkIn(delegationId: string, text: string, signal: AbortSignal | undefined): Promise<CheckInAnswer> {
        const minutes = checkIn.replyTimeoutMinutes;
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), minutes * 60_000);
        // Registered before the message goes out, so no reply can come first.
        const answer = backgroundCalls.question(delegationId, signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]));
        send(delegationId, "check-in", `Worker ${delegationId} checks in, and waits for your decision:\n\n${text}\n\n` +
          `${CHECK_IN_REPLY_FORMAT} Use the id ${delegationId}. Without a reply within ${minutes} minutes it goes on.`, text,
          { triggerTurn: true, deliverAs: "steer" });
        try {
          const reply = await answer;
          // A delegating worker's fallback is no decision: its child goes on.
          return reply === UNANSWERED_QUESTION ? { decision: "continue" } : parseCheckInReply(reply);
        } catch (error) {
          if (!timeout.signal.aborted || signal?.aborted) throw error;
          const note = `Worker ${delegationId}'s check-in got no reply within ${minutes} minutes, so it goes on with its task.`;
          send(delegationId, "check-in", note, note, { triggerTurn: false });
          return { decision: "timeout" };
        } finally { clearTimeout(timer); }
      },
    }),
  };
}
