import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FIXTURE_PROJECT_SETTINGS,
  fixtureClassification,
  fixturePersonalSettings,
  fixtureRefusal,
  fixtureRoute,
  fixtureTierMap,
  legacyExplicitRecord,
  SONNET,
} from "../fixtures/routing-decision.ts";
import {
  appendRoutingRecord,
  buildAgentModelRecord,
  buildEditRecord,
  buildEffortLadderRecord,
  buildFailoverRecord,
  buildForkRecord,
  buildGateRequirementRecord,
  buildUnplacedLadderRecord,
  DECISION_RECORD_SCHEMA_VERSION,
  decisionRecordPath,
  FREE_TEXT_LIMIT,
  readRoutingRecords,
  readRoutingRecordsJudging,
  readUsableRoutingRecordEntries,
  readUsableRoutingRecords,
  RoutingRecordError,
  TASK_TEXT_PREFIX_LIMIT,
  UnreadableDelegationRecordError,
  validateRoutingRecord,
  writeDecisionRecord,
  type DecisionRecord,
  type DecisionRecordInput,
  type RoutingRecord,
} from "./decision-record.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

// Ticket 25, stories 28 and 34. Seam: `writeDecisionRecord` and
// `buildDecisionRecord`, the public functions for one routing decision, with
// every value injected. The auto provider writes one record per worker's
// first request; here it is two writer calls, one per mode.

const NOW = new Date("2026-09-25T09:30:00.000Z");
const TASK = "Add a CSV export button to the reports page and wire it to the existing export service.";

function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-decision-record-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function liveInput(overrides: Partial<DecisionRecordInput> = {}): Promise<DecisionRecordInput> {
  const tierMap = fixtureTierMap();
  const route = overrides.route ?? fixtureRoute("standard", tierMap);
  return {
    delegationId: "attempt-live-1",
    at: NOW,
    mode: "live",
    ranOn: route.ok ? route.rung.rung : SONNET,
    taskText: TASK,
    agentRole: "worker",
    classification: await fixtureClassification(TASK, "standard"),
    tierMap,
    route,
    ...overrides,
  } as DecisionRecordInput;
}

async function shadowInput(overrides: Partial<DecisionRecordInput> = {}): Promise<DecisionRecordInput> {
  return { ...(await liveInput()), delegationId: "attempt-shadow-1", mode: "shadow", handPickedModel: SONNET, ranOn: SONNET, ...overrides } as DecisionRecordInput;
}

function linesOf(path: string): Record<string, unknown>[] {
  return readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

// ---------------------------------------------------------------------------
// Checkbox 1 (story 28): two writes, two complete records, validation on read
// ---------------------------------------------------------------------------

test("one shadow write and one live write leave exactly two records, each carrying every field the spec lists", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const shadow = writeDecisionRecord(dir, await shadowInput());
    const live = writeDecisionRecord(dir, await liveInput());
    assert.equal(shadow.path, live.path, "one file per day");
    assert.equal(shadow.path, join(dir, "2026-09-25.jsonl"));
    assert.equal(decisionRecordPath(dir, NOW), shadow.path);
    assert.deepEqual(readdirSync(dir), ["2026-09-25.jsonl"]);

    const records = readRoutingRecords(dir);
    assert.equal(records.length, 2);
    const [first, second] = records as [DecisionRecord, DecisionRecord];
    assert.equal(first.mode, "shadow");
    assert.equal(first.ranOn, SONNET);
    assert.equal(second.mode, "live");
    assert.equal(second.ranOn, `${SONNET}:medium`);

    for (const record of [first, second]) {
      assert.equal(record.recordType, "decision");
      assert.equal(record.schemaVersion, DECISION_RECORD_SCHEMA_VERSION);
      assert.equal(record.timestamp, NOW.toISOString());
      assert.equal(record.taskTextPrefix, TASK);
      assert.equal(record.agentRole, "worker");
      // Classification: tier, deciding hop, floor, the four signals, versions.
      const { classification } = record;
      assert.equal(classification.tier, "standard");
      assert.equal(classification.cause, "model:openai-codex/gpt-6-luna:low");
      assert.equal(classification.floor, "none");
      assert.deepEqual(classification.floorSignals, []);
      assert.deepEqual(classification.risk, { level: "some", reasons: ["fixture reason"] });
      assert.equal(classification.ambiguity, "clear");
      assert.equal(classification.complexity, "medium");
      assert.equal(classification.kindOfWork, "implement");
      assert.match(classification.rubricVersion, /\d/);
      assert.match(classification.schemaVersion, /\d/);
      assert.deepEqual(classification.hops.map((hop) => [hop.hop, hop.outcome]), [["openai-codex/gpt-6-luna:low", "decided"]]);
      // The resolved map, unchanged: per-rung origin, every drop, ignored keys.
      assert.deepEqual(record.tierMap, JSON.parse(JSON.stringify(fixtureTierMap())));
      assert.equal(record.tierMap.orders?.standard, "balanced");
      assert.equal(record.route.outcome === "chosen" && record.route.tierOrder, "balanced");
      assert.equal(record.tierMap.tiers.elevated[0]?.origin, "project");
      assert.equal(record.tierMap.tiers.standard[0]?.origin, "personal");
      assert.deepEqual(record.tierMap.drops.map((drop) => drop.reason), ["subagent ban list"]);
      assert.deepEqual(record.tierMap.ignoredProjectKeys, ["orchestrator.subagentBanList"]);
      // The router: removed rungs with reasons, escalation fields, the rung.
      assert.equal(record.route.outcome, "chosen");
      if (record.route.outcome !== "chosen") continue;
      assert.equal(record.route.startedAtTier, "standard");
      assert.equal(record.route.tier, "standard");
      assert.deepEqual(record.route.tiersTried, ["standard"]);
      assert.deepEqual(record.route.removed.map((entry) => [entry.rung, entry.reason]), [["openai-codex/gpt-6-luna:medium", "provider out of usage"]]);
      assert.deepEqual(record.route.rung, { rung: `${SONNET}:medium`, model: SONNET, effort: "medium", origin: "personal" });
    }
    assert.equal(first.delegationId, "attempt-shadow-1");
    assert.equal(second.delegationId, "attempt-live-1");
  } finally {
    cleanup();
  }
});

test("a balanced choice records the provider counts that selected it", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const map = fixtureTierMap();
    const route = fixtureRoute("standard", map, {}, { "openai-codex": 4, anthropic: 1 });
    const { record } = writeDecisionRecord(dir, await liveInput({ tierMap: map, route, ranOn: route.ok ? route.rung.rung : SONNET }));
    assert.equal(record.route.outcome, "chosen");
    if (record.route.outcome === "chosen") {
      assert.equal(record.route.tierOrder, "balanced");
      assert.deepEqual(record.route.providerCounts, { "openai-codex": 4, anthropic: 1 });
    }
    assert.deepEqual(readRoutingRecords(dir), [record]);
  } finally { cleanup(); }
});

