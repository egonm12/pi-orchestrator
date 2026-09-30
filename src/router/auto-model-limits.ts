import type { ModelInfo } from "../models/model-info.ts";
import type { ResolvedTierMap } from "../routing/tier-map.ts";

export interface AutoModelLimits {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/** The largest context window and the largest output limit among the tier
 *  map's rungs, each from pi's registry entry for the rung's model. A limit no
 *  rung's entry declares is left out. pi shows the auto model's declared limits
 *  until a rung has answered; after that, and when it compacts, it uses the
 *  limits of the physical model a request is routed to (ADR 0014). */
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
