import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toModelInfo, splitKnownThinkingSuffix, type ModelInfo } from "../models/model-info.ts";
import { agentRoleOf, AUTO_MODEL_ID, AUTO_MODEL_THINKING_LEVELS, AUTO_PROVIDER, createAutoModelRouter, isAutoModel, isVirtualModel, recordLimitError, recordQuotaHeaders,
  registerIncomingJudge, SESSION_MODEL_ENV, SESSION_VIRTUAL_MODEL_ENV, type AutoModelDependencies, type AutoModelState } from "./auto-model.ts";
import { autoModelLimits, type AutoModelLimits } from "./auto-model-limits.ts";
import { refuseAutoModelForMainThread } from "./main-thread.ts";
import type { ActiveRouter } from "./route-task.ts";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { banListsFromSettings, configureBanLists, loadBanListsOrDefaults, personalAgentDir, personalOrchestrator, readSettingsFile } from "../policy/ban-lists.ts";
import { isPlainObject } from "../guard/boundaries.ts";
import { ROUTING_MODES, writeEffortDecisionRecord, writeHandlingDecisionRecord, type RoutingMode } from "../routing/decision-record.ts";
import { sessionClassifierModelCall, type SessionClassifierCallReport } from "../routing/session-classifier-call.ts";
import {
  classifierConfigFromSettings,
  DEFAULT_CLASSIFIER_CONFIG,
  loadClassifierChain,
  type ClassifierModelCall,
} from "../routing/tier-classifier.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { runInit } from "../init/command.ts";
import { setupNotice, setupStatus } from "../init/setup.ts";
import { INIT_COMMAND } from "../init/setup.ts";
import { registerSubcommands, showOwner, type Subcommand } from "../init/subcommands.ts";
import { stateFolderEvidence, type EvidenceSetup, type RoutingEvidenceSource } from "./evidence.ts";
import { usageObservationsPath } from "./usage-observations.ts";
import { applyWorkerBudget, workerBudgetFromSettings } from "../routing/worker-budget.ts";
import { isOrchestratorSession } from "../subagents/orchestrator-session.ts";
import { publishOrchestratorRouter } from "./orchestrator-router.ts";
import { effortJudgeConfigFromSettings, loadEffortJudgeChain, judgeEffort, type EffortBand, type EffortJudgeModelCall } from "../routing/effort-judge.ts";
import { sessionEffortJudgeModelCall } from "../routing/session-effort-judge-call.ts";
import type { SessionModelRegistry } from "../routing/model-stream.ts";
import { sessionEffortBandFromSettings } from "../routing/session-effort.ts";
import { dynamicRungRefusal } from "../models/effort-capability.ts";
import { getSupportedThinkingLevels, type ThinkingLevel } from "../models/model-info.ts";
import { emitEffortDecision, emitHandlingDecision, onEffortDecision, onHandlingDecision, type EffortDecisionEvent } from "../routing/effort-decisions.ts";
import { handlingJudgeConfigFromSettings, judgeHandling } from "../routing/handling-judge.ts";

export type { RoutingEvidence, RoutingEvidenceSource, EvidenceSetup } from "./evidence.ts";

// The router extension (ADR 0006): a personal pi extension, separate from the
// guard, that serves the auto model `orchestrator/auto` as a pi virtual model
// (ADR 0014). It hooks no tool calls.

import { ROUTER_PREFIX } from "./prefix.ts";
export { ROUTER_PREFIX };
export const ROUTER_DISABLED_PREFIX = "pi-orchestrator router disabled:";
/** pi loads each extension with a fresh module copy (jiti moduleCache: false),
 *  so the once-per-process disabled line is kept on the process's global object. */
export const DISABLED_LINE_REPORTED = Symbol.for("pi-orchestrator.router.disabled-line-reported");
const EFFORT_DECISION_RECORDER = Symbol.for("pi-orchestrator.effort-decision-recorder");
export const ROUTER_WARNING_PREFIX = "pi-orchestrator router warning:";
/** The oldest supported pi version for cache-safe per-message effort. */
export const REQUIRED_PI_VERSION = "1.1.0";
/** The load error on a pi host without `registerVirtualModel`. pi reports a
 *  throwing extension factory as a failed extension load. */