test("an escalation and a refusal are both recorded with the tiers tried and every removed rung", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Standard holds only a Codex rung, so Codex out of usage moves the task up.
    const settings = fixturePersonalSettings();
    const tiers = { ...(settings.orchestrator as { routing: { tiers: Record<string, string[]> } }).routing.tiers, standard: ["openai-codex/gpt-6-luna:medium"] };
    const tierMap = fixtureTierMap({ orchestrator: { routing: { enabled: true, tiers } } }, FIXTURE_PROJECT_SETTINGS);
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-escalated", tierMap, route: fixtureRoute("standard", tierMap) }));
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-refused", tierMap, route: fixtureRefusal("elevated", tierMap) }));
    const [escalated, refused] = readRoutingRecords(dir) as [DecisionRecord, DecisionRecord];

    assert.equal(escalated.route.outcome, "chosen");
    if (escalated.route.outcome !== "chosen") return;
    assert.equal(escalated.route.startedAtTier, "standard");
    assert.equal(escalated.route.tier, "elevated");
    assert.deepEqual(escalated.route.tiersTried, ["standard", "elevated"]);
    assert.deepEqual(escalated.route.removed.map((entry) => [entry.tier, entry.rung, entry.reason]), [
      ["standard", "openai-codex/gpt-6-luna:medium", "provider out of usage"],
    ]);
    assert.equal(escalated.route.rung.origin, "project");

    assert.equal(refused.route.outcome, "refused");
    if (refused.route.outcome !== "refused") return;
    assert.equal(refused.route.code, "no_authorized_candidate");
    assert.equal(refused.route.startedAtTier, "elevated");
    assert.deepEqual(refused.route.tiersTried, ["elevated", "critical"]);
    assert.deepEqual(refused.route.removed.map((entry) => entry.reason), [
      "provider out of usage",
      "provider out of usage",
      "provider out of usage",
    ]);
    assert.match(refused.route.message, /no rung survived/);
    assert.equal("rung" in refused.route, false);
  } finally {
    cleanup();
  }
});

test("a record with a missing or an unknown field fails validation on read, naming the field", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { path, record } = writeDecisionRecord(dir, await liveInput());
    const base = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;

    const missing = "is missing";
    const unknown = "is not a known field";
    const cases: { readonly mutate: (copy: Record<string, unknown>) => void; readonly field: string; readonly problem: string }[] = [
      { mutate: (copy) => delete copy.agentRole, field: "agentRole", problem: missing },
      { mutate: (copy) => delete copy.delegationId, field: "delegationId", problem: missing },
      { mutate: (copy) => delete copy.ranOn, field: "ranOn", problem: missing },
      { mutate: (copy) => { copy.ranOn = ""; }, field: "ranOn", problem: "must be a non-blank string; got \"\"" },
      { mutate: (copy) => { copy.surprise = 1; }, field: "surprise", problem: unknown },
      { mutate: (copy) => { copy.handPickedModel = SONNET; }, field: "handPickedModel", problem: unknown },
      { mutate: (copy) => delete (copy.classification as Record<string, unknown>).rubricVersion, field: "classification.rubricVersion", problem: missing },
      { mutate: (copy) => { (copy.route as Record<string, unknown>).extra = true; }, field: "route.extra", problem: unknown },
      { mutate: (copy) => delete (copy.tierMap as Record<string, unknown>).drops, field: "tierMap.drops", problem: missing },
      {
        mutate: (copy) => delete ((copy.route as { removed: Record<string, unknown>[] }).removed[0]!).detail,
        field: "route.removed[0].detail",
        problem: missing,
      },
    ];
    for (const { mutate, field, problem } of cases) {
      const copy = JSON.parse(JSON.stringify(base)) as Record<string, unknown>;
      mutate(copy);
      assert.throws(() => validateRoutingRecord(copy), (error: unknown) => {
        assert.ok(error instanceof RoutingRecordError, String(error));
        assert.equal(error.field, field);
        assert.equal(error.problem, problem, error.message);
        assert.ok(error.message.includes(`'${field}'`), error.message);
        return true;
      });
      writeFileSync(path, `${JSON.stringify(copy)}\n`);
      assert.throws(() => readRoutingRecords(dir), (error: unknown) => {
        assert.ok(error instanceof RoutingRecordError, String(error));
        assert.equal(error.field, field);
        assert.ok(error.message.includes("2026-09-25.jsonl:1"), error.message);
        return true;
      });
    }

    const shadow = JSON.parse(JSON.stringify(writeDecisionRecord(dir, await shadowInput()).record)) as Record<string, unknown>;
    delete shadow.handPickedModel;
    assert.throws(() => validateRoutingRecord(shadow), { name: "RoutingRecordError", message: /'handPickedModel'/ });

    const versioned = { ...base, schemaVersion: "decision-record/1" };
    assert.throws(() => validateRoutingRecord(versioned), { message: /'schemaVersion'/ });

    // A later version with a new field reports the version, not the field.
    const future = { ...base, schemaVersion: "decision-record/4", cause: "explicit" };
    assert.throws(() => validateRoutingRecord(future), (error: unknown) => {
      assert.ok(error instanceof RoutingRecordError, String(error));
      assert.equal(error.field, "schemaVersion", error.message);
      assert.match(error.message, /decision-record\/4/);
      return true;
    });
    const futureVerdict = { recordType: "verdict", schemaVersion: "decision-record/4", delegationId: "a", timestamp: NOW.toISOString(), verdict: "accept", extra: 1 };
    assert.throws(() => validateRoutingRecord(futureVerdict), { name: "RoutingRecordError", message: /field 'schemaVersion'/ });
  } finally {
    cleanup();
  }
});

