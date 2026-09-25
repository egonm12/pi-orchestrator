import { getSupportedThinkingLevels, type ModelInfo } from "../subagents/model-info.ts";
import { RISK_TIERS, type RiskTier } from "./classifier.ts";
import type { ResolvedTierMap, TierRung } from "./tier-map.ts";
import { MAX_NOT_LISTED, type LadderSkipReason } from "./skip-reasons.ts";
import { checkEstimatedPromptTokens, failedHardFilter, refusedAlternatives, routeTier, type RouterEvidence, type RemovedRung, type TierRouteChoice, type TierRouteRefusal } from "./tier-router.ts";

export interface FailedDecision {
  readonly delegationId: string;
  readonly tier: RiskTier;
  readonly rung: TierRung;
}
export interface EffortLadderInput {
  readonly failed: FailedDecision;
  readonly tierMap: ResolvedTierMap;
  readonly installedModels: readonly ModelInfo[];
  readonly evidence: RouterEvidence;
}
export type LadderStep = "effort" | "same-tier" | "next-tier";
export type LadderSkippedRung = Omit<RemovedRung, "reason"> & { readonly reason: LadderSkipReason };
export type LadderChoice = TierRouteChoice & { readonly step: LadderStep; readonly skipped: readonly LadderSkippedRung[] };
export type LadderDecision = LadderChoice | (TierRouteRefusal & { readonly step: "blocker"; readonly skipped: readonly LadderSkippedRung[] });

/** Pure retry routing. The installed registry supplies capabilities; every
 * candidate uses ticket 24's single hard-filter implementation. */
export function nextRungAfterFailure(input: EffortLadderInput): LadderDecision {
  const { failed, tierMap, evidence } = input;
  checkEstimatedPromptTokens("effort ladder", evidence.estimatedPromptTokens);
  const removed: RemovedRung[] = [];
  const skipped: LadderSkippedRung[] = [];
  const installed = input.installedModels.find((model) => model.fullId === failed.rung.model);
  const levels = installed === undefined ? [] : getSupportedThinkingLevels(installed);
  const current = levels.indexOf(failed.rung.effort);
  const listed = tierMap.tiers[failed.tier];
  let index = listed.findIndex((rung) => rung.rung === failed.rung.rung);
  // Generated efforts retain the position of the latest listed effort they
  // climbed from. No earlier listed rung is retried.
  if (index < 0) {
    for (let position = 0; position < listed.length; position++) {
      const rung = listed[position]!;
      if (rung.model === failed.rung.model && levels.indexOf(rung.effort) <= current) index = position;
    }
  }
  if (index < 0) throw new Error("effort ladder: failed rung has no position in the resolved tier map.");
  const next = current < 0 ? undefined : levels[current + 1];
  const maxListed = RISK_TIERS.some((tier) => tierMap.tiers[tier].some((rung) => rung.model === failed.rung.model && rung.effort === "max"));
  if (next === "max" && !maxListed) skipped.push({ tier: failed.tier, rung: `${failed.rung.model}:max`, model: failed.rung.model, reason: MAX_NOT_LISTED, detail: "max requires an explicitly listed rung for this model in the resolved tier map" });
  if (next !== undefined && (next !== "max" || maxListed)) {
    const rung: TierRung = { ...failed.rung, effort: next, rung: `${failed.rung.model}:${next}` };
    const removal = failedHardFilter(rung, evidence);
    if (removal === undefined) return { ok: true, refused: false, step: "effort", rung, model: rung.model, survivors: [rung], startedAtTier: failed.tier, tier: failed.tier, tiersTried: [failed.tier], removed, skipped, allowanceApplied: evidence.allowance.describe };
    removed.push({ tier: failed.tier, rung: rung.rung, model: rung.model, ...removal });
    skipped.push(removed[removed.length - 1]!);
  }
  const remaining = { ...tierMap, tiers: { ...tierMap.tiers, [failed.tier]: listed.slice(index + 1) } };
  const route = routeTier({ tier: failed.tier, tierMap: remaining, evidence });
  const allRemoved = [...removed, ...route.removed];
  skipped.push(...route.removed);
  if (route.ok) return { ...route, removed: allRemoved, skipped, step: route.tier === failed.tier ? "same-tier" : "next-tier" };
  return { ...route, step: "blocker", skipped, removed: allRemoved,
    message: `pi-orchestration-harness: effort ladder exhausted after ${failed.rung.rung}; tiers tried: ${route.tiersTried.join(", ")}. Removed: ${allRemoved.map((entry) => `${entry.rung} (${entry.reason}: ${entry.detail})`).join("; ") || "none"}.`,
    consideredAndRefused: refusedAlternatives(allRemoved),
  };
}
