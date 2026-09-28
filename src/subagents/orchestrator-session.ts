import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkerSession } from "./worker-sessions.ts";

// Whether a session is the orchestrator's own: not a worker, not a forked
// worker, not a pi-subagents child. What binds only the orchestrator's session
// asks here: the session ban list (ADR 0002), the remembered session model,
// the fresh-install notice and the orchestrator protocol.
//
// Two kinds of delegated session load these extensions too:
// - the subagents tool's workers, forked ones included, which run in the
//   orchestrator's process and are marked per session (worker-sessions.ts);
// - pi-subagents children, whole processes pi-subagents marks: its async runner
//   with PI_SUBAGENT_CHILD=1, a herdr pane-native child with
//   PI_SUBAGENTS_HERDR_BRIDGE=1. Every session in such a process is delegated.

const CHILD_PROCESS_MARKERS = ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"] as const;

/** Whether `ctx` is the orchestrator's own session. `env` is the process
 *  environment, read on each call. */
export function isOrchestratorSession(ctx: Partial<Pick<ExtensionContext, "sessionManager">> | undefined,
  env: NodeJS.ProcessEnv = process.env): boolean {
  if (CHILD_PROCESS_MARKERS.some((marker) => env[marker] === "1")) return false;
  return !isWorkerSession(ctx);
}
