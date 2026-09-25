import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { liveTest as test } from "../fixtures/live.ts";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath, realAgentDirPath } from "../fixtures/guarded-agent-dir.ts";
import { piEvents, PROVIDER_REFUSAL } from "../fixtures/live-pi-session.ts";
import { installPiLaunchLog, type PiLaunch } from "../fixtures/pi-launch-log.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, type RoutingRecord } from "../routing/decision-record.ts";
import { installRouterEntry } from "../fixtures/extension-entry.ts";
import { ROUTER_PREFIX } from "./extension.ts";

// Seam 2, checkbox 3 (stories 40, 41) and checkbox 8's live half (story 44):
// one real pi session per mode on anthropic/claude-haiku-4-5, the only live
// model allowed here. The router is installed into a throwaway agent dir;
// the parent session calls `subagent` once, in the foreground (`async:
// false`), so the child's result comes back in the tool result. pi-subagents
// sets `details.results[0].model` to the launch model string, provider/id
// plus the effort suffix (`runSingleAttempt`, runs/foreground/execution.js:
// 245 and :355, `model: modelArg`), which is how the child's resolved model
// is read back. TMPDIR sits inside the throwaway home so pi-subagents' run
// artifacts are removed with it.
//
// The classifier runs at Haiku :off inside the parent session (ADR 0004),
// matching the owner's explicit classifier setting. Every `pi`
// started through PATH is logged (../fixtures/pi-launch-log.ts), and the only
// launches are `--list-models` and the parent, never a classifier child.
//
// Spend: each session is one parent turn pair, one in-session classifier
// request and one child reply, all on Haiku. A skip is reported as a skip,
// never a pass.

const HAIKU = "anthropic/claude-haiku-4-5";

/** A test agent with no model and thinking off, so pi's own resolution gives
 *  `anthropic/claude-haiku-4-5:off` (the session model) and a router rung
 *  with its own effort is visible in the child's model string. */
const ECHO_AGENT = [
  "---",
  "name: router-echo",
  "description: Replies with one word; used by the router's live test",
  "thinking: off",
  "tools: read",
  "defaultContext: fresh",
  "async: false",
  "---",
  "",
  "Reply with the single word PONG. Do not call any tool.",
  "",
].join("\n");

function allTiers(rung: string) {
  return { mechanical: [rung], standard: [rung], elevated: [rung], critical: [rung] };
}

interface LiveSession {
  readonly childModel: unknown;
  readonly callArgs: Record<string, unknown> | undefined;
  readonly records: RoutingRecord[];
  readonly hookLine: string | undefined;
  readonly launches: readonly PiLaunch[];
}