test("a folder reads legacy decisions, explicit records and verdicts beside new decisions without relaxing validation", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const { record } = writeDecisionRecord(dir, await liveInput());
    const oldDecision = { ...record, schemaVersion: "decision-record/2" } as Record<string, unknown>;
    delete oldDecision.ranOn;
    const explicit = legacyExplicitRecord({ timestamp: NOW.toISOString(), taskTextPrefix: TASK });
    const verdict = { recordType: "verdict", schemaVersion: "decision-record/2", delegationId: "old-decision", timestamp: NOW.toISOString(), verdict: "accept", decisionFile: "2026-09-25.jsonl" };
    const path = decisionRecordPath(dir, NOW);
    writeFileSync(path, [oldDecision, explicit, verdict, record].map((item) => JSON.stringify(item)).join("\n") + "\n");
    assert.deepEqual(readRoutingRecords(dir).map((item) => [item.schemaVersion, item.recordType]), [
      ["decision-record/2", "decision"], ["decision-record/2", "explicit"], ["decision-record/2", "verdict"], ["decision-record/3", "decision"],
    ]);
    assert.throws(() => validateRoutingRecord({ ...oldDecision, ranOn: SONNET }), /field 'ranOn' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...explicit, surprise: true }), /field 'surprise' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...verdict, surprise: true }), /field 'surprise' is not a known field/);
  } finally { cleanup(); }
});

test("every record type the extension writes reads back; the usable reader skips each line it cannot validate and names it, the strict one throws at the first", async () => {
  // pi-orchestrator-zb6t: every pi process appends to one folder, so it can hold a record written by
  // another version of the extension, or a torn line. The verdict path reads past them.
  const { dir, cleanup } = tempDir();
  try {
    const tierMap = fixtureTierMap();
    const route = fixtureRoute("standard", tierMap);
    assert.ok(route.ok);
    const at = NOW;
    const common = { recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, timestamp: at.toISOString() } as const;
    const written: RoutingRecord[] = [
      writeDecisionRecord(dir, await liveInput()).record,
      buildEffortLadderRecord({ delegationId: "retry-1", at, previousDecisionId: "attempt-live-1", step: "same-tier", mode: "live", skipped: [],
        taskText: TASK, agentRole: "worker", kindOfWork: "implement", tierMap, route }),
      buildUnplacedLadderRecord({ delegationId: "retry-2", at, previousDecisionId: "attempt-live-1", mode: "live",
        detail: "its rung openai-codex/gpt-6-sol:high has no position in the elevated tier of the tier map", taskText: TASK, agentRole: "unknown" }),
      buildForkRecord({ delegationId: "fork-1", at, model: SONNET, effort: "medium", parentSession: "session-1", forkPoint: null, banListException: false }),
      buildAgentModelRecord({ delegationId: "agent-1", at, agent: "scout", definitionFile: "scout.md", model: SONNET, effort: "low" }),
      buildEditRecord({ delegationId: "retry-2", at, orchestratorSession: "session-1", tool: "write" }),
      buildGateRequirementRecord({ delegationId: "retry-2", at, gateLevel: "medium", gateAction: "spot-check" }),
      { ...common, delegationId: "retry-2", verdict: "accept", decisionFile: "2026-09-25.jsonl", reason: "checked" },
      { ...common, recordType: "orphaned-verdict", delegationId: "nobody", verdict: "request_changes" },
      buildFailoverRecord({ delegationId: "attempt-live-1", at, refusedAttempt: { timestamp: at.toISOString(), rung: "openai-codex/gpt-6-sol:high" },
        limit: "exhausted", detail: "You have hit your ChatGPT usage limit (plus plan).", rung: `${SONNET}:medium` }),
    ];
    for (const record of written.slice(1)) appendRoutingRecord(dir, record);
    const path = decisionRecordPath(dir, NOW);
    const readable = readRoutingRecords(dir);
    assert.deepEqual(readable.map((record) => record.recordType),
      ["decision", "effort-ladder", "effort-ladder", "fork", "agent-model", "edit", "gate-requirement", "verdict", "orphaned-verdict", "failover"]);

    // What an older reader cannot validate: a newer ladder step, a record type it does not know, a newer schema version, a torn line.
    const unplaced = written[2]!;
    appendFileSync(path, [
      JSON.stringify({ ...unplaced, step: "sideways" }),
      JSON.stringify({ ...unplaced, recordType: "usage-header" }),
      JSON.stringify({ ...unplaced, schemaVersion: "decision-record/4" }),
      '{"recordType":"verdict","schemaVer',
    ].join("\n") + "\n");
    appendRoutingRecord(dir, buildEditRecord({ delegationId: "retry-3", at, orchestratorSession: "session-1", tool: "edit" }));

    assert.throws(() => readRoutingRecords(dir), (error: unknown) => {
      assert.ok(error instanceof RoutingRecordError, String(error));
      assert.equal(error.message, "routing record 2026-09-25.jsonl:11: field 'step' must be one of effort, same-tier, next-tier, unplaced; got \"sideways\"");
      return true;
    });
    const { entries, skipped } = readUsableRoutingRecordEntries(dir);
    assert.deepEqual(entries.map((entry) => [entry.line, entry.record.recordType]),
      [...readable.map((record, index) => [index + 1, record.recordType]), [15, "edit"]], "every valid line, the one after the bad ones too");
    assert.deepEqual(skipped.map((line) => [line.file, line.line, line.error.field]),
      [["2026-09-25.jsonl", 11, "step"], ["2026-09-25.jsonl", 12, "recordType"], ["2026-09-25.jsonl", 13, "schemaVersion"], ["2026-09-25.jsonl", 14, "(record)"]]);
    assert.match(skipped[3]!.error.message, /^routing record 2026-09-25\.jsonl:14: field '\(record\)' is not valid JSON/);
    assert.deepEqual(readUsableRoutingRecords(dir), entries.map((entry) => entry.record));
    assert.deepEqual(readUsableRoutingRecordEntries(join(dir, "none")), { entries: [], skipped: [] }, "a folder that does not exist holds no records");
  } finally { cleanup(); }
});

