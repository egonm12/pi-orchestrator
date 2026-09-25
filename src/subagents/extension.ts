import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { agentDefinitionDirs, agentDefinitionListing, loadAgentDefinitions, resolveAgent } from "./agent-definitions.ts";
import { runWorker, SUBAGENTS_TOOL, type WorkerResult } from "./worker.ts";

// The subagents extension (ADR 0007): a third pi extension, separate from the
// router and the guard, with a `subagents` tool. Each call starts a worker in
// this pi process on the auto model `orchestrator/auto`, and the router
// extension routes it. This first version runs one task per call. A task
// may name an agent definition, which gives the worker its instructions and
// narrows its tools.

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** Plain JSON Schema: pi validates a schema without TypeBox's marker as it is
 *  (pi-ai's validateToolArguments), and TypeBox does not resolve from here. */
const PARAMETERS = {
  type: "object",
  properties: {
    task: { type: "string", description: "The whole task for the worker, with every fact it needs. The worker sees nothing else." },
    agent: { type: "string", description: "Optional: the name of an agent definition the worker follows." },
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

export interface SubagentResult extends Omit<WorkerResult, "sessionId"> {
  readonly task: string;
  readonly agent?: string;
  /** `undefined` when the item failed before a worker started. */
  readonly sessionId: string | undefined;
}

/** The tool result's `details`. */
export interface SubagentsDetails {
  readonly results: readonly SubagentResult[];
}

function resultText(result: SubagentResult): string {
  if (result.sessionId === undefined) return `No worker started: ${result.error ?? "the item failed."}`;
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

const DESCRIPTION = "Hand one task to a worker. The worker runs to its end and returns its final text, " +
  "its status and its session file. It sees only the task text, so put every fact it needs in it. " +
  "`agent` is optional: it names an agent definition, whose instructions the worker follows and whose tools list narrows the worker's tools.";

export function createSubagentsExtension(overrides: Partial<SubagentsDependencies> = {}) {
  const deps: SubagentsDependencies = { workerExtensions: [], ...overrides };
  return function subagents(pi: ExtensionAPI): void {
    const registerSubagentsTool = (description: string) => pi.registerTool({
      name: SUBAGENTS_TOOL,
      label: "Subagents",
      description,
      parameters: PARAMETERS,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { task, agent } = params as { task: string; agent?: string };
        const item = { task, ...(agent === undefined ? {} : { agent }) };
        const agentDir = personalAgentDir();
        const definitions = loadAgentDefinitions(agentDefinitionDirs(agentDir, ctx.cwd));
        const resolution = resolveAgent(agent, definitions, pi.getActiveTools());
        let result: SubagentResult;
        if (resolution.ok) {
          const worker = await runWorker({
            task, cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager, signal,
            extensionFactories: deps.workerExtensions, instructions: resolution.instructions, tools: resolution.tools,
          });
          result = { ...item, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
        } else {
          result = { ...item, status: "failed", sessionId: undefined, sessionFile: undefined, finalText: "", error: resolution.error };
        }
        const details: SubagentsDetails = { results: [result] };
        return { content: [{ type: "text", text: resultText(result) }], details };
      },
    });
    // Registered at load, so a worker's extension set can leave this extension
    // out by its tool. The listing of agent definitions follows at session start,
    // when the project's folder is known.
    registerSubagentsTool(DESCRIPTION);
    pi.on("session_start", (_event, ctx) => {
      const definitions = loadAgentDefinitions(agentDefinitionDirs(personalAgentDir(), ctx.cwd));
      registerSubagentsTool(`${DESCRIPTION}\n\n${agentDefinitionListing(definitions)}`);
    });
  };
}

export default createSubagentsExtension();
