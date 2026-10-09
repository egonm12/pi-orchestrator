import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkerSession } from "./worker-sessions.ts";

// Nested delegation (ADR 0016): a top-level routed worker may delegate one
// level deeper, in the foreground or background, with routed or forked items.
// Its workers name their parent delegation and never get subagents themselves.

/** The calling worker's delegation id, or `undefined` for the orchestrator. */
export function callingDelegation(ctx: Pick<ExtensionContext, "sessionManager">): string | undefined {
  return isWorkerSession(ctx) ? ctx.sessionManager.getSessionId() : undefined;
}
