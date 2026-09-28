import {
  checkModelScope,
  type ModelScopeCheckRule,
} from "../models/model-scope.ts";
import { lookup, type ModelCatalog } from "../catalog/model-catalog.ts";
import { isProhibitedModel, subagentBanListReason, type BanLists } from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { approvedRecipients, type RecipientAuthorization } from "../recipients/authorization.ts";
import {
  checkRecipient,
  providerOf,
  type BudgetPreflightConstraint,
  type RefusedAlternative,
} from "../recipients/authorized-delegation.ts";
import { RISK_TIERS, type RiskTier } from "./classifier.ts";
import type { RemovalReason } from "./skip-reasons.ts";
import type { ResolvedTierMap, TierRung } from "./tier-map.ts";

// Ticket 24, ADR 0001 and ADR 0012: the router core.
//
//   stage 1  the classified tier's rungs, in map order, through the hard
//            filters. Every removed rung carries its reason and a detail.
//   stage 2  the least-used provider among survivors in balanced order, with
//            list order breaking ties; ordered tiers take the first survivor.
//
// A worker's routing constraints narrow this: a minimum tier raises the tier
// stage 1 starts at, an excluded rung fails stage 1 in every tier, and a
// forced rung (`routeForcedRung`) goes through stage 1 alone, with no stage 2.
//
// All evidence is a plain input, so the router reads no file, no clock and no
// network. The router extension calls `routeTier` (../router/route-task.ts);
// ticket 19's `computeAgentCandidates` consumes the same decision.

export type ProviderUsageState = "out-of-usage" | "throttled";

/** What ticket 08's observations and the usage store say about one provider
 *  right now. A provider with no entry has no known limit, which removes
 *  nothing. */
export interface ProviderUsage {
  readonly state: ProviderUsageState;
  readonly detail?: string;
}

export interface RouterEvidence {
  /** Keyed by provider, as `providerOf` spells it. */
  readonly providerUsage: Readonly<Record<string, ProviderUsage>>;
  /** Pinned delegations in the rolling window, per provider. Unknown providers count as zero. */
  readonly providerCounts?: Readonly<Record<string, number>>;
  /** Read for `contextWindow` only. */
  readonly catalog: ModelCatalog;
  readonly estimatedPromptTokens: number;
  /** Ticket 09's check-only preflight; `NO_BUDGET_CONSTRAINT` states that no
   *  allowance applies. */
  readonly allowance: BudgetPreflightConstraint;
  /** Ticket 07's store of approved data recipients. */
  readonly authorization: RecipientAuthorization;
  /** Defaults to the configured subagent ban list. */
  readonly banLists?: BanLists;
  /** Defaults to ticket 04's `HARNESS_MODEL_SCOPE`. */
  readonly modelScope?: ModelScopeCheckRule;
  /** A rung this worker's routing constraints exclude. Only that model at
   *  that effort is removed, in every tier. */
  readonly excludedRung?: ConstraintRung;
}

/** One model at one effort, as a routing constraint names it. A recorded
 *  rung fits, so a worker's rung can be taken from its decision record. */
export interface ConstraintRung {
  readonly model: string;
  readonly effort: string;
}

/** The rung a worker must run on and the tier it stands for, as the effort
 *  ladder's choice names them. The rung need not be listed: the ladder may
 *  raise a listed model to its next effort. */
export type ForcedRung = Pick<TierRouteChoice, "rung" | "tier">;

/** Per-worker routing constraints, set for one worker before its first
 *  request. They narrow the choice and never bypass the hard filters. A
 *  forced rung replaces the tier choice, so it stands alone. */
export type RoutingConstraints =
  | {
      /** Route at this tier or higher: a lower classified tier is raised to it. */
      readonly minimumTier?: RiskTier;
      /** A rung the worker must not run on. Removed in every tier, so escalation
       *  cannot choose it either. */
      readonly excludedRung?: ConstraintRung;
      readonly forcedRung?: undefined;
    }
  | {
      /** Pinned if it passes the hard filters, else a refusal. */
      readonly forcedRung: ForcedRung;
      readonly minimumTier?: undefined;
      readonly excludedRung?: undefined;
    };

export interface TierRouteInput {
  /** The tier routing starts at: the classifier's tier (ticket 23), or a
   *  minimum tier above it. The router does not classify. */
  readonly tier: RiskTier;
  readonly tierMap: ResolvedTierMap;
  readonly evidence: RouterEvidence;
}

export { REMOVAL_REASONS, type RemovalReason } from "./skip-reasons.ts";

export interface RemovedRung {
  readonly tier: RiskTier;
  readonly rung: string;
  readonly model: string;
  readonly reason: RemovalReason;
  readonly detail: string;
}

