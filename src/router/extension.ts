import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { toModelInfo, splitKnownThinkingSuffix, type ModelInfo } from "../models/model-info.ts";
import { autoProviderConfig } from "./auto-provider.ts";
import { autoModelLimits, withAutoModelLimits } from "./auto-model-limits.ts";
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
import { INIT_COMMAND, setupNotice, setupStatus } from "../init/setup.ts";
import { stateFolderEvidence, type EvidenceSetup, type RoutingEvidenceSource } from "./evidence.ts";

export type { RoutingEvidence, RoutingEvidenceSource, EvidenceSetup } from "./evidence.ts";

// The router extension (ADR 0006): a personal pi extension, separate from the
// guard, that serves the auto model `orchestrator/auto` as the `orchestrator`
// provider. It hooks no tool calls.

import { ROUTER_PREFIX } from "./prefix.ts";
export { ROUTER_PREFIX };
export const ROUTER_DISABLED_PREFIX = "pi-orchestrator router disabled:";
/** pi loads each extension with a fresh module copy (jiti moduleCache: false),
 *  so the once-per-process disabled line is kept on the process's global object. */
export const DISABLED_LINE_REPORTED = Symbol.for("pi-orchestrator.router.disabled-line-reported");
type ProcessGlobal = typeof globalThis & { [DISABLED_LINE_REPORTED]?: boolean };

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
    installedModels,
  };
}

export function createRouterExtension(overrides: Partial<RouterDependencies> = {}) {
  const deps: RouterDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return function router(pi: ExtensionAPI): void {
    // Fail open, as the guard does: the first failure anywhere prints one
    // line and stops routing for the rest of the session; workers then run
    // on the orchestrator's model.
    let disabled = false;
    let active: ActiveRouter | undefined;
    let sessionRegistry: ExtensionContext["modelRegistry"];
    const autoConfig = autoProviderConfig({
      router: () => active, registry: () => sessionRegistry, now: deps.now,
      banLists: () => active?.banLists ?? loadBanListsOrDefaults().banLists,
      disabled: () => disabled,
      disable: (error) => disable(error),
    });
    if (typeof pi.registerProvider === "function") pi.registerProvider("orchestrator", autoConfig);
    refuseAutoModelForMainThread(pi);
    const disable = (error: unknown) => {
      active = undefined;
      if (disabled) return;
      disabled = true;
      if ((globalThis as ProcessGlobal)[DISABLED_LINE_REPORTED]) return;
      (globalThis as ProcessGlobal)[DISABLED_LINE_REPORTED] = true;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`${ROUTER_DISABLED_PREFIX} ${message.split(/\r?\n/, 1)[0]}\n`);
      if (process.env.PI_ORCHESTRATOR_ROUTER_DEBUG === "1") process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    };
    const probe = process.env.PI_ORCHESTRATOR_ROUTER_PROBE === "1";

    // `/pi-orchestrator init` sets up a fresh install. Its failures are
    // reported by the command and never disable routing.
    if (typeof pi.registerCommand === "function") pi.registerCommand(INIT_COMMAND, {
      description: "Set up pi-orchestrator: starter tier map, ban list and approved recipients (init)",
      handler: async (args, ctx) => {
        try { await runInit(args, ctx, { stateDir: stateDir() }); }
        catch (error) { ctx.ui.notify(`pi-orchestrator init failed: ${String(error).split(/\r?\n/, 1)[0]}`, "error"); }
      },
    });

    const rememberSessionModel = (model: { provider: string; id: string } | undefined, effort: string) => {
      if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1") return;
      if (model?.provider === "orchestrator" && model.id === "auto") return;
      if (model) process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${model.provider}/${model.id}:${effort}`;
      else delete process.env.PI_ORCHESTRATOR_SESSION_MODEL;
    };
    let noticeShown = false;
    pi.on("session_start", (_event, ctx) => {
      rememberSessionModel(ctx.model, ctx.thinkingLevel ?? "off");
      sessionRegistry = ctx.modelRegistry;
      if (disabled) return;
      try {
        // One line on a fresh install, in the owner's session only.
        if (!noticeShown && process.env.PI_SUBAGENT_CHILD !== "1") {
          noticeShown = true;
          const personal = readSettingsFile(join(personalAgentDir(), "settings.json")) ?? {};
          const notice = setupNotice(setupStatus(personal, stateDir()), stateDir());
          if (notice) {
            if (ctx.hasUI) ctx.ui.notify(notice, "warning");
            else process.stderr.write(`${notice}\n`);
          }
        }
        active = startRouting(ctx, deps);
        if (active && typeof pi.registerProvider === "function") {
          pi.registerProvider("orchestrator", withAutoModelLimits(autoConfig, autoModelLimits(active.tierMap, active.installedModels)));
        }
        if (probe && active) process.stderr.write(`${ROUTER_PREFIX} routing enabled, mode ${active.mode}, records ${active.recordDir}\n`);
      } catch (error) { disable(error); }
    });

    pi.on("model_select", (event, ctx) => {
      rememberSessionModel(event.model, ctx.thinkingLevel ?? "off");
    });
    pi.on("thinking_level_select", (event, ctx) => {
      rememberSessionModel(ctx.model, event.level);
    });

    if (probe) process.stderr.write(`${ROUTER_PREFIX} loaded\n`);
  };
}

export default createRouterExtension();
