import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toModelInfo, splitKnownThinkingSuffix, type ModelInfo } from "../models/model-info.ts";
import { AUTO_MODEL_ID, AUTO_MODEL_THINKING_LEVELS, AUTO_PROVIDER, createAutoModelRouter, isAutoModel, isVirtualModel, recordLimitError, recordQuotaHeaders,
  SESSION_MODEL_ENV, SESSION_VIRTUAL_MODEL_ENV, type AutoModelDependencies, type AutoModelState } from "./auto-model.ts";
import { autoModelLimits, type AutoModelLimits } from "./auto-model-limits.ts";
import { refuseAutoModelForMainThread } from "./main-thread.ts";
import type { ActiveRouter } from "./route-task.ts";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { banListsFromSettings, configureBanLists, loadBanListsOrDefaults, personalAgentDir, personalOrchestrator, readSettingsFile } from "../policy/ban-lists.ts";
import { isPlainObject } from "../guard/boundaries.ts";
import { ROUTING_MODES, type RoutingMode } from "../routing/decision-record.ts";
import { sessionClassifierModelCall, type SessionClassifierCallReport } from "../routing/session-classifier-call.ts";
import {
  classifierConfigFromSettings,
  loadClassifierChain,
  type ClassifierModelCall,
} from "../routing/tier-classifier.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { runInit } from "../init/command.ts";
import { setupNotice, setupStatus } from "../init/setup.ts";
import { registerSubcommands, type Subcommand } from "../init/subcommands.ts";
import { stateFolderEvidence, type EvidenceSetup, type RoutingEvidenceSource } from "./evidence.ts";
import { usageObservationsPath } from "./usage-observations.ts";
import { isOrchestratorSession } from "../subagents/orchestrator-session.ts";
import { publishOrchestratorRouter } from "./orchestrator-router.ts";

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
export const ROUTER_WARNING_PREFIX = "pi-orchestrator router warning:";
/** The oldest pi the router loads on: the first with `registerVirtualModel` (ADR 0014). */
export const REQUIRED_PI_VERSION = "0.99";
/** The load error on a pi host without `registerVirtualModel`. pi reports a
 *  throwing extension factory as a failed extension load. */
export const PI_TOO_OLD_MESSAGE = `pi-orchestrator requires pi v${REQUIRED_PI_VERSION} or later: this pi has no registerVirtualModel. Upgrade pi to v${REQUIRED_PI_VERSION} or later.`;
/** The keys of the warnings this process printed, each once, like the disabled line. */
const WARNINGS_REPORTED = Symbol.for("pi-orchestrator.router.warnings-reported");
type ProcessGlobal = typeof globalThis & { [DISABLED_LINE_REPORTED]?: boolean; [WARNINGS_REPORTED]?: Set<string> };

/** The state folder when `PI_ORCHESTRATOR_STATE_DIR` is not set: under the agent
 *  directory, never inside the package checkout. */
export function defaultStateDir(): string {
  return join(personalAgentDir(), "pi-orchestrator");
}

/** The state folder this session uses. */
export function stateDir(): string {
  return resolve(process.env.PI_ORCHESTRATOR_STATE_DIR ?? defaultStateDir());
}

export interface RouterDependencies {
  /** The classifier model call for this session. */
  readonly classifierCall: (ctx: ExtensionContext) => ClassifierModelCall;
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
  const chain = loadClassifierChain(classifierConfigFromSettings(personal));
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
    const autoDeps: AutoModelDependencies = {
      router: () => active, now: deps.now,
      banLists: () => active?.banLists ?? loadBanListsOrDefaults().banLists,
      disabled: () => disabled,
      disable: (error) => disable(error),
      warn: (key, message) => {
        const reported = (globalThis as ProcessGlobal)[WARNINGS_REPORTED] ??= new Set();
        if (reported.has(key)) return;
        reported.add(key);
        process.stderr.write(`${ROUTER_WARNING_PREFIX} ${message}\n`);
      },
    };
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

    // `/pi-orchestrator <subcommand>`. `init` sets up a fresh install. Its
    // failures are reported by the command and never disable routing. Other
    // extensions add their subcommands to the same command (subcommands.ts).
    const subcommands: Subcommand<ExtensionCommandContext>[] = [{
      name: "init",
      summary: "set up a starter tier map, ban list and approved recipients",
      run: async (rest, ctx) => {
        try { await runInit(`init ${rest}`, ctx, { stateDir: stateDir() }); }
        catch (error) { ctx.ui.notify(`pi-orchestrator init failed: ${String(error).split(/\r?\n/, 1)[0]}`, "error"); }
      },
    }];
    if (typeof pi.registerCommand === "function") registerSubcommands(pi, subcommands);

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
    pi.on("session_start", (_event, ctx) => {
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
    });

    pi.on("session_shutdown", () => {
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
    });

    if (probe) process.stderr.write(`${ROUTER_PREFIX} loaded\n`);
  };
}

export default createRouterExtension();
