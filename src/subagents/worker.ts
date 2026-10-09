import { existsSync } from "node:fs";
import { join } from "node:path";
import { appendRoutingRecord, buildAgentModelRecord, buildForkRecord } from "../routing/decision-record.ts";
import { stateDir } from "../router/extension.ts";
import { markWorkerSession, reviewedDelegationOf } from "./worker-sessions.ts";
import { READ_ONLY_REVIEWER, trackEdits } from "./editing.ts";
import type { ResumeWorker } from "./resume.ts";
import type { BackgroundMessageMode } from "./background.ts";
import { REPORT_TOOL, reportExtension, type WorkerReports } from "./report.ts";
import { SUBAGENTS_VERDICT_TOOL } from "./verdict.ts";
import { missingResultSections, REPORTING_RULES, type ResultSection } from "./result-format.ts";
import { AUTO_MODEL_ID, AUTO_PROVIDER, requestFailover, setCarriedClassification, setPendingTask, setRoutingConstraints } from "../router/auto-model.ts";
import { limitErrorObservation } from "../router/limit-errors.ts";
import type { TierClassification } from "../routing/tier-classifier.ts";
import type { RoutingConstraints } from "../routing/tier-router.ts";
import type { ThinkingLevel } from "../models/model-info.ts";
import type { WorkerSession } from "./worker-board.ts";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  SessionManager,
  SettingsManager,
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
// extension then registers `orchestrator/auto` in the worker's runtime as a
// virtual model and routes the worker as ADR 0006 and ADR 0014 describe.

export const SUBAGENTS_TOOL = "subagents";

/** The built-in extensions pi's CLI loads for its own sessions besides the
 *  installed ones, which an SDK session only gets when its resource loader is
 *  given them: codemode, tool_search and MCP, in the CLI's order and with its
 *  flags. As `builtin:<name>` resources they load after project trust and obey
 *  the `extensions` setting (`-builtin:mcp` turns one off), and as replaceable
 *  ones they give way to an installed extension that registers the same tool or
 *  command, as a third-party MCP extension does. The tools register inactive;
 *  pi's `defaultTools` setting, an agent definition's tools list, or the MCP
 *  extension, which activates codemode or tool_search for the MCP tools that
 *  need it, activates them, as in the orchestrator. pi's llama.cpp built-in is
 *  not exported, so a worker goes without it. */
