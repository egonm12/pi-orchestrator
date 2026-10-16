import type { EffortJudgeDecision, EffortJudgeKind } from "./effort-judge.ts";
import type { EffortBand } from "./effort-rubric.ts";

/** An observation of a judged incoming message. Subscribers must not affect routing. */
export type EffortDecisionEvent = EffortJudgeDecision & {
  readonly timestamp: string;
  readonly band: EffortBand;
  readonly sessionId: string;
  readonly kind: EffortJudgeKind;
  readonly scope: "worker" | "orchestrator";
};

const KEY = Symbol.for("pi-orchestrator.effort-decisions.listeners");
type Shared = typeof globalThis & { [KEY]?: Set<(event: EffortDecisionEvent) => void> };

/** Subscribe to decisions across extension module copies. Returns an unsubscribe function. */
export function onEffortDecision(listener: (event: EffortDecisionEvent) => void): () => void {
  const listeners = (globalThis as Shared)[KEY] ??= new Set();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitEffortDecision(event: EffortDecisionEvent): void {
  for (const listener of (globalThis as Shared)[KEY] ?? []) {
    try { listener(event); } catch { /* Observation cannot alter a route. */ }
  }
}

/** The handling judge's verdict for one orchestrator user prompt (ADR 0020).
 *  `forced` is an owner override, `fallback` a failed judgement. */
export interface HandlingDecisionEvent {
  readonly sessionId: string;
  readonly timestamp: string;
  readonly handling: "self" | "delegate";
  readonly source: "judged" | "fallback" | "forced";
  readonly reason: string;
  readonly judgeModel: string;
}

const HANDLING_KEY = Symbol.for("pi-orchestrator.handling-decisions.listeners");
type SharedHandling = typeof globalThis & { [HANDLING_KEY]?: Set<(event: HandlingDecisionEvent) => void> };

/** Subscribe to handling verdicts across extension module copies. Returns an unsubscribe function. */
export function onHandlingDecision(listener: (event: HandlingDecisionEvent) => void): () => void {
  const listeners = (globalThis as SharedHandling)[HANDLING_KEY] ??= new Set();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function emitHandlingDecision(event: HandlingDecisionEvent): void {
  for (const listener of (globalThis as SharedHandling)[HANDLING_KEY] ?? []) {
    try { listener(event); } catch { /* Observation cannot alter a route. */ }
  }
}
