import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath } from "../fixtures/guarded-agent-dir.ts";
import { piEvents, PROVIDER_REFUSAL, type PiEvent } from "../fixtures/live-pi-session.ts";
import { NOISY_EXTENSION_ANCHOR, writeNoisyExtensionPackage } from "../fixtures/noisy-extension.ts";
import { installPiLaunchLog } from "../fixtures/pi-launch-log.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { GUARD_PREFIX } from "../guard/extension.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { ROUTER_PREFIX } from "../router/extension.ts";
import { readRoutingRecords, type DecisionRecord } from "../routing/decision-record.ts";

// Bean pi-orchestrator-ngf0: the built-in `subagents` tool (ADR 0007) on a
// real pi session, with the owner's package (this checkout, no pi-subagents)
// and one noisy extension (bean 5he0) that appends a plain user message
// through pi's `context` hook, mimicking context-mode. One `subagents` call
// carries two items, both under the default `maxParallel` of 4, so both
// workers start together. The router must classify each worker from its own
// task text only: the noisy extension's injected "Purge" text must set no
// keyword floor and must not reach a decision record's task text.
//
// Only anthropic/claude-haiku-4-5 is approved for this live route. A provider
// refusal (usage, quota, rate limit) is a skip, never a pass or a failure.

const HAIKU = "anthropic/claude-haiku-4-5";
const AUTO_MODEL = "orchestrator/auto";
const WORKER_AGENT = "stub-worker";

const RUNG = {
  mechanical: `${HAIKU}:low`,
  standard: `${HAIKU}:medium`,
  elevated: `${HAIKU}:high`,
  critical: `${HAIKU}:xhigh`,
} as const;
const TIERS = {
  mechanical: [RUNG.mechanical],
  standard: [RUNG.standard],
  elevated: [RUNG.elevated],
  critical: [RUNG.critical],
};

// Reuses routing-acceptance.test.ts's "mechanical 1"/"mechanical 2" wording:
// known to classify mechanical on this live route, with no destructive
// keyword of its own.
const TASK_A = "Reformat src/report.ts with prettier: fix the indentation and add the missing trailing commas. No behaviour change.";
const TASK_B = "Reformat src/invoice.ts with prettier: fix the indentation and add the missing trailing commas. No behaviour change.";

const WORKER_DEFINITION = [
  "---",
  `name: ${WORKER_AGENT}`,
  "description: Stub worker that replies ACK; used by the subagents tool's live acceptance test",
  "tools: read",
  "---",
  "",
  "You are a stub worker in an automated test. There are no files and nothing to change. Whatever the task says, reply with the single word ACK and nothing else. Do not call any tool.",
  "",
].join("\n");

interface SubagentsResultItem {
  readonly task?: string;
  readonly agent?: string;
  readonly status?: string;
  readonly sessionId?: string;
  readonly sessionFile?: string;
  readonly finalText?: string;
  readonly error?: string;
}

function subagentsResults(events: readonly PiEvent[]): { readonly isError: boolean | undefined; readonly items: readonly SubagentsResultItem[] } {
  const start = events.find((event) => event.type === "tool_execution_start" && event.toolName === "subagents" && event.toolCallId);
  assert.ok(start, `no subagents call: ${JSON.stringify(events.filter((e) => e.type?.startsWith("tool_"))).slice(0, 2000)}`);
  const end = events.find((event) => event.type === "tool_execution_end" && event.toolCallId === start!.toolCallId);
  const items = (end?.result?.details?.results ?? []) as unknown as SubagentsResultItem[];
  return { isError: end?.isError, items };
}

/** The worker's pi session id: the id in its session file's header. */
function workerSessionId(file: string): string {
  const header = JSON.parse(readFileSync(file, "utf8").split("\n")[0]!) as { type?: string; id?: string };
  assert.equal(header.type, "session", `no session header in ${file}`);
  assert.ok(header.id, `no session id in ${file}`);
  return header.id;
}

function decisionFor(records: readonly DecisionRecord[], sessionId: string): DecisionRecord {
  const own = records.filter((record) => record.delegationId === sessionId);
  assert.equal(own.length, 1, `one decision record for worker ${sessionId}: ${JSON.stringify(records.map((record) => record.delegationId))}`);
  return own[0]!;
}

