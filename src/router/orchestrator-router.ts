import type { ActiveRouter } from "./route-task.ts";

// The orchestrator session's router, for the subagents extension: a retry on
// the effort ladder (ADR 0010) climbs through the tier map, hard-filter
// evidence and installed models the router extension loaded for that session.
// The two extensions get separate module copies (jiti moduleCache: false), so
// the router is kept on the process's global object, by session id. A
// worker's own router extension publishes nothing: only the orchestrator's
// session starts retries.

const ORCHESTRATOR_ROUTERS = Symbol.for("pi-orchestrator.router.orchestrator-routers");
type ProcessGlobal = typeof globalThis & { [ORCHESTRATOR_ROUTERS]?: Map<string, ActiveRouter> };
const routers = (): Map<string, ActiveRouter> => (globalThis as ProcessGlobal)[ORCHESTRATOR_ROUTERS] ??= new Map();

/** Sets the router of the orchestrator session `sessionId`; `undefined` says
 *  routing is off there, not enabled or switched off by an error. */
export function publishOrchestratorRouter(sessionId: string, router: ActiveRouter | undefined): void {
  if (router === undefined) routers().delete(sessionId);
  else routers().set(sessionId, router);
}

/** The router of the orchestrator session `sessionId`; `undefined` when routing is off there. */
export function orchestratorRouter(sessionId: string): ActiveRouter | undefined {
  return routers().get(sessionId);
}