test("a reader judging delegations refuses a line it cannot validate that belongs to one of them, and skips the lines of others", () => {
  // pi-orchestrator-zb6t review: a verdict must not be judged without one of its delegation's records.
  const { dir, cleanup } = tempDir();
  try {
    const at = NOW;
    const edit = (delegationId: string, nested?: string) =>
      buildEditRecord({ delegationId, at, orchestratorSession: "session-1", tool: "write", ...(nested === undefined ? {} : { nestedDelegationId: nested }) });
    appendRoutingRecord(dir, edit("judged"));
    appendRoutingRecord(dir, edit("reviewer"));
    const path = decisionRecordPath(dir, NOW);
    const unreadable = (record: object) => JSON.stringify({ ...record, schemaVersion: "decision-record/4" });
    const others = [unreadable(edit("other")), '{"recordType":"edit","delegationId":"oth'];
    appendFileSync(path, `${others.join("\n")}\n`);

    const read = readRoutingRecordsJudging(dir, ["judged", "reviewer"]);
    assert.deepEqual(read.records.map((record) => record.delegationId), ["judged", "reviewer"]);
    assert.deepEqual(read.skipped.map((line) => [line.file, line.line, line.text]), [["2026-09-25.jsonl", 3, others[0]], ["2026-09-25.jsonl", 4, others[1]]],
      "the lines of other delegations are skipped, and named");

    const refused = (lines: string[], ids: string[], id: string, line: number) => {
      const { dir: own, cleanup: done } = tempDir();
      try {
        appendRoutingRecord(own, edit("judged"));
        appendFileSync(decisionRecordPath(own, NOW), `${lines.join("\n")}\n`);
        assert.throws(() => readRoutingRecordsJudging(own, ids), (error: unknown) => {
          assert.ok(error instanceof UnreadableDelegationRecordError, String(error));
          assert.deepEqual([error.delegationId, error.file, error.line], [id, "2026-09-25.jsonl", line]);
          assert.equal(error.message, `routing record 2026-09-25.jsonl:${line} of delegation ${id} cannot be read ` +
            `(field '${error.recordError.field}' ${error.recordError.problem}); it may come from newer code than this session has loaded, so /reload may be needed`);
          return true;
        }, JSON.stringify(lines));
      } finally { done(); }
    };
    // Its delegationId, its nestedDelegationId, or the id anywhere in a line that is not valid JSON.
    refused([unreadable(edit("judged"))], ["judged"], "judged", 2);
    refused([unreadable(edit("reviewer"))], ["judged", "reviewer"], "reviewer", 2);
    refused([unreadable(edit("parent", "judged"))], ["judged"], "judged", 2);
    refused([others[1]!, '{"recordType":"decision","delegationId":"judged","sch'], ["judged"], "judged", 3);
    refused([JSON.stringify({ recordType: "failover", delegationId: "x", note: "after judged" })], ["judged"], "judged", 2);
  } finally { cleanup(); }
});

test("an agent-model record shares the routing day file, validates on read, and rejects unknown fields", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const record = buildAgentModelRecord({
      delegationId: "worker-1", at: NOW, agent: "reviewer", definitionFile: "/owner/agents/reviewer.md",
      model: "anthropic/claude-haiku-4-5", effort: "high",
    });
    assert.equal(appendRoutingRecord(dir, record), decisionRecordPath(dir, NOW));
    assert.deepEqual(readRoutingRecords(dir), [record]);
    assert.throws(() => validateRoutingRecord({ ...record, surprise: true }), /field 'surprise' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...record, effort: "" }), /field 'effort'/);
    assert.throws(() => validateRoutingRecord({ ...record, schemaVersion: "decision-record\/2" }), /field 'schemaVersion'/);
    assert.deepEqual(validateRoutingRecord({ ...record, banListException: true }), { ...record, banListException: true });
    assert.throws(() => validateRoutingRecord({ ...record, banListException: "true" }), /field 'banListException'/);
  } finally { cleanup(); }
});

test("an edit record names its orchestrator session and tool, and a worker's own worker beside the delegation it counts for", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const own = buildEditRecord({ delegationId: "worker-1", at: NOW, orchestratorSession: "orchestrator-1", tool: "write" });
    const nested = buildEditRecord({ delegationId: "worker-1", at: NOW, orchestratorSession: "orchestrator-1", tool: "bash", nestedDelegationId: "worker-2" });
    appendRoutingRecord(dir, own);
    appendRoutingRecord(dir, nested);
    assert.deepEqual(readRoutingRecords(dir), [
      { recordType: "edit", schemaVersion: "decision-record/3", delegationId: "worker-1", timestamp: NOW.toISOString(), orchestratorSession: "orchestrator-1", tool: "write" },
      { recordType: "edit", schemaVersion: "decision-record/3", delegationId: "worker-1", timestamp: NOW.toISOString(), orchestratorSession: "orchestrator-1", tool: "bash",
        nestedDelegationId: "worker-2" },
    ]);
    assert.throws(() => validateRoutingRecord({ ...own, surprise: true }), /field 'surprise' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...own, orchestratorSession: "" }), /field 'orchestratorSession'/);
    const { tool: _tool, ...withoutTool } = own;
    assert.throws(() => validateRoutingRecord(withoutTool), /field 'tool' is missing/);
    assert.throws(() => validateRoutingRecord({ ...own, nestedDelegationId: "worker-1" }), /field 'nestedDelegationId' must name a different delegation/);
    assert.throws(() => validateRoutingRecord({ ...own, schemaVersion: "decision-record/2" }), /field 'schemaVersion'/);
  } finally { cleanup(); }
});

test("a gate requirement record names the gate level in force and the gate action at it, and nothing else", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const ungated = buildGateRequirementRecord({ delegationId: "worker-1", at: NOW, gateLevel: "low", gateAction: "none" });
    const reviewer = buildGateRequirementRecord({ delegationId: "worker-2", at: NOW, gateLevel: "medium", gateAction: "reviewer" });
    appendRoutingRecord(dir, ungated);
    appendRoutingRecord(dir, reviewer);
    assert.deepEqual(readRoutingRecords(dir), [
      { recordType: "gate-requirement", schemaVersion: "decision-record/3", delegationId: "worker-1", timestamp: NOW.toISOString(), gateLevel: "low", gateAction: "none" },
      { recordType: "gate-requirement", schemaVersion: "decision-record/3", delegationId: "worker-2", timestamp: NOW.toISOString(), gateLevel: "medium", gateAction: "reviewer" },
    ]);
    assert.equal(validateRoutingRecord({ ...ungated, gateAction: "spot-check" }).recordType, "gate-requirement");
    assert.throws(() => validateRoutingRecord({ ...ungated, gateAction: "spot check" }), /field 'gateAction' must be one of none, spot-check, reviewer/);
    assert.throws(() => validateRoutingRecord({ ...ungated, gateLevel: "strict" }), /field 'gateLevel' must be one of low, medium, high, max/);
    const { gateLevel: _level, ...withoutLevel } = ungated;
    assert.throws(() => validateRoutingRecord(withoutLevel), /field 'gateLevel' is missing/);
    assert.throws(() => validateRoutingRecord({ ...ungated, tier: "standard" }), /field 'tier' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...ungated, schemaVersion: "decision-record/2" }), /field 'schemaVersion' is unsupported for gate-requirement records/);
  } finally { cleanup(); }
});

test("a verdict is accept or request_changes: missing is no recorded verdict", () => {
  const verdict = { recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId: "worker-1", timestamp: NOW.toISOString(),
    verdict: "missing", decisionFile: "2026-09-25.jsonl" };
  assert.throws(() => validateRoutingRecord(verdict), /field 'verdict' must be one of accept, request_changes; got "missing"/);
  assert.throws(() => validateRoutingRecord({ recordType: "orphaned-verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId: "worker-1",
    timestamp: NOW.toISOString(), verdict: "missing" }), /field 'verdict' must be one of accept, request_changes/);
});

