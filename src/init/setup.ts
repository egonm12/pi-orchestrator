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
import type { RiskTier } from "../routing/classifier.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { checkModelScope } from "../models/model-scope.ts";
import { getSupportedThinkingLevels, type ModelInfo, type ThinkingLevel } from "../models/model-info.ts";

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

/** The one line printed at session start when something is missing, or
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

const TIER_EFFORT: Record<RiskTier, readonly ThinkingLevel[]> = {
  mechanical: ["low", "minimal", "off"],
  standard: ["medium", "low", "off"],
  elevated: ["high", "medium", "off"],
  critical: ["xhigh", "high", "medium", "off"],
};

function rungFor(model: ModelInfo, tier: RiskTier): string {
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

/** A starter tier map from the installed models: those the allowed-model
 *  list and the ban list admit and whose published price is known, cheapest
 *  first. Mechanical takes the cheapest two, standard the middle, elevated
 *  and critical the two most expensive at rising effort. The classifier runs
 *  on the cheapest. `undefined` when no installed model qualifies. */
export function starterTierMap(installed: readonly ModelInfo[], banLists: BanLists): StarterTierMap | undefined {
  const skipped: string[] = [];
  const catalog = buildCatalog({ modelIds: installed.map((model) => model.fullId) });
  const priced: { model: ModelInfo; output: number }[] = [];
  for (const model of installed) {
    if (isProhibitedModel(model.fullId, banLists)) { skipped.push(`${model.fullId}: subagent ban list`); continue; }
    if (checkModelScope(model.fullId, HARNESS_MODEL_SCOPE, "explicit")?.severity === "error") { skipped.push(`${model.fullId}: allowed-model list`); continue; }
    const entry = lookup(catalog, model.fullId);
    const price = entry && readFact(entry.publishedListPrice);
    if (!price || price.state === "unknown") { skipped.push(`${model.fullId}: no published price`); continue; }
    priced.push({ model, output: price.value.outputUsdPerMTok });
  }
  if (priced.length === 0) return undefined;
  const sorted = priced.sort((a, b) => a.output - b.output || a.model.fullId.localeCompare(b.model.fullId)).map((entry) => entry.model);
  const pick = (from: number, count: number) => sorted.slice(Math.max(0, from), Math.max(0, from) + count);
  const middle = Math.floor((sorted.length - 1) / 2);
  const top = pick(sorted.length - 2, 2).reverse();
  const tiers: Record<RiskTier, string[]> = {
    mechanical: pick(0, 2).map((model) => rungFor(model, "mechanical")),
    standard: pick(middle, 2).map((model) => rungFor(model, "standard")),
    elevated: top.map((model) => rungFor(model, "elevated")),
    critical: top.map((model) => rungFor(model, "critical")),
  };
  return { tiers, classifier: rungFor(sorted[0]!, "mechanical"), skipped };
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

export interface SettingsPlan {
  /** The settings after init; equal to the input when nothing changes. */
  readonly settings: Record<string, unknown>;
  readonly changes: readonly string[];
}

/** Add what is missing and keep what is there: an existing tier map,
 *  classifier or ban list is never replaced. A new tier map starts in shadow
 *  mode, which records decisions and changes no call. */
export function planSettings(personal: Record<string, unknown>, starter: StarterTierMap | undefined, subagentBanList: readonly string[]): SettingsPlan {
  const changes: string[] = [];
  const orchestrator = { ...orchestratorOf(personal) };
  const routing = { ...routingOf(personal) };
  if (routing.tiers === undefined && starter) {
    routing.tiers = starter.tiers;
    if (routing.enabled === undefined) routing.enabled = true;
    if (routing.mode === undefined) routing.mode = "shadow";
    changes.push("orchestrator.routing.tiers (starter map, shadow mode)");
    if (routing.classifier === undefined) {
      routing.classifier = { model: starter.classifier };
      changes.push(`orchestrator.routing.classifier.model = ${starter.classifier}`);
    }
  }
  if (orchestrator.subagentBanList === undefined) {
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
