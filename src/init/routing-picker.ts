import { getSupportedThinkingLevels, THINKING_LEVELS, type ModelInfo, type ThinkingLevel } from "../models/model-info.ts";
import { dynamicRungRefusal } from "../models/effort-capability.ts";
import { RISK_TIERS, type RiskTier } from "../routing/tiers.ts";
import { type PickerUi } from "./ban-list-picker.ts";
import { canUseCustomCheckbox, checkboxSelect, checkboxSelectWithValues, type CheckboxRowValueConfig } from "./checkbox-select.ts";
import { autoEffortBand, fixedEffortLevelAtDynamicTop, publishedOutputPrice, starterRungFor, type StarterTierMap } from "./setup.ts";
import { isDynamicRung, modelIdFromRung, thinkingLevelFromRung } from "./rungs.ts";
export { modelIdFromRung, thinkingLevelFromRung };

// Interactive routing choices for `/pi-orchestrator init`. In the TUI, tier
// model picking uses a checkbox list with inline thinking-level cycling; other
// modes fall back to a select loop and follow-up thinking-level selects.
//
// The picker writes checkbox selections in option order, which is the eligible
// model order shown by pi. Balanced routing chooses among surviving providers
// by recent usage, with list order only breaking ties. Ordered tiers take the
// first survivor. The retry effort ladder can also move from a failed rung to
// later listed rungs.

export const ROUTING_PICKER_HINT =
  "Pick a classifier, then the models and thinking level for each tier. In a balanced tier, routing picks by recent provider usage and list order only breaks ties. An ordered tier uses the first model still available. Retries can move on to models later in the list. Escape keeps your current choice, or the starter choice if you have none.";
export const PRICE_UNKNOWN_LABEL = "price unknown";
export const KEEP_STARTER_TIER = "Keep starter picks for this tier";
export const ROUTING_BACK = "Back, remove nothing";
export const CLASSIFIER_MODEL_HINT =
  "The classifier runs on every delegation. A small, fast model is usually enough; larger models add delay and cost to each delegation.";
export const TIER_MODEL_USAGE_HINT = "More models give routing more choices when usage runs low.";
export const THINKING_LEVEL_HINT = "Higher thinking levels are slower and costlier.";
export const AUTO_EFFORT_HINT = "Saves cost on easy messages, thinks harder on hard ones. Same model, cache kept.";
const AUTO_EFFORT_CHOICE = "auto";
export const CLASSIFIER_THINKING_HINT =
  "The classifier runs on every delegation; higher thinking levels add delay and cost each time. Low effort is usually enough.";

const TIER_HINTS: Record<RiskTier, string> = {
  mechanical: "Behaviour-preserving work: formatting, typos, comments, import order and tool-checkable renames.",
  standard: "Ordinary behaviour changes with clear requirements, where tests or review catch mistakes and a revert undoes them.",
  elevated: "Costly or hard-to-see mistakes: public APIs, releases, migrations, concurrency, performance, validation, sensitive logging or vague requirements.",
  critical: "Security-boundary changes or unrecoverable data destruction.",
};

export interface RoutingPickerDefaults {
  readonly starter: StarterTierMap;
  /** Existing tier rungs, used as rebuild defaults when present. */
  readonly tiers?: Partial<Record<RiskTier, readonly string[]>>;
  /** Existing classifier rung, used as the rebuild default when present. */
  readonly classifier?: string;
}

function modelByFullId(models: readonly ModelInfo[], fullId: string): ModelInfo | undefined {
  return models.find((model) => model.fullId === fullId);
}

function uniqueKnownModelIds(rungs: readonly string[], eligible: readonly ModelInfo[]): string[] {
  const ids: string[] = [];
  for (const rung of rungs) {
    const id = modelIdFromRung(rung);
    if (!ids.includes(id) && modelByFullId(eligible, id)) ids.push(id);
  }
  return ids;
}

function defaultTierRungs(defaults: RoutingPickerDefaults, tier: RiskTier): readonly string[] {
  return defaults.tiers?.[tier] ?? defaults.starter.tiers[tier] ?? [];
}

function normalizedTierRung(rung: string, tier: RiskTier, model: ModelInfo, ui?: PickerUi): string {
  if (!isDynamicRung(rung) || dynamicRungRefusal(model.fullId, model) === undefined) return rung;
  const fixed = `${model.fullId}:${fixedEffortLevelAtDynamicTop(rung, model)}`;
  ui?.notify(`pi-orchestrator: existing ${tier} rung ${rung} is no longer cache-safe for effort changes; using fixed effort ${fixed} instead.`, "warning");
  return fixed;
}