export function workerBuiltinExtensions(): InlineExtension[] {
  return [
    { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
    { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
    { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
  ];
}

/** The built-in extensions a worker adds to `given`: those `given` does not
 *  already supply under the same built-in name. */
function builtinExtensionsBesides(given: readonly InlineExtension[]): InlineExtension[] {
  const named = new Set(given.flatMap((extension) => typeof extension === "function" || !extension.builtin ? [] : [extension.name]));
  return workerBuiltinExtensions().filter((extension) => typeof extension === "function" || !named.has(extension.name));
}

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
  /** The Result sections a completed non-fork worker's final text has no
   *  header for (ADR 0010); absent when none is missing, and for a fork. */
  readonly missingSections?: readonly ResultSection[];
  /** The worker, or a worker it started, edited in this run, so its
   *  delegation needs a verdict (ADR 0010); absent when it did not. */
  readonly edited?: true;
}

export interface WorkerSetup {
  readonly task: string;
  readonly resume?: ResumeWorker;
  readonly cwd: string;
  /** The orchestrator's agent dir: its auth.json, models.json, settings,
   *  mcp.json and installed extensions. */
  readonly agentDir: string;
  /** Whether the orchestrator trusts the project; without it the worker
   *  trusts it, as pi's SDK does. An untrusted project's settings, extensions
   *  and .pi/mcp.json are left out, as they are for the orchestrator. */
  readonly projectTrusted?: boolean;
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
  /** An agent definition's instructions, appended to the worker's system
   *  prompt after the reporting rules a non-fork worker gets. */
  readonly instructions?: string;
  /** The only tools the worker may use. Without it, pi's default and extension
   *  tools include subagents for a routed, top-level worker (ADR 0016). */
  readonly tools?: readonly string[];
  /** The delegation id of the worker that makes this delegation, if a worker does. */
  readonly parentDelegationId?: string;
  /** Routing constraints for the worker's first request (../router/auto-model.ts).
   *  Only a routed worker takes them: one with a fork, a named model or a resume fails. */
  readonly routingConstraints?: RoutingConstraints;
  /** A retry's classification, carried from the delegation it retries
   *  (./retry.ts): the router routes the worker's first request on it instead
   *  of classifying it. Like routing constraints, only a routed worker takes it. */
  readonly carriedClassification?: TierClassification;
  /** The delegation this worker reviews (ADR 0010): its decision record links
   *  to it, and `prompt`, the review rules and the reviewed delegation
   *  (./review.ts), follows the reporting rules in its system prompt. */
  readonly review?: { readonly delegationId: string; readonly prompt: string };
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
  /** Registers this running background session as a message recipient. */
  readonly onMessageReady?: (receive: (text: string, mode: BackgroundMessageMode) => Promise<void>) => () => void;
  /** Called once the worker's session exists, before its first request: its
   *  delegation id, session file, messages and events, for the worker board. */
  readonly onSession?: (session: WorkerSession) => void;
  /** Called when the worker starts, as its turns and text move on, and once more when it ends. */
  readonly onActivity?: (activity: WorkerActivity) => void;
  /** Where the worker's `report` tool sends its reports. The tool is added to
   *  a `tools` list, since every worker gets it (ADR 0008). */
  readonly reports?: WorkerReports;
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

/** Remove the extension that registers subagents where delegation is not allowed. */
function withoutSubagentsTool(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.filter((extension) => !extension.tools.has(SUBAGENTS_TOOL)) };
}

/** Delegating workers can manage their own background calls, not issue the
 *  orchestrator's quality verdicts. */
function withoutVerdictTool(base: LoadExtensionsResult): LoadExtensionsResult {
  return { ...base, extensions: base.extensions.map((extension) => extension.tools.has(SUBAGENTS_VERDICT_TOOL)
    ? { ...extension, tools: new Map([...extension.tools].filter(([name]) => name !== SUBAGENTS_VERDICT_TOOL)) } : extension) };
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

type WorkerAgentSession = Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"];

interface FailedReply {
  readonly role?: string;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly provider?: string;
  readonly model?: string;
  readonly timestamp?: number;
  readonly content?: string | readonly { readonly type: string; readonly text?: string; readonly thinking?: string }[];
}

/** Whether a reply produced anything before it ended. */
function producedOutput(reply: FailedReply): boolean {
  const { content } = reply;
  if (content === undefined) return false;
  if (typeof content === "string") return content !== "";
  return content.some((part) => part.type === "toolCall" || (part.type === "text" && (part.text ?? "") !== "") ||
    (part.type === "thinking" && (part.thinking ?? "") !== ""));
}

/** Fails a routed worker over when its first request ended in a limit
 *  error pi does not retry, such as a quota or billing error, before any
 *  output (spec 23b3, ticket v1q3). The router's message_end handler has
 *  already recorded the usage observation. The worker asks the auto model
 *  for a failover, leaves the failed attempt out of the context with a
 *  context edit, as pi's own retry does, and continues the session once: pi
 *  routes that request with reason user and the old router state, and the
 *  route moves the worker to a surviving rung on another provider or refuses
 *  it. That continued turn runs outside pi's post-run loop, with no
 *  auto-retry or compaction after it (owner decision on the ticket).
 *  Returns an error when the continue itself failed, else `undefined`. */
async function failOverFirstRequest(session: WorkerAgentSession, sessionId: string): Promise<string | undefined> {
  const replies = session.messages.filter((message) => (message as FailedReply).role === "assistant") as FailedReply[];
  const [failed] = replies;
  if (replies.length !== 1 || failed === undefined || failed.stopReason !== "error" || failed.errorMessage === undefined || producedOutput(failed)) return undefined;
  // A failure whose routing failed names the auto model: no rung answered.
  if (failed.provider === undefined || failed.provider === AUTO_PROVIDER || failed.model === undefined) return undefined;
  if (limitErrorObservation(failed.errorMessage, new Date()) === undefined) return undefined;
  const branch = session.sessionManager.getBranch();
  const entry = [...branch].reverse().find((candidate) => candidate.type === "message");
  const saved = entry?.type === "message" ? entry.message as FailedReply : undefined;
  if (entry === undefined || saved?.role !== "assistant" || saved.stopReason !== "error" || saved.timestamp !== failed.timestamp) return undefined;
  const withdraw = requestFailover(sessionId, { model: `${failed.provider}/${failed.model}`, errorMessage: failed.errorMessage });
  try {
    session.sessionManager.appendContextEdit(entry.id, null);
    session.agent.state.messages = session.sessionManager.buildSessionProjection().messages as typeof session.agent.state.messages;
    await session.agent.continue();
    return undefined;
  } catch (error) {
    return `${failed.errorMessage} (the failover could not continue the worker: ${errorText(error)})`;
  } finally { withdraw(); }
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
    const sessionManager = workerSessionManager(setup);
    // An edit counts for the orchestrator's delegation, however the worker ends (editing.ts).
    const edits = await trackEdits({ sessionId: sessionManager.getSessionId(), orchestratorSession: setup.orchestratorSession.getSessionId(),
      recordDir: join(stateDir(), "routing"), cwd: setup.cwd, readOnly: isReadOnly(setup),
      ...(setup.parentDelegationId === undefined ? {} : { parentDelegationId: setup.parentDelegationId }) });
    try {
      const result = await runWorkerSession(setup, sessionManager, edits.extension, activity, () => report(false));
      return (await edits.finish()) ? { ...result, edited: true } : result;
    } finally { await edits.finish(); }
  } finally { report(true); }
}

/** The worker's session: a fork's copy, already carrying any background
 *  delegation id; a resumed worker's saved session; or a new one. */
function workerSessionManager(setup: WorkerSetup): SessionManager {
  const sessionOptions = setup.sessionId === undefined ? undefined : { id: setup.sessionId };
  return setup.resume
    ? SessionManager.open(setup.resume.file, workerSessionDir(setup.orchestratorSession), setup.cwd)
    : setup.fork?.sessionManager ?? (setup.orchestratorSession.getSessionFile() === undefined
      ? SessionManager.inMemory(setup.cwd, sessionOptions)
      : SessionManager.create(setup.cwd, workerSessionDir(setup.orchestratorSession), sessionOptions));
}

/** A reviewer, resumed or not, and a worker it started never edit (ADR 0010). */
function isReadOnly(setup: WorkerSetup): boolean {
  return (setup.review?.delegationId ?? setup.resume?.review?.delegationId) !== undefined ||
    (setup.parentDelegationId !== undefined && reviewedDelegationOf(setup.parentDelegationId) !== undefined);
}

/** `runWorker`'s body: it moves `activity` on and calls `report` at each
 *  step. `editTracking` is the worker's extension that records its edits. */
async function runWorkerSession(setup: WorkerSetup, sessionManager: SessionManager, editTracking: InlineExtension,
  activity: ActivitySoFar, report: () => void): Promise<WorkerResult> {
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

  const { instructions, reports, review } = setup;
  // Constraints bind the router's choice, so a worker the router does not choose for must not drop them unseen.
  if ((setup.routingConstraints !== undefined || setup.carriedClassification !== undefined || review !== undefined) &&
    (setup.fork || setup.namedModel || setup.resume)) {
    return failed("routing constraints and a review need a newly routed worker, not a fork, a named model or a resume");
  }
  // Every non-fork worker gets the reporting rules, whatever its agent
  // definition says (ADR 0010); a fork, resumed or not, runs as the orchestrator.
  const getsReportingRules = setup.fork === undefined && setup.resume?.fork !== true;
  const appendedPrompt = [...(getsReportingRules ? [REPORTING_RULES] : []), ...(review === undefined ? [] : [review.prompt]),
    ...(instructions === undefined ? [] : [instructions])];
  const tools = setup.tools === undefined || reports === undefined ? setup.tools : [...setup.tools, REPORT_TOOL];
  const reviewed = review?.delegationId ?? setup.resume?.review?.delegationId;
  const readOnly = isReadOnly(setup);
  let session: WorkerAgentSession;
  /** A new worker on the auto model, not a fork, a named model or a resume. */
  let routed = false;
  try {
    const given = setup.extensionFactories ?? [];
    const services = await createAgentSessionServices({
      cwd: setup.cwd,
      agentDir: setup.agentDir,
      ...(setup.projectTrusted === undefined ? {}
        : { settingsManager: SettingsManager.create(setup.cwd, setup.agentDir, { projectTrusted: setup.projectTrusted }) }),
      resourceLoaderOptions: {
        // A tools list also narrows the built-ins' tools: MCP tools it does not name are not registered (ADR 0007).
        extensionFactories: [...builtinExtensionsBesides(given), ...given, ...(readOnly ? [READ_ONLY_REVIEWER] : []), editTracking,
          ...(reports === undefined ? [] : [reportExtension(reports)])],
        ...(setup.parentDelegationId === undefined && setup.fork === undefined && setup.resume?.fork !== true &&
          (setup.tools === undefined || setup.tools.includes(SUBAGENTS_TOOL))
          ? { extensionsOverride: withoutVerdictTool } : { extensionsOverride: withoutSubagentsTool }),
        ...(appendedPrompt.length === 0 ? {} : { appendSystemPromptOverride: (base: string[]) => [...base, ...appendedPrompt] }),
      },
    });
    const { fork } = setup;
    const namedModel = setup.resume?.namedModel ?? setup.namedModel;
    // A resumed fork is not routed either: it runs on the model it forked on (ADR 0008).
    const resumedFork = setup.resume?.fork ? setup.resume.pin : undefined;
    // The provider ends at the first slash; a model id may hold more.
    const selectedModel = fork?.model ?? namedModel?.model ?? resumedFork?.model;
    const slash = selectedModel?.indexOf("/") ?? -1;
    const [provider, modelId] = selectedModel ? [selectedModel.slice(0, slash), selectedModel.slice(slash + 1)] : [AUTO_PROVIDER, AUTO_MODEL_ID];
    routed = selectedModel === undefined && setup.resume === undefined;
    const model = services.modelRuntime.getModel(provider, modelId);
    if (model === undefined) {
      const loadErrors = services.diagnostics.filter((diagnostic) => diagnostic.type === "error").map((diagnostic) => diagnostic.message);
      return failed([`${selectedModel ?? "orchestrator/auto"} is not in the worker's model runtime${selectedModel ? "" : "; is the router extension installed?"}`, ...loadErrors].join(" "));
    }
    session = (await createAgentSessionFromServices({
      services, sessionManager, model, ...((fork?.effort ?? namedModel?.effort ?? resumedFork?.effort) === undefined ? {}
        : { thinkingLevel: fork?.effort ?? namedModel?.effort ?? resumedFork?.effort }),
      ...(tools === undefined ? {} : { tools: [...tools] }),
    })).session;
    // A resume writes no new record: the delegation keeps its original one.
    if ((fork || namedModel) && !setup.resume) {
      try {
        appendRoutingRecord(join(stateDir(), "routing"), fork ? buildForkRecord({
          delegationId: sessionId, model: fork.model, effort: fork.effort,
          parentSession: fork.parentSession, forkPoint: fork.forkPoint, banListException: fork.banListException,
          ...(setup.parentDelegationId === undefined ? {} : { parentDelegationId: setup.parentDelegationId }),
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

  try {
    setup.onSession?.({ sessionId, sessionFile: sessionManager.getSessionFile(), effort: session.thinkingLevel,
      messages: () => session.messages, subscribe: (listener) => session.subscribe(listener),
      toolDefinition: (name) => session.getToolDefinition(name) });
  } catch { /* An observer must not fail the worker. */ }
  const abort = () => { void session.abort(); };
  const runningTools = new Map<string, string>();
  // pi retried a failed request itself: its retry routed any failover.
  let retried = false;
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "auto_retry_start") {
      retried = true;
      return;
    }
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
  const unmarkWorkerSession = markWorkerSession(sessionId, setup.parentDelegationId, reviewed, setup.orchestratorSession.getSessionId(), setup.signal);
  const unsetConstraints = setup.routingConstraints === undefined ? undefined : setRoutingConstraints(sessionId, setup.routingConstraints);
  const unsetClassification = setup.carriedClassification === undefined ? undefined : setCarriedClassification(sessionId, setup.carriedClassification);
  // A routed worker's router starts classifying its task at session_start,
  // during the rest of its startup; a carried classification needs none.
  const unsetPendingTask = routed && setup.carriedClassification === undefined ? setPendingTask(sessionId, setup.task) : undefined;
  let unregisterMessage: (() => void) | undefined;
  try {
    // Binding starts the extensions: the router extension reads its settings
    // at session_start.
    await session.bindExtensions({});
    setup.signal?.addEventListener("abort", abort, { once: true });
    if (setup.signal?.aborted) return { status: "aborted", sessionId, sessionFile: saved(), finalText: "" };
    unregisterMessage = setup.onMessageReady?.((text, mode) => {
      if (!session.isStreaming) throw new Error("subagents_message: the background worker is no longer running");
      // pi 0.99 answers with a disposition (handled or queued); the caller needs none.
      return session[mode](text).then(() => undefined);
    });
    await session.prompt(setup.task);
    // Only a newly routed worker on the auto model fails over.
    if (routed && !retried && !setup.signal?.aborted) {
      const continueError = await failOverFirstRequest(session, sessionId);
      if (continueError !== undefined) return failed(continueError);
    }
    const replies = session.messages.filter((message) => (message as Reply).role === "assistant") as Reply[];
    const last = replies.at(-1);
    const finalText = session.getLastAssistantText() ?? "";
    if (setup.signal?.aborted || last?.stopReason === "aborted") return { status: "aborted", sessionId, sessionFile: saved(), finalText };
    if (last === undefined) return failed("the worker gave no reply");
    if (last.stopReason === "error") return { ...failed(last.errorMessage ?? "the worker's model call failed"), finalText };
    const missingSections = getsReportingRules ? missingResultSections(finalText) : [];
    return { status: "completed", sessionId, sessionFile: saved(), finalText, ...(missingSections.length === 0 ? {} : { missingSections }) };
  } catch (error) {
    return failed(errorText(error));
  } finally {
    unregisterMessage?.();
    setup.signal?.removeEventListener("abort", abort);
    unsubscribe();
    // The session ends as pi ends one: its extensions get session_shutdown, so
    // the MCP extension closes the servers it started for this worker.
    try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } catch { /* The worker's result stands. */ }
    session.dispose();
    unsetConstraints?.();
    unsetClassification?.();
    unsetPendingTask?.();
    unmarkWorkerSession();
  }
}
