import { join } from "node:path";
import {
  getSupportedThinkingLevels,
  THINKING_LEVELS,
  type ModelInfo,
  type ThinkingLevel,
} from "../models/model-info.ts";
import {
  checkModelScope,
  type ModelScopeCheckRule,
} from "../models/model-scope.ts";
import {
  banListsFromSettings,
  isProhibitedModel,
  personalAgentDir,
  personalOrchestrator,
  readSettingsFile,
  type BanListSources,
  type BanLists,
} from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { RISK_TIERS, type RiskTier } from "./classifier.ts";

// Ticket 22, ADR 0001: the owner-written tier map.
//
//   orchestrator.routing.tiers   personal settings: all four tiers, each a
//                           non-empty ordered list of rungs written
//                           `provider/model:effort`.
//
// A project settings file (`<cwd>/.pi/settings.json`) may carry only
// `orchestrator.routing.tiers`. A project tier replaces the personal tier of the
// same name; unnamed tiers are inherited. Every other project `orchestrator` key,
// and a project key that is not one of the four tiers, is ignored and named in
// `ignoredProjectKeys`.
//
// Every rung must pass the subagent ban list (`isProhibitedModel`, reading the
// personal `orchestrator.subagentBanList`), the allowed-model list (ticket 04's
// scope, `checkModelScope`) and name an installed model. A failing rung, from
// either file, is dropped with its reason so a wrong map stays visible in the
// decision record (ADR 0001). A project tier emptied by drops inherits the
// personal tier; a personal tier emptied by drops has nothing to inherit and
// fails closed.
//
// Efforts are pi's levels; an installed model must support the effort by
// pi's own rule (`getSupportedThinkingLevels`). A malformed rung fails closed.
//
// The result is a plain frozen value. The loader logs nothing: ticket 27's
// extension puts the value unchanged in the decision record.

export type RungOrigin = "personal" | "project";

export interface TierRung {
  /** As written in settings, trimmed: `provider/model:effort`. */
  readonly rung: string;
  /** `provider/model`, spelled as the installed registry spells it (the
   *  lookup ignores case, so `rung` may differ from `model` in case only). */
  readonly model: string;
  readonly effort: ThinkingLevel;
  readonly origin: RungOrigin;
}

export type RungDropReason = "subagent ban list" | "allowed-model list" | "not installed";

export type TierMapDrop =
  | {
      readonly tier: RiskTier;
      readonly rung: string;
      readonly origin: RungOrigin;
      readonly reason: RungDropReason;
    }
  | { readonly tier: RiskTier; readonly origin: "project"; readonly reason: "inherited after drops" };

export interface ResolvedTierMap {
  readonly tiers: Readonly<Record<RiskTier, readonly TierRung[]>>;
  readonly drops: readonly TierMapDrop[];
  readonly ignoredProjectKeys: readonly string[];
}

export interface TierMapInputs {
  readonly installedModels: readonly ModelInfo[];
  readonly modelScope?: ModelScopeCheckRule;
  readonly banLists?: BanLists;
}

type SettingsFile = "personal" | "project";

const TIERS_KEY = "orchestrator.routing.tiers";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keyError(file: SettingsFile, key: string, problem: string): Error {
  return new Error(`tier map: ${file} settings key '${key}' ${problem}`);
}

type ParsedRung = Omit<TierRung, "origin">;

function parsedRung(file: SettingsFile, key: string, value: unknown, installedModels: readonly ModelInfo[]): ParsedRung {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw keyError(file, key, `must be a rung written provider/model:effort; got ${JSON.stringify(value)}.`);
  }
  const rung = value.trim();
  const colon = rung.lastIndexOf(":");
  if (colon === -1) {
    throw keyError(file, key, `has no ':effort' in ${JSON.stringify(rung)}; write it as provider/model:effort.`);
  }
  const model = rung.slice(0, colon);
  const effort = rung.slice(colon + 1);
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw keyError(file, key, `does not name a provider/model in ${JSON.stringify(rung)}.`);
  }
  const level = THINKING_LEVELS.find((candidate) => candidate === effort);
  if (level === undefined) {
    throw keyError(file, key, `effort '${effort}' is not one of pi's levels (${THINKING_LEVELS.join(", ")}).`);
  }
  // A model that is not installed has no levels to check against; the rung
  // is dropped as `not installed` by `failedHardFilter` instead.
  const installed = installedModel(model, installedModels);
  if (installed !== undefined) {
    const supported = getSupportedThinkingLevels(installed);
    if (!supported.includes(level)) {
      throw keyError(file, key, `model '${model}' does not support effort '${level}' (supported: ${supported.join(", ")}).`);
    }
  }
  // The canonical id, so exact-match consumers downstream find the entry.
  return { rung, model: installed?.fullId ?? model, effort: level };
}

