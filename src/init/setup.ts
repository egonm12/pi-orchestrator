import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readFact } from "../catalog/epistemic.ts";
import { buildCatalog, lookup } from "../catalog/model-catalog.ts";
import { isProhibitedModel, type BanLists } from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import {
  authorizeRecipient,
  grantOwnerApproval,
  loadAuthorizationOrEmpty,
  saveAuthorization,
  type RecipientAuthorization,
} from "../recipients/authorization.ts";
import { RISK_TIERS, type RiskTier } from "../routing/tiers.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { checkModelScope } from "../models/model-scope.ts";
import { getSupportedThinkingLevels, type ModelInfo, type ThinkingLevel } from "../models/model-info.ts";
import { isAutoModel } from "../router/auto-model.ts";

// Fresh-install support: what is missing at session start, and the pieces
// `/pi-orchestrator init` writes. The package ships no tier map, no ban list
// and no approved recipients; init proposes a starter from the installed
// models and asks the owner to approve each provider. Recipients stay fail
// closed: nothing here approves a provider without an explicit yes.

export const INIT_COMMAND = "pi-orchestrator";
export const RECIPIENTS_FILE = "authorized-recipients.json";

export interface SetupStatus {
  readonly tiersMissing: boolean;
  readonly recipientsMissing: boolean;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orchestratorOf(personal: unknown): Record<string, unknown> {
  const value = isPlainObject(personal) ? personal.orchestrator : undefined;
  return isPlainObject(value) ? value : {};
}

function routingOf(personal: unknown): Record<string, unknown> {
  const value = orchestratorOf(personal).routing;
  return isPlainObject(value) ? value : {};
}

export function setupStatus(personal: unknown, stateDir: string): SetupStatus {
  return {
    tiersMissing: routingOf(personal).tiers === undefined,
    recipientsMissing: !existsSync(join(stateDir, RECIPIENTS_FILE)),
  };
}

/** The notice printed at session start when something is missing, or
 *  `undefined` when the package is set up. */
export function setupNotice(status: SetupStatus, stateDir: string): string | undefined {
  const missing = [
    ...(status.tiersMissing ? ["no tier map (orchestrator.routing.tiers in personal settings)"] : []),
    ...(status.recipientsMissing ? [`no approved recipients (${join(stateDir, RECIPIENTS_FILE)})`] : []),
  ];
  if (missing.length === 0) return undefined;
  return `pi-orchestrator: not set up: ${missing.join(", ")}. Run /${INIT_COMMAND} init.`;
}

// ---------------------------------------------------------------------------
// Starter tier map
// ---------------------------------------------------------------------------

export const TIER_EFFORT: Record<RiskTier, readonly ThinkingLevel[]> = {
  mechanical: ["low", "minimal", "off"],
  standard: ["medium", "low", "off"],
  elevated: ["high", "medium", "off"],
  critical: ["xhigh", "high", "medium", "off"],
};

export function starterRungFor(model: ModelInfo, tier: RiskTier): string {
  const supported = getSupportedThinkingLevels(model);
  const effort = TIER_EFFORT[tier].find((level) => supported.includes(level)) ?? supported[0] ?? "off";
  return `${model.fullId}:${effort}`;
}

export interface StarterTierMap {
  readonly tiers: Record<RiskTier, string[]>;
  readonly classifier: string;
  /** Installed models left out, with why. */
  readonly skipped: readonly string[];
}

export interface EligibleRoutingModels {
  /** Eligible installed models, sorted by known output price, then unknown price, then id. */
  readonly models: readonly ModelInfo[];
  /** Installed models left out, with why. */
  readonly skipped: readonly string[];
}

export function publishedOutputPrice(model: ModelInfo): number | undefined {
  const catalog = buildCatalog({ modelIds: [model.fullId] });
  const entry = lookup(catalog, model.fullId);
  const price = entry && readFact(entry.publishedListPrice);
  return price && price.state !== "unknown" ? price.value.outputUsdPerMTok : undefined;
}

function pricedRoutingModels(models: readonly ModelInfo[]): { model: ModelInfo; output: number }[] {
  return models.flatMap((model) => {
    const output = publishedOutputPrice(model);
    return output === undefined ? [] : [{ model, output }];
  });
}

export function eligibleRoutingModels(installed: readonly ModelInfo[], banLists: BanLists): EligibleRoutingModels {
  const skipped: string[] = [];
  const eligible: ModelInfo[] = [];
  for (const model of installed) {
    if (isAutoModel(model)) { skipped.push(`${model.fullId}: orchestrator auto model`); continue; }
    if (isProhibitedModel(model.fullId, banLists)) { skipped.push(`${model.fullId}: subagent ban list`); continue; }
    if (checkModelScope(model.fullId, HARNESS_MODEL_SCOPE, "explicit")?.severity === "error") { skipped.push(`${model.fullId}: allowed-model list`); continue; }
    eligible.push(model);
  }
  return {
    models: eligible.sort((a, b) => {
      const aPrice = publishedOutputPrice(a);
      const bPrice = publishedOutputPrice(b);
      if (aPrice !== undefined && bPrice !== undefined) return aPrice - bPrice || a.fullId.localeCompare(b.fullId);
      if (aPrice !== undefined) return -1;
      if (bPrice !== undefined) return 1;
      return a.fullId.localeCompare(b.fullId);
    }),
    skipped,
  };
}

/** A starter tier map from the installed models: those the allowed-model
 *  list and the ban list admit and whose published price is known, cheapest
 *  first. Mechanical takes the cheapest two, standard the middle, elevated
 *  and critical the two most expensive at rising effort. The classifier runs
 *  on the cheapest. `undefined` when no installed model qualifies. */
export function starterTierMap(installed: readonly ModelInfo[], banLists: BanLists): StarterTierMap | undefined {
  const eligible = eligibleRoutingModels(installed, banLists);
  const priced = pricedRoutingModels(eligible.models).sort((a, b) => a.output - b.output || a.model.fullId.localeCompare(b.model.fullId));
  const sorted = priced.map((entry) => entry.model);
  const unpriced = eligible.models.filter((model) => publishedOutputPrice(model) === undefined).map((model) => `${model.fullId}: no published price`);
  const skipped = [...eligible.skipped, ...unpriced];
  if (sorted.length === 0) return undefined;
  const pick = (from: number, count: number) => sorted.slice(Math.max(0, from), Math.max(0, from) + count);
  const middle = Math.floor((sorted.length - 1) / 2);
  const top = pick(sorted.length - 2, 2).reverse();
  const tiers: Record<RiskTier, string[]> = {
    mechanical: pick(0, 2).map((model) => starterRungFor(model, "mechanical")),
    standard: pick(middle, 2).map((model) => starterRungFor(model, "standard")),
    elevated: top.map((model) => starterRungFor(model, "elevated")),
    critical: top.map((model) => starterRungFor(model, "critical")),
  };
  return { tiers, classifier: starterRungFor(sorted[0]!, "mechanical"), skipped };
}

/** The providers a tier map and classifier would send task text to. */
export function recipientProviders(starter: Pick<StarterTierMap, "tiers" | "classifier">): string[] {
  const rungs = [...Object.values(starter.tiers).flat(), starter.classifier];
  return [...new Set(rungs.map((rung) => rung.slice(0, rung.indexOf("/"))))].sort();
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

export function readPersonalSettings(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isPlainObject(parsed)) throw new Error(`${path} is not a JSON object`);
  return parsed;
}

/** The subagent ban list in personal settings, or `[]` when there is none.
 *  Non-string items are left out. */
export function currentSubagentBanList(personal: unknown): string[] {
  const list = orchestratorOf(personal).subagentBanList;
  return Array.isArray(list) ? list.filter((entry): entry is string => typeof entry === "string") : [];
}

export function currentClassifierRung(personal: unknown): string | undefined {
  return classifierModelIn(routingOf(personal));
}

function tierRungsFrom(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string");
  if (isPlainObject(value) && Array.isArray(value.rungs)) return value.rungs.filter((entry): entry is string => typeof entry === "string");
  return undefined;
}

export function currentTierRungs(personal: unknown): Partial<Record<RiskTier, string[]>> | undefined {
  const tiers = routingOf(personal).tiers;
  if (!isPlainObject(tiers)) return undefined;
  const current: Partial<Record<RiskTier, string[]>> = {};
  for (const tier of RISK_TIERS) {
    const rungs = tierRungsFrom(tiers[tier]);
    if (rungs && rungs.length > 0) current[tier] = rungs;
  }
  return Object.keys(current).length > 0 ? current : undefined;
}

export interface SettingsPlan {
  /** The settings after init; equal to the input when nothing changes. */
  readonly settings: Record<string, unknown>;
  readonly changes: readonly string[];
}

export interface PlanOptions {
  /** Replace an existing tier map with the picked map; the owner confirmed it. */
  readonly rebuildTiers?: boolean;
}

function classifierModelIn(routing: Record<string, unknown>): string | undefined {
  const classifier = routing.classifier;
  if (!isPlainObject(classifier)) return undefined;
  return typeof classifier.model === "string" ? classifier.model : undefined;
}

function setClassifierModel(routing: Record<string, unknown>, model: string, changes: string[]): void {
  const existing = routing.classifier;
  if (classifierModelIn(routing) === model) return;
  routing.classifier = isPlainObject(existing) ? { ...existing, model } : { model };
  changes.push(`orchestrator.routing.classifier.model = ${model}`);
}

function withPickedTiersPreservingOrders(existing: unknown, picked: Record<RiskTier, string[]>): Record<RiskTier, string[] | { order?: unknown; rungs: string[] }> {
  const result = {} as Record<RiskTier, string[] | { order?: unknown; rungs: string[] }>;
  const current = isPlainObject(existing) ? existing : {};
  for (const tier of RISK_TIERS) {
    const value = current[tier];
    result[tier] = isPlainObject(value) && value.order !== undefined
      ? { order: value.order, rungs: picked[tier] }
      : picked[tier];
  }
  return result;
}

/** Add what is missing and keep what is there: an existing tier map is
 *  replaced only with `rebuildTiers`. When rebuilding, the classifier is
 *  replaced too because init just asked for it, with the existing classifier
 *  preselected by the UI when it is still eligible. The subagent ban list is
 *  the exception: init's picker starts from the current list, so the picked
 *  list replaces it when it differs. A new tier map starts in shadow mode,
 *  which records decisions while workers run on the session model; a rebuilt
 *  one keeps the mode and switch already set. */
export function planSettings(personal: Record<string, unknown>, starter: StarterTierMap | undefined, subagentBanList: readonly string[], options: PlanOptions = {}): SettingsPlan {
  const changes: string[] = [];
  const orchestrator = { ...orchestratorOf(personal) };
  const routing = { ...routingOf(personal) };
  if (routing.tiers !== undefined && starter && options.rebuildTiers) {
    routing.tiers = withPickedTiersPreservingOrders(routing.tiers, starter.tiers);
    changes.push("orchestrator.routing.tiers (rebuilt from picked models)");
    setClassifierModel(routing, starter.classifier, changes);
  } else if (routing.tiers === undefined && starter) {
    routing.tiers = starter.tiers;
    if (routing.enabled === undefined) routing.enabled = true;
    if (routing.mode === undefined) routing.mode = "shadow";
    changes.push("orchestrator.routing.tiers (picked map, shadow mode)");
    setClassifierModel(routing, starter.classifier, changes);
  }
  const existing = orchestrator.subagentBanList;
  const unchanged = Array.isArray(existing) && existing.length === subagentBanList.length && existing.every((entry, index) => entry === subagentBanList[index]);
  if (!unchanged) {
    orchestrator.subagentBanList = [...subagentBanList];
    changes.push(`orchestrator.subagentBanList = [${subagentBanList.join(", ")}]`);
  }
  if (orchestrator.sessionBanList === undefined) {
    orchestrator.sessionBanList = [];
    changes.push("orchestrator.sessionBanList = []");
  }
  if (changes.length === 0) return { settings: personal, changes };
  orchestrator.routing = routing;
  if (Object.keys(routing).length === 0) delete orchestrator.routing;
  return { settings: { ...personal, orchestrator }, changes };
}

export function writePersonalSettings(path: string, settings: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/** Add each provider the owner approved, one explicit approval each, and
 *  save the store. A declined provider is not added. */
export function approveRecipients(storePath: string, approved: readonly string[], approvedBy: string): RecipientAuthorization {
  let authorization = loadAuthorizationOrEmpty(storePath);
  for (const provider of approved) {
    const approval = grantOwnerApproval({
      approvedBy,
      scope: "data-recipient",
      acknowledgement: `Approved ${provider} as a data recipient in /${INIT_COMMAND} init: the router may send delegated task text to ${provider} models.`,
    });
    authorization = authorizeRecipient(authorization, provider, approval, "approved in /pi-orchestrator init");
  }
  saveAuthorization(storePath, authorization);
  return authorization;
}
