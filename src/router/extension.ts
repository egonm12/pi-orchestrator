import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { toModelInfo, splitKnownThinkingSuffix, type ModelInfo } from "../subagents/model-info.ts";
import { discoverAgents, resolveAgentName, type AgentConfig } from "../subagents/agents.ts";
import { resolveExecutionAgentScope } from "../subagents/agents.ts";
import { INHERIT_MODEL, resolveEffectiveSubagentModel } from "../subagents/model-resolution.ts";
import { newTaskLedger, TaskAllowanceOwner, allowanceConstraint } from "../budget/task-allowance.ts";
import { banListsFromSettings, configureBanLists, personalAgentDir, personalOrchestrator, readSettingsFile, type BanLists } from "../policy/ban-lists.ts";
import { delegationObjects, isModelField, isPlainObject } from "../guard/boundaries.ts";
import {
  appendRoutingRecord,
  buildDecisionRecord,
  buildExplicitModelRecord,
  ROUTING_MODES,
  type RoutingMode,
  type RoutingRecord,
} from "../routing/decision-record.ts";
import { sessionClassifierModelCall, type SessionClassifierCallReport } from "../routing/session-classifier-call.ts";
import {
  classifierConfigFromSettings,
  classifyTier,
  loadClassifierChain,
  type ClassifierModelCall,
  type LoadedClassifierChain,
} from "../routing/tier-classifier.ts";
import { tierMapFromSettings, type ResolvedTierMap } from "../routing/tier-map.ts";
import { routeTier } from "../routing/tier-router.ts";
import { runInit } from "../init/command.ts";
import { INIT_COMMAND, setupNotice, setupStatus } from "../init/setup.ts";
import { deriveProviderUsage, stateFolderEvidence, type EvidenceSetup, type RoutingEvidenceSource } from "./evidence.ts";

export type { RoutingEvidence, RoutingEvidenceSource, EvidenceSetup } from "./evidence.ts";

// Ticket 27: the router extension (stories 38 to 44). A personal pi extension,
// separate from the guard, hooked on `tool_call` for `subagent`.

export const ROUTER_PREFIX = "pi-orchestrator router:";
export const ROUTER_DISABLED_PREFIX = "pi-orchestrator router disabled:";

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

