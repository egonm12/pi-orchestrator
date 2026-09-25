/**
 * Ticket 09 -- one shared task allowance.
 *
 * A single spending allowance per approved user task. Orchestration, every
 * delegated subtask, every review and every retry draw on the SAME pool.
 * Decomposing the work does not reset it, switching provider does not reset
 * it, and resuming a session does not reset it.
 *
 * WHY THIS IS CUSTOM. Every surveyed budget product scopes spending to a
 * credential or a workspace -- key, user, team, organisation, workspace --
 * with time-window resets. None offers a budget scoped to a *logical task*
 * spanning multiple agents, providers and sessions, and there is no
 * configuration flag for it anywhere. So the ledger below is keyed by a task
 * id and nothing else: not by provider, not by model, not by session, not by
 * a time window. That key IS the feature.
 *
 * WHAT IS NOT REBUILT. Per-call cost arithmetic and provider pricing tables
 * are ticket 05's catalog (`catalog/model-catalog.ts`), consumed here through
 * `Fact<TokenPrice>` rather than re-tabulated per provider. The unforgeable
 * approval concept is ticket 07's (`recipients/authorization.ts`), reused for
 * the over-allowance gate rather than stood up a second time. The constraint
 * shape is ticket 07's `BudgetConstraint` seam, which this ticket fills in.
 *
 * THIS IS A STOP THRESHOLD, NOT A BILLING CEILING. See `OVERSHOOT_CAVEAT`.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProhibitedModel } from "../policy/model-resolution.ts";
import {
  known,
  readFact,
  unknown,
  type Fact,
  type FreshnessPolicy,
} from "../catalog/epistemic.ts";
import {
  lookup,
  type ModelCatalog,
  type TokenPrice,
} from "../catalog/model-catalog.ts";
import {
  isOwnerApprovalGranted,
  type OwnerApproval,
} from "../recipients/authorization.ts";
import type {
  BudgetConstraint,
  BudgetVerdict,
  DelegationReservationBinding,
} from "../recipients/authorized-delegation.ts";

export const ALLOWANCE_SCHEMA_VERSION = 1;

/** The spec's initial figure. Configurable per ledger; this is only the default. */
export const DEFAULT_ALLOWANCE_USD = 5;

/**
 * The honest description of what the allowance can and cannot promise,
 * carried in the ledger's own rendering so a reader cannot take the number
 * for a guaranteed bill.
 *
 * Estimate-based pre-call enforcement has this property industry-wide, not
 * just here: LiteLLM issue #33923 documents concurrent requests all passing
 * the same under-budget check and reaching the provider before any cost was
 * recorded, inside a purpose-built billing enforcement system. pi's own
 * `UsageBudgetState.source` is the literal `"reported"`, documented "no
 * reservation estimates" (`pi-subagents/src/shared/types.d.ts:1097-1098`),
 * which is the same limitation stated by the product this harness runs on.
 *
 * Ticket 10 owns reporting this in full. This module's duty is narrower: do
 * not misrepresent it.
 */
export const OVERSHOOT_CAVEAT =
  "aggregate stop threshold, not a guaranteed billing ceiling: reservations " +
  "are estimates, and calls already in flight can still overshoot";

/**
 * `TaskAllowanceOwner` is the authoritative in-process mutation boundary: it
 * owns the current ledger for one task and synchronously serializes reserve,
 * reconcile and release operations against that current state. Pure ledger
 * transforms remain exported for testing and recovery tooling, but the
 * delegation-facing constraint accepts an owner, never a snapshot.
 *
 * Two processes sharing one ledger file are still NOT serialized. Atomic
 * replacement prevents torn files, but it is not a cross-process compare-and-
 * swap. A lock file, database transaction or broker is outside this harness.
 */
export const ATOMICITY_SCOPE =
  "serialized by one TaskAllowanceOwner within a process; concurrent processes sharing one ledger file are not serialized";

/**
 * Dollars are held as IEEE-754 doubles, so accumulated sums carry
 * representation error (three $1.30 reservations sum to $3.9000000000000004).
 *
 * Not converted to integer cents, because the inputs genuinely are fractional:
 * prices are USD per 1M tokens and a single call's cost is routinely a small
 * fraction of a cent, which integer cents would round to zero. The error is
 * ~1e-16 relative, far below the estimate error that already dominates a
 * threshold check, so it is stated rather than engineered around. Renderings
 * round to 4 decimal places; comparisons are threshold tests, not exact
 * bookkeeping to the cent.
 */
export const USD_PRECISION =
  "floating-point dollars: sums carry ~1e-16 relative representation error, " +
  "which is negligible against estimate error but means totals are not exact to the cent";

// ---------------------------------------------------------------------------
// Who spends
// ---------------------------------------------------------------------------

/**
 * Every role draws on ONE allowance. The role is recorded for attribution, and
 * has no effect on accounting -- there is deliberately no per-role sub-budget,
 * because a per-role budget is exactly how decomposition multiplies spending.
 */
export type ChargeRole = "orchestration" | "subtask" | "review" | "retry";

export const CHARGE_ROLES: readonly ChargeRole[] = [
  "orchestration",
  "subtask",
  "review",
  "retry",
];

// ---------------------------------------------------------------------------
// Estimating a call's maximum cost from existing pricing data
// ---------------------------------------------------------------------------

/**
 * Which price the estimate came from, kept explicit because they are not the
 * same claim. `effective-billed` is what the route actually charges;
 * `published-list` is an upstream list price standing in for it. Ticket 05
 * keeps these apart precisely so a cost figure cannot quietly change meaning.
 */
export type CostBasis =
  | { readonly kind: "effective-billed"; readonly price: TokenPrice }
  | { readonly kind: "published-list"; readonly price: TokenPrice }
  | { readonly kind: "not-metered"; readonly why: string }
  | { readonly kind: "unboundable"; readonly why: string };

export interface CostEstimate {
  readonly model: string;
  readonly basis: CostBasis;
  /**
   * Maximum metered dollars this call can cost, or `undefined` when that
   * cannot be bounded. `undefined` is NOT zero: a call whose cost cannot be
   * bounded is the case the allowance most needs to refuse, so collapsing it
   * to 0 would defeat the gate.
   */
  readonly maxUsd: number | undefined;
  /** True when this route bills metered dollars at all. */
  readonly metered: boolean;
  readonly describe: string;
}

export interface EstimateRequest {
  readonly model: string;
  /** Ceiling on prompt tokens for this call. Must be a finite non-negative integer. */
  readonly maxInputTokens: number;
  /** Ceiling on completion tokens. Must be a finite non-negative integer. Falls back to the catalog's max output. */
  readonly maxOutputTokens?: number;
}

