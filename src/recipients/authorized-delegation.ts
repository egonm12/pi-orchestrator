// Ticket 07: the delegation boundary, and the reported pre-delegation switch.
//
// Composition, not reimplementation. Three existing layers stay where they are:
//
//   ticket 06 stage 1  allowedCandidates()  -- the candidate boundary. This
//       module narrows it through the `PrivacyConstraint` seam stage 1 already
//       exposes, rather than adding a second boundary next to it.
//   ticket 06 stage 2  Picker               -- the preference. The switch below
//       asks the SAME picker for its next preference instead of inventing a
//       second ordering, so there is one place that decides what "better" means.
//   ticket 04 resolveDelegationModel()        -- identity and the prohibition.
//       Still the single enforcement point for the subagent ban list and for
//       explicit provider/model identity.
//
// What this module adds is the recipient gate and the switch.
//
// WHY THE SWITCH LIVES HERE AND NOT IN TICKET 04
// ticket 04's resolver reports an unavailable model as itself and never
// substitutes -- that is the failure mode it was built to design out. So the
// decision to use a different model cannot be hidden inside it. It belongs in
// a layer that makes the substitution an explicit, reported event, which is
// what `delegateWithSwitch` is. A switch is a decision with a record, never a
// silent retry on another model.
//
// No network I/O, no model call. Availability comes from an injected probe
// (harness/fixtures/provider-double.ts in tests).

import { appendFileSync } from "node:fs";
import {
  resolveDelegationModel,
  validatedDelegationId,
  type DelegationIdentity,
  type DelegationDecision,
  type ResolvedDelegation,
} from "../policy/model-resolution.ts";
import type { Availability } from "../fixtures/provider-double.ts";
import {
  route,
  correctnessFirstPicker,
  isAdmittedCandidate,
  type AllowedCandidates,
  type Picker,
  type PrivacyConstraint,
  type RoutedDecision,
  type RoutingDecision,
  type Stage1Input,
} from "../routing/routing-policy.ts";
import {
  approvedRecipients,
  isAuthorizedRecipient,
  recipientApproval,
  type AuthorizedRecipient,
  type RecipientAuthorization,
} from "./authorization.ts";

// ---------------------------------------------------------------------------
// Budget: preflight is observation; delegation admission is reservation
// ---------------------------------------------------------------------------

export interface BudgetVerdict {
  readonly ok: boolean;
  readonly why?: string;
}

/** A check-only view for UI/reporting. Passing this verdict does not admit a delegation. */
export interface BudgetPreflightConstraint {
  readonly describe: string;
  check(model: string): BudgetVerdict;
}

export interface BudgetReconciliation {
  readonly reportedUsd?: number;
  readonly now?: Date;
}

/**
 * The capability returned by a successful reserving admission. Its methods
 * close over the authoritative owner and reservation id, so callers do not
 * choose which hold to release or reconcile after a failed or completed call.
 */
export interface DelegationReservationBinding {
  readonly kind: "reservation";
  readonly reservationId: string;
  readonly model: string;
  /** The exact reservation record already registered in the owner's open ledger. */
  readonly reservation: {
    readonly reservationId: string;
    readonly model: string;
  };
  release(): void;
  reconcile(input: BudgetReconciliation): void;
}

export type BudgetAdmission =
  | DelegationReservationBinding
  | { readonly kind: "no-budget-constraint" };

export type BudgetAdmissionVerdict =
  | { readonly ok: true; readonly admission: BudgetAdmission }
  | { readonly ok: false; readonly why?: string };

/**
 * A delegation-capable spending constraint composes a check-only preflight with
 * an explicitly named admission operation. `delegateNamedModel` uses only
 * `admitDelegation`; a caller cannot pass a preflight-only constraint and have a
 * successful check mistaken for a reservation.
 *
 * A stable `delegationKey` makes duplicate delivery fail closed while its first
 * hold is live. Callers must release that binding if the provider never starts,
 * or reconcile it when the provider did run, before retrying.
 */
export interface BudgetConstraint extends BudgetPreflightConstraint {
  admitDelegation(model: string, delegationKey?: string): BudgetAdmissionVerdict;
}

/** The absence of a constraint, stated rather than implied. Recorded in the
 *  switch report so "no budget was applied" is visible instead of reading as
 *  "the budget approved it". */
export const NO_BUDGET_CONSTRAINT: BudgetConstraint = {
  describe: "no spending constraint applied (ticket 09 owns allowance accounting)",
  check: () => ({ ok: true }),
  admitDelegation: () => ({ ok: true, admission: { kind: "no-budget-constraint" } }),
};