test("a verdict's reason is optional, must not be blank, and has credentials redacted and its length bounded like other free text", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const verdict = { recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId: "worker-1", timestamp: NOW.toISOString(),
      verdict: "accept", decisionFile: "2026-09-25.jsonl" } as const;
    appendRoutingRecord(dir, verdict);
    appendRoutingRecord(dir, { ...verdict, reason: `checked with api_key=abc123 ${"x".repeat(2 * FREE_TEXT_LIMIT)}` });
    const [plain, reasoned] = readRoutingRecords(dir);
    assert.deepEqual(plain, verdict);
    const reason = (reasoned as { reason?: string }).reason ?? "";
    assert.ok(reason.startsWith("checked with api_key=[redacted] x"), reason);
    assert.equal(reason.length, FREE_TEXT_LIMIT);
    assert.throws(() => validateRoutingRecord({ ...verdict, reason: " " }), /field 'reason'/);
    assert.throws(() => validateRoutingRecord({ ...verdict, reason: "x".repeat(FREE_TEXT_LIMIT + 1) }), /field 'reason' holds 501 characters/);
  } finally { cleanup(); }
});

test("new effort-ladder records use /3, while legacy /2 remains readable and unknown fields fail", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const tierMap = fixtureTierMap();
    const route = fixtureRoute("standard", tierMap);
    assert.equal(route.ok, true);
    if (!route.ok) return;
    const record = buildEffortLadderRecord({
      delegationId: "attempt-2", at: NOW, previousDecisionId: "attempt-1", step: "effort", mode: "live", skipped: [],
      taskText: TASK, agentRole: "worker", kindOfWork: "implement", tierMap, route,
    });
    assert.equal(record.schemaVersion, "decision-record/3");
    appendRoutingRecord(dir, record);
    const legacy = { ...record, schemaVersion: "decision-record/2", delegationId: "attempt-old" };
    appendRoutingRecord(dir, legacy);
    assert.deepEqual(readRoutingRecords(dir).map((item) => item.schemaVersion), ["decision-record/3", "decision-record/2"]);
    assert.throws(() => validateRoutingRecord({ ...record, ranOn: SONNET }), /field 'ranOn' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...record, surprise: true }), /field 'surprise' is not a known field/);
  } finally { cleanup(); }
});

test("a placed climb names its routing mode, live or shadow, never off; an unplaced climb names no rung, only why, in any mode", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const tierMap = fixtureTierMap();
    const route = fixtureRoute("standard", tierMap);
    assert.ok(route.ok);
    const placed = { delegationId: "attempt-2", at: NOW, previousDecisionId: "attempt-1", step: "same-tier", skipped: [],
      taskText: TASK, agentRole: "worker", kindOfWork: "implement", tierMap, route } as const;
    const shadow = buildEffortLadderRecord({ ...placed, mode: "shadow" });
    assert.equal(shadow.mode, "shadow");
    assert.throws(() => validateRoutingRecord({ ...shadow, mode: "off" }), /field 'mode' must be one of shadow, live/);
    const unplaced = buildUnplacedLadderRecord({ delegationId: "attempt-3", at: NOW, previousDecisionId: "attempt-2", mode: "off",
      detail: "routing is off, so no tier map is loaded", taskText: TASK, agentRole: "unknown" });
    assert.deepEqual(Object.keys(unplaced).sort(), ["agentRole", "cause", "delegationId", "detail", "mode", "previousDecisionId", "recordType",
      "schemaVersion", "step", "taskTextPrefix", "timestamp"]);
    appendRoutingRecord(dir, shadow);
    appendRoutingRecord(dir, unplaced);
    assert.deepEqual(readRoutingRecords(dir).map((record) => record.recordType === "effort-ladder" ? [record.step, record.mode] : []),
      [["same-tier", "shadow"], ["unplaced", "off"]]);
    assert.throws(() => validateRoutingRecord({ ...unplaced, route: shadow.route }), /field 'route' is not a known field/);
    assert.throws(() => validateRoutingRecord({ ...unplaced, detail: " " }), /field 'detail'/);
    assert.throws(() => validateRoutingRecord({ ...unplaced, schemaVersion: "decision-record/2" }), /unplaced effort-ladder records/);
    assert.throws(() => validateRoutingRecord({ ...unplaced, previousDecisionId: "attempt-3" }), /must name a different attempt/);
  } finally { cleanup(); }
});

test("a failover record links to the refused attempt by its timestamp and rung, names the rung it moved to, and keeps its error text safe", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const refusedAttempt = { timestamp: NOW.toISOString(), rung: "openai-codex/gpt-6-luna:low" };
    const failover = buildFailoverRecord({ delegationId: "worker-1", at: NOW, refusedAttempt, limit: "exhausted",
      resetsAt: "2026-09-25T10:12:00.000Z", detail: `usage limit ${"x".repeat(FREE_TEXT_LIMIT)} api_key=abc123`, rung: `${SONNET}:medium` });
    assert.equal(failover.detail.length, FREE_TEXT_LIMIT);
    appendRoutingRecord(dir, failover);
    const [read] = readRoutingRecords(dir);
    assert.ok(read?.recordType === "failover");
    assert.deepEqual([read.refusedAttempt, read.limit, read.resetsAt, read.rung], [refusedAttempt, "exhausted", "2026-09-25T10:12:00.000Z", `${SONNET}:medium`]);
    const throttled = buildFailoverRecord({ delegationId: "worker-2", at: NOW, refusedAttempt, limit: "throttled", detail: "429 rate limit", rung: `${SONNET}:medium` });
    assert.equal("resetsAt" in throttled, false);
    assert.throws(() => validateRoutingRecord({ ...failover, limit: "low" }), /field 'limit' must be one of exhausted, throttled/);
    assert.throws(() => validateRoutingRecord({ ...failover, refusedAttempt: { rung: refusedAttempt.rung } }), /field 'refusedAttempt.timestamp' is missing/);
    assert.throws(() => validateRoutingRecord({ ...failover, rung: refusedAttempt.rung }), /field 'rung' must name a different rung/);
    assert.throws(() => validateRoutingRecord({ ...failover, resetsAt: "soon" }), /field 'resetsAt' must be an ISO-8601 time/);
    assert.throws(() => validateRoutingRecord({ ...failover, schemaVersion: "decision-record/2" }), /unsupported for failover records/);
  } finally { cleanup(); }
});

