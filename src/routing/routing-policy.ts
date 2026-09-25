// Ticket 06: which model a task gets, driven by what the task demands rather
// than by how large the diff is.
//
// LEGACY PATH (ticket 24, ADR 0001). This catalog-wide path (`allowedCandidates`,
// `route`, `correctnessFirstPicker`) is not the router. Ticket 24's
// `routeTier` (tier-router.ts) is, and ticket 19's candidate computation and
// ticket 27's extension use it. This file still feeds ticket 07's
// `delegateWithSwitch`, `routeAndResolve` and ticket 11's recovery, and is
// scheduled for retirement when ticket 26 moves bounded recovery onto
// `nextRungAfterFailure` and ticket 27 wires the extension onto the router.
// Ticket 24 removed its numeric suitability floor per tier; the rule that a
// model without fresh evidence for the task type is not admitted remains here
// only.
//
// Structured in two stages because tickets 07, 09 and 19 depend on that shape:
//
//   STAGE 1  allowedCandidates()  -- the BOUNDARY. A deterministic function of
//            (assessment, catalog, config, probes) returning the set of models
//            a task is allowed to reach, with a recorded reason for every
//            admission and every rejection. Ticket 07 narrows this set by
//            approved recipients, ticket 09 by remaining allowance. Both
//            narrow the same set; neither has to move the boundary.
//
//   STAGE 2  a Picker -- the PREFERENCE. Chooses one candidate from a set it
//            receives as a plain input parameter. It cannot widen the set: it
//            has no access to the catalog, the probes or the config, only to
//            what stage 1 already admitted. Ticket 19 swaps this out without
//            touching stage 1.
//
// The ordering the ticket sets is correctness > completion time > cost, and it
// is implemented as a lexicographic order rather than a weighted score, so a
// large cost difference can never outvote a correctness difference.
//
// COMPLETION TIME IS NOT MODELLED, and that is a gap rather than an omission.
// The pinned catalog carries no latency or throughput data, so there is no
// evidence to rank it by. Inventing a proxy -- smaller model is faster, cheaper
// is faster -- would be the same unevidenced inference from a name that the
// cost rule below exists to prevent. The middle term is therefore absent, and
// the picker documents where it would attach.
//
// This module performs no network I/O, runs no benchmark, and makes no model
// call. It reads the local catalog and nothing else.

import {
  describeFact,
  isTrustworthy,
  readFact,
  DEFAULT_FRESHNESS,
  type Evidence,
  type FreshnessPolicy,
} from "../catalog/epistemic.ts";
import {
  lookup,
  type CatalogEntry,
  type ModelCatalog,
  type TokenPrice,
} from "../catalog/model-catalog.ts";
import type { Availability } from "../fixtures/provider-double.ts";
import {
  isProhibitedModel,
  validatedDelegationId,
  type DelegationIdentity,
} from "../policy/model-resolution.ts";
import { subagentBanListReason } from "../policy/ban-lists.ts";
import {
  classifyTask,
  tierRank,
  type RiskAssessment,
  type RiskTier,
} from "./classifier.ts";

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

/**
 * Approved data recipients. Ticket 07 owns discovery and authorization; this
 * is the seam it narrows the candidate set through. Absent means no recipient
 * constraint is applied HERE -- it does not mean every recipient is approved,
 * and routing says so in the decision record rather than implying authorization
 * it has not been given.
 */
export interface PrivacyConstraint {
  readonly approvedRecipients?: readonly string[];
  readonly reason?: string;
}

export interface RoutingPolicyConfig {
  /**
   * Confidence in the RISK CLASSIFICATION below which routing stops trusting
   * the classification and takes the fallback tier instead.
   *
   * This is the reject-option shape the ticket asks to borrow rather than
   * invent: Chow (1957) formalised a classifier that declines to classify when
   * its confidence falls below a threshold, and the LLM cascade-deferral
   * literature applies the same thresholding to route-or-defer decisions. The
   * borrowed part is the mechanism -- threshold, abstain, take the safe
   * branch. The classification itself is ours (classifier.ts).
   */
  readonly confidenceThreshold: number;
  /** The tier taken when confidence falls below the threshold. Configurable,
   *  and deliberately a tier rather than a model, so the fallback narrows the
   *  candidate set by the same rule as any other tier. */
  readonly mostRestrictiveTier: RiskTier;
  readonly freshness: FreshnessPolicy;
}

