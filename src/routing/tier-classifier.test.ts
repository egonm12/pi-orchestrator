import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { known } from "../catalog/epistemic.ts";
import { buildCatalog, type CatalogEntry, type ModelCatalog } from "../catalog/model-catalog.ts";
import {
  createGuardedAgentDir,
  credentialsAvailable,
  liveAuthExtensionPath,
} from "../fixtures/guarded-agent-dir.ts";
import { configureBanLists, resetBanLists } from "../policy/ban-lists.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { SCHEMA_VERSION } from "./tier-answer-schema.ts";
import {
  CLASSIFIER_ALLOWANCE_LABEL,
  classifierConfigFromSettings,
  classifyTier,
  DEFAULT_CLASSIFIER_CONFIG,
  loadClassifierChain,
  ProviderOutOfUsageError,
  type ClassifierConfig,
  type ClassifierModelCall,
  type TierClassification,
} from "./tier-classifier.ts";
import { RUBRIC_VERSION, TIER_RUBRIC } from "./tier-rubric.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

// Ticket 23: seam 1 is `classifyTier` with the model call injected as a fake.
// Seam 2 is the three live Haiku cases at the end of this file.

afterEach(() => resetBanLists());

const LUNA = "openai-codex/gpt-6-luna:low";
const HAIKU = "anthropic/claude-haiku-4-5:low";
const SOL = "openai-codex/gpt-6-sol:low";
const LUNA_MEDIUM = "openai-codex/gpt-6-luna:medium";
const GPT5_LUNA = "openai-codex/gpt-5.6-luna:low";

const PLAIN_TASK = "Add a CSV export button to the reports page and wire it to the existing export service.";

interface Allowance {
  readonly owner: TaskAllowanceOwner;
  readonly catalog: ModelCatalog;
}

function allowance(allowanceUsd = 5): Allowance {
  const catalog = buildCatalog({
    modelIds: [
      "openai-codex/gpt-6-luna",
      "openai-codex/gpt-6-sol",
      "openai-codex/gpt-5.6-luna",
      "anthropic/claude-haiku-4-5",
    ],
  });
  const owner = new TaskAllowanceOwner(newTaskLedger({ taskId: "ticket-23", allowanceUsd }));
  return { owner, catalog };
}

/** The luna route priced as metered ($10 in, $30 out per 1M tokens), so the
 *  allowance holds real dollars. The real routes here are all subscription. */
function meteredAllowance(allowanceUsd: number): Allowance {
  const base = allowance(allowanceUsd);
  const model = "openai-codex/gpt-6-luna";
  const entry = base.catalog.entries[model]!;
  const asOf = new Date().toISOString();
  const metered: CatalogEntry = {
    ...entry,
    routeBilling: known<"metered">("metered", "operator-configured", asOf),
    publishedListPrice: known({ inputUsdPerMTok: 10, outputUsdPerMTok: 30 }, "published-dataset", asOf),
  };
  return { owner: base.owner, catalog: { ...base.catalog, entries: { ...base.catalog.entries, [model]: metered } } };
}

function answer(tier: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    tier,
    risk: { level: "none", reasons: [] },
    ambiguity: "clear",
    complexity: "medium",
    kindOfWork: "implement",
    why: `fake says ${tier}`,
    ...extra,
  });
}

type Behaviour = "timeout" | "nonsense" | "unknown-tier" | "out-of-usage" | "throws" | { readonly answer: string };

interface FakeCall {
  readonly prompt: string;
  readonly rung: string;
  readonly signal: AbortSignal;
}

