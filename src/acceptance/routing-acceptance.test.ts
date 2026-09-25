import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCatalog, saveCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState, saveRefreshState, updateFromCallResult } from "../catalog/refresh-lifecycle.ts";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath, realAgentDirPath } from "../fixtures/guarded-agent-dir.ts";
import { piEvents, PROVIDER_REFUSAL, type PiEvent } from "../fixtures/live-pi-session.ts";
import { installPiLaunchLog, type PiLaunch } from "../fixtures/pi-launch-log.ts";
import { fixtureClassification, fixtureRefusal, fixtureRoute, fixtureTierMap, HAIKU as FIXTURE_HAIKU, OPUS, SONNET } from "../fixtures/routing-decision.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { GUARD_PREFIX } from "../guard/extension.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { installRouterEntry } from "../fixtures/extension-entry.ts";
import { ROUTER_DISABLED_PREFIX, ROUTER_PREFIX } from "../router/extension.ts";
import type { RiskTier } from "../routing/classifier.ts";
import {
  readRoutingRecords,
  writeDecisionRecord,
  type DecisionRecord,
  type RoutingRecord,
  type Verdict,
} from "../routing/decision-record.ts";
import { attachVerdict, installVerdictReviewer, VERDICT_REVIEWER_AGENT, verdictFromReviewResult, type AttachVerdictOutcome } from "../routing/verdicts.ts";

// Ticket 28 (story 45): the routing acceptance gate. Seam 2 throughout: real
// `pi -p` sessions on anthropic/claude-haiku-4-5 against a throwaway agent
// dir with the guard (`installGuardEntry`, through `createGuardedAgentDir`)
// and the router (`installRouterEntry`) installed by their real activation
// code, an approved-recipients store, a tier map, ban lists and project
// settings in two temporary git repositories.
//
// Every model that runs is Haiku. The surviving rungs are Haiku at different
// efforts, so each tier's delegation is visible in the child's model string:
//
//   mechanical  anthropic/claude-haiku-4-5:minimal
//   standard    openai-codex/gpt-6-luna:low (out of usage, removed),
//               anthropic/claude-haiku-4-5:low
//   elevated    anthropic/claude-haiku-4-5:high
//   critical    anthropic/claude-haiku-4-5:medium
//
// Codex rungs appear only where they are removed before anything runs: the
// simulated out-of-usage removes them, and `openai-codex` is not an approved
// recipient either, so a failed simulation still cannot send it a task. The
// Fable rung in the first project's override is dropped at load by the ban
// list. The classifier runs on `anthropic/claude-haiku-4-5:off` with no
// fallback: ticket 28's exact six classifications are the quality gate for
// the owner's choice of off. The reviewer is `verdict-reviewer.md`, which pins Haiku.
//
// Four parent sessions (one parent Haiku each):
//
//   A   shadow, project 1  one critical-floor delegation: the record's rung
//                          differs from the model the child runs on
//   B1  live, project 1    mechanical, standard, critical delegation, each
//                          followed by a verdict-reviewer review
//   B2  live, project 1    the second mechanical, standard and critical
//   C   live, project 2    project 2 replaces critical with Codex rungs only,
//                          so a critical task is refused; then a call naming
//                          a banned model, which the guard refuses
//
// Launches: 1 `pi --list-models`, 4 parents, 14 children (8 delegations, 6
// reviews): 19. The 8 classifier calls run inside the parent sessions (ADR
// 0004) and start no `pi`; their tokens and cost are in the router's probe
// lines. Every `pi` started through PATH is logged by
// ../fixtures/pi-launch-log.ts; children are counted from the subagent
// results. A provider refusal is reported as a skip, never a pass, and no
// session after the one that showed it is started.
//
// pi-subagents' intercom bridge is off in the throwaway agent dir, so a child
// has no `contact_supervisor` tool and cannot detach (SUBAGENT_CONFIG).
//
// With PI_ORCHESTRATOR_ACCEPTANCE_TRANSCRIPT_DIR set to an existing directory,
// each session's stdout and stderr and the records folder are copied there
// before the throwaway environment is removed, so a failed run can be read
// without another one.

const HAIKU = "anthropic/claude-haiku-4-5";
const LUNA = "openai-codex/gpt-6-luna";
const SOL = "openai-codex/gpt-6-sol";
const FABLE = "anthropic/claude-fable-5";
const CLASSIFIER_RUNG = `${HAIKU}:off`;
const WORKER_AGENT = "worker";

const RUNG = {
  mechanical: `${HAIKU}:minimal`,
  standardCodex: `${LUNA}:low`,
  standard: `${HAIKU}:low`,
  elevated: `${HAIKU}:high`,
  critical: `${HAIKU}:medium`,
} as const;

const PERSONAL_TIERS = {
  mechanical: [RUNG.mechanical],
  standard: [RUNG.standardCodex, RUNG.standard],
  elevated: [RUNG.elevated],
  critical: [RUNG.critical],
};

const FABLE_RUNG = `${FABLE}:high`;
/** Project 1: a Fable rung for standard, dropped by the ban list, so the
 *  personal standard tier is inherited. */
const PROJECT_WITH_FABLE = { orchestrator: { routing: { tiers: { standard: [FABLE_RUNG] } } } };
const EMPTIED_CRITICAL = [`${LUNA}:high`, `${SOL}:high`];
/** Project 2: critical replaced by Codex rungs only, both removed by the
 *  simulated out-of-usage, so the top tier is empty at route time. */