test("a verdict record may say it rests on a same-rung review, and nothing else there", () => {
  const verdict = { recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId: "worker-1", timestamp: NOW.toISOString(),
    verdict: "accept", decisionFile: "2026-09-25.jsonl", sameRungReview: true } as const;
  assert.deepEqual(validateRoutingRecord(verdict), verdict);
  assert.throws(() => validateRoutingRecord({ ...verdict, sameRungReview: false }), /field 'sameRungReview' must be true when present/);
});

test("a verdict record may name a gate level raise for its delegation: from a level to a higher one, with a reason bounded like other free text", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const verdict = { recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId: "worker-1", timestamp: NOW.toISOString(),
      verdict: "accept", decisionFile: "2026-09-25.jsonl", gateLevelRaise: { from: "medium", to: "max", reason: "touches the auth flow" } } as const;
    assert.deepEqual(validateRoutingRecord(verdict), verdict);
    appendRoutingRecord(dir, { ...verdict, gateLevelRaise: { ...verdict.gateLevelRaise, reason: `token=abc123 ${"x".repeat(2 * FREE_TEXT_LIMIT)}` } });
    const reason = (readRoutingRecords(dir)[0] as { gateLevelRaise?: { reason: string } }).gateLevelRaise?.reason ?? "";
    assert.ok(reason.startsWith("token=[redacted] x"), reason);
    assert.equal(reason.length, FREE_TEXT_LIMIT);
    const raise = (change: Record<string, unknown>) => ({ ...verdict, gateLevelRaise: { ...verdict.gateLevelRaise, ...change } });
    assert.throws(() => validateRoutingRecord(raise({ to: "medium" })), /field 'gateLevelRaise.to' must be a higher gate level than medium/);
    assert.throws(() => validateRoutingRecord(raise({ to: "low" })), /field 'gateLevelRaise.to' must be a higher gate level than medium/);
    assert.throws(() => validateRoutingRecord(raise({ from: "strict" })), /field 'gateLevelRaise.from' must be one of low, medium, high, max/);
    assert.throws(() => validateRoutingRecord(raise({ reason: " " })), /field 'gateLevelRaise.reason'/);
    assert.throws(() => validateRoutingRecord(raise({ by: "owner" })), /field 'gateLevelRaise.by' is not a known field/);
  } finally { cleanup(); }
});

test("an explicit record with a missing or an unknown field fails validation on write and on read, naming the field", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const record = legacyExplicitRecord({ delegationId: "attempt-explicit", timestamp: NOW.toISOString(), mode: "shadow", slot: "tasks[1].model", taskTextPrefix: TASK, agentRole: "reviewer" });
    const cases: readonly (readonly [(copy: Record<string, unknown>) => void, string, string])[] = [
      [(copy) => delete copy.slot, "slot", "is missing"],
      [(copy) => delete copy.cause, "cause", "is missing"],
      [(copy) => { copy.tier = "standard"; }, "tier", "is not a known field"],
      [(copy) => { copy.handPickedModel = SONNET; }, "handPickedModel", "is not a known field"],
    ];
    for (const [mutate, field, problem] of cases) {
      const copy = JSON.parse(JSON.stringify(record)) as Record<string, unknown>;
      mutate(copy);
      const named = (error: unknown) => {
        assert.ok(error instanceof RoutingRecordError, String(error));
        assert.equal(error.field, field);
        assert.equal(error.problem, problem, error.message);
        return true;
      };
      assert.throws(() => appendRoutingRecord(dir, copy as unknown as RoutingRecord), named);
      assert.deepEqual(readdirSync(dir), [], "a refused record is not written");
      writeFileSync(join(dir, "2026-09-25.jsonl"), `${JSON.stringify(copy)}\n`);
      assert.throws(() => readRoutingRecords(dir), named);
      rmSync(join(dir, "2026-09-25.jsonl"));
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Checkbox 2 (story 28): the hand-picked model in shadow mode only
// ---------------------------------------------------------------------------

test("the shadow record carries the model the orchestrator named by hand and the live record carries none", async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeDecisionRecord(dir, await shadowInput({ handPickedModel: "anthropic/claude-opus-5", ranOn: "anthropic/claude-opus-5" } as Partial<DecisionRecordInput>));
    writeDecisionRecord(dir, await liveInput());
    const [shadow, live] = linesOf(decisionRecordPath(dir, NOW));
    assert.equal(shadow?.mode, "shadow");
    assert.equal(shadow?.handPickedModel, "anthropic/claude-opus-5");
    assert.equal(shadow?.ranOn, "anthropic/claude-opus-5");
    assert.equal(live?.mode, "live");
    assert.equal(Object.hasOwn(live!, "handPickedModel"), false);

    // The writer refuses the wrong pairing rather than writing it.
    const liveOnly = await liveInput();
    assert.throws(() => writeDecisionRecord(dir, { ...liveOnly, handPickedModel: SONNET } as unknown as DecisionRecordInput), /'handPickedModel'/);
    const { handPickedModel: _dropped, ...noPick } = (await shadowInput()) as DecisionRecordInput & { handPickedModel?: string };
    assert.throws(() => writeDecisionRecord(dir, noPick as DecisionRecordInput), /'handPickedModel'/);
    assert.equal(linesOf(decisionRecordPath(dir, NOW)).length, 2, "nothing written by a refused call");
  } finally {
    cleanup();
  }
});

test("a nested worker's record names its parent delegation, which must be another delegation (ADR 0008)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-nested-1", parentDelegationId: "attempt-live-1" }));
    const [nested] = readRoutingRecords(dir);
    assert.ok(nested?.recordType === "decision");
    assert.equal(nested.parentDelegationId, "attempt-live-1");

    for (const [parentDelegationId, problem] of [["attempt-nested-2", /'parentDelegationId' must name a different delegation/], [" ", /'parentDelegationId'/]] as const) {
      assert.throws(() => validateRoutingRecord({ ...nested, delegationId: "attempt-nested-2", parentDelegationId }), problem);
    }
  } finally {
    cleanup();
  }
});

test("a reviewer's record names the delegation it reviews, which must be another delegation (ADR 0010)", async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-review-1", reviewedDelegationId: "attempt-live-1" }));
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-live-2" }));
    const [review, plain] = readRoutingRecords(dir);
    assert.ok(review?.recordType === "decision" && plain?.recordType === "decision");
    assert.equal(review.reviewedDelegationId, "attempt-live-1");
    assert.equal("reviewedDelegationId" in plain, false, "a delegation that reviews nothing has no reviewedDelegationId field");

    for (const [reviewedDelegationId, problem] of [["attempt-review-2", /'reviewedDelegationId' must name a different delegation/], [" ", /'reviewedDelegationId'/], [3, /'reviewedDelegationId'/]] as const) {
      assert.throws(() => validateRoutingRecord({ ...review, delegationId: "attempt-review-2", reviewedDelegationId }), problem);
    }
  } finally {
    cleanup();
  }
});

