import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync } from "node:fs";
import { appendRoutingRecord, buildDecisionRecord, buildFailoverRecord, madeUnderConstraints, readRoutingRecords, RoutingRecordError,
  type DecisionRecord, type FailoverRecord } from "../routing/decision-record.ts";
import type { TierClassification } from "../routing/tier-classifier.ts";
import { splitKnownThinkingSuffix } from "../models/model-info.ts";
import { subagentBanListEntry, type BanLists } from "../policy/ban-lists.ts";
import { streamReasoning } from "../routing/session-classifier-call.ts";
import { autoStream } from "./auto-stream.ts";
import { ROUTER_PREFIX } from "./prefix.ts";
import { classifyTask, recordedRungPassesHardFilters, routeTask, type ActiveRouter } from "./route-task.ts";
import { withRoutingChoice } from "./routing-choice-lock.ts";
import { releaseRoutingChoice, reserveRoutingChoice } from "./routing-choice-reservations.ts";
import { parentDelegationOf, reviewedDelegationOf } from "../subagents/worker-sessions.ts";
import { publishServedRung, type RungEscalation } from "./served-rungs.ts";
import type { RiskTier } from "../routing/classifier.ts";
import type { ProviderUsage, RoutingConstraints } from "../routing/tier-router.ts";
import { providerOf } from "../recipients/authorized-delegation.ts";
import { limitErrorObservation } from "./limit-errors.ts";
import { recordUsageObservation, type UsageObservation } from "./usage-observations.ts";

type ProviderConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;

const RESUME_PINS = Symbol.for("pi-orchestrator.subagents.resume-pins");
const ROUTING_CONSTRAINTS = Symbol.for("pi-orchestrator.router.routing-constraints");
type Pin = { model: string; effort: string };
type ProcessGlobal = typeof globalThis & { [RESUME_PINS]?: Map<string, Pin>; [ROUTING_CONSTRAINTS]?: Map<string, RoutingConstraints> };
function resumePins(): Map<string, Pin> { return (globalThis as ProcessGlobal)[RESUME_PINS] ??= new Map(); }
/** A checked resume keeps its original pin without making a new routing decision. */
export function setResumePin(id: string, pin: Pin): () => void {
  resumePins().set(id, pin);
  return () => { resumePins().delete(id); };
}

// Like resume pins, constraints are set by the orchestrator's extension copy
// and read by the worker's, so they are kept on the process's global object.
function routingConstraints(): Map<string, RoutingConstraints> { return (globalThis as ProcessGlobal)[ROUTING_CONSTRAINTS] ??= new Map(); }
/** Routing constraints for the worker with session id `id`, read at its
 *  first request. Returns the function that removes them. */
export function setRoutingConstraints(id: string, constraints: RoutingConstraints): () => void {
  routingConstraints().set(id, constraints);
  return () => { routingConstraints().delete(id); };
}

export interface AutoProviderDependencies {
  readonly router: () => ActiveRouter | undefined;
  readonly registry: () => ExtensionContext["modelRegistry"];
  readonly now: () => Date;
  readonly banLists: () => BanLists;
  readonly disabled: () => boolean;
  readonly disable: (error: unknown) => void;
}

/** A pin and, when its routing decision escalated, the tiers it moved between. */
type ServedPin = Pin & { readonly escalation?: RungEscalation };

/** What a worker's first request was routed with, kept so a limit error
 *  before any output can route it again (PRD cml8, "Failover"), and the
 *  providers it was refused by so far. */
interface FailoverContext {
  readonly router: ActiveRouter;
  readonly taskText: string;
  readonly agentRole: string;
  readonly classification: TierClassification;
  readonly constraints: RoutingConstraints | undefined;
  readonly refusedProviders: Set<string>;
}

function escalationOf(route: { readonly startedAtTier: RiskTier; readonly tier: RiskTier }): { escalation?: RungEscalation } {
  return route.startedAtTier === route.tier ? {} : { escalation: { from: route.startedAtTier, to: route.tier } };
}

function contentText(content: string | readonly { type: string; text?: string }[]): string {
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("\n");
}

type Context = Parameters<NonNullable<ProviderConfig["streamSimple"]>>[1];