export interface TierRouteChoice {
  readonly ok: true;
  readonly refused: false;
  /** The chosen survivor of `tier`. */
  readonly rung: TierRung;
  readonly tierOrder?: "balanced" | "ordered";
  /** Counts behind a balanced choice, for providers that survived the filters. */
  readonly providerCounts?: Readonly<Record<string, number>>;
  readonly model: string;
  /** Every survivor of `tier`, in map order. */
  readonly survivors: readonly TierRung[];
  /** The tier routing started at: the classified tier, or a minimum tier
   *  above it. */
  readonly startedAtTier: RiskTier;
  /** The tier the rung came from: `startedAtTier` or a higher one. */
  readonly tier: RiskTier;
  /** From `startedAtTier` up to `tier`, one step at a time. */
  readonly tiersTried: readonly RiskTier[];
  readonly removed: readonly RemovedRung[];
  readonly allowanceApplied: string;
}

/**
 * Every tier from the one routing started at up to critical emptied, or a
 * forced rung failed a hard filter. The shape is
 * ticket 07's delegation refusal (`AuthorizedDelegationOutcome` with `ok: false`)
 * plus the router's own fields. It carries no model and no rung, so nothing
 * can be written into the call from it.
 */
export interface TierRouteRefusal {
  readonly ok: false;
  readonly refused: true;
  readonly code: "no_authorized_candidate";
  readonly message: string;
  readonly startedAtTier: RiskTier;
  readonly tiersTried: readonly RiskTier[];
  readonly removed: readonly RemovedRung[];
  /** Ticket 07's `{ model, why }` list, one per removed rung. `model` here
   *  carries the rung string `provider/model:effort`, not a bare model id; a
   *  consumer that needs the model reads `removed[].model` instead. */
  readonly consideredAndRefused: readonly RefusedAlternative[];
  readonly approvedRecipients: readonly string[];
  readonly allowanceApplied: string;
}

export type TierRouteDecision = TierRouteChoice | TierRouteRefusal;

/** The context window must hold the estimated prompt plus this share. */
export const CONTEXT_WINDOW_HEADROOM_PERCENT = 5;

function neededTokens(estimated: number): number {
  return estimated + Math.ceil((estimated * CONTEXT_WINDOW_HEADROOM_PERCENT) / 100);
}

interface Removal {
  readonly reason: RemovalReason;
  readonly detail: string;
}

/** The model is matched without case, as the installed registry is; the
 *  effort exactly. */
function isExcluded(rung: ConstraintRung, excluded: ConstraintRung | undefined): boolean {
  return excluded !== undefined && rung.model.toLowerCase() === excluded.model.toLowerCase() && rung.effort === excluded.effort;
}

/** The hard filters see the whole rung, so one effort of a model can be
 *  excluded while its other efforts stay. */
export function failedHardFilter(rung: ConstraintRung, evidence: RouterEvidence): Removal | undefined {
  const { model } = rung;
  if (isProhibitedModel(model, evidence.banLists)) {
    return { reason: "subagent ban list", detail: subagentBanListReason(model, evidence.banLists) };
  }
  const scope = checkModelScope(model, evidence.modelScope ?? HARNESS_MODEL_SCOPE, "explicit");
  if (scope?.severity === "error") return { reason: "allowed-model list", detail: scope.message };

  const provider = providerOf(model);
  const usage = evidence.providerUsage[provider];
  if (usage?.state === "out-of-usage") {
    return { reason: "provider out of usage", detail: `provider '${provider}' is out of usage${usage.detail ? `: ${usage.detail}` : ""}` };
  }
  if (usage?.state === "throttled") {
    return { reason: "provider throttled", detail: `provider '${provider}' is throttled${usage.detail ? `: ${usage.detail}` : ""}` };
  }

  // An unknown window is left alone: not removed, and not moved in the order.
  const window = lookup(evidence.catalog, model)?.contextWindow;
  if (window?.state === "known") {
    const needed = neededTokens(evidence.estimatedPromptTokens);
    if (window.value.contextTokens < needed) {
      return {
        reason: "context window",
        detail:
          `${window.value.contextTokens}-token context window is smaller than the ${needed} tokens needed ` +
          `(${evidence.estimatedPromptTokens} estimated plus ${CONTEXT_WINDOW_HEADROOM_PERCENT}% headroom)`,
      };
    }
  }

  const preflight = evidence.allowance.check(model);
  if (!preflight.ok) {
    return {
      reason: "allowance preflight",
      detail: `${preflight.why ?? "no remaining allowance"} (${evidence.allowance.describe})`,
    };
  }

  const recipient = checkRecipient(provider, evidence.authorization);
  if (!recipient.ok) return { reason: "unapproved recipient", detail: recipient.message };
  if (isExcluded(rung, evidence.excludedRung)) {
    return { reason: "excluded rung", detail: `the worker's routing constraints exclude ${rung.model}:${rung.effort}` };
  }
  return undefined;
}

/** Throws unless the estimate is a non-negative number. `owner` names the
 *  caller in the message: `tier router` or `effort ladder`. */
export function checkEstimatedPromptTokens(owner: string, estimated: number): void {
  if (!Number.isFinite(estimated) || estimated < 0) {
    throw new TypeError(`${owner}: estimatedPromptTokens must be a non-negative number; got ${estimated}.`);
  }
}