// ---------------------------------------------------------------------------
// The recipient gate
// ---------------------------------------------------------------------------

export type RecipientCheck =
  | { readonly ok: true; readonly provider: string; readonly approval: AuthorizedRecipient }
  | { readonly ok: false; readonly provider: string; readonly message: string };

export function providerOf(model: string): string {
  const slash = model.indexOf("/");
  return slash > 0 ? model.slice(0, slash) : "";
}

/**
 * May data go to this provider? Discovery does not answer this question, and
 * neither does the catalog: only the authorization store does.
 */
export function checkRecipient(
  provider: string,
  authorization: RecipientAuthorization,
): RecipientCheck {
  const approval = recipientApproval(authorization, provider);
  if (!approval) {
    const approved = approvedRecipients(authorization);
    return {
      ok: false,
      provider,
      message:
        `pi-orchestration-harness: '${provider}' is not an approved data ` +
        "recipient, so no delegation was sent to it. Being present in the " +
        "catalog or the installed registry establishes only that it exists. " +
        `Approved recipients: ${approved.length > 0 ? approved.join(", ") : "none"}. ` +
        "Adding one requires explicit owner approval via grantOwnerApproval.",
    };
  }
  return { ok: true, provider, approval };
}

// ---------------------------------------------------------------------------
// Direct delegation of an already-chosen model
// ---------------------------------------------------------------------------

export type DirectDelegationOutcome =
  | {
      readonly ok: true;
      readonly delegation: ResolvedDelegation;
      readonly approval: AuthorizedRecipient;
      /** The admission that made this delegation acceptable. */
      readonly budgetAdmission: BudgetAdmission;
    }
  | {
      readonly ok: false;
      readonly code: "unauthorized_recipient" | "resolver_rejected" | "over_budget";
      readonly message: string;
      readonly delegation?: DelegationDecision;
    };

/**
 * The narrow gate: a model is already chosen, may it be delegated?
 *
 * Deliberately independent of routing, because "a delegate to an unapproved
 * recipient does not execute" has to hold for any caller, not only for one
 * that came through stage 1. Routing narrowing its candidate set is the first
 * line; this is the boundary that still refuses if routing is bypassed.
 *
 * Order matters: ticket 04's resolver runs FIRST, so a prohibited model is
 * rejected as prohibited even if its provider happens to be approved. The
 * prohibition is not a recipient question.
 */
export function delegateNamedModel(input: {
  readonly model?: string;
  readonly authorization: RecipientAuthorization;
  readonly budget?: BudgetConstraint;
  /** Stable identity for retry/deduplication within one task allowance owner. */
  readonly delegationKey?: string;
  readonly availability?: (baseModel: string) => Availability;
}): DirectDelegationOutcome {
  const delegation = resolveDelegationModel({
    model: input.model,
    source: "explicit",
    ...(input.availability ? { availability: input.availability } : {}),
  });
  if (!delegation.ok) {
    return { ok: false, code: "resolver_rejected", message: delegation.message, delegation };
  }

  const recipient = checkRecipient(delegation.provider, input.authorization);
  if (!recipient.ok) {
    return { ok: false, code: "unauthorized_recipient", message: recipient.message, delegation };
  }

  const budget = input.budget ?? NO_BUDGET_CONSTRAINT;
  const admission = budget.admitDelegation(delegation.baseModel, input.delegationKey);
  if (!admission.ok) {
    return {
      ok: false,
      code: "over_budget",
      message:
        `pi-orchestration-harness: delegate to '${delegation.baseModel}' was not sent. ` +
        `${admission.why ?? "the spending constraint refused admission"} (${budget.describe}).`,
      delegation,
    };
  }

  return {
    ok: true,
    delegation,
    approval: recipient.approval,
    budgetAdmission: admission.admission,
  };
}

// ---------------------------------------------------------------------------
// Privacy constraint derived from the authorization store
// ---------------------------------------------------------------------------

/**
 * Build ticket 06's `PrivacyConstraint` from the authorization store.
 *
 * A caller-supplied constraint can only NARROW the result, never widen it:
 * the two lists are intersected. This follows the spec's own rule that project
 * configuration may strengthen restrictions but not relax them -- a caller
 * passing a longer recipient list must not be able to authorize a provider the
 * owner never approved.
 */