export const PI_TOO_OLD_MESSAGE = `pi-orchestrator requires pi v${REQUIRED_PI_VERSION} or later: this pi has no registerVirtualModel. Upgrade pi to v${REQUIRED_PI_VERSION} or later.`;
/** The keys of the warnings this process printed, each once, like the disabled line. */
const WARNINGS_REPORTED = Symbol.for("pi-orchestrator.router.warnings-reported");
type ProcessGlobal = typeof globalThis & {
  [DISABLED_LINE_REPORTED]?: boolean;
  [WARNINGS_REPORTED]?: Set<string>;
  [EFFORT_DECISION_RECORDER]?: true;
};

/** The state folder when `PI_ORCHESTRATOR_STATE_DIR` is not set: under the agent
 *  directory, never inside the package checkout. */
export function defaultStateDir(): string {
  return join(personalAgentDir(), "pi-orchestrator");
}

/** The state folder this session uses. */
export function stateDir(): string {
  return resolve(process.env.PI_ORCHESTRATOR_STATE_DIR ?? defaultStateDir());
}

function recordEffortDecisionEvents(warn: (key: string, message: string) => void): void {
  const processGlobal = globalThis as ProcessGlobal;
  if (processGlobal[EFFORT_DECISION_RECORDER]) return;
  processGlobal[EFFORT_DECISION_RECORDER] = true;
  onEffortDecision((event: EffortDecisionEvent) => {
    try {
      writeEffortDecisionRecord(join(stateDir(), "routing"), {
        at: new Date(event.timestamp),
        sessionId: event.sessionId,
        scope: event.scope,
        kind: event.kind,
        from: event.from,
        to: event.to,
        applyAt: event.applyAt,
        reason: event.reason,
        judgeModel: event.judgeModel,
        band: event.band,
      });
    } catch (error) {
      warn(`effort-decision-record:${event.sessionId}`, `could not save effort decision for ${event.sessionId}: ${String(error).split(/\r?\n/, 1)[0]}`);
    }
  });
}

const HANDLING_DECISION_RECORDER = Symbol.for("pi-orchestrator.handling-decision-recorder");

/** Writes each handling verdict to the routing log (ADR 0020), once per process, as the effort decisions are. */
function recordHandlingDecisionEvents(warn: (key: string, message: string) => void): void {
  const processGlobal = globalThis as unknown as Record<symbol, true | undefined>;
  if (processGlobal[HANDLING_DECISION_RECORDER]) return;
  processGlobal[HANDLING_DECISION_RECORDER] = true;
  onHandlingDecision((event) => {
    try {
      writeHandlingDecisionRecord(join(stateDir(), "routing"), {
        at: new Date(event.timestamp), sessionId: event.sessionId, handling: event.handling,
        source: event.source, reason: event.reason, judgeModel: event.judgeModel,
      });
    } catch (error) {
      warn(`handling-decision-record:${event.sessionId}`, `could not save handling decision for ${event.sessionId}: ${String(error).split(/\r?\n/, 1)[0]}`);
    }
  });
}

export interface RouterDependencies {
  /** The classifier model call for this session. */
  readonly classifierCall: (ctx: ExtensionContext) => ClassifierModelCall;
  /** The in-session judge call, replaceable at the provider boundary in tests. */
  readonly effortJudgeCall: (registry: SessionModelRegistry) => EffortJudgeModelCall;
  /** Where the hard filters' evidence comes from. */
  readonly evidence: (setup: EvidenceSetup) => RoutingEvidenceSource;
  readonly now: () => Date;
}

function tokensOf(usage: NonNullable<SessionClassifierCallReport["reply"]>["usage"]): number {
  if (usage === undefined) return 0;
  return usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
}

/** The probe line for one in-session classifier call: its time to first
 *  token and total time, and pi's reported tokens and cost (a consumption
 *  signal on a subscription route, not a bill). */
function printClassifierProbe(report: SessionClassifierCallReport): void {
  const total = report.totalMs.toFixed(1);
  if (report.reply === undefined) {
    process.stderr.write(`${ROUTER_PREFIX} classifier ${report.rung} failed after ${total} ms: ${(report.error ?? "").split(/\r?\n/, 1)[0]}\n`);
    return;
  }
  const firstToken = report.firstTokenMs === undefined ? "none" : `${report.firstTokenMs.toFixed(1)} ms`;
  const cost = report.reply.reportedUsd === undefined ? "none" : `$${report.reply.reportedUsd.toFixed(5)}`;
  process.stderr.write(`${ROUTER_PREFIX} classifier ${report.rung} first token ${firstToken}, total ${total} ms, tokens ${tokensOf(report.reply.usage)}, reported cost ${cost}\n`);
}

