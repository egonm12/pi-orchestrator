import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendRoutingRecord, buildAgentModelRecord, buildForkRecord } from "../routing/decision-record.ts";
import { stateDir } from "../router/extension.ts";
import { markWorkerSession } from "./worker-sessions.ts";
import type { ThinkingLevel } from "../models/model-info.ts";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
  type ExtensionContext,
  type InlineExtension,
  type LoadExtensionsResult,
} from "@earendil-works/pi-coding-agent";

// One worker (ADR 0007): a pi session in the orchestrator's process, started
// through the SDK on the auto model unless an agent definition's model is
// preserved. pi's ModelRegistry keeps its runtime
// private, so the worker cannot reuse the orchestrator's. It gets its own
// model runtime instead, which pi builds from the same agent dir's auth.json
// and models.json, and it loads the same installed extensions. The router
// extension then registers `orchestrator/auto` in the worker's runtime and
// routes the worker as ADR 0006 describes.

export const SUBAGENTS_TOOL = "subagents";
const AUTO_PROVIDER = "orchestrator";
const AUTO_MODEL_ID = "auto";

export type WorkerStatus = "completed" | "failed" | "aborted";

export interface WorkerResult {
  readonly status: WorkerStatus;
  /** The worker's pi session id, which is the delegation id. */
  readonly sessionId: string;
  /** `undefined` when nothing was saved, as when the orchestrator's own
   *  session is not saved. */
  readonly sessionFile: string | undefined;
  /** The worker's last reply text; empty when it gave none. */
  readonly finalText: string;
  /** Why the worker failed, when it did. */
  readonly error?: string;
}

export interface WorkerSetup {
  readonly task: string;
  readonly cwd: string;
  /** The orchestrator's agent dir: its auth.json, models.json, settings and
   *  installed extensions. */
  readonly agentDir: string;
  readonly orchestratorSession: Pick<ExtensionContext["sessionManager"], "getSessionDir" | "getSessionId" | "getSessionFile">;
  readonly fork?: {
    readonly sessionManager: SessionManager;
    readonly model: string;
    readonly effort: ThinkingLevel;
    readonly parentSession: string;
    readonly forkPoint: string | null;
    readonly banListException: boolean;
  };
  readonly signal?: AbortSignal;
  /** Extensions the worker loads besides the installed ones. */
  readonly extensionFactories?: readonly InlineExtension[];
  /** An agent definition's instructions, appended to the worker's system prompt. */
  readonly instructions?: string;
  /** The only tools the worker may use; without it, pi's default tools and
   *  every extension tool. */
  readonly tools?: readonly string[];
  /** A preserved agent definition names a real model, so the auto router is
   *  bypassed. `banListException` is set when the model is on the subagent ban
   *  list and the owner's exception let it run. */
  readonly namedModel?: {
    readonly model: string; readonly effort?: ThinkingLevel; readonly agent: string; readonly definitionFile: string;
    readonly banListException?: boolean;
  };
  /** Called with a tool's name when the worker starts running it, and with
   *  the name of a tool still running, or `undefined`, when one ends. */
  readonly onTool?: (tool: string | undefined) => void;
}

/** Where a worker's session is saved: below the orchestrator's session
 *  folder, in a folder of its own, so pi's session list leaves it out. */
export function workerSessionDir(orchestratorSession: WorkerSetup["orchestratorSession"]): string {
  return join(orchestratorSession.getSessionDir(), "subagents", orchestratorSession.getSessionId());
}

/** Workers do not get the `subagents` tool (ADR 0007): the extension that
 *  registers it is left out of the worker's extensions. */
function withoutSubagentsTool(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.filter((extension) => !extension.tools.has(SUBAGENTS_TOOL)) };
}

interface Reply {
  readonly role?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
}

function errorText(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0] ?? "";
}