export const DEFAULT_ROUTING_POLICY: RoutingPolicyConfig = {
  confidenceThreshold: 0.6,
  mostRestrictiveTier: "critical",
  freshness: DEFAULT_FRESHNESS,
};

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export interface RoutingRequest {
  readonly taskDescription: string;
  /** Suitability is per task type, so the catalog is asked about this key
   *  specifically rather than about the model in general. */
  readonly taskType: string;
  readonly privacy?: PrivacyConstraint;
  /**
   * Overrides the classifier. Exists so a caller can route an assessment that
   * was made elsewhere, and so tests can drive the escalation path with an
   * exact confidence instead of hunting for wording that happens to produce
   * one. It is an assessment of the TASK, from the same shape the classifier
   * produces -- there is no path here for a number a model reported about its
   * own answer.
   */
  readonly assessment?: RiskAssessment;
}

// ---------------------------------------------------------------------------
// Stage 1 output
// ---------------------------------------------------------------------------

/** Whether the catalog actually evidences this model for this task type. */
export type SuitabilityEvidence =
  | {
      readonly state: "evidenced";
      readonly score: number;
      readonly evidence: Evidence;
      readonly asOf: string;
    }
  | { readonly state: "unevidenced"; readonly why: string };

/**
 * The basis for calling one candidate cheaper than another.
 *
 * `publishedListPrice` is the upstream list price, which is NOT necessarily
 * what a route bills -- the catalog keeps those apart and so does this. The
 * basis is named in the record so a cost comparison can never be read as a
 * statement about money actually charged.
 */
export type CostEvidence =
  | {
      readonly state: "comparable";
      readonly basis: "published-list-price";
      readonly inputUsdPerMTok: number;
      readonly outputUsdPerMTok: number;
      readonly evidence: Evidence;
      /** What this route actually bills, which is a separate question. */
      readonly billedCost: string;
    }
  | { readonly state: "incomparable"; readonly why: string };

export interface CandidateAssessment {
  readonly model: string;
  readonly provider: string;
  readonly suitability: SuitabilityEvidence;
  readonly cost: CostEvidence;
  /**
   * Rendered through describeFact, never as a raw value. Unknown headroom
   * prints as `unknown (<reason>)`, so a candidate can never carry a number or
   * an "unlimited" that was never established.
   */
  readonly headroom: string;
  readonly headroomKnown: boolean;
}

export interface AdmittedCandidate extends CandidateAssessment {
  readonly admitted: true;
  readonly suitability: Extract<SuitabilityEvidence, { state: "evidenced" }>;
}

export interface RejectedCandidate extends CandidateAssessment {
  readonly admitted: false;
  readonly rejectedBecause: readonly string[];
}

export interface AllowedCandidates {
  readonly taskType: string;
  readonly assessment: RiskAssessment;
  /** Visible in the output, per the ticket. */
  readonly confidenceThreshold: number;
  readonly fallbackTier: RiskTier;
  readonly fallbackTriggered: boolean;
  /** The tier actually applied: the classified tier, or the fallback. */
  readonly effectiveTier: RiskTier;
  readonly admitted: readonly AdmittedCandidate[];
  readonly rejected: readonly RejectedCandidate[];
  readonly privacyApplied: boolean;
  readonly allowanceApplied: string | null;
}

/**
 * The remaining-allowance seam this module's header already promised ticket 09.
 *
 * Structurally the check-only half of ticket 07's `BudgetPreflightConstraint`,
 * which ticket 09's `allowanceConstraint()` fills in, so a caller passes the
 * real shared task allowance here rather than a routing-local copy of it.
 */
export interface AllowancePreflight {
  /** Human-readable identity of the shared allowance being consulted. */
  readonly describe: string;
  check(model: string): { readonly ok: boolean; readonly why?: string };
}

export interface Stage1Input {
  readonly request: RoutingRequest;
  readonly catalog: ModelCatalog;
  readonly config?: RoutingPolicyConfig;
  /** Availability probe. Omitted means availability was not checked here, which
   *  is recorded rather than assumed to be "available". */
  readonly availability?: (model: string) => Availability;
  /**
   * Check-only view of ticket 09's authoritative shared task allowance.
   * Candidate computation uses it to narrow the set; delegation still performs
   * the reserving admission, because a preflight is never a reservation.
   */
  readonly allowance?: AllowancePreflight;
  readonly now?: number;
}