const DEFAULT_DEPENDENCIES: RouterDependencies = {
  // The classifier runs inside this pi session, through its model registry
  // (ADR 0004), not in a `pi -p` child.
  classifierCall: (ctx) => {
    if (ctx.modelRegistry === undefined) throw new Error("pi supplied no model registry");
    return sessionClassifierModelCall(ctx.modelRegistry, process.env.PI_ORCHESTRATOR_ROUTER_PROBE === "1" ? { onCallEnd: printClassifierProbe } : {});
  },
  effortJudgeCall: (registry) => sessionEffortJudgeModelCall(registry),
  evidence: stateFolderEvidence,
  now: () => new Date(),
};

/** `undefined` when routing is not enabled. Throws on a malformed key. */
function routingMode(personal: unknown): RoutingMode | undefined {
  const routing = personalOrchestrator(personal)?.routing;
  if (routing === undefined) return undefined;
  if (!isPlainObject(routing)) throw new Error(`orchestrator.routing must be an object; got ${JSON.stringify(routing)}.`);
  if (routing.enabled !== undefined && typeof routing.enabled !== "boolean") {
    throw new Error(`orchestrator.routing.enabled must be a boolean; got ${JSON.stringify(routing.enabled)}.`);
  }
  if (routing.enabled !== true) return undefined;
  const mode = routing.mode ?? "shadow";
  if (!ROUTING_MODES.includes(mode as RoutingMode)) {
    throw new Error(`orchestrator.routing.mode must be one of ${ROUTING_MODES.join(", ")}; got ${JSON.stringify(mode)}.`);
  }
  return mode as RoutingMode;
}

function installedModel(model: string, installedModels: readonly ModelInfo[]): ModelInfo | undefined {
  const id = model.toLowerCase();
  return installedModels.find((entry) => entry.fullId.toLowerCase() === id);
}

/** Read the settings and build everything a call needs. `undefined` when
 *  routing is not enabled; throws on any failure. */
function startRouting(ctx: ExtensionContext, deps: RouterDependencies): ActiveRouter | undefined {
  const personal = readSettingsFile(join(personalAgentDir(), "settings.json")) ?? {};
  const mode = routingMode(personal);
  if (mode === undefined) return undefined;
  const project = readSettingsFile(join(ctx.cwd, ".pi", "settings.json"));
  const banLists = banListsFromSettings(personal).banLists;
  // The classifier chain and the allowance read the configured lists.
  configureBanLists(banLists);
  if (ctx.modelRegistry === undefined) throw new Error("pi supplied no model registry");
  const installedModels = ctx.modelRegistry.getAvailable().map((model) => toModelInfo(model));
  const tierMap = tierMapFromSettings(personal, project, { installedModels, banLists });
  if (tierMap === undefined) throw new Error("orchestrator.routing.tiers is missing");
  const classifierConfig = classifierConfigFromSettings(personal);
  // The default fallback is a convenience, not an owner choice: drop it when pi does not have its model.
  const chain = loadClassifierChain(classifierConfig.fallback === DEFAULT_CLASSIFIER_CONFIG.fallback
    ? { ...classifierConfig, fallback: classifierConfig.fallback.filter((rung) => installedModel(splitKnownThinkingSuffix(rung).baseModel, installedModels) !== undefined) }
    : classifierConfig);
  for (const { rung } of chain.entries) {
    const { baseModel } = splitKnownThinkingSuffix(rung);
    if (installedModel(baseModel, installedModels) === undefined) {
      throw new Error(`classifier rung '${rung}' names a model pi does not have (${baseModel})`);
    }
  }
  const folder = stateDir();
  const sessionId = ctx.sessionManager?.getSessionId() ?? "unknown";
  return {
    mode,
    tierMap,
    banLists,
    chain,
    callModel: deps.classifierCall(ctx),
    evidence: deps.evidence({ stateDir: folder, installedModelIds: installedModels.map((model) => model.fullId) }),
    owner: new TaskAllowanceOwner(newTaskLedger({ taskId: `router-session:${sessionId}` })),
    recordDir: join(folder, "routing"),
    usagePath: usageObservationsPath(folder),
    installedModels,
  };
}

/** A successful response's physical model and thinking level, as
 *  `provider/id:level`. A failed or aborted response, including one whose
 *  routing failed and so names the virtual model, answered nothing. A
 *  response without a thinking level ran outside pi's agent loop, unmanaged:
 *  its level is taken as off. */