/** One fake model call for the whole chain; each rung gets its own behaviour. */
function fakeModel(behaviours: Readonly<Record<string, Behaviour>>) {
  const calls: FakeCall[] = [];
  const call: ClassifierModelCall = (prompt, rung, signal) => {
    calls.push({ prompt, rung, signal });
    const behaviour = behaviours[rung];
    if (behaviour === undefined) throw new Error(`fake has no behaviour for ${rung}`);
    if (behaviour === "timeout") {
      return new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted by the classifier")));
      });
    }
    if (behaviour === "nonsense") return Promise.resolve("I would say this is a standard task.");
    if (behaviour === "unknown-tier") return Promise.resolve(answer("extreme"));
    if (behaviour === "out-of-usage") {
      return Promise.reject(new ProviderOutOfUsageError("You have hit your usage limit."));
    }
    if (behaviour === "throws") throw new Error("provider connection reset");
    return Promise.resolve(behaviour.answer);
  };
  return { call, calls };
}

function config(model: string, fallback: readonly string[] = [], timeoutMs = 50): ClassifierConfig {
  return { model, timeoutMs, fallback };
}

async function classify(
  task: string,
  cfg: ClassifierConfig,
  behaviours: Readonly<Record<string, Behaviour>>,
  budget: Allowance = allowance(),
  extra: { role?: string; paths?: readonly string[] } = {},
): Promise<{ record: TierClassification; calls: FakeCall[] }> {
  const fake = fakeModel(behaviours);
  const record = await classifyTier(
    { task, role: extra.role ?? "worker", paths: extra.paths ?? [] },
    { chain: loadClassifierChain(cfg), callModel: fake.call, allowance: budget },
  );
  return { record, calls: fake.calls };
}

// ---------------------------------------------------------------------------
// Checkbox 1 (stories 13, 15, 20)
// ---------------------------------------------------------------------------

test("a schema-valid standard from the primary is recorded with cause, the four signals, why and both versions", async () => {
  assert.equal(DEFAULT_CLASSIFIER_CONFIG.model, LUNA);
  const reply = answer("standard", {
    risk: { level: "some", reasons: ["touches an existing service"] },
    ambiguity: "partial",
    complexity: "low",
    kindOfWork: "implement",
    why: "routine feature in ordinary code",
  });
  const { record } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: reply } });
  assert.equal(record.tier, "standard");
  assert.equal(record.cause, `model:${LUNA}`);
  assert.deepEqual(record.risk, { level: "some", reasons: ["touches an existing service"] });
  assert.equal(record.ambiguity, "partial");
  assert.equal(record.complexity, "low");
  assert.equal(record.kindOfWork, "implement");
  assert.equal(record.why, "routine feature in ordinary code");
  assert.equal(record.rubricVersion, RUBRIC_VERSION);
  assert.equal(record.schemaVersion, SCHEMA_VERSION);
  assert.match(RUBRIC_VERSION, /\d/);
  assert.match(SCHEMA_VERSION, /\d/);
  assert.equal("floor" in record, false, "no keyword floor");
  assert.deepEqual(record.hops.map((hop) => [hop.hop, hop.outcome]), [[LUNA, "decided"]]);
});

// ---------------------------------------------------------------------------
// Checkbox 2 (story 14)
// ---------------------------------------------------------------------------

test("the model sees the task text, the role and the named paths, and never the conversation", async () => {
  const fake = fakeModel({ [LUNA]: { answer: answer("standard") } });
  const delegation = {
    task: "Rename the helper in src/util/strings.ts and update its callers in src/app.ts.",
    role: "worker",
    paths: ["src/util/strings.ts", "src/app.ts"],
    conversation: [
      { role: "user", content: "CONVERSATION-MARKER-ALPHA earlier discussion about the launch plan" },
      { role: "assistant", content: "CONVERSATION-MARKER-BETA I will delegate this" },
    ],
  };
  await classifyTier(delegation, {
    chain: loadClassifierChain(DEFAULT_CLASSIFIER_CONFIG),
    callModel: fake.call,
    allowance: allowance(),
  });
  assert.equal(fake.calls.length, 1);
  const prompt = fake.calls[0]!.prompt;
  assert.ok(prompt.includes(delegation.task), prompt);
  assert.match(prompt, /Agent role: worker/);
  for (const path of delegation.paths) assert.ok(prompt.includes(path), `missing ${path}`);
  assert.doesNotMatch(prompt, /CONVERSATION-MARKER/);
  assert.doesNotMatch(prompt, /launch plan|I will delegate/);
});