function tierDefaults(defaults: RoutingPickerDefaults, eligible: readonly ModelInfo[], ui?: PickerUi): Record<RiskTier, string[]> {
  const tiers = {} as Record<RiskTier, string[]>;
  for (const tier of RISK_TIERS) {
    tiers[tier] = defaultTierRungs(defaults, tier).flatMap((rung) => {
      const model = modelByFullId(eligible, modelIdFromRung(rung));
      return model ? [normalizedTierRung(rung, tier, model, ui)] : [];
    });
  }
  return tiers;
}

function warnUnavailableDefaults(ui: PickerUi, defaults: RoutingPickerDefaults, eligible: readonly ModelInfo[]): void {
  const eligibleIds = new Set(eligible.map((model) => model.fullId));
  for (const tier of RISK_TIERS) {
    for (const rung of defaults.tiers?.[tier] ?? []) {
      const modelId = modelIdFromRung(rung);
      if (!eligibleIds.has(modelId)) ui.notify(`pi-orchestrator: existing ${tier} rung ${rung} is not available or eligible, so it is not shown in the picker.`, "warning");
    }
  }
  if (defaults.classifier && !eligibleIds.has(modelIdFromRung(defaults.classifier))) {
    ui.notify(`pi-orchestrator: existing classifier ${defaults.classifier} is not available or eligible, so it is not shown in the picker.`, "warning");
  }
}

export function modelOptions(eligible: readonly ModelInfo[], preferred?: string): string[] {
  const ids = eligible.map((model) => model.fullId);
  return preferred && ids.includes(preferred) ? [preferred, ...ids.filter((id) => id !== preferred)] : ids;
}

function modelOptionLabel(model: ModelInfo): string {
  return publishedOutputPrice(model) === undefined ? `${model.fullId} (${PRICE_UNKNOWN_LABEL})` : model.fullId;
}

function modelIdFromOption(option: string): string {
  const suffix = ` (${PRICE_UNKNOWN_LABEL})`;
  return option.endsWith(suffix) ? option.slice(0, -suffix.length) : option;
}

export function modelDisplayOptions(eligible: readonly ModelInfo[], preferred?: string): string[] {
  return modelOptions(eligible, preferred).map((id) => modelOptionLabel(modelByFullId(eligible, id)!));
}

export function thinkingLevelOptions(model: ModelInfo, preferred?: ThinkingLevel): ThinkingLevel[] {
  const supported = getSupportedThinkingLevels(model);
  return preferred && supported.includes(preferred)
    ? [preferred, ...supported.filter((level) => level !== preferred)]
    : supported;
}

export function starterTierModelIds(starter: StarterTierMap, tier: RiskTier, eligible: readonly ModelInfo[]): string[] {
  return uniqueKnownModelIds(starter.tiers[tier] ?? [], eligible);
}

export function defaultTierModelIds(defaults: RoutingPickerDefaults, tier: RiskTier, eligible: readonly ModelInfo[]): string[] {
  return uniqueKnownModelIds(defaultTierRungs(defaults, tier), eligible);
}

export function starterThinkingLevel(starter: StarterTierMap, tier: RiskTier, model: ModelInfo): ThinkingLevel {
  const rung = starter.tiers[tier]?.find((entry) => modelIdFromRung(entry) === model.fullId);
  const fromRung = rung ? thinkingLevelFromRung(rung, model) : undefined;
  const supported = getSupportedThinkingLevels(model);
  if (fromRung && supported.includes(fromRung)) return fromRung;
  return thinkingLevelFromRung(starterRungFor(model, tier)) ?? supported[0] ?? "off";
}

export function defaultThinkingLevel(defaults: RoutingPickerDefaults, tier: RiskTier, model: ModelInfo): ThinkingLevel {
  const rung = defaultTierRungs(defaults, tier).find((entry) => modelIdFromRung(entry) === model.fullId);
  const fromRung = rung ? thinkingLevelFromRung(rung, model) : undefined;
  const supported = getSupportedThinkingLevels(model);
  if (fromRung && supported.includes(fromRung)) return fromRung;
  return starterThinkingLevel(defaults.starter, tier, model);
}

function writtenBand(rung: string, model: ModelInfo): Readonly<{ min: ThinkingLevel; max: ThinkingLevel }> | undefined {
  const colon = rung.lastIndexOf(":");
  if (colon === -1) {
    if (rung !== model.fullId) return undefined;
    const supported = getSupportedThinkingLevels(model).filter((level) => level !== "max");
    const min = supported[0];
    const max = supported.at(-1);
    return min && max ? { min, max } : undefined;
  }
  const ends = rung.slice(colon + 1).split("-");
  if (ends.length !== 2) return undefined;
  const min = THINKING_LEVELS.find((level) => level === ends[0]);
  const max = THINKING_LEVELS.find((level) => level === ends[1]);
  return min && max ? { min, max } : undefined;
}