export function privacyConstraintFor(
  authorization: RecipientAuthorization,
  callerPrivacy?: PrivacyConstraint,
): PrivacyConstraint {
  const approved = approvedRecipients(authorization);
  const callerList = callerPrivacy?.approvedRecipients;
  const effective =
    callerList === undefined ? approved : approved.filter((p) => callerList.includes(p));
  const reasons = ["approved data recipients only"];
  if (callerList !== undefined) reasons.push("intersected with the caller's narrower list");
  if (callerPrivacy?.reason) reasons.push(callerPrivacy.reason);
  return {
    approvedRecipients: Object.freeze(effective),
    reason: reasons.join("; "),
  };
}

// ---------------------------------------------------------------------------
// The reported pre-delegation switch
// ---------------------------------------------------------------------------

export interface RefusedAlternative {
  readonly model: string;
  readonly why: string;
}

export interface SwitchReport {
  readonly from: string;
  readonly to: string;
  readonly reason: string;
  /** Every alternative considered and turned down, with why. A switch that
   *  skipped a capability-suitable model because it was an unapproved
   *  recipient says so here. */
  readonly consideredAndRefused: readonly RefusedAlternative[];
  /** The constraints the replacement had to satisfy, named so the record shows
   *  they were applied rather than asserting it. */
  readonly recipientConstraint: readonly string[];
  readonly budgetApplied: string;
  readonly capabilityBasis: string;
}

export type AuthorizedDelegationFailureCode =
  | "no_authorized_candidate"
  | "selector_error"
  | "unauthorized_recipient"
  | "over_budget"
  | "resolver_rejected"
  | "no_authorized_alternative";

export type AuthorizedDelegationOutcome =
  | {
      readonly ok: true;
      readonly model: string;
      readonly provider: string;
      readonly delegation: ResolvedDelegation;
      readonly routing: RoutingDecision;
      /** Present only when the first choice was replaced. */
      readonly switched?: SwitchReport;
      readonly approvedRecipients: readonly string[];
      readonly budgetApplied: string;
      /** The reservation/no-budget admission bound to the accepted delegation. */
      readonly budgetAdmission: BudgetAdmission;
    }
  | {
      readonly ok: false;
      readonly code: AuthorizedDelegationFailureCode;
      readonly message: string;
      readonly routing?: RoutingDecision;
      readonly delegation?: DelegationDecision;
      readonly consideredAndRefused?: readonly RefusedAlternative[];
      readonly approvedRecipients: readonly string[];
    };

export interface AuthorizedDelegationInput {
  readonly stage1: Stage1Input;
  readonly authorization: RecipientAuthorization;
  readonly picker?: Picker;
  readonly budget?: BudgetConstraint;
  /** Stable across a delivery retry or pre-start provider switch. */
  readonly delegationKey?: string;
  /**
   * Availability AT DELEGATION TIME, which is a different question from
   * `stage1.availability` (the boundary's view when the candidate set was
   * computed). Capacity exhausted between planning and delegate is exactly the
   * case the switch exists for.
   */
  readonly delegationAvailability?: (baseModel: string) => Availability;
}

/** Stage 1's output with some candidates removed. Used to ask the picker for
 *  its NEXT preference without reimplementing the ordering. */
function withoutModels(
  allowed: AllowedCandidates,
  exclude: ReadonlySet<string>,
): AllowedCandidates {
  return { ...allowed, admitted: allowed.admitted.filter((c) => !exclude.has(c.model)) };
}

function describeUnusable(decision: DelegationDecision): string {
  return decision.ok ? "resolved" : `${decision.code}: ${decision.message}`;
}

/**
 * Refuse a pick stage 1 never admitted, and say so as a selector error.
 *
 * Deliberately runs AFTER `delegateNamedModel` rather than before it, so the
 * existing precedence is untouched: a prohibited model is still reported as
 * prohibited by ticket 04's resolver, and an unapproved recipient still as
 * unauthorized by the recipient gate. What is left for this check is the case
 * neither of those gates can see -- a picker returning an approved, resolvable
 * model that stage 1 rejected on capability, headroom or availability grounds.
 * Without it, a picker could widen the capability ceiling even though it cannot
 * widen the recipient list.
 *
 * The admission that was just taken is released, because the delegation it was
 * held for is not going to happen.
 */