test(`live ${HAIKU} session: two parallel workers through the built-in subagents tool are not polluted by a noisy extension`, async (t: TestContext) => {
  const liveModel = selectedLivePiModel();
  if (liveModel !== HAIKU) return t.skip(`this test is approved on ${HAIKU} only; PI_ORCHESTRATOR_LIVE_MODEL selected ${liveModel}`);
  const authExtension = liveAuthExtensionPath();
  if (!credentialsAvailable() || !authExtension) return t.skip("live credentials/auth extension unavailable");

  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  const project = createTempRepo();
  const launches = installPiLaunchLog(agent.home);
  const cleanups: (() => void)[] = [() => agent.cleanup(), () => project.cleanup()];
  try {
    cleanups.push(() => {
      const { stopped, skipped } = launches.stopRunning();
      if (stopped.length > 0) t.diagnostic(`stopped ${stopped.length} still-running pi launch(es): ${stopped.join(", ")}`);
      for (const { pid, reason } of skipped) t.diagnostic(`left pi launch pid ${pid} without an exit marker alone: ${reason}`);
    });

    const baseEnv = agent.env(launches.env);
    const listed = spawnSync("pi", ["--list-models"], { encoding: "utf8", env: baseEnv, timeout: PI_LIST_MODELS_TIMEOUT_MS });
    const available = livePiModelAvailability(HAIKU, () => listed);
    if (available.status !== "available") return t.skip(`live route ${HAIKU} unavailable`);

    mkdirSync(join(agent.dir, "agents"));
    writeFileSync(join(agent.dir, "agents", `${WORKER_AGENT}.md`), WORKER_DEFINITION);
    const orchestratorPackage = resolve(import.meta.dirname, "..", "..");
    const noisyPackage = writeNoisyExtensionPackage(agent.home);

    writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      quietStartup: true,
      enableInstallTelemetry: false,
      // No pi-subagents: the built-in `subagents` tool comes from this
      // checkout's own package. The noisy extension is a second, separate
      // package, exactly as an owner would install one alongside pi-orchestrator.
      packages: [authExtension, orchestratorPackage, noisyPackage],
      orchestrator: {
        routing: { enabled: true, mode: "live", classifier: { model: `${HAIKU}:off`, timeoutMs: 120_000 }, tiers: TIERS },
      },
    }, null, 2));

    const stateDir = join(agent.home, "state");
    const recordDir = join(stateDir, "routing");
    const approval = grantOwnerApproval({ approvedBy: "pi-orchestrator-ngf0 acceptance", scope: "data-recipient", acknowledgement: "send the acceptance tasks to anthropic" });
    saveAuthorization(join(stateDir, "authorized-recipients.json"), authorizeRecipient(emptyAuthorization(), "anthropic", approval));

    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);
    const noiseLog = join(agent.home, "noisy-extension.log");

    const items = [
      { agent: WORKER_AGENT, task: TASK_A },
      { agent: WORKER_AGENT, task: TASK_B },
    ];
    const prompt = [
      "Call the subagents tool exactly once, with exactly these arguments and no others, and do nothing else yourself:",
      JSON.stringify({ items }),
      "When the tool returns, reply with the single word DONE.",
    ].join("\n");

    const run = spawnSync(
      "pi",
      ["-p", prompt, "--mode", "json", "-t", "subagent", "--model", HAIKU, "--thinking", "off"],
      {
        cwd: project.dir,
        env: agent.env({
          ...launches.env,
          TMPDIR: tmp,
          PI_ORCHESTRATOR_STATE_DIR: stateDir,
          PI_ORCHESTRATOR_ROUTER_PROBE: "1",
          PI_ORCHESTRATOR_GUARD_PROBE: "1",
          PI_NOISY_EXTENSION_LOG: noiseLog,
        }),
        encoding: "utf8",
        timeout: 420_000,
        // A session's JSON event stream can be several MB.
        maxBuffer: 512 * 1024 * 1024,
      },
    );
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const refusal = `${stdout}${stderr}`.match(PROVIDER_REFUSAL)?.[0];
    t.diagnostic(`exit ${run.status}${run.error ? ` (${run.error.message})` : ""}`);
    if (refusal) return t.skip(`live provider refused: ${refusal}`);
    assert.equal(run.status, 0, stderr.slice(-2000));
    assert.match(stderr, new RegExp(`${GUARD_PREFIX} loaded`), stderr.slice(-2000));
    assert.match(stderr, new RegExp(`${ROUTER_PREFIX} loaded`), stderr.slice(-2000));
    assert.match(stderr, new RegExp(`${ROUTER_PREFIX} routing enabled, mode live`), stderr.slice(-2000));

    const events = piEvents(stdout);
    const { isError, items: results } = subagentsResults(events);
    assert.equal(isError, false, JSON.stringify(results).slice(0, 2000));
    assert.equal(results.length, 2, JSON.stringify(results).slice(0, 2000));
    assert.deepEqual(results.map((result) => result.task), [TASK_A, TASK_B], "results keep item order");

    for (const result of results) {
      assert.equal(result.status, "completed", JSON.stringify(result).slice(0, 1000));
      assert.equal(result.agent, WORKER_AGENT);
      assert.match(result.finalText ?? "", /\bACK\b/);
      assert.ok(result.sessionFile && existsSync(result.sessionFile), `worker session saved: ${result.sessionFile}`);
    }
    const sessionIds = results.map((result) => workerSessionId(result.sessionFile!));
    assert.equal(sessionIds.length, 2);
    const [sessionA, sessionB] = sessionIds as [string, string];
    assert.notEqual(sessionA, sessionB, "each item started its own worker session");

    const allRecords = readRoutingRecords(recordDir);
    assert.deepEqual(allRecords.filter((record) => record.recordType !== "decision"), [], "the router extension writes only decision records here");
    const records = allRecords as DecisionRecord[];
    assert.equal(records.length, 2, "one decision record per worker, from the one subagents call");

    await t.test("both workers ran on orchestrator/auto, routed live to the mechanical rung, from their own task text only", () => {
      for (const [sessionId, task] of [[sessionA, TASK_A], [sessionB, TASK_B]] as const) {
        const record = decisionFor(records, sessionId);
        assert.equal(record.mode, "live");
        assert.equal(record.taskTextPrefix, task, "the decision's task text is the item's task, nothing appended");
        assert.doesNotMatch(record.taskTextPrefix, /purge/i, "the noisy extension's injected text is not the task text");
        assert.deepEqual(record.classification.floorSignals, [], "the noisy extension's \"Purge\" text set no keyword floor");
        assert.equal(record.classification.tier, "mechanical", JSON.stringify(record.classification));
        assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, RUNG.mechanical, JSON.stringify(record.route));
        assert.equal(record.ranOn, RUNG.mechanical);
        const requestLine = new RegExp(`^${ROUTER_PREFIX} request ${sessionId} rung ${RUNG.mechanical.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}, pin new, `, "m");
        assert.match(stderr, requestLine, `${sessionId}: auto provider did not run it on ${RUNG.mechanical}`);
      }
    });

    await t.test("the noisy extension actually ran: it left a log line for each worker's request, proving the assertions above are not vacuous", () => {
      assert.ok(existsSync(noiseLog), `no noisy-extension log at ${noiseLog}: the extension never loaded or never fired`);
      const lines = readFileSync(noiseLog, "utf8").split("\n").filter((line) => line.trim() !== "");
      assert.ok(lines.length >= 2, `expected at least one "context" event per worker, got: ${JSON.stringify(lines)}`);
      t.diagnostic(`noisy extension anchor: ${NOISY_EXTENSION_ANCHOR}`);
      t.diagnostic(`noisy extension fired ${lines.length} time(s)`);
    });

    for (const result of results) t.diagnostic(`${result.agent} ${workerSessionId(result.sessionFile!)}: ${result.status}, model asked for ${AUTO_MODEL}`);
  } finally {
    for (const cleanup of cleanups.reverse()) cleanup();
  }
});
