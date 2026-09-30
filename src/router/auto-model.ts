import { VIRTUAL_MODEL_STATE_ENTRY, type ExtensionContext, type ModelRoute, type ModelRouteRequest } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { appendRoutingRecord, buildDecisionRecord, buildFailoverRecord } from "../routing/decision-record.ts";
import type { TierClassification } from "../routing/tier-classifier.ts";
import { splitKnownThinkingSuffix, THINKING_LEVELS, type ThinkingLevel } from "../models/model-info.ts";
import { subagentBanListEntry, type BanLists } from "../policy/ban-lists.ts";
import { ROUTER_PREFIX } from "./prefix.ts";
import { classifyTask, routeTask, type ActiveRouter } from "./route-task.ts";
import { withRoutingChoice } from "./routing-choice-lock.ts";
import { parentDelegationOf, reviewedDelegationOf } from "../subagents/worker-sessions.ts";
import { publishServedRung, type RungEscalation } from "./served-rungs.ts";
import { RISK_TIERS, type RiskTier } from "../routing/classifier.ts";
import type { ProviderUsage, RoutingConstraints } from "../routing/tier-router.ts";
import { providerOf } from "../recipients/authorized-delegation.ts";
import { limitErrorObservation } from "./limit-errors.ts";
import { limitLiftsAt, percentHoldsUntil, readUsageObservations, recordUsageObservation, replaces, type UsageObservation } from "./usage-observations.ts";
import { quotaHeaderObservation } from "./quota-headers.ts";

// The auto model `orchestrator/auto` as a pi virtual model (ADR 0014). pi
// calls `route` before every request a worker on the auto model makes, with
// the reason for the request and the router state last stored on the
// worker's session branch. The state is the worker's pin: pi stores it on the
// branch, so it follows the session tree through compaction and resume.
// Providers only see the physical model the route names, and assistant
// messages record it, so /session shows cost per physical model.

export const AUTO_PROVIDER = "orchestrator";
export const AUTO_MODEL_ID = "auto";
/** The thinking levels a worker may select on the auto model. The route
 *  ignores the selection: a rung's effort is its own. */
export const AUTO_MODEL_THINKING_LEVELS: readonly ThinkingLevel[] = THINKING_LEVELS;

export function isAutoModel(model: { readonly provider?: string; readonly id?: string } | undefined): boolean {
  return model?.provider === AUTO_PROVIDER && model.id === AUTO_MODEL_ID;
}

const ROUTING_CONSTRAINTS = Symbol.for("pi-orchestrator.router.routing-constraints");
type Pin = { readonly model: string; readonly effort: ThinkingLevel };
type ProcessGlobal = typeof globalThis & { [ROUTING_CONSTRAINTS]?: Map<string, RoutingConstraints> };

// Constraints are set by the orchestrator's extension copy and read by the
// worker's, so they are kept on the process's global object.
function routingConstraints(): Map<string, RoutingConstraints> { return (globalThis as ProcessGlobal)[ROUTING_CONSTRAINTS] ??= new Map(); }
/** Routing constraints for the worker with session id `id`, read at its
 *  first request. Returns the function that removes them. */
export function setRoutingConstraints(id: string, constraints: RoutingConstraints): () => void {
  routingConstraints().set(id, constraints);
  return () => { routingConstraints().delete(id); };
}

/** A worker's pin as the auto model's router state (JSON). `decisionId` is
 *  the timestamp of the decision record that chose the rung, which a
 *  failover record links to. `failedOver` is set once the worker's first
 *  request failed over; it fails over at most once. */
export interface AutoModelState {
  readonly rung: Pin;
  readonly tier?: RiskTier;
  /** The tier the decision started at, when it escalated to `tier`. */
  readonly escalatedFrom?: RiskTier;
  readonly decisionId?: string;
  readonly failedOver: boolean;
}

export interface AutoModelDependencies {
  readonly router: () => ActiveRouter | undefined;
  readonly now: () => Date;
  readonly banLists: () => BanLists;
  readonly disabled: () => boolean;
  readonly disable: (error: unknown) => void;
  /** Prints `message` once per process for `key`, leaving routing on. */
  readonly warn: (key: string, message: string) => void;
}

type Request = ModelRouteRequest<AutoModelState>;
type Route = ModelRoute<AutoModelState>;
type Registry = ExtensionContext["modelRegistry"];
type RouteContext = Pick<ExtensionContext, "modelRegistry" | "sessionManager">;

