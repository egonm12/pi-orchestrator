import type { RoutingMode } from "../routing/decision-record.ts";
import type { FailedDecision, LadderDecision } from "../routing/effort-ladder.ts";
import type { ResolvedTierMap } from "../routing/tier-map.ts";
import { climbEffortLadder, type ActiveRouter } from "./route-task.ts";

// The orchestrator session's router, for the subagents extension: a retry on
// the effort ladder (ADR 0010) climbs through the tier map, hard-filter
// evidence and installed models the router extension loaded for that session.
// The two extensions get separate module copies (jiti moduleCache: false), so
// the router is kept on the process's global object, by session id. A
// worker's own router extension publishes nothing: only the orchestrator's
// session starts retries.
//
// What is published is not the router itself but what a retry needs of it,
// with the climb bound to the publisher's module copy. The router's task
// allowance owner is genuine only to the copy that minted it
// (../budget/task-allowance.ts), so the subagents extension must never pass
// it to its own copy of ./route-task.ts: it calls `climbEffortLadder` here.

/** The orchestrator session's router, as the subagents extension may use it. */
export interface OrchestratorRouter {
  readonly mode: RoutingMode;
  readonly tierMap: ResolvedTierMap;
  /** The effort ladder's next rung after `failed`, climbed in the router extension's module copy (./route-task.ts). */
  climbEffortLadder(failed: FailedDecision, taskText: string, at: Date): LadderDecision;
}

const ORCHESTRATOR_ROUTERS = Symbol.for("pi-orchestrator.router.orchestrator-routers");
type ProcessGlobal = typeof globalThis & { [ORCHESTRATOR_ROUTERS]?: Map<string, OrchestratorRouter> };
const routers = (): Map<string, OrchestratorRouter> => (globalThis as ProcessGlobal)[ORCHESTRATOR_ROUTERS] ??= new Map();

/** Sets the router of the orchestrator session `sessionId`; `undefined` says
 *  routing is off there, not enabled or switched off by an error. */
export function publishOrchestratorRouter(sessionId: string, router: ActiveRouter | undefined): void {
  if (router === undefined) {
    routers().delete(sessionId);
    return;
  }
  routers().set(sessionId, {
    mode: router.mode, tierMap: router.tierMap,
    climbEffortLadder: (failed, taskText, at) => climbEffortLadder(router, failed, taskText, at),
  });
}

/** The router of the orchestrator session `sessionId`; `undefined` when routing is off there. */
export function orchestratorRouter(sessionId: string): OrchestratorRouter | undefined {
  return routers().get(sessionId);
}