function suitabilityOf(
  entry: CatalogEntry,
  taskType: string,
  policy: FreshnessPolicy,
  now: number,
): SuitabilityEvidence {
  const view = readFact(entry.taskSuitability, policy, now);
  if (view.state === "unknown") {
    return {
      state: "unevidenced",
      why: `catalog has no task-suitability evidence (${view.reason})`,
    };
  }
  if (!isTrustworthy(view)) {
    // Stale evidence is not evidence. It keeps its value in the catalog, but it
    // cannot support a fresh claim that this model is suitable now.
    return {
      state: "unevidenced",
      why: `task-suitability evidence is stale (as of ${view.asOf})`,
    };
  }
  const score = view.value[taskType];
  if (score === undefined) {
    return {
      state: "unevidenced",
      why: `task-suitability evidence covers ${Object.keys(view.value).join(", ") || "nothing"}, not '${taskType}'`,
    };
  }
  return { state: "evidenced", score, evidence: view.evidence, asOf: view.asOf };
}

function costOf(
  entry: CatalogEntry,
  policy: FreshnessPolicy,
  now: number,
): CostEvidence {
  const listed = readFact(entry.publishedListPrice, policy, now);
  const billed = readFact(entry.effectiveBilledCost, policy, now);
  const billedText = describeFact(
    billed,
    (p: TokenPrice) => `$${p.inputUsdPerMTok}/M in, $${p.outputUsdPerMTok}/M out`,
  );
  if (!isTrustworthy(listed)) {
    return {
      state: "incomparable",
      why:
        listed.state === "unknown"
          ? `no published price (${listed.reason})`
          : `published price is stale (as of ${listed.asOf})`,
    };
  }
  return {
    state: "comparable",
    basis: "published-list-price",
    inputUsdPerMTok: listed.value.inputUsdPerMTok,
    outputUsdPerMTok: listed.value.outputUsdPerMTok,
    evidence: listed.evidence,
    billedCost: billedText,
  };
}

/**
 * STAGE 1 -- the boundary. Legacy path: not the router (see the file header).
 *
 * Pure: same inputs, same output. It reads the catalog and the probes it is
 * given, and nothing else.
 */
export function allowedCandidates(input: Stage1Input): AllowedCandidates {
  const config = input.config ?? DEFAULT_ROUTING_POLICY;
  const now = input.now ?? Date.now();
  const { request, catalog } = input;
  const assessment = request.assessment ?? classifyTask(request.taskDescription);

  // The reject-option step. Below the threshold the classification is not
  // trusted and the fallback tier is applied instead. This depends only on
  // confidence in the risk classification: there is no quality prediction in
  // this function, so nothing else can suppress or trigger it.
  const fallbackTriggered = assessment.confidence < config.confidenceThreshold;
  const effectiveTier: RiskTier = fallbackTriggered
    ? config.mostRestrictiveTier
    : assessment.riskTier;

  const approved = request.privacy?.approvedRecipients;

  const admitted: AdmittedCandidate[] = [];
  const rejected: RejectedCandidate[] = [];

  for (const model of Object.keys(catalog.entries)) {
    const entry = lookup(catalog, model);
    if (!entry) continue;

    const suitability = suitabilityOf(entry, request.taskType, config.freshness, now);
    const cost = costOf(entry, config.freshness, now);
    const headroomView = readFact(entry.usageHeadroom, config.freshness, now);
    const headroom = describeFact(headroomView, (h) =>
      h.kind === "metered"
        ? `$${h.remainingUsd} remaining`
        : `${h.remaining} requests remaining`,
    );
    const headroomKnown = isTrustworthy(headroomView);
    const base: CandidateAssessment = {
      model,
      provider: entry.provider,
      suitability,
      cost,
      headroom,
      headroomKnown,
    };

    const reasons: string[] = [];

    if (isProhibitedModel(model)) {
      reasons.push(subagentBanListReason(model));
    }

    // Privacy. A candidate outside the approved recipients is out, regardless
    // of how suitable it is.
    if (approved && !approved.includes(entry.provider)) {
      reasons.push(
        `provider '${entry.provider}' is not an approved data recipient` +
          (request.privacy?.reason ? ` (${request.privacy.reason})` : ""),
      );
    }

    // Capability evidence for THIS task type. A model with no evidence is not
    // admitted at any tier on this legacy path. Ticket 24 removed the numeric
    // floor per tier (ADR 0001); the tier now only steers the picker.
    if (suitability.state !== "evidenced") {
      reasons.push(suitability.why);
    }

    // Usage headroom. Only a KNOWN exhausted headroom rejects. An unknown one
    // does not reject and does not admit on the strength of capacity nobody
    // established -- it is carried into the record as unknown so a reader sees
    // that the question is open. Ticket 09 is where remaining allowance
    // actually narrows this set.
    if (headroomKnown) {
      const value = headroomView.value;
      const exhausted =
        value.kind === "metered" ? value.remainingUsd <= 0 : value.remaining <= 0;
      if (exhausted) reasons.push(`usage headroom is exhausted (${headroom})`);
    }

    // Availability.
    if (input.availability) {
      const probe = input.availability(model);
      if (probe.status !== "available") {
        reasons.push(
          `not available (${probe.status}${probe.detail ? `: ${probe.detail}` : ""})`,
        );
      }
    }

    // Remaining shared task allowance. Observation only: ticket 09's reserving
    // admission (`admitDelegation`) stays the delegation-time authority, because a
    // preflight that passed is not a reservation and two candidates can both
    // pass the same check before either has held anything.
    if (input.allowance) {
      const verdict = input.allowance.check(model);
      if (!verdict.ok) {
        reasons.push(
          `shared task allowance rejected this candidate: ${verdict.why ?? "no remaining allowance"}`,
        );
      }
    }

    if (reasons.length > 0) {
      rejected.push({ ...base, admitted: false, rejectedBecause: reasons });
    } else if (suitability.state === "evidenced") {
      admitted.push({ ...base, admitted: true, suitability });
    }
  }

  return {
    taskType: request.taskType,
    assessment,
    confidenceThreshold: config.confidenceThreshold,
    fallbackTier: config.mostRestrictiveTier,
    fallbackTriggered,
    effectiveTier,
    admitted,
    rejected,
    privacyApplied: approved !== undefined,
    allowanceApplied: input.allowance?.describe ?? null,
  };
}

