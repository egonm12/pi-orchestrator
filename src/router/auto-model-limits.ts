import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ModelInfo } from "../models/model-info.ts";
import type { ResolvedTierMap } from "../routing/tier-map.ts";

type ProviderConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;

export interface AutoModelLimits {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/** The largest context window and the largest output limit among the tier
 *  map's rungs, each from pi's registry entry for the rung's model. A limit no
 *  rung's entry declares is left out. pi compacts on the auto model's declared
 *  window, so a smaller one would compact a worker on a large rung too early. */
export function autoModelLimits(tierMap: ResolvedTierMap, installedModels: readonly ModelInfo[]): AutoModelLimits {
  const byId = new Map(installedModels.map((model) => [model.fullId.toLowerCase(), model]));
  let contextWindow: number | undefined;
  let maxTokens: number | undefined;
  for (const rungs of Object.values(tierMap.tiers)) {
    for (const rung of rungs) {
      const model = byId.get(rung.model.toLowerCase());
      if (model?.contextWindow !== undefined) contextWindow = Math.max(contextWindow ?? 0, model.contextWindow);
      if (model?.maxTokens !== undefined) maxTokens = Math.max(maxTokens ?? 0, model.maxTokens);
    }
  }
  return { ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) };
}

/** The auto provider's config with `limits` on its models. The stream function
 *  is kept, so re-registering keeps the session pins. */
export function withAutoModelLimits(config: ProviderConfig, limits: AutoModelLimits): ProviderConfig {
  return { ...config, models: config.models?.map((model) => ({ ...model, ...limits })) };
}
