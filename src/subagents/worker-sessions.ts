import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Which pi sessions in this process are the subagents tool's workers. A
// worker runs in the orchestrator's process and loads the same extensions, so
// a process-wide marker such as an environment variable would mark the
// orchestrator too. The router and the guard look up their own session's id
// here to leave the orchestrator's session behaviour out of a worker: the
// remembered session model, the session ban list and the fresh-install notice.
//
// pi loads each extension with a fresh module copy (jiti moduleCache: false),
// so the set is kept on the process's global object.

const WORKER_SESSION_IDS = Symbol.for("pi-orchestrator.subagents.worker-session-ids");
type ProcessGlobal = typeof globalThis & { [WORKER_SESSION_IDS]?: Set<string> };

function workerSessionIds(): Set<string> {
  return (globalThis as ProcessGlobal)[WORKER_SESSION_IDS] ??= new Set();
}

/** Marks `sessionId` as a worker's session until the returned function is called. */
export function markWorkerSession(sessionId: string): () => void {
  workerSessionIds().add(sessionId);
  return () => { workerSessionIds().delete(sessionId); };
}

/** Whether this process is currently running the delegation. */
export function isRunningWorkerSession(sessionId: string): boolean {
  return workerSessionIds().has(sessionId);
}

/** Whether `ctx` belongs to a session the subagents tool started as a worker. */
export function isWorkerSession(ctx: Partial<Pick<ExtensionContext, "sessionManager">> | undefined): boolean {
  const sessionId = ctx?.sessionManager?.getSessionId();
  return sessionId !== undefined && workerSessionIds().has(sessionId);
}
