import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { RISK_TIERS, type RiskTier } from "../routing/tiers.ts";
import {
  appendRoutingRecord,
  buildGateRequirementRecord,
  GATE_LEVELS,
  readRoutingRecords,
  type GateAction,
  type GateLevel,
  type GateRequirementRecord,
  type RoutingRecord,
} from "../routing/decision-record.ts";
import type { ConstraintRung } from "../routing/tier-router.ts";
import { splitKnownThinkingSuffix } from "../models/model-info.ts";
import { delegationEdits, type DelegationEdits } from "./editing.ts";
import { hasEnded, workerBoard } from "./worker-board.ts";
import { isRunningWorkerSession } from "./worker-sessions.ts";
import { workerSessionDir } from "./worker.ts";

// What the quality gate (ADR 0010) asks of one editing delegation, and the
// facts it reads from the record folder: the delegation's tier and the rung
// it ran on, from its latest decision of some kind, and whether it is a
// finished editing delegation of this orchestrator session. Both
// subagents_verdict (./verdict.ts) and a review item (./review.ts) use them.
// The gate action is the one place that says whether a delegation needs a
// verdict and whether it needs a reviewer: the commit gate
// (./commit-gate.ts), subagents_verdict, an editing delegation's Result and
// the orchestrator protocol all read it. When a run of an editing delegation
// ends, its gate action at the gate level then in force is recorded as its
// gate requirement, from which the routing report counts ungated delegations
// and missing verdicts (ADR 0013).

export { GATE_ACTIONS, GATE_LEVELS, type GateAction, type GateLevel } from "../routing/decision-record.ts";

/** ADR 0011's table: the gate action per tier and gate level. Critical needs
 *  a reviewer at every level from low up, so low never means "gate nothing";
 *  off does: it removes the quality gate. */
const GATE_TABLE: Readonly<Record<RiskTier, Readonly<Record<GateLevel, GateAction>>>> = {
  mechanical: { off: "none", low: "none", medium: "spot-check", high: "spot-check", max: "reviewer" },
  standard: { off: "none", low: "none", medium: "spot-check", high: "reviewer", max: "reviewer" },
  elevated: { off: "none", low: "spot-check", medium: "reviewer", high: "reviewer", max: "reviewer" },
  critical: { off: "none", low: "reviewer", medium: "reviewer", high: "reviewer", max: "reviewer" },
};

/** The gate levels the orchestrator may raise a delegation to: all but off. */
export const RAISE_GATE_LEVELS: readonly GateLevel[] = GATE_LEVELS.filter((level) => level !== "off");

/** Whether the quality gate exists at `level`: everything but off. */
export function hasQualityGate(level: GateLevel): boolean {
  return level !== "off";
}

export function isGateLevel(value: unknown): value is GateLevel {
  return GATE_LEVELS.includes(value as GateLevel);
}

/** Whether `level` is stricter than `than`. */
export function isHigherGateLevel(level: GateLevel, than: GateLevel): boolean {
  return GATE_LEVELS.indexOf(level) > GATE_LEVELS.indexOf(than);
}

/** The gate action for an editing delegation of `tier` at the gate level
 *  `level` (ADR 0011). A delegation without a tier (a forked worker, one whose
 *  agent definition names a model, or an unrouted one) is gated as elevated. */
export function gateAction(tier: RiskTier | undefined, level: GateLevel): GateAction {
  return GATE_TABLE[tier ?? "elevated"][level];
}

/** The tiers of each gate action at `level`, in tier order, as the protocol names them. */
export function tiersByGateAction(level: GateLevel): Readonly<Record<GateAction, readonly RiskTier[]>> {
  const tiers = (action: GateAction) => RISK_TIERS.filter((tier) => GATE_TABLE[tier][level] === action);
  return { none: tiers("none"), "spot-check": tiers("spot-check"), reviewer: tiers("reviewer") };
}

/** Records the gate requirement of `delegationId`, whose run edited and has
 *  just ended: its gate action at `level`, the gate level in force now, read
 *  from its tier in the record folder `recordDir`. A resume that edits again
 *  records a fresh one. It is no verdict and teaches the router nothing. */
export function recordGateRequirement(recordDir: string, delegationId: string, level: GateLevel, at?: Date): GateRequirementRecord {
  const { tier } = delegationRouting(readRoutingRecords(recordDir), delegationId);
  const record = buildGateRequirementRecord({ delegationId, gateLevel: level, gateAction: gateAction(tier, level), ...(at === undefined ? {} : { at }) });
  appendRoutingRecord(recordDir, record);
  return record;
}