/** Run one worker to its end. Never throws: a failure is a `failed` result. */
export async function runWorker(setup: WorkerSetup): Promise<WorkerResult> {
  const sessionManager = setup.fork?.sessionManager ?? (setup.orchestratorSession.getSessionFile() === undefined
    ? SessionManager.inMemory(setup.cwd)
    : SessionManager.create(setup.cwd, workerSessionDir(setup.orchestratorSession)));
  const sessionId = sessionManager.getSessionId();
  const saved = (): string | undefined => {
    const file = sessionManager.getSessionFile();
    return file !== undefined && existsSync(file) ? file : undefined;
  };
  const failed = (error: string): WorkerResult => setup.signal?.aborted
    ? { status: "aborted", sessionId, sessionFile: saved(), finalText: "" }
    : { status: "failed", sessionId, sessionFile: saved(), finalText: "", error };

  const { instructions } = setup;
  let session: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];
  try {
    const services = await createAgentSessionServices({
      cwd: setup.cwd,
      agentDir: setup.agentDir,
      resourceLoaderOptions: {
        extensionFactories: [...(setup.extensionFactories ?? [])],
        extensionsOverride: withoutSubagentsTool,
        ...(instructions === undefined ? {} : { appendSystemPromptOverride: (base: string[]) => [...base, instructions] }),
      },
    });
    const { namedModel, fork } = setup;
    // The provider ends at the first slash; a model id may hold more.
    const selectedModel = fork?.model ?? namedModel?.model;
    const slash = selectedModel?.indexOf("/") ?? -1;
    const [provider, modelId] = selectedModel ? [selectedModel.slice(0, slash), selectedModel.slice(slash + 1)] : [AUTO_PROVIDER, AUTO_MODEL_ID];
    const model = services.modelRuntime.getModel(provider, modelId);
    if (model === undefined) {
      const loadErrors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error").map((diagnostic) => diagnostic.message);
      return failed([`${selectedModel ?? "orchestrator/auto"} is not in the worker's model runtime${selectedModel ? "" : "; is the router extension installed?"}`, ...loadErrors].join(" "));
    }
    session = (await createAgentSessionFromServices({
      services, sessionManager, model, ...((fork?.effort ?? namedModel?.effort) === undefined ? {} : { thinkingLevel: fork?.effort ?? namedModel?.effort }),
      ...(setup.tools === undefined ? {} : { tools: [...setup.tools] }),
    })).session;
    if (fork || namedModel) {
      try {
        appendRoutingRecord(join(stateDir(), "routing"), fork ? buildForkRecord({
          delegationId: sessionId, model: fork.model, effort: fork.effort,
          parentSession: fork.parentSession, forkPoint: fork.forkPoint, banListException: fork.banListException,
        }) : buildAgentModelRecord({
          delegationId: sessionId, agent: namedModel!.agent, definitionFile: namedModel!.definitionFile,
          model: namedModel!.model, effort: session.thinkingLevel,
          ...(namedModel!.banListException ? { banListException: true } : {}),
        }));
      } catch (error) {
        session.dispose();
        throw error;
      }
    }
  } catch (error) {
    return failed(errorText(error));
  }

  const abort = () => { void session.abort(); };
  const runningTools = new Map<string, string>();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") runningTools.set(event.toolCallId, event.toolName);
    else if (event.type === "tool_execution_end") runningTools.delete(event.toolCallId);
    else return;
    setup.onTool?.([...runningTools.values()].at(-1));
  });
  // Before binding, so the extensions see the mark at session_start.
  const unmarkWorkerSession = markWorkerSession(sessionId);
  try {
    // Binding starts the extensions: the router extension reads its settings
    // at session_start.
    await session.bindExtensions({});
    setup.signal?.addEventListener("abort", abort, { once: true });
    if (setup.signal?.aborted) return { status: "aborted", sessionId, sessionFile: saved(), finalText: "" };
    await session.prompt(setup.task);
    const replies = session.messages.filter((message) => (message as Reply).role === "assistant") as Reply[];
    const last = replies.at(-1);
    const finalText = session.getLastAssistantText() ?? "";
    if (setup.signal?.aborted || last?.stopReason === "aborted") return { status: "aborted", sessionId, sessionFile: saved(), finalText };
    if (last === undefined) return failed("the worker gave no reply");
    if (last.stopReason === "error") return { ...failed(last.errorMessage ?? "the worker's model call failed"), finalText };
    return { status: "completed", sessionId, sessionFile: saved(), finalText };
  } catch (error) {
    return failed(errorText(error));
  } finally {
    setup.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
    unmarkWorkerSession();
  }
}