// ---------------------------------------------------------------------------
// Stage 2 -- the preference
// ---------------------------------------------------------------------------

export interface Pick {
  readonly model: string;
  readonly reason: string;
  /** True only when cost actually decided the choice, which the rules below
   *  permit only among candidates that have fresh suitability evidence for
   *  the task type. Since ticket 24 the score itself is no longer checked
   *  against a floor, so any fresh score qualifies. */
  readonly cheapenedOnCostEvidence: boolean;
}

/**
 * Stage 2 receives stage 1's output as a plain value and returns a choice from
 * within it. It is given no catalog, no probes and no config, so a picker
 * cannot admit anything stage 1 rejected. Ticket 19 replaces this function.
 */
export type Picker = (allowed: AllowedCandidates) => Pick | undefined;

function cheaper(a: AdmittedCandidate, b: AdmittedCandidate): number {
  const ax = a.cost.state === "comparable" ? a.cost.inputUsdPerMTok : Number.POSITIVE_INFINITY;
  const bx = b.cost.state === "comparable" ? b.cost.inputUsdPerMTok : Number.POSITIVE_INFINITY;
  return ax - bx;
}

/**
 * The default picker: correctness first, then completion time, then cost.
 * Legacy path: not the router (see the file header).
 *
 * Correctness first means evidenced suitability decides, except at a tier
 * whose work is mechanical -- there, every admitted candidate has fresh
 * suitability evidence for this task type, so the ordering's later terms are
 * free to decide and cost picks the cheapest. Since ticket 24 the score is no
 * longer checked against a per-tier floor, so "has fresh evidence" is all
 * admission establishes; it does not say the score is high. That is the ticket's "mechanical work may go to a
 * cheaper model, but only when that model is suitable for the task type and
 * the cheaper designation is supported by evidence".
 *
 * Completion time would be consulted between those two terms. The catalog
 * carries no latency evidence, so there is nothing to consult and the term is
 * skipped rather than approximated.
 */
export const correctnessFirstPicker: Picker = (allowed) => {
  if (allowed.admitted.length === 0) return undefined;

  const mechanical = allowed.effectiveTier === "mechanical";
  const comparable = allowed.admitted.filter((c) => c.cost.state === "comparable");

  if (mechanical && comparable.length > 0) {
    const chosen = [...comparable].sort(
      (a, b) =>
        cheaper(a, b) ||
        b.suitability.score - a.suitability.score ||
        a.model.localeCompare(b.model),
    )[0];
    if (!chosen) return undefined;
    return {
      model: chosen.model,
      reason:
        `mechanical work; every candidate has fresh suitability evidence for '${allowed.taskType}' ` +
        `(this one at ${chosen.suitability.score}, evidence ${chosen.suitability.evidence}; ` +
        `the score is no longer checked against a floor since ticket 24), ` +
        `so cost decided on published list price`,
      cheapenedOnCostEvidence: true,
    };
  }

  const chosen = [...allowed.admitted].sort(
    (a, b) =>
      b.suitability.score - a.suitability.score ||
      cheaper(a, b) ||
      a.model.localeCompare(b.model),
  )[0];
  if (!chosen) return undefined;
  return {
    model: chosen.model,
    reason:
      `${allowed.effectiveTier} work; chose the highest evidenced suitability for ` +
      `'${allowed.taskType}' (${chosen.suitability.score}, evidence ${chosen.suitability.evidence})` +
      (mechanical ? "; no comparable cost evidence, so cost did not decide" : ""),
    cheapenedOnCostEvidence: false,
  };
};

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface RoutedDecision {
  readonly ok: true;
  readonly model: string;
  readonly reason: string;
  readonly cheapenedOnCostEvidence: boolean;
  readonly allowed: AllowedCandidates;
}