function outOfSetRefusal(
  routing: RoutedDecision,
  accepted: Extract<DirectDelegationOutcome, { readonly ok: true }>,
  approved: readonly string[],
): AuthorizedDelegationOutcome | undefined {
  const model = accepted.delegation.baseModel;
  if (isAdmittedCandidate(routing.allowed, model)) return undefined;
  if (accepted.budgetAdmission.kind === "reservation") accepted.budgetAdmission.release();
  return {
    ok: false,
    code: "selector_error",
    message:
      `pi-orchestration-harness: the picker returned '${model}', which the ` +
      `rules-computed candidate set does not contain. The choice was discarded ` +
      `and any spending hold taken for it released. The candidate set was not ` +
      `widened to accommodate it: a picker decides preference, never permission. ` +
      `Admitted candidates were: ${routing.allowed.admitted.map((c) => c.model).join(", ") || "none"}.`,
    routing,
    delegation: accepted.delegation,
    approvedRecipients: approved,
  };
}

/**
 * Route, resolve, and -- if the chosen model turns out to be unusable at
 * delegation time -- switch to an authorized alternative and report it.
 *
 * Legacy path (ticket 24): it routes through ticket 06's catalog-wide
 * `route`, not the router (`routeTier` in routing/tier-router.ts), so it still
 * admits only models with fresh suitability evidence. Not called by ticket
 * 27's extension; scheduled for retirement when ticket 26 moves bounded
 * recovery onto `nextRungAfterFailure` and ticket 27 wires the extension onto
 * the router. The router's refusal (`TierRouteRefusal`) reuses this
 * function's refusal shape.
 *
 * Recipient authorization is applied twice on purpose: once as stage 1's
 * candidate narrowing, and again at the delegation boundary for whatever the
 * picker returned. The second check is not redundant defensiveness; it is the
 * check that still holds if a future picker, or a caller assembling its own
 * `AllowedCandidates`, produces a candidate stage 1 never admitted.
 */
export function delegateWithSwitch(
  input: AuthorizedDelegationInput,
): AuthorizedDelegationOutcome {
  const picker = input.picker ?? correctnessFirstPicker;
  const budget = input.budget ?? NO_BUDGET_CONSTRAINT;
  const approved = approvedRecipients(input.authorization);

  // Stage 1, narrowed through the seam it already exposes.
  const stage1: Stage1Input = {
    ...input.stage1,
    request: {
      ...input.stage1.request,
      privacy: privacyConstraintFor(input.authorization, input.stage1.request.privacy),
    },
  };

  const routing = route(stage1, picker);
  if (!routing.ok) {
    return {
      ok: false,
      code: "no_authorized_candidate",
      message: routing.message,
      routing,
      approvedRecipients: approved,
    };
  }

  const attempt = (model: string): { outcome: DirectDelegationOutcome } => ({
    outcome: delegateNamedModel({
      model,
      authorization: input.authorization,
      budget,
      ...(input.delegationKey === undefined ? {} : { delegationKey: input.delegationKey }),
      ...(input.delegationAvailability ? { availability: input.delegationAvailability } : {}),
    }),
  });

  const first = attempt(routing.model).outcome;
  if (first.ok) {
    const outOfSet = outOfSetRefusal(routing, first, approved);
    if (outOfSet) return outOfSet;
    return {
      ok: true,
      model: first.delegation.baseModel,
      provider: first.delegation.provider,
      delegation: first.delegation,
      routing,
      approvedRecipients: approved,
      budgetApplied: budget.describe,
      budgetAdmission: first.budgetAdmission,
    };
  }

  // An unapproved recipient is not a reason to shop around: it is a boundary
  // violation in what stage 1 or the picker produced, and it is reported as
  // itself rather than papered over by trying the next model.
  if (first.code === "unauthorized_recipient") {
    return {
      ok: false,
      code: "unauthorized_recipient",
      message: first.message,
      routing,
      ...(first.delegation ? { delegation: first.delegation } : {}),
      approvedRecipients: approved,
    };
  }

  // A prohibited or unidentifiable model is likewise not a switch trigger.
  // Only capacity/reachability is.
  const unusableForCapacity =
    first.code === "resolver_rejected" &&
    first.delegation !== undefined &&
    !first.delegation.ok &&
    (first.delegation.code === "unavailable" ||
      first.delegation.code === "throttled" ||
      first.delegation.code === "call_failure");

  if (!unusableForCapacity && first.code !== "over_budget") {
    return {
      ok: false,
      code: "resolver_rejected",
      message: first.message,
      routing,
      ...(first.delegation ? { delegation: first.delegation } : {}),
      approvedRecipients: approved,
    };
  }

  // The switch. Ask the SAME picker for its next preference, so preference
  // order is not duplicated here.
  const refused: RefusedAlternative[] = [
    {
      model: routing.model,
      why:
        first.code === "over_budget"
          ? first.message
          : describeUnusable(first.delegation ?? { ok: false, code: "unavailable", message: first.message, source: "explicit" }),
    },
  ];
  const tried = new Set<string>([routing.model]);

  for (let i = 0; i < routing.allowed.admitted.length; i += 1) {
    const next = picker(withoutModels(routing.allowed, tried));
    if (!next) break;
    tried.add(next.model);

    const alternative = attempt(next.model).outcome;
    if (alternative.ok) {
      const outOfSet = outOfSetRefusal(routing, alternative, approved);
      if (outOfSet) return outOfSet;
      const switched: SwitchReport = {
        from: routing.model,
        to: alternative.delegation.baseModel,
        reason:
          `'${routing.model}' was not usable at delegation time (` +
          `${refused[0]?.why ?? "unusable"}). Switched to the next preference ` +
          `from the same allowed-candidate set, which is an approved recipient, ` +
          `has fresh suitability evidence for '${routing.allowed.taskType}', and within the ` +
          "applied spending constraint.",
        consideredAndRefused: refused,
        recipientConstraint: approved,
        budgetApplied: budget.describe,
        capabilityBasis: next.reason,
      };
      return {
        ok: true,
        model: alternative.delegation.baseModel,
        provider: alternative.delegation.provider,
        delegation: alternative.delegation,
        routing,
        switched,
        approvedRecipients: approved,
        budgetApplied: budget.describe,
        budgetAdmission: alternative.budgetAdmission,
      };
    }

    refused.push({
      model: next.model,
      why:
        alternative.code === "unauthorized_recipient" || alternative.code === "over_budget"
          ? alternative.message
          : describeUnusable(
              alternative.delegation ?? {
                ok: false,
                code: "unavailable",
                message: alternative.message,
                source: "explicit",
              },
            ),
    });
  }

  return {
    ok: false,
    code: "no_authorized_alternative",
    message:
      `pi-orchestration-harness: '${routing.model}' was not usable and no ` +
      "authorized alternative satisfied recipient, capability and spending " +
      `constraints. ${refused.length} candidate(s) were considered. ` +
      "Requirements were not weakened and no unapproved recipient was used; " +
      "report the blocker or authorize a suitable recipient.",
    routing,
    consideredAndRefused: refused,
    approvedRecipients: approved,
  };
}

