import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadRefreshState, type CapabilityObservation } from "../catalog/refresh-lifecycle.ts";
import {
  createGuardedAgentDir,
  credentialsAvailable,
  liveAuthExtensionPath,
  realAgentDirPath,
} from "../fixtures/guarded-agent-dir.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
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
  writeDecisionRecord,
  type DecisionRecordInput,
  type OrphanedVerdictRecord,
  type VerdictRecord,
} from "./decision-record.ts";
import {
  attachVerdict,
  installVerdictReviewer,
  VERDICT_OUTPUT_SCHEMA,
  VERDICT_REVIEWER_AGENT,
  verdictFromReviewResult,
} from "./verdicts.ts";

// Ticket 25, stories 30 to 32. Seams: `verdictFromReviewResult` over a
// pi-subagents review result, `attachVerdict` over a record folder and ticket
// 08's ledger file, and (live, at the end) a real review on Haiku.

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
  return writeDecisionRecord(records, {
    attemptId: "attempt-1",
    at: DECIDED_AT,
    mode: "live",
    taskText: TASK,
    agentRole: "worker",
    classification: await fixtureClassification(TASK, "standard", "implement"),
    tierMap,
    route: fixtureRoute("standard", tierMap),
    ...overrides,
  } as DecisionRecordInput);
}

function verifiedOutcomes(ledger: string): CapabilityObservation[] {
  if (!existsSync(ledger)) return [];
  return loadRefreshState(ledger).observations.filter((observation) => observation.source === "verified-task-outcome");
}

// ---------------------------------------------------------------------------
// Checkbox 5 (story 31): structured field only, prose never parsed
// ---------------------------------------------------------------------------

test("a review result with no structured field yields missing, even when its prose says ACCEPT", () => {
  const prose = "Looks good to me.\nVERDICT: ACCEPT\nACCEPT\n```json\n{\"verdict\":\"accept\"}\n```";
  assert.equal(verdictFromReviewResult({ finalOutput: prose }), "missing");
  assert.equal(verdictFromReviewResult({ finalOutput: prose, output: prose, structuredOutput: undefined }), "missing");
  assert.equal(verdictFromReviewResult({ structuredOutput: { summary: "ACCEPT" }, finalOutput: prose }), "missing");
  assert.equal(verdictFromReviewResult({ structuredOutput: { verdict: "ACCEPT" } }), "missing", "only the schema's exact values count");
  assert.equal(verdictFromReviewResult({ structuredOutput: "accept" }), "missing");
  assert.equal(verdictFromReviewResult(prose), "missing");
  assert.equal(verdictFromReviewResult(undefined), "missing");
});

test("a structured verdict field is read as it is, whatever the prose says", () => {
  assert.equal(verdictFromReviewResult({ structuredOutput: { verdict: "accept" }, finalOutput: "VERDICT: request_changes" }), "accept");
  assert.equal(verdictFromReviewResult({ structuredOutput: { verdict: "request_changes", summary: "off by one" } }), "request_changes");
});

