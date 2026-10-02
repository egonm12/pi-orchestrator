import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { GATE_LEVELS, type GateLevel } from "../routing/decision-record.ts";
import { DEFAULT_GATE_LEVEL, DEFAULT_WORKER_LIMIT, subagentsSettingsFromSettings, WORKER_LIMIT_CEILING } from "../subagents/settings.ts";

// The gate level and worker limit steps of `/pi-orchestrator init`. The
// subagents extension reads both from `orchestrator.subagents`; init only
// writes them, so it shares the pure defaults from src/subagents/settings.ts
// and nothing that needs the subagents extension to be loaded. Escape at a
// select skips that step: the caller writes nothing for it.

export const PERSONAL_TARGET = "Personal settings (all projects)";
export const PROJECT_TARGET = "This project (.pi/settings.json)";
export const OTHER_LIMIT = "Other…";
export const CURRENT_MARK = " (current)";
/** Marks a project's own value while personal settings do not allow project overrides. */
export const IGNORED_MARK = " (project, ignored until overrides are allowed)";
export const WORKER_LIMIT_OPTIONS = [1, 2, 4, 6, 8, 12, 16, 32] as const;
export const OVERRIDES_TITLE = "Allow project settings to override your personal gate level and worker limit?";

/** What each gate level means, shown after it in the select. */
export const GATE_LEVEL_DESCRIPTIONS: Record<GateLevel, string> = {
  off: "no reviews or verdicts, saves tokens",
  low: "verdicts for elevated and critical work, a reviewer only for critical",
  medium: "spot checks for mechanical and standard work, a reviewer for elevated and critical",
  high: "a reviewer for standard work and up",
  max: "a reviewer for every edit, who reruns its checks",
};

export type SettingsTarget = "personal" | "project";

/** The pi UI calls these steps use. */
export interface WorkerSettingsUi {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function subagentsOf(settings: unknown): Record<string, unknown> {
  const orchestrator = isPlainObject(settings) ? settings.orchestrator : undefined;
  const subagents = isPlainObject(orchestrator) ? orchestrator.subagents : undefined;
  return isPlainObject(subagents) ? subagents : {};
}

export interface GateAndLimit {
  readonly gateLevel?: GateLevel;
  readonly workerLimit?: number;
}

/** The gate level and worker limit one settings file sets. The worker
 *  limit is resolved by the subagents loader itself, reading the file as
 *  personal settings, so its keys and deprecated aliases stay in one place;
 *  a limit above the ceiling counts as the ceiling. When the loader refuses
 *  the file's `orchestrator.subagents`, the limit counts as not set; an
 *  unknown gate level counts as not set too. */
export function gateAndLimitIn(settings: unknown): GateAndLimit {
  const gate = subagentsOf(settings).gateLevel;
  let workerLimit: number | undefined;
  try {
    const loaded = subagentsSettingsFromSettings(isPlainObject(settings) ? { orchestrator: { subagents: subagentsOf(settings) } } : {});
    if (loaded.workerLimitSource !== "default") workerLimit = loaded.settings.workerLimit;
  } catch {
    workerLimit = undefined;
  }
  return {
    ...(GATE_LEVELS.includes(gate as GateLevel) ? { gateLevel: gate as GateLevel } : {}),
    ...(workerLimit !== undefined ? { workerLimit } : {}),
  };
}

/** Whether a project file sets a gate level or a worker limit of its own. */
export function setsGateOrLimit(project: unknown): boolean {
  const own = gateAndLimitIn(project);
  return own.gateLevel !== undefined || own.workerLimit !== undefined;
}

/** `allowProjectOverrides` in personal settings, as the subagents loader reads it. */
export function projectOverridesAllowed(personal: unknown): boolean {
  return subagentsOf(personal).allowProjectOverrides === true;
}

export interface CurrentValues extends Required<GateAndLimit> {
  /** The mark after each current value: `IGNORED_MARK` for a project's own
   *  value while project overrides are off, else `CURRENT_MARK`. */
  readonly gateMark: string;
  readonly limitMark: string;
}

/** The values a target starts from: for a project its own value when set,
 *  else the personal one; then the default. A project's own value while
 *  personal settings do not allow overrides is marked as ignored. */
export function currentFor(target: SettingsTarget, personal: unknown, project: unknown): CurrentValues {
  const own = gateAndLimitIn(personal);
  const projectOwn = target === "project" ? gateAndLimitIn(project) : {};
  const ignored = !projectOverridesAllowed(personal);
  const mark = (fromProject: boolean) => (fromProject && ignored ? IGNORED_MARK : CURRENT_MARK);
  return {
    gateLevel: projectOwn.gateLevel ?? own.gateLevel ?? DEFAULT_GATE_LEVEL,
    workerLimit: projectOwn.workerLimit ?? own.workerLimit ?? DEFAULT_WORKER_LIMIT,
    gateMark: mark(projectOwn.gateLevel !== undefined),
    limitMark: mark(projectOwn.workerLimit !== undefined),
  };
}

/** Whether init offers this project's `.pi/settings.json`: `cwd` holds a
 *  `.git` or `.pi` folder, is not the home folder, and its settings file is
 *  not the personal one. */
export function isProjectDirectory(cwd: string | undefined, personalSettingsPath: string, home: string = homedir()): boolean {
  if (!cwd) return false;
  const dir = resolve(cwd);
  if (dir === resolve(home)) return false;
  if (resolve(projectSettingsPath(dir)) === resolve(personalSettingsPath)) return false;
  return existsSync(join(dir, ".git")) || existsSync(join(dir, ".pi"));
}

export function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
}

