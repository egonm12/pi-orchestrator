// Ticket 25: review verdicts (stories 30 to 32).
//
//   1. Reading. The reviewer agent (./verdict-reviewer.md) declares
//      pi-subagents' `outputSchema` with a required `verdict` enum. pi-subagents
//      validates the child's `structured_output` call against it and hands the
//      value to the parent as the result's `structuredOutput`.
//      `verdictFromReviewResult` reads that field and nothing else: a result
//      without it, or with a value outside the enum, is `missing`. Prose is
//      never parsed.
//   2. Attaching. `attachVerdict` looks the delegation id up in the
//      record folder. A known id appends a `verdict` record linked to the
//      delegation's decision: its routing decision, its fork or agent-model
//      record, or, for an editing delegation the router did not route (routing
//      off, or switched off by an error), its edit record. An unknown id
//      appends an `orphaned-verdict` record. Both go into the day file of the
//      verdict's own timestamp. The orchestrator's `subagents_verdict`
//      (../subagents/verdict.ts) passes its reason on.
//   3. Learning data. An `accept` or `request_changes` attached to a decision
//      that chose a rung is also recorded in ticket 08's observation ledger as
//      a `verified-task-outcome`: taskType is the classifier's kind of work,
//      instance is the delegation id, so a second attach replaces rather than
//      adds (the ledger dedupes on model, taskType and instance). The model is
//      the one that ran the work: the chosen rung's model in live mode, the
//      hand-picked model in shadow mode (owner decision, 2026-09-25), with the
//      router's rung in the note. `missing`, an orphan, a refused decision
//      and a delegation the router did not route record no observation.

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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
  readRoutingRecordEntries,
  type AgentModelRecord,
  type EditRecord,
  type ForkRecord,
  type RoutedDecisionRecord,
  type RoutingRecord,
  type Verdict,
} from "./decision-record.ts";

export const REVIEW_VERDICTS = ["accept", "request_changes"] as const;
export type ReviewVerdict = (typeof REVIEW_VERDICTS)[number];

/** The schema `verdict-reviewer.md` declares in its frontmatter. A test checks
 *  the two are equal. */
export const VERDICT_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: [...REVIEW_VERDICTS] },
    summary: { type: "string" },
  },
  required: ["verdict"],
  additionalProperties: false,
} as const;

export const VERDICT_REVIEWER_AGENT = "verdict-reviewer";

const VERDICT_REVIEWER_SOURCE = fileURLToPath(new URL("./verdict-reviewer.md", import.meta.url));

/** Copy the reviewer definition into `<agentDir>/agents/`, where pi-subagents
 *  discovers user agents. For throwaway agent dirs only; returns the path. */
export function installVerdictReviewer(agentDir: string): string {
  const agents = join(agentDir, "agents");
  mkdirSync(agents, { recursive: true });
  const target = join(agents, `${VERDICT_REVIEWER_AGENT}.md`);
  copyFileSync(VERDICT_REVIEWER_SOURCE, target);
  return target;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The verdict in a pi-subagents review result (`SingleResult`, or anything
 *  with its `structuredOutput` field). Only `structuredOutput.verdict` is
 *  read; every other field, prose included, is ignored. */
export function verdictFromReviewResult(result: unknown): Verdict {
  if (!isObject(result)) return "missing";
  const structured = result.structuredOutput;
  if (!isObject(structured)) return "missing";
  const verdict = structured.verdict;
  return REVIEW_VERDICTS.includes(verdict as ReviewVerdict) ? (verdict as ReviewVerdict) : "missing";
}

export interface AttachVerdictInput {
  readonly recordDir: string;
  /** Ticket 18's delegation id of the reviewed work. */
  readonly delegationId: string;
  readonly verdict: Verdict;
  /** Why the orchestrator judged so; an attached verdict records it, an orphan does not. */
  readonly reason?: string;
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
      /** Absent for `missing` and for a refused decision. */
      readonly observation?: CapabilityObservation;
    }
  | { readonly status: "orphaned"; readonly recordPath: string };

/** The observation a verdict yields, or `undefined` when it yields none. */
function observationFor(decision: RoutedDecisionRecord, verdict: Verdict, observedAt: string): CapabilityObservation | undefined {
  if (decision.recordType === "effort-ladder" || verdict === "missing" || decision.route.outcome !== "chosen") return undefined;
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
  const entries = readRoutingRecordEntries(input.recordDir).filter((entry) => entry.record.delegationId === input.delegationId);
  // An edit record stands in only when the delegation has no decision at all.
  const latest = entries.filter((entry) => isDecisionOfSomeKind(entry.record)).at(-1) ??
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
  });
  // Only a routing decision teaches the router: a fork, an agent's named model
  // and an unrouted worker chose no rung.
  const observation = isRoutedDecision(decision) ? observationFor(decision, input.verdict, timestamp) : undefined;
  if (observation === undefined) return { status: "attached", recordPath, decision };
  const state = existsSync(input.refreshStatePath) ? loadRefreshState(input.refreshStatePath) : emptyRefreshState();
  saveRefreshState(input.refreshStatePath, recordCapabilityObservation(state, observation));
  return { status: "attached", recordPath, decision, observation };
}
