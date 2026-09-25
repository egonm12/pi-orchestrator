// Ticket 25: the routing report (story 33).
//
//   npm run routing:report -- <folder>
//   node harness/routing/routing-report.ts <folder>
//
// Reads the record folder's day files and nothing else (no settings, no
// ledger, no agent dir), and prints one line per tier and rung: decisions,
// verdicts by kind, and the shadow agreement rate, then the totals and the
// orphaned verdict count.
//
//   - A decision's row is the tier and rung it chose, or `<classified tier>,
//     refused` when the router refused.
//   - Verdicts count once per delegation id, the newest winning, as ticket 08's
//     ledger does. A decision with no verdict yet counts in no verdict column.
//   - Shadow agreement: of the shadow decisions in the row, the share whose
//     chosen rung's model equals the hand-picked model. A refused shadow
//     decision chose no rung, so it does not agree.
//   - Orphaned verdicts count once per delegation id.
//   - Ticket 27's `explicit` records (a call that named its own model) are
//     not routing decisions and are not counted.
//
// Only ./decision-record.ts (and through it the tier list) is imported, so
// running this loads no other harness module.

import { existsSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { RISK_TIERS, type RiskTier } from "./classifier.ts";
import {
  isRoutedDecision,
  readRoutingRecords,
  RoutingRecordError,
  type RoutedDecisionRecord,
  type EffortLadderRecord,
  type RecordFolderReader,
  type Verdict,
} from "./decision-record.ts";

export interface RoutingReportRow {
  readonly tier: RiskTier;
  /** The chosen rung, or `null` for the refused row. */
  readonly rung: string | null;
  readonly decisions: number;
  readonly verdicts: Readonly<Record<Verdict, number>>;
  readonly shadowDecisions: number;
  readonly shadowAgreements: number;
}

export interface RoutingReport {
  readonly rows: readonly RoutingReportRow[];
  readonly totals: Omit<RoutingReportRow, "tier" | "rung">;
  readonly orphanedVerdicts: number;
  readonly ladders: readonly EffortLadderRecord[];
}

interface MutableRow {
  tier: RiskTier;
  rung: string | null;
  decisions: number;
  verdicts: Record<Verdict, number>;
  shadowDecisions: number;
  shadowAgreements: number;
}

function emptyCounts(): Omit<MutableRow, "tier" | "rung"> {
  return { decisions: 0, verdicts: { accept: 0, request_changes: 0, missing: 0 }, shadowDecisions: 0, shadowAgreements: 0 };
}

function rowKey(decision: RoutedDecisionRecord): { tier: RiskTier; rung: string | null } {
  return decision.route.outcome === "chosen"
    ? { tier: decision.route.tier, rung: decision.route.rung.rung }
    : { tier: decision.route.startedAtTier, rung: null };
}

function agrees(decision: RoutedDecisionRecord): boolean {
  return decision.route.outcome === "chosen" && decision.recordType === "decision" && decision.route.rung.model === decision.handPickedModel;
}

export function buildRoutingReport(folder: string, reader?: RecordFolderReader): RoutingReport {
  const records = readRoutingRecords(folder, reader);
  const decisions = new Map<string, RoutedDecisionRecord>();
  const verdicts = new Map<string, Verdict>();
  const orphans = new Set<string>();
  for (const record of records) {
    if (isRoutedDecision(record)) decisions.set(record.delegationId, record);
    else if (record.recordType === "verdict") verdicts.set(record.delegationId, record.verdict);
    else if (record.recordType === "orphaned-verdict") orphans.add(record.delegationId);
    // An `explicit` record (ticket 27) routed nothing: no row, no orphan.
  }

  const rows = new Map<string, MutableRow>();
  const totals = emptyCounts();
  for (const decision of decisions.values()) {
    const { tier, rung } = rowKey(decision);
    const key = `${tier}\u0000${rung ?? ""}`;
    const row = rows.get(key) ?? { tier, rung, ...emptyCounts() };
    rows.set(key, row);
    const verdict = verdicts.get(decision.delegationId);
    for (const counts of [row, totals]) {
      counts.decisions += 1;
      if (verdict !== undefined) counts.verdicts[verdict] += 1;
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
  return { rows: ordered, totals, orphanedVerdicts: orphans.size, ladders: [...decisions.values()].filter((record): record is EffortLadderRecord => record.recordType === "effort-ladder") };
}

function agreement(shadowDecisions: number, shadowAgreements: number): string {
  if (shadowDecisions === 0) return "n/a (no shadow decisions)";
  return `${shadowAgreements} of ${shadowDecisions} (${Math.round((shadowAgreements / shadowDecisions) * 100)}%)`;
}

function counts(row: Omit<RoutingReportRow, "tier" | "rung">): string {
  return (
    `decisions ${row.decisions}, accept ${row.verdicts.accept}, request_changes ${row.verdicts.request_changes}, ` +
    `missing ${row.verdicts.missing}, shadow agreement ${agreement(row.shadowDecisions, row.shadowAgreements)}`
  );
}

export function renderRoutingReport(folder: string, report: RoutingReport): string {
  const lines = [`routing report for ${folder}`];
  for (const row of report.rows) {
    lines.push(`tier ${row.tier}, ${row.rung === null ? "refused" : `rung ${row.rung}`}: ${counts(row)}`);
  }
  lines.push(`all: ${counts(report.totals)}`);
  lines.push(`orphaned verdicts: ${report.orphanedVerdicts}`);
  for (const ladder of report.ladders) {
    lines.push(`effort ladder: ${ladder.previousDecisionId} -> ${ladder.delegationId}; ${ladder.step}; ${ladder.route.tier} ${ladder.route.rung.rung}`);
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
