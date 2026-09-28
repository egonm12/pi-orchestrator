import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// Which pi sessions in this process are the subagents tool's workers. A
// worker runs in the orchestrator's process and loads the same extensions, so
// a process-wide marker such as an environment variable would mark the
// orchestrator too. The orchestrator-session check (orchestrator-session.ts)
// looks up a session's id here to leave the orchestrator's session behaviour
// out of a worker: the remembered session model, the session ban list and the
// fresh-install notice.
// A worker started by another worker (ADR 0008) is kept with its parent
// delegation, and a reviewer (ADR 0010) with the delegation it reviews; the
// router extension writes both into the worker's decision record.
//
// pi loads each extension with a fresh module copy (jiti moduleCache: false),
// so the map is kept on the process's global object.

const WORKER_SESSIONS = Symbol.for("pi-orchestrator.subagents.worker-sessions");

/** A worker's session: `parentDelegationId` is set when a worker, not the
 *  orchestrator, started it, and `reviewedDelegationId` when it is a reviewer. */
interface WorkerSession {
  readonly parentDelegationId?: string;
  readonly reviewedDelegationId?: string;
}

type ProcessGlobal = typeof globalThis & { [WORKER_SESSIONS]?: Map<string, WorkerSession> };

function workerSessions(): Map<string, WorkerSession> {
  return (globalThis as ProcessGlobal)[WORKER_SESSIONS] ??= new Map();
}

/** Marks `sessionId` as a worker's session until the returned function is
 *  called. `parentDelegationId` names the worker that started it, if any, and
 *  `reviewedDelegationId` the delegation it reviews, if it is a reviewer. */
export function markWorkerSession(sessionId: string, parentDelegationId?: string, reviewedDelegationId?: string): () => void {
  workerSessions().set(sessionId, { ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
    ...(reviewedDelegationId === undefined ? {} : { reviewedDelegationId }) });
  return () => { workerSessions().delete(sessionId); };
}

/** Whether this process is currently running the delegation. */
export function isRunningWorkerSession(sessionId: string): boolean {
  return workerSessions().has(sessionId);
}

/** Whether `ctx` belongs to a session the subagents tool started as a worker. */
export function isWorkerSession(ctx: Partial<Pick<ExtensionContext, "sessionManager">> | undefined): boolean {
  const sessionId = ctx?.sessionManager?.getSessionId();
  return sessionId !== undefined && workerSessions().has(sessionId);
}

/** The delegation id of the worker that started the worker `sessionId`;
 *  `undefined` for the orchestrator's workers and for any other session. */
export function parentDelegationOf(sessionId: string): string | undefined {
  return workerSessions().get(sessionId)?.parentDelegationId;
}

/** The delegation the reviewer `sessionId` reviews; `undefined` for any other session. */
export function reviewedDelegationOf(sessionId: string): string | undefined {
  return workerSessions().get(sessionId)?.reviewedDelegationId;
}
