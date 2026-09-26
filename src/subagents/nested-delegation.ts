import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isWorkerSession } from "./worker-sessions.ts";

// Nested delegation (ADR 0008): a worker gets the subagents tool only when its
// agent definition lists `subagents` in `tools:`, and only when the
// orchestrator started it. Its calls start workers one level deeper, which
// never get the tool, always run on the auto model and name it as their
// parent delegation.

/** The delegation a subagents call is made from: the calling worker's
 *  delegation id, or `undefined` when the orchestrator calls. Throws when a
 *  worker's call asks for what only the orchestrator's may: a background call
 *  or a fork item. */
export function callingDelegation(ctx: Pick<ExtensionContext, "sessionManager">,
  params: { readonly background?: unknown; readonly items?: unknown }): string | undefined {
  if (!isWorkerSession(ctx)) return undefined;
  if (params.background === true) throw new Error("a worker's subagents calls run in the foreground only; background calls are the orchestrator's");
  if (Array.isArray(params.items) && params.items.some((item) => (item as { fork?: unknown } | null)?.fork === true)) {
    throw new Error("a worker's subagents calls cannot fork; its workers are always routed");
  }
  return ctx.sessionManager.getSessionId();
}
