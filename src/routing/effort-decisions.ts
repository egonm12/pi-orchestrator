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