// ---------------------------------------------------------------------------
// Only the classifier model chooses the tier (ADR 0015). The tasks are the
// routing log's false criticals, 2026-09-25 to 2026-10-01.
// ---------------------------------------------------------------------------

const RENAME_TASK =
  "Rename `formatDate` to `formatIsoDate` in src/util/dates.ts and update its callers. Commit the change on the current branch. " +
  "Do not push or force-push. Report the commit hash.";

const DLQ_TASK =
  "Investigate the contents of the AWS SQS FIFO dead-letter queue `orders-effects-dlq.fifo` (production, region eu-west-1): " +
  "read a sample of its messages and the consumer's Datadog logs, and report why the messages reached the DLQ. " +
  "Do NOT redrive, purge, delete or modify any message or queue. If login is needed (e.g. aws sso login), stop and report it; " +
  "do not handle credentials yourself.";

const AUTH_CHANGE_TASK =
  "Change one line in src/auth/middleware.ts so the authentication check also accepts requests whose session is still refreshing.";

test("a mechanical answer for a rename that forbids a push and asks for the commit hash stays mechanical", async () => {
  const { record } = await classify(RENAME_TASK, DEFAULT_CLASSIFIER_CONFIG, {
    [LUNA]: { answer: answer("mechanical", { kindOfWork: "mechanical-edit", why: "a rename a tool can check" }) },
  });
  assert.equal(record.tier, "mechanical");
  assert.equal(record.cause, `model:${LUNA}`);
  assert.equal(record.why, "a rename a tool can check");
});

test("the DLQ investigation keeps the model's tier, though it forbids redrive, purge and delete and names aws sso login", async () => {
  const reasons = ["reads production messages and logs", "changes nothing: the task forbids redrive, purge and delete"];
  const { record } = await classify(DLQ_TASK, DEFAULT_CLASSIFIER_CONFIG, {
    [LUNA]: { answer: answer("elevated", {
      risk: { level: "some", reasons },
      ambiguity: "partial",
      complexity: "high",
      kindOfWork: "research",
      why: "a read-only production investigation across several systems",
    }) },
  });
  assert.equal(record.tier, "elevated");
  assert.equal(record.cause, `model:${LUNA}`);
  // The model's own reason explains the tier, and nothing else does.
  assert.equal(record.why, "a read-only production investigation across several systems");
  assert.deepEqual(record.risk, { level: "some", reasons });
  for (const field of ["floor", "floorTier", "floorSignals", "modelTier"]) assert.equal(field in record, false, field);
});

test("the model may still choose critical, and its critical stays critical", async () => {
  const { record } = await classify(AUTH_CHANGE_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("critical") } });
  assert.equal(record.tier, "critical");
  assert.equal(record.cause, `model:${LUNA}`);
  const plain = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("critical") } });
  assert.equal(plain.record.tier, "critical");
});

test("the rubric judges the action, not the subject: read-only work is never critical and a prohibition is a constraint", async () => {
  assert.equal(RUBRIC_VERSION, "tier-rubric-4");
  const { calls } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("standard") } });
  const prompt = calls[0]!.prompt;
  assert.ok(prompt.startsWith(TIER_RUBRIC));
  for (const rule of [
    "Judge the action the task asks the worker to perform, not the subject it touches.",
    "A review, audit or investigation that changes nothing is never critical, however sensitive its subject: its tier follows how hard the reasoning is.",
    "A prohibition in the task, such as \"do not delete anything\" or \"do not push\", is a constraint on the worker, not the action it asks for: it never raises the tier.",
    "Judge the riskiest part of the requested action.",
    "Example: review a pull request that changes OAuth. The review changes nothing, so it is elevated, not critical.",
    "Not critical: \"do not delete anything\" destroys no data.",
    "Example: investigate why messages reached the DLQ and report the cause.",
    // The critical rule and its example stay.
    "1. critical: does the task change a security boundary, or destroy data that cannot be recovered?",
    "Example: grant the support role write access to billing settings.",
  ]) {
    assert.ok(prompt.includes(rule), rule);
  }
  assert.doesNotMatch(TIER_RUBRIC, /Judge the riskiest part of the task\./);
});

