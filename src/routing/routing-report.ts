// Ticket 25: the routing report (story 33).
//
//   npm run routing:report -- <folder>
//   node harness/routing/routing-report.ts <folder>
//
// Reads the record folder's day files and nothing else (no settings, no
// ledger, no agent dir), and prints one line per tier and rung: decisions,
// verdicts by kind, same-rung verdicts, ungated delegations, missing verdicts
// and the shadow agreement rate, then the totals, the unclassified decision
// count, the orphaned verdict count, the same counts for unrouted delegations
// and each decision's classification with its reason.
//
//   - A decision's row is the tier and rung it chose, or `<tier routing
//     started at>, refused` when the router refused: the classified tier,
//     unless a routing constraint raised it or forced a rung.
//   - Verdicts count once per delegation id, the newest winning, as ticket 08's
//     ledger does. A decision with no verdict yet counts in no verdict column.
//     A verdict backed by a same-rung review (ADR 0010) counts in the same-rung
//     columns instead of accept or request_changes.
//   - Ungated and missing (ADR 0010, ADR 0011) come from each editing
//     delegation's latest gate requirement record, written when a run of it
//     that edited ends. Gate action none makes it ungated, whether or not it
//     got a verdict anyway. Any other gate action with no verdict after the
//     delegation's latest edit record is a missing verdict, so a verdict
//     recorded later, after a resume say, removes it. Neither is a verdict or
//     a learning observation, and each counts once per delegation id.
//   - Shadow agreement: of the shadow decisions in the row, the share whose
//     chosen rung's model equals the hand-picked model. A refused shadow
//     decision chose no rung, so it does not agree.
//   - Orphaned verdicts count once per delegation id.
//   - Unclassified decisions (CONTEXT.md, Unclassified task) count the
//     decisions whose cause is `unclassified`: no classifier model could
//     classify the task.
//   - Each decision's classification line gives its tier, its cause and the
//     model's reason (`why`), so a reviewer argues with the reason. A record
//     written before ADR 0015 whose keyword floor was set also names the floor.
//   - A delegation the router did not route (a forked worker, an agent
//     definition's named model, a worker that ran with routing off) has no
//     row: its verdict, ungated delegation or missing verdict counts in its own
//     line, once per delegation id.
//   - Edit records (ADR 0010) mark editing delegations; they are not counted.
//   - An effort-ladder record is a retry's link to the attempt it climbs
//     from (ADR 0010), not its routing decision: each is listed on its own
//     line. The retry's row is its decision record's; a retry with routing
//     off has none, so it counts as an unrouted delegation.
//   - Ticket 27's `explicit` records (a call that named its own model) are
//     not routing decisions and are not counted.
//
// Only ./decision-record.ts (and through it the tier list) is imported, so
// running this loads no other harness module.

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RISK_TIERS, type RiskTier } from "./tiers.ts";
import {
  readRoutingRecords,
  RoutingRecordError,
  type DecisionRecord,
  type EffortLadderRecord,
  type GateRequirementRecord,
  type RecordFolderReader,
  type Verdict,
  type VerdictRecord,
} from "./decision-record.ts";

/** What the quality gate left for a set of delegations. */
export interface GateCounts {
  /** Latest verdicts by kind, same-rung ones left out. */
  readonly verdicts: Readonly<Record<Verdict, number>>;
  /** Latest verdicts backed by a same-rung review, by kind. */
  readonly sameRungVerdicts: Readonly<Record<Verdict, number>>;
  /** Editing delegations whose latest gate requirement was gate action none. */
  readonly ungated: number;
  /** Editing delegations whose latest gate requirement needs a verdict that
   *  was not recorded after their latest edit. */
  readonly missing: number;
}

export interface RoutingReportRow extends GateCounts {
  readonly tier: RiskTier;
  /** The chosen rung, or `null` for the refused row. */
  readonly rung: string | null;
  readonly decisions: number;
  readonly shadowDecisions: number;
  readonly shadowAgreements: number;
}

/** A decision's classification: what gave its tier, and why. */
export interface ReportedClassification {
  readonly delegationId: string;
  readonly tier: RiskTier;
  readonly cause: string;
  readonly why: string;
  /** The keyword floor of a record written before ADR 0015, when it was set. */
  readonly floor?: string;
}