function physicalAnswerOf(message: unknown): string | undefined {
  const { role, stopReason, api, provider, model, thinkingLevel } = (message ?? {}) as
    { role?: string; stopReason?: string; api?: string; provider?: unknown; model?: unknown; thinkingLevel?: unknown };
  if (role !== "assistant" || stopReason === "error" || stopReason === "aborted" || isVirtualModel({ api })) return undefined;
  if (typeof provider !== "string" || typeof model !== "string" || provider === "" || model === "") return undefined;
  return `${provider}/${model}:${typeof thinkingLevel === "string" ? thinkingLevel : "off"}`;
}

/** The latest physical answer on a session branch, as pi's own latest response. */
function latestPhysicalAnswer(branch: readonly unknown[]): string | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: string; message?: unknown };
    if (entry.type !== "message") continue;
    const answered = physicalAnswerOf(entry.message);
    if (answered) return answered;
  }
  return undefined;
}

/** An owner prompt waiting for its user message to be shown, the judge's input captured at `before_agent_start`. */
interface PendingOwnerPrompt {
  readonly sessionId: string;
  readonly band: EffortBand;
  readonly prompt: string;
  readonly lastUserMessage: string;
  readonly lastAssistantReply: string;
}

export function createRouterExtension(overrides: Partial<RouterDependencies> = {}) {
  const deps: RouterDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return function router(pi: ExtensionAPI): void {
    if (typeof (pi as Partial<ExtensionAPI>).registerVirtualModel !== "function") throw new Error(PI_TOO_OLD_MESSAGE);
    // Fail open, as the guard does: the first failure anywhere prints one
    // line and stops routing for the rest of the session; workers then run
    // on the orchestrator's model.
    let disabled = false;
    let active: ActiveRouter | undefined;
    /** This copy's session when it is the orchestrator's, whose router retries climb through (./orchestrator-router.ts). */
    let orchestratorSessionId: string | undefined;
    let sessionBand: ReturnType<typeof sessionEffortBandFromSettings>;
    let sessionEffortOff = false;
    let ourThinkingSelection: ThinkingLevel | undefined;
    let effortPersonal: unknown = {};
    const selectEffort = (level: ThinkingLevel) => {
      if (pi.getThinkingLevel() === level) return;
      ourThinkingSelection = level;
      pi.setThinkingLevel(level);
    };
    const autoDeps: AutoModelDependencies = {
      router: () => active, now: deps.now,
      banLists: () => active?.banLists ?? loadBanListsOrDefaults().banLists,
      disabled: () => disabled,
      disable: (error) => disable(error),
      effortJudge: (registry) => {
        const models = registry.getAvailable().map((model) => toModelInfo(model));
        return { chain: loadEffortJudgeChain(effortJudgeConfigFromSettings(effortPersonal), models),
          callModel: deps.effortJudgeCall(registry) };
      },
      warn: (key, message) => {
        const reported = (globalThis as ProcessGlobal)[WARNINGS_REPORTED] ??= new Set();
        if (reported.has(key)) return;
        reported.add(key);
        process.stderr.write(`${ROUTER_WARNING_PREFIX} ${message}\n`);
      },
    };
    recordEffortDecisionEvents(autoDeps.warn);
    recordHandlingDecisionEvents(autoDeps.warn);
    const autoModel = createAutoModelRouter(autoDeps);
    // Registering again replaces the virtual model; its route keeps no pins of its own.
    const registerAutoModel = (limits: AutoModelLimits = {}) => pi.registerVirtualModel<AutoModelState>({
      provider: AUTO_PROVIDER, id: AUTO_MODEL_ID, name: "Orchestrator auto", thinkingLevels: AUTO_MODEL_THINKING_LEVELS, ...limits,
      route: (request, ctx) => autoModel.route(request, ctx),
    });
    registerAutoModel();
    refuseAutoModelForMainThread(pi);
    const disable = (error: unknown) => {
      active = undefined;
      if (orchestratorSessionId !== undefined) publishOrchestratorRouter(orchestratorSessionId, undefined);
      if (disabled) return;
      disabled = true;
      if ((globalThis as ProcessGlobal)[DISABLED_LINE_REPORTED]) return;
      (globalThis as ProcessGlobal)[DISABLED_LINE_REPORTED] = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${ROUTER_DISABLED_PREFIX} ${message.split(/\r?\n/, 1)[0]}\n`);
      if (process.env.PI_ORCHESTRATOR_ROUTER_DEBUG === "1") process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    };
    const probe = process.env.PI_ORCHESTRATOR_ROUTER_PROBE === "1";


    // The orchestrator's session model, for workers to fall back to. A
    // worker's or a child process's session model is not remembered. A
    // worker's route cannot return a virtual model, so while the orchestrator
    // runs on one (another extension's router) its session model is the
    // physical model that last answered it, and none before one has.
    const rememberSessionModel = (model: { provider: string; id: string; api?: string } | undefined, effort: string, ctx: ExtensionContext) => {
      if (!isOrchestratorSession(ctx)) return;
      if (isAutoModel(model)) return;
      if (model && isVirtualModel(model)) {
        process.env[SESSION_VIRTUAL_MODEL_ENV] = `${model.provider}/${model.id}`;
        const answered = latestPhysicalAnswer(ctx.sessionManager?.getBranch?.() ?? []);
        if (answered) process.env[SESSION_MODEL_ENV] = answered;
        else delete process.env[SESSION_MODEL_ENV];
        return;
      }
      delete process.env[SESSION_VIRTUAL_MODEL_ENV];
      if (model) process.env[SESSION_MODEL_ENV] = `${model.provider}/${model.id}:${effort}`;
      else delete process.env[SESSION_MODEL_ENV];
    };
    const rememberPhysicalAnswer = (message: unknown, ctx: ExtensionContext) => {
      if (!isOrchestratorSession(ctx) || isAutoModel(ctx.model) || !isVirtualModel(ctx.model)) return;
      const answered = physicalAnswerOf(message);
      if (answered) process.env[SESSION_MODEL_ENV] = answered;
    };
    let noticeShown = false;
    // Each worker session on the auto model this copy serves, with the
    // function that removes its incoming-message judge.
    const incomingJudges = new Map<string, () => void>();
    /** Whether this session's owner settings leave the worker budget on (worker-budget.ts). */
    let workerBudgetOn = true;
    pi.on("session_start", (_event, ctx) => {
      sessionEffortOff = false;
      sessionBand = undefined;
      try {
        effortPersonal = readSettingsFile(join(personalAgentDir(), "settings.json")) ?? {};
        sessionBand = sessionEffortBandFromSettings(effortPersonal);
      } catch (error) { autoDeps.warn("session-effort-settings", String(error)); }
      try { workerBudgetOn = workerBudgetFromSettings(effortPersonal); }
      catch (error) { workerBudgetOn = true; autoDeps.warn("worker-budget-settings", String(error)); }
      rememberSessionModel(ctx.model, ctx.thinkingLevel ?? "off", ctx);
      if (orchestratorSessionId !== undefined) publishOrchestratorRouter(orchestratorSessionId, undefined);
      orchestratorSessionId = isOrchestratorSession(ctx) ? ctx.sessionManager?.getSessionId() : undefined;
      if (disabled) return;
      try {
        // One line on a fresh install, in the owner's session only.
        if (!noticeShown && isOrchestratorSession(ctx)) {
          noticeShown = true;
          const personal = readSettingsFile(join(personalAgentDir(), "settings.json")) ?? {};
          const notice = setupNotice(setupStatus(personal, stateDir()), stateDir());
          if (notice) {
            if (ctx.hasUI) ctx.ui.notify(notice, "warning");
            else process.stderr.write(`${notice}\n`);
          }
        }
        active = startRouting(ctx, deps);
        if (orchestratorSessionId !== undefined) publishOrchestratorRouter(orchestratorSessionId, active);
        if (active) registerAutoModel(autoModelLimits(active.tierMap, active.installedModels));
        if (probe && active) process.stderr.write(`${ROUTER_PREFIX} routing enabled, mode ${active.mode}, records ${active.recordDir}\n`);
      } catch (error) { disable(error); }
      // A newly routed worker's classification starts now, while the rest of
      // its startup runs (MCP servers connecting), not at its first request.
      const workerId = ctx.sessionManager?.getSessionId();
      // Its steers and follow-ups are judged when the worker runtime sends them (ADR 0018).
      if (workerId !== undefined && isAutoModel(ctx.model)) {
        incomingJudges.get(workerId)?.();
        incomingJudges.set(workerId, registerIncomingJudge(workerId, (text, mode, running) => autoModel.judgeIncoming(workerId, text, mode, running, ctx)));
      }
      if (workerId !== undefined && !disabled && isAutoModel(ctx.model)) {
        let systemPrompt = "";
        try { systemPrompt = ctx.getSystemPrompt?.() ?? ""; } catch { /* The first request classifies again if the role differs. */ }
        autoModel.classifyEarly(workerId, agentRoleOf(systemPrompt));
      }
    });

    // A routed worker on a simple tier gets a tool-call budget and loses its
    // delegation tools (worker-budget.ts, ADR 0021). Its first request awaits
    // the same classification, so waiting for it here costs no time.
    pi.on("before_agent_start", async (event, ctx) => {
      if (disabled || !workerBudgetOn || !isAutoModel(ctx.model) || isOrchestratorSession(ctx)) return undefined;
      const workerId = ctx.sessionManager?.getSessionId();
      if (workerId === undefined) return undefined;
      try {
        return applyWorkerBudget(event, pi, await autoModel.workerTier(workerId, ctx));
      } catch (error) {
        autoDeps.warn("worker-budget", `could not apply the worker budget: ${String(error).split(/\r?\n/, 1)[0]}`);
        return undefined;
      }
    });

    // The owner's prompt is judged once its user message is shown (message_end
    // below), not here: the judge's call must not hold the message back, and
    // the first request reads the level the judge chose.
    let pendingPrompt: PendingOwnerPrompt | undefined;
    pi.on("before_agent_start", (event, ctx) => {
      pendingPrompt = undefined;
      if (!sessionBand || sessionEffortOff || !isOrchestratorSession(ctx)) return;
      const id = ctx.sessionManager?.getSessionId();
      const model = ctx.model;
      if (!id || !model) return;
      if (isVirtualModel(model)) {
        autoDeps.warn(`session-effort-unsupported:${id}`, `dynamic session effort is unavailable for ${model.provider}/${model.id}: a virtual model cannot guarantee cache-safe effort changes.`);
        return;
      }
      const installed = ctx.modelRegistry?.find(model.provider, model.id);
      if (dynamicRungRefusal(`${model.provider}/${model.id}`, installed ? toModelInfo(installed) : undefined) || !installed) {
        autoDeps.warn(`session-effort-unsupported:${id}`, `dynamic session effort is unavailable for ${model.provider}/${model.id}: model is not cache-safe.`);
        return;
      }
      const supported = getSupportedThinkingLevels(toModelInfo(installed));
      const band = sessionBand;
      if (!supported.includes(band.min) || !supported.includes(band.max)) {
        autoDeps.warn(`session-effort-unsupported:${id}`, `dynamic session effort is unavailable for ${model.provider}/${model.id}: effort band is not supported.`);
        return;
      }
      const branch = ctx.sessionManager?.getBranch?.() ?? [];
      const userEntry = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "user");
      const assistantEntry = [...branch].reverse().find((entry) => entry.type === "message" && entry.message.role === "assistant");
      const lastUser = userEntry?.type === "message" ? userEntry.message : undefined;
      const lastAssistant = assistantEntry?.type === "message" ? assistantEntry.message : undefined;
      const textOf = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value)
        ? value.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n") : "";
      pendingPrompt = {
        sessionId: id, band, prompt: event.prompt,
        lastUserMessage: textOf(lastUser && "content" in lastUser ? lastUser.content : undefined).slice(0, 400),
        lastAssistantReply: textOf(lastAssistant && "content" in lastAssistant ? lastAssistant.content : undefined).slice(-2_000),
      };
    });

    /** Whether the owner has already been told that its judge fell back, this session. */
    let fallbackNotified = false;
    /** Judges the pending owner prompt, once. Never throws: a failed judge
     *  applies the band maximum, and any other failure only warns. */
    const judgeOwnerPrompt = async (ctx: ExtensionContext) => {
      const pending = pendingPrompt;
      pendingPrompt = undefined;
      if (pending === undefined) return;
      try {
        const { band, sessionId } = pending;
        const currentEffort = pi.getThinkingLevel();
        let decision;
        try {
          decision = await judgeEffort({ message: pending.prompt, kind: "user-prompt", tier: "orchestrator", band, currentEffort,
            turnRunning: false, lastUserMessage: pending.lastUserMessage, lastAssistantReply: pending.lastAssistantReply,
            withHandling: pendingHandling !== undefined },
          { chain: loadEffortJudgeChain(effortJudgeConfigFromSettings(effortPersonal), ctx.modelRegistry!.getAvailable().map(toModelInfo)),
            callModel: deps.effortJudgeCall(ctx.modelRegistry!) });
        } catch (error) {
          decision = { from: currentEffort, to: band.max, applyAt: "now" as const,
            reason: `effort judge fallback to band maximum: ${String(error)}`, judgeModel: "fallback" as const };
        }
        if (decision.judgeModel === "fallback" && !fallbackNotified) {
          fallbackNotified = true;
          const message = `pi-orchestrator: ${decision.reason}. The orchestrator runs at ${decision.to} for this message.`;
          if (ctx.hasUI && ctx.ui) ctx.ui.notify(message, "warning");
          else autoDeps.warn(`effort-judge-fallback:${sessionId}`, `orchestrator ${sessionId}: ${decision.reason}`);
        }
        emitEffortDecision({ ...decision, timestamp: deps.now().toISOString(), band, sessionId, kind: "user-prompt", scope: "orchestrator" });
        if (decision.applyAt === "now") selectEffort(decision.to);
        return decision;
      } catch (error) {
        autoDeps.warn("session-effort-judge", `could not apply the effort judgement: ${String(error).split(/\r?\n/, 1)[0]}`);
      }
    };

    // The handling judge (ADR 0020) judges each orchestrator user prompt once,
    // when its user message is shown. `input` runs before the run starts, and
    // says whether the prompt came from the owner (an extension's message does not).
    let pendingHandling: { readonly sessionId: string; readonly text: string } | undefined;
    /** The owner's override for the next prompt, from `/pi-orchestrator self|delegate` with no prompt (ADR 0020). */
    let handlingOverride: "self" | "delegate" | undefined;
    pi.on("input", (event, ctx) => {
      pendingHandling = undefined;
      if (event.source === "extension" || !isOrchestratorSession(ctx)) return;
      // A command is not a prompt: it neither takes the override nor is judged.
      if (event.text.trimStart().startsWith(`/${INIT_COMMAND}`)) return;
      const sessionId = ctx.sessionManager?.getSessionId();
      if (sessionId === undefined) return;
      if (handlingOverride !== undefined) {
        emitForcedHandling(sessionId, handlingOverride);
        handlingOverride = undefined;
        return;
      }
      pendingHandling = { sessionId, text: event.text };
    });
    const emitForcedHandling = (sessionId: string, handling: "self" | "delegate") => {
      emitHandlingDecision({ sessionId, timestamp: deps.now().toISOString(), handling, source: "forced",
        reason: `owner override: /${INIT_COMMAND} ${handling}`, judgeModel: "forced" });
    };
    // `/pi-orchestrator self|delegate`: with a prompt, sends it with the forced mode; without, the mode applies to the next prompt.
    const overrideSubcommand = (handling: "self" | "delegate"): Subcommand<ExtensionCommandContext> => ({
      name: handling,
      summary: handling === "delegate" ? "hand the next prompt to workers, skipping the judge" : "handle the next prompt yourself, skipping the judge",
      run: (rest, ctx) => {
        if (!isOrchestratorSession(ctx)) return;
        if (rest === "") {
          handlingOverride = handling;
          showOwner(ctx, `pi-orchestrator: the next prompt is judged ${handling}, without the handling judge`, "info");
          return;
        }
        const sessionId = ctx.sessionManager?.getSessionId();
        if (sessionId !== undefined) emitForcedHandling(sessionId, handling);
        pi.sendUserMessage(rest, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
      },
    });
    /** Judges the pending owner prompt's handling, once. Never throws: a failed judgement is self. */
    const judgeHandlingPrompt = async (ctx: ExtensionContext, judged?: { readonly judgeModel: string; readonly handling?: { readonly handling: "self" | "delegate"; readonly reason: string } }) => {
      const pending = pendingHandling;
      pendingHandling = undefined;
      if (pending === undefined) return;
      // The effort judge's reply already judged the handling: one model call, not two.
      if (judged?.handling !== undefined) {
        emitHandlingDecision({
          sessionId: pending.sessionId, timestamp: deps.now().toISOString(), handling: judged.handling.handling,
          source: "judged", reason: judged.handling.reason, judgeModel: judged.judgeModel,
        });
        return;
      }
      let verdict;
      try {
        verdict = await judgeHandling({ message: pending.text }, {
          chain: loadEffortJudgeChain(handlingJudgeConfigFromSettings(effortPersonal), ctx.modelRegistry!.getAvailable().map(toModelInfo)),
          callModel: deps.effortJudgeCall(ctx.modelRegistry!),
        });
      } catch (error) {
        verdict = { handling: "self" as const, reason: `handling judge fallback to self: ${String(error)}`, judgeModel: "fallback" };
      }
      emitHandlingDecision({
        sessionId: pending.sessionId, timestamp: deps.now().toISOString(), handling: verdict.handling,
        source: verdict.judgeModel === "fallback" ? "fallback" : "judged", reason: verdict.reason, judgeModel: verdict.judgeModel,
      });
      // Warned once per session, not per prompt: the routing log keeps every fallback.
      if (verdict.judgeModel === "fallback") autoDeps.warn(`handling-judge-fallback:${pending.sessionId}`, `orchestrator ${pending.sessionId}: ${verdict.reason}`);
    };

    // `/pi-orchestrator <subcommand>`. `init` sets up a fresh install. Its
    // failures are reported by the command and never disable routing. Other
    // extensions add their subcommands to the same command (subcommands.ts).
    const subcommands: Subcommand<ExtensionCommandContext>[] = [overrideSubcommand("delegate"), overrideSubcommand("self"), {
      name: "init",
      summary: "set up a starter tier map, ban list and approved recipients",
      run: async (rest, ctx) => {
        try { await runInit(`init ${rest}`, ctx, { stateDir: stateDir() }); }
        catch (error) { ctx.ui.notify(`pi-orchestrator init failed: ${String(error).split(/\r?\n/, 1)[0]}`, "error"); }
      },
    }];
    if (typeof pi.registerCommand === "function") registerSubcommands(pi, subcommands);

    pi.on("session_shutdown", (_event, ctx) => {
      const id = ctx?.sessionManager?.getSessionId();
      if (id !== undefined) {
        autoModel.dropEarlyClassification(id);
        incomingJudges.get(id)?.();
        incomingJudges.delete(id);
      }
      if (orchestratorSessionId !== undefined) publishOrchestratorRouter(orchestratorSessionId, undefined);
      orchestratorSessionId = undefined;
    });

    // Quota headers (PRD cml8, story 50). pi's after_provider_response names
    // no provider, so its headers are attributed to the request in flight in
    // the same session: the physical model an auto-model request was routed
    // to (auto-model.ts), else the model the session's own request was sent
    // with, taken when that request started.
    const ownRequests = new Map<string, string>();
    const sessionIdOf = (ctx: ExtensionContext) => ctx.sessionManager?.getSessionId();
    pi.on("before_provider_request", (_event, ctx) => {
      const id = sessionIdOf(ctx);
      if (id === undefined) return undefined;
      const provider = ctx.model?.provider;
      // A request on the auto model was routed just before it started.
      if (isAutoModel(ctx.model)) ownRequests.delete(id);
      else if (provider === undefined) ownRequests.delete(id);
      else {
        autoModel.forget(id);
        ownRequests.set(id, provider);
      }
      return undefined;
    });
    pi.on("after_provider_response", async (event, ctx) => {
      const id = sessionIdOf(ctx);
      if (id === undefined) return;
      const provider = autoModel.providerInFlight(id) ?? ownRequests.get(id);
      if (provider === undefined) return;
      // Header reading is advice: a failure warns and never stops the response.
      try { await recordQuotaHeaders(autoDeps, provider, event.status, event.headers ?? {}); } catch (error) {
        autoDeps.warn(`quota-headers:${provider}`, `could not read the quota headers of a ${provider} response: ${String(error).split(/\r?\n/, 1)[0]}`);
      }
    });

    // Usage observations (PRD cml8, "Signals"): a worker's failed response
    // names the physical model it ran on, and a limit error in it marks that
    // model's provider in the usage store before the worker or pi's retry
    // goes on. A response whose routing failed names the auto model: no rung answered.
    pi.on("message_end", async (event, ctx) => {
      rememberPhysicalAnswer(event.message, ctx);
      const message = event.message as { role?: string; stopReason?: string; errorMessage?: string; provider?: string };
      // A queued steer or follow-up also shows a user message; only the pending
      // owner prompt is judged, so the judgement is one-shot per prompt.
      if (message.role === "user") { const judged = await judgeOwnerPrompt(ctx); await judgeHandlingPrompt(ctx, judged); return undefined; }
      if (message.role !== "assistant" || message.stopReason !== "error" || !isAutoModel(ctx.model)) return undefined;
      if (message.provider === undefined || message.provider === AUTO_PROVIDER) return undefined;
      await recordLimitError(autoDeps, message.provider, message.errorMessage);
      return undefined;
    });

    pi.on("model_select", (event, ctx) => {
      rememberSessionModel(event.model, ctx.thinkingLevel ?? "off", ctx);
    });
    pi.on("thinking_level_select", (event, ctx) => {
      rememberSessionModel(ctx.model, event.level, ctx);
      if (ourThinkingSelection === event.level) ourThinkingSelection = undefined;
      else if (sessionBand && isOrchestratorSession(ctx)) sessionEffortOff = true;
    });

    if (probe) process.stderr.write(`${ROUTER_PREFIX} loaded\n`);
  };
}

export default createRouterExtension();
