import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  SONNET,
} from "../fixtures/routing-decision.ts";
import {
  appendRoutingRecord,
  buildExplicitModelRecord,
  DECISION_RECORD_SCHEMA_VERSION,
  decisionRecordPath,
  FREE_TEXT_LIMIT,
  readRoutingRecords,
  RoutingRecordError,
  TASK_TEXT_PREFIX_LIMIT,
  validateRoutingRecord,
  writeDecisionRecord,
  type DecisionRecord,
  type DecisionRecordInput,
  type RoutingRecord,
} from "./decision-record.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

// Ticket 25, stories 28 and 34. Seam: `writeDecisionRecord`, the public
// function ticket 27's extension hook will call once per routing decision,
// with every value injected. Ticket 27 completes the "one hook call" form of
// checkbox 1; here it is two writer calls, one per mode.

const NOW = new Date("2026-09-25T09:30:00.000Z");
const TASK = "Add a CSV export button to the reports page and wire it to the existing export service.";

function tempDir(): { dir: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-decision-record-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function liveInput(overrides: Partial<DecisionRecordInput> = {}): Promise<DecisionRecordInput> {
  const tierMap = fixtureTierMap();
  return {
    attemptId: "attempt-live-1",
    at: NOW,
    mode: "live",
    taskText: TASK,
    agentRole: "worker",
    classification: await fixtureClassification(TASK, "standard"),
    tierMap,
    route: fixtureRoute("standard", tierMap),
    ...overrides,
  } as DecisionRecordInput;
}

async function shadowInput(overrides: Partial<DecisionRecordInput> = {}): Promise<DecisionRecordInput> {
  return { ...(await liveInput()), attemptId: "attempt-shadow-1", mode: "shadow", handPickedModel: SONNET, ...overrides } as DecisionRecordInput;
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
    assert.equal(second.mode, "live");

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
    assert.equal(first.attemptId, "attempt-shadow-1");
    assert.equal(second.attemptId, "attempt-live-1");
  } finally {
    cleanup();
  }
});

test("an escalation and a refusal are both recorded with the tiers tried and every removed rung", async () => {
  const { dir, cleanup } = tempDir();
  try {
    // Standard holds only a Codex rung, so Codex out of usage moves the task up.
    const settings = fixturePersonalSettings();
    const tiers = { ...(settings.orchestrator as { routing: { tiers: Record<string, string[]> } }).routing.tiers, standard: ["openai-codex/gpt-6-luna:medium"] };
    const tierMap = fixtureTierMap({ orchestrator: { routing: { enabled: true, tiers } } }, FIXTURE_PROJECT_SETTINGS);
    writeDecisionRecord(dir, await liveInput({ attemptId: "attempt-escalated", tierMap, route: fixtureRoute("standard", tierMap) }));
    writeDecisionRecord(dir, await liveInput({ attemptId: "attempt-refused", tierMap, route: fixtureRefusal("elevated", tierMap) }));
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
      { mutate: (copy) => delete copy.attemptId, field: "attemptId", problem: missing },
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

    const versioned = { ...base, schemaVersion: "decision-record/0" };
    assert.throws(() => validateRoutingRecord(versioned), { message: /'schemaVersion'/ });

    // A later version with a new field reports the version, not the field.
    const future = { ...base, schemaVersion: "decision-record/2", cause: "explicit" };
    assert.throws(() => validateRoutingRecord(future), (error: unknown) => {
      assert.ok(error instanceof RoutingRecordError, String(error));
      assert.equal(error.field, "schemaVersion", error.message);
      assert.match(error.message, /decision-record\/2/);
      return true;
    });
    const futureVerdict = { recordType: "verdict", schemaVersion: "decision-record/2", attemptId: "a", timestamp: NOW.toISOString(), verdict: "accept", extra: 1 };
    assert.throws(() => validateRoutingRecord(futureVerdict), { name: "RoutingRecordError", message: /field 'schemaVersion'/ });
  } finally {
    cleanup();
  }
});

test("an explicit record with a missing or an unknown field fails validation on write and on read, naming the field", async () => {
  const { dir, cleanup } = tempDir();
  try {
    const record = buildExplicitModelRecord({ attemptId: "attempt-explicit", at: NOW, mode: "shadow", slot: "tasks[1].model", model: SONNET, taskText: TASK, agentRole: "reviewer" });
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
    writeDecisionRecord(dir, await shadowInput({ handPickedModel: "anthropic/claude-opus-5" } as Partial<DecisionRecordInput>));
    writeDecisionRecord(dir, await liveInput());
    const [shadow, live] = linesOf(decisionRecordPath(dir, NOW));
    assert.equal(shadow?.mode, "shadow");
    assert.equal(shadow?.handPickedModel, "anthropic/claude-opus-5");
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
    writeDecisionRecord(dir, await liveInput({ attemptId: "attempt-leaky", taskText: task, classification: leaky, route: leakyRefusal }));
    appendRoutingRecord(dir, buildExplicitModelRecord({
      attemptId: "attempt-leaky-explicit", at: NOW, mode: "live", slot: "model", model: SONNET, taskText: task, agentRole: "worker",
    }));

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
      attemptId: "attempt-straddle",
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
    for (const [attemptId, text] of [["attempt-long-quote", longQuoted], ["attempt-open-quote", unterminated]] as const) {
      writeDecisionRecord(dir, await liveInput({
        attemptId,
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
    writeDecisionRecord(dir, await liveInput({ attemptId: "attempt-cut-key", taskText: task }));

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
    const input = await liveInput({ attemptId: "attempt-long-run", taskText: `Deploy with ${API_KEY} then ${run}` });
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
    // Everything a hook could have at hand is passed in, including the parsed
    // settings object and copies of the values with the token spliced in.
    const input = {
      attemptId: "attempt-token",
      at: NOW,
      mode: "shadow",
      handPickedModel: SONNET,
      taskText: TASK,
      agentRole: "worker",
      settings,
      anthropicToken: TOKEN,
      classification: { ...classification, anthropicToken: TOKEN, hops: classification.hops.map((hop) => ({ ...hop, token: TOKEN })) },
      tierMap: { ...tierMap, settings, tiers: { ...tierMap.tiers, standard: tierMap.tiers.standard.map((rung) => ({ ...rung, token: TOKEN })) } },
      route: { ...route, settings, ...(route.ok ? { rung: { ...route.rung, token: TOKEN } } : {}) },
    } as unknown as DecisionRecordInput;
    writeDecisionRecord(dir, input);
    writeDecisionRecord(dir, { ...input, attemptId: "attempt-token-live", mode: "live", handPickedModel: undefined } as unknown as DecisionRecordInput);
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
