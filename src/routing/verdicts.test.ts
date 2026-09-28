import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadRefreshState, type CapabilityObservation } from "../catalog/refresh-lifecycle.ts";
import {
  fixtureClassification,
  fixtureRefusal,
  fixtureRoute,
  fixtureTierMap,
  OPUS,
  SONNET,
} from "../fixtures/routing-decision.ts";
import {
  readRoutingRecords,
  validateRoutingRecord,
  writeDecisionRecord,
  type DecisionRecordInput,
  type OrphanedVerdictRecord,
  type VerdictRecord,
} from "./decision-record.ts";
import { attachVerdict } from "./verdicts.ts";

// Ticket 25, stories 31 and 32. Seam: `attachVerdict` over a record folder
// and ticket 08's ledger file. Verdicts are no longer read from a reviewer's
// structured output (l8af): the orchestrator records every one.

const DECIDED_AT = new Date("2026-09-25T09:30:00.000Z");
const REVIEWED_AT = new Date("2026-09-25T11:00:00.000Z");
const TASK = "Add a CSV export button to the reports page and wire it to the existing export service.";

interface Folder {
  readonly dir: string;
  readonly records: string;
  readonly ledger: string;
  cleanup(): void;
}

function folder(): Folder {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-verdicts-"));
  return {
    dir,
    records: join(dir, "routing"),
    ledger: join(dir, "refresh-state.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function decide(records: string, overrides: Partial<DecisionRecordInput> = {}) {
  const tierMap = fixtureTierMap();
  const route = overrides.route ?? fixtureRoute("standard", tierMap);
  return writeDecisionRecord(records, {
    delegationId: "attempt-1",
    at: DECIDED_AT,
    mode: "live",
    taskText: TASK,
    agentRole: "worker",
    classification: await fixtureClassification(TASK, "standard", "implement"),
    tierMap,
    route,
    ...overrides,
    ranOn: overrides.ranOn ?? (overrides.mode === "shadow" ? overrides.handPickedModel : route.ok ? route.rung.rung : "anthropic/claude-haiku-4-5"),
  } as DecisionRecordInput);
}

function verifiedOutcomes(ledger: string): CapabilityObservation[] {
  if (!existsSync(ledger)) return [];
  return loadRefreshState(ledger).observations.filter((observation) => observation.source === "verified-task-outcome");
}

// ---------------------------------------------------------------------------
// Checkbox 6 (story 32): attach by delegation id, orphans kept
// ---------------------------------------------------------------------------

test("a verdict with a known delegation id is attached to that decision and one with an unknown id is stored as orphaned", async () => {
  const f = folder();
  try {
    const decided = await decide(f.records);
    const attached = attachVerdict({ recordDir: f.records, delegationId: "attempt-1", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.equal(attached.decision.delegationId, "attempt-1");
    assert.equal(attached.recordPath, decided.path, "same day, same file");

    const orphaned = attachVerdict({ recordDir: f.records, delegationId: "attempt-unknown", verdict: "request_changes", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(orphaned.status, "orphaned");

    const records = readRoutingRecords(f.records);
    assert.deepEqual(records.map((record) => [record.recordType, record.delegationId]), [
      ["decision", "attempt-1"],
      ["verdict", "attempt-1"],
      ["orphaned-verdict", "attempt-unknown"],
    ]);
    const verdict = records[1] as VerdictRecord;
    assert.equal(verdict.schemaVersion, "decision-record/3");
    assert.equal(verdict.verdict, "accept");
    assert.equal(verdict.decisionFile, "2026-09-25.jsonl");
    assert.equal(verdict.timestamp, REVIEWED_AT.toISOString());
    assert.equal((records[2] as OrphanedVerdictRecord).schemaVersion, "decision-record/3");
    assert.equal((records[2] as OrphanedVerdictRecord).verdict, "request_changes");
    for (const record of [verdict, records[2]!]) {
      assert.throws(() => validateRoutingRecord({ ...record, ranOn: "anthropic/claude-haiku-4-5" }), /field 'ranOn' is not a known field/);
      assert.throws(() => validateRoutingRecord({ ...record, surprise: true }), /field 'surprise' is not a known field/);
      assert.equal(validateRoutingRecord({ ...record, schemaVersion: "decision-record/2" }).schemaVersion, "decision-record/2");
    }
    assert.deepEqual(verifiedOutcomes(f.ledger).map((o) => o.instance), ["attempt-1"], "an orphan records no observation");
  } finally {
    f.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Checkbox 7 (story 32): one verified-task-outcome per attempt
// ---------------------------------------------------------------------------

test("an attached verdict puts one verified-task-outcome in the ledger for that rung and kind of work, and a second attach adds none", async () => {
  const f = folder();
  try {
    await decide(f.records);
    attachVerdict({ recordDir: f.records, delegationId: "attempt-1", verdict: "request_changes", at: REVIEWED_AT, refreshStatePath: f.ledger });
    let outcomes = verifiedOutcomes(f.ledger);
    assert.equal(outcomes.length, 1);
    assert.deepEqual(
      { ...outcomes[0], note: undefined },
      {
        model: SONNET,
        taskType: "implement",
        instance: "attempt-1",
        source: "verified-task-outcome",
        outcome: "fail",
        observedAt: REVIEWED_AT.toISOString(),
        note: undefined,
      },
    );
    assert.match(outcomes[0]!.note ?? "", /rung anthropic\/claude-sonnet-5:medium/);

    attachVerdict({ recordDir: f.records, delegationId: "attempt-1", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    outcomes = verifiedOutcomes(f.ledger);
    assert.equal(outcomes.length, 1, "the ledger dedupes on the delegation id");
    assert.equal(outcomes[0]!.outcome, "pass", "the newest verdict is kept");
    assert.equal(loadRefreshState(f.ledger).observations.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a verdict of missing is refused: a missing verdict is derived by the routing report, never recorded", async () => {
  const f = folder();
  try {
    await decide(f.records);
    assert.throws(() => attachVerdict({ recordDir: f.records, delegationId: "attempt-1", verdict: "missing" as never, at: REVIEWED_AT, refreshStatePath: f.ledger }),
      /field 'verdict' must be one of accept, request_changes; got "missing"/);
    assert.deepEqual(readRoutingRecords(f.records).map((record) => record.recordType), ["decision"]);
    assert.equal(existsSync(f.ledger), false, "the ledger is not touched");
  } finally {
    f.cleanup();
  }
});

// Supervisor decision (2026-09-25): the ledger holds evidence about the model
// that ran the work. In shadow mode that is the hand-picked model, not the
// router's rung; the rung stays recoverable from the observation's note.
test("a shadow verdict credits the hand-picked model that ran the work, with the router's rung in the note", async () => {
  const f = folder();
  try {
    await decide(f.records, { delegationId: "attempt-shadow", mode: "shadow", handPickedModel: OPUS } as Partial<DecisionRecordInput>);
    attachVerdict({ recordDir: f.records, delegationId: "attempt-shadow", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    const [outcome] = verifiedOutcomes(f.ledger);
    assert.equal(outcome?.model, OPUS);
    assert.equal(outcome?.outcome, "pass");
    assert.match(outcome?.note ?? "", /shadow/);
    assert.match(outcome?.note ?? "", /rung anthropic\/claude-sonnet-5:medium/);
  } finally {
    f.cleanup();
  }
});

test("a verdict on a refused decision is attached but records no observation", async () => {
  const f = folder();
  try {
    await decide(f.records, { delegationId: "attempt-refused", route: fixtureRefusal("elevated") });
    const outcome = attachVerdict({ recordDir: f.records, delegationId: "attempt-refused", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(outcome.status, "attached");
    assert.deepEqual(verifiedOutcomes(f.ledger), []);
    assert.equal(existsSync(f.ledger), false);
  } finally {
    f.cleanup();
  }
});
