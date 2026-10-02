import { join } from "node:path";
import { personalOrchestrator, readSettingsFile } from "../policy/ban-lists.ts";
import { GATE_LEVELS, type GateLevel } from "../routing/decision-record.ts";

// The subagents extension's settings (ADR 0007), under `orchestrator.subagents`
// in personal settings. `allowProjectOverrides` is read from personal settings
// only, default false. When it is on, a key in the project's
// `.pi/settings.json` replaces the personal value whole; a project value for
// the flag itself is ignored. When it is off, every project key is ignored.
// Each ignored key is named in `ignoredProjectKeys`, for the extension to log.

type AgentDefinitionModelUse = "route" | "preserve";

export interface SubagentsSettings {
  /** The worker limit: at most this many workers run at once across the
   *  orchestrator's session, foreground and background; the rest queue. */
  readonly workerLimit: number;
  readonly agentDefinitionModel: {
    readonly use: AgentDefinitionModelUse;
    /** Under "preserve", a definition-named model may be on the subagent ban list (ADR 0002 follow-up). */
    readonly allowBanned: boolean;
  };
  /** Exploratory calls the orchestrator makes per user prompt before each further one carries the exploration nudge (ADR 0013). */
  readonly explorationNudge: number;
  /** How strictly the quality gate treats each tier (ADR 0011); the owner's floor. */
  readonly gateLevel: GateLevel;
}

export interface LoadedSubagentsSettings {
  /** The personal settings, with the project's keys when allowed. */
  readonly settings: SubagentsSettings;
  /** Personal settings only. */
  readonly allowProjectOverrides: boolean;
  /** Dotted keys the project's `orchestrator.subagents` carried and the
   *  loader ignored, e.g. `orchestrator.subagents.workerLimit`. */
  readonly ignoredProjectKeys: readonly string[];
  /** Warnings about values the loader changed, for the extension to log once. */
  readonly warnings: readonly string[];
  /** Where `settings.workerLimit` comes from: a project allowed to override, personal settings, or neither. */
  readonly workerLimitSource: WorkerLimitSource;
}

/** The settings a worker limit comes from. */
export type WorkerLimitSource = "project" | "personal" | "default";

const SUBAGENTS_KEY = "orchestrator.subagents";
/** `explorationNudge` when the owner sets none. */
export const DEFAULT_EXPLORATION_NUDGE = 3;
/** `gateLevel` when the owner sets none (ADR 0011). */
export const DEFAULT_GATE_LEVEL: GateLevel = "medium";
const FLAG = "allowProjectOverrides";
/** `workerLimit` when the owner sets none. */
export const DEFAULT_WORKER_LIMIT = 4;
/** The highest worker limit; a higher value is cut to it with a warning. */
export const WORKER_LIMIT_CEILING = 32;
/** The worker limit's key, then its deprecated aliases in the order they are read. */
const WORKER_LIMIT_KEYS = ["workerLimit", "maxParallel", "maxBackgroundWorkers"] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The project's `orchestrator.subagents` value, `undefined` when absent. */
function projectSubagents(project: unknown): unknown {
  if (project === undefined) return undefined;
  if (!isPlainObject(project)) throw new Error("project settings must be a JSON object");
  const orchestrator = project.orchestrator;
  if (orchestrator === undefined) return undefined;
  if (!isPlainObject(orchestrator)) throw new Error("project settings key 'orchestrator' must be an object");
  return orchestrator.subagents;
}