function customEffortChoice(band: Readonly<{ min: ThinkingLevel; max: ThinkingLevel }>): string {
  return `custom (${band.min}-${band.max})`;
}

function tierEffortChoices(defaults: RoutingPickerDefaults, tier: RiskTier, model: ModelInfo): { choices: string[]; initial: string } {
  const supported = getSupportedThinkingLevels(model);
  const existing = defaultTierRungs(defaults, tier).find((rung) => modelIdFromRung(rung) === model.fullId);
  const dynamic = existing !== undefined && isDynamicRung(existing);
  const refusal = dynamic ? dynamicRungRefusal(model.fullId, model) : undefined;
  const auto = autoEffortBand(model, tier);
  const currentBand = dynamic && refusal === undefined ? writtenBand(existing!, model) : undefined;
  const autoMatches = auto !== undefined && currentBand?.min === auto.min && currentBand.max === auto.max;
  const custom = currentBand && !autoMatches ? customEffortChoice(currentBand) : undefined;
  const choices = [
    ...(custom ? [custom] : []),
    ...(auto ? [AUTO_EFFORT_CHOICE] : []),
    ...supported,
  ];
  const initial = dynamic
    ? refusal === undefined
      ? (autoMatches ? AUTO_EFFORT_CHOICE : custom ?? (auto ? AUTO_EFFORT_CHOICE : fixedEffortLevelAtDynamicTop(existing!, model)))
      : fixedEffortLevelAtDynamicTop(existing!, model)
    : existing
      ? defaultThinkingLevel(defaults, tier, model)
      : auto ? AUTO_EFFORT_CHOICE : defaultThinkingLevel(defaults, tier, model);
  return { choices, initial };
}

function tierEffortRung(model: ModelInfo, tier: RiskTier, choice: string, defaults: RoutingPickerDefaults): string {
  if (choice === AUTO_EFFORT_CHOICE) {
    const band = autoEffortBand(model, tier);
    if (band) return `${model.fullId}:${band.min}-${band.max}`;
  }
  const custom = /^custom \(([^)]+)\)$/.exec(choice)?.[1];
  if (custom) return `${model.fullId}:${custom}`;
  return `${model.fullId}:${choice || defaultThinkingLevel(defaults, tier, model)}`;
}

export function classifierDefault(defaults: RoutingPickerDefaults, eligible: readonly ModelInfo[]): string {
  const existing = defaults.classifier ? modelIdFromRung(defaults.classifier) : undefined;
  if (existing && modelByFullId(eligible, existing)) return existing;
  return modelIdFromRung(defaults.starter.classifier);
}

export function classifierThinkingDefault(defaults: RoutingPickerDefaults, model: ModelInfo): ThinkingLevel {
  const existing = defaults.classifier && modelIdFromRung(defaults.classifier) === model.fullId
    ? thinkingLevelFromRung(defaults.classifier, model)
    : undefined;
  const starter = modelIdFromRung(defaults.starter.classifier) === model.fullId
    ? thinkingLevelFromRung(defaults.starter.classifier, model)
    : undefined;
  const supported = getSupportedThinkingLevels(model);
  if (existing && supported.includes(existing)) return existing;
  if (starter && supported.includes(starter)) return starter;
  return thinkingLevelFromRung(starterRungFor(model, "mechanical")) ?? supported[0] ?? "off";
}

async function askThinkingLevel(ui: PickerUi, title: string, model: ModelInfo, preferred: ThinkingLevel): Promise<ThinkingLevel> {
  const options = thinkingLevelOptions(model, preferred);
  const choice = await ui.select(title, options);
  // Escape keeps the default effort for this exact model and step. This keeps
  // the init flow moving without silently dropping the chosen model.
  return choice && (options as readonly string[]).includes(choice) ? choice as ThinkingLevel : options[0] ?? "off";
}

export function tierThinkingValueConfig(defaults: RoutingPickerDefaults, tier: RiskTier, eligible: readonly ModelInfo[]): CheckboxRowValueConfig {
  const choices: Record<string, readonly string[]> = {};
  const initial: Record<string, string> = {};
  for (const model of eligible) {
    const label = modelOptionLabel(model);
    const config = tierEffortChoices(defaults, tier, model);
    choices[label] = config.choices;
    initial[label] = config.initial;
  }
  return { choices, initial };
}