test("a constrained worker's record names its routing constraints, and a malformed constraints field fails validation, naming the field", async () => {
  const { dir, cleanup } = tempDir();
  try {
    writeDecisionRecord(dir, await liveInput({ constraints: { minimumTier: "elevated", excludedRung: { model: SONNET, effort: "high" } } }));
    const [record] = readRoutingRecords(dir);
    assert.ok(record?.recordType === "decision");
    assert.deepEqual(record.constraints, { minimumTier: "elevated", excludedRung: `${SONNET}:high` });

    const cases: readonly (readonly [unknown, string, RegExp])[] = [
      [{}, "constraints", /must name at least one constraint/],
      [{ minimumTier: "urgent" }, "constraints.minimumTier", /must be one of/],
      [{ excludedRung: "" }, "constraints.excludedRung", /non-blank/],
      [{ surprise: 1 }, "constraints.surprise", /is not a known field/],
      [{ forcedRung: { tier: "standard", rung: `${SONNET}:high` }, minimumTier: "elevated" }, "constraints.forcedRung", /must be the only constraint/],
      [{ forcedRung: { tier: "standard" } }, "constraints.forcedRung.rung", /is missing/],
    ];
    for (const [constraints, field, problem] of cases) {
      assert.throws(() => validateRoutingRecord({ ...record, constraints }), (error: unknown) => {
        assert.ok(error instanceof RoutingRecordError, String(error));
        assert.equal(error.field, field, error.message);
        assert.match(error.problem, problem);
        return true;
      });
    }
  } finally {
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Checkbox 9 (story 34): 200 characters of task text, never a credential
// ---------------------------------------------------------------------------

test("a 1,000-character task text is stored truncated to its first 200 characters", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const long = Array.from({ length: 1_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
    assert.equal(long.length, 1_000);
    writeDecisionRecord(dir, await liveInput({ taskText: long }));
    const [record] = readRoutingRecords(dir) as [DecisionRecord];
    assert.equal(TASK_TEXT_PREFIX_LIMIT, 200);
    assert.equal(record.taskTextPrefix, long.slice(0, 200));
    assert.equal(record.taskTextPrefix.length, 200);
    assert.equal(readFileSync(decisionRecordPath(dir, NOW), "utf8").includes(long.slice(0, 201)), false);

    // A record claiming a longer prefix is invalid on read.
    const tooLong = { ...record, taskTextPrefix: long.slice(0, 201) };
    assert.throws(() => validateRoutingRecord(tooLong), /'taskTextPrefix'/);
  } finally {
    cleanup();
  }
});

// Story 34, ticket 27 round 2: the writer redacts credential-shaped text in
// every free-text field and bounds each one, for every record type.

const API_KEY = "sk-ant-api03-R2REDACTME-0123456789abcdefghij";
const BEARER = "abcDEF123.ticket27-bearer-value";

test("credential-shaped text in the task and in hop details, route messages and removal details never reaches any record file", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const task = `Deploy with ${API_KEY} and send Authorization: Bearer ${BEARER} to the staging API.`;
    const detail = `pi exited 1: 401 for Authorization: Bearer ${BEARER}; key=${API_KEY}`;
    const classification = await fixtureClassification(TASK, "standard");
    const leaky = {
      ...classification,
      why: `the task names password: hunter2-ticket27 and ${API_KEY}`,
      hops: classification.hops.map((hop) => ({ ...hop, detail })),
    };
    const tierMap = fixtureTierMap();
    const refusal = fixtureRefusal("elevated", tierMap);
    assert.equal(refusal.ok, false);
    const leakyRefusal = {
      ...refusal,
      message: `no rung survived; token=${BEARER}`,
      removed: refusal.removed.map((removed) => ({ ...removed, detail: `Bearer ${BEARER}` })),
    } as typeof refusal;
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-leaky", taskText: task, classification: leaky, route: leakyRefusal }));
    appendRoutingRecord(dir, legacyExplicitRecord({ delegationId: "attempt-leaky-explicit", timestamp: NOW.toISOString(), taskTextPrefix: task }));

    const files = readdirSync(dir);
    assert.deepEqual(files, ["2026-09-25.jsonl"]);
    const text = readFileSync(join(dir, files[0]!), "utf8");
    for (const secret of [API_KEY, "sk-ant-api03", BEARER, "R2REDACTME", "ticket27-bearer-value", "hunter2-ticket27"]) {
      assert.equal(text.includes(secret), false, `the record file holds ${secret}`);
    }
    const [decision, explicit] = readRoutingRecords(dir) as [DecisionRecord, RoutingRecord];
    assert.equal(decision.taskTextPrefix, "Deploy with [redacted] and send Authorization: [redacted] to the staging API.");
    assert.equal(explicit.recordType === "explicit" && explicit.taskTextPrefix, "Deploy with [redacted] and send Authorization: [redacted] to the staging API.");
    assert.equal(decision.classification.why, "the task names password: [redacted] and [redacted]");
    assert.equal(decision.classification.hops[0]?.detail, "pi exited 1: 401 for Authorization: [redacted]; key=[redacted]");
    assert.equal(decision.route.outcome === "refused" && decision.route.message, "no rung survived; token=[redacted]");
    assert.deepEqual([...new Set(decision.route.removed.map((removed) => removed.detail))], ["Bearer [redacted]"]);
  } finally {
    cleanup();
  }
});

test("a key that straddles the task-text or hop-detail limit is redacted before the cut, so no prefix of it is written", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // The space keeps the word boundary the `sk-` pattern needs; the key
    // starts at character 190 of the task and 495 of the detail.
    const task = `${"x".repeat(189)} ${API_KEY}`;
    const detail = `${"y".repeat(494)} ${API_KEY}`;
    const classification = await fixtureClassification(TASK, "standard");
    const input = await liveInput({
      delegationId: "attempt-straddle",
      taskText: task,
      classification: { ...classification, hops: classification.hops.map((hop) => ({ ...hop, detail })) },
    });
    writeDecisionRecord(dir, input);

    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      // Five characters is the shortest prefix the hop-detail cut would leave.
      assert.equal(text.includes(API_KEY.slice(0, 5)), false, `${file} holds a prefix of the key`);
    }
    const [record] = readRoutingRecords(dir) as [DecisionRecord];
    assert.equal(record.taskTextPrefix, `${"x".repeat(189)} [redacted]`);
    assert.equal(record.classification.hops[0]?.detail, `${"y".repeat(494)} [reda`);
  } finally {
    cleanup();
  }
});