test("the why answer is one short sentence of at most 120 characters, and an over-long why is still a decision, never a schema failure", async () => {
  assert.ok(TIER_RUBRIC.includes("- why: one short sentence, at most 120 characters, explaining the tier from the action the task asks for."));
  assert.doesNotMatch(TIER_RUBRIC, /one or two sentences/);
  const long = "The task changes a shared helper used across several modules, so a mistake would spread to every caller. ".repeat(3).trim();
  assert.ok(long.length > 120, long);
  const { record } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("standard", { why: long }) } });
  assert.equal(record.tier, "standard");
  assert.equal(record.cause, `model:${LUNA}`);
  assert.equal(record.why, long);
  assert.deepEqual(record.hops.map((hop) => [hop.hop, hop.outcome]), [[LUNA, "decided"]]);
});

// ---------------------------------------------------------------------------
// Checkbox 5 (story 17)
// ---------------------------------------------------------------------------

test("a timed-out primary falls to the first fallback, which the cause names", async () => {
  const { record, calls } = await classify(PLAIN_TASK, config(LUNA, [HAIKU, SOL]), {
    [LUNA]: "timeout",
    [HAIKU]: { answer: answer("standard") },
    [SOL]: { answer: answer("critical") },
  });
  assert.equal(record.cause, `model:${HAIKU}`);
  assert.equal(record.tier, "standard");
  assert.deepEqual(record.hops.map((hop) => [hop.hop, hop.outcome]), [[LUNA, "timeout"], [HAIKU, "decided"]]);
  assert.deepEqual(calls.map((call) => call.rung), [LUNA, HAIKU]);
  assert.equal(calls[0]?.signal.aborted, true, "the timed-out call is told to stop");
});

test("a schema-invalid answer moves to the next hop", async () => {
  const { record } = await classify(PLAIN_TASK, config(LUNA, [HAIKU]), {
    [LUNA]: "nonsense",
    [HAIKU]: { answer: answer("standard") },
  });
  assert.equal(record.cause, `model:${HAIKU}`);
  assert.equal(record.hops[0]?.outcome, "schema-invalid");
});

test("an answer missing a signal is schema-invalid and moves to the next hop", async () => {
  const incomplete = JSON.stringify({ tier: "standard", why: "no signals given" });
  const { record } = await classify(PLAIN_TASK, config(LUNA, [HAIKU]), {
    [LUNA]: { answer: incomplete },
    [HAIKU]: { answer: answer("standard") },
  });
  assert.equal(record.cause, `model:${HAIKU}`);
  assert.equal(record.hops[0]?.outcome, "schema-invalid");
});

test("an unknown tier moves to the next hop", async () => {
  const { record } = await classify(PLAIN_TASK, config(LUNA, [HAIKU]), {
    [LUNA]: "unknown-tier",
    [HAIKU]: { answer: answer("mechanical") },
  });
  assert.equal(record.cause, `model:${HAIKU}`);
  assert.equal(record.tier, "mechanical");
  assert.equal(record.hops[0]?.outcome, "unknown-tier");
});

