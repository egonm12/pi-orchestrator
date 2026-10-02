import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubcommands, showOwner } from "../init/subcommands.ts";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { DEFAULT_WORKER_LIMIT, loadSubagentsSettings, WORKER_LIMIT_CEILING, type WorkerLimitSource } from "./settings.ts";

// The worker limit in force in the orchestrator's session: the owner's
// `orchestrator.subagents.workerLimit` (settings.ts: personal settings, a
// project's under `allowProjectOverrides`, or the default), or the limit the
// owner set for this session with `/pi-orchestrator workers <n>`. Like the
// gate level (./gate-level.ts), a session limit holds for the session it was
// set in until the next session_start: another session, this one after a
// reload or a resume, starts from the settings. A number above the ceiling is
// cut to it with a notice, as the settings cut it. The subagents tool asks
// here on every orchestrator call for the limit of the session's worker slots
// (./worker-slots.ts), and each limit set here re-registers the tool, so its
// schema's maxItems and description follow it.

/** The settings' worker limit and where it comes from. */
export interface SettingsWorkerLimit {
  readonly limit: number;
  readonly source: WorkerLimitSource;
}

/** A worker limit and where it comes from. */
export interface WorkerLimitInForce {
  readonly limit: number;
  readonly source: WorkerLimitSource | "session";
}

type SessionContext = Pick<ExtensionContext, "cwd"> & { readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId"> };

export const WORKERS_USAGE = `usage: /pi-orchestrator workers [1-${WORKER_LIMIT_CEILING}]`;

/** How the owner is told where the settings' limit comes from. */
function fromSettings({ limit, source }: SettingsWorkerLimit): { readonly shown: string; readonly aside: string } {
  if (source === "default") return { shown: "the default", aside: `default ${limit}` };
  return { shown: `from ${source} settings`, aside: `${source} settings ${limit}` };
}

/** The worker limit of the orchestrator's sessions in this extension. */
export class WorkerLimits {
  readonly #fromSettings: (cwd: string) => SettingsWorkerLimit;
  /** The limit the owner set, and the session it holds for. */
  #session: { readonly sessionId: string; readonly limit: number } | undefined;
  readonly #onSet: ((ctx: ExtensionContext, limit: number) => void)[] = [];

  constructor(fromSettings: (cwd: string) => SettingsWorkerLimit) {
    this.#fromSettings = fromSettings;
  }

  /** Calls `listener` with the session's context and the limit each time `/pi-orchestrator workers <n>` sets one. */
  onSet(listener: (ctx: ExtensionContext, limit: number) => void): void {
    this.#onSet.push(listener);
  }

  /** A session starts: the settings' limit is in force again. */
  reset(): void {
    this.#session = undefined;
  }

  /** The limit the owner set for `ctx`'s session, `undefined` when the settings' is in force. */
  session(ctx: SessionContext): number | undefined {
    const session = this.#session;
    return session !== undefined && session.sessionId === ctx.sessionManager.getSessionId() ? session.limit : undefined;
  }

  /** The limit in force in `ctx`'s session. */
  inForce(ctx: SessionContext): WorkerLimitInForce {
    const limit = this.session(ctx);
    return limit !== undefined ? { limit, source: "session" } : this.#fromSettings(ctx.cwd);
  }

  /** `/pi-orchestrator workers [n]`: `rest` sets the limit for `ctx`'s session,
   *  or is empty to show the limit in force. Returns what the owner is told. */
  command(rest: string, ctx: SessionContext): { readonly line: string; readonly type: "info" | "warning" } {
    if (rest === "") {
      const { limit } = this.inForce(ctx);
      const from = this.session(ctx) === undefined ? fromSettings(this.#fromSettings(ctx.cwd)).shown
        : `set for this session (${fromSettings(this.#fromSettings(ctx.cwd)).aside})`;
      return { line: `pi-orchestrator: worker limit ${limit}, ${from}.\n${WORKERS_USAGE}`, type: "info" };
    }
    if (!/^\d+$/.test(rest) || Number(rest) < 1) return { line: WORKERS_USAGE, type: "warning" };
    const asked = Number(rest);
    const limit = Math.min(asked, WORKER_LIMIT_CEILING);
    this.#session = { sessionId: ctx.sessionManager.getSessionId(), limit };
    const set = `worker limit ${limit} for this session (${fromSettings(this.#fromSettings(ctx.cwd)).aside}).`;
    if (asked > WORKER_LIMIT_CEILING) return { line: `pi-orchestrator: ${rest} is above the ceiling of ${WORKER_LIMIT_CEILING}; ${set}`, type: "warning" };
    return { line: `pi-orchestrator: ${set}`, type: "info" };
  }

  /** `/pi-orchestrator workers [n]` as the owner runs it: `command`, then each
   *  `onSet` listener hears a limit it set. */
  run(rest: string, ctx: ExtensionContext): { readonly line: string; readonly type: "info" | "warning" } {
    const before = this.#session;
    const shown = this.command(rest, ctx);
    const after = this.#session;
    if (after !== before && after !== undefined) for (const listener of this.#onSet) listener(ctx, after.limit);
    return shown;
  }
}

/** Adds `/pi-orchestrator workers` and returns the worker limits it sets. A
 *  settings failure shows the default and is logged once. */
export function registerWorkerLimit(pi: ExtensionAPI, logOnce: (line: string) => void): WorkerLimits {
  const limits = new WorkerLimits((cwd) => {
    try {
      const loaded = loadSubagentsSettings(personalAgentDir(), cwd);
      for (const warning of loaded.warnings) logOnce(warning);
      return { limit: loaded.settings.workerLimit, source: loaded.workerLimitSource };
    } catch (error) {
      logOnce(`worker limit: ${String(error).split(/\r?\n/, 1)[0]}; using ${DEFAULT_WORKER_LIMIT}`);
      return { limit: DEFAULT_WORKER_LIMIT, source: "default" };
    }
  });
  pi.on("session_start", () => { limits.reset(); });
  registerSubcommands(pi, [{
    name: "workers",
    summary: `\`workers <n>\` sets the worker limit (1 to ${WORKER_LIMIT_CEILING}) for this session; \`workers\` shows it and where it comes from`,
    run: (rest, ctx) => {
      const { line, type } = limits.run(rest, ctx);
      showOwner(ctx, line, type);
    },
  }]);
  return limits;
}
