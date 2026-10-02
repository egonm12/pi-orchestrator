// The four tiers: the level of care a task demands (CONTEXT.md, Tier). Only
// the classifier model chooses a task's tier (ADR 0015, ./tier-classifier.ts);
// this module holds the vocabulary and its order, and nothing that judges a
// task.

export type RiskTier = "mechanical" | "standard" | "elevated" | "critical";

/** Ascending. Index is the rank, so a higher index is a more demanding tier. */
export const RISK_TIERS: readonly RiskTier[] = [
  "mechanical",
  "standard",
  "elevated",
  "critical",
] as const;

export function tierRank(tier: RiskTier): number {
  return RISK_TIERS.indexOf(tier);
}

export function isAtLeastTier(tier: RiskTier, floor: RiskTier): boolean {
  return tierRank(tier) >= tierRank(floor);
}
