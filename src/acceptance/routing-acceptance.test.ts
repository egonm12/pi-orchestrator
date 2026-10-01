import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fixtureClassification, fixtureRefusal, fixtureRoute, fixtureTierMap, HAIKU as FIXTURE_HAIKU, OPUS, SONNET } from "../fixtures/routing-decision.ts";
import type { RiskTier } from "../routing/classifier.ts";
import {
  appendRoutingRecord,
  buildEditRecord,
  buildGateRequirementRecord,
  writeDecisionRecord,
  type Verdict,
} from "../routing/decision-record.ts";
import { attachVerdict } from "../routing/verdicts.ts";

// The routing report check, hand-computed: routing-report.ts over a records
// folder whose counts are known by construction. No pi, no spend.
//
// The live routing acceptance gate that ran real pi sessions with workers
// started through the external pi-subagents package was retired by owner
// decision: pi-subagents cannot carry the auto model, a pi virtual model
// (ADR 0014), into its in-process children.

// ---------------------------------------------------------------------------
// The report check, hand-computed
// ---------------------------------------------------------------------------

interface ExpectedReportRow {
  readonly tier: RiskTier;
  /** `null` for the refused row. */
  readonly rung: string | null;
  readonly decisions: number;
  readonly verdicts: readonly Verdict[];
  /** Editing delegations whose required verdict was never recorded; none when absent. */
  readonly missing?: number;
  readonly shadowDecisions: number;
  readonly shadowAgreements: number;
}

function expectedCounts(row: Omit<ExpectedReportRow, "tier" | "rung">): string {
  const count = (verdict: Verdict) => row.verdicts.filter((value) => value === verdict).length;
  const agreement = row.shadowDecisions === 0
    ? "n/a (no shadow decisions)"
    : `${row.shadowAgreements} of ${row.shadowDecisions} (${Math.round((row.shadowAgreements / row.shadowDecisions) * 100)}%)`;
  // No verdict here rests on a same-rung review, and no delegation is ungated.
  return `decisions ${row.decisions}, accept ${count("accept")}, request_changes ${count("request_changes")}, same-rung accept 0, same-rung request_changes 0, ` +
    `ungated 0, missing ${row.missing ?? 0}, shadow agreement ${agreement}`;
}

/** The report the test expects, written from its own list of rows in the
 *  report's line format, never from `buildRoutingReport`. */
function expectedReport(folder: string, rows: readonly ExpectedReportRow[], orphanedVerdicts: number): string {
  const total = {
    decisions: rows.reduce((sum, row) => sum + row.decisions, 0),
    verdicts: rows.flatMap((row) => row.verdicts),
    missing: rows.reduce((sum, row) => sum + (row.missing ?? 0), 0),
    shadowDecisions: rows.reduce((sum, row) => sum + row.shadowDecisions, 0),
    shadowAgreements: rows.reduce((sum, row) => sum + row.shadowAgreements, 0),
  };
  return [
    `routing report for ${folder}`,
    ...rows.map((row) => `tier ${row.tier}, ${row.rung === null ? "refused" : `rung ${row.rung}`}: ${expectedCounts(row)}`),
    `all: ${expectedCounts(total)}`,
    `orphaned verdicts: ${orphanedVerdicts}`,
    // Every delegation here is routed.
    "unrouted delegations: accept 0, request_changes 0, same-rung accept 0, same-rung request_changes 0, ungated 0, missing 0",
    "",
  ].join("\n");
}

const REPORT_SCRIPT = fileURLToPath(new URL("../routing/routing-report.ts", import.meta.url));

function runRoutingReport(folder: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [REPORT_SCRIPT, folder], { encoding: "utf8", timeout: 60_000 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// Offline seam: the report check above, against a folder whose counts are known
// by construction. No pi. This is where a change to
// the report's counting (verdicts once per delegation id, newest wins; missing
// verdicts from gate requirements; orphans once; explicit records nowhere;
// shadow agreement) is caught without spend.
test("the hand-computed report equals routing-report.ts over a folder with known counts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-acceptance-report-"));
  try {
    const records = join(dir, "routing");
    const ledger = join(dir, "refresh-state.json");
    const at = new Date("2026-09-26T09:00:00.000Z");
    const later = new Date("2026-09-26T10:00:00.000Z");
    const latest = new Date("2026-09-26T11:00:00.000Z");
    const tierMap = fixtureTierMap();
    const task = "Reformat src/report.ts with prettier.";
    const mechanical = await fixtureClassification(task, "mechanical", "implement");
    const common = { at, taskText: task, agentRole: "worker", classification: mechanical, tierMap };
    writeDecisionRecord(records, { ...common, delegationId: "m-live", mode: "live", ranOn: `${FIXTURE_HAIKU}:low`, route: fixtureRoute("mechanical", tierMap) });
    writeDecisionRecord(records, { ...common, delegationId: "m-shadow-agrees", mode: "shadow", handPickedModel: FIXTURE_HAIKU, ranOn: FIXTURE_HAIKU, route: fixtureRoute("mechanical", tierMap) });
    writeDecisionRecord(records, { ...common, delegationId: "m-shadow-differs", mode: "shadow", handPickedModel: OPUS, ranOn: OPUS, route: fixtureRoute("mechanical", tierMap) });
    writeDecisionRecord(records, {
      ...common,
      delegationId: "s-live",
      mode: "live",
      ranOn: `${SONNET}:medium`,
      classification: await fixtureClassification(task, "standard", "implement"),
      route: fixtureRoute("standard", tierMap),
    });
    writeDecisionRecord(records, {
      ...common,
      delegationId: "e-refused",
      mode: "live",
      ranOn: FIXTURE_HAIKU,
      classification: await fixtureClassification(task, "elevated", "implement"),
      route: fixtureRefusal("elevated", tierMap),
    });
    const attach = (delegationId: string, verdict: Verdict, when: Date) => attachVerdict({ recordDir: records, delegationId, verdict, at: when, refreshStatePath: ledger });
    attach("m-live", "accept", later);
    attach("m-shadow-agrees", "request_changes", later);
    attach("m-shadow-agrees", "accept", latest);
    // An editing delegation the gate required a spot check of, never judged: a missing verdict.
    appendRoutingRecord(records, buildEditRecord({ delegationId: "m-shadow-differs", orchestratorSession: "orchestrator-1", tool: "write", at: later }));
    appendRoutingRecord(records, buildGateRequirementRecord({ delegationId: "m-shadow-differs", gateLevel: "medium", gateAction: "spot-check", at: later }));
    attach("e-refused", "request_changes", later);
    attach("no-such-attempt", "request_changes", later);
    attach("no-such-attempt", "accept", latest);

    const expected = expectedReport(records, [
      { tier: "mechanical", rung: `${FIXTURE_HAIKU}:low`, decisions: 3, verdicts: ["accept", "accept"], missing: 1, shadowDecisions: 2, shadowAgreements: 1 },
      { tier: "standard", rung: "anthropic/claude-sonnet-5:medium", decisions: 1, verdicts: [], shadowDecisions: 0, shadowAgreements: 0 },
      { tier: "elevated", rung: null, decisions: 1, verdicts: ["request_changes"], shadowDecisions: 0, shadowAgreements: 0 },
    ], 1);
    const run = runRoutingReport(records);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, expected);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
