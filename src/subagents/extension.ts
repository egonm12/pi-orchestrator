import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { banListsFromSettings, personalAgentDir, readSettingsFile, subagentBanListEntry } from "../policy/ban-lists.ts";
import { THINKING_LEVELS, splitKnownThinkingSuffix, type ThinkingLevel } from "../models/model-info.ts";
import { agentDefinitionDirs, agentDefinitionListing, loadAgentDefinitions, resolveAgent } from "./agent-definitions.ts";
import { callingDelegation } from "./nested-delegation.ts";
import { BackgroundCalls, type BackgroundCallResult } from "./background.ts";
import { renderSubagentsCall, renderSubagentsResult } from "./render.ts";
import { forkSession } from "./fork-session.ts";
import { prepareResume, saveWorkerOutcome } from "./resume.ts";
import { loadSubagentsSettings } from "./settings.ts";
import { registerSubagentsStatusTool } from "./status.ts";
import { runWorker, SUBAGENTS_TOOL, type WorkerResult, type WorkerSetup } from "./worker.ts";

// The subagents extension (ADR 0007): a third pi extension, separate from the
// router and the guard, with a `subagents` tool. Each call starts a worker in
// this pi process, normally on the auto model `orchestrator/auto`, and the
// router extension routes it. A call queues up to eight tasks. A task may name an
// agent definition, which gives the worker its instructions and narrows its
// tools; one listing `subagents` lets the worker delegate one level deeper
// (nested-delegation.ts). While the call runs, partial updates show each item
// queued, running with its worker's current tool, or finished (render.ts
// draws them).

type ToolParameters = Parameters<ExtensionAPI["registerTool"]>[0]["parameters"];

/** Plain JSON Schema: pi validates a schema without TypeBox's marker as it is
 *  (pi-ai's validateToolArguments), and TypeBox does not resolve from here. */