test("the reviewer agent definition declares outputSchema with a required verdict enum, as pi-subagents parses it", () => {
  assert.deepEqual(VERDICT_OUTPUT_SCHEMA.required, ["verdict"]);
  assert.deepEqual(VERDICT_OUTPUT_SCHEMA.properties.verdict.enum, ["accept", "request_changes"]);
  const home = mkdtempSync(join(tmpdir(), "pi-harness-reviewer-agent-"));
  try {
    const agentDir = join(home, "agent");
    const installed = installVerdictReviewer(agentDir);
    assert.equal(installed, join(agentDir, "agents", `${VERDICT_REVIEWER_AGENT}.md`));
    const agents = fileURLToPath(new URL("../../../../../../.pi/agent/npm/node_modules/pi-subagents/src/agents/agents.js", import.meta.url));
    const probe =
      `import { discoverAgents } from ${JSON.stringify(agents)};` +
      `const found = discoverAgents(${JSON.stringify(home)}, "user").agents.find((agent) => agent.name === ${JSON.stringify(VERDICT_REVIEWER_AGENT)});` +
      "process.stdout.write(JSON.stringify(found ? { outputSchema: found.outputSchema, model: found.model, defaultAsync: found.defaultAsync } : null));";
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
      timeout: 30_000,
    });
    assert.equal(run.status, 0, run.stderr);
    const parsed = JSON.parse(run.stdout) as { outputSchema: unknown; model: string; defaultAsync?: boolean } | null;
    assert.ok(parsed, "pi-subagents did not discover the reviewer");
    assert.deepEqual(parsed.outputSchema, VERDICT_OUTPUT_SCHEMA);
    assert.equal(parsed.model, "anthropic/claude-haiku-4-5");
    // Foreground by default, so a call that omits `async` still returns the
    // structured verdict in the tool result.
    assert.equal(parsed.defaultAsync, false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Checkbox 6 (story 32): attach by attempt id, orphans kept
// ---------------------------------------------------------------------------

test("a verdict with a known attempt id is attached to that decision and one with an unknown id is stored as orphaned", async () => {
  const f = folder();
  try {
    const decided = await decide(f.records);
    const attached = attachVerdict({ recordDir: f.records, attemptId: "attempt-1", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(attached.status, "attached");
    if (attached.status !== "attached") return;
    assert.equal(attached.decision.attemptId, "attempt-1");
    assert.equal(attached.recordPath, decided.path, "same day, same file");

    const orphaned = attachVerdict({ recordDir: f.records, attemptId: "attempt-unknown", verdict: "request_changes", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(orphaned.status, "orphaned");

    const records = readRoutingRecords(f.records);
    assert.deepEqual(records.map((record) => [record.recordType, record.attemptId]), [
      ["decision", "attempt-1"],
      ["verdict", "attempt-1"],
      ["orphaned-verdict", "attempt-unknown"],
    ]);
    const verdict = records[1] as VerdictRecord;
    assert.equal(verdict.verdict, "accept");
    assert.equal(verdict.decisionFile, "2026-09-25.jsonl");
    assert.equal(verdict.timestamp, REVIEWED_AT.toISOString());
    assert.equal((records[2] as OrphanedVerdictRecord).verdict, "request_changes");
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
    attachVerdict({ recordDir: f.records, attemptId: "attempt-1", verdict: "request_changes", at: REVIEWED_AT, refreshStatePath: f.ledger });
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

    attachVerdict({ recordDir: f.records, attemptId: "attempt-1", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    outcomes = verifiedOutcomes(f.ledger);
    assert.equal(outcomes.length, 1, "the ledger dedupes on the attempt id");
    assert.equal(outcomes[0]!.outcome, "pass", "the newest verdict is kept");
    assert.equal(loadRefreshState(f.ledger).observations.length, 1);
  } finally {
    f.cleanup();
  }
});

test("a missing verdict is attached but records no observation", async () => {
  const f = folder();
  try {
    await decide(f.records);
    const outcome = attachVerdict({ recordDir: f.records, attemptId: "attempt-1", verdict: "missing", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(outcome.status, "attached");
    assert.equal(outcome.status === "attached" ? outcome.observation : "wrong", undefined);
    assert.deepEqual(verifiedOutcomes(f.ledger), []);
    assert.equal(existsSync(f.ledger), false, "the ledger is not touched");
    assert.equal((readRoutingRecords(f.records)[1] as VerdictRecord).verdict, "missing");
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
    await decide(f.records, { attemptId: "attempt-shadow", mode: "shadow", handPickedModel: OPUS } as Partial<DecisionRecordInput>);
    attachVerdict({ recordDir: f.records, attemptId: "attempt-shadow", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
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
    await decide(f.records, { attemptId: "attempt-refused", route: fixtureRefusal("elevated") });
    const outcome = attachVerdict({ recordDir: f.records, attemptId: "attempt-refused", verdict: "accept", at: REVIEWED_AT, refreshStatePath: f.ledger });
    assert.equal(outcome.status, "attached");
    assert.deepEqual(verifiedOutcomes(f.ledger), []);
    assert.equal(existsSync(f.ledger), false);
  } finally {
    f.cleanup();
  }
});

test("the reviewer definition file on disk is the one installed", () => {
  const source = readFileSync(new URL("./verdict-reviewer.md", import.meta.url), "utf8");
  assert.match(source, /^outputSchema: /m);
  assert.match(source, /^name: verdict-reviewer$/m);
});

// ---------------------------------------------------------------------------
// Checkbox 4 (story 30): live, seam 2. A real review on Haiku through
// pi-subagents' structured-output path: a parent `pi -p` session on Haiku
// calls the `subagent` tool once with the verdict reviewer, whose frontmatter
// declares the outputSchema; the child (also Haiku) must finish by calling
// `structured_output`, which pi-subagents validates and returns to the parent
// as `details.results[0].structuredOutput`. The only live model allowed here
// is anthropic/claude-haiku-4-5. A skip is reported as a skip, never a pass.
// ---------------------------------------------------------------------------

const LIVE_REVIEW_TASK =
  "Review this change to src/math.ts. The task was: make add(a, b) return the sum of a and b.\n\n" +
  "--- a/src/math.ts\n+++ b/src/math.ts\n" +
  "-export function add(a: number, b: number): number { return 0; }\n" +
  "+export function add(a: number, b: number): number { return a - b; }\n";

interface PiEvent {
  readonly type?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly result?: { readonly content?: readonly { readonly text?: string }[]; readonly details?: { readonly results?: readonly Record<string, unknown>[] } };
  readonly message?: { readonly role?: string; readonly usage?: Record<string, unknown>; readonly errorMessage?: string };
}

function piEvents(stdout: string): PiEvent[] {
  return stdout.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try {
      return [JSON.parse(line) as PiEvent];
    } catch {
      return [];
    }
  });
}

/** Every string anywhere in a value, for the test's own look at the prose. */
function strings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (typeof value === "object" && value !== null) return Object.values(value).flatMap(strings);
  return [];
}

test("live review on anthropic/claude-haiku-4-5 returns a structured verdict equal to the reviewer's verdict line", async (t) => {
  const liveModel = selectedLivePiModel();
  if (liveModel !== "anthropic/claude-haiku-4-5") {
    return t.skip(`the live review is approved on anthropic/claude-haiku-4-5 only; PI_HARNESS_LIVE_MODEL selected ${liveModel}`);
  }
  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  const repo = createTempRepo();
  const f = folder();
  try {
    const authExtension = liveAuthExtensionPath();
    if (!credentialsAvailable() || !authExtension) return t.skip("live credentials/auth extension unavailable");
    const available = livePiModelAvailability(liveModel, () =>
      spawnSync("pi", ["--list-models"], { encoding: "utf8", env: agent.env(), timeout: PI_LIST_MODELS_TIMEOUT_MS }),
    );
    if (available.status !== "available") return t.skip(`live route ${liveModel} unavailable`);
    installVerdictReviewer(agent.dir);

    // Foreground (`async: false` in the call and as the agent's frontmatter
    // default), so the child's result, structured output
    // included, comes back in the tool result. TMPDIR inside the throwaway
    // home keeps pi-subagents' run artifacts there, removed with it.
    const call = { agent: VERDICT_REVIEWER_AGENT, task: LIVE_REVIEW_TASK, context: "fresh", async: false };
    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);
    const prompt =
      "Call the subagent tool exactly once, with exactly these arguments, and do not review anything yourself:\n" +
      `${JSON.stringify(call)}\n` +
      "When the tool returns, reply with the single word DONE.";
    const subagents = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents", "index.js");
    const run = spawnSync(
      "pi",
      ["-p", prompt, "--mode", "json", "-t", "subagent", "-e", authExtension, "-e", subagents, "--model", liveModel, "--no-session"],
      { cwd: repo.dir, env: agent.env({ TMPDIR: tmp }), encoding: "utf8", timeout: 300_000 },
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (/"errorMessage":"[^"]*(?:usage|quota|rate.?limit|credit|overloaded)[^"]*"/i.test(output)) {
      return t.skip(`live provider refused: ${output.slice(-300)}`);
    }
    const events = piEvents(run.stdout ?? "");
    const parentUsage = events
      .filter((event) => event.type === "message_end" && event.message?.role === "assistant")
      .map((event) => event.message?.usage);
    const end = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
    const child = end?.result?.details?.results?.[0];
    t.diagnostic(`parent usage per turn: ${JSON.stringify(parentUsage)}`);
    t.diagnostic(`child usage: ${JSON.stringify(child?.usage)} model=${String(child?.model)}`);
    t.diagnostic(`child structuredOutput: ${JSON.stringify(child?.structuredOutput)}`);
    assert.equal(run.status, 0, output.slice(-2000));
    assert.ok(end, `no subagent tool result: ${output.slice(-2000)}`);
    assert.equal(end.isError, false, JSON.stringify(end.result?.content).slice(0, 2000));
    assert.ok(child, "the subagent result carries no child details");

    // The harness reads the structured field only.
    const verdict = verdictFromReviewResult(child);
    assert.notEqual(verdict, "missing", `no structured verdict: ${JSON.stringify(child).slice(0, 2000)}`);

    // The test (never the harness) reads the reviewer's own verdict line, to
    // show the structured value is what the reviewer wrote.
    const lines = strings(child).concat(strings(end.result?.content)).flatMap((text) => [...text.matchAll(/VERDICT: (accept|request_changes)\b/g)].map((match) => match[1]));
    t.diagnostic(`verdict lines: ${JSON.stringify(lines)}; structured: ${verdict}`);
    assert.ok(lines.length > 0, `the reviewer wrote no verdict line: ${strings(child).join(" | ").slice(0, 2000)}`);
    assert.ok(lines.every((line) => line === verdict), `verdict lines ${JSON.stringify(lines)} differ from the structured ${verdict}`);

    // End to end: the live verdict attaches to a decision and reaches the ledger.
    await decide(f.records, { attemptId: "attempt-live-review" });
    const attached = attachVerdict({ recordDir: f.records, attemptId: "attempt-live-review", verdict, refreshStatePath: f.ledger });
    assert.equal(attached.status, "attached");
    assert.deepEqual(verifiedOutcomes(f.ledger).map((o) => [o.instance, o.outcome]), [["attempt-live-review", verdict === "accept" ? "pass" : "fail"]]);
  } finally {
    f.cleanup();
    repo.cleanup();
    agent.cleanup();
  }
});