// ---------------------------------------------------------------------------
// Observable records, matching the JSONL convention of tickets 04 and 06
// ---------------------------------------------------------------------------

export const SWITCH_RECORD_PREFIX = "SWITCH=";
export const RECIPIENT_RECORD_PREFIX = "RECIPIENT=";

export function formatSwitchRecord(
  report: SwitchReport,
  identity?: DelegationIdentity,
): string {
  const delegationId = validatedDelegationId(identity);
  const record = delegationId === undefined ? report : { ...report, delegationId };
  return `${SWITCH_RECORD_PREFIX}${JSON.stringify(record)}`;
}

/** One line per delegation outcome, switch included. Tests read this from
 *  outside instead of inspecting internals. */
export function formatRecipientRecord(
  outcome: AuthorizedDelegationOutcome,
  identity?: DelegationIdentity,
): string {
  const delegationId = validatedDelegationId(identity);
  const summary = outcome.ok
    ? {
        ...(delegationId === undefined ? {} : { delegationId }),
        ok: true,
        model: outcome.model,
        provider: outcome.provider,
        switched: outcome.switched ?? null,
        approvedRecipients: outcome.approvedRecipients,
        budgetApplied: outcome.budgetApplied,
        budgetAdmission:
          outcome.budgetAdmission.kind === "reservation"
            ? {
                kind: outcome.budgetAdmission.kind,
                reservationId: outcome.budgetAdmission.reservationId,
                model: outcome.budgetAdmission.model,
              }
            : outcome.budgetAdmission,
      }
    : {
        ...(delegationId === undefined ? {} : { delegationId }),
        ok: false,
        code: outcome.code,
        message: outcome.message,
        consideredAndRefused: outcome.consideredAndRefused ?? [],
        approvedRecipients: outcome.approvedRecipients,
      };
  return `${RECIPIENT_RECORD_PREFIX}${JSON.stringify(summary)}`;
}

export function recordSwitch(
  path: string,
  report: SwitchReport,
  identity?: DelegationIdentity,
): void {
  appendFileSync(path, `${formatSwitchRecord(report, identity)}\n`);
}

export function recordRecipientOutcome(
  path: string,
  outcome: AuthorizedDelegationOutcome,
  identity?: DelegationIdentity,
): void {
  appendFileSync(path, `${formatRecipientRecord(outcome, identity)}\n`);
}
