import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendRoutingRecord, buildAgentModelRecord, buildForkRecord } from "../routing/decision-record.ts";
import { stateDir } from "../router/extension.ts";
import { markWorkerSession } from "./worker-sessions.ts";
import type { ResumeWorker } from "./resume.ts";
import { setResumePin } from "../router/auto-provider.ts";
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
  readonly resume?: ResumeWorker;
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
  /** The worker's session id, which is its delegation id, when it is chosen
   *  before the worker starts, as for a background call. */
  readonly sessionId?: string;
  /** Extensions the worker loads besides the installed ones. */
  readonly extensionFactories?: readonly InlineExtension[];
  /** An agent definition's instructions, appended to the worker's system prompt. */
  readonly instructions?: string;
  /** The only tools the worker may use; without it, pi's default tools and
   *  every extension tool except the subagents tool. Only a list naming the
   *  subagents tool gives it to the worker (ADR 0008). */
  readonly tools?: readonly string[];
  /** The delegation id of the worker that makes this delegation, if a worker does. */
  readonly parentDelegationId?: string;
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
  /** Called when the worker starts, as its turns and text move on, and once more when it ends. */
  readonly onActivity?: (activity: WorkerActivity) => void;
}

/** What a worker has done so far, for `subagents_status`. */
export interface WorkerActivity {
  /** Where its session is saved; `undefined` for a session that is not saved. */
  readonly sessionFile: string | undefined;
  /** The turns it has started. */
  readonly turns: number;
  /** Its latest assistant message's text; empty until it writes any. */
  readonly text: string;
  readonly ended: boolean;
}

/** Where a worker's session is saved: below the orchestrator's session
 *  folder, in a folder of its own, so pi's session list leaves it out. */
export function workerSessionDir(orchestratorSession: WorkerSetup["orchestratorSession"]): string {
  return join(orchestratorSession.getSessionDir(), "subagents", orchestratorSession.getSessionId());
}

/** A worker does not get the `subagents` tool unless its tools list names it
 *  (ADR 0007, ADR 0008): the extension that registers it is left out of the
 *  worker's extensions. */
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

interface AssistantText {
  readonly role?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
}

/** An assistant message's text; empty for any other message. */
function assistantText(message: AssistantText): string {
  if (message.role !== "assistant" || message.content === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
}

/** A running worker's activity so far, which `runWorkerSession` moves on. */
interface ActivitySoFar {
  sessionFile: string | undefined;
  turns: number;
  text: string;
}

/** Run one worker to its end. Never throws: a failure is a `failed` result. */
export async function runWorker(setup: WorkerSetup): Promise<WorkerResult> {
  const activity: ActivitySoFar = { sessionFile: undefined, turns: 0, text: "" };
  const report = (ended: boolean) => setup.onActivity?.({ ...activity, ended });
  try {
    return await runWorkerSession(setup, activity, () => report(false));
  } finally { report(true); }
}

/** `runWorker`'s body: it moves `activity` on and calls `report` at each step. */
async function runWorkerSession(setup: WorkerSetup, activity: ActivitySoFar, report: () => void): Promise<WorkerResult> {
  // A fork's session is copied beforehand, already carrying any background delegation id;
  // a resumed worker reopens its saved session.
  const sessionOptions = setup.sessionId === undefined ? undefined : { id: setup.sessionId };
  const sessionManager = setup.resume
    ? SessionManager.open(setup.resume.file, workerSessionDir(setup.orchestratorSession), setup.cwd)
    : setup.fork?.sessionManager ?? (setup.orchestratorSession.getSessionFile() === undefined
      ? SessionManager.inMemory(setup.cwd, sessionOptions)
      : SessionManager.create(setup.cwd, workerSessionDir(setup.orchestratorSession), sessionOptions));
  const sessionId = sessionManager.getSessionId();
  activity.sessionFile = sessionManager.getSessionFile();
  report();
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
        ...(setup.tools?.includes(SUBAGENTS_TOOL) ? {} : { extensionsOverride: withoutSubagentsTool }),
        ...(instructions === undefined ? {} : { appendSystemPromptOverride: (base: string[]) => [...base, instructions] }),
      },
    });
    const { fork } = setup;
    const namedModel = setup.resume?.namedModel ?? setup.namedModel;
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
    // A resume writes no new record: the delegation keeps its original one.
    if ((fork || namedModel) && !setup.resume) {
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
    if (event.type === "turn_start") {
      activity.turns++;
      report();
      return;
    }
    if (event.type === "message_update" || event.type === "message_end") {
      const text = assistantText(event.message as AssistantText);
      if (text !== "" && text !== activity.text) {
        activity.text = text;
        report();
      }
      return;
    }
    if (event.type === "tool_execution_start") runningTools.set(event.toolCallId, event.toolName);
    else if (event.type === "tool_execution_end") runningTools.delete(event.toolCallId);
    else return;
    setup.onTool?.([...runningTools.values()].at(-1));
  });
  // Before binding, so the extensions see the mark at session_start.
  const unmarkWorkerSession = markWorkerSession(sessionId, setup.parentDelegationId);
  const unsetResumePin = setup.resume && !setup.resume.namedModel ? setResumePin(sessionId, setup.resume.pin) : undefined;
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
    unsetResumePin?.();
    unmarkWorkerSession();
  }
}