test("with every model hop failing the task is unclassified: elevated, whatever words it holds", async () => {
  const risky = "Delete the admin password hash, drop table users, rotate the API key and force-push the branch.";
  for (const task of [risky, PLAIN_TASK, RENAME_TASK]) {
    const { record } = await classify(task, config(LUNA, [HAIKU, SOL, LUNA_MEDIUM, GPT5_LUNA]), {
      [LUNA]: "timeout",
      [HAIKU]: "nonsense",
      [SOL]: "unknown-tier",
      [LUNA_MEDIUM]: "out-of-usage",
      [GPT5_LUNA]: "throws",
    });
    assert.equal(record.cause, "unclassified", task);
    assert.equal(record.tier, "elevated", task);
    assert.deepEqual(record.risk, { level: "unassessed", reasons: [] });
    assert.equal(record.ambiguity, "unassessed");
    assert.equal(record.complexity, "unassessed");
    assert.equal(record.kindOfWork, "unassessed");
    assert.match(record.why, /no classifier model could classify the task, so it runs as elevated/);
    assert.equal(record.rubricVersion, RUBRIC_VERSION);
    assert.equal("floor" in record, false);
    assert.deepEqual(record.hops.map((hop) => [hop.hop, hop.outcome]), [
      [LUNA, "timeout"],
      [HAIKU, "schema-invalid"],
      [SOL, "unknown-tier"],
      [LUNA_MEDIUM, "out-of-usage"],
      [GPT5_LUNA, "error"],
    ]);
  }
});

// ---------------------------------------------------------------------------
// Checkbox 6 (story 18)
// ---------------------------------------------------------------------------

test("a classifier rung on the subagent ban list is refused at load and routing falls to the next hop", async () => {
  const banned = "anthropic/claude-fable-5:low";
  const chain = loadClassifierChain(config(banned, [LUNA]));
  assert.equal(chain.refusals.length, 1);
  assert.equal(chain.refusals[0]?.rung, banned);
  assert.match(chain.refusals[0]!.error, /classifier rung 'anthropic\/claude-fable-5:low' refused at load/);
  assert.match(chain.refusals[0]!.error, /subagent ban list entry 'fable'/);

  const { record, calls } = await classify(PLAIN_TASK, config(banned, [LUNA]), { [LUNA]: { answer: answer("standard") } });
  assert.equal(record.cause, `model:${LUNA}`);
  assert.deepEqual(calls.map((call) => call.rung), [LUNA]);
  assert.equal(record.hops[0]?.outcome, "refused-at-load");
  assert.match(record.hops[0]!.detail ?? "", /subagent ban list/);
});

test("a configured ban list entry refuses a rung the defaults would admit", async () => {
  configureBanLists({ subagentBanList: ["fable", "astra", "luna"], sessionBanList: [] });
  const { record, calls } = await classify(PLAIN_TASK, config(LUNA, [HAIKU]), {
    [LUNA]: { answer: answer("critical") },
    [HAIKU]: { answer: answer("standard") },
  });
  assert.equal(record.cause, `model:${HAIKU}`);
  assert.deepEqual(calls.map((call) => call.rung), [HAIKU]);
});

test("a classifier rung outside the allowed-model list is refused at load and routing falls to the next hop", async () => {
  const outside = "google/gemini-2.5-pro:low";
  const chain = loadClassifierChain(config(outside, [LUNA]));
  assert.match(chain.refusals[0]!.error, /classifier rung 'google\/gemini-2.5-pro:low' refused at load/);
  assert.match(chain.refusals[0]!.error, /outside the configured subagent model scope/);
  const { record, calls } = await classify(PLAIN_TASK, config(outside, [LUNA]), { [LUNA]: { answer: answer("standard") } });
  assert.equal(record.cause, `model:${LUNA}`);
  assert.deepEqual(calls.map((call) => call.rung), [LUNA]);
});

test("a classifier rung without an effort is refused at load", () => {
  const chain = loadClassifierChain(config("openai-codex/gpt-6-luna", [LUNA]));
  assert.match(chain.refusals[0]!.error, /must be written provider\/model:effort/);
});

// ---------------------------------------------------------------------------
// Checkbox 7 (story 19)
// ---------------------------------------------------------------------------