function latestDecision(dir: string, sessionId: string): DecisionRecord | undefined {
  try {
    return readRoutingRecords(dir).filter((record): record is DecisionRecord =>
      record.recordType === "decision" && record.delegationId === sessionId).at(-1);
  } catch (error) {
    if (error instanceof RoutingRecordError) return undefined;
    throw error;
  }
}

function canRestoreDecision(router: ActiveRouter, decision: DecisionRecord | undefined, sessionId: string,
  constraints: RoutingConstraints | undefined, taskText: string, at: Date): boolean {
  return decision?.mode === "live" && decision.delegationId === sessionId && decision.route.outcome === "chosen" &&
    (decision.ranOn === undefined || decision.ranOn === `${decision.route.rung.model}:${decision.route.rung.effort}`) &&
    madeUnderConstraints(decision, constraints) &&
    recordedRungPassesHardFilters(router, decision.route.rung, taskText, at, constraints);
}

function firstTaskAndRole(context: Context): { taskText: string; agentRole: string } {
  const messages = context.messages;
  const first = messages.find((message) => message.role === "user");
  const taskText = first ? contentText(first.content) : "";
  // pi's buildSystemPromptState puts ordinary prompts in sections, not content.
  // A forced prompt or later system update can use string or text-part content.
  const prompt = ["systemPrompt" in context && typeof context.systemPrompt === "string" ? context.systemPrompt : "",
    ...messages.filter((message) => message.role === "system").flatMap((message) => [
      contentText(message.content), ...Object.values(message.sections ?? {}).filter((value): value is string => typeof value === "string"),
    ])].join("\n");
  return { taskText, agentRole: prompt.match(/<active_agent\s+name=["']([^"']+)["']/)?.[1] ?? "unknown" };
}

class SessionModelError extends Error {}
class MissingRungError extends Error {}

function sessionPin(banLists: BanLists): { model: string; effort: string } {
  const value = process.env.PI_ORCHESTRATOR_SESSION_MODEL;
  if (!value) throw new SessionModelError("PI_ORCHESTRATOR_SESSION_MODEL is missing; no orchestrator session model is known");
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(value);
  if (!thinkingSuffix || !/^[^/]+\/.+$/.test(baseModel) || baseModel === "orchestrator/auto") {
    throw new SessionModelError(`PI_ORCHESTRATOR_SESSION_MODEL is invalid: ${value}`);
  }
  const banned = subagentBanListEntry(baseModel, banLists);
  if (banned) throw new SessionModelError(`orchestrator session model ${baseModel} is on the subagent ban list (entry '${banned}')`);
  return { model: baseModel, effort: thinkingSuffix.slice(1) };
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
      `is on ${provider}, which is out of usage. Usage limits: ${usageLimitsText(providerUsage)}. No request was sent to any provider.`);
  }
  return pin;
}

/** Records the usage observation a rung's error text gives for the rung's
 *  provider, in the usage store every later routing reads. Nothing is
 *  recorded with routing off, or for an error that is no limit. */
function recordLimitError(deps: AutoProviderDependencies, provider: string, text: string | undefined): void {
  const router = deps.disabled() ? undefined : deps.router();
  if (router === undefined || text === undefined) return;
  const observation = limitErrorObservation(text, deps.now());
  if (observation === undefined) return;
  try { recordUsageObservation(router.usagePath, provider, observation); } catch (error) { deps.disable(error); }
}