/** Pure: the effective settings from parsed personal and (optional) project settings. */
export function subagentsSettingsFromSettings(personal: unknown, project?: unknown): LoadedSubagentsSettings {
  const personalOptions = personalOrchestrator(personal)?.subagents;
  if (personalOptions !== undefined && !isPlainObject(personalOptions)) throw new Error(`${SUBAGENTS_KEY} must be an object`);
  const allowProjectOverrides = personalOptions?.[FLAG] === true;
  const projectOptions = projectSubagents(project);
  const ignoredProjectKeys: string[] = [];
  const options: Record<string, unknown> = { ...personalOptions };
  // The worker limit is read from one source as a whole: a project allowed to override that sets any of its keys,
  // else personal settings, so a project's deprecated key still beats a personal `workerLimit`.
  let limitOptions: Record<string, unknown> = options;
  if (projectOptions !== undefined) {
    if (!allowProjectOverrides) {
      if (isPlainObject(projectOptions)) ignoredProjectKeys.push(...Object.keys(projectOptions).map((key) => `${SUBAGENTS_KEY}.${key}`));
      else ignoredProjectKeys.push(SUBAGENTS_KEY);
    } else {
      if (!isPlainObject(projectOptions)) throw new Error(`project ${SUBAGENTS_KEY} must be an object`);
      if (WORKER_LIMIT_KEYS.some((key) => projectOptions[key] !== undefined)) limitOptions = projectOptions;
      for (const [key, value] of Object.entries(projectOptions)) {
        if (key === FLAG) ignoredProjectKeys.push(`${SUBAGENTS_KEY}.${key}`);
        else options[key] = value;
      }
    }
  }

  // `maxParallel` and `maxBackgroundWorkers` are deprecated aliases from before the
  // worker limit; the first key set counts, each checked under its own name.
  const warnings: string[] = [];
  const setKey = WORKER_LIMIT_KEYS.find((key) => limitOptions[key] !== undefined);
  const limitKey = setKey ?? "workerLimit";
  const workerLimitSource: WorkerLimitSource = setKey === undefined ? "default" : limitOptions === projectOptions ? "project" : "personal";
  const setLimit = limitOptions[limitKey] ?? DEFAULT_WORKER_LIMIT;
  if (typeof setLimit !== "number" || !Number.isInteger(setLimit) || setLimit < 1) {
    throw new Error(`${SUBAGENTS_KEY}.${limitKey} must be a positive integer`);
  }
  if (setLimit > WORKER_LIMIT_CEILING) {
    warnings.push(`${SUBAGENTS_KEY}.${limitKey} ${setLimit} is above the ceiling of ${WORKER_LIMIT_CEILING}; ${WORKER_LIMIT_CEILING} workers run at once`);
  }
  const workerLimit = Math.min(setLimit, WORKER_LIMIT_CEILING);
  // `explorationBudget` is the key's name from before ADR 0013; it still counts when `explorationNudge` is absent.
  const nudgeKey = options.explorationNudge === undefined && options.explorationBudget !== undefined ? "explorationBudget" : "explorationNudge";
  const explorationNudge = options[nudgeKey] ?? DEFAULT_EXPLORATION_NUDGE;
  if (typeof explorationNudge !== "number" || !Number.isInteger(explorationNudge) || explorationNudge < 1) {
    throw new Error(`${SUBAGENTS_KEY}.${nudgeKey} must be a positive integer`);
  }
  const gateLevel = options.gateLevel ?? DEFAULT_GATE_LEVEL;
  if (!GATE_LEVELS.includes(gateLevel as GateLevel)) throw new Error(`${SUBAGENTS_KEY}.gateLevel must be ${GATE_LEVELS.slice(0, -1).join(", ")} or ${GATE_LEVELS.at(-1)}`);
  const agentDefinitionModel = options.agentDefinitionModel;
  if (agentDefinitionModel !== undefined && !isPlainObject(agentDefinitionModel)) {
    throw new Error(`${SUBAGENTS_KEY}.agentDefinitionModel must be an object`);
  }
  const use = agentDefinitionModel?.use ?? "route";
  if (use !== "route" && use !== "preserve") throw new Error(`${SUBAGENTS_KEY}.agentDefinitionModel.use must be route or preserve`);
  const allowBanned = agentDefinitionModel?.allowBanned ?? false;
  if (typeof allowBanned !== "boolean") throw new Error(`${SUBAGENTS_KEY}.agentDefinitionModel.allowBanned must be a boolean`);

  return {
    settings: { workerLimit, agentDefinitionModel: { use, allowBanned }, explorationNudge, gateLevel: gateLevel as GateLevel },
    allowProjectOverrides,
    ignoredProjectKeys,
    warnings,
    workerLimitSource,
  };
}

/** The effective settings from `<agentDir>/settings.json` and `<cwd>/.pi/settings.json`. */
export function loadSubagentsSettings(agentDir: string, cwd: string): LoadedSubagentsSettings {
  const personal = readSettingsFile(join(agentDir, "settings.json")) ?? {};
  const project = readSettingsFile(join(cwd, ".pi", "settings.json"));
  return subagentsSettingsFromSettings(personal, project);
}