test("each classifier call reserves before the call, settles after, and the ledger labels it classifier", async () => {
  const budget = allowance();
  const openDuringCall: string[] = [];
  const call: ClassifierModelCall = async () => {
    for (const reservation of budget.owner.snapshot().open) openDuringCall.push(`${reservation.label}:${reservation.model}`);
    return answer("standard");
  };
  await classifyTier(
    { task: PLAIN_TASK, role: "worker", paths: [] },
    { chain: loadClassifierChain(DEFAULT_CLASSIFIER_CONFIG), callModel: call, allowance: budget },
  );
  assert.equal(CLASSIFIER_ALLOWANCE_LABEL, "classifier");
  assert.deepEqual(openDuringCall, ["classifier:openai-codex/gpt-6-luna"]);
  const ledger = budget.owner.snapshot();
  assert.equal(ledger.open.length, 0);
  assert.deepEqual(ledger.settled.map((charge) => [charge.label, charge.model]), [["classifier", "openai-codex/gpt-6-luna"]]);
});

test("a failed hop still settles its reservation, so every attempted call is accounted", async () => {
  const budget = allowance();
  await classify(PLAIN_TASK, config(LUNA, [HAIKU]), { [LUNA]: "nonsense", [HAIKU]: { answer: answer("standard") } }, budget);
  const ledger = budget.owner.snapshot();
  assert.equal(ledger.open.length, 0);
  assert.deepEqual(ledger.settled.map((charge) => [charge.label, charge.model]), [
    ["classifier", "openai-codex/gpt-6-luna"],
    ["classifier", "anthropic/claude-haiku-4-5"],
  ]);
});

test("with zero remaining allowance the model hop is skipped and the task is unclassified", async () => {
  const budget = allowance(0);
  const { record, calls } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("critical") } }, budget);
  assert.equal(calls.length, 0);
  assert.equal(record.cause, "unclassified");
  assert.equal(record.tier, "elevated");
  assert.equal(record.hops[0]?.outcome, "allowance-exhausted");
  assert.match(record.hops[0]!.detail ?? "", /no remaining task allowance/);
  assert.equal(budget.owner.snapshot().settled.length, 0);
  assert.equal(budget.owner.snapshot().open.length, 0);
});

test("a metered hop whose estimate exceeds the remaining allowance is refused and not called", async () => {
  const budget = meteredAllowance(0.0001);
  const { record, calls } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("critical") } }, budget);
  assert.equal(calls.length, 0);
  assert.equal(record.cause, "unclassified");
  assert.equal(record.hops[0]?.outcome, "allowance-refused");
  assert.match(record.hops[0]!.detail ?? "", /exceeds the \$0\.0001 remaining/);
  assert.equal(budget.owner.snapshot().open.length, 0);
  assert.equal(budget.owner.snapshot().settled.length, 0);
});

test("a metered call that reports no cost keeps its reservation held open", async () => {
  const budget = meteredAllowance(5);
  const { record } = await classify(PLAIN_TASK, DEFAULT_CLASSIFIER_CONFIG, { [LUNA]: { answer: answer("standard") } }, budget);
  assert.equal(record.cause, `model:${LUNA}`);
  assert.equal(record.hops[0]?.allowance?.settlement, "held-open");
  const ledger = budget.owner.snapshot();
  assert.deepEqual(ledger.open.map((reservation) => [reservation.label, reservation.reservationId]), [
    ["classifier", record.hops[0]!.allowance!.reservationId],
  ]);
  assert.equal(ledger.settled.length, 0);
});

