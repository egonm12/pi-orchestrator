import { join } from "node:path";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { banListsFromSettings, personalAgentDir, personalOrchestrator, readSettingsFile, subagentBanListEntry } from "../policy/ban-lists.ts";
import { THINKING_LEVELS, splitKnownThinkingSuffix, type ThinkingLevel } from "../models/model-info.ts";
import { agentDefinitionDirs, agentDefinitionListing, loadAgentDefinitions, resolveAgent } from "./agent-definitions.ts";
import { renderSubagentsCall, renderSubagentsResult } from "./render.ts";
import { runWorker, SUBAGENTS_TOOL, type WorkerResult } from "./worker.ts";

// The subagents extension (ADR 0007): a third pi extension, separate from the
// router and the guard, with a `subagents` tool. Each call starts a worker in
// this pi process, normally on the auto model `orchestrator/auto`, and the
// router extension routes it. A call queues up to eight tasks. A task may name an
// agent definition, which gives the worker its instructions and narrows its
// tools. While the call runs, partial updates show each item queued, running
// with its worker's current tool, or finished (render.ts draws them).

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

/** The model a worker ran on when its agent definition named one and the
 *  model was preserved, not routed (ADR 0007), and whether the subagent ban
 *  list's exception let it run. Absent for a routed worker. */
interface PreservedModel {
  readonly model?: string;
  readonly banListException?: boolean;
}

/** An item's result. Only a started worker has a session id: an item whose
 *  agent is unknown fails before a worker starts, and an item still queued at
 *  abort is not started. */
export type SubagentResult = PreservedModel & (
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
  }));

/** The tool result's `details`. */
export interface SubagentsDetails {
  readonly results: readonly SubagentResult[];
}

/** An item while its call runs: queued, running (with the tool its worker is
 *  in, if any), or finished with its result. */
export type SubagentProgress =
  | (SubagentItem & { readonly status: "queued" })
  | (SubagentItem & PreservedModel & { readonly status: "running"; readonly tool?: string })
  | SubagentResult;

/** A partial result's `details`, sent through `onUpdate` while the call runs.
 *  The final `details` is a `SubagentsDetails`, which is one of these too. */
export interface SubagentsProgressDetails {
  readonly results: readonly SubagentProgress[];
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

function agentModelSettings(agentDir: string): { use: "route" | "preserve"; banned: readonly string[] } {
  const personal = readSettingsFile(join(agentDir, "settings.json")) ?? {};
  const options = personalOrchestrator(personal)?.subagents;
  if (options !== undefined && (typeof options !== "object" || options === null || Array.isArray(options))) {
    throw new Error("orchestrator.subagents must be an object");
  }
  const config = (options as Record<string, unknown> | undefined)?.agentDefinitionModel;
  if (config !== undefined && (typeof config !== "object" || config === null || Array.isArray(config))) {
    throw new Error("orchestrator.subagents.agentDefinitionModel must be an object");
  }
  const use = (config as Record<string, unknown> | undefined)?.use ?? "route";
  if (use !== "route" && use !== "preserve") throw new Error("orchestrator.subagents.agentDefinitionModel.use must be route or preserve");
  return { use, banned: banListsFromSettings(personal).banLists.subagentBanList };
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
    const warnedSessions = new Set<string>();
    const registerSubagentsTool = (description: string) => pi.registerTool({
      name: SUBAGENTS_TOOL,
      label: "Subagents",
      description,
      parameters: PARAMETERS,
      async execute(_toolCallId, params, signal, onUpdate, ctx) {
        const { items } = params as { items: SubagentItem[] };
        if (!Array.isArray(items) || items.length < 1 || items.length > 8) throw new Error("subagents requires 1 to 8 items per call");
        const agentDir = personalAgentDir();
        const limit = maxParallel(agentDir, ctx.cwd);
        const modelSettings = agentModelSettings(agentDir);
        const definitions = loadAgentDefinitions(agentDefinitionDirs(agentDir, ctx.cwd));
        const orchestratorTools = pi.getActiveTools();
        const results: SubagentResult[] = new Array(items.length);
        const progress: SubagentProgress[] = items.map(({ task, agent }) => ({ task, ...(agent === undefined ? {} : { agent }), status: "queued" }));
        const sendProgress = () => {
          const done = progress.filter((item) => item.status !== "queued" && item.status !== "running").length;
          const update: SubagentsProgressDetails = { results: [...progress] };
          onUpdate?.({ content: [{ type: "text", text: `${done}/${items.length} workers done` }], details: update });
        };
        const showProgress = (index: number, state: SubagentProgress) => {
          progress[index] = state;
          sendProgress();
        };
        sendProgress();
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
              showProgress(index, results[index]);
              continue;
            }
            const definition = resolution.definition;
            if (modelSettings.use === "route" && definition && (definition.model || definition.thinking)) {
              const sessionId = ctx.sessionManager.getSessionId();
              if (!warnedSessions.has(sessionId)) {
                warnedSessions.add(sessionId);
                const warning = "pi-orchestrator subagents: agent definition model and thinking are ignored under route mode";
                if (ctx.hasUI && ctx.ui) ctx.ui.notify(warning, "warning");
                else process.stderr.write(`${warning}\n`);
              }
            }
            let namedModel: { model: string; effort?: ThinkingLevel; agent: string; definitionFile: string } | undefined;
            if (modelSettings.use === "preserve" && definition?.model) {
              const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(definition.model);
              const [provider, ...parts] = baseModel.split("/");
              if (!provider || parts.length !== 1 || !parts[0]) {
                results[index] = { ...item, status: "failed", finalText: "", error: `agent ${definition.name} must name a provider/model` };
                showProgress(index, results[index]);
                continue;
              }
              const banned = subagentBanListEntry(baseModel, { subagentBanList: modelSettings.banned, sessionBanList: [] });
              if (banned) {
                results[index] = { ...item, status: "failed", finalText: "", error: `agent ${definition.name} model ${baseModel} is on the subagent ban list (entry '${banned}')` };
                showProgress(index, results[index]);
                continue;
              }
              const effort = definition.thinking ?? (thinkingSuffix ? thinkingSuffix.slice(1) : undefined);
              if (effort !== undefined && !THINKING_LEVELS.includes(effort as ThinkingLevel)) {
                results[index] = { ...item, status: "failed", finalText: "", error: `agent ${definition.name} has invalid thinking level ${effort}` };
                showProgress(index, results[index]);
                continue;
              }
              namedModel = { model: baseModel, ...(effort === undefined ? {} : { effort: effort as ThinkingLevel }), agent: definition.name, definitionFile: definition.file };
            }
            const preservedModel = namedModel === undefined ? {} : { model: namedModel.model };
            showProgress(index, { ...item, ...preservedModel, status: "running" });
            const worker = await runWorker({
              task, cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager, signal,
              extensionFactories: deps.workerExtensions, instructions: resolution.instructions, tools: resolution.tools,
              ...(namedModel === undefined ? {} : { namedModel }),
              onTool: (tool) => showProgress(index, { ...item, ...preservedModel, status: "running", ...(tool === undefined ? {} : { tool }) }),
            });
            results[index] = { ...item, ...preservedModel, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
            showProgress(index, results[index]);
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
      renderCall: (args, theme) => renderSubagentsCall(args, theme),
      renderResult: (result, options, theme) => renderSubagentsResult(result, options, theme),
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