export interface RoutingBlocker {
  readonly ok: false;
  readonly code: "no_authorized_candidate";
  readonly message: string;
  readonly allowed: AllowedCandidates;
}

export type RoutingDecision = RoutedDecision | RoutingBlocker;

/**
 * Whether a pick is inside the set stage 1 computed.
 *
 * Stage 2 is handed the set as a plain value, so it has nothing to widen it
 * WITH -- but a picker can still fabricate a model id, and TypeScript's return
 * type is not an authorization boundary. Exported so the delegation boundary
 * (ticket 07) and the agent selection seam (ticket 19) answer this question
 * from one definition rather than two.
 */
export function isAdmittedCandidate(allowed: AllowedCandidates, model: string): boolean {
  return allowed.admitted.some((candidate) => candidate.model === model);
}

/** Stage 1 then stage 2. Legacy path: not the router (see the file header). */
export function route(
  input: Stage1Input,
  picker: Picker = correctnessFirstPicker,
): RoutingDecision {
  const allowed = allowedCandidates(input);
  const pick = picker(allowed);
  if (pick && isProhibitedModel(pick.model)) {
    return {
      ok: false,
      code: "no_authorized_candidate",
      message: `pi-orchestration-harness: picker returned prohibited model '${pick.model}'.`,
      allowed,
    };
  }
  if (!pick) {
    // No weakening. The requirement is not lowered until something fits; the
    // blocker carries every rejection reason so the gap is explainable.
    return {
      ok: false,
      code: "no_authorized_candidate",
      message:
        `pi-orchestration-harness: no authorized model satisfies '${input.request.taskType}' ` +
        `at the ${allowed.effectiveTier} tier` +
        `${allowed.fallbackTriggered ? ` (reached by conservative fallback because classifier confidence ${allowed.assessment.confidence} < ${allowed.confidenceThreshold})` : ""}. ` +
        `${allowed.rejected.length} candidate(s) were considered and none qualified. ` +
        "Requirements were not weakened to find an assignment; report the blocker or authorize a suitable model.",
      allowed,
    };
  }
  return {
    ok: true,
    model: pick.model,
    reason: pick.reason,
    cheapenedOnCostEvidence: pick.cheapenedOnCostEvidence,
    allowed,
  };
}

export const ROUTING_RECORD_PREFIX = "ROUTING=";

/** Observable output, matching ticket 04's JSONL convention. Carries the
 *  threshold, the computed confidence and whether the fallback fired, so the
 *  escalation is visible without reading internals. */
export function formatRoutingRecord(
  decision: RoutingDecision,
  identity?: DelegationIdentity,
): string {
  const { allowed } = decision;
  const delegationId = validatedDelegationId(identity);
  const summary = {
    ...(delegationId === undefined ? {} : { delegationId }),
    ok: decision.ok,
    model: decision.ok ? decision.model : null,
    code: decision.ok ? null : decision.code,
    taskType: allowed.taskType,
    riskTier: allowed.assessment.riskTier,
    effectiveTier: allowed.effectiveTier,
    ambiguity: allowed.assessment.ambiguity,
    confidence: allowed.assessment.confidence,
    confidenceThreshold: allowed.confidenceThreshold,
    fallbackTier: allowed.fallbackTier,
    fallbackTriggered: allowed.fallbackTriggered,
    allowanceApplied: allowed.allowanceApplied,
    classifierBasis: allowed.assessment.classifierBasis,
    admitted: allowed.admitted.map((c) => c.model),
    rejected: allowed.rejected.map((c) => ({ model: c.model, why: c.rejectedBecause })),
    reason: decision.ok ? decision.reason : decision.message,
  };
  return `${ROUTING_RECORD_PREFIX}${JSON.stringify(summary)}`;
}
