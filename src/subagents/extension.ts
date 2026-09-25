import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { runWorker, SUBAGENTS_TOOL, type WorkerResult } from "./worker.ts";

// The subagents extension (ADR 0007): a third pi extension, separate from the
// router and the guard, with a `subagents` tool. Each call starts a worker in
// this pi process on the auto model `orchestrator/auto`, and the router
// extension routes it. This first version runs one task per call.

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** Plain JSON Schema: pi validates a schema without TypeBox's marker as it is
 *  (pi-ai's validateToolArguments), and TypeBox does not resolve from here. */
const PARAMETERS = {
  type: "object",
  properties: {
    task: { type: "string", description: "The whole task for the worker, with every fact it needs. The worker sees nothing else." },
  },
  required: ["task"],
  additionalProperties: false,
} as unknown as ToolParameters;

/** A worker's final text longer than this is cut; its session file keeps the whole text. */
export const MAX_TEXT_BYTES = 50 * 1024;

/** `text`, or its first 50 KB and a pointer to the session file. */
export function cutText(text: string, sessionFile: string | undefined): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_TEXT_BYTES) return text;
  // A character split at the cut decodes as U+FFFD; drop it.
  const kept = Buffer.from(text, "utf8").subarray(0, MAX_TEXT_BYTES).toString("utf8").replace(/�+$/, "");
  const where = sessionFile === undefined ? "The full text was not saved." : `The full text is in the worker's session file: ${sessionFile}`;
  return `${kept}\n\n[Cut at 50 KB. ${where}]`;
}

export interface SubagentResult extends WorkerResult {
  readonly task: string;
}

/** The tool result's `details`. */
export interface SubagentsDetails {
  readonly results: readonly SubagentResult[];
}

function resultText(result: SubagentResult): string {
  const outcome = result.status === "completed" ? "completed." : `${result.status}${result.error ? `: ${result.error}` : "."}`;
  return [
    `Worker ${result.sessionId} ${outcome}`,
    `Session file: ${result.sessionFile ?? "none, the session was not saved"}`,
    "",
    result.finalText,
  ].join("\n");
}

export interface SubagentsDependencies {
  /** Extensions each worker loads besides the installed ones. */
  readonly workerExtensions: readonly InlineExtension[];
}

export function createSubagentsExtension(overrides: Partial<SubagentsDependencies> = {}) {
  const deps: SubagentsDependencies = { workerExtensions: [], ...overrides };
  return function subagents(pi: ExtensionAPI): void {
    pi.registerTool({
      name: SUBAGENTS_TOOL,
      label: "Subagents",
      description: "Hand one task to a worker. The worker runs to its end and returns its final text, " +
        "its status and its session file. It sees only the task text, so put every fact it needs in it.",
      parameters: PARAMETERS,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { task } = params as { task: string };
        const worker = await runWorker({
          task, cwd: ctx.cwd, agentDir: personalAgentDir(), orchestratorSession: ctx.sessionManager, signal,
          extensionFactories: deps.workerExtensions,
        });
        const result: SubagentResult = { task, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
        const details: SubagentsDetails = { results: [result] };
        return { content: [{ type: "text", text: resultText(result) }], details };
      },
    });
  };
}

export default createSubagentsExtension();
