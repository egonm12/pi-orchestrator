import type { ExtensionAPI, ExtensionContext, ModelInfo } from "../types/pi-extension.ts";
import { activeBanLists, configureBanLists, loadBanListsOrDefaults, personalAgentDir, sessionBanListRefusal } from "../policy/ban-lists.ts";
import { toolRefusal } from "./boundaries.ts";

export const GUARD_PREFIX = "pi-orchestration-harness guard:";

export default function personalGuard(pi: ExtensionAPI) {
  let disabled = false;
  const disable = (error: unknown) => {
    if (disabled) return;
    disabled = true;
    process.stderr.write(`harness guard disabled: ${String(error).split(/\r?\n/, 1)[0]}\n`);
    if (process.env.PI_HARNESS_GUARD_DEBUG === "1") process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  };
  try {
    const agentDir = personalAgentDir();

    const logged = new Set<string>();
    const logOnce = (line: string) => {
      if (logged.has(line)) return;
      logged.add(line);
      process.stderr.write(`${GUARD_PREFIX} ${line}\n`);
    };
    // Ticket 21: the ban lists come from personal settings. A settings failure
    // never widens and never disables the guard: the loader keeps the defaults
    // (or the personal lists, for a bad project file) and the failure is logged.
    const applyBanLists = (projectCwd?: string) => {
      const loaded = loadBanListsOrDefaults({ agentDir, projectCwd });
      configureBanLists(loaded.banLists);
      for (const error of loaded.errors) logOnce(`ban lists: ${error.split(/\r?\n/, 1)[0]}`);
      for (const key of loaded.ignoredProjectKeys) logOnce(`ignored project settings key ${key}`);
    };
    // Personal lists at load; the project file once a session names its cwd.
    applyBanLists();

    // pi cannot cancel a model selection (`model_select` has no result), so a
    // session-banned session model blocks every turn until another is selected.
    //
    // The session ban list binds only the orchestrator's own session (ADR 0002).
    // pi-subagents loads ambient extensions, this guard included, into the
    // delegated sessions it hosts, and marks those processes: the async runner
    // with PI_SUBAGENT_CHILD=1, a herdr pane-native child with
    // PI_SUBAGENTS_HERDR_BRIDGE=1. There the session check is skipped.
    const hostsDelegatedSessions = process.env.PI_SUBAGENT_CHILD === "1" || process.env.PI_SUBAGENTS_HERDR_BRIDGE === "1";
    let sessionRefusal: string | undefined;
    const report = (message: string, ctx: ExtensionContext) => {
      if (ctx.hasUI && ctx.ui) ctx.ui.notify(`${GUARD_PREFIX} ${message}`, "error");
      else process.stderr.write(`${GUARD_PREFIX} ${message}\n`);
    };
    const refusalFor = (model: ModelInfo | undefined) => {
      if (hostsDelegatedSessions || !model) return undefined;
      const refusal = sessionBanListRefusal(`${model.provider}/${model.id}`);
      return refusal && `${refusal.message}; no turn runs until another model is selected.`;
    };
    const checkSessionModel = (model: ModelInfo | undefined, ctx: ExtensionContext) => {
      sessionRefusal = refusalFor(model);
      if (sessionRefusal) report(sessionRefusal, ctx);
    };
    // The live session model when pi supplies it, else the last selection seen.
    const currentRefusal = (ctx: ExtensionContext) => ctx.model ? refusalFor(ctx.model) : sessionRefusal;

    pi.on("tool_call", (event, ctx) => {
      if (disabled) return;
      try {
        const reason = toolRefusal(event.toolName, event.input, { agentDir, cwd: ctx.cwd });
        if (reason) return { block: true, reason: `${GUARD_PREFIX} ${reason}` };
      } catch (error) { disable(error); }
    });
    pi.on("session_start", (_event, ctx) => {
      if (disabled) return;
      try {
        applyBanLists(ctx.cwd);
        if (process.env.PI_HARNESS_GUARD_PROBE === "1") {
          const { subagentBanList, sessionBanList } = activeBanLists();
          const list = (entries: readonly string[]) => entries.join(", ") || "(none)";
          process.stderr.write(`${GUARD_PREFIX} subagent ban list: ${list(subagentBanList)}; session ban list: ${list(sessionBanList)}\n`);
        }
        checkSessionModel(ctx.model, ctx);
      } catch (error) { disable(error); }
    });
    pi.on("model_select", (event, ctx) => {
      if (disabled) return;
      try { checkSessionModel(event.model, ctx); } catch (error) { disable(error); }
    });
    // Print mode already has the line from the selection; a TUI user needs to
    // see why nothing happened.
    const reportBlocked = (refusal: string, ctx: ExtensionContext) => {
      if (ctx.hasUI || refusal !== sessionRefusal) report(refusal, ctx);
    };
    pi.on("input", (_event, ctx) => {
      if (disabled) return;
      try {
        const refusal = currentRefusal(ctx);
        if (!refusal) return;
        reportBlocked(refusal, ctx);
        return { action: "handled" };
      } catch (error) { disable(error); }
    });
    // A turn can start without `input` (an extension's sendMessage with
    // triggerTurn). `turn_start` is awaited before each provider request, so
    // aborting here stops the turn before the model is called.
    pi.on("turn_start", (_event, ctx) => {
      if (disabled) return;
      try {
        const refusal = currentRefusal(ctx);
        if (!refusal) return;
        reportBlocked(refusal, ctx);
        ctx.abort?.();
      } catch (error) { disable(error); }
    });
    if (process.env.PI_HARNESS_GUARD_PROBE === "1") process.stderr.write(`${GUARD_PREFIX} loaded\n`);
  } catch (error) { disable(error); }
}