/** Case-insensitive on the full `provider/id`, as pi's own model resolver
 *  matches a canonical reference (`core/model-resolver.js`). */
function installedModel(model: string, installedModels: readonly ModelInfo[]): ModelInfo | undefined {
  const id = model.toLowerCase();
  return installedModels.find((entry) => entry.fullId.toLowerCase() === id);
}

function parsedTier(file: SettingsFile, tier: RiskTier, value: unknown, installedModels: readonly ModelInfo[]): ParsedRung[] {
  const key = `${TIERS_KEY}.${tier}`;
  if (!Array.isArray(value) || value.length === 0) {
    throw keyError(file, key, `must be a non-empty list of rungs; got ${JSON.stringify(value)}.`);
  }
  return value.map((entry, index) => parsedRung(file, `${key}[${index}]`, entry, installedModels));
}

/** The load-time check a rung fails, if any, in this order: the ban list,
 *  the allowed-model list, then installed. So a banned rung outside the
 *  allow list reports the ban. */
function failedHardFilter(model: string, inputs: Required<TierMapInputs>): RungDropReason | undefined {
  if (isProhibitedModel(model, inputs.banLists)) return "subagent ban list";
  if (checkModelScope(model, inputs.modelScope, "explicit")?.severity === "error") return "allowed-model list";
  if (installedModel(model, inputs.installedModels) === undefined) return "not installed";
  return undefined;
}

function frozenRung(rung: ParsedRung, origin: RungOrigin): TierRung {
  return Object.freeze({ ...rung, origin });
}

interface PersonalTiers {
  readonly tiers: Record<RiskTier, readonly TierRung[]>;
  readonly drops: readonly TierMapDrop[];
}

/** The personal map, every rung checked and failing rungs dropped;
 *  `undefined` when there is none and routing is not enabled. */
function personalTiers(personal: unknown, inputs: Required<TierMapInputs>): PersonalTiers | undefined {
  const orchestrator = personalOrchestrator(personal);
  const routing = orchestrator?.routing;
  if (routing !== undefined && !isPlainObject(routing)) {
    throw keyError("personal", "orchestrator.routing", `must be an object; got ${JSON.stringify(routing)}.`);
  }
  const enabled = routing?.enabled;
  if (enabled !== undefined && typeof enabled !== "boolean") {
    throw keyError("personal", "orchestrator.routing.enabled", `must be a boolean; got ${JSON.stringify(enabled)}.`);
  }
  const tiers = routing?.tiers;
  if (tiers === undefined) {
    if (enabled === true) throw keyError("personal", TIERS_KEY, "is missing while orchestrator.routing.enabled is true.");
    return undefined;
  }
  if (!isPlainObject(tiers)) {
    throw keyError("personal", TIERS_KEY, `must be an object keyed by tier; got ${JSON.stringify(tiers)}.`);
  }
  for (const name of Object.keys(tiers)) {
    if (!RISK_TIERS.includes(name as RiskTier)) {
      throw keyError("personal", `${TIERS_KEY}.${name}`, `is not a tier; the tiers are ${RISK_TIERS.join(", ")}.`);
    }
  }
  const resolved = {} as Record<RiskTier, readonly TierRung[]>;
  const drops: TierMapDrop[] = [];
  for (const tier of RISK_TIERS) {
    if (!Object.hasOwn(tiers, tier)) {
      throw keyError("personal", `${TIERS_KEY}.${tier}`, `is missing; the personal tier map lists all four tiers (${RISK_TIERS.join(", ")}).`);
    }
    const kept: TierRung[] = [];
    const reasons: RungDropReason[] = [];
    for (const rung of parsedTier("personal", tier, tiers[tier], inputs.installedModels)) {
      const failed = failedHardFilter(rung.model, inputs);
      if (failed === undefined) {
        kept.push(frozenRung(rung, "personal"));
        continue;
      }
      reasons.push(failed);
      drops.push(Object.freeze({ tier, rung: rung.rung, origin: "personal", reason: failed }));
    }
    // A personal tier has nothing to inherit, so emptying it is an error.
    if (kept.length === 0) {
      throw keyError("personal", `${TIERS_KEY}.${tier}`, `has every rung dropped (${reasons.join(", ")}); a personal tier has nothing to inherit.`);
    }
    resolved[tier] = Object.freeze(kept);
  }
  return { tiers: resolved, drops };
}

