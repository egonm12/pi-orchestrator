import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { installGuardEntry } from "./extension-entry.ts";

// A throwaway agent directory with the personal guard installed, used so guard
// tests never read from, write to, or depend on the real `~/.pi/agent`.
//
// Credentials are copied only when a test asks for a live model route, only
// into this temporary directory, and never into the repository.

export interface GuardedAgentDir {
  readonly dir: string;
  /** The `HOME` a child process should see, so `$HOME/.pi/agent` names `dir`
   *  and no experiment can reach the real agent directory by that spelling. */
  readonly home: string;
  /** Environment for a `pi` subprocess bound to this agent directory. */
  env(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
  cleanup(): void;
}

export interface GuardedAgentDirOptions {
  /** Copy `auth.json` from the real agent directory so a live route works. */
  readonly withCredentials?: boolean;
  readonly installGuard?: boolean;
}

/** Always placed at `<temp home>/.pi/agent`, so a test can redirect `HOME` and
 *  reproduce the `$HOME/.pi/agent/...` spellings without the real one being
 *  reachable under that name. */
const AGENT_DIR_UNDER_HOME = join(".pi", "agent");

export function realAgentDirPath(): string {
  return join(homedir(), ".pi", "agent");
}

/** Whether the real agent directory can supply a live route's credentials. */
export function credentialsAvailable(): boolean {
  return existsSync(join(realAgentDirPath(), "auth.json"));
}

/**
 * The installed package that serves this machine's Anthropic subscription
 * route, loaded with `-e` from where it already is.
 *
 * Measured: `auth.json` alone is not enough. Without this package the same
 * credentials reach Anthropic on the metered path and the request comes back
 * "You're out of extra usage", on the real agent directory too (`pi -ne`).
 * Referencing the installed path keeps the live route working without copying
 * a 213 MB package tree and without writing anything to the real agent
 * directory.
 */
export function liveAuthExtensionPath(): string | undefined {
  const path = join(realAgentDirPath(), "npm", "node_modules", "@gotgenes", "pi-anthropic-auth");
  return existsSync(path) ? path : undefined;
}

export function createGuardedAgentDir(options: GuardedAgentDirOptions = {}): GuardedAgentDir {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-agentdir-"));
  const dir = join(home, AGENT_DIR_UNDER_HOME);
  mkdirSync(join(dir, "extensions"), { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    `${JSON.stringify({ defaultProjectTrust: "ask", quietStartup: true, enableInstallTelemetry: false }, null, 2)}\n`,
  );
  const real = realAgentDirPath();
  // The model catalogue, not a credential: without it an offline probe has no
  // model list at all and pi exits before the guard's decision is observable.
  if (existsSync(join(real, "models-store.json"))) {
    copyFileSync(join(real, "models-store.json"), join(dir, "models-store.json"));
  }
  if (options.withCredentials && existsSync(join(real, "auth.json"))) {
    copyFileSync(join(real, "auth.json"), join(dir, "auth.json"));
  }
  if (options.installGuard !== false) installGuardEntry(dir);
  return {
    dir,
    home,
    env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
      const env: NodeJS.ProcessEnv = { ...process.env, ...extra, HOME: home, PI_CODING_AGENT_DIR: dir };
      // A pi started from inside a pi-subagents child registers no tools at
      // all; the suite's own launches must not inherit that marker.
      delete env.PI_SUBAGENT_CHILD;
      delete env.PI_SUBAGENT_PARENT_SESSION;
      delete env.PI_SUBAGENTS_HERDR_BRIDGE;
      return env;
    },
    cleanup(): void {
      rmSync(home, { recursive: true, force: true });
    },
  };
}
