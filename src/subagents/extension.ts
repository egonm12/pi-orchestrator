import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { personalAgentDir, personalOrchestrator, readSettingsFile } from "../policy/ban-lists.ts";
import { agentDefinitionDirs, agentDefinitionListing, loadAgentDefinitions, resolveAgent } from "./agent-definitions.ts";
import { runWorker, SUBAGENTS_TOOL, type WorkerResult } from "./worker.ts";

// The subagents extension (ADR 0007): a third pi extension, separate from the
// router and the guard, with a `subagents` tool. Each call starts a worker in
// this pi process on the auto model `orchestrator/auto`, and the router
// extension routes it. A call queues up to eight tasks. A task may name an
// agent definition, which gives the worker its instructions and narrows its
// tools.

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** Plain JSON Schema: pi validates a schema without TypeBox's marker as it is
 *  (pi-ai's validateToolArguments), and TypeBox does not resolve from here. */
const PARAMETERS = {
  type: "object",
  properties: {
    items: { type: "array", minItems: 1, maxItems: 8, items: {
      type: "object", properties: {
        task: { type: "string", description: "The whole task for the worker, with every fact it needs. The worker sees nothing else." },
        agent: { type: "string", description: "Optional: the name of an agent definition the worker follows." },
      }, required: ["task"], additionalProperties: false,
    } },
  },
  required: ["items"],
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

/** One call item: its task and, optionally, the agent definition it names. */
interface SubagentItem {
  readonly task: string;
  readonly agent?: string;
}

/** An item's result. Only a started worker has a session id: an item whose
 *  agent is unknown fails before a worker starts, and an item still queued at
 *  abort is not started. */
export type SubagentResult =
  | (SubagentItem & WorkerResult)
  | (SubagentItem & {
    readonly status: "failed";
    readonly sessionId?: never;
    readonly sessionFile?: never;
    readonly finalText: "";
    readonly error: string;
  })
  | (SubagentItem & {
    readonly status: "not-started";
    readonly sessionId?: never;
    readonly sessionFile?: never;
    readonly finalText: "";
    readonly error?: never;
  });

/** The tool result's `details`. */
export interface SubagentsDetails {
  readonly results: readonly SubagentResult[];
}

function resultText(result: SubagentResult): string {
  if (result.status === "not-started") return `Worker not started: ${result.task}`;
  if (result.sessionId === undefined) return `No worker started: ${result.error}`;
  const outcome = result.status === "completed" ? "completed." : `${result.status}${result.error ? `: ${result.error}` : "."}`;
  return [
    `Worker ${result.sessionId} ${outcome}`,
    `Session file: ${result.sessionFile ?? "none, the session was not saved"}`,
    "",
    result.finalText,
  ].join("\n");
}

function maxParallel(agentDir: string, cwd: string): number {
  const personal = personalOrchestrator(readSettingsFile(join(agentDir, "settings.json")) ?? {})?.subagents;
  if (personal !== undefined && (typeof personal !== "object" || personal === null || Array.isArray(personal))) {
    throw new Error("orchestrator.subagents must be an object");
  }
  const personalOptions = personal as Record<string, unknown> | undefined;
  const allowProjectOverrides = personalOptions?.allowProjectOverrides === true;
  const project = allowProjectOverrides ? readSettingsFile(join(cwd, ".pi", "settings.json")) : undefined;
  const projectOptions = project === undefined ? undefined : personalOrchestrator(project)?.subagents;
  if (projectOptions !== undefined && (typeof projectOptions !== "object" || projectOptions === null || Array.isArray(projectOptions))) {
    throw new Error("project orchestrator.subagents must be an object");
  }
  const limit = (projectOptions as Record<string, unknown> | undefined)?.maxParallel ?? personalOptions?.maxParallel ?? 4;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1) {
    throw new Error("orchestrator.subagents.maxParallel must be a positive integer");
  }
  return Math.min(limit, 8);
}

export interface SubagentsDependencies {
  /** Extensions each worker loads besides the installed ones. */
  readonly workerExtensions: readonly InlineExtension[];
}

const DESCRIPTION = "Hand 1 to 8 tasks to workers. At most orchestrator.subagents.maxParallel run at once. " +
  "Results keep item order; abort stops running workers and leaves queued workers not started. " +
  "Each worker sees only its task text, so put every fact it needs in it. " +
  "An item's `agent` is optional: it names an agent definition, whose instructions the worker follows and whose tools list narrows the worker's tools. " +
  "An unknown agent fails that item without starting its worker.";

export function createSubagentsExtension(overrides: Partial<SubagentsDependencies> = {}) {
  const deps: SubagentsDependencies = { workerExtensions: [], ...overrides };
  return function subagents(pi: ExtensionAPI): void {
    const registerSubagentsTool = (description: string) => pi.registerTool({
      name: SUBAGENTS_TOOL,
      label: "Subagents",
      description,
      parameters: PARAMETERS,
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        const { items } = params as { items: SubagentItem[] };
        if (!Array.isArray(items) || items.length < 1 || items.length > 8) throw new Error("subagents requires 1 to 8 items per call");
        const agentDir = personalAgentDir();
        const limit = maxParallel(agentDir, ctx.cwd);
        const definitions = loadAgentDefinitions(agentDefinitionDirs(agentDir, ctx.cwd));
        const orchestratorTools = pi.getActiveTools();
        const results: SubagentResult[] = new Array(items.length);
        let next = 0;
        const runQueue = async () => {
          while (next < items.length) {
            if (signal?.aborted) return;
            const index = next++;
            const { task, agent } = items[index]!;
            const item: SubagentItem = { task, ...(agent === undefined ? {} : { agent }) };
            const resolution = resolveAgent(agent, definitions, orchestratorTools);
            if (!resolution.ok) {
              results[index] = { ...item, status: "failed", finalText: "", error: resolution.error };
              continue;
            }
            const worker = await runWorker({
              task, cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager, signal,
              extensionFactories: deps.workerExtensions, instructions: resolution.instructions, tools: resolution.tools,
            });
            results[index] = { ...item, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
          }
        };
        await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runQueue()));
        for (let index = 0; index < items.length; index++) {
          const { task, agent } = items[index]!;
          results[index] ??= { task, ...(agent === undefined ? {} : { agent }), status: "not-started", finalText: "" };
        }
        const details: SubagentsDetails = { results };
        return { content: [{ type: "text", text: results.map(resultText).join("\n\n") }], details };
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