export function autoProviderConfig(deps: AutoProviderDependencies): ProviderConfig {
  const pins = new Map<string, ServedPin>();
  return {
    name: "Orchestrator auto", baseUrl: "http://localhost/unused", apiKey: "unused", api: "orchestrator-auto" as never,
    models: [{ id: "auto", name: "Orchestrator auto", reasoning: true, input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
    streamSimple(model, context, options) {
      const { stream, push, end } = autoStream();
      void (async () => {
        const started = performance.now();
        const sessionId = options?.sessionId;
        let wasPinned = false;
        let probeRung: string | undefined;
        let pendingDecision: DecisionRecord | undefined;
        let pendingFailover: FailoverRecord | undefined;
        let pendingRecordDir: string | undefined;
        let failover: FailoverContext | undefined;
        try {
          if (!sessionId) throw new Error("auto model request has no sessionId");
          const registry = deps.registry();
          if (!registry) throw new Error("auto model has no session model registry");
          function beginRequest(selected: ServedPin) {
            const slash = selected.model.indexOf("/");
            const rung = registry.find(selected.model.slice(0, slash), selected.model.slice(slash + 1));
            if (!rung) throw new MissingRungError(`pinned rung ${selected.model} is missing from the session model registry`);
            const { apiKey: _apiKey, headers: _headers, reasoning: _reasoning, ...rest } = options ?? {};
            const inward = { ...context, messages: context.messages.map((message) =>
              message.role === "assistant" && message.provider === model.provider && message.model === model.id
                ? { ...message, provider: rung.provider, model: rung.id, api: rung.api } : message) };
            const reasoning = streamReasoning(rung, selected.effort);
            const inner = registry.streamSimple(rung, inward, { ...rest, ...(reasoning === undefined ? {} : { reasoning }) });
            return { rung, inner };
          }
          let request: ReturnType<typeof beginRequest> | undefined;
          let startingRequest = false;
          let pin: ServedPin | undefined = resumePins().get(sessionId) ?? pins.get(sessionId);
          wasPinned = pin !== undefined;
          if (!pin) {
            const router = deps.disabled() ? undefined : deps.router();
            const constraints = routingConstraints().get(sessionId);
            if (!router) pin = fallbackPin(deps.banLists(), constraints, "allowed");
            else {
              const { taskText, agentRole } = firstTaskAndRole(context);
              // Classification may call a provider. Do it before taking the
              // shared queue; only choice and reservation must be serialized.
              let existing: DecisionRecord | undefined;
              try { existing = router.mode === "live" ? latestDecision(router.recordDir, sessionId) : undefined; }
              catch (error) {
                deps.disable(error);
                pin = fallbackPin(deps.banLists(), constraints, "allowed");
              }
              const resumable = canRestoreDecision(router, existing, sessionId, constraints, taskText, deps.now());
              let classification;
              if (!resumable && !pin) {
                try { classification = await classifyTask(router, taskText, agentRole); }
                catch (error) {
                  deps.disable(error);
                  pin = fallbackPin(deps.banLists(), constraints, "allowed");
                }
              }
              if (existing || classification) await withRoutingChoice(router.recordDir, async () => {
                try {
                  // The classifier may be slower than another worker's. Take
                  // the timestamp when choosing, after prior pins/reservations
                  // have been written, not before classification.
                  const at = deps.now();
                  const latest = router.mode === "live" ? latestDecision(router.recordDir, sessionId) : undefined;
                  // A decision made under other constraints could restore a rung these exclude.
                  if (canRestoreDecision(router, latest, sessionId, constraints, taskText, at) && latest?.route.outcome === "chosen") {
                    pin = { model: latest.route.rung.model, effort: latest.route.rung.effort, ...escalationOf(latest.route) };
                  } else {
                    classification ??= await classifyTask(router, taskText, agentRole);
                    const { route, providerUsage } = routeTask(router, taskText, classification, at, constraints);
                    pin = router.mode === "shadow" ? fallbackPin(router.banLists, constraints, "allowed")
                      : !route.ok ? fallbackPin(router.banLists, constraints, "refused", providerUsage)
                      : { model: route.rung.model, effort: route.rung.effort, ...escalationOf(route) };
                    const ranOn = `${pin.model}:${pin.effort}`;
                    const parentDelegationId = parentDelegationOf(sessionId);
                    const reviewedDelegationId = reviewedDelegationOf(sessionId);
                    const common = { delegationId: sessionId, at, taskText, agentRole, classification, tierMap: router.tierMap, route, ranOn,
                      ...(parentDelegationId === undefined ? {} : { parentDelegationId }), ...(constraints === undefined ? {} : { constraints }),
                      ...(reviewedDelegationId === undefined ? {} : { reviewedDelegationId }) };
                    const decision = buildDecisionRecord(router.mode === "shadow"
                      ? { ...common, mode: "shadow", handPickedModel: pin.model }
                      : { ...common, mode: "live" });
                    // A live chosen request may be lazy. Reserve its choice
                    // now, then commit the decision only after its first event
                    // proves that request preparation succeeded. Other choices
                    // see the reservation while it is pending.
                    mkdirSync(router.recordDir, { recursive: true });
                    startingRequest = true;
                    request = beginRequest(pin);
                    startingRequest = false;
                    if (router.mode === "live" && route.ok) {
                      reserveRoutingChoice(router.recordDir, sessionId, providerOf(pin.model), at);
                      pendingDecision = decision;
                      pendingRecordDir = router.recordDir;
                      // Only a new live choice can fail over: its request is
                      // the worker's first, and routing picked its rung.
                      failover = { router, taskText, agentRole, classification, constraints, refusedProviders: new Set() };
                    } else appendRoutingRecord(router.recordDir, decision);
                  }
                } catch (error) {
                  // An unavailable or banned session model is a refusal, not a router bug.
                  if (error instanceof SessionModelError || error instanceof MissingRungError || startingRequest) throw error;
                  deps.disable(error);
                  if (request) throw error; // Never start a second request after a record write failure.
                  pin = fallbackPin(deps.banLists(), constraints, "allowed");
                }
                if (!pin) throw new Error("auto model could not pin a rung");
                pins.set(sessionId, pin);
              });
            }
          }
          if (!pin) throw new Error("auto model could not pin a rung");

          /** Pins the worker again after its first request on `refused`
           *  answered with `limit` before any output: routes the task once
           *  more, now that the usage store holds the refused provider's
           *  observation, and starts the request on the chosen rung. Its
           *  decision and the failover record linking it to `refusedDecision`
           *  are held until that request's first event, like a first choice.
           *  `undefined` when routing has no other provider's rung left. */
          async function failOver(context: FailoverContext, refused: ServedPin, refusedDecision: DecisionRecord,
            limit: UsageObservation, errorText: string): Promise<{ pin: ServedPin } & ReturnType<typeof beginRequest> | undefined> {
            const { router, taskText, agentRole, classification, constraints, refusedProviders } = context;
            try { recordUsageObservation(router.usagePath, providerOf(refused.model), limit); }
            catch (error) { deps.disable(error); return undefined; }
            refusedProviders.add(providerOf(refused.model));
            return withRoutingChoice(router.recordDir, async () => {
              const at = deps.now();
              let route: ReturnType<typeof routeTask>["route"];
              try { ({ route } = routeTask(router, taskText, classification, at, constraints)); }
              catch (error) { deps.disable(error); return undefined; }
              if (!route.ok || refusedProviders.has(providerOf(route.rung.model))) return undefined;
              const next: ServedPin = { model: route.rung.model, effort: route.rung.effort, ...escalationOf(route) };
              const ranOn = `${next.model}:${next.effort}`;
              const parentDelegationId = parentDelegationOf(sessionId!);
              const reviewedDelegationId = reviewedDelegationOf(sessionId!);
              const decision = buildDecisionRecord({ delegationId: sessionId!, at, taskText, agentRole, classification, tierMap: router.tierMap,
                route, ranOn, mode: "live", ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
                ...(constraints === undefined ? {} : { constraints }), ...(reviewedDelegationId === undefined ? {} : { reviewedDelegationId }) });
              const record = buildFailoverRecord({ delegationId: sessionId!, at,
                refusedAttempt: { timestamp: refusedDecision.timestamp, rung: `${refused.model}:${refused.effort}` },
                limit: limit.state === "exhausted" ? "exhausted" : "throttled", ...(limit.resetsAt === undefined ? {} : { resetsAt: limit.resetsAt }),
                detail: errorText, rung: ranOn });
              // Should the new request not start, a later request routes again
              // instead of reusing the refused pin.
              pins.delete(sessionId!);
              const started = beginRequest(next);
              reserveRoutingChoice(router.recordDir, sessionId!, providerOf(next.model), at);
              pendingDecision = decision;
              pendingFailover = record;
              pendingRecordDir = router.recordDir;
              pins.set(sessionId!, next);
              return { pin: next, ...started };
            });
          }

          let attempt = { pin, ...(request ?? beginRequest(pin)) };
          for (;;) {
            probeRung = `${attempt.pin.model}:${attempt.pin.effort}`;
            const iterator = attempt.inner[Symbol.asyncIterator]();
            type Event = Awaited<ReturnType<typeof iterator.next>> extends IteratorResult<infer E> ? E : never;
            // Calling next() starts a lazy model request. A synchronous stream
            // factory is not evidence that a provider request was attempted.
            let first = await iterator.next();
            // Any first event shows the request was attempted on the rung, a
            // provider's error reply included (an overflow keeps its pin). Known
            // limit: pi-ai reports its own setup failures (an unconfigured
            // provider) as an error event of the same shape, so those count too.
            // The registry lookup and the authorization filter run first, which
            // keeps that case rare.
            const accepted = !first.done;
            const committed = accepted ? pendingDecision : undefined;
            if (pendingRecordDir) {
              const dir = pendingRecordDir;
              try {
                await withRoutingChoice(dir, async () => {
                  if (accepted && pendingFailover) appendRoutingRecord(dir, pendingFailover);
                  if (accepted && pendingDecision) appendRoutingRecord(dir, pendingDecision);
                  releaseRoutingChoice(dir, sessionId);
                  pendingRecordDir = undefined;
                  pendingDecision = undefined;
                  pendingFailover = undefined;
                });
              } catch (error) {
                deps.disable(error);
                // Nobody will read the started request once the worker fails.
                await iterator.return?.();
                throw error;
              }
              // A worker whose request was never accepted keeps no pin, so the
              // decision it did not record cannot be restored on a later request.
              if (!accepted) pins.delete(sessionId);
            }
            // The worker board shows the rung, which the relabelled replies below
            // never name. It reads the tier from the decision, so publish only
            // after the decision is persisted. A failover publishes its new rung.
            const { pin: served, rung } = attempt;
            if (accepted) publishServedRung({ delegationId: sessionId, model: served.model, effort: served.effort, ...(served.escalation ? { escalation: served.escalation } : {}) });
            // A start event carries no output yet, so it is held until the
            // rung shows whether it answers or refuses: a failover must not
            // leave the worker a second start.
            const held: Event[] = [];
            while (!first.done && first.value.type === "start") {
              held.push(first.value);
              first = await iterator.next();
            }
            // A limit error before any output on a new live choice fails over.
            // Any other error, and a limit later in the run, fails the worker.
            const refusal = failover && committed && !deps.disabled() && !first.done && first.value.type === "error" &&
              first.value.reason === "error" && first.value.error.errorMessage !== undefined
              ? { text: first.value.error.errorMessage, limit: limitErrorObservation(first.value.error.errorMessage, deps.now()) } : undefined;
            if (failover && committed && refusal?.limit) {
              const next = await failOver(failover, attempt.pin, committed, refusal.limit, refusal.text);
              if (next) {
                await iterator.return?.();
                attempt = next;
                continue;
              }
            }
            // A refusal that could not fail over already recorded its observation.
            const observed = refusal?.limit !== undefined;
            const forward = (event: Event) => {
              // Recorded before the worker sees the error, so later delegations route elsewhere.
              if (event.type === "error" && event.reason === "error" && !(observed && event === first.value)) recordLimitError(deps, rung.provider, event.error.errorMessage);
              const label = <T extends { provider: string; model: string; api: string }>(message: T): T =>
                ({ ...message, provider: model.provider, model: model.id, api: model.api });
              push({ ...event, ...("partial" in event && event.partial ? { partial: label(event.partial) } : {}),
                ...("message" in event && event.message ? { message: label(event.message) } : {}),
                ...("error" in event && event.error ? { error: label(event.error) } : {}) } as Parameters<typeof push>[0]);
            };
            for (const event of held) forward(event);
            for (let next = first; !next.done; next = await iterator.next()) forward(next.value);
            break;
          }
        } catch (error) {
          // A lazy request that fails during preparation must not leave a
          // choice behind. The lock protects cancellation from a new choice.
          if (pendingRecordDir && sessionId) {
            try { await withRoutingChoice(pendingRecordDir, async () => releaseRoutingChoice(pendingRecordDir!, sessionId)); }
            catch { /* preserve the original request error */ }
            pins.delete(sessionId);
          }
          const text = error instanceof Error ? error.message : String(error);
          push({ type: "error", reason: "error", error: { role: "assistant", content: [], api: model.api,
            provider: model.provider, model: model.id, stopReason: "error", errorMessage: text, timestamp: Date.now(),
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } });
        } finally {
          if (probeRung && process.env.PI_ORCHESTRATOR_ROUTER_PROBE === "1") process.stderr.write(`${ROUTER_PREFIX} request ${sessionId} rung ${probeRung}, pin ${wasPinned ? "reused" : "new"}, ${(performance.now() - started).toFixed(1)} ms\n`);
          end({ api: model.api, provider: model.provider, model: model.id });
        }
      })();
      return stream;
    },
  };
}