const PROJECT_EMPTIED_CRITICAL = { orchestrator: { routing: { tiers: { critical: EMPTIED_CRITICAL } } } };

/** A worker with no model: the router routes it, and without a written rung
 *  pi's resolution is the session model with this `thinking: off`. The name
 *  replaces pi-subagents' builtin `worker` (user source ranks higher), so
 *  the classifier sees the role `worker`, as in its own live test. It is a
 *  stub: the task text is what is classified and routed, and the child only
 *  has to run on the routed model and return. */
const WORKER_DEFINITION = [
  "---",
  `name: ${WORKER_AGENT}`,
  "description: Stub worker that replies ACK; used by the routing acceptance test",
  "thinking: off",
  "tools: read",
  "defaultContext: fresh",
  "async: false",
  "---",
  "",
  "You are a stub worker in an automated routing test. There are no files and nothing to change. Whatever the task says, reply with the single word ACK and nothing else. Do not call any tool.",
  "",
].join("\n");

/** pi-subagents' own config in the throwaway agent dir
 *  (`<agentDir>/extensions/subagent/config.json`, `getConfigPath`). With the
 *  intercom bridge off a child gets no `contact_supervisor` tool, so it
 *  cannot detach to ask the parent a question: in the first live run the
 *  worker and the reviewer both detached with a clarification request, the
 *  reviewer's structured verdict never came back, and the parent session
 *  stayed alive waiting on the channel. */
const SUBAGENT_CONFIG = { intercomBridge: { mode: "off" } };

const REVIEW_PREFIX = "There are no files to read: judge only the description in this task. ";

interface Delegation {
  readonly label: string;
  readonly task: string;
  readonly tier: RiskTier;
  readonly rung: string;
  /** The review that follows it, one line so the parent copies it exactly. */
  readonly review: string;
}

// Mechanical and standard reuse the rubric v2 wording of the live classifier
// test (tier-classifier.test.ts, LIVE_CASES); the second of each changes only
// the names. Critical tasks carry a credential and a data-loss keyword, so
// the keyword floor makes them critical whatever the model answers.
const DELEGATIONS: readonly Delegation[] = [
  {
    label: "mechanical 1",
    task: "Reformat src/report.ts with prettier: fix the indentation and add the missing trailing commas. No behaviour change.",
    tier: "mechanical",
    rung: RUNG.mechanical,
    review:
      "Review this change to src/report.ts. The task was: reformat it with prettier, fixing the indentation and adding the missing trailing commas, with no behaviour change. " +
      "The diff re-indents three lines of buildReport from tabs to two spaces and adds a trailing comma after the last entry of the columns array; no other line changes.",
  },
  {
    label: "standard 1",
    task:
      "Add an optional pageSize parameter to the list endpoint handler in src/api/list.ts, pass it through " +
      "src/services/list-service.ts to src/repositories/list-repo.ts, default it to 50, and add unit tests.",
    tier: "standard",
    rung: RUNG.standard,
    review:
      "Review this change. The task was: add an optional pageSize parameter to the list endpoint handler in src/api/list.ts, pass it through src/services/list-service.ts to src/repositories/list-repo.ts, default it to 50, and add unit tests. " +
      "The diff adds pageSize = 50 to the handler, passes it to listService.list, which passes it to listRepo.find as the query limit, and adds a unit test for the default of 50 and for an explicit 10.",
  },
  {
    label: "critical 1",
    task: "Reset the admin password and drop table sessions_old.",
    tier: "critical",
    rung: RUNG.critical,
    review:
      "Review this change. The task was: reset the admin password and drop table sessions_old. " +
      "The diff adds migrations/0042.sql, which sets a new bcrypt hash as the admin user's password and runs DROP TABLE sessions_old; nothing else changes.",
  },
  {
    label: "mechanical 2",
    task: "Reformat src/invoice.ts with prettier: fix the indentation and add the missing trailing commas. No behaviour change.",
    tier: "mechanical",
    rung: RUNG.mechanical,
    review:
      "Review this change to src/invoice.ts. The task was: reformat it with prettier, fixing the indentation and adding the missing trailing commas, with no behaviour change. " +
      "The diff re-indents two lines of formatInvoice from tabs to two spaces and adds a trailing comma after the last entry of the lineItems array; no other line changes.",
  },
  {
    label: "standard 2",
    task:
      "Add an optional sortOrder parameter to the search endpoint handler in src/api/search.ts, pass it through " +
      "src/services/search-service.ts to src/repositories/search-repo.ts, default it to ascending, and add unit tests.",
    tier: "standard",
    rung: RUNG.standard,
    review:
      "Review this change. The task was: add an optional sortOrder parameter to the search endpoint handler in src/api/search.ts, pass it through src/services/search-service.ts to src/repositories/search-repo.ts, default it to ascending, and add unit tests. " +
      "The diff adds sortOrder = 'ascending' to the handler, passes it to searchService.search, which passes it to searchRepo.find as the ORDER BY direction, and adds a unit test for the default and for 'descending'.",
  },
  {
    label: "critical 2",
    task: "Store the password hash column elsewhere, then drop table legacy_users.",
    tier: "critical",
    rung: RUNG.critical,
    review:
      "Review this change. The task was: store the password hash column elsewhere, then drop table legacy_users. " +
      "The diff adds migrations/0043.sql, which copies legacy_users.password_hash into credentials.password_hash for every user, then runs DROP TABLE legacy_users; nothing else changes.",
  },
];