test("a quoted password value longer than the redaction window, or never closed, is redacted in the task text and the hop detail", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const filler = Array.from({ length: 300 }, () => "word").join(" ");
    const longQuoted = `password: "hunter2 ${filler}"`;
    const unterminated = "password: \"hunter2 and the rest of the line";
    assert.ok(longQuoted.length > TASK_TEXT_PREFIX_LIMIT + 1_000 && longQuoted.length > FREE_TEXT_LIMIT + 1_000);
    const classification = await fixtureClassification(TASK, "standard");
    for (const [delegationId, text] of [["attempt-long-quote", longQuoted], ["attempt-open-quote", unterminated]] as const) {
      writeDecisionRecord(dir, await liveInput({
        delegationId,
        taskText: text,
        classification: { ...classification, hops: classification.hops.map((hop) => ({ ...hop, detail: text })) },
      }));
    }

    for (const file of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, file), "utf8").includes("hunter2"), false, `${file} holds the password`);
    }
    const [long, open] = readRoutingRecords(dir) as [DecisionRecord, DecisionRecord];
    assert.equal(long.taskTextPrefix, "password: [redacted]");
    assert.equal(open.taskTextPrefix, "password: [redacted]");
    assert.equal(open.classification.hops[0]?.detail, "password: [redacted]");
  } finally {
    cleanup();
  }
});

test("a key cut by the redaction window end does not slide into the kept task text once a long value before it is redacted", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // The window ends 7 characters into the key, leaving `sk-proj`, too short
    // for the `sk-` pattern; redacting the quoted value shrinks the text by
    // over 1,000 characters.
    const task = `password: "${"a".repeat(1_180)}" sk-proj1234567890`;
    assert.equal(task.indexOf("sk-proj") + 7, TASK_TEXT_PREFIX_LIMIT + 1_000);
    writeDecisionRecord(dir, await liveInput({ delegationId: "attempt-cut-key", taskText: task }));

    for (const file of readdirSync(dir)) {
      assert.equal(readFileSync(join(dir, file), "utf8").includes("sk-proj"), false, `${file} holds a fragment of the key`);
    }
    const [record] = readRoutingRecords(dir) as [DecisionRecord];
    assert.equal(record.taskTextPrefix, "password: [redacted] ");
  } finally {
    cleanup();
  }
});

test("a 200,000-character unbroken a-b-c run in the task text is redacted and cut within 200 ms, and a key in the kept prefix is still redacted", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const run = Array.from({ length: 200_000 }, (_, index) => (index % 2 === 1 ? "-" : String.fromCharCode(97 + ((index / 2) % 26)))).join("");
    assert.equal(run.length, 200_000);
    const input = await liveInput({ delegationId: "attempt-long-run", taskText: `Deploy with ${API_KEY} then ${run}` });
    const started = performance.now();
    writeDecisionRecord(dir, input);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 200, `writing the record took ${Math.round(elapsed)} ms`);
    const [record] = readRoutingRecords(dir) as [DecisionRecord];
    assert.equal(record.taskTextPrefix, `Deploy with [redacted] then ${run}`.slice(0, TASK_TEXT_PREFIX_LIMIT));
  } finally {
    cleanup();
  }
});

test("a 5,000-character hop detail is stored bounded to 500 characters, and a longer one is refused on read", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const long = Array.from({ length: 5_000 }, (_, index) => String.fromCharCode(97 + (index % 26))).join("");
    const classification = await fixtureClassification(TASK, "standard");
    const input = await liveInput({ classification: { ...classification, hops: classification.hops.map((hop) => ({ ...hop, detail: long })) } });
    writeDecisionRecord(dir, input);
    const [record] = readRoutingRecords(dir) as [DecisionRecord];
    assert.equal(FREE_TEXT_LIMIT, 500);
    assert.equal(record.classification.hops[0]?.detail, long.slice(0, 500));
    assert.equal(readFileSync(decisionRecordPath(dir, NOW), "utf8").includes(long.slice(0, 501)), false);

    const tooLong = JSON.parse(JSON.stringify(record)) as { classification: { hops: { detail?: string }[] } };
    tooLong.classification.hops[0]!.detail = long.slice(0, 501);
    assert.throws(() => validateRoutingRecord(tooLong), (error: unknown) => {
      assert.ok(error instanceof RoutingRecordError, String(error));
      assert.equal(error.field, "classification.hops[0].detail");
      return true;
    });
  } finally {
    cleanup();
  }
});

test("an auth token in a settings key next to orchestrator never appears in any record", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const TOKEN = "sk-ant-oat01-TICKET25-DO-NOT-RECORD-7f3a9c";
    const settings = fixturePersonalSettings({ anthropicToken: TOKEN, auth: { anthropic: { access: TOKEN } } });
    const tierMap = fixtureTierMap(settings);
    const classification = await fixtureClassification(TASK, "standard");
    const route = fixtureRoute("standard", tierMap);
    // Everything a caller could have at hand is passed in, including the parsed
    // settings object and copies of the values with the token spliced in.
    const input = {
      delegationId: "attempt-token",
      at: NOW,
      mode: "shadow",
      handPickedModel: SONNET,
      ranOn: SONNET,
      taskText: TASK,
      agentRole: "worker",
      settings,
      anthropicToken: TOKEN,
      classification: { ...classification, anthropicToken: TOKEN, hops: classification.hops.map((hop) => ({ ...hop, token: TOKEN })) },
      tierMap: { ...tierMap, settings, tiers: { ...tierMap.tiers, standard: tierMap.tiers.standard.map((rung) => ({ ...rung, token: TOKEN })) } },
      route: { ...route, settings, ...(route.ok ? { rung: { ...route.rung, token: TOKEN } } : {}) },
    } as unknown as DecisionRecordInput;
    writeDecisionRecord(dir, input);
    writeDecisionRecord(dir, { ...input, delegationId: "attempt-token-live", mode: "live", handPickedModel: undefined, ranOn: route.ok ? route.rung.rung : SONNET } as unknown as DecisionRecordInput);
    for (const file of readdirSync(dir)) {
      const text = readFileSync(join(dir, file), "utf8");
      assert.equal(text.includes(TOKEN), false, `${file} holds the token`);
      assert.equal(text.includes("TICKET25-DO-NOT-RECORD"), false);
      assert.equal(text.includes("anthropicToken"), false);
    }
    assert.equal(readRoutingRecords(dir).length, 2, "both records still validate");
  } finally {
    cleanup();
  }
});