export interface EstimateOptions {
  readonly freshness?: FreshnessPolicy;
  readonly now?: number;
}

function assertTokenBound(value: number, field: string): void {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `pi-orchestration-harness: ${field} must be a finite non-negative integer, got ${value}.`,
    );
  }
}

function assertTokenPrice(price: TokenPrice, model: string): void {
  for (const [field, value] of Object.entries(price)) {
    if (!isFiniteNonNegative(value)) {
      throw new Error(
        `pi-orchestration-harness: ${model} price ${field} must be a finite non-negative number, got ${value}.`,
      );
    }
  }
}

function priceOf(
  entry: ReturnType<typeof lookup>,
  options: EstimateOptions,
): { basis: CostBasis; price?: TokenPrice } {
  if (!entry) {
    return {
      basis: {
        kind: "unboundable",
        why: "model is not in the catalog, so no price is available to bound it",
      },
    };
  }

  const billing = readFact(entry.routeBilling, options.freshness, options.now);
  // A subscription route has no per-call metered amount. That is not "free":
  // the consumption is real and untracked, recorded separately below and
  // reported honestly by ticket 10.
  if (billing.state !== "unknown" && billing.value === "subscription") {
    return {
      basis: {
        kind: "not-metered",
        why: "subscription-routed: no per-call metered amount exists (consumption is tracked separately, not as dollars)",
      },
    };
  }

  // Prefer what the route actually bills; fall back to list price and SAY SO.
  const effective = readFact(entry.effectiveBilledCost, options.freshness, options.now);
  if (effective.state === "known") {
    return { basis: { kind: "effective-billed", price: effective.value }, price: effective.value };
  }

  const list = readFact(entry.publishedListPrice, options.freshness, options.now);
  if (list.state === "known") {
    return { basis: { kind: "published-list", price: list.value }, price: list.value };
  }

  // Stale or unknown price on a metered route. An unpriced model does not get
  // an assumed default price -- ticket 05's honesty rule applies here too.
  const why =
    list.state === "stale"
      ? `only a stale published list price is available (${Math.round(list.ageMs / 86_400_000)}d old), which cannot bound a current call`
      : "no known price for this model on a metered route";
  return { basis: { kind: "unboundable", why } };
}

/**
 * Estimate the maximum metered cost of a call BEFORE making it.
 *
 * ESTIMATION BASIS, stated because there is no universal max-cost formula:
 *
 *   maxUsd = (maxInputTokens / 1e6) * inputUsdPerMTok
 *          + (maxOutputTokens / 1e6) * outputUsdPerMTok
 *
 * Prices are USD per 1M tokens, which is the unit ticket 05's catalog already
 * stores (`TokenPrice`), so no per-provider arithmetic is reimplemented here.
 * The output ceiling falls back to the catalog's `contextWindow.maxOutputTokens`
 * when the caller does not supply one; if neither exists the cost is not
 * boundable and the call is refused rather than estimated at zero.
 *
 * Cache read/write rates are deliberately NOT subtracted: a cache hit can only
 * make the real cost lower, and an estimate that assumed cache hits would
 * under-reserve. This is a maximum, so it is priced as if nothing is cached.
 */
export function estimateMaxCost(
  catalog: ModelCatalog,
  request: EstimateRequest,
  options: EstimateOptions = {},
): CostEstimate {
  if (!isNonBlankString(request.model)) {
    throw new Error("pi-orchestration-harness: a cost estimate requires a non-blank model id.");
  }
  assertTokenBound(request.maxInputTokens, "maxInputTokens");
  if (request.maxOutputTokens !== undefined) {
    assertTokenBound(request.maxOutputTokens, "maxOutputTokens");
  }

  const entry = lookup(catalog, request.model);
  const { basis, price } = priceOf(entry, options);

  if (basis.kind === "not-metered") {
    return {
      model: request.model,
      basis,
      maxUsd: 0,
      metered: false,
      describe: `${request.model}: no metered cost (${basis.why})`,
    };
  }

  if (basis.kind === "unboundable" || !price) {
    return {
      model: request.model,
      basis: basis.kind === "unboundable" ? basis : { kind: "unboundable", why: "no price" },
      maxUsd: undefined,
      metered: true,
      describe: `${request.model}: cost cannot be bounded -- ${
        basis.kind === "unboundable" ? basis.why : "no price"
      }`,
    };
  }

  assertTokenPrice(price, request.model);
  const context = entry ? readFact(entry.contextWindow, options.freshness, options.now) : undefined;
  const catalogMaxOutput =
    context && context.state !== "unknown" ? context.value.maxOutputTokens : undefined;
  const maxOutputTokens = request.maxOutputTokens ?? catalogMaxOutput;

  if (maxOutputTokens === undefined) {
    return {
      model: request.model,
      basis: {
        kind: "unboundable",
        why: "no output-token ceiling: neither the request nor the catalog bounds completion length",
      },
      maxUsd: undefined,
      metered: true,
      describe: `${request.model}: cost cannot be bounded -- no output-token ceiling`,
    };
  }

  assertTokenBound(maxOutputTokens, "maxOutputTokens");
  const maxUsd =
    (request.maxInputTokens / 1_000_000) * price.inputUsdPerMTok +
    (maxOutputTokens / 1_000_000) * price.outputUsdPerMTok;
  if (!isFiniteNonNegative(maxUsd)) {
    throw new Error(
      `pi-orchestration-harness: the maximum cost for '${request.model}' is not a finite non-negative number.`,
    );
  }

  const label = basis.kind === "effective-billed" ? "billed rate" : "published list price";
  return {
    model: request.model,
    basis,
    maxUsd,
    metered: true,
    describe:
      `${request.model}: max $${maxUsd.toFixed(4)} from ${label} ` +
      `(${request.maxInputTokens} in + ${maxOutputTokens} out, uncached)`,
  };
}

// ---------------------------------------------------------------------------
// The ledger
// ---------------------------------------------------------------------------

export interface Reservation {
  readonly reservationId: string;
  readonly role: ChargeRole;
  readonly model: string;
  /**
   * Metered dollars held against the allowance until this reservation is
   * reconciled. Normally the estimated maximum. On an owner-approved call
   * whose cost cannot be bounded there is no maximum to hold, so the hold is
   * the whole remaining allowance -- see `reserveWithApproval`.
   */
  readonly estimatedUsd: number;
  readonly metered: boolean;
  readonly basis: string;
  readonly openedAt: string;
  readonly label?: string;
}