/** Ticket 07's `{ model, why }` list for removed rungs; `model` carries the rung. */
export function refusedAlternatives(removed: readonly RemovedRung[]): readonly RefusedAlternative[] {
  return Object.freeze(
    removed.map((entry) => Object.freeze({ model: entry.rung, why: `${entry.tier}: ${entry.reason}: ${entry.detail}` })),
  );
}

/** A forced rung through the hard filters: chosen when it passes them, else
 *  a refusal naming the filter it failed. No other rung is tried. */
export function routeForcedRung(forced: ForcedRung, evidence: RouterEvidence): TierRouteDecision {
  checkEstimatedPromptTokens("tier router", evidence.estimatedPromptTokens);
  const { rung, tier } = forced;
  const tiersTried = Object.freeze([tier]);
  const failed = failedHardFilter(rung, evidence);
  if (failed === undefined) {
    return Object.freeze({
      ok: true, refused: false, rung, model: rung.model, survivors: Object.freeze([rung]), startedAtTier: tier, tier, tiersTried,
      removed: Object.freeze([]), allowanceApplied: evidence.allowance.describe,
    });
  }
  const removed = Object.freeze([Object.freeze({ tier, rung: rung.rung, model: rung.model, ...failed })]);
  return Object.freeze({
    ok: false,
    refused: true,
    code: "no_authorized_candidate",
    message: `pi-orchestration-harness: the forced rung ${rung.rung} (${tier}) fails ${failed.reason}: ${failed.detail}. No other rung was tried.`,
    startedAtTier: tier,
    tiersTried,
    removed,
    consideredAndRefused: refusedAlternatives(removed),
    approvedRecipients: approvedRecipients(evidence.authorization),
    allowanceApplied: evidence.allowance.describe,
  });
}

function refusalMessage(startedAtTier: RiskTier, tiersTried: readonly RiskTier[], removed: readonly RemovedRung[]): string {
  const rungs = removed.map((entry) => `${entry.tier} ${entry.rung} (${entry.reason})`).join("; ");
  return (
    `pi-orchestration-harness: no rung survived the hard filters for a task classified ${startedAtTier}; ` +
    `tiers tried: ${tiersTried.join(", ")}. Removed: ${rungs || "none (every tier tried was empty)"}. ` +
    "No model was chosen and no lower tier was tried; report the blocker or change the evidence or the tier map."
  );
}

/**
 * Stage 1 and stage 2 for the classified tier, moving up one tier while the
 * current one is empty. The loop starts at the classified tier's index and
 * only counts up, so no tier below the classified one is ever read.
 */
export function routeTier(input: TierRouteInput): TierRouteDecision {
  const { evidence } = input;
  checkEstimatedPromptTokens("tier router", evidence.estimatedPromptTokens);
  const removed: RemovedRung[] = [];
  const tiersTried: RiskTier[] = [];
  for (let index = RISK_TIERS.indexOf(input.tier); index < RISK_TIERS.length; index += 1) {
    const tier = RISK_TIERS[index]!;
    tiersTried.push(tier);
    const survivors: TierRung[] = [];
    for (const rung of input.tierMap.tiers[tier]) {
      const failed = failedHardFilter(rung, evidence);
      if (failed === undefined) survivors.push(rung);
      else removed.push(Object.freeze({ tier, rung: rung.rung, model: rung.model, ...failed }));
    }
    const [first] = survivors;
    if (first !== undefined) {
      const tierOrder = input.tierMap.orders[tier];
      const providerCounts: Record<string, number> = {};
      if (tierOrder === "balanced") {
        for (const rung of survivors) {
          const provider = providerOf(rung.model);
          providerCounts[provider] = evidence.providerCounts?.[provider] ?? 0;
        }
      }
      // A future per-provider weight can be added to this score without changing filtering or tier escalation.
      const score = (rung: TierRung) => providerCounts[providerOf(rung.model)] ?? 0;
      const chosen = tierOrder === "ordered" ? first : survivors.reduce((best, rung) => score(rung) < score(best) ? rung : best, first);
      return Object.freeze({
        ok: true,
        refused: false,
        rung: chosen,
        tierOrder,
        ...(tierOrder === "balanced" ? { providerCounts: Object.freeze(providerCounts) } : {}),
        model: chosen.model,
        survivors: Object.freeze(survivors),
        startedAtTier: input.tier,
        tier,
        tiersTried: Object.freeze(tiersTried),
        removed: Object.freeze(removed),
        allowanceApplied: evidence.allowance.describe,
      });
    }
  }
  return Object.freeze({
    ok: false,
    refused: true,
    code: "no_authorized_candidate",
    message: refusalMessage(input.tier, tiersTried, removed),
    startedAtTier: input.tier,
    tiersTried: Object.freeze(tiersTried),
    removed: Object.freeze(removed),
    consideredAndRefused: refusedAlternatives(removed),
    approvedRecipients: approvedRecipients(evidence.authorization),
    allowanceApplied: evidence.allowance.describe,
  });
}
