import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendRoutingRecord, buildDecisionRecord, madeUnderConstraints, readRoutingRecords, RoutingRecordError, type DecisionRecord } from "../routing/decision-record.ts";
import { splitKnownThinkingSuffix } from "../models/model-info.ts";
import { subagentBanListEntry, type BanLists } from "../policy/ban-lists.ts";
import { streamReasoning } from "../routing/session-classifier-call.ts";
import { autoStream } from "./auto-stream.ts";
import { ROUTER_PREFIX } from "./prefix.ts";
import { recordedRungPassesHardFilters, routeTask, type ActiveRouter } from "./route-task.ts";
import { parentDelegationOf, reviewedDelegationOf } from "../subagents/worker-sessions.ts";
import { publishServedRung, type RungEscalation } from "./served-rungs.ts";
import type { RiskTier } from "../routing/classifier.ts";
import type { RoutingConstraints } from "../routing/tier-router.ts";

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

/** Whether a fallback onto a worker's excluded rung is refused: only when a
 *  live route refused. In shadow mode and with routing off (not enabled, or
 *  switched off by an error) no other rung can be chosen, so a reviewer runs
 *  on the reviewed delegation's rung with its fresh context, a same-rung
 *  review (ADR 0010, owner decision 2026-09-28). */
type ExcludedFallback = "refused" | "allowed";

/** The session model a worker falls back to when routing is off, refuses or
 *  runs in shadow mode. After a live refusal a worker whose routing
 *  constraints exclude that rung, a reviewer on the reviewed delegation's rung
 *  (ADR 0010), fails with the reason instead of running. */
function fallbackPin(banLists: BanLists, constraints: RoutingConstraints | undefined, excludedFallback: ExcludedFallback): Pin {
  const pin = sessionPin(banLists);
  const excluded = constraints?.excludedRung;
  if (excludedFallback === "refused" && excluded?.model === pin.model && excluded.effort === pin.effort) {
    throw new SessionModelError(`no other rung is left: this worker would fall back to the orchestrator session model ${pin.model}:${pin.effort}, ` +
      "which its routing constraints exclude");
  }
  return pin;
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
        try {
          if (!sessionId) throw new Error("auto model request has no sessionId");
          const registry = deps.registry();
          if (!registry) throw new Error("auto model has no session model registry");
          let pin: ServedPin | undefined = resumePins().get(sessionId) ?? pins.get(sessionId);
          wasPinned = pin !== undefined;
          if (!pin) {
            const router = deps.disabled() ? undefined : deps.router();
            const constraints = routingConstraints().get(sessionId);
            if (!router) pin = fallbackPin(deps.banLists(), constraints, "allowed");
            else {
              try {
                const at = deps.now();
                const { taskText, agentRole } = firstTaskAndRole(context);
                const latest = router.mode === "live" ? latestDecision(router.recordDir, sessionId) : undefined;
                // A decision made under other constraints could restore a rung these exclude.
                if (latest?.mode === "live" && latest.route.outcome === "chosen" &&
                  (latest.ranOn === undefined || latest.ranOn === `${latest.route.rung.model}:${latest.route.rung.effort}`) &&
                  madeUnderConstraints(latest, constraints) &&
                  recordedRungPassesHardFilters(router, latest.route.rung, taskText, at, constraints)) {
                  pin = { model: latest.route.rung.model, effort: latest.route.rung.effort, ...escalationOf(latest.route) };
                } else {
                  const { classification, route } = await routeTask(router, taskText, agentRole, at, constraints);
                  pin = router.mode === "shadow" ? fallbackPin(router.banLists, constraints, "allowed")
                    : !route.ok ? fallbackPin(router.banLists, constraints, "refused")
                    : { model: route.rung.model, effort: route.rung.effort, ...escalationOf(route) };
                  const ranOn = `${pin.model}:${pin.effort}`;
                  const parentDelegationId = parentDelegationOf(sessionId);
                  const reviewedDelegationId = reviewedDelegationOf(sessionId);
                  const common = { delegationId: sessionId, at, taskText, agentRole, classification, tierMap: router.tierMap, route, ranOn,
                    ...(parentDelegationId === undefined ? {} : { parentDelegationId }), ...(constraints === undefined ? {} : { constraints }),
                    ...(reviewedDelegationId === undefined ? {} : { reviewedDelegationId }) };
                  appendRoutingRecord(router.recordDir, buildDecisionRecord(router.mode === "shadow"
                    ? { ...common, mode: "shadow", handPickedModel: pin.model }
                    : { ...common, mode: "live" }));
                }
              } catch (error) {
                // An unavailable or banned session model is a refusal, not a router bug.
                if (error instanceof SessionModelError) throw error;
                deps.disable(error);
                pin = fallbackPin(deps.banLists(), constraints, "allowed");
              }
            }
            pins.set(sessionId, pin);
          }
          probeRung = `${pin.model}:${pin.effort}`;
          const slash = pin.model.indexOf("/");
          const rung = registry.find(pin.model.slice(0, slash), pin.model.slice(slash + 1));
          if (!rung) throw new Error(`pinned rung ${pin.model} is missing from the session model registry`);
          // The worker board shows the rung, which the relabelled replies below never name.
          publishServedRung({ delegationId: sessionId, model: pin.model, effort: pin.effort, ...(pin.escalation ? { escalation: pin.escalation } : {}) });
          // The rung sets the effort; a caller's thinking level never reaches it (ADR 0006).
          const { apiKey: _apiKey, headers: _headers, reasoning: _reasoning, ...rest } = options ?? {};
          const inward = { ...context, messages: context.messages.map((message) =>
            message.role === "assistant" && message.provider === model.provider && message.model === model.id
              ? { ...message, provider: rung.provider, model: rung.id, api: rung.api } : message) };
          const reasoning = streamReasoning(rung, pin.effort);
          const inner = registry.streamSimple(rung, inward, { ...rest, ...(reasoning === undefined ? {} : { reasoning }) });
          for await (const event of inner) {
            const label = <T extends { provider: string; model: string; api: string }>(message: T): T =>
              ({ ...message, provider: model.provider, model: model.id, api: model.api });
            push({ ...event, ...("partial" in event && event.partial ? { partial: label(event.partial) } : {}),
              ...("message" in event && event.message ? { message: label(event.message) } : {}),
              ...("error" in event && event.error ? { error: label(event.error) } : {}) } as Parameters<typeof push>[0]);
          }
        } catch (error) {
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