/** A pin and, when its routing decision escalated, the tiers it moved between. */
type ServedPin = Pin & { readonly escalation?: RungEscalation };

/** What a worker's first request was routed with, kept so a limit error
 *  before any output can route it again (PRD cml8, "Failover"). */
interface FailoverContext {
  readonly router: ActiveRouter;
  readonly taskText: string;
  readonly agentRole: string;
  readonly classification: TierClassification;
  readonly constraints: RoutingConstraints | undefined;
}

function escalationOf(route: { readonly startedAtTier: RiskTier; readonly tier: RiskTier }): { escalation?: RungEscalation } {
  return route.startedAtTier === route.tier ? {} : { escalation: { from: route.startedAtTier, to: route.tier } };
}

type Part = { readonly type: string; readonly text?: string; readonly thinking?: string };
type LooseMessage = { readonly role: string; readonly content?: string | readonly Part[]; readonly sections?: Readonly<Record<string, unknown>> };

function contentText(content: string | readonly Part[] | undefined): string {
  if (content === undefined) return "";
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

function firstTaskAndRole(messages: readonly LooseMessage[]): { taskText: string; agentRole: string } {
  const first = messages.find((message) => message.role === "user");
  const taskText = first ? contentText(first.content) : "";
  // pi's buildSystemPromptState puts ordinary prompts in sections, not content.
  // A forced prompt or later system update can use string or text-part content.
  const prompt = messages.filter((message) => message.role === "system").flatMap((message) => [
    contentText(message.content), ...Object.values(message.sections ?? {}).filter((value): value is string => typeof value === "string"),
  ]).join("\n");
  return { taskText, agentRole: prompt.match(/<active_agent\s+name=["']([^"']+)["']/)?.[1] ?? "unknown" };
}

/** Whether a failed response produced anything before its error. */
function producedOutput(message: { readonly content?: readonly Part[] | string }): boolean {
  const content = message.content;
  if (content === undefined) return false;
  if (typeof content === "string") return content !== "";
  return content.some((part) => part.type === "toolCall" || (part.type === "text" && (part.text ?? "") !== "") ||
    (part.type === "thinking" && (part.thinking ?? "") !== ""));
}

class SessionModelError extends Error {}
class MissingRungError extends Error {}

function sessionPin(banLists: BanLists): Pin {
  const value = process.env.PI_ORCHESTRATOR_SESSION_MODEL;
  if (!value) throw new SessionModelError("PI_ORCHESTRATOR_SESSION_MODEL is missing; no orchestrator session model is known");
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(value);
  if (!thinkingSuffix || !/^[^/]+\/.+$/.test(baseModel) || baseModel === `${AUTO_PROVIDER}/${AUTO_MODEL_ID}`) {
    throw new SessionModelError(`PI_ORCHESTRATOR_SESSION_MODEL is invalid: ${value}`);
  }
  const banned = subagentBanListEntry(baseModel, banLists);
  if (banned) throw new SessionModelError(`orchestrator session model ${baseModel} is on the subagent ban list (entry '${banned}')`);
  return { model: baseModel, effort: thinkingSuffix.slice(1) as ThinkingLevel };
}

/** Whether the fallback is checked: only when a live route refused. Then a
 *  fallback onto a worker's excluded rung is refused, and so is one whose
 *  provider is out of usage. In shadow mode and with routing off (not
 *  enabled, or switched off by an error) no other rung can be chosen, so a
 *  reviewer runs on the reviewed delegation's rung with its fresh context, a
 *  same-rung review (ADR 0010, owner decision 2026-09-28). */
type ExcludedFallback = "refused" | "allowed";

/** Each limited provider with what limits it, in provider order. */
function usageLimitsText(providerUsage: Readonly<Record<string, ProviderUsage>>): string {
  return Object.keys(providerUsage).sort().map((provider) => {
    const usage = providerUsage[provider]!;
    return `${provider}: ${usage.detail ?? (usage.state === "out-of-usage" ? "out of usage" : "throttled")}`;
  }).join("; ");
}

/** The session model a worker falls back to when routing is off, refuses or
 *  runs in shadow mode. After a live refusal a worker fails with the reason
 *  instead of running when its routing constraints exclude that rung, a
 *  reviewer on the reviewed delegation's rung (ADR 0010), or when the
 *  session model's provider is out of usage in `providerUsage`. */
function fallbackPin(banLists: BanLists, constraints: RoutingConstraints | undefined, excludedFallback: ExcludedFallback,
  providerUsage: Readonly<Record<string, ProviderUsage>> = {}): Pin {
  const pin = sessionPin(banLists);
  if (excludedFallback === "allowed") return pin;
  const excluded = constraints?.excludedRung;
  if (excluded?.model === pin.model && excluded.effort === pin.effort) {
    throw new SessionModelError(`no other rung is left: this worker would fall back to the orchestrator session model ${pin.model}:${pin.effort}, ` +
      "which its routing constraints exclude");
  }
  const provider = providerOf(pin.model);
  if (providerUsage[provider]?.state === "out-of-usage") {
    throw new SessionModelError(`routing refused this worker, and its fallback, the orchestrator session model ${pin.model}:${pin.effort}, ` +
      `is on ${provider}, which is out of usage. Usage limits: ${usageLimitsText(providerUsage)}. No worker request was sent.`);
  }
  return pin;
}

/** Records `observation` for `provider` in the usage store every later
 *  routing reads. A write that fails warns and leaves routing on: this
 *  process keeps the observation and goes on reading it (usage-observations.ts),
 *  so a failed write never routes this process's workers to a provider it saw
 *  limited. Other processes see it once a later write succeeds. */
export async function saveObservation(deps: AutoModelDependencies, router: ActiveRouter, provider: string, observation: UsageObservation): Promise<void> {
  try { await recordUsageObservation(router.usagePath, provider, observation, deps.now()); } catch (error) {
    const until = limitLiftsAt(observation);
    const reason = (error instanceof Error ? error.message : String(error)).split(/\r?\n/, 1)[0];
    deps.warn(`usage-store:${router.usagePath}:${provider}`, `could not save the usage observation for ${provider} ` +
      `(${observation.state}${until === undefined ? "" : ` until ${new Date(until).toISOString()}`}) in ${router.usagePath}: ${reason}. ` +
      `Routing in this process still ${until === undefined ? "reads it" : `avoids ${provider}`}; other sessions don't see it until a later write succeeds.`);
  }
}

/** Records the usage observation a rung's error text gives for the rung's
 *  provider. Nothing is recorded with routing off, or for an error that is no limit. */
export async function recordLimitError(deps: AutoModelDependencies, provider: string, text: string | undefined): Promise<void> {
  const router = deps.disabled() ? undefined : deps.router();
  if (router === undefined || text === undefined) return;
  const observation = limitErrorObservation(text, deps.now());
  if (observation !== undefined) await saveObservation(deps, router, provider, observation);
}

/** Records the percentage left that a response's quota headers give for
 *  `provider`, the provider of the request in flight (quota-headers.ts).
 *  Nothing is written with routing off, for a response without readable quota
 *  headers, while the store holds a limit from an error that still holds, or
 *  when the store already holds the same reading, still current: a worker's
 *  every response would otherwise write the shared store. */
export async function recordQuotaHeaders(deps: AutoModelDependencies, provider: string, status: number,
  headers: Readonly<Record<string, string>>): Promise<void> {
  const router = deps.disabled() ? undefined : deps.router();
  if (router === undefined) return;
  const now = deps.now();
  const observation = quotaHeaderObservation(status, headers, now);
  if (observation === undefined) return;
  const stored = readUsageObservations(router.usagePath, now)[provider];
  if (stored !== undefined) {
    const sameReading = stored.source === "header" && stored.state === observation.state && stored.percentLeft === observation.percentLeft &&
      stored.resetsAt === observation.resetsAt && Date.parse(observation.observedAt) < percentHoldsUntil(stored);
    if (!replaces(observation, stored, now) || sameReading) return;
  }
  await saveObservation(deps, router, provider, observation);
}

function isRiskTier(value: unknown): value is RiskTier {
  return typeof value === "string" && (RISK_TIERS as readonly string[]).includes(value);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

/** `state` when it is a pin this router stored, else undefined. */
function storedPin(state: unknown): AutoModelState | undefined {
  if (typeof state !== "object" || state === null) return undefined;
  const { rung, tier, escalatedFrom, decisionId, failedOver } = state as Record<string, unknown>;
  if (typeof rung !== "object" || rung === null) return undefined;
  const { model, effort } = rung as Record<string, unknown>;
  if (typeof model !== "string" || !/^[^/]+\/.+$/.test(model) || !isThinkingLevel(effort) || typeof failedOver !== "boolean") return undefined;
  if (tier !== undefined && !isRiskTier(tier)) return undefined;
  if (escalatedFrom !== undefined && !isRiskTier(escalatedFrom)) return undefined;
  if (decisionId !== undefined && typeof decisionId !== "string") return undefined;
  return state as AutoModelState;
}

function servedPinOf(state: AutoModelState): ServedPin {
  const { rung, tier, escalatedFrom } = state;
  return { ...rung, ...(escalatedFrom !== undefined && tier !== undefined ? { escalation: { from: escalatedFrom, to: tier } } : {}) };
}

function stateOf(pin: ServedPin, extra: { tier?: RiskTier; decisionId?: string; failedOver: boolean }): AutoModelState {
  return { rung: { model: pin.model, effort: pin.effort }, ...(extra.tier === undefined ? {} : { tier: extra.tier }),
    ...(pin.escalation === undefined ? {} : { escalatedFrom: pin.escalation.from }),
    ...(extra.decisionId === undefined ? {} : { decisionId: extra.decisionId }), failedOver: extra.failedOver };
}

/** The pin the session branch stores, for a direct request, which carries no state. */
function branchPin(ctx: RouteContext): AutoModelState | undefined {
  return savedAutoModelPin(ctx.sessionManager?.getBranch?.() ?? []);
}

/** The pin the latest auto model router state on `branch` holds, as pi reads
 *  it for the next request: how a resumed worker's saved session keeps its
 *  pin. `undefined` when the branch stores none, as in a worker session saved
 *  before the pin was router state, or the state is not a pin. */
export function savedAutoModelPin(branch: readonly unknown[]): AutoModelState | undefined {
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index] as { type?: string; customType?: string; data?: { provider?: unknown; modelId?: unknown; state?: unknown } };
    if (entry.type !== "custom" || entry.customType !== VIRTUAL_MODEL_STATE_ENTRY) continue;
    if (entry.data?.provider !== AUTO_PROVIDER || entry.data.modelId !== AUTO_MODEL_ID) continue;
    return storedPin(entry.data.state);
  }
  return undefined;
}