async function pickTierModelIds(ui: PickerUi, tier: RiskTier, eligible: readonly ModelInfo[], defaultIds: readonly string[]): Promise<string[] | undefined> {
  const hasAuto = eligible.some((model) => autoEffortBand(model, tier) !== undefined);
  const hint = `${TIER_HINTS[tier]} ${TIER_MODEL_USAGE_HINT}${hasAuto ? `\n${AUTO_EFFORT_HINT}` : ""}`;
  const picked = await checkboxSelect(
    ui,
    `${tier} tier models`,
    modelDisplayOptions(eligible),
    defaultIds.map((id) => modelOptionLabel(modelByFullId(eligible, id)!)),
    hint,
    { minSelected: 1 },
  );
  return picked?.map(modelIdFromOption);
}

async function pickTierRungsInline(ui: PickerUi, defaults: RoutingPickerDefaults, tier: RiskTier, eligible: readonly ModelInfo[], defaultIds: readonly string[]): Promise<string[] | undefined> {
  const picked = await checkboxSelectWithValues(
    ui,
    `${tier} tier models`,
    modelDisplayOptions(eligible),
    defaultIds.map((id) => modelOptionLabel(modelByFullId(eligible, id)!)),
    tierThinkingValueConfig(defaults, tier, eligible),
    `${TIER_HINTS[tier]} ${TIER_MODEL_USAGE_HINT} ${THINKING_LEVEL_HINT}${eligible.some((model) => autoEffortBand(model, tier) !== undefined) ? `\n${AUTO_EFFORT_HINT}` : ""}`,
    { minSelected: 1 },
  );
  // Escape at a tier keeps that tier's current picks when they exist, else the
  // starter picks. Changing an unchecked row's thinking level is kept if the row
  // is checked later; left and right do not auto-check rows.
  return picked?.selected.map((option) => {
    const modelId = modelIdFromOption(option);
    const model = modelByFullId(eligible, modelId);
    return model ? tierEffortRung(model, tier, picked.values[option] ?? "off", defaults) : `${modelId}:off`;
  });
}

export async function pickRoutingMap(ui: PickerUi, eligible: readonly ModelInfo[], defaults: RoutingPickerDefaults): Promise<StarterTierMap> {
  ui.notify(ROUTING_PICKER_HINT);
  warnUnavailableDefaults(ui, defaults, eligible);
  ui.notify(CLASSIFIER_MODEL_HINT);
  const classifierModelId = classifierDefault(defaults, eligible);
  const defaultTiers = tierDefaults(defaults, eligible, ui);
  const classifierChoice = await ui.select("Classifier model", modelDisplayOptions(eligible, classifierModelId));
  // Escape at the classifier is the fastest safe escape hatch: keep the full
  // current routing map when one exists, otherwise the starter map.
  if (classifierChoice === undefined) {
    const model = modelByFullId(eligible, classifierModelId);
    return {
      ...defaults.starter,
      tiers: defaultTiers,
      classifier: defaults.classifier ?? (model ? `${model.fullId}:${classifierThinkingDefault(defaults, model)}` : defaults.starter.classifier),
    };
  }
  const classifierChoiceId = modelIdFromOption(classifierChoice);
  const classifierModel = modelByFullId(eligible, classifierChoiceId) ?? modelByFullId(eligible, classifierModelId)!;
  const classifierLevel = await askThinkingLevel(
    ui,
    `Thinking level for classifier ${classifierModel.fullId}. ${CLASSIFIER_THINKING_HINT}`,
    classifierModel,
    classifierThinkingDefault(defaults, classifierModel),
  );
  const tiers: Record<RiskTier, string[]> = { ...defaultTiers };
  for (const tier of RISK_TIERS) {
    const defaultIds = defaultTierModelIds(defaults, tier, eligible);
    if (canUseCustomCheckbox(ui)) {
      const rungs = await pickTierRungsInline(ui, defaults, tier, eligible, defaultIds);
      tiers[tier] = rungs === undefined ? defaultTiers[tier] : rungs;
      continue;
    }
    const picked = await pickTierModelIds(ui, tier, eligible, defaultIds);
    if (picked === undefined) {
      tiers[tier] = defaultTiers[tier];
      continue;
    }
    const rungs: string[] = [];
    for (const modelId of picked) {
      const model = modelByFullId(eligible, modelId);
      if (!model) continue;
      const config = tierEffortChoices(defaults, tier, model);
      const options = config.initial ? [config.initial, ...config.choices.filter((choice) => choice !== config.initial)] : config.choices;
      const hint = `${THINKING_LEVEL_HINT}${options.includes(AUTO_EFFORT_CHOICE) ? ` ${AUTO_EFFORT_HINT}` : ""}`;
      const choice = await ui.select(`Thinking level for ${tier} model ${model.fullId}. ${hint}`, options);
      rungs.push(tierEffortRung(model, tier, choice && options.includes(choice) ? choice : config.initial, defaults));
    }
    tiers[tier] = rungs;
  }
  return { tiers, classifier: `${classifierModel.fullId}:${classifierLevel}`, skipped: defaults.starter.skipped };
}
