import { writeFileSync } from "node:fs";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { workerSessionDir } from "./worker.ts";

/** Snapshot the active path, not the whole append-only session tree. The
 * assistant entry containing this call is excluded even if it also has text. */
export function forkSession(ctx: ExtensionContext, toolCallId: string): { sessionManager: SessionManager; forkPoint: string | null } {
  const branch = ctx.sessionManager.getBranch();
  let callIndex = -1;
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index]!;
    if (entry.type === "message" && entry.message.role === "assistant" &&
      entry.message.content.some((part) => part.type === "toolCall" && part.id === toolCallId)) {
      callIndex = index;
      break;
    }
  }
  if (callIndex < 0) throw new Error(`delegating tool call ${toolCallId} is not on the current session branch`);
  const path = branch.slice(0, callIndex);
  const forkPoint = path.at(-1)?.id ?? null;
  const parentSession = ctx.sessionManager.getSessionFile();
  if (parentSession === undefined) {
    const header = SessionManager.inMemory(ctx.cwd, { parentSession }).getHeader()!;
    return { sessionManager: SessionManager.inMemory(ctx.cwd, { id: header.id }, [header, ...path]), forkPoint };
  }
  const sessionManager = SessionManager.create(ctx.cwd, workerSessionDir(ctx.sessionManager), { parentSession });
  const file = sessionManager.getSessionFile()!;
  writeFileSync(file, `${[sessionManager.getHeader(), ...path].map((entry) => JSON.stringify(entry)).join("\n")}\n`, { flag: "wx" });
  return { sessionManager: SessionManager.open(file), forkPoint };
}
