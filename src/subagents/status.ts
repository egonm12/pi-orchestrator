import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundCalls, CallSnapshot, CompletionNoticeDetails, WorkerSnapshot } from "./background.ts";

// The subagents_status tool (ADR 0008): the orchestrator's view of its
// background calls. Without an id it lists them; with a call id it gives a
// snapshot of each item, with a delegation id one item's snapshot. With a call
// id and `wait: true` it blocks until the call has ended and returns its
// results, which then take the place of the call's completion notice. Ctrl+C
// fires the tool's abort signal, which stops only the wait. Workers never get
// this tool: an agent definition's `tools:` list cannot give it to them.

export const SUBAGENTS_STATUS_TOOL = "subagents_status";

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** Plain JSON Schema, as the subagents tool's. */
const PARAMETERS = {
  type: "object",
  properties: {
    id: { type: "string", description: "Optional: a background call id for a snapshot of each item, or a delegation id for that worker's snapshot." },
    wait: { type: "boolean", description: "With a call id: block until the call finishes and return its results instead of its completion notice." },
  },
  additionalProperties: false,
} as unknown as ToolParameters;

const DESCRIPTION = "Check this session's background subagents calls. Without `id`, list them with each worker's state. " +
  "With a call id, a snapshot of each item; with a delegation id, that worker's snapshot: state, current tool, turns, elapsed time, " +
  "the last lines of its text and its session file. With a call id and `wait: true`, block until the call finishes and return its results; " +
  "its completion notice is then not delivered. Aborting a wait stops only the wait, not the workers.";

/** The result's `details` for a listing or a snapshot. */
export interface SubagentsStatusDetails {
  readonly calls: readonly CallSnapshot[];
}

function elapsedText(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function workerText(worker: WorkerSnapshot): string {
  const state = worker.state === "not-started" ? "not started" : worker.tool === undefined ? worker.state : `${worker.state}: ${worker.tool}`;
  return [
    `Worker ${worker.delegationId}: ${state}`,
    `Agent: ${worker.agent ?? "worker"}`,
    `Task: ${worker.task}`,
    `Turns: ${worker.turns}${worker.elapsedMs === undefined ? "" : `, elapsed: ${elapsedText(worker.elapsedMs)}`}`,
    `Session file: ${worker.sessionFile ?? (worker.elapsedMs === undefined ? "none yet" : "none, the session is not saved")}`,
    ...(worker.lastLines.length === 0 ? [] : ["Last lines:", ...worker.lastLines.map((line) => `  ${line}`)]),
  ].join("\n");
}

function snapshotText(calls: readonly CallSnapshot[]): string {
  return calls.map((call) => [`Background call ${call.callId}:`, ...call.workers.map(workerText)].join("\n\n")).join("\n\n");
}

/** Registers `subagents_status` over this session's `backgroundCalls`. */
export function registerSubagentsStatusTool(pi: ExtensionAPI, backgroundCalls: BackgroundCalls): void {
  pi.registerTool({
    name: SUBAGENTS_STATUS_TOOL,
    label: "Subagents status",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, signal): Promise<{ content: { type: "text"; text: string }[]; details: CompletionNoticeDetails | SubagentsStatusDetails }> {
      const { id, wait = false } = params as { id?: string; wait?: boolean };
      if (wait) {
        if (id === undefined) throw new Error("wait needs a background call id");
        const notice = await backgroundCalls.wait(id, signal);
        if (notice.details === undefined) throw new Error(notice.text);
        return { content: [{ type: "text", text: notice.text }], details: notice.details };
      }
      const calls = backgroundCalls.snapshots(id);
      const details: SubagentsStatusDetails = { calls };
      const text = id === undefined ? backgroundCalls.listing() : snapshotText(calls);
      return { content: [{ type: "text", text }], details };
    },
  });
}
