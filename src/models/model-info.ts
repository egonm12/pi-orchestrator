// Model facts from pi's model registry and the thinking levels a model
// supports, as the tier map, tier router, classifier, ban lists and init read
// them. model-info.test.ts pins the behaviour.

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type ThinkingLevelMap = Partial<Record<ThinkingLevel, string | null>>;

/** pi-ai's `ModelCost`, as far as this package reads it. */
export interface ModelCost {
  input: number;
  output: number;
  tiers?: object[];
}

export interface ModelInfo {
  provider: string;
  id: string;
  fullId: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
  contextWindow?: number;
  maxTokens?: number;
  input?: string[];
  cost?: ModelCost;
}

export interface RegistryModelLike {
  provider: string;
  id: string;
  api?: string;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap | Partial<Record<string, string | null>>;
  contextWindow?: number;
  maxTokens?: number;
  input?: readonly string[];
  cost?: { input: number; output: number; tiers?: readonly object[] };
}

const positiveFinite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

export function toModelInfo(model: RegistryModelLike): ModelInfo {
  const cost = model.cost;
  return {
    provider: model.provider,
    id: model.id,
    fullId: `${model.provider}/${model.id}`,
    api: model.api,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap as ThinkingLevelMap | undefined,
    ...(positiveFinite(model.contextWindow) ? { contextWindow: model.contextWindow } : {}),
    ...(positiveFinite(model.maxTokens) ? { maxTokens: model.maxTokens } : {}),
    ...(Array.isArray(model.input) && model.input.length > 0 ? { input: [...model.input] } : {}),
    ...(cost && Number.isFinite(cost.input) && Number.isFinite(cost.output)
      ? { cost: { ...cost, ...(cost.tiers ? { tiers: cost.tiers.map((tier) => ({ ...tier })) } : {}) } as ModelCost }
      : {}),
  };
}

/** Split a trailing `:<thinking level>` off a model string. Only the seven
 *  known levels count as a suffix; anything else stays part of the model. */
export function splitKnownThinkingSuffix(model: string): { baseModel: string; thinkingSuffix: string } {
  const colonIdx = model.lastIndexOf(":");
  if (colonIdx === -1) return { baseModel: model, thinkingSuffix: "" };
  const suffix = THINKING_LEVELS.find((level) => level === model.substring(colonIdx + 1));
  if (!suffix) return { baseModel: model, thinkingSuffix: "" };
  return { baseModel: model.substring(0, colonIdx), thinkingSuffix: `:${suffix}` };
}

export function getSupportedThinkingLevels(model: ModelInfo | undefined): ThinkingLevel[] {
  if (!model) return THINKING_LEVELS.filter((level) => level !== "max");
  if (model.reasoning === false) return ["off"];
  if (!model.thinkingLevelMap) return THINKING_LEVELS.filter((level) => level !== "max");
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}