export interface SettledCharge {
  readonly reservationId: string;
  readonly role: ChargeRole;
  readonly model: string;
  readonly estimatedUsd: number;
  /**
   * What the call actually cost in metered dollars.
   *
   * `unknown("not-metered")` on a subscription route -- NOT `known(0)`. A zero
   * there would read as "this was free", and 01-findings.md §B.2 shows exactly
   * that trap: four runs on the since-uninstalled claude-bridge route reported
   * $0.000000 while consuming real subscription capacity. The `anthropic` OAuth
   * route can report a non-zero `cost.total` (one measured call reported
   * $0.00356115), but that reported amount is not the billed cost.
   */
  readonly actualUsd: Fact<number>;
  /**
   * Whatever figure the runtime reported, kept even when it is not metered
   * dollars, because ticket 10 needs the raw number to report consumption
   * honestly. On a subscription route this is a runtime-reported signal, not a
   * charge: it may be a list-derived estimate (01-findings.md §B.2: one
   * openai-codex run reported $6.136058) or a non-zero `cost.total` that is
   * still not the billed cost.
   */
  readonly reportedUsd?: number;
  readonly metered: boolean;
  readonly settledAt: string;
  readonly label?: string;
}

/** An over-allowance delegation that the owner explicitly approved, recorded so
 *  the overrun is auditable rather than merely permitted. */
export interface RecordedOverrunApproval {
  readonly approvedBy: string;
  readonly grantedAt: string;
  readonly acknowledgement: string;
  readonly model: string;
  readonly estimatedUsd: number;
  readonly remainingAtApprovalUsd: number;
}

/**
 * One approved user task's spending, in one place.
 *
 * Keyed by `taskId` alone. Nothing in this structure is keyed by provider,
 * model, agent, session or time window, which is what makes decomposition,
 * provider switches and session resumes structurally unable to reset it.
 */
export interface TaskLedger {
  readonly schemaVersion: number;
  readonly taskId: string;
  readonly allowanceUsd: number;
  readonly open: readonly Reservation[];
  readonly settled: readonly SettledCharge[];
  readonly overrunApprovals: readonly RecordedOverrunApproval[];
  readonly createdAt: string;
}

export interface NewLedgerInput {
  readonly taskId: string;
  /** Defaults to `DEFAULT_ALLOWANCE_USD` ($5). */
  readonly allowanceUsd?: number;
  readonly now?: Date;
}