interface ProjectOverride {
  readonly tiers: Partial<Record<RiskTier, unknown>>;
  readonly ignoredProjectKeys: readonly string[];
}

/** The project's tier values, unparsed, and every key it carries that a
 *  project may not set. */
function projectOverride(project: unknown): ProjectOverride {
  const tiers: Partial<Record<RiskTier, unknown>> = {};
  const ignoredProjectKeys: string[] = [];
  const override = { tiers, ignoredProjectKeys };
  if (project === undefined) return override;
  if (!isPlainObject(project)) throw new Error("tier map: project settings must be a JSON object.");
  const orchestrator = project.orchestrator;
  if (orchestrator === undefined) return override;
  if (!isPlainObject(orchestrator)) throw keyError("project", "orchestrator", `must be an object; got ${JSON.stringify(orchestrator)}.`);
  for (const key of Object.keys(orchestrator)) if (key !== "routing") ignoredProjectKeys.push(`orchestrator.${key}`);
  const routing = orchestrator.routing;
  if (routing === undefined) return override;
  if (!isPlainObject(routing)) throw keyError("project", "orchestrator.routing", `must be an object; got ${JSON.stringify(routing)}.`);
  for (const key of Object.keys(routing)) if (key !== "tiers") ignoredProjectKeys.push(`orchestrator.routing.${key}`);
  const projectTiers = routing.tiers;
  if (projectTiers === undefined) return override;
  if (!isPlainObject(projectTiers)) {
    throw keyError("project", TIERS_KEY, `must be an object keyed by tier; got ${JSON.stringify(projectTiers)}.`);
  }
  for (const [name, value] of Object.entries(projectTiers)) {
    if (RISK_TIERS.includes(name as RiskTier)) tiers[name as RiskTier] = value;
    else ignoredProjectKeys.push(`${TIERS_KEY}.${name}`);
  }
  return override;
}

/** Pure: the resolved tier map from parsed personal and (optional) project
 *  settings. Throws, naming the key, on a malformed map. Returns `undefined`
 *  when the personal file has no tiers and routing is not enabled. */
export function tierMapFromSettings(personal: unknown, project: unknown, inputs: TierMapInputs): ResolvedTierMap | undefined {
  const complete: Required<TierMapInputs> = {
    installedModels: inputs.installedModels,
    modelScope: inputs.modelScope ?? HARNESS_MODEL_SCOPE,
    banLists: inputs.banLists ?? banListsFromSettings(personal).banLists,
  };
  const personalMap = personalTiers(personal, complete);
  if (personalMap === undefined) return undefined;

  const override = projectOverride(project);
  const tiers = {} as Record<RiskTier, readonly TierRung[]>;
  const drops: TierMapDrop[] = [...personalMap.drops];
  for (const tier of RISK_TIERS) {
    if (!Object.hasOwn(override.tiers, tier)) {
      tiers[tier] = personalMap.tiers[tier];
      continue;
    }
    const kept: TierRung[] = [];
    for (const rung of parsedTier("project", tier, override.tiers[tier], complete.installedModels)) {
      const failed = failedHardFilter(rung.model, complete);
      if (failed === undefined) kept.push(frozenRung(rung, "project"));
      else drops.push(Object.freeze({ tier, rung: rung.rung, origin: "project", reason: failed }));
    }
    if (kept.length > 0) {
      tiers[tier] = Object.freeze(kept);
    } else {
      tiers[tier] = personalMap.tiers[tier];
      drops.push(Object.freeze({ tier, origin: "project", reason: "inherited after drops" }));
    }
  }
  return Object.freeze({
    tiers: Object.freeze(tiers),
    drops: Object.freeze(drops),
    ignoredProjectKeys: Object.freeze([...override.ignoredProjectKeys]),
  });
}

export interface TierMapSources extends BanListSources, TierMapInputs {}

/** The tier map from `<agentDir>/settings.json` and, when `projectCwd` is
 *  given, `<projectCwd>/.pi/settings.json`. A missing file is no settings. */
export function loadTierMap({ agentDir = personalAgentDir(), projectCwd, ...inputs }: TierMapSources): ResolvedTierMap | undefined {
  const personal = readSettingsFile(join(agentDir, "settings.json")) ?? {};
  const project = projectCwd === undefined ? undefined : readSettingsFile(join(projectCwd, ".pi", "settings.json"));
  return tierMapFromSettings(personal, project, inputs);
}
