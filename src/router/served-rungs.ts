import type { RiskTier } from "../routing/classifier.ts";

// The rung that serves each request of a worker on the auto model, for the
// worker board (src/subagents/worker-board.ts). Replies are labelled
// `orchestrator/auto` (ADR 0006), so a worker's own events never name the
// rung; the auto provider publishes it here instead. Every worker runs in the
// orchestrator's process (ADR 0007), so one process-wide registry reaches the
// board. pi loads each extension with a fresh module copy (jiti moduleCache:
// false), so the listeners are kept on the process's global object.

const LISTENERS = Symbol.for("pi-orchestrator.router.served-rung-listeners");

/** The routing decision moved the task up from its classified tier because
 *  the hard filters emptied it (CONTEXT.md, Escalation). */
export interface RungEscalation {
  readonly from: RiskTier;
  readonly to: RiskTier;
}

/** One request of a worker and the rung that serves it. */
export interface ServedRung {
  /** The request's session id: the worker's delegation id, or a compaction
   *  summary's own session id. */
  readonly delegationId: string;
  /** `provider/model`. */
  readonly model: string;
  readonly effort: string;
  /** Present when the rung came from an escalated routing decision. */
  readonly escalation?: RungEscalation;
}

type Listener = (rung: ServedRung) => void;
type ProcessGlobal = typeof globalThis & { [LISTENERS]?: Set<Listener> };

function listeners(): Set<Listener> {
  return (globalThis as ProcessGlobal)[LISTENERS] ??= new Set();
}

/** Tells every listener which rung serves a request. A listener's failure
 *  never reaches the request. */
export function publishServedRung(rung: ServedRung): void {
  for (const listener of listeners()) {
    try { listener(rung); } catch { /* An observer must not fail a worker's request. */ }
  }
}

/** Calls `listener` with every served rung until the returned function is called. */
export function watchServedRungs(listener: Listener): () => void {
  listeners().add(listener);
  return () => { listeners().delete(listener); };
}