export function newTaskLedger(input: NewLedgerInput): TaskLedger {
  const taskId = input.taskId.trim();
  if (!taskId) {
    throw new Error("pi-orchestration-harness: a task ledger requires a task id.");
  }
  const allowanceUsd = input.allowanceUsd ?? DEFAULT_ALLOWANCE_USD;
  if (!(allowanceUsd >= 0) || !Number.isFinite(allowanceUsd)) {
    throw new Error(
      `pi-orchestration-harness: allowance must be a finite non-negative number, got ${allowanceUsd}.`,
    );
  }
  return {
    schemaVersion: ALLOWANCE_SCHEMA_VERSION,
    taskId,
    allowanceUsd,
    open: [],
    settled: [],
    overrunApprovals: [],
    createdAt: (input.now ?? new Date()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Accounting
// ---------------------------------------------------------------------------

/** Metered dollars actually spent and reconciled. */
export function committedUsd(ledger: TaskLedger): number {
  return ledger.settled.reduce((total, charge) => {
    if (!charge.metered) return total;
    return charge.actualUsd.state === "known" ? total + charge.actualUsd.value : total;
  }, 0);
}

/** Metered dollars held by open reservations, not yet reconciled. */
export function reservedUsd(ledger: TaskLedger): number {
  return ledger.open.reduce(
    (total, reservation) => (reservation.metered ? total + reservation.estimatedUsd : total),
    0,
  );
}

/** Committed plus reserved: what the allowance must currently answer for. */
export function encumberedUsd(ledger: TaskLedger): number {
  return committedUsd(ledger) + reservedUsd(ledger);
}

export function remainingUsd(ledger: TaskLedger): number {
  return ledger.allowanceUsd - encumberedUsd(ledger);
}

/**
 * Charges on routes that bill no metered dollars. Counted, never summed into
 * the allowance, and never called free.
 */
export function unmeteredCharges(ledger: TaskLedger): readonly SettledCharge[] {
  return ledger.settled.filter((charge) => !charge.metered);
}

/**
 * Figures the runtime reported for unmetered routes. These are consumption
 * estimates, not charges. Ticket 10 owns presenting them; this only keeps them
 * separable from money.
 */
export function reportedUnmeteredConsumptionUsd(ledger: TaskLedger): number {
  return unmeteredCharges(ledger).reduce(
    (total, charge) => total + (charge.reportedUsd ?? 0),
    0,
  );
}

/**
 * A rendering that states the limits of the number it prints. Deliberately
 * never emits "free", and never presents unmetered consumption as dollars
 * spent against the allowance.
 */
export function describeAllowance(ledger: TaskLedger): string {
  const unmetered = unmeteredCharges(ledger);
  const unmeteredNote =
    unmetered.length === 0
      ? ""
      : ` Plus ${unmetered.length} unmetered charge(s) on subscription routes, ` +
        `which consume real capacity and are NOT counted as dollars here ` +
        `(reported consumption estimate $${reportedUnmeteredConsumptionUsd(ledger).toFixed(4)}).`;
  return (
    `task '${ledger.taskId}': $${committedUsd(ledger).toFixed(4)} committed + ` +
    `$${reservedUsd(ledger).toFixed(4)} reserved of $${ledger.allowanceUsd.toFixed(2)} ` +
    `allowance ($${remainingUsd(ledger).toFixed(4)} remaining). ` +
    `${OVERSHOOT_CAVEAT}.${unmeteredNote}`
  );
}

// ---------------------------------------------------------------------------
// estimate -> reserve -> reject-or-proceed -> reconcile
// ---------------------------------------------------------------------------

export interface ReserveRequest extends EstimateRequest {
  readonly role: ChargeRole;
  readonly label?: string;
  /** Stable id for the reservation. Defaults to a counter-free unique value. */
  readonly reservationId?: string;
}

export type ReserveOutcome =
  | {
      readonly ok: true;
      readonly ledger: TaskLedger;
      readonly reservation: Reservation;
      readonly estimate: CostEstimate;
    }
  | {
      readonly ok: false;
      readonly code: "would_exceed_allowance" | "unboundable_cost";
      readonly message: string;
      readonly estimate: CostEstimate;
      /** The scope an owner approval must carry to proceed anyway. */
      readonly requiredApprovalScope: "allowance-overrun";
      /** The ledger, unchanged. A refused reservation reserves nothing. */
      readonly ledger: TaskLedger;
    };

export class ReservationIdConflictError extends Error {
  readonly code = "duplicate_reservation_id";
  constructor(taskId: string, reservationId: string) {
    super(
      `pi-orchestration-harness: reservation id '${reservationId}' has already been used on task '${taskId}'. ` +
        "Reservation ids are unique for the lifetime of a ledger and cannot be reused after settlement.",
    );
    this.name = "ReservationIdConflictError";
  }
}

let reservationCounter = 0;

function allReservationIds(ledger: TaskLedger): Set<string> {
  return new Set([
    ...ledger.open.map((reservation) => reservation.reservationId),
    ...ledger.settled.map((charge) => charge.reservationId),
  ]);
}

function nextReservationId(ledger: TaskLedger): string {
  const existing = allReservationIds(ledger);
  let candidate: string;
  do {
    reservationCounter += 1;
    candidate = `res-${Date.now().toString(36)}-${reservationCounter.toString(36)}`;
  } while (existing.has(candidate));
  return candidate;
}

function requestedReservationId(ledger: TaskLedger, request: ReserveRequest): string | undefined {
  if (request.reservationId === undefined) return undefined;
  if (!isNonBlankString(request.reservationId)) {
    throw new Error("pi-orchestration-harness: reservationId must be a non-blank string.");
  }
  if (allReservationIds(ledger).has(request.reservationId)) {
    throw new ReservationIdConflictError(ledger.taskId, request.reservationId);
  }
  return request.reservationId;
}

function reservationFrom(
  request: ReserveRequest,
  reservationId: string,
  estimate: CostEstimate,
  now: Date,
  holdUsd: number,
): Reservation {
  return {
    reservationId,
    role: request.role,
    model: request.model,
    estimatedUsd: holdUsd,
    metered: estimate.metered,
    basis: estimate.describe,
    openedAt: now.toISOString(),
    ...(request.label === undefined ? {} : { label: request.label }),
  };
}

export interface ReserveOptions {
  readonly freshness?: FreshnessPolicy;
  /** A `Date` here rather than `EstimateOptions`' epoch number, because a
   *  reservation stamps an ISO timestamp as well as reading freshness. */
  readonly now?: Date;
}

/**
 * Estimate this call's maximum cost, hold it against the allowance, and refuse
 * if it would not fit.
 *
 * The refusal is the point: approval is required BEFORE delegating, not after
 * spending. A refused reservation returns the ledger unchanged, so a rejected
 * call cannot leave a phantom hold behind.
 */
export function reserve(
  ledger: TaskLedger,
  request: ReserveRequest,
  catalog: ModelCatalog,
  options: ReserveOptions = {},
): ReserveOutcome {
  assertLedgerForMutation(ledger);
  const suppliedReservationId = requestedReservationId(ledger, request);
  const estimateOptions: EstimateOptions = {
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.now === undefined ? {} : { now: options.now.getTime() }),
  };
  const estimate = estimateMaxCost(catalog, request, estimateOptions);

  if (estimate.maxUsd === undefined) {
    return {
      ok: false,
      code: "unboundable_cost",
      message:
        `pi-orchestration-harness: refused to reserve for '${request.model}' because its ` +
        `maximum cost cannot be bounded. ${estimate.describe}. An unbounded call is not ` +
        "reserved at zero; proceeding requires an explicit owner approval.",
      estimate,
      requiredApprovalScope: "allowance-overrun",
      ledger,
    };
  }

  const remaining = remainingUsd(ledger);
  // An unmetered route reserves $0, so it cannot exhaust a dollar allowance --
  // and it is still recorded, because ticket 10 must be able to see it.
  if (estimate.metered && estimate.maxUsd > remaining) {
    return {
      ok: false,
      code: "would_exceed_allowance",
      message:
        `pi-orchestration-harness: delegate to '${request.model}' was not reserved. ` +
        `Its estimated maximum $${estimate.maxUsd.toFixed(4)} exceeds the $${remaining.toFixed(4)} ` +
        `remaining on task '${ledger.taskId}' (allowance $${ledger.allowanceUsd.toFixed(2)}). ` +
        "Approval is required before this runs, not after it spends.",
      estimate,
      requiredApprovalScope: "allowance-overrun",
      ledger,
    };
  }

  // `estimate.maxUsd` is established here: the unboundable case returned above.
  const reservation = reservationFrom(
    request,
    suppliedReservationId ?? nextReservationId(ledger),
    estimate,
    options.now ?? new Date(),
    estimate.maxUsd,
  );
  return {
    ok: true,
    ledger: { ...ledger, open: [...ledger.open, reservation] },
    reservation,
    estimate,
  };
}

export class UnapprovedOverrunError extends Error {
  readonly code = "unapproved_allowance_overrun";
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedOverrunError";
  }
}

/**
 * Reserve past the allowance, with an owner approval that must be genuine.
 *
 * Verified against ticket 07's module-private approval registry via
 * `isOwnerApprovalGranted`, so a hand-built approval-shaped object is refused
 * exactly as it is at the recipient gate. The harness keeps ONE unforgeable
 * approval concept rather than a second one for money.
 *
 * The scope must be `allowance-overrun` specifically: approvals are not
 * fungible, so a data-recipient approval cannot buy spending headroom.
 */
export function reserveWithApproval(
  ledger: TaskLedger,
  request: ReserveRequest,
  catalog: ModelCatalog,
  approval: OwnerApproval,
  options: ReserveOptions = {},
): ReserveOutcome {
  if (!isOwnerApprovalGranted(approval)) {
    throw new UnapprovedOverrunError(
      "pi-orchestration-harness: refused to exceed the task allowance on an approval that " +
        "did not come from grantOwnerApproval. An approval-shaped object is not an approval.",
    );
  }
  if (approval.scope !== "allowance-overrun") {
    throw new UnapprovedOverrunError(
      `pi-orchestration-harness: an approval scoped '${approval.scope}' cannot authorize ` +
        "spending past the task allowance. Approvals are not fungible; this gate requires " +
        "scope 'allowance-overrun'.",
    );
  }

  const attempt = reserve(ledger, request, catalog, options);
  if (attempt.ok) return attempt;

  const now = options.now ?? new Date();
  // An unboundable cost has no maximum to hold. Holding $0 would leave the
  // remaining allowance looking entirely free for as long as the call is in
  // flight, so a second reservation could be granted against headroom this
  // call may already be consuming -- the same collapse-to-zero that
  // `CostEstimate.maxUsd` exists to refuse, arriving through the approved
  // path. There is no honest figure to invent (ticket 05 forbids assuming a
  // price), so the conservative hold is everything that is left; `reconcile`
  // releases it and applies what the call actually cost.
  const holdUsd = attempt.estimate.maxUsd ?? Math.max(0, remainingUsd(ledger));
  const reservation = reservationFrom(
    request,
    request.reservationId ?? nextReservationId(ledger),
    attempt.estimate,
    now,
    holdUsd,
  );
  const record: RecordedOverrunApproval = {
    approvedBy: approval.approvedBy,
    grantedAt: approval.grantedAt,
    acknowledgement: approval.acknowledgement,
    model: request.model,
    estimatedUsd: reservation.estimatedUsd,
    remainingAtApprovalUsd: remainingUsd(ledger),
  };

  return {
    ok: true,
    ledger: {
      ...ledger,
      open: [...ledger.open, reservation],
      overrunApprovals: [...ledger.overrunApprovals, record],
    },
    reservation,
    estimate: attempt.estimate,
  };
}

export interface ReconcileInput {
  readonly reservationId: string;
  /**
   * The cost the runtime reported for the completed call. On a metered route
   * this becomes the actual charge and is required. On a subscription route
   * it is kept as a consumption estimate and NOT counted as dollars.
   */
  readonly reportedUsd?: number;
  readonly now?: Date;
}

export class ReconciliationError extends Error {
  readonly code: "unknown_reservation" | "missing_reported_cost" | "invalid_reported_cost";

  constructor(
    code: "unknown_reservation" | "missing_reported_cost" | "invalid_reported_cost",
    message: string,
  ) {
    super(message);
    this.name = "ReconciliationError";
    this.code = code;
  }
}

/**
 * Release the reservation's estimate and apply what the call actually cost.
 *
 * A metered reservation remains open when no valid actual is supplied. This is
 * deliberately fail-closed: moving it to settled with an unknown actual would
 * release its conservative hold and manufacture spendable headroom.
 */
export function reconcile(ledger: TaskLedger, input: ReconcileInput): TaskLedger {
  assertLedgerForMutation(ledger);
  if (!isNonBlankString(input.reservationId)) {
    throw new ReconciliationError(
      "unknown_reservation",
      "pi-orchestration-harness: reconciliation requires a non-blank reservation id.",
    );
  }
  if (input.reportedUsd !== undefined && !isFiniteNonNegative(input.reportedUsd)) {
    throw new ReconciliationError(
      "invalid_reported_cost",
      `pi-orchestration-harness: reportedUsd must be a finite non-negative number, got ${input.reportedUsd}.`,
    );
  }

  const reservationIndex = ledger.open.findIndex(
    (reservation) => reservation.reservationId === input.reservationId,
  );
  const reservation = ledger.open[reservationIndex];
  if (!reservation) {
    throw new ReconciliationError(
      "unknown_reservation",
      `pi-orchestration-harness: no open reservation '${input.reservationId}' on task '${ledger.taskId}'.`,
    );
  }
  if (reservation.metered && input.reportedUsd === undefined) {
    throw new ReconciliationError(
      "missing_reported_cost",
      `pi-orchestration-harness: metered reservation '${input.reservationId}' reported no cost; ` +
        "its hold remains open until a finite non-negative actual is supplied.",
    );
  }
  const settledAt = (input.now ?? new Date()).toISOString();

  const actualUsd: Fact<number> = reservation.metered
    ? known(input.reportedUsd as number, "observed-from-call", settledAt)
    : unknown<number>(
        "not-metered",
        "subscription-routed: the reported figure is a consumption estimate, not a charge",
      );

  const charge: SettledCharge = {
    reservationId: reservation.reservationId,
    role: reservation.role,
    model: reservation.model,
    estimatedUsd: reservation.estimatedUsd,
    actualUsd,
    metered: reservation.metered,
    settledAt,
    ...(input.reportedUsd === undefined ? {} : { reportedUsd: input.reportedUsd }),
    ...(reservation.label === undefined ? {} : { label: reservation.label }),
  };

  return {
    ...ledger,
    open: [...ledger.open.slice(0, reservationIndex), ...ledger.open.slice(reservationIndex + 1)],
    settled: [...ledger.settled, charge],
  };
}

/**
 * Drop a reservation whose call never happened (a refused delegation, an
 * infrastructure failure). Releases the hold without recording a charge, so a
 * call that never ran does not consume the allowance.
 */
export function releaseReservation(ledger: TaskLedger, reservationId: string): TaskLedger {
  assertLedgerForMutation(ledger);
  const index = ledger.open.findIndex((reservation) => reservation.reservationId === reservationId);
  if (index < 0) return ledger;
  return { ...ledger, open: [...ledger.open.slice(0, index), ...ledger.open.slice(index + 1)] };
}

// ---------------------------------------------------------------------------
// Authoritative in-process owner
// ---------------------------------------------------------------------------

/**
 * The single in-process owner of one task's current ledger.
 *
 * Each mutating method is synchronous and updates the private current ledger
 * before returning, so two child callbacks using the same owner cannot both
 * reserve against one stale snapshot. Callers may inspect `snapshot()`, but
 * cannot submit that snapshot back to an owner mutation.
 */
const mintedAllowanceOwners = new WeakSet<TaskAllowanceOwner>();

export class TaskAllowanceOwner {
  #ledger: TaskLedger;

  constructor(initialLedger: TaskLedger) {
    assertLedgerForMutation(initialLedger);
    this.#ledger = initialLedger;
    mintedAllowanceOwners.add(this);
  }

  get taskId(): string {
    return this.#ledger.taskId;
  }

  snapshot(): TaskLedger {
    return this.#ledger;
  }

  reserve(
    request: ReserveRequest,
    catalog: ModelCatalog,
    options: ReserveOptions = {},
  ): ReserveOutcome {
    const outcome = reserve(this.#ledger, request, catalog, options);
    if (outcome.ok) this.#ledger = outcome.ledger;
    return outcome;
  }

  reserveWithApproval(
    request: ReserveRequest,
    catalog: ModelCatalog,
    approval: OwnerApproval,
    options: ReserveOptions = {},
  ): ReserveOutcome {
    const outcome = reserveWithApproval(this.#ledger, request, catalog, approval, options);
    if (outcome.ok) this.#ledger = outcome.ledger;
    return outcome;
  }

  reconcile(input: ReconcileInput): TaskLedger {
    const next = reconcile(this.#ledger, input);
    this.#ledger = next;
    return next;
  }

  releaseReservation(reservationId: string): TaskLedger {
    const next = releaseReservation(this.#ledger, reservationId);
    this.#ledger = next;
    return next;
  }
}

// ---------------------------------------------------------------------------
// Ticket 07's BudgetConstraint seam, now filled in
// ---------------------------------------------------------------------------

export interface AllowanceDelegationCall {
  readonly role: ChargeRole;
  readonly maxInputTokens: number;
  readonly maxOutputTokens?: number;
  readonly label?: string;
  /**
   * A genuine, allowance-scoped owner approval for a delegation that the normal
   * admission cannot bound or fit. The constraint still reserves through this
   * owner; approval never creates a second, unreserved delegation path.
   */
  readonly overrunApproval?: OwnerApproval;
}

/**
 * The real spending constraint that ticket 07 left a seam for.
 *
 * `check` is deliberately observation-only for UI/reporting. Delegation code
 * calls `admitDelegation`, which synchronously reserves through the same owner
 * before it can return success. A successful admission returns a closure-bound
 * capability for releasing a call that never started or reconciling one that
 * did; callers never supply a reservation id to those mutations.
 */
const constraintOwners = new WeakMap<BudgetConstraint, TaskAllowanceOwner>();

/** Only factory-minted constraints backed by the identical mutation owner share a pool. */
export function sharesTaskAllowance(a: BudgetConstraint, b: BudgetConstraint): boolean {
  const owner = constraintOwners.get(a);
  return owner !== undefined && owner === constraintOwners.get(b);
}

export function allowanceConstraint(
  owner: TaskAllowanceOwner,
  catalog: ModelCatalog,
  call: AllowanceDelegationCall,
  options: EstimateOptions = {},
): BudgetConstraint {
  if (!mintedAllowanceOwners.has(owner)) {
    throw new TypeError("task allowance constraint requires a genuine TaskAllowanceOwner");
  }
  const requestFor = (model: string, delegationKey?: string): ReserveRequest => ({
    model,
    role: call.role,
    maxInputTokens: call.maxInputTokens,
    ...(call.maxOutputTokens === undefined ? {} : { maxOutputTokens: call.maxOutputTokens }),
    ...(call.label === undefined ? {} : { label: call.label }),
    ...(delegationKey === undefined ? {} : { reservationId: delegationKey }),
  });
  const reserveOptions: ReserveOptions = {
    ...(options.freshness === undefined ? {} : { freshness: options.freshness }),
    ...(options.now === undefined ? {} : { now: new Date(options.now) }),
  };

  const preflight = (model: string): BudgetVerdict => {
    if (isProhibitedModel(model)) {
      return { ok: false, why: `model '${model}' is prohibited by name` };
    }
    const estimate = estimateMaxCost(catalog, requestFor(model), options);
    if (estimate.maxUsd === undefined) {
      return { ok: false, why: `its maximum cost cannot be bounded (${estimate.describe})` };
    }
    if (!estimate.metered) return { ok: true };
    const remaining = remainingUsd(owner.snapshot());
    if (estimate.maxUsd > remaining) {
      return {
        ok: false,
        why:
          `its estimated maximum $${estimate.maxUsd.toFixed(4)} exceeds the ` +
          `$${remaining.toFixed(4)} remaining on this task`,
      };
    }
    return { ok: true };
  };

  const constraint: BudgetConstraint = {
    get describe(): string {
      const ledger = owner.snapshot();
      return (
        `task allowance '${ledger.taskId}': $${remainingUsd(ledger).toFixed(4)} remaining ` +
        `of $${ledger.allowanceUsd.toFixed(2)} (${OVERSHOOT_CAVEAT})`
      );
    },
    check: preflight,
    admitDelegation(model: string, delegationKey?: string) {
      if (isProhibitedModel(model)) {
        return { ok: false, why: `model '${model}' is prohibited by name` };
      }
      let outcome: ReserveOutcome;
      try {
        outcome = call.overrunApproval === undefined
          ? owner.reserve(requestFor(model, delegationKey), catalog, reserveOptions)
          : owner.reserveWithApproval(
              requestFor(model, delegationKey),
              catalog,
              call.overrunApproval,
              reserveOptions,
            );
      } catch (cause) {
        if (cause instanceof ReservationIdConflictError) {
          return {
            ok: false,
            why:
              `delegation id '${delegationKey}' already has an open or settled reservation on ` +
              `task '${owner.taskId}'; duplicate delivery was not admitted`,
          };
        }
        throw cause;
      }
      if (!outcome.ok) return { ok: false, why: outcome.message };

      const { reservation } = outcome;
      const admission: DelegationReservationBinding = {
        kind: "reservation",
        reservationId: reservation.reservationId,
        model: reservation.model,
        reservation,
        release(): void {
          // A released id may be retried. Object identity prevents an old
          // binding from releasing the retry's newer reservation with that id.
          if (!owner.snapshot().open.includes(reservation)) return;
          owner.releaseReservation(reservation.reservationId);
        },
        reconcile(input): void {
          if (!owner.snapshot().open.includes(reservation)) {
            throw new ReconciliationError(
              "unknown_reservation",
              `pi-orchestration-harness: delegation reservation '${reservation.reservationId}' ` +
                "is no longer the open reservation bound to this admission.",
            );
          }
          owner.reconcile({ reservationId: reservation.reservationId, ...input });
        },
      };
      return { ok: true, admission };
    },
  };
  Object.freeze(constraint);
  constraintOwners.set(constraint, owner);
  return constraint;
}

// ---------------------------------------------------------------------------
// Persistence: the reason a resumed session does not start spending again
// ---------------------------------------------------------------------------

/** Runtime state, not source: git-ignored, same as tickets 05 and 07. */
export const DEFAULT_ALLOWANCE_DIR = "src/state/task-allowances";

/**
 * One file per task id, because the task is the accounting unit.
 *
 * The sanitiser is NOT injective: `task/alpha`, `task alpha` and `task_alpha`
 * all land on `task_alpha.json`. That collision is not resolved here -- a
 * path cannot know which task asked for it -- so `resumeLedger` verifies the
 * loaded ledger's own `taskId` and refuses a mismatch rather than letting two
 * logical tasks quietly share one allowance.
 */
export function allowancePathFor(directory: string, taskId: string): string {
  const safe = taskId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(directory, `${safe}.json`);
}

/**
 * Write the ledger via a temp file and a rename, which is atomic within one
 * directory on POSIX.
 *
 * A plain in-place write that is interrupted -- crash, full disk, killed
 * process -- leaves truncated JSON, and truncated JSON now correctly fails
 * closed in `resumeLedger`. Without the rename, the fail-closed design would
 * be a footgun: a half-written file would wedge that task permanently. With
 * it, a reader sees either the previous ledger or the new one, never half of
 * either.
 */
export function saveLedger(path: string, ledger: TaskLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  // Unique and in the destination directory: `wx` cannot clobber another
  // writer's temp file, and same-directory rename is atomic on POSIX.
  const temp = `${path}.${process.pid.toString(36)}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, { flag: "wx" });
    renameSync(temp, path);
  } catch (cause) {
    // The ledger at `path` is untouched if writing or rename failed. Cleanup is
    // best effort and must not mask the original persistence error.
    try {
      rmSync(temp, { force: true });
    } catch {
      // Nothing safer can be done here without replacing the useful failure.
    }
    throw cause;
  }
}

type DecodedLedger =
  | { readonly ok: true; readonly ledger: TaskLedger }
  | { readonly ok: false; readonly kind: "json" | "structure"; readonly detail: string }
  | { readonly ok: false; readonly kind: "schema"; readonly found: number };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isChargeRole(value: unknown): value is ChargeRole {
  return typeof value === "string" && (CHARGE_ROLES as readonly string[]).includes(value);
}

function optionalStringProblem(value: unknown, field: string): string | undefined {
  return value === undefined || typeof value === "string"
    ? undefined
    : `${field} must be a string when present`;
}

function reservationProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (!isNonBlankString(value.reservationId)) return `${at}.reservationId must be a non-blank string`;
  if (!isChargeRole(value.role)) return `${at}.role is not a recognized charge role`;
  if (!isNonBlankString(value.model)) return `${at}.model must be a non-blank string`;
  if (!isFiniteNonNegative(value.estimatedUsd)) {
    return `${at}.estimatedUsd must be a finite non-negative number`;
  }
  if (typeof value.metered !== "boolean") return `${at}.metered must be a boolean`;
  if (!isNonBlankString(value.basis)) return `${at}.basis must be a non-blank string`;
  if (!isNonBlankString(value.openedAt)) return `${at}.openedAt must be a non-blank string`;
  return optionalStringProblem(value.label, `${at}.label`);
}

function actualUsdProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (value.state === "known") {
    if (!isFiniteNonNegative(value.value)) {
      return `${at}.value must be a finite non-negative number when known`;
    }
    if (!isNonBlankString(value.evidence)) return `${at}.evidence must be a non-blank string`;
    if (!isNonBlankString(value.asOf)) return `${at}.asOf must be a non-blank string`;
    return optionalStringProblem(value.note, `${at}.note`);
  }
  if (value.state === "unknown") {
    if (!isNonBlankString(value.reason)) return `${at}.reason must be a non-blank string`;
    return (
      optionalStringProblem(value.note, `${at}.note`) ??
      optionalStringProblem(value.checkedAt, `${at}.checkedAt`)
    );
  }
  return `${at}.state must be 'known' or 'unknown'`;
}

function settledChargeProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (!isNonBlankString(value.reservationId)) return `${at}.reservationId must be a non-blank string`;
  if (!isChargeRole(value.role)) return `${at}.role is not a recognized charge role`;
  if (!isNonBlankString(value.model)) return `${at}.model must be a non-blank string`;
  if (!isFiniteNonNegative(value.estimatedUsd)) {
    return `${at}.estimatedUsd must be a finite non-negative number`;
  }
  const actualProblem = actualUsdProblem(value.actualUsd, `${at}.actualUsd`);
  if (actualProblem) return actualProblem;
  if (value.reportedUsd !== undefined && !isFiniteNonNegative(value.reportedUsd)) {
    return `${at}.reportedUsd must be a finite non-negative number when present`;
  }
  if (typeof value.metered !== "boolean") return `${at}.metered must be a boolean`;
  if (value.metered) {
    if (!isRecord(value.actualUsd) || value.actualUsd.state !== "known") {
      return `${at}.actualUsd must be known for a settled metered charge`;
    }
    if (value.reportedUsd === undefined) {
      return `${at}.reportedUsd is required for a settled metered charge`;
    }
  }
  if (!isNonBlankString(value.settledAt)) return `${at}.settledAt must be a non-blank string`;
  return optionalStringProblem(value.label, `${at}.label`);
}

function approvalProblem(value: unknown, at: string): string | undefined {
  if (!isRecord(value)) return `${at} must be an object`;
  if (!isNonBlankString(value.approvedBy)) return `${at}.approvedBy must be a non-blank string`;
  if (!isNonBlankString(value.grantedAt)) return `${at}.grantedAt must be a non-blank string`;
  if (!isNonBlankString(value.acknowledgement)) {
    return `${at}.acknowledgement must be a non-blank string`;
  }
  if (!isNonBlankString(value.model)) return `${at}.model must be a non-blank string`;
  if (!isFiniteNonNegative(value.estimatedUsd)) {
    return `${at}.estimatedUsd must be a finite non-negative number`;
  }
  if (typeof value.remainingAtApprovalUsd !== "number" || !Number.isFinite(value.remainingAtApprovalUsd)) {
    return `${at}.remainingAtApprovalUsd must be a finite number`;
  }
  return undefined;
}

/** Return the first structural problem that could make accounting ambiguous. */
function ledgerStructureProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "the root value must be an object";
  if (!isNonBlankString(value.taskId)) return "taskId must be a non-blank string";
  if (!isFiniteNonNegative(value.allowanceUsd)) {
    return "allowanceUsd must be a finite non-negative number";
  }
  if (!Array.isArray(value.open)) return "open must be an array";
  for (let index = 0; index < value.open.length; index += 1) {
    const problem = reservationProblem(value.open[index], `open[${index}]`);
    if (problem) return problem;
  }
  if (!Array.isArray(value.settled)) return "settled must be an array";
  for (let index = 0; index < value.settled.length; index += 1) {
    const problem = settledChargeProblem(value.settled[index], `settled[${index}]`);
    if (problem) return problem;
  }
  // Reservation ids are lifetime-unique across both states. Reuse after
  // settlement is forbidden because an id names exactly one call forever.
  const reservationIds = new Set<string>();
  for (const [at, entries] of [
    ["open", value.open],
    ["settled", value.settled],
  ] as const) {
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index] as Record<string, unknown>;
      const reservationId = entry.reservationId as string;
      if (reservationIds.has(reservationId)) {
        return `duplicate reservationId '${reservationId}' at ${at}[${index}]`;
      }
      reservationIds.add(reservationId);
    }
  }
  if (!Array.isArray(value.overrunApprovals)) return "overrunApprovals must be an array";
  for (let index = 0; index < value.overrunApprovals.length; index += 1) {
    const problem = approvalProblem(value.overrunApprovals[index], `overrunApprovals[${index}]`);
    if (problem) return problem;
  }
  if (!isNonBlankString(value.createdAt)) return "createdAt must be a non-blank string";
  return undefined;
}

function assertLedgerForMutation(ledger: TaskLedger): void {
  if (ledger.schemaVersion !== ALLOWANCE_SCHEMA_VERSION) {
    throw new Error(
      `pi-orchestration-harness: task '${ledger.taskId}' ledger schemaVersion ${ledger.schemaVersion} ` +
        `does not match ${ALLOWANCE_SCHEMA_VERSION}.`,
    );
  }
  const problem = ledgerStructureProblem(ledger);
  if (problem) {
    throw new Error(
      `pi-orchestration-harness: task '${ledger.taskId}' ledger is invalid: ${problem}.`,
    );
  }
}

function decodeLedger(raw: string): DecodedLedger {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (cause) {
    return { ok: false, kind: "json", detail: String(cause) };
  }
  if (!isRecord(parsed)) {
    return { ok: false, kind: "structure", detail: "the root value must be an object" };
  }
  if (typeof parsed.schemaVersion !== "number" || !Number.isInteger(parsed.schemaVersion)) {
    return { ok: false, kind: "structure", detail: "schemaVersion must be an integer" };
  }
  if (parsed.schemaVersion !== ALLOWANCE_SCHEMA_VERSION) {
    return { ok: false, kind: "schema", found: parsed.schemaVersion };
  }
  const problem = ledgerStructureProblem(parsed);
  return problem
    ? { ok: false, kind: "structure", detail: problem }
    : { ok: true, ledger: parsed as unknown as TaskLedger };
}

export function loadLedger(path: string): TaskLedger {
  const decoded = decodeLedger(readFileSync(path, "utf8"));
  if (decoded.ok) return decoded.ledger;
  if (decoded.kind === "schema") {
    throw new Error(
      `task ledger at ${path} has schemaVersion ${decoded.found}, expected ${ALLOWANCE_SCHEMA_VERSION}`,
    );
  }
  throw new Error(`task ledger at ${path} is invalid (${decoded.kind}: ${decoded.detail})`);
}

/**
 * Resume a task's ledger, or start one if this is the first session.
 *
 * Deliberately NOT fail-open-to-a-fresh-allowance on a corrupt store: a
 * damaged ledger that silently became a new $5 is the precise failure this
 * ticket exists to prevent, and it would be invisible. Tickets 05 and 07 fail
 * closed toward "no capability"; the equivalent here is to refuse rather than
 * to grant spending headroom that was never approved.
 */
export function resumeLedger(path: string, input: NewLedgerInput): TaskLedger {
  // Validate caller input even when a persisted ledger exists. Otherwise a
  // blank task id or nonsensical explicit allowance would only fail on ENOENT.
  const requestedTaskId = input.taskId.trim();
  if (!requestedTaskId) {
    throw new Error("pi-orchestration-harness: a task ledger requires a task id.");
  }
  if (
    input.allowanceUsd !== undefined &&
    (!(input.allowanceUsd >= 0) || !Number.isFinite(input.allowanceUsd))
  ) {
    throw new Error(
      `pi-orchestration-harness: allowance must be a finite non-negative number, got ${input.allowanceUsd}.`,
    );
  }
  const freshAllowance = input.allowanceUsd ?? DEFAULT_ALLOWANCE_USD;

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (cause) {
    // ONLY "there is no ledger yet" starts fresh. A permissions change, an I/O
    // error or a directory sitting where the ledger belongs all describe a
    // ledger that may exist and carry real accumulated spend, and treating
    // them as "first session" is the same invisible reset to $5 that the
    // corrupt-JSON and future-schema branches below refuse -- reached through
    // a different errno rather than a different kind of damage.
    const errno = errnoOf(cause);
    if (errno === "ENOENT") return newTaskLedger(input);
    throw new Error(
      `pi-orchestration-harness: task ledger at ${path} exists but could not be read ` +
        `(${errno ?? "no errno"}), so accumulated spend cannot be established. Refusing to ` +
        "resume with a fresh allowance, which would reset accounting invisibly. To recover, " +
        `restore read access to ${path} to resume with its spend intact, or delete it to ` +
        `start a fresh $${freshAllowance} allowance for this task -- the spend already ` +
        `recorded there will be lost. (${String(cause)})`,
    );
  }

  const decoded = decodeLedger(raw);
  if (!decoded.ok) {
    if (decoded.kind === "schema") {
      throw new Error(
        `pi-orchestration-harness: task ledger at ${path} has schemaVersion ` +
          `${decoded.found}, expected ${ALLOWANCE_SCHEMA_VERSION}. Refusing to resume rather ` +
          "than reset accounting. To recover, run a build that understands schemaVersion " +
          `${decoded.found}, or delete ${path} to start a fresh $${freshAllowance} allowance ` +
          "for this task -- the spend already recorded there will be lost.",
      );
    }
    throw new Error(
      `pi-orchestration-harness: task ledger at ${path} is unreadable or structurally invalid ` +
        `(${decoded.kind}: ${decoded.detail}), so accumulated spend cannot be established. ` +
        "Refusing to resume with a fresh allowance, which would reset accounting invisibly. " +
        `To recover, delete ${path} to start a fresh $${freshAllowance} allowance for this ` +
        "task -- the spend already recorded there will be lost.",
    );
  }
  const parsed = decoded.ledger;

  // `allowancePathFor` sanitises a task id into a file name, and that mapping
  // is many-to-one. Without this check, two different logical tasks whose ids
  // collide would silently draw on ONE allowance: the second task would
  // inherit the first's spend, and its own charges would be billed to the
  // first. Refuse, rather than merge two tasks' accounting invisibly.
  if (parsed.taskId !== requestedTaskId) {
    throw new Error(
      `pi-orchestration-harness: task ledger at ${path} belongs to task '${parsed.taskId}', ` +
        `not '${requestedTaskId}'. Task ids are sanitised into file names, so distinct ids can ` +
        "collide on one path; resuming here would merge two tasks into a single allowance. " +
        "Give the tasks ids that stay distinct after sanitisation, or resume this one from a " +
        "different allowance directory.",
    );
  }
  // Existing spend and its original allowance are authoritative. Silently
  // replacing the persisted allowance would reset accounting; silently
  // ignoring an explicit incompatible value would hide a configuration error.
  if (input.allowanceUsd !== undefined && input.allowanceUsd !== parsed.allowanceUsd) {
    throw new Error(
      `pi-orchestration-harness: task ledger at ${path} has persisted allowance ` +
        `$${parsed.allowanceUsd}, but the caller explicitly requested $${input.allowanceUsd}. ` +
        "Refusing to silently replace or ignore either value. Resume without an explicit " +
        `allowance (or with $${parsed.allowanceUsd}) to keep the persisted accounting.`,
    );
  }
  return parsed;
}

/** The `errno` string on a Node filesystem error, when there is one. */
function errnoOf(cause: unknown): string | undefined {
  if (typeof cause !== "object" || cause === null || !("code" in cause)) return undefined;
  const code = (cause as { readonly code: unknown }).code;
  return typeof code === "string" ? code : undefined;
}