const SHADOW_TASK = "Rotate the service account password and drop table tokens_archive.";
const REFUSED_TASK = "Remove the stored password column and drop table legacy_accounts.";
const BANNED_TASK = "Reply with the single word PONG.";

function delegationCall(task: string): Record<string, unknown> {
  return { agent: WORKER_AGENT, task, context: "fresh", async: false };
}

function reviewCall(review: string): Record<string, unknown> {
  return { agent: VERDICT_REVIEWER_AGENT, task: `${REVIEW_PREFIX}${review}`, context: "fresh", async: false };
}

/** One numbered step per `subagent` call, each with its exact arguments. */
function parentPrompt(calls: readonly Record<string, unknown>[]): string {
  return [
    `Follow these ${calls.length} numbered steps exactly, one at a time and in order. Each step is one call to the subagent tool with exactly the JSON arguments shown: copy them character for character, add no field, remove no field. Make one call per step and wait for it to return before the next step. Make no other subagent call (no steer, status or any other action). A call may return an error; that is expected, so continue with the next step regardless. Do no other work yourself.`,
    "",
    ...calls.map((call, index) => `Step ${index + 1}: call subagent with ${JSON.stringify(call)}`),
    "",
    "When the last step has returned, reply with the single word DONE.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The report check, hand-computed
// ---------------------------------------------------------------------------

interface ExpectedReportRow {
  readonly tier: RiskTier;
  /** `null` for the refused row. */
  readonly rung: string | null;
  readonly decisions: number;
  readonly verdicts: readonly Verdict[];
  readonly shadowDecisions: number;
  readonly shadowAgreements: number;
}

function expectedCounts(row: Omit<ExpectedReportRow, "tier" | "rung">): string {
  const count = (verdict: Verdict) => row.verdicts.filter((value) => value === verdict).length;
  const agreement = row.shadowDecisions === 0
    ? "n/a (no shadow decisions)"
    : `${row.shadowAgreements} of ${row.shadowDecisions} (${Math.round((row.shadowAgreements / row.shadowDecisions) * 100)}%)`;
  return `decisions ${row.decisions}, accept ${count("accept")}, request_changes ${count("request_changes")}, missing ${count("missing")}, shadow agreement ${agreement}`;
}

/** The report the test expects, written from its own list of rows in the
 *  report's line format, never from `buildRoutingReport`. */
function expectedReport(folder: string, rows: readonly ExpectedReportRow[], orphanedVerdicts: number): string {
  const total = {
    decisions: rows.reduce((sum, row) => sum + row.decisions, 0),
    verdicts: rows.flatMap((row) => row.verdicts),
    shadowDecisions: rows.reduce((sum, row) => sum + row.shadowDecisions, 0),
    shadowAgreements: rows.reduce((sum, row) => sum + row.shadowAgreements, 0),
  };
  return [
    `routing report for ${folder}`,
    ...rows.map((row) => `tier ${row.tier}, ${row.rung === null ? "refused" : `rung ${row.rung}`}: ${expectedCounts(row)}`),
    `all: ${expectedCounts(total)}`,
    `orphaned verdicts: ${orphanedVerdicts}`,
    "",
  ].join("\n");
}

const REPORT_SCRIPT = fileURLToPath(new URL("../routing/routing-report.ts", import.meta.url));

function runRoutingReport(folder: string): { status: number | null; stdout: string; stderr: string } {
  const run = spawnSync(process.execPath, [REPORT_SCRIPT, folder], { encoding: "utf8", timeout: 60_000 });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

// Seam 1 companion of checkbox 7: the report check above, against a folder
// whose counts are known by construction. No pi. This is where a change to
// the report's counting (verdicts once per delegation id, newest wins; orphans
// once; explicit records nowhere; shadow agreement) is caught without spend.
test("the gate's hand-computed report equals routing-report.ts over a folder with known counts", async () => {
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
    attach("m-shadow-differs", "missing", later);
    attach("e-refused", "request_changes", later);
    attach("no-such-attempt", "request_changes", later);
    attach("no-such-attempt", "accept", latest);

    const expected = expectedReport(records, [
      { tier: "mechanical", rung: `${FIXTURE_HAIKU}:low`, decisions: 3, verdicts: ["accept", "accept", "missing"], shadowDecisions: 2, shadowAgreements: 1 },
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

// ---------------------------------------------------------------------------
// Live sessions
// ---------------------------------------------------------------------------

interface SubagentCall {
  readonly id: string;
  readonly args: Record<string, unknown>;
  readonly isError: boolean | undefined;
  readonly text: string;
  /** pi-subagents' results; each is one child `pi` launch. */
  readonly children: readonly Record<string, unknown>[];
}

interface SessionRun {
  readonly label: string;
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly calls: readonly SubagentCall[];
  readonly providerRefusal?: string;
}

function subagentCalls(events: readonly PiEvent[]): SubagentCall[] {
  return events.filter((event) => event.type === "tool_execution_start" && event.toolName === "subagent" && event.toolCallId).map((start) => {
    const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start.toolCallId);
    return {
      id: start.toolCallId!,
      args: start.args ?? {},
      isError: end?.isError,
      text: end?.result?.content?.map((item) => item.text ?? "").join("\n") ?? "",
      children: end?.result?.details?.results ?? [],
    };
  });
}

/** Each parent session's `spawnSync` timeout. Their total stays near 1,500 s,
 *  inside activation's 1,800 s full-suite timeout (extension-gate.ts,
 *  `runSuite`), so a hung session fails here as a named subtest and not as
 *  an unexplained suite timeout. A normal run of all four takes about
 *  3.5 minutes. */
const SESSION_TIMEOUTS_MS = { shadow: 240_000, live1: 480_000, live2: 480_000, emptied: 300_000 } as const;

/** Run the sessions in order and stop after the first one whose output shows
 *  a provider refusal, so a 429 in one session spends no further launches. */
function runSessionsUntilRefusal(steps: readonly (() => SessionRun)[]): { readonly sessions: readonly SessionRun[]; readonly refused?: SessionRun } {
  const sessions: SessionRun[] = [];
  for (const step of steps) {
    const session = step();
    sessions.push(session);
    if (session.providerRefusal) return { sessions, refused: session };
  }
  return { sessions };
}

test("the gate's four parent sessions' timeouts total at most 1,500 s, inside activation's 1,800 s suite timeout", () => {
  const total = Object.values(SESSION_TIMEOUTS_MS).reduce((sum, ms) => sum + ms, 0);
  assert.ok(total <= 1_500_000, `sessions total ${total / 1000} s`);
});

test("the gate's parent sessions stop after the first provider refusal, so no further launches are spent", () => {
  const started: string[] = [];
  const session = (label: string, providerRefusal?: string) => (): SessionRun => {
    started.push(label);
    return { label, status: 0, stdout: "", stderr: "", calls: [], ...(providerRefusal ? { providerRefusal } : {}) };
  };
  const run = runSessionsUntilRefusal([session("A"), session("B1", '"errorMessage":"429 rate limit"'), session("B2"), session("C")]);
  assert.deepEqual(started, ["A", "B1"]);
  assert.deepEqual(run.sessions.map((s) => s.label), ["A", "B1"]);
  assert.equal(run.refused?.label, "B1");
  assert.equal(runSessionsUntilRefusal([session("A"), session("B1")]).refused, undefined);
});

function callFor(session: SessionRun, args: Record<string, unknown>): SubagentCall {
  const call = session.calls.find((candidate) => candidate.args.agent === args.agent && candidate.args.task === args.task);
  assert.ok(call, `${session.label}: no subagent call for ${JSON.stringify(args)}; calls made: ${JSON.stringify(session.calls.map((c) => c.args))}`);
  return call;
}

function decisionFor(records: readonly RoutingRecord[], delegationId: string): DecisionRecord {
  const matching = records.filter((record) => record.delegationId === delegationId);
  assert.equal(matching.length > 0 ? matching[0]!.recordType : "none", "decision", `records for ${delegationId}: ${JSON.stringify(matching)}`);
  return matching[0] as DecisionRecord;
}

function childModel(call: SubagentCall): unknown {
  return call.children[0]?.model;
}

/** A complete record by the reader's validation (readRoutingRecords), and
 *  with the parts a reviewer reads not empty. */
function assertCompleteDecision(record: DecisionRecord, label: string): void {
  assert.ok(record.classification.why.trim().length > 0, `${label}: no classifier reason`);
  assert.equal(record.classification.cause, `model:${CLASSIFIER_RUNG}`, `${label}: ${JSON.stringify(record.classification.hops)}`);
  assert.equal(record.classification.rubricVersion.length > 0, true);
  for (const tier of ["mechanical", "standard", "elevated", "critical"] as const) {
    assert.ok(record.tierMap.tiers[tier].length > 0, `${label}: tier map ${tier} empty`);
  }
  assert.ok(record.route.allowanceApplied.length > 0, `${label}: no allowance recorded`);
}

function describeDecision(record: RoutingRecord | undefined): string {
  if (record?.recordType !== "decision") return JSON.stringify(record);
  const { classification: c, route } = record;
  const outcome = route.outcome === "chosen" ? `chosen ${route.tier} ${route.rung.rung}` : `refused (${route.code})`;
  return `${record.mode} ${c.tier} (model ${c.modelTier ?? "-"}, floor ${c.floor}, cause ${c.cause}) -> ${outcome}; removed ${JSON.stringify(route.removed.map((r) => [r.tier, r.rung, r.reason]))}; why: ${c.why}`;
}

test(`routing acceptance gate on ${HAIKU}: six routed delegations with verdicts, project override, out of usage, emptied top tier, shadow then live, banned model, report`, async (t: TestContext) => {
  const liveModel = selectedLivePiModel();
  if (liveModel !== HAIKU) return t.skip(`the routing acceptance runs on ${HAIKU} only; PI_ORCHESTRATOR_LIVE_MODEL selected ${liveModel}`);
  const authExtension = liveAuthExtensionPath();
  if (!credentialsAvailable() || !authExtension) return t.skip("live credentials/auth extension unavailable");

  const agent = createGuardedAgentDir({ withCredentials: true });
  // Run in reverse in `finally`: each is added as soon as its root exists, so
  // a throw part-way through setup leaks nothing.
  const cleanups: (() => void)[] = [() => agent.cleanup()];
  try {
    const project = createTempRepo();
    cleanups.push(() => project.cleanup());
    const emptiedProject = createTempRepo();
    cleanups.push(() => emptiedProject.cleanup());
    const launches = installPiLaunchLog(agent.home);
    // A real pi orphaned by a SIGKILL on its shim is killed before the temp
    // roots are removed.
    cleanups.push(() => {
      const { stopped, skipped } = launches.stopRunning();
      if (stopped.length > 0) t.diagnostic(`stopped ${stopped.length} still-running pi launch(es): ${stopped.join(", ")}`);
      for (const { pid, reason } of skipped) t.diagnostic(`left pi launch pid ${pid} without an exit marker alone: ${reason}`);
    });
    const baseEnv = agent.env(launches.env);
    const listed = spawnSync("pi", ["--list-models"], { encoding: "utf8", env: baseEnv, timeout: PI_LIST_MODELS_TIMEOUT_MS });
    const available = livePiModelAvailability(HAIKU, () => listed);
    if (available.status !== "available") return t.skip(`live route ${HAIKU} unavailable`);
    const listedModels = new Set((listed.stdout ?? "").split("\n").map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length >= 2).map((cols) => `${cols[0]}/${cols[1]}`));
    const missing = [LUNA, SOL, FABLE].filter((model) => !listedModels.has(model));
    if (missing.length > 0) return t.skip(`the gate needs ${missing.join(", ")} listed (only removed, never run); not listed here`);

    // The environment: guard installed by the fixture, router by its own
    // installer, the reviewer and the worker as user agents.
    installRouterEntry(agent.dir);
    installVerdictReviewer(agent.dir);
    writeFileSync(join(agent.dir, "agents", `${WORKER_AGENT}.md`), WORKER_DEFINITION);
    mkdirSync(join(agent.dir, "extensions", "subagent"));
    writeFileSync(join(agent.dir, "extensions", "subagent", "config.json"), JSON.stringify(SUBAGENT_CONFIG));
    const writePersonalSettings = (mode: "shadow" | "live") => writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      quietStartup: true,
      enableInstallTelemetry: false,
      orchestrator: {
        subagentBanList: ["fable", "astra"],
        sessionBanList: ["gpt-6-astra"],
        routing: { enabled: true, mode, classifier: { model: CLASSIFIER_RUNG, timeoutMs: 120_000, fallback: [] }, tiers: PERSONAL_TIERS },
      },
    }, null, 2));
    mkdirSync(join(project.dir, ".pi"));
    writeFileSync(join(project.dir, ".pi", "settings.json"), JSON.stringify(PROJECT_WITH_FABLE));
    mkdirSync(join(emptiedProject.dir, ".pi"));
    writeFileSync(join(emptiedProject.dir, ".pi", "settings.json"), JSON.stringify(PROJECT_EMPTIED_CRITICAL));

    // State: Anthropic approved (openai-codex deliberately not), and Codex
    // out of usage through ticket 08's own call-result path: a simulated
    // throttled result reporting no requests left, applied by
    // `updateFromCallResult` to the saved catalog (usageHeadroom, which is
    // what "out of usage" is derived from) and to refresh-state.json (the
    // throttle). No Codex call is made.
    const stateDir = join(agent.home, "state");
    const recordDir = join(stateDir, "routing");
    const refreshStatePath = join(stateDir, "refresh-state.json");
    const approval = grantOwnerApproval({ approvedBy: "ticket 28 acceptance", scope: "data-recipient", acknowledgement: "send the acceptance tasks to anthropic" });
    saveAuthorization(join(stateDir, "authorized-recipients.json"), authorizeRecipient(emptyAuthorization(), "anthropic", approval));
    const now = new Date();
    const simulated = updateFromCallResult(buildCatalog({ modelIds: [HAIKU, LUNA, SOL] }), emptyRefreshState(), {
      model: LUNA,
      outcome: "throttled",
      observedAt: now.toISOString(),
      reportedUsage: { remainingRequests: 0, resetsAt: new Date(now.getTime() + 6 * 60 * 60 * 1000).toISOString() },
      detail: "simulated out of usage (ticket 28 acceptance)",
    });
    assert.deepEqual(simulated.applied, ["usageHeadroom"]);
    saveCatalog(join(stateDir, "model-catalog.json"), simulated.catalog);
    saveRefreshState(refreshStatePath, simulated.state);

    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);
    const subagents = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents", "index.js");
    const runSession = (label: string, cwd: string, calls: readonly Record<string, unknown>[], timeoutMs: number): SessionRun => {
      const run = spawnSync(
        "pi",
        ["-p", parentPrompt(calls), "--mode", "json", "-t", "subagent", "-e", authExtension, "-e", subagents, "--model", HAIKU, "--thinking", "off", "--no-session"],
        {
          cwd,
          env: agent.env({ ...launches.env, TMPDIR: tmp, PI_ORCHESTRATOR_STATE_DIR: stateDir, PI_ORCHESTRATOR_ROUTER_PROBE: "1", PI_ORCHESTRATOR_GUARD_PROBE: "1" }),
          encoding: "utf8",
          timeout: timeoutMs,
          // The JSON event stream of a six-call session is several MB.
          maxBuffer: 512 * 1024 * 1024,
        },
      );
      const stdout = run.stdout ?? "";
      const stderr = run.stderr ?? "";
      const refusal = `${stdout}${stderr}`.match(PROVIDER_REFUSAL)?.[0];
      const session: SessionRun = { label, status: run.status, stdout, stderr, calls: subagentCalls(piEvents(stdout)), ...(refusal ? { providerRefusal: refusal } : {}) };
      t.diagnostic(`${label}: exit ${run.status}${run.error ? ` (${run.error.message})` : ""}; ${session.calls.length} subagent call(s)`);
      for (const call of session.calls) {
        t.diagnostic(`${label}: ${call.id} agent=${String(call.args.agent)} model=${String(childModel(call))} error=${String(call.isError)} usage=${JSON.stringify(call.children[0]?.usage)} task=${String(call.args.task).slice(0, 60)}`);
      }
      for (const line of stderr.split("\n").filter((l) => l.startsWith(ROUTER_PREFIX) || l.startsWith(GUARD_PREFIX) || l.startsWith(ROUTER_DISABLED_PREFIX))) t.diagnostic(`${label}: ${line}`);
      return session;
    };

    // Shadow, then flip `mode` to live in the throwaway settings.
    const firstHalf = DELEGATIONS.slice(0, 3);
    const secondHalf = DELEGATIONS.slice(3);
    const steps = (delegations: readonly Delegation[]) => delegations.flatMap((d) => [delegationCall(d.task), reviewCall(d.review)]);
    const { sessions, refused } = runSessionsUntilRefusal([
      () => {
        writePersonalSettings("shadow");
        return runSession("A shadow", project.dir, [delegationCall(SHADOW_TASK)], SESSION_TIMEOUTS_MS.shadow);
      },
      () => {
        writePersonalSettings("live");
        return runSession("B1 live", project.dir, steps(firstHalf), SESSION_TIMEOUTS_MS.live1);
      },
      () => runSession("B2 live", project.dir, steps(secondHalf), SESSION_TIMEOUTS_MS.live2),
      () => runSession("C live, emptied critical", emptiedProject.dir, [
        delegationCall(REFUSED_TASK),
        { agent: WORKER_AGENT, task: BANNED_TASK, model: FABLE, context: "fresh", async: false },
      ], SESSION_TIMEOUTS_MS.emptied),
    ]);
    const transcripts = process.env.PI_ORCHESTRATOR_ACCEPTANCE_TRANSCRIPT_DIR;
    if (transcripts) {
      for (const [index, session] of sessions.entries()) {
        writeFileSync(join(transcripts, `session-${index + 1}.stdout.jsonl`), session.stdout);
        writeFileSync(join(transcripts, `session-${index + 1}.stderr.txt`), session.stderr);
      }
    }

    // Every launch, with pi's reported usage.
    const logged: PiLaunch[] = launches.read();
    const children = sessions.flatMap((session) => session.calls.flatMap((call) => call.children.map((child) => ({ session: session.label, agent: String(call.args.agent), child }))));
    for (const launch of logged) {
      const model = launch.args[launch.args.indexOf("--model") + 1];
      t.diagnostic(`launch ${launch.index + 1}: ${launch.kind} model=${launch.kind === "list-models" ? "-" : String(model)} turns=${launch.assistantTurns} usage=${JSON.stringify(launch.usage)}`);
    }
    for (const [index, entry] of children.entries()) {
      t.diagnostic(`child ${index + 1}: ${entry.session} ${entry.agent} model=${String(entry.child.model)} usage=${JSON.stringify(entry.child.usage)}`);
    }
    const loggedCost = logged.reduce((sum, launch) => sum + launch.usage.costUsd, 0);
    const loggedTokens = logged.reduce((sum, launch) => sum + launch.usage.totalTokens, 0);
    const childUsage = children.map((entry) => entry.child.usage as Record<string, unknown> | undefined);
    const childTokens = childUsage.reduce((sum, usage) => sum + ["input", "output", "cacheRead", "cacheWrite"].reduce((s, key) => s + (typeof usage?.[key] === "number" ? (usage[key] as number) : 0), 0), 0);
    const childCost = childUsage.reduce((sum, usage) => sum + (typeof usage?.cost === "number" ? usage.cost : 0), 0);
    t.diagnostic(
      `pi launches: ${logged.length + children.length} (${logged.filter((l) => l.kind === "parent").length} parents, ${logged.filter((l) => l.kind === "classifier").length} classifier, ` +
      `${logged.filter((l) => l.kind === "list-models").length} list-models, ${logged.filter((l) => l.kind === "other").length} other, ${children.length} children); ` +
      `reported tokens ${loggedTokens + childTokens}, pi's reported cost $${(loggedCost + childCost).toFixed(5)} (a consumption signal on the subscription route, not a bill)`,
    );
    // The in-session classifier requests, from the router's probe lines.
    const classifierSpend = sessions.flatMap((session) => session.stderr.split("\n"))
      .map((line) => /^\S+ router: classifier \S+ first token .*, tokens (\d+), reported cost \$(\d+\.\d+)$/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null);
    t.diagnostic(
      `in-session classifier requests: ${classifierSpend.length}, reported tokens ${classifierSpend.reduce((sum, match) => sum + Number(match[1]), 0)}, ` +
      `pi's reported cost $${classifierSpend.reduce((sum, match) => sum + Number(match[2]), 0).toFixed(5)}`,
    );

    if (refused) return t.skip(`live provider refused in ${refused.label}: ${refused.providerRefusal}; no later session was started`);
    const [shadow, live1, live2, emptied] = sessions as readonly [SessionRun, SessionRun, SessionRun, SessionRun];

    const records = readRoutingRecords(recordDir);
    for (const record of records) t.diagnostic(`record ${record.delegationId}: ${record.recordType} ${describeDecision(record)}`);

    // Verdicts: each delegation's review, read from the structured field only,
    // attached by the delegation's delegation id.
    const reviewed: { delegation: Delegation; delegationId: string; verdict: Verdict; outcome: AttachVerdictOutcome }[] = [];
    for (const [session, delegations] of [[live1, firstHalf], [live2, secondHalf]] as const) {
      for (const delegation of delegations) {
        const work = session.calls.find((call) => call.args.agent === WORKER_AGENT && call.args.task === delegation.task);
        const review = session.calls.find((call) => call.args.agent === VERDICT_REVIEWER_AGENT && call.args.task === reviewCall(delegation.review).task);
        if (!work || !review) continue;
        const verdict = verdictFromReviewResult(review.children[0]);
        reviewed.push({ delegation, delegationId: work.id, verdict, outcome: attachVerdict({ recordDir, delegationId: work.id, verdict, refreshStatePath }) });
      }
    }
    const report = runRoutingReport(recordDir);
    t.diagnostic(`routing report (exit ${report.status}):\n${report.stdout}${report.stderr}`);
    if (transcripts && existsSync(recordDir)) cpSync(recordDir, join(transcripts, "routing"), { recursive: true });

    await t.test("every session ran with the guard and the router loaded, and every model that ran is Haiku", () => {
      for (const session of sessions) {
        assert.equal(session.status, 0, `${session.label}: ${session.stderr.slice(-2000)}`);
        assert.match(session.stderr, new RegExp(`${GUARD_PREFIX} loaded`), session.label);
        assert.match(session.stderr, new RegExp(`${ROUTER_PREFIX} loaded`), session.label);
        assert.doesNotMatch(session.stderr, new RegExp(ROUTER_DISABLED_PREFIX), `${session.label}: ${session.stderr.slice(-2000)}`);
        assert.doesNotMatch(session.stderr, /pi-orchestrator guard disabled:/, `${session.label}: ${session.stderr.slice(-2000)}`);
        assert.match(session.stderr, /subagent ban list: fable, astra; session ban list: gpt-6-astra/, session.label);
      }
      for (const launch of logged.filter((l) => l.kind === "parent")) {
        assert.equal(launch.args[launch.args.indexOf("--model") + 1], HAIKU, JSON.stringify(launch.args.slice(0, 8)));
      }
      // The classifier runs in the parent sessions: no classifier child, and
      // every in-session classifier request printed its probe line.
      assert.deepEqual(logged.filter((l) => l.kind !== "parent" && l.kind !== "list-models").map((l) => l.kind), [], "no classifier or other pi launch");
      const classifierLines = sessions.flatMap((session) => session.stderr.split("\n").filter((line) => line.startsWith(`${ROUTER_PREFIX} classifier ${CLASSIFIER_RUNG} `)));
      assert.equal(classifierLines.length, 8, classifierLines.join("\n"));
      for (const entry of children) {
        assert.match(String(entry.child.model), /^anthropic\/claude-haiku-4-5(?::[a-z]+)?$/, `${entry.session} ${entry.agent}`);
        assert.notEqual(entry.child.detached, true, `${entry.session} ${entry.agent} detached: ${JSON.stringify(entry.child.toolCalls)}`);
      }
      assert.ok(logged.length + children.length <= 22, `launch cap: ${logged.length + children.length}`);
    });

    await t.test("checkbox 1: six live delegations, two per tier, each with a complete decision record and a structured verdict from a real review", () => {
      const problems: string[] = [];
      for (const [session, delegations] of [[live1, firstHalf], [live2, secondHalf]] as const) {
        for (const delegation of delegations) {
          const work = callFor(session, delegationCall(delegation.task));
          const record = decisionFor(records, work.id);
          assertCompleteDecision(record, delegation.label);
          assert.equal(record.mode, "live");
          if (record.classification.tier !== delegation.tier) problems.push(`${delegation.label}: classified ${describeDecision(record)}`);
          assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, delegation.rung, `${delegation.label}: ${describeDecision(record)}`);
          assert.equal(childModel(work), delegation.rung, `${delegation.label}: the child ran on the record's rung`);
          const review = callFor(session, reviewCall(delegation.review));
          assert.equal(review.isError, false, review.text.slice(0, 1000));
        }
      }
      assert.deepEqual(problems, [], "a task landed on a neighbouring tier; the assertion is not loosened");
      assert.equal(reviewed.length, 6);
      for (const entry of reviewed) {
        assert.notEqual(entry.verdict, "missing", `${entry.delegation.label}: the review returned no structured verdict`);
        assert.equal(entry.outcome.status, "attached", entry.delegation.label);
        assert.equal(entry.outcome.status === "attached" && entry.outcome.decision.delegationId, entry.delegationId);
      }
      const afterAttach = readRoutingRecords(recordDir);
      const verdicts = afterAttach.filter((record) => record.recordType === "verdict");
      assert.deepEqual(verdicts.map((record) => record.delegationId).sort(), reviewed.map((entry) => entry.delegationId).sort());
      assert.deepEqual(DELEGATIONS.map((d) => d.tier), ["mechanical", "standard", "critical", "mechanical", "standard", "critical"]);
    });

    await t.test("checkbox 2: the project's Fable rung is dropped by the ban list and the personal tier inherited, as the record's tier map says", () => {
      const inProject = [shadow, live1, live2].flatMap((session) => session.calls.filter((call) => call.args.agent === WORKER_AGENT)).map((call) => decisionFor(records, call.id));
      assert.equal(inProject.length, 7);
      for (const record of inProject) {
        assert.deepEqual(record.tierMap.drops, [
          { tier: "standard", rung: FABLE_RUNG, origin: "project", reason: "subagent ban list" },
          { tier: "standard", origin: "project", reason: "inherited after drops" },
        ]);
        assert.deepEqual(record.tierMap.tiers.standard.map((rung) => [rung.rung, rung.origin]), [[RUNG.standardCodex, "personal"], [RUNG.standard, "personal"]]);
      }
    });

    await t.test("checkbox 3: Codex out of usage falls through to the Claude rung in the same tier, with no tier move", () => {
      for (const [session, delegations] of [[live1, firstHalf], [live2, secondHalf]] as const) {
        for (const delegation of delegations.filter((d) => d.tier === "standard")) {
          const work = callFor(session, delegationCall(delegation.task));
          const record = decisionFor(records, work.id);
          assert.equal(record.route.outcome, "chosen", describeDecision(record));
          if (record.route.outcome !== "chosen") continue;
          assert.equal(record.route.startedAtTier, "standard");
          assert.equal(record.route.tier, "standard");
          assert.deepEqual(record.route.tiersTried, ["standard"]);
          assert.deepEqual(record.route.removed.map((r) => [r.tier, r.rung, r.reason]), [["standard", RUNG.standardCodex, "provider out of usage"]]);
          assert.match(record.route.removed[0]!.detail, /openai-codex.*out of usage/);
          assert.equal(record.route.rung.rung, RUNG.standard);
          assert.equal(childModel(work), RUNG.standard);
        }
      }
    });

    await t.test("checkbox 4: an emptied top tier refuses, listing every removed rung, and no model is written", () => {
      const work = callFor(emptied, delegationCall(REFUSED_TASK));
      const record = decisionFor(records, work.id);
      assertCompleteDecision(record, "refused critical");
      assert.equal(record.mode, "live");
      assert.equal(record.classification.tier, "critical", describeDecision(record));
      assert.deepEqual(record.tierMap.tiers.critical.map((rung) => [rung.rung, rung.origin]), EMPTIED_CRITICAL.map((rung) => [rung, "project"]));
      assert.equal(record.route.outcome, "refused", describeDecision(record));
      if (record.route.outcome !== "refused") return;
      assert.equal(record.route.startedAtTier, "critical");
      assert.deepEqual(record.route.tiersTried, ["critical"]);
      assert.deepEqual(record.route.removed.map((r) => [r.tier, r.rung, r.reason]), EMPTIED_CRITICAL.map((rung) => ["critical", rung, "provider out of usage"]));
      for (const rung of EMPTIED_CRITICAL) assert.ok(record.route.message.includes(rung), record.route.message);
      // The router never blocks: the call proceeded with no model written,
      // so the child ran on pi's own resolution (the session model with the
      // worker's `thinking: off`).
      assert.equal(work.isError, false, work.text.slice(0, 1000));
      assert.equal(childModel(work), `${HAIKU}:off`);
    });

    await t.test("checkbox 5: shadow records without changing the delegated model; after the flip to live the next session's child runs on the record's rung", () => {
      const shadowCall = callFor(shadow, delegationCall(SHADOW_TASK));
      const record = decisionFor(records, shadowCall.id);
      assertCompleteDecision(record, "shadow");
      assert.equal(record.mode, "shadow");
      assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, RUNG.critical, describeDecision(record));
      assert.equal(record.handPickedModel, HAIKU);
      assert.equal(childModel(shadowCall), `${HAIKU}:off`, "shadow: pi's own resolution, not the record's rung");
      assert.match(shadow.stderr, new RegExp(`${ROUTER_PREFIX} routing enabled, mode shadow`));

      assert.match(live1.stderr, new RegExp(`${ROUTER_PREFIX} routing enabled, mode live`));
      const first = callFor(live1, delegationCall(firstHalf[0]!.task));
      const liveRecord = decisionFor(records, first.id);
      assert.equal(liveRecord.mode, "live");
      assert.equal(childModel(first), liveRecord.route.outcome === "chosen" ? liveRecord.route.rung.rung : "refused");
    });

    await t.test("checkbox 6: a subagent call naming a banned model is refused by the guard; the router's record for it is absent or explicit", () => {
      const banned = callFor(emptied, { agent: WORKER_AGENT, task: BANNED_TASK });
      assert.equal(banned.args.model, FABLE);
      assert.equal(banned.isError, true);
      assert.match(banned.text, /prohibited model: anthropic\/claude-fable-5/);
      assert.deepEqual(banned.children, [], "no child ran");
      const forIt = records.filter((record) => record.delegationId === banned.id || record.delegationId.startsWith(`${banned.id}:`));
      t.diagnostic(`records for the banned call: ${JSON.stringify(forIt.map((record) => record.recordType))}`);
      assert.ok(forIt.every((record) => record.recordType === "explicit"), JSON.stringify(forIt));
    });

    await t.test("checkbox 7: routing-report.ts over the records folder prints the hand-computed counts", () => {
      const verdictOf = (label: string) => reviewed.find((entry) => entry.delegation.label === label)?.verdict ?? "missing";
      const expected = expectedReport(recordDir, [
        { tier: "mechanical", rung: RUNG.mechanical, decisions: 2, verdicts: [verdictOf("mechanical 1"), verdictOf("mechanical 2")], shadowDecisions: 0, shadowAgreements: 0 },
        { tier: "standard", rung: RUNG.standard, decisions: 2, verdicts: [verdictOf("standard 1"), verdictOf("standard 2")], shadowDecisions: 0, shadowAgreements: 0 },
        // The shadow delegation (no review) and the two live critical ones.
        { tier: "critical", rung: RUNG.critical, decisions: 3, verdicts: [verdictOf("critical 1"), verdictOf("critical 2")], shadowDecisions: 1, shadowAgreements: 1 },
        { tier: "critical", rung: null, decisions: 1, verdicts: [], shadowDecisions: 0, shadowAgreements: 0 },
      ], 0);
      assert.equal(report.status, 0, report.stderr);
      assert.equal(report.stdout, expected);
    });
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
});