interface ActiveRouter {
  readonly mode: RoutingMode;
  readonly tierMap: ResolvedTierMap;
  readonly banLists: BanLists;
  readonly chain: LoadedClassifierChain;
  readonly callModel: ClassifierModelCall;
  readonly evidence: RoutingEvidenceSource;
  readonly owner: TaskAllowanceOwner;
  readonly recordDir: string;
  /** pi's available models, as pi-subagents resolves a child's model. */
  readonly installedModels: readonly ModelInfo[];
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

interface Slot {
  readonly path: string;
  readonly object: Record<string, unknown>;
}

const NESTED_SLOT = /^(?:tasks\[\d+\]|chain\[\d+\]|workflow\.steps\[\d+\])$/;

/** The model a slot names: a model field (the guard's rule) holding a
 *  non-blank string. A blank value names no model, so the slot is routed. */
function namedModel(object: Record<string, unknown>): string | undefined {
  for (const [key, value] of Object.entries(object)) {
    if (isModelField(key) && typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

/**
 * The delegation slots of a `subagent` call, over the guard's walk
 * (`delegationObjects`): the top level when it names an agent, a task or a
 * model, then each `tasks[i]`, `chain[i]` and `workflow.steps[i]`. A model
 * named at the top level covers the nested slots, so they are not routed.
 */
function delegationSlots(input: Record<string, unknown>): Slot[] {
  if (namedModel(input) !== undefined) return [{ path: "", object: input }];
  const top = text(input.agent) !== undefined || text(input.task) !== undefined;
  const nested = delegationObjects(input, true).filter((entry) => NESTED_SLOT.test(entry.path));
  return [...(top ? [{ path: "", object: input }] : []), ...nested];
}

const WRAPPING = /^[\s"'`([{<]+|[\s"'`)\]}>.,;:!?]+$/g;
const FILE_NAME = /^[\w.-]*[\w-]{2}\.[A-Za-z][A-Za-z0-9]{0,7}$/;

/**
 * The file paths a task text names, by a deliberately simple rule, not a
 * parser: split on whitespace, strip surrounding quotes, backticks, brackets
 * and trailing punctuation, drop URLs (`://`), and keep a word that contains
 * a `/` or looks like a file name with an extension (`README.md`; two
 * characters before the dot, so `e.g` is not one). First mention first, each
 * once.
 */
function namedPaths(taskText: string): string[] {
  const paths: string[] = [];
  for (const word of taskText.split(/\s+/)) {
    const candidate = word.replace(WRAPPING, "");
    if (candidate.length === 0 || candidate.includes("://")) continue;
    if ((candidate.includes("/") || FILE_NAME.test(candidate)) && !paths.includes(candidate)) paths.push(candidate);
  }
  return paths;
}

function slotName(path: string): string {
  return path === "" ? "model" : `${path}.model`;
}

interface SlotPlan {
  readonly record: RoutingRecord;
  /** Live mode, rung chosen: the rung to write into the slot. */
  readonly write?: { readonly object: Record<string, unknown>; readonly rung: string };
}

async function planSlot(
  router: ActiveRouter,
  input: Record<string, unknown>,
  slot: Slot,
  delegationId: string,
  at: Date,
  ctx: ExtensionContext,
): Promise<SlotPlan> {
  const taskText = text(slot.object.task) ?? text(input.task) ?? "";
  const agentName = text(slot.object.agent) ?? text(input.agent);
  const agentRole = agentName ?? "unknown";
  const explicit = (slotLabel: string, model: string): SlotPlan => ({
    record: buildExplicitModelRecord({ delegationId, at, mode: router.mode, slot: slotLabel, model, taskText, agentRole }),
  });
  const model = namedModel(slot.object);
  if (model !== undefined) return explicit(slotName(slot.path), model);
  const agent = agentName === undefined ? undefined : discoveredAgent(agentName, input, ctx);
  const pinned = definitionModel(agent);
  if (agent !== undefined && pinned !== undefined) return explicit(`agent:${agent.name}.model`, pinned);
  const evidence = router.evidence();
  const classification = await classifyTier(
    { task: taskText, role: agentRole, paths: namedPaths(taskText) },
    { chain: router.chain, callModel: router.callModel, allowance: { owner: router.owner, catalog: evidence.catalog } },
  );
  const estimatedPromptTokens = Buffer.byteLength(taskText, "utf8");
  const route = routeTier({
    tier: classification.tier,
    tierMap: router.tierMap,
    evidence: {
      providerUsage: deriveProviderUsage(evidence, at),
      catalog: evidence.catalog,
      estimatedPromptTokens,
      allowance: allowanceConstraint(router.owner, evidence.catalog, { role: "subtask", maxInputTokens: estimatedPromptTokens }),
      authorization: evidence.authorization,
      banLists: router.banLists,
    },
  });
  const common = { delegationId, at, taskText, agentRole, classification, tierMap: router.tierMap, route };
  if (router.mode === "live") {
    const record = buildDecisionRecord({ ...common, mode: "live" });
    return route.ok ? { record, write: { object: slot.object, rung: route.rung.rung } } : { record };
  }
  return { record: buildDecisionRecord({ ...common, mode: "shadow", handPickedModel: handPickedModel(agent, router.installedModels, ctx) }) };
}

/** The agent a slot names, found the way pi-subagents finds it for this call:
 *  its discovery for the call's `agentScope` (default both) and its name,
 *  local-name and alias lookup. Discovery reads the agent files and the
 *  `subagents` settings, with pi-subagents' own fingerprinted cache; a
 *  malformed `subagents` key throws, which disables the router. */
function discoveredAgent(name: string, input: Record<string, unknown>, ctx: ExtensionContext): AgentConfig | undefined {
  const scope = resolveExecutionAgentScope(input.agentScope);
  return resolveAgentName(name, discoverAgents(ctx.cwd, scope, ctx.model?.provider).agents).agent;
}

/** A model the agent's definition pins: its frontmatter `model` or a builtin
 *  override's. A `subagents.defaultModel` from settings fills `model` as well,
 *  marked by `modelSource` (pi-subagents tells them apart the same way,
 *  agent-management.js:1063); it is a global default, not a pin, so it is
 *  routed over. `inherit` names the session model and pins nothing. */
function definitionModel(agent: AgentConfig | undefined): string | undefined {
  const model = agent?.model?.trim();
  if (model === undefined || model === "" || model === INHERIT_MODEL) return undefined;
  if (agent?.modelSource?.type === "subagents.defaultModel" && agent.modelSource.model === agent.model) return undefined;
  return model;
}

/** The model pi resolves for a slot that names none, canonical `provider/id`
 *  with the thinking suffix stripped: pi-subagents' own resolution
 *  (`resolveEffectiveSubagentModel`, runs/shared/model-resolution.js:281) of
 *  the agent's `model` (here only a `subagents.defaultModel`, since a pinned
 *  one is explicit), else the session model. */
function handPickedModel(agent: AgentConfig | undefined, installedModels: readonly ModelInfo[], ctx: ExtensionContext): string {
  if (ctx.model === undefined) throw new Error("shadow mode records the session model, and pi supplied none");
  const parent = { provider: ctx.model.provider, id: ctx.model.id };
  const resolved = resolveEffectiveSubagentModel(undefined, agent?.model, parent, [...installedModels], agent?.modelProvider ?? parent.provider);
  return splitKnownThinkingSuffix(resolved ?? `${parent.provider}/${parent.id}`).baseModel;
}

export function createRouterExtension(overrides: Partial<RouterDependencies> = {}) {
  const deps: RouterDependencies = { ...DEFAULT_DEPENDENCIES, ...overrides };
  return function router(pi: ExtensionAPI): void {
    // Fail open, as the guard does: the first failure anywhere prints one
    // line and leaves the hook inert for the rest of the session.
    let disabled = false;
    let active: ActiveRouter | undefined;
    const disable = (error: unknown) => {
      active = undefined;
      if (disabled) return;
      disabled = true;
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

    let noticeShown = false;
    pi.on("session_start", (_event, ctx) => {
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
        if (probe && active) process.stderr.write(`${ROUTER_PREFIX} routing enabled, mode ${active.mode}, records ${active.recordDir}\n`);
      } catch (error) { disable(error); }
    });

    pi.on("tool_call", async (event: ToolCallEvent, ctx: ExtensionContext) => {
      if (disabled || active === undefined || event.toolName !== "subagent") return;
      const started = performance.now();
      try {
        const router = active;
        const at = deps.now();
        const plans: SlotPlan[] = [];
        for (const slot of delegationSlots(event.input)) {
          const delegationId = slot.path === "" ? event.toolCallId : `${event.toolCallId}:${slot.path}`;
          plans.push(await planSlot(router, event.input, slot, delegationId, at, ctx));
        }
        // Every record is written before the call changes, so a failed write
        // leaves the call exactly as the orchestrator made it.
        for (const plan of plans) appendRoutingRecord(router.recordDir, plan.record);
        for (const plan of plans) if (plan.write) plan.write.object.model = plan.write.rung;
        if (probe) {
          const elapsed = (performance.now() - started).toFixed(1);
          process.stderr.write(`${ROUTER_PREFIX} hook ${elapsed} ms for ${plans.length} slot(s), mode ${router.mode}\n`);
        }
      } catch (error) { disable(error); }
      // Never a block: refusing a call is the guard's job, not the router's.
      return undefined;
    });
    if (probe) process.stderr.write(`${ROUTER_PREFIX} loaded\n`);
  };
}

export default createRouterExtension();