test("a metered call that reports its cost settles with that cost", async () => {
  const budget = meteredAllowance(5);
  const call: ClassifierModelCall = async () => ({ text: answer("standard"), reportedUsd: 0.002 });
  const record = await classifyTier(
    { task: PLAIN_TASK, role: "worker", paths: [] },
    { chain: loadClassifierChain(DEFAULT_CLASSIFIER_CONFIG), callModel: call, allowance: budget },
  );
  assert.equal(record.hops[0]?.allowance?.settlement, "settled");
  const [charge] = budget.owner.snapshot().settled;
  assert.deepEqual(charge?.actualUsd.state === "known" ? charge.actualUsd.value : undefined, 0.002);
});

for (const reportedUsd of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
  test(`a malformed reported cost (${reportedUsd}) is an error hop, not a throw, and a metered hold stays open`, async () => {
    const budget = meteredAllowance(5);
    const call: ClassifierModelCall = async () => ({ text: answer("critical"), reportedUsd });
    const record = await classifyTier(
      { task: PLAIN_TASK, role: "worker", paths: [] },
      { chain: loadClassifierChain(DEFAULT_CLASSIFIER_CONFIG), callModel: call, allowance: budget },
    );
    assert.equal(record.cause, "unclassified");
    assert.equal(record.hops[0]?.outcome, "error");
    assert.match(record.hops[0]!.detail ?? "", /invalid reported cost/);
    assert.equal(record.hops[0]?.allowance?.settlement, "held-open");
    assert.equal(budget.owner.snapshot().open.length, 1);
  });
}

// ---------------------------------------------------------------------------
// Settings (story 18: a configurable rung)
// ---------------------------------------------------------------------------

test("classifier settings come from orchestrator.routing.classifier with defaults, and a malformed key fails closed", () => {
  assert.deepEqual(classifierConfigFromSettings({}), DEFAULT_CLASSIFIER_CONFIG);
  assert.deepEqual(
    classifierConfigFromSettings({ orchestrator: { routing: { classifier: { model: HAIKU, timeoutMs: 5000, fallback: [LUNA] } } } }),
    { model: HAIKU, timeoutMs: 5000, fallback: [LUNA] },
  );
  assert.deepEqual(
    classifierConfigFromSettings({ orchestrator: { routing: { classifier: { fallback: [HAIKU] } } } }),
    { ...DEFAULT_CLASSIFIER_CONFIG, fallback: [HAIKU] },
  );
  assert.throws(
    () => classifierConfigFromSettings({ orchestrator: { routing: { classifier: { timeoutMs: -1 } } } }),
    /orchestrator\.routing\.classifier\.timeoutMs/,
  );
  assert.throws(
    () => classifierConfigFromSettings({ orchestrator: { routing: { classifier: { fallback: "anthropic/claude-haiku-4-5:low" } } } }),
    /orchestrator\.routing\.classifier\.fallback/,
  );
  assert.throws(
    () => classifierConfigFromSettings({ orchestrator: { routing: { classifier: { model: "" } } } }),
    /orchestrator\.routing\.classifier\.model/,
  );
});

test("an unknown key under orchestrator.routing.classifier fails closed naming the key", () => {
  assert.throws(
    () => classifierConfigFromSettings({ orchestrator: { routing: { classifier: { model: HAIKU, timeOutMs: 5000 } } } }),
    /unknown key\(s\) orchestrator\.routing\.classifier\.timeOutMs/,
  );
});

// ---------------------------------------------------------------------------
// Checkbox 8 (story 13): live, seam 2. The only live model allowed here is
// anthropic/claude-haiku-4-5, owner-approved for these three cases. A skip is
// reported as a skip, never as a pass.
// ---------------------------------------------------------------------------

const LIVE_CLASSIFIER_RUNG = "anthropic/claude-haiku-4-5:low";
const LIVE_CASES = [
  {
    name: "formatting fix",
    task: "Reformat src/report.ts with prettier: fix the indentation and add the missing trailing commas. No behaviour change.",
    paths: ["src/report.ts"],
    expected: "mechanical",
  },
  {
    name: "routine multi-file change",
    task:
      "Add an optional pageSize parameter to the list endpoint handler in src/api/list.ts, pass it through " +
      "src/services/list-service.ts to src/repositories/list-repo.ts, default it to 50, and add unit tests.",
    paths: ["src/api/list.ts", "src/services/list-service.ts", "src/repositories/list-repo.ts"],
    expected: "standard",
  },
  {
    name: "one-line auth change",
    task: "Change one line in src/auth/middleware.ts so the authentication check also accepts requests whose session is still refreshing.",
    paths: ["src/auth/middleware.ts"],
    expected: "critical",
  },
] as const;