/** A delegation's tier and the rung it ran on, as its records name them. */
export interface DelegationRouting {
  /** Absent for a delegation without a tier: a fork, an agent's named model,
   *  or a worker the router did not route. */
  readonly tier?: RiskTier;
  /** Absent when no record names it, as for an unrouted worker. */
  readonly rung?: ConstraintRung;
}

function rungOf(rung: string): ConstraintRung | undefined {
  const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(rung);
  return thinkingSuffix === "" ? undefined : { model: baseModel, effort: thinkingSuffix.slice(1) };
}

/** `delegationId`'s tier and rung from its latest decision, fork or
 *  agent-model record in `records`, the record folder in file order. A routed
 *  decision's tier is the one it routed at, or started at when it refused;
 *  its rung is the one the worker ran on, which is the session model in
 *  shadow mode and on refusal. A retry's effort-ladder record is its link to
 *  the failed attempt, not what it ran on: it counts only when no other record
 *  is there, as with routing off, and then gives a placed climb's tier alone. */
export function delegationRouting(records: readonly RoutingRecord[], delegationId: string): DelegationRouting {
  const own = records.filter((record) => record.delegationId === delegationId);
  const latest = own.filter((record) => record.recordType === "decision" || record.recordType === "fork" || record.recordType === "agent-model").at(-1) ??
    own.filter((record) => record.recordType === "effort-ladder").at(-1);
  if (latest === undefined) return {};
  if (latest.recordType === "fork" || latest.recordType === "agent-model") return { rung: { model: latest.model, effort: latest.effort } };
  if (latest.recordType === "effort-ladder") return latest.step === "unplaced" ? {} : { tier: latest.route.tier };
  if (latest.recordType !== "decision") return {};
  const { route } = latest;
  const tier = route.outcome === "chosen" ? route.tier : route.startedAtTier;
  // A decision-record/2 record has no ranOn; in live mode its chosen rung ran.
  const ranOn = latest.ranOn ?? (latest.mode === "live" && route.outcome === "chosen" ? route.rung.rung : undefined);
  const rung = ranOn === undefined ? undefined : rungOf(ranOn);
  return { tier, ...(rung === undefined ? {} : { rung }) };
}

/** Whether this orchestrator session started the delegation `id`: its board
 *  lists it, or its saved worker sessions hold it. */
export function isOwnDelegation(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string): boolean {
  if (workerBoard().byDelegation(id) !== undefined) return true;
  try {
    return SessionManager.findById(ctx.cwd, id, workerSessionDir(ctx.sessionManager)) !== undefined;
  } catch { return false; }
}

/** Whether the delegation `id` is still running in this process or on the board. */
export function isRunningDelegation(id: string): boolean {
  const board = workerBoard().byDelegation(id);
  return isRunningWorkerSession(id) || (board !== undefined && !hasEnded(board));
}

/** Why `id` is not a finished editing delegation of this orchestrator
 *  session, or `undefined` when it is. */
export type EditingDelegationProblem =
  | { readonly kind: "running" }
  /** A worker's own worker: its edits count for `delegationId`. */
  | { readonly kind: "nested"; readonly delegationId: string }
  /** A delegation of this session that did not edit. */
  | { readonly kind: "research" }
  | { readonly kind: "unknown" }
  | { readonly kind: "other-session" };

/** The problem with judging `id` as an editing delegation, if any, and its
 *  edits as `records`, the record folder in file order, name them. */
export function editingDelegationProblem(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, records: readonly RoutingRecord[],
  id: string): { readonly problem: EditingDelegationProblem } | { readonly problem?: undefined; readonly edits: Extract<DelegationEdits, { kind: "edited" }> } {
  if (isRunningDelegation(id)) return { problem: { kind: "running" } };
  const edits = delegationEdits(records, id);
  if (edits.kind === "nested") return { problem: { kind: "nested", delegationId: edits.delegationId } };
  if (edits.kind === "none") {
    const known = isOwnDelegation(ctx, id) || records.some((record) => record.delegationId === id);
    return { problem: { kind: known ? "research" : "unknown" } };
  }
  if (edits.orchestratorSession !== ctx.sessionManager.getSessionId()) return { problem: { kind: "other-session" } };
  return { edits };
}
