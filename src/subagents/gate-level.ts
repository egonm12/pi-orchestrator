import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerSubcommands, showOwner } from "../init/subcommands.ts";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { GATE_LEVELS, isGateLevel, type GateLevel } from "./quality-gate.ts";
import { DEFAULT_GATE_LEVEL, loadSubagentsSettings } from "./settings.ts";

// The gate level in force in the orchestrator's session (ADR 0011): the
// owner's `orchestrator.subagents.gateLevel`, which a project may override
// under `allowProjectOverrides`, or the level the owner set for this session
// with `/pi-orchestrator gate <level>`. The owner may set any level there,
// lower ones too; only the orchestrator is held to raising, and it raises for
// one delegation in its verdict call (./verdict.ts), never here. The setting
// is read each time the level is asked for, as the subagents tool reads its
// settings on every call. A session level holds for the session it was set
// in until the next session_start: another session, this one after a reload
// or a resume, starts from the settings.
//
// Everything that asks which gate action a delegation has (./quality-gate.ts)
// asks here for the level: the commit gate, subagents_verdict, an editing
// delegation's Result, a reviewer's rules and the orchestrator protocol.

/** A gate level and where it comes from. */
export interface GateLevelInForce {
  readonly level: GateLevel;
  readonly source: "settings" | "session";
}

type SessionContext = Pick<ExtensionContext, "cwd"> & { readonly sessionManager: Pick<ExtensionContext["sessionManager"], "getSessionId"> };

export const GATE_USAGE = `usage: /pi-orchestrator gate [${GATE_LEVELS.join("|")}]`;

/** The gate level of the orchestrator's sessions in this extension. */
export class GateLevels {
  readonly #fromSettings: (cwd: string) => GateLevel;
  /** The level the owner set, and the session it holds for. */
  #session: { readonly sessionId: string; readonly level: GateLevel } | undefined;

  constructor(fromSettings: (cwd: string) => GateLevel) {
    this.#fromSettings = fromSettings;
  }

  /** A session starts: the settings' level is in force again. */
  reset(): void {
    this.#session = undefined;
  }

  /** The level in force in `ctx`'s session. */
  inForce(ctx: SessionContext): GateLevelInForce {
    const session = this.#session;
    if (session !== undefined && session.sessionId === ctx.sessionManager.getSessionId()) return { level: session.level, source: "session" };
    return { level: this.#fromSettings(ctx.cwd), source: "settings" };
  }

  /** `/pi-orchestrator gate [level]`: `rest` sets the level for `ctx`'s session,
   *  or is empty to show the level in force. Returns what the owner is told. */
  command(rest: string, ctx: SessionContext): { readonly line: string; readonly type: "info" | "warning" } {
    if (rest === "") {
      const { level, source } = this.inForce(ctx);
      const from = source === "settings" ? "from settings" : `set for this session (settings say ${this.#fromSettings(ctx.cwd)})`;
      return { line: `pi-orchestrator: gate level ${level}, ${from}.\n${GATE_USAGE}`, type: "info" };
    }
    if (!isGateLevel(rest)) return { line: GATE_USAGE, type: "warning" };
    this.#session = { sessionId: ctx.sessionManager.getSessionId(), level: rest };
    return { line: `pi-orchestrator: gate level ${rest} for this session (settings say ${this.#fromSettings(ctx.cwd)}).`, type: "info" };
  }
}

/** Adds `/pi-orchestrator gate` and returns the gate levels it sets. A
 *  settings failure keeps the default and is logged once. */
export function registerGateLevel(pi: ExtensionAPI, logOnce: (line: string) => void): GateLevels {
  const levels = new GateLevels((cwd) => {
    try {
      const loaded = loadSubagentsSettings(personalAgentDir(), cwd);
      for (const key of loaded.ignoredProjectKeys) logOnce(`ignored project settings key ${key}`);
      return loaded.settings.gateLevel;
    } catch (error) {
      logOnce(`gate level: ${String(error).split(/\r?\n/, 1)[0]}; using ${DEFAULT_GATE_LEVEL}`);
      return DEFAULT_GATE_LEVEL;
    }
  });
  pi.on("session_start", () => { levels.reset(); });
  registerSubcommands(pi, [{
    name: "gate",
    summary: "`gate <level>` sets the gate level (low, medium, high or max) for this session; `gate` shows it",
    run: (rest, ctx) => {
      const { line, type } = levels.command(rest, ctx);
      showOwner(ctx, line, type);
    },
  }]);
  return levels;
}
