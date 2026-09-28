// Ticket 25: review verdicts (stories 31 and 32).
//
//   1. Recording. The orchestrator records every verdict itself, whoever did
//      the checking (ADR 0010), with `subagents_verdict`
//      (../subagents/verdict.ts): `accept` or `request_changes`, and nothing
//      else. A verdict the gate required and nobody recorded is a missing
//      verdict, which the routing report derives (./routing-report.ts); it is
//      never recorded as a verdict.
//   2. Attaching. `attachVerdict` looks the delegation id up in the
//      record folder. A known id appends a `verdict` record linked to the
//      delegation's decision: its routing decision, its fork or agent-model
//      record, or, for an editing delegation the router did not route (routing
//      off, or switched off by an error), its edit record. An unknown id
//      appends an `orphaned-verdict` record. Both go into the day file of the
//      verdict's own timestamp. The orchestrator's `subagents_verdict` passes
//      its reason on, whether the verdict rests on a same-rung review, and any
//      gate level raise it made. A retry's effort-ladder record is its link to
//      the failed attempt: the verdict attaches to it only when the retry has
//      no decision record, as with routing off. A line of the delegation
//      that cannot be read refuses the verdict (UnreadableDelegationRecordError):
//      the record it would attach to may be the one missing.
//   3. Learning data. A verdict attached to a decision that chose a rung is
//      also recorded in ticket 08's observation ledger as a
//      `verified-task-outcome`: taskType is the classifier's kind of work,
//      instance is the delegation id, so a second attach replaces rather than
//      adds (the ledger dedupes on model, taskType and instance). The model is
//      the one that ran the work: the chosen rung's model in live mode, the
//      hand-picked model in shadow mode (owner decision, 2026-09-25), with the
//      router's rung in the note. An orphan, a refused decision and a
//      delegation the router did not route record no observation, and neither
//      does an ungated delegation or a missing verdict.

import { existsSync } from "node:fs";
import {
  emptyRefreshState,
  loadRefreshState,
  recordCapabilityObservation,
  saveRefreshState,
  type CapabilityObservation,
} from "../catalog/refresh-lifecycle.ts";
import {
  appendRoutingRecord,
  DECISION_RECORD_SCHEMA_VERSION,
  isRoutedDecision,
  readRoutingRecordsJudging,
  type AgentModelRecord,
  type EditRecord,
  type ForkRecord,
  type GateLevelRaise,
  type RoutedDecisionRecord,
  type RoutingRecord,
  type Verdict,
} from "./decision-record.ts";

export interface AttachVerdictInput {
  readonly recordDir: string;
  /** Ticket 18's delegation id of the reviewed work. */
  readonly delegationId: string;
  readonly verdict: Verdict;
  /** Why the orchestrator judged so; an attached verdict records it, an orphan does not. */
  readonly reason?: string;
  /** The verdict rests on a same-rung review (ADR 0010); an attached verdict records it. */
  readonly sameRungReview?: boolean;
  /** The orchestrator raised the gate level for this delegation (ADR 0011); an attached verdict records it. */
  readonly gateLevelRaise?: GateLevelRaise;
  /** Defaults to now. */
  readonly at?: Date;
  /** Ticket 08's refresh state file holding the observation ledger. */
  readonly refreshStatePath: string;
}

/** A record a verdict attaches to: the delegation's decision of some kind. */
export type VerdictTarget = RoutedDecisionRecord | ForkRecord | AgentModelRecord | EditRecord;

export type AttachVerdictOutcome =
  | {
      readonly status: "attached";
      readonly recordPath: string;
      readonly decision: VerdictTarget;
      /** Absent for a refused decision and a delegation the router did not route. */
      readonly observation?: CapabilityObservation;
    }
  | { readonly status: "orphaned"; readonly recordPath: string };

/** The observation a verdict yields, or `undefined` when it yields none. */
function observationFor(decision: RoutedDecisionRecord, verdict: Verdict, observedAt: string): CapabilityObservation | undefined {
  if (decision.recordType === "effort-ladder" || decision.route.outcome !== "chosen") return undefined;
  const { rung } = decision.route;
  const model = decision.mode === "shadow" ? decision.handPickedModel : rung.model;
  if (model === undefined) return undefined;
  return {
    model,
    taskType: decision.classification.kindOfWork,
    instance: decision.delegationId,
    source: "verified-task-outcome",
    outcome: verdict === "accept" ? "pass" : "fail",
    observedAt,
    note:
      `${decision.mode} decision; router rung ${rung.rung}; ` +
      `verdict ${verdict}${decision.mode === "shadow" ? `; ran on the hand-picked ${model}` : ""}`,
  };
}

function isDecisionOfSomeKind(record: RoutingRecord): record is RoutedDecisionRecord | ForkRecord | AgentModelRecord {
  return isRoutedDecision(record) || record.recordType === "fork" || record.recordType === "agent-model";
}

export function attachVerdict(input: AttachVerdictInput): AttachVerdictOutcome {
  const timestamp = (input.at ?? new Date()).toISOString();
  // Lines of other delegations this reader cannot validate are skipped; one of
  // this delegation's throws, as the verdict cannot be judged without it (pi-orchestrator-zb6t).
  const entries = readRoutingRecordsJudging(input.recordDir, [input.delegationId]).entries.filter((entry) => entry.record.delegationId === input.delegationId);
  // An effort-ladder record stands in only for a retry without a decision
  // record, and an edit record only when the delegation has no decision at all.
  const latest = entries.filter((entry) => isDecisionOfSomeKind(entry.record) && entry.record.recordType !== "effort-ladder").at(-1) ??
    entries.filter((entry) => entry.record.recordType === "effort-ladder").at(-1) ??
    entries.filter((entry) => entry.record.recordType === "edit").at(-1);
  if (latest === undefined) {
    const recordPath = appendRoutingRecord(input.recordDir, {
      recordType: "orphaned-verdict",
      schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
      delegationId: input.delegationId,
      timestamp,
      verdict: input.verdict,
    });
    return { status: "orphaned", recordPath };
  }
  const decision = latest.record as VerdictTarget;
  const recordPath = appendRoutingRecord(input.recordDir, {
    recordType: "verdict",
    schemaVersion: DECISION_RECORD_SCHEMA_VERSION,
    delegationId: input.delegationId,
    timestamp,
    verdict: input.verdict,
    decisionFile: latest.file,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.sameRungReview === true ? { sameRungReview: true } : {}),
    ...(input.gateLevelRaise === undefined ? {} : { gateLevelRaise: input.gateLevelRaise }),
  });
  // Only a routing decision teaches the router: a fork, an agent's named model
  // and an unrouted worker chose no rung.
  const observation = isRoutedDecision(decision) ? observationFor(decision, input.verdict, timestamp) : undefined;
  if (observation === undefined) return { status: "attached", recordPath, decision };
  const state = existsSync(input.refreshStatePath) ? loadRefreshState(input.refreshStatePath) : emptyRefreshState();
  saveRefreshState(input.refreshStatePath, recordCapabilityObservation(state, observation));
  return { status: "attached", recordPath, decision, observation };
}