export async function askTarget(ui: WorkerSettingsUi): Promise<SettingsTarget | undefined> {
  const choice = await ui.select("Write the gate level and worker limit to", [PERSONAL_TARGET, PROJECT_TARGET]);
  if (choice === PERSONAL_TARGET) return "personal";
  if (choice === PROJECT_TARGET) return "project";
  return undefined;
}

/** The current level first, marked, so Enter keeps it; then the others in order. */
export function gateLevelOptions(current: GateLevel, mark: string = CURRENT_MARK): string[] {
  const order = [current, ...GATE_LEVELS.filter((level) => level !== current)];
  return order.map((level) => `${level}${level === current ? mark : ""}: ${GATE_LEVEL_DESCRIPTIONS[level]}`);
}

export async function askGateLevel(ui: WorkerSettingsUi, current: GateLevel, mark: string = CURRENT_MARK): Promise<GateLevel | undefined> {
  const choice = await ui.select("Gate level: how strictly editing work is checked", gateLevelOptions(current, mark));
  if (choice === undefined) return undefined;
  const level = choice.slice(0, choice.search(/[ :]/));
  return GATE_LEVELS.includes(level as GateLevel) ? (level as GateLevel) : undefined;
}

/** The current limit first, marked, then the usual limits, then `Other…`. */
export function workerLimitOptions(current: number, mark: string = CURRENT_MARK): string[] {
  const order = [current, ...WORKER_LIMIT_OPTIONS.filter((limit) => limit !== current)];
  return [...order.map((limit) => `${limit}${limit === current ? mark : ""}`), OTHER_LIMIT];
}

/** The worker limit picked, or `undefined` for Escape. `Other…` asks for a
 *  whole number from 1 to the ceiling and asks again after anything else;
 *  Escape there keeps the current limit, which also writes nothing. */
export async function askWorkerLimit(ui: WorkerSettingsUi, current: number, mark: string = CURRENT_MARK): Promise<number | undefined> {
  const choice = await ui.select("Worker limit: workers running at once, foreground and background; the rest queue", workerLimitOptions(current, mark));
  if (choice === undefined) return undefined;
  if (choice !== OTHER_LIMIT) return Number.parseInt(choice, 10);
  let title = `Worker limit, a whole number from 1 to ${WORKER_LIMIT_CEILING}`;
  for (;;) {
    const typed = await ui.input(title, String(current));
    if (typed === undefined) return undefined;
    const text = typed.trim();
    if (text === "") return current;
    const limit = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (Number.isInteger(limit) && limit >= 1 && limit <= WORKER_LIMIT_CEILING) return limit;
    title = `${JSON.stringify(text)} is not a whole number from 1 to ${WORKER_LIMIT_CEILING}; worker limit`;
  }
}

/** `settings` with `keys` merged into `orchestrator.subagents`; every other
 *  key, there and elsewhere in the file, stays. */
export function withSubagentKeys(settings: Record<string, unknown>, keys: Record<string, unknown>): Record<string, unknown> {
  const orchestrator = isPlainObject(settings.orchestrator) ? settings.orchestrator : {};
  return { ...settings, orchestrator: { ...orchestrator, subagents: { ...subagentsOf(settings), ...keys } } };
}