test(`live classifier on ${LIVE_CLASSIFIER_RUNG} classifies a formatting fix, a routine multi-file change and a one-line auth change`, async (t) => {
  const liveModel = selectedLivePiModel();
  if (liveModel !== "anthropic/claude-haiku-4-5") {
    return t.skip(`the classifier live cases are approved on anthropic/claude-haiku-4-5 only; PI_ORCHESTRATOR_LIVE_MODEL selected ${liveModel}`);
  }
  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  try {
    const authExtension = liveAuthExtensionPath();
    if (!credentialsAvailable() || !authExtension) return t.skip("live credentials/auth extension unavailable");
    const available = livePiModelAvailability(liveModel, () =>
      spawnSync("pi", ["--list-models"], { encoding: "utf8", env: agent.env(), timeout: PI_LIST_MODELS_TIMEOUT_MS }),
    );
    if (available.status !== "available") return t.skip(`live route ${liveModel} unavailable`);

    // The in-session path (ADR 0004): a probe extension classifies inside a
    // real pi session through its own model registry, as the router does.
    const outDir = mkdtempSync(join(tmpdir(), "pi-orchestrator-classifier-"));
    try {
      const out = join(outDir, "records.json");
      const probe = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "session-classifier-probe.ts");
      const run = spawnSync("pi", ["-p", "noop", "--no-session", "-ne", "-e", authExtension, "-e", probe, "--model", liveModel], {
        cwd: agent.home,
        encoding: "utf8",
        timeout: 360_000,
        env: agent.env({
          PI_ORCHESTRATOR_CLASSIFIER_OUT: out,
          PI_ORCHESTRATOR_CLASSIFIER_RUNG: LIVE_CLASSIFIER_RUNG,
          PI_ORCHESTRATOR_CLASSIFIER_CASES: JSON.stringify(LIVE_CASES),
        }),
      });
      const result = JSON.parse(readFileSync(out, "utf8")) as {
        error?: string;
        refusals?: unknown[];
        records?: { readonly name: string; readonly record: TierClassification }[];
        settled?: string[];
      };
      assert.equal(result.error, undefined, `${result.error}\n${run.stderr}`);
      assert.deepEqual(result.refusals, []);
      const records = result.records ?? [];
      for (const { name, record } of records) {
        t.diagnostic(`${name}: ${JSON.stringify(record)}`);
        if (record.hops.some((hop) => hop.outcome === "out-of-usage")) {
          return t.skip(`live provider refused: ${JSON.stringify(record.hops)}`);
        }
      }

      assert.deepEqual(
        records.map(({ name, record }) => [name, record.cause]),
        LIVE_CASES.map((live) => [live.name, `model:${LIVE_CLASSIFIER_RUNG}`]),
        records.map(({ name, record }) => `${name}: ${JSON.stringify(record.hops)}`).join("; "),
      );
      assert.deepEqual(
        records.map(({ name, record }) => [name, record.tier]),
        LIVE_CASES.map((live) => [live.name, live.expected]),
        records.map(({ name, record }) => `${name}: ${record.tier}, why: ${record.why}`).join("; "),
      );
      assert.ok(records.every(({ record }) => record.why.trim().length > 0));
      assert.deepEqual(result.settled, LIVE_CASES.map(() => "classifier"));
    } finally {
      rmSync(outDir, { recursive: true, force: true });
    }
  } finally {
    agent.cleanup();
  }
});
