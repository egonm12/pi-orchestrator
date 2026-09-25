import { join } from "node:path";
import { personalOrchestrator, readSettingsFile } from "../policy/ban-lists.ts";

// The subagents extension's settings (ADR 0007), under `orchestrator.subagents`
// in personal settings. `allowProjectOverrides` is read from personal settings
// only, default false. When it is on, a key in the project's
// `.pi/settings.json` replaces the personal value whole; a project value for
// the flag itself is ignored. When it is off, every project key is ignored.
// Each ignored key is named in `ignoredProjectKeys`, for the extension to log.

type AgentDefinitionModelUse = "route" | "preserve";

export interface SubagentsSettings {
  readonly maxParallel: number;
  readonly agentDefinitionModel: { readonly use: AgentDefinitionModelUse };
}

export interface LoadedSubagentsSettings {
  /** The personal settings, with the project's keys when allowed. */
  readonly settings: SubagentsSettings;
  /** Personal settings only. */
  readonly allowProjectOverrides: boolean;
  /** Dotted keys the project's `orchestrator.subagents` carried and the
   *  loader ignored, e.g. `orchestrator.subagents.maxParallel`. */
  readonly ignoredProjectKeys: readonly string[];
}

const SUBAGENTS_KEY = "orchestrator.subagents";
const FLAG = "allowProjectOverrides";

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
  if (projectOptions !== undefined) {
    if (!allowProjectOverrides) {
      if (isPlainObject(projectOptions)) ignoredProjectKeys.push(...Object.keys(projectOptions).map((key) => `${SUBAGENTS_KEY}.${key}`));
      else ignoredProjectKeys.push(SUBAGENTS_KEY);
    } else {
      if (!isPlainObject(projectOptions)) throw new Error(`project ${SUBAGENTS_KEY} must be an object`);
      for (const [key, value] of Object.entries(projectOptions)) {
        if (key === FLAG) ignoredProjectKeys.push(`${SUBAGENTS_KEY}.${key}`);
        else options[key] = value;
      }
    }
  }

  const maxParallel = options.maxParallel ?? 4;
  if (typeof maxParallel !== "number" || !Number.isInteger(maxParallel) || maxParallel < 1) {
    throw new Error(`${SUBAGENTS_KEY}.maxParallel must be a positive integer`);
  }
  const agentDefinitionModel = options.agentDefinitionModel;
  if (agentDefinitionModel !== undefined && !isPlainObject(agentDefinitionModel)) {
    throw new Error(`${SUBAGENTS_KEY}.agentDefinitionModel must be an object`);
  }
  const use = agentDefinitionModel?.use ?? "route";
  if (use !== "route" && use !== "preserve") throw new Error(`${SUBAGENTS_KEY}.agentDefinitionModel.use must be route or preserve`);

  return {
    settings: { maxParallel: Math.min(maxParallel, 8), agentDefinitionModel: { use } },
    allowProjectOverrides,
    ignoredProjectKeys,
  };
}

/** The effective settings from `<agentDir>/settings.json` and `<cwd>/.pi/settings.json`. */
export function loadSubagentsSettings(agentDir: string, cwd: string): LoadedSubagentsSettings {
  const personal = readSettingsFile(join(agentDir, "settings.json")) ?? {};
  const project = readSettingsFile(join(cwd, ".pi", "settings.json"));
  return subagentsSettingsFromSettings(personal, project);
}