/** The first route's result: the pin, and the state to store for it, if any.
 *  With routing off, after an internal failure and with no classification,
 *  nothing is stored, so each later request routes again, as before. */
interface FirstRoute {
  readonly pin: ServedPin;
  readonly state?: AutoModelState;
}

export interface AutoModelRouter {
  route(request: Request, ctx: RouteContext): Promise<Route>;
  /** The provider of the physical model the latest request of session
   *  `sessionId` was routed to, or undefined when none was routed. */
  providerInFlight(sessionId: string): string | undefined;
  /** Forgets session `sessionId`'s routed provider, when its own request runs on a physical model. */
  forget(sessionId: string): void;
}

export function createAutoModelRouter(deps: AutoModelDependencies): AutoModelRouter {
  // pi's after_provider_response names no provider, and a worker's session
  // model is the auto model. So the provider each request was routed to is
  // kept by session id, for the quota headers of its response.
  const routedProviders = new Map<string, string>();
  const failovers = new Map<string, FailoverContext>();

  function physical(registry: Registry, pin: Pin) {
    const slash = pin.model.indexOf("/");
    const model = registry.find(pin.model.slice(0, slash), pin.model.slice(slash + 1));
    if (!model) throw new MissingRungError(`pinned rung ${pin.model} is missing from the session model registry`);
    return model;
  }

  function probe(sessionId: string, rung: string, pin: "new" | "reused", started: number): void {
    if (process.env.PI_ORCHESTRATOR_ROUTER_PROBE !== "1") return;
    process.stderr.write(`${ROUTER_PREFIX} request ${sessionId} rung ${rung}, pin ${pin}, ${(performance.now() - started).toFixed(1)} ms\n`);
  }

  function commonRecordFields(sessionId: string) {
    const parentDelegationId = parentDelegationOf(sessionId);
    const reviewedDelegationId = reviewedDelegationOf(sessionId);
    return { ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
      ...(reviewedDelegationId === undefined ? {} : { reviewedDelegationId }) };
  }

  /** Classifies and routes a worker's first request, writes its decision
   *  record, and returns its pin. */
  async function firstRoute(sessionId: string, messages: readonly LooseMessage[], registry: Registry): Promise<FirstRoute> {
    const router = deps.disabled() ? undefined : deps.router();
    const constraints = routingConstraints().get(sessionId);
    if (!router) return { pin: fallbackPin(deps.banLists(), constraints, "allowed") };
    const { taskText, agentRole } = firstTaskAndRole(messages);
    // Classification may call a provider. Do it before taking the shared
    // queue; only choice and record must be serialized.
    let classification: TierClassification;
    try { classification = await classifyTask(router, taskText, agentRole); }
    catch (error) {
      deps.disable(error);
      return { pin: fallbackPin(deps.banLists(), constraints, "allowed") };
    }
    return withRoutingChoice(router.recordDir, async (): Promise<FirstRoute> => {
      try {
        // The classifier may be slower than another worker's. Take the
        // timestamp when choosing, after prior decisions have been written,
        // not before classification.
        const at = deps.now();
        const { route, providerUsage } = routeTask(router, taskText, classification, at, constraints);
        const pin: ServedPin = router.mode === "shadow" ? fallbackPin(router.banLists, constraints, "allowed")
          : !route.ok ? fallbackPin(router.banLists, constraints, "refused", providerUsage)
          : { model: route.rung.model, effort: route.rung.effort as ThinkingLevel, ...escalationOf(route) };
        // A rung pi cannot send to fails the worker before it counts as pinned.
        physical(registry, pin);
        const common = { delegationId: sessionId, at, taskText, agentRole, classification, tierMap: router.tierMap, route,
          ranOn: `${pin.model}:${pin.effort}`, ...commonRecordFields(sessionId), ...(constraints === undefined ? {} : { constraints }) };
        const decision = buildDecisionRecord(router.mode === "shadow"
          ? { ...common, mode: "shadow", handPickedModel: pin.model }
          : { ...common, mode: "live" });
        mkdirSync(router.recordDir, { recursive: true });
        appendRoutingRecord(router.recordDir, decision);
        const live = router.mode === "live" && route.ok;
        // Only a new live choice can fail over: routing picked its rung.
        if (live) failovers.set(sessionId, { router, taskText, agentRole, classification, constraints });
        return { pin, state: stateOf(pin, { ...(live ? { tier: route.tier } : {}), decisionId: decision.timestamp, failedOver: false }) };
      } catch (error) {
        // An unavailable or banned session model is a refusal, not a router bug.
        if (error instanceof SessionModelError || error instanceof MissingRungError) throw error;
        deps.disable(error);
        return { pin: fallbackPin(deps.banLists(), constraints, "allowed") };
      }
    });
  }

  /** Pins the worker again after its first request on `state`'s rung
   *  answered with a limit error before any output: records the usage
   *  observation, routes the task once more, now that the usage store holds
   *  the refused provider's limit, and writes the failover record linked to
   *  the refused decision and the new decision. `undefined` when the request
   *  cannot fail over or routing has no other provider's rung left. */
  async function failOver(sessionId: string, state: AutoModelState, request: Request, registry: Registry): Promise<FirstRoute | undefined> {
    const failed = request.failed;
    const context = failovers.get(sessionId);
    if (failed === undefined || context === undefined || state.failedOver || state.decisionId === undefined || request.previous !== undefined ||
      deps.disabled() || producedOutput(failed.message as { content?: readonly Part[] })) return undefined;
    const errorText = failed.message.errorMessage;
    const limit = errorText === undefined ? undefined : limitErrorObservation(errorText, deps.now());
    if (errorText === undefined || limit === undefined) return undefined;
    // One attempt: a later retry of this request stays on the pin.
    failovers.delete(sessionId);
    const { router, taskText, agentRole, classification, constraints } = context;
    const refusedProvider = providerOf(state.rung.model);
    await saveObservation(deps, router, refusedProvider, limit);
    return withRoutingChoice(router.recordDir, async () => {
      const at = deps.now();
      let route: ReturnType<typeof routeTask>["route"];
      try { ({ route } = routeTask(router, taskText, classification, at, constraints)); }
      catch (error) { deps.disable(error); return undefined; }
      if (!route.ok || providerOf(route.rung.model) === refusedProvider) return undefined;
      const next: ServedPin = { model: route.rung.model, effort: route.rung.effort as ThinkingLevel, ...escalationOf(route) };
      try { physical(registry, next); } catch { return undefined; }
      const ranOn = `${next.model}:${next.effort}`;
      const decision = buildDecisionRecord({ delegationId: sessionId, at, taskText, agentRole, classification, tierMap: router.tierMap,
        route, ranOn, mode: "live", ...commonRecordFields(sessionId), ...(constraints === undefined ? {} : { constraints }) });
      const record = buildFailoverRecord({ delegationId: sessionId, at,
        refusedAttempt: { timestamp: state.decisionId!, rung: `${state.rung.model}:${state.rung.effort}` },
        limit: limit.state === "exhausted" ? "exhausted" : "throttled", ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
        detail: errorText, rung: ranOn });
      try {
        appendRoutingRecord(router.recordDir, record);
        appendRoutingRecord(router.recordDir, decision);
      } catch (error) {
        // Never send a request the records do not show.
        deps.disable(error);
        throw error;
      }
      return { pin: next, state: stateOf(next, { tier: route.tier, decisionId: decision.timestamp, failedOver: true }) };
    });
  }

  return {
    providerInFlight: (sessionId) => routedProviders.get(sessionId),
    forget: (sessionId) => { routedProviders.delete(sessionId); },
    async route(request, ctx) {
      const started = performance.now();
      const sessionId = ctx.sessionManager?.getSessionId();
      if (!sessionId) throw new Error("auto model request has no session id");
      const registry = ctx.modelRegistry;
      if (!registry) throw new Error("auto model has no session model registry");
      const messages = request.messages as unknown as readonly LooseMessage[];

      /** The route to `pin`. A worker's rung is published for the worker board
       *  (served-rungs.ts); a direct request's is not. */
      const to = (pin: ServedPin, state: AutoModelState | undefined, kind: "new" | "reused", publish = true): Route => {
        const model = physical(registry, pin);
        routedProviders.set(sessionId, model.provider);
        if (publish) publishServedRung({ delegationId: sessionId, model: pin.model, effort: pin.effort, ...(pin.escalation ? { escalation: pin.escalation } : {}) });
        probe(sessionId, `${pin.model}:${pin.effort}`, kind, started);
        return { model, thinkingLevel: pin.effort, ...(state === undefined ? {} : { state }) };
      };
      /** Back on a physical model pi already sent to: a retry's failed model or a direct request's previous one. */
      const back = (sent: { readonly model: { readonly provider: string; readonly id: string }; readonly thinkingLevel?: ThinkingLevel },
        fallback: ThinkingLevel): Route => {
        const model = registry.find(sent.model.provider, sent.model.id);
        if (!model) throw new MissingRungError(`rung ${sent.model.provider}/${sent.model.id} is missing from the session model registry`);
        const effort = sent.thinkingLevel ?? fallback;
        routedProviders.set(sessionId, model.provider);
        probe(sessionId, `${model.provider}/${model.id}:${effort}`, "reused", started);
        return { model, thinkingLevel: effort };
      };

      // A direct request (a compaction summary, an extension's streamSimple)
      // carries no state: it goes to the model that answered last, else to
      // the pin the branch stores. With neither it routes as a first request,
      // and pi ignores any state it returns.
      if (request.reason === "direct") {
        const stored = branchPin(ctx);
        if (request.previous) return back(request.previous, stored?.rung.effort ?? request.thinkingLevel);
        if (stored) return to(servedPinOf(stored), undefined, "reused", false);
        const first = await firstRoute(sessionId, messages, registry);
        return to(first.pin, undefined, "new", false);
      }

      const state = storedPin(request.state);
      if (state) {
        if (request.reason === "retry" && request.failed) {
          const next = await failOver(sessionId, state, request, registry);
          if (next) return to(next.pin, next.state, "new");
          return back(request.failed, state.rung.effort);
        }
        // A worker that answered once can no longer fail over.
        if (request.previous !== undefined) failovers.delete(sessionId);
        return to(servedPinOf(state), request.state, "reused");
      }
      // pi retries a failed request that has no pin stored on the model it failed on.
      if (request.reason === "retry" && request.failed) return back(request.failed, request.thinkingLevel);
      const first = await firstRoute(sessionId, messages, registry);
      return to(first.pin, first.state, "new");
    },
  };
}