async function routerSession(t: TestContext, mode: "shadow" | "live", tierRung: string): Promise<LiveSession | undefined> {
  const liveModel = selectedLivePiModel();
  if (liveModel !== HAIKU) { t.skip(`the router's live test is approved on ${HAIKU} only; PI_ORCHESTRATOR_LIVE_MODEL selected ${liveModel}`); return undefined; }
  const authExtension = liveAuthExtensionPath();
  if (!credentialsAvailable() || !authExtension) { t.skip("live credentials/auth extension unavailable"); return undefined; }
  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  const repo = createTempRepo();
  const launchLog = installPiLaunchLog(agent.home);
  try {
    const available = livePiModelAvailability(HAIKU, () => spawnSync("pi", ["--list-models"], { encoding: "utf8", env: agent.env(launchLog.env), timeout: PI_LIST_MODELS_TIMEOUT_MS }));
    if (available.status !== "available") { t.skip(`live route ${HAIKU} unavailable`); return undefined; }

    installRouterEntry(agent.dir);
    mkdirSync(join(agent.dir, "agents"));
    writeFileSync(join(agent.dir, "agents", "router-echo.md"), ECHO_AGENT);
    writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      quietStartup: true,
      enableInstallTelemetry: false,
      orchestrator: { routing: { enabled: true, mode, classifier: { model: `${HAIKU}:off`, timeoutMs: 90_000 }, tiers: allTiers(tierRung) } },
    }));
    const stateDir = join(agent.home, "state");
    const approval = grantOwnerApproval({ approvedBy: "ticket 27 live test", scope: "data-recipient", acknowledgement: "send the test task to anthropic" });
    saveAuthorization(join(stateDir, "authorized-recipients.json"), authorizeRecipient(emptyAuthorization(), "anthropic", approval));
    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);

    const call = { agent: "router-echo", task: "Reply with the single word PONG.", context: "fresh", async: false };
    const prompt =
      "Call the subagent tool exactly once, with exactly these arguments and no others, and do nothing else yourself:\n" +
      `${JSON.stringify(call)}\n` +
      "When the tool returns, reply with the single word DONE.";
    const subagents = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents", "index.js");
    const run = spawnSync(
      "pi",
      ["-p", prompt, "--mode", "json", "-t", "subagent", "-e", authExtension, "-e", subagents, "--model", HAIKU, "--no-session"],
      { cwd: repo.dir, env: agent.env({ ...launchLog.env, TMPDIR: tmp, PI_ORCHESTRATOR_STATE_DIR: stateDir, PI_ORCHESTRATOR_ROUTER_PROBE: "1" }), encoding: "utf8", timeout: 300_000 },
    );
    const output = `${run.stdout ?? ""}${run.stderr ?? ""}`;
    if (PROVIDER_REFUSAL.test(output)) {
      t.skip(`live provider refused: ${output.slice(-300)}`);
      return undefined;
    }
    const events = piEvents(run.stdout ?? "");
    const parentUsage = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message?.usage);
    const start = events.find((event) => event.type === "tool_execution_start" && event.toolName === "subagent");
    const end = events.find((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
    const child = end?.result?.details?.results?.[0];
    const hookLine = (run.stderr ?? "").split("\n").find((line) => line.startsWith(`${ROUTER_PREFIX} hook `));
    t.diagnostic(`${mode}: parent usage per turn: ${JSON.stringify(parentUsage)}`);
    t.diagnostic(`${mode}: child usage: ${JSON.stringify(child?.usage)} model=${String(child?.model)}`);
    const classifierLine = (run.stderr ?? "").split("\n").find((line) => line.startsWith(`${ROUTER_PREFIX} classifier `));
    assert.ok(classifierLine?.startsWith(`${ROUTER_PREFIX} classifier ${HAIKU}:off first token `), "the probe identifies the successful off classifier request");
    const launches = launchLog.read();
    t.diagnostic(`${mode}: ${hookLine ?? "no hook line"} (includes one in-session Haiku classifier request)`);
    t.diagnostic(`${mode}: ${classifierLine ?? "no classifier line"}`);
    for (const launch of launches) t.diagnostic(`${mode}: launch ${launch.index + 1}: ${launch.kind} turns=${launch.assistantTurns} usage=${JSON.stringify(launch.usage)}`);
    assert.equal(run.status, 0, output.slice(-2000));
    assert.doesNotMatch(run.stderr ?? "", /pi-orchestrator router disabled/, output.slice(-2000));
    assert.ok(end, `no subagent tool result: ${output.slice(-2000)}`);
    assert.equal(end.isError, false, JSON.stringify(end.result?.content).slice(0, 2000));
    return { childModel: child?.model, callArgs: start?.args, records: readRoutingRecords(join(stateDir, "routing")), hookLine, launches };
  } finally {
    launchLog.stopRunning();
    repo.cleanup();
    agent.cleanup();
  }
}

test(`live shadow session on ${HAIKU}: the child runs on the session model and the record shows the router's rung and the disagreement`, async (t) => {
  const session = await routerSession(t, "shadow", "anthropic/claude-sonnet-5:low");
  if (!session) return;
  const [record, ...rest] = session.records;
  assert.equal(rest.length, 0, JSON.stringify(session.records));
  assert.equal(record?.recordType, "decision", JSON.stringify(record));
  if (record?.recordType !== "decision") return;
  assert.equal(record.mode, "shadow");
  assert.equal(record.classification.cause, `model:${HAIKU}:off`, `the in-session classifier decided: ${JSON.stringify(record.classification.hops)}`);
  assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, "anthropic/claude-sonnet-5:low");
  assert.equal(record.handPickedModel, HAIKU);
  // Pinned exactly: the live-mode test's `:low` proves the router wrote the
  // rung only while pi's own resolution for this agent is `:off`.
  assert.equal(session.childModel, `${HAIKU}:off`, "pi's normal resolution: the session model with the agent's thinking");
  assert.ok(session.hookLine, "the probe printed the hook's wall time");
  assert.deepEqual(session.launches.map((launch) => launch.kind), ["list-models", "parent"], "no classifier child: the classifier ran in the session");
});

test(`live live-mode session on ${HAIKU}: the child's resolved model equals the record's rung`, async (t) => {
  const session = await routerSession(t, "live", `${HAIKU}:low`);
  if (!session) return;
  const [record, ...rest] = session.records;
  assert.equal(rest.length, 0, JSON.stringify(session.records));
  assert.equal(record?.recordType, "decision", JSON.stringify(record));
  if (record?.recordType !== "decision") return;
  assert.equal(record.mode, "live");
  assert.equal(record.classification.cause, `model:${HAIKU}:off`, `the in-session classifier decided: ${JSON.stringify(record.classification.hops)}`);
  assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, `${HAIKU}:low`);
  assert.equal(session.childModel, `${HAIKU}:low`, "the child ran on the router's rung, not the session default");
  assert.ok(session.hookLine, "the probe printed the hook's wall time");
  assert.deepEqual(session.launches.map((launch) => launch.kind), ["list-models", "parent"], "no classifier child: the classifier ran in the session");
});