export interface RoutingReport {
  readonly rows: readonly RoutingReportRow[];
  readonly totals: Omit<RoutingReportRow, "tier" | "rung">;
  /** Decisions no classifier model could classify. */
  readonly unclassified: number;
  /** One per decision, in the order the decisions were first written. */
  readonly classifications: readonly ReportedClassification[];
  readonly orphanedVerdicts: number;
  /** The same counts for delegations without a routing decision. */
  readonly unrouted: GateCounts;
  readonly ladders: readonly EffortLadderRecord[];
}

interface MutableGateCounts {
  verdicts: Record<Verdict, number>;
  sameRungVerdicts: Record<Verdict, number>;
  ungated: number;
  missing: number;
}

interface MutableRow extends MutableGateCounts {
  tier: RiskTier;
  rung: string | null;
  decisions: number;
  shadowDecisions: number;
  shadowAgreements: number;
}

function emptyGateCounts(): MutableGateCounts {
  return { verdicts: { accept: 0, request_changes: 0 }, sameRungVerdicts: { accept: 0, request_changes: 0 }, ungated: 0, missing: 0 };
}

function emptyCounts(): Omit<MutableRow, "tier" | "rung"> {
  return { decisions: 0, ...emptyGateCounts(), shadowDecisions: 0, shadowAgreements: 0 };
}

function rowKey(decision: DecisionRecord): { tier: RiskTier; rung: string | null } {
  return decision.route.outcome === "chosen"
    ? { tier: decision.route.tier, rung: decision.route.rung.rung }
    : { tier: decision.route.startedAtTier, rung: null };
}

function agrees(decision: DecisionRecord): boolean {
  return decision.route.outcome === "chosen" && decision.route.rung.model === decision.handPickedModel;
}

/** One delegation's latest verdict and what its latest gate requirement left. */
interface DelegationGate {
  verdict?: VerdictRecord;
  requirement?: GateRequirementRecord;
  /** A verdict was recorded after the delegation's latest edit record. */
  judgedSinceEdit: boolean;
}

function countGate(counts: MutableGateCounts, gate: DelegationGate | undefined): void {
  if (gate === undefined) return;
  if (gate.verdict !== undefined) (gate.verdict.sameRungReview ? counts.sameRungVerdicts : counts.verdicts)[gate.verdict.verdict] += 1;
  if (gate.requirement?.gateAction === "none") counts.ungated += 1;
  else if (gate.requirement !== undefined && !gate.judgedSinceEdit) counts.missing += 1;
}

export function buildRoutingReport(folder: string, reader?: RecordFolderReader): RoutingReport {
  const records = readRoutingRecords(folder, reader);
  const decisions = new Map<string, DecisionRecord>();
  const ladders: EffortLadderRecord[] = [];
  const gates = new Map<string, DelegationGate>();
  const gateOf = (delegationId: string): DelegationGate => {
    const gate = gates.get(delegationId) ?? { judgedSinceEdit: false };
    gates.set(delegationId, gate);
    return gate;
  };
  const orphans = new Set<string>();
  for (const record of records) {
    if (record.recordType === "decision") decisions.set(record.delegationId, record);
    else if (record.recordType === "effort-ladder") ladders.push(record);
    else if (record.recordType === "verdict") {
      const gate = gateOf(record.delegationId);
      gate.verdict = record;
      gate.judgedSinceEdit = true;
    } else if (record.recordType === "edit") gateOf(record.delegationId).judgedSinceEdit = false;
    else if (record.recordType === "gate-requirement") gateOf(record.delegationId).requirement = record;
    else if (record.recordType === "orphaned-verdict") orphans.add(record.delegationId);
    // An `explicit` record (ticket 27) routed nothing: no row, no orphan.
  }
  const unrouted = emptyGateCounts();
  for (const [delegationId, gate] of gates) if (!decisions.has(delegationId)) countGate(unrouted, gate);

  const rows = new Map<string, MutableRow>();
  const totals = emptyCounts();
  for (const decision of decisions.values()) {
    const { tier, rung } = rowKey(decision);
    const key = `${tier}\u0000${rung ?? ""}`;
    const row = rows.get(key) ?? { tier, rung, ...emptyCounts() };
    rows.set(key, row);
    const gate = gates.get(decision.delegationId);
    for (const counts of [row, totals]) {
      counts.decisions += 1;
      countGate(counts, gate);
      if (decision.mode === "shadow") {
        counts.shadowDecisions += 1;
        if (agrees(decision)) counts.shadowAgreements += 1;
      }
    }
  }

  const ordered = [...rows.values()].sort((a, b) => {
    const byTier = RISK_TIERS.indexOf(a.tier) - RISK_TIERS.indexOf(b.tier);
    if (byTier !== 0) return byTier;
    if (a.rung === null) return 1;
    if (b.rung === null) return -1;
    return a.rung < b.rung ? -1 : a.rung > b.rung ? 1 : 0;
  });
  const classifications = [...decisions.values()].map(({ delegationId, classification: { tier, cause, why, floor } }): ReportedClassification =>
    ({ delegationId, tier, cause, why, ...(floor === undefined || floor === "none" ? {} : { floor }) }));
  const unclassified = classifications.filter((classification) => classification.cause === "unclassified").length;
  return { rows: ordered, totals, unclassified, classifications, orphanedVerdicts: orphans.size, unrouted, ladders };
}