const PARAMETERS = {
  type: "object",
  properties: {
    items: { type: "array", minItems: 1, maxItems: 8, items: {
      type: "object", properties: {
        task: { type: "string", description: "The whole task for an ordinary worker. Forks also see the current branch." },
        agent: { type: "string", description: "Optional: the name of an agent definition the worker follows." },
        fork: { type: "boolean", description: "Start from the orchestrator's current branch on its session model." },
        resume: { type: "string", description: "Continue a finished delegation by id, in its saved session and on its original pin." },
      }, required: ["task"], additionalProperties: false,
    } },
    background: { type: "boolean", description: "Optional: return at once with the call id and delegation ids; one completion notice with the results follows when every item has finished." },
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
  readonly fork?: boolean;
  readonly resume?: string;
}

/** The model an unrouted worker used, and whether its exception to the
 *  subagent ban list let it run. Absent for a routed worker. */
interface WorkerModelDetails {
  readonly model?: string;
  readonly banListException?: boolean;
  readonly fork?: boolean;
}

/** An item's result. Only a started worker has a session id: an item whose
 *  agent is unknown fails before a worker starts, and an item still queued at
 *  abort is not started. */
export type SubagentResult = WorkerModelDetails & (
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
  | (SubagentItem & WorkerModelDetails & { readonly status: "queued" })
  | (SubagentItem & WorkerModelDetails & { readonly status: "running"; readonly tool?: string })
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

/** The background call's result `details`: its call id and each item's delegation id, in item order. */
export interface SubagentsBackgroundDetails {
  readonly callId: string;
  readonly delegationIds: readonly string[];
}

/** The custom message type of a background call's completion notice. */
export const COMPLETION_NOTICE = "subagents-completion";

/** The subagent ban list from personal settings; a project may not change it (ADR 0002). */
function personalSubagentBanList(agentDir: string): readonly string[] {
  return banListsFromSettings(readSettingsFile(join(agentDir, "settings.json")) ?? {}).banLists.subagentBanList;
}

export interface SubagentsDependencies {
  /** Extensions each worker loads besides the installed ones. */
  readonly workerExtensions: readonly InlineExtension[];
}

const DESCRIPTION = "Hand 1 to 8 tasks to workers. At most orchestrator.subagents.maxParallel run at once. " +
  "Results keep item order; abort stops running workers and leaves queued workers not started. " +
  "An ordinary worker sees only its task text, so put every fact it needs in it. " +
  "An item's `agent` is optional: it names an agent definition, whose instructions the worker follows and whose tools list narrows the worker's tools. " +
  "An unknown agent fails that item without starting its worker. " +
  "Set `fork: true` to copy the current branch before this call and run on the session model and effort, without routing. " +
  "With `background: true` the call returns at once with its call id and delegation ids, and one completion notice with the results follows when every item has finished; " +
  "at most orchestrator.subagents.maxBackgroundWorkers background workers may be queued or running at once. " +
  "Use `resume` with `task` (without `agent`) to continue a finished saved worker on its original pin.";

export function createSubagentsExtension(overrides: Partial<SubagentsDependencies> = {}) {
  const deps: SubagentsDependencies = { workerExtensions: [], ...overrides };
  return function subagents(pi: ExtensionAPI): void {
    // Each warning is shown once per orchestrator session.
    const warned = new Set<string>();
    const warnOnce = (ctx: ExtensionContext, warning: string) => {
      const key = `${ctx.sessionManager.getSessionId()}\n${warning}`;
      if (warned.has(key)) return;
      warned.add(key);
      if (ctx.hasUI && ctx.ui) ctx.ui.notify(warning, "warning");
      else process.stderr.write(`${warning}\n`);
    };
    const logged = new Set<string>();
    const logOnce = (line: string) => {
      if (logged.has(line)) return;
      logged.add(line);
      process.stderr.write(`pi-orchestrator subagents: ${line}\n`);
    };
    const backgroundCalls = new BackgroundCalls(({ text, details }, startTurn) => pi.sendMessage(
      { customType: COMPLETION_NOTICE, content: text, display: true, details },
      startTurn ? { triggerTurn: true, deliverAs: "followUp" } : { triggerTurn: false },
    ));
    const registerSubagentsTool = (description: string) => pi.registerTool({
      name: SUBAGENTS_TOOL,
      label: "Subagents",
      description,
      parameters: PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const { items, background = false } = params as { items: SubagentItem[]; background?: boolean };
        if (!Array.isArray(items) || items.length < 1 || items.length > 8) throw new Error("subagents requires 1 to 8 items per call");
        const parentDelegationId = callingDelegation(ctx, params as { background?: unknown; items?: unknown });
        const agentDir = personalAgentDir();
        const { settings, allowProjectOverrides, ignoredProjectKeys } = loadSubagentsSettings(agentDir, ctx.cwd);
        for (const key of ignoredProjectKeys) logOnce(`ignored project settings key ${key}`);
        if (background) backgroundCalls.assertRoom(items.length, settings.maxBackgroundWorkers);
        const limit = settings.maxParallel;
        const modelSettings = { ...settings.agentDefinitionModel, banned: personalSubagentBanList(agentDir) };
        if (modelSettings.use === "route" && modelSettings.allowBanned) {
          warnOnce(ctx, "pi-orchestrator subagents: agentDefinitionModel.allowBanned has no effect under route mode");
        }
        const definitionDirs = agentDefinitionDirs(agentDir, ctx.cwd);
        const definitions = loadAgentDefinitions(definitionDirs);
        const orchestratorTools = pi.getActiveTools();
        const results: SubagentResult[] = new Array(items.length);
        // Snapshot every fork before the queue runs: a later model switch or
        // parent turn cannot change a queued fork's pin or branch.
        // A background call's delegation ids are chosen now, so a fork's copied session can carry its id.
        // A resume item's delegation id is the one it resumes.
        const delegationIds = background ? items.map((item) => item.resume ?? randomUUID()) : undefined;
        const forks = items.map((item, index) => {
          if (item.fork !== true || item.resume !== undefined || !resolveAgent(item.agent, definitions, orchestratorTools).ok) return undefined;
          try {
            if (!ctx.model) throw new Error("the session has no model to fork");
            const model = `${ctx.model.provider}/${ctx.model.id}`;
            const { sessionManager, forkPoint } = forkSession(ctx, toolCallId, delegationIds?.[index]);
            const banned = subagentBanListEntry(model, { subagentBanList: modelSettings.banned, sessionBanList: [] });
            return { sessionManager, model, effort: ctx.thinkingLevel ?? "off", parentSession: ctx.sessionManager.getSessionId(), forkPoint,
              banListException: banned !== undefined } as const;
          } catch (error) { return { error: error instanceof Error ? error.message : String(error) } as const; }
        });
        const progress: SubagentProgress[] = items.map(({ task, agent, fork, resume }, index) => ({ task, ...(agent === undefined ? {} : { agent }),
          ...(fork === true ? { fork: true } : {}), ...(resume === undefined ? {} : { resume }),
          ...(forks[index]?.model === undefined ? {} : { model: forks[index].model,
            ...(forks[index].banListException ? { banListException: true } : {}) }), status: "queued" }));
        const sendProgress = () => {
          const done = progress.filter((item) => item.status !== "queued" && item.status !== "running").length;
          const update: SubagentsProgressDetails = { results: [...progress] };
          // A background call has returned, so its progress has no tool result to update.
          if (!background) onUpdate?.({ content: [{ type: "text", text: `${done}/${items.length} workers done` }], details: update });
        };
        const showProgress = (index: number, state: SubagentProgress) => {
          progress[index] = state;
          sendProgress();
        };
        sendProgress();
        // A background call's workers stop on its own signals, not on the tool's.
        const backgroundCall = background ? backgroundCalls.start({ callId: toolCallId, progress, delegationIds: delegationIds! }) : undefined;
        const callSignal = backgroundCall ? backgroundCall.callSignal : signal;
        const itemSignals = backgroundCall?.itemSignals;
        let next = 0;
        const runQueue = async () => {
          while (next < items.length) {
            if (callSignal?.aborted) return;
            const index = next++;
            if (itemSignals?.[index]?.aborted) continue;
            const { task, agent, fork, resume } = items[index]!;
            const item: SubagentItem = { task, ...(agent === undefined ? {} : { agent }), ...(fork === true ? { fork: true } : {}),
              ...(resume === undefined ? {} : { resume }) };
            if (resume !== undefined) {
              let releaseResume: (() => void) | undefined;
              try {
                if (agent !== undefined || fork !== undefined) throw new Error("resume excludes agent and fork");
                const prepared = prepareResume(resume, task, { cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager });
                releaseResume = prepared.release;
                showProgress(index, { ...item, status: "running" });
                const worker = await runWorker({ task, resume: prepared, cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager,
                  signal: itemSignals?.[index] ?? callSignal, extensionFactories: deps.workerExtensions, instructions: prepared.instructions, tools: prepared.tools,
                  onActivity: backgroundCall?.onActivity[index],
                  onTool: (tool) => showProgress(index, { ...item, status: "running", ...(tool === undefined ? {} : { tool }) }),
                });
                saveWorkerOutcome(worker.sessionFile, worker.status);
                results[index] = { ...item, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
              } catch (error) {
                results[index] = { ...item, status: "failed", finalText: "", error: error instanceof Error ? error.message : String(error) };
              } finally { releaseResume?.(); }
              showProgress(index, results[index]);
              continue;
            }
            const preparedFork = forks[index];
            if (preparedFork?.error !== undefined) {
              results[index] = { ...item, status: "failed", finalText: "", error: preparedFork.error };
              showProgress(index, results[index]);
              continue;
            }
            // Forked workers never delegate (ADR 0008), whatever their definition lists.
            const resolution = resolveAgent(agent, definitions, orchestratorTools, parentDelegationId === undefined && !preparedFork);
            if (!resolution.ok) {
              results[index] = { ...item, status: "failed", finalText: "", error: resolution.error };
              showProgress(index, results[index]);
              continue;
            }
            const definition = resolution.definition;
            if (!preparedFork && modelSettings.use === "route" && definition && (definition.model || definition.thinking)) {
              warnOnce(ctx, "pi-orchestrator subagents: agent definition model and thinking are ignored under route mode");
            }
            let namedModel: NonNullable<WorkerSetup["namedModel"]> | undefined;
            // A worker's own workers are always routed (ADR 0008).
            if (!preparedFork && modelSettings.use === "preserve" && definition?.model && parentDelegationId === undefined) {
              const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(definition.model);
              // The provider ends at the first slash; a model id may hold more.
              const slash = baseModel.indexOf("/");
              if (slash <= 0 || slash === baseModel.length - 1) {
                results[index] = { ...item, status: "failed", finalText: "", error: `agent ${definition.name} must name a provider/model` };
                showProgress(index, results[index]);
                continue;
              }
              const banned = subagentBanListEntry(baseModel, { subagentBanList: modelSettings.banned, sessionBanList: [] });
              // The ban-list exception (ADR 0002 follow-up): a project's definition also needs allowProjectOverrides.
              const banListException = banned !== undefined && modelSettings.allowBanned &&
                (dirname(definition.file) === definitionDirs.personal || allowProjectOverrides);
              if (banned && !banListException) {
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
              namedModel = { model: baseModel, ...(effort === undefined ? {} : { effort: effort as ThinkingLevel }), agent: definition.name, definitionFile: definition.file,
                ...(banListException ? { banListException: true } : {}) };
            }
            const workerModel: WorkerModelDetails = preparedFork ? { fork: true, model: preparedFork.model,
              ...(preparedFork.banListException ? { banListException: true } : {}) } : namedModel === undefined ? {}
              : { model: namedModel.model, ...(namedModel.banListException ? { banListException: true } : {}) };
            showProgress(index, { ...item, ...workerModel, status: "running" });
            const worker = await runWorker({
              task, cwd: ctx.cwd, agentDir, orchestratorSession: ctx.sessionManager, signal: itemSignals?.[index] ?? callSignal,
              ...(backgroundCall === undefined ? {} : { sessionId: backgroundCall.delegationIds[index]! }),
              extensionFactories: deps.workerExtensions, instructions: resolution.instructions, tools: resolution.tools,
              ...(namedModel === undefined ? {} : { namedModel }),
              ...(preparedFork === undefined ? {} : { fork: preparedFork }),
              ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
              onActivity: backgroundCall?.onActivity[index],
              onTool: (tool) => showProgress(index, { ...item, ...workerModel, status: "running", ...(tool === undefined ? {} : { tool }) }),
            });
            saveWorkerOutcome(worker.sessionFile, worker.status, { instructions: resolution.instructions, tools: resolution.tools });
            results[index] = { ...item, ...workerModel, ...worker, finalText: cutText(worker.finalText, worker.sessionFile) };
            showProgress(index, results[index]);
          }
        };
        const lanes = Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runQueue()));
        const finishCall = async (): Promise<BackgroundCallResult> => {
          await lanes;
          for (let index = 0; index < items.length; index++) {
            const { task, agent, fork, resume } = items[index]!;
            if (results[index] === undefined) {
              const file = forks[index]?.sessionManager?.getSessionFile();
              if (file !== undefined) rmSync(file, { force: true });
              results[index] = { task, ...(agent === undefined ? {} : { agent }), ...(fork === true ? { fork: true } : {}), ...(resume === undefined ? {} : { resume }), status: "not-started", finalText: "" };
            }
          }
          const details: SubagentsDetails = { results };
          return { text: results.map(resultText).join("\n\n"), details };
        };
        if (backgroundCall) {
          backgroundCall.finish(finishCall());
          const { delegationIds } = backgroundCall;
          const details: SubagentsBackgroundDetails = { callId: toolCallId, delegationIds };
          const text = [`Background subagents call ${toolCallId} started. Delegation ids, in item order:`, ...delegationIds,
            "A completion notice with the results follows when every item has finished."].join("\n");
          return { content: [{ type: "text", text }], details };
        }
        const { text, details } = await finishCall();
        return { content: [{ type: "text", text }], details };
      },
      renderCall: (args, theme) => renderSubagentsCall(args, theme),
      renderResult: (result, options, theme) => renderSubagentsResult(result, options, theme),
    });
    // Registered at load, so a worker's extension set can leave this extension
    // out by its tool. The listing of agent definitions follows at session start,
    // when the project's folder is known.
    registerSubagentsTool(DESCRIPTION);
    pi.registerCommand("subagents", {
      description: "List this session's background subagents calls, or stop one: /subagents stop <call id | delegation id | all>",
      handler: async (args, ctx) => { ctx.ui.notify(backgroundCalls.command(args), "info"); },
    });
    registerSubagentsStatusTool(pi, backgroundCalls);
    // Ctrl+C leaves background workers running; the session's end stops them.
    pi.on("session_shutdown", () => backgroundCalls.shutdown());
    pi.on("session_start", (_event, ctx) => {
      const definitions = loadAgentDefinitions(agentDefinitionDirs(personalAgentDir(), ctx.cwd));
      registerSubagentsTool(`${DESCRIPTION}\n\n${agentDefinitionListing(definitions)}`);
    });
  };
}

export default createSubagentsExtension();