function agreement(shadowDecisions: number, shadowAgreements: number): string {
  if (shadowDecisions === 0) return "n/a (no shadow decisions)";
  return `${shadowAgreements} of ${shadowDecisions} (${Math.round((shadowAgreements / shadowDecisions) * 100)}%)`;
}

function gateCounts(gate: GateCounts): string {
  return (
    `accept ${gate.verdicts.accept}, request_changes ${gate.verdicts.request_changes}, ` +
    `same-rung accept ${gate.sameRungVerdicts.accept}, same-rung request_changes ${gate.sameRungVerdicts.request_changes}, ` +
    `ungated ${gate.ungated}, missing ${gate.missing}`
  );
}

function counts(row: Omit<RoutingReportRow, "tier" | "rung">): string {
  return `decisions ${row.decisions}, ${gateCounts(row)}, shadow agreement ${agreement(row.shadowDecisions, row.shadowAgreements)}`;
}

export function renderRoutingReport(folder: string, report: RoutingReport): string {
  const lines = [`routing report for ${folder}`];
  for (const row of report.rows) {
    lines.push(`tier ${row.tier}, ${row.rung === null ? "refused" : `rung ${row.rung}`}: ${counts(row)}`);
  }
  lines.push(`all: ${counts(report.totals)}`);
  lines.push(`unclassified decisions: ${report.unclassified}`);
  lines.push(`orphaned verdicts: ${report.orphanedVerdicts}`);
  lines.push(`unrouted delegations: ${gateCounts(report.unrouted)}`);
  for (const { delegationId, tier, cause, why, floor } of report.classifications) {
    // One line each: a reason that spans lines is joined with spaces.
    lines.push(`classification ${delegationId}: ${tier}, ${cause}${floor === undefined ? "" : `, floor ${floor}`}: ${why.replace(/\s+/g, " ").trim()}`);
  }
  for (const ladder of report.ladders) {
    const climb = ladder.step === "unplaced" ? `unplaced (${ladder.detail})` : `${ladder.step}; ${ladder.route.tier} ${ladder.route.rung.rung}`;
    lines.push(`effort ladder: ${ladder.previousDecisionId} -> ${ladder.delegationId}; ${climb}${ladder.mode === "live" ? "" : `; ${ladder.mode}`}`);
  }
  return `${lines.join("\n")}\n`;
}

export function main(argv: readonly string[]): number {
  const [folder] = argv;
  if (folder === undefined || argv.length !== 1) {
    process.stderr.write("usage: node harness/routing/routing-report.ts <folder>\n");
    return 2;
  }
  if (!existsSync(folder)) {
    process.stderr.write(`routing report: no record folder at ${folder}\n`);
    return 1;
  }
  try {
    process.stdout.write(renderRoutingReport(folder, buildRoutingReport(folder)));
    return 0;
  } catch (error) {
    if (!(error instanceof RoutingRecordError)) throw error;
    process.stderr.write(`${error.message}\n`);
    return 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
