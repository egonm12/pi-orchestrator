import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { TestContext } from "node:test";
import { liveTest as test } from "../fixtures/live.ts";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath, realAgentDirPath } from "../fixtures/guarded-agent-dir.ts";
import { piEvents, PROVIDER_REFUSAL, type PiEvent } from "../fixtures/live-pi-session.ts";
import { installPiLaunchLog } from "../fixtures/pi-launch-log.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { livePiModelAvailability, PI_LIST_MODELS_TIMEOUT_MS, selectedLivePiModel } from "../policy/live-model.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, type DecisionRecord } from "../routing/decision-record.ts";
import { ROUTER_PREFIX } from "./extension.ts";

// Seam 2 of the auto model (ADR 0006): a real `pi -p` session on
// anthropic/claude-haiku-4-5, the only live model allowed here, with
// pi-subagents, pi-orchestrator (this checkout) and the Anthropic login
// package installed as packages in a throwaway agent dir. A background
// worker's process loads installed packages, not `-e` extensions, so all three
// are `packages` entries of the throwaway `settings.json`, loaded from where
// they already are; nothing is copied and the real agent dir is only read.
// pi-subagents is pointed at `orchestrator/auto` through its own
// `subagents.defaultModel` in that throwaway settings file.
//
// While the router's `tool_call` hook for `subagent` still exists, it routes
// over a `subagents.defaultModel` and would write the real rung into the call,
// so the worker would never run on `orchestrator/auto`. The test agents
// therefore also pin `model: orchestrator/auto` in their frontmatter, which
// the hook records as an explicit-model record and leaves alone. Ticket itu1
// removes the hook and this frontmatter pin, so the `defaultModel` path is
// exercised on its own. Until then only `decision` records are asserted on.
//
// Every rung is Haiku (at a different effort per tier, or the dated Haiku id
// in the compact-and-retry case), the classifier is Haiku :off and the
// orchestrator's session model is Haiku, so only Haiku runs. The router's
// probe line (`request <sessionId> rung <rung>, pin new|reused`) shows the
// rung each worker request went to: on the parent's stderr for a foreground
// worker, and in pi-subagents' `runner.stderr.log` for a background worker.
//
// Spend: two parent sessions of two to three Haiku turns each, three worker
// sessions of one to four Haiku turns (under 10k tokens of context each), one in-process classifier call per
// worker session and one per compaction summary. A skip is a skip, never a
// pass.

const HAIKU = "anthropic/claude-haiku-4-5";
const HAIKU_ID = "claude-haiku-4-5";
const AUTO_MODEL = "orchestrator/auto";
const TIERS = {
  mechanical: [`${HAIKU}:low`],
  standard: [`${HAIKU}:medium`],
  elevated: [`${HAIKU}:high`],
  critical: [`${HAIKU}:xhigh`],
};

function agentFile(name: string, tools: string, body: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name}, used by the auto model's live test`,
    `model: ${AUTO_MODEL}`,
    "thinking: off",
    `tools: ${tools}`,
    "defaultContext: fresh",
    "---",
    "",
    body,
    "",
  ].join("\n");
}

interface ProbeRequest {
  readonly sessionId: string;
  readonly rung: string;
  readonly pin: "new" | "reused";
}

function probeRequests(stderr: string): ProbeRequest[] {
  const pattern = new RegExp(`^${ROUTER_PREFIX} request (\\S+) rung (\\S+), pin (new|reused), `);
  return stderr.split("\n").flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [{ sessionId: match[1]!, rung: match[2]!, pin: match[3] as "new" | "reused" }] : [];
  });
}

function classifierRungs(stderr: string): string[] {
  const pattern = new RegExp(`^${ROUTER_PREFIX} classifier (\\S+) `);
  return stderr.split("\n").flatMap((line) => {
    const match = pattern.exec(line);
    return match ? [match[1]!] : [];
  });
}

interface SessionEntry {
  readonly type: string;
  readonly id: string;
  /** On a `compaction` entry. */
  readonly tokensBefore?: number;
  readonly message?: {
    readonly role?: string;
    readonly provider?: string;
    readonly model?: string;
    readonly stopReason?: string;
    readonly content?: unknown;
    readonly usage?: { readonly totalTokens?: number; readonly output?: number };
  };
}

function sessionEntries(file: string): SessionEntry[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as SessionEntry);
}

/** The worker's pi session id: the id in its session file's header, the
 *  `sessionId` pi passes with each of its model requests. */
function workerSessionId(file: string): string {
  const header = sessionEntries(file)[0];
  assert.equal(header?.type, "session", `no session header in ${file}`);
  return header.id;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part as { type?: string; text?: string }).type === "text" ? (part as { text?: string }).text ?? "" : "").join("");
}

function decisionRecords(stateDir: string): DecisionRecord[] {
  return readRoutingRecords(join(stateDir, "routing")).filter((record): record is DecisionRecord => record.recordType === "decision");
}

interface ParentRun {
  readonly events: PiEvent[];
  readonly stderr: string;
  readonly stateDir: string;
  /** Every rung of the session's tier map, all Haiku. */
  readonly rungs: readonly string[];
}

interface SessionSetup {
  readonly agents: Readonly<Record<string, string>>;
  readonly repoFiles?: Readonly<Record<string, string>>;
  readonly settings?: Record<string, unknown>;
  readonly models?: Record<string, unknown>;
  /** The tier map; `TIERS` when left out. */
  readonly tiers?: Readonly<Record<string, readonly string[]>>;
  readonly prompt: string;
}

/** One `pi -p` parent session on Haiku in a throwaway agent dir. `inspect`
 *  runs before the throwaway dir is removed. `undefined` when skipped. */
async function withParentSession<T>(t: TestContext, setup: SessionSetup, inspect: (run: ParentRun) => T): Promise<T | undefined> {
  const liveModel = selectedLivePiModel();
  if (liveModel !== HAIKU) { t.skip(`the auto model's live test is approved on ${HAIKU} only; PI_ORCHESTRATOR_LIVE_MODEL selected ${liveModel}`); return undefined; }
  const authPackage = liveAuthExtensionPath();
  const subagentsPackage = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents");
  if (!credentialsAvailable() || !authPackage) { t.skip("live credentials/auth package unavailable"); return undefined; }
  if (!existsSync(join(subagentsPackage, "package.json"))) { t.skip(`pi-subagents is not installed at ${subagentsPackage}`); return undefined; }
  const tiers = setup.tiers ?? TIERS;
  const rungs = Object.values(tiers).flat();
  assert.ok(rungs.every((rung) => rung.startsWith(`${HAIKU}`)), `only Haiku rungs: ${JSON.stringify(rungs)}`);
  const orchestratorPackage = resolve(import.meta.dirname, "..", "..");
  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  const repo = createTempRepo();
  const launchLog = installPiLaunchLog(agent.home);
  try {
    const available = livePiModelAvailability(HAIKU, () => spawnSync("pi", ["--list-models"], { encoding: "utf8", env: agent.env(launchLog.env), timeout: PI_LIST_MODELS_TIMEOUT_MS }));
    if (available.status !== "available") { t.skip(`live route ${HAIKU} unavailable`); return undefined; }

    mkdirSync(join(agent.dir, "agents"));
    for (const [name, content] of Object.entries(setup.agents)) writeFileSync(join(agent.dir, "agents", `${name}.md`), content);
    for (const [name, content] of Object.entries(setup.repoFiles ?? {})) writeFileSync(join(repo.dir, name), content);
    writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      quietStartup: true,
      enableInstallTelemetry: false,
      packages: [authPackage, subagentsPackage, orchestratorPackage],
      subagents: { defaultModel: AUTO_MODEL },
      orchestrator: { routing: { enabled: true, mode: "live", classifier: { model: `${HAIKU}:off`, timeoutMs: 90_000 }, tiers } },
      ...setup.settings,
    }, null, 2));
    if (setup.models) writeFileSync(join(agent.dir, "models.json"), JSON.stringify(setup.models, null, 2));
    const stateDir = join(agent.home, "state");
    const approval = grantOwnerApproval({ approvedBy: "auto model live test", scope: "data-recipient", acknowledgement: "send the test tasks to anthropic" });
    saveAuthorization(join(stateDir, "authorized-recipients.json"), authorizeRecipient(emptyAuthorization(), "anthropic", approval));
    // pi-subagents keeps its background run folders under TMPDIR, so they are
    // removed with the throwaway home.
    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);

    const run = spawnSync(
      "pi",
      ["-p", setup.prompt, "--mode", "json", "-t", "subagent", "--model", HAIKU],
      { cwd: repo.dir, env: agent.env({ ...launchLog.env, TMPDIR: tmp, PI_ORCHESTRATOR_STATE_DIR: stateDir, PI_ORCHESTRATOR_ROUTER_PROBE: "1" }), encoding: "utf8", timeout: 600_000 },
    );
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const output = `${stdout}${stderr}`;
    if (PROVIDER_REFUSAL.test(output)) { t.skip(`live provider refused: ${output.slice(-300)}`); return undefined; }
    assert.equal(run.status, 0, output.slice(-2000));
    assert.doesNotMatch(stderr, /pi-orchestrator router disabled/, stderr.slice(-2000));
    assert.doesNotMatch(output, /model_verification_failed/, "pi-subagents accepted every reply labelled orchestrator/auto");
    const events = piEvents(stdout);
    const parentModels = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant")
      .map((event) => { const message = event.message as { provider?: string; model?: string }; return `${message.provider}/${message.model}`; });
    assert.ok(parentModels.length > 0, output.slice(-2000));
    assert.ok(parentModels.every((model) => model === HAIKU), `the parent ran on ${HAIKU} only: ${JSON.stringify(parentModels)}`);
    assert.deepEqual(launchLog.read().map((launch) => launch.kind), ["list-models", "parent"], "no classifier child: each classifier ran in its worker's process");
    for (const rung of classifierRungs(stderr)) assert.equal(rung, `${HAIKU}:off`);
    for (const probe of probeRequests(stderr)) assert.ok(rungs.includes(probe.rung), `only Haiku rungs ran: ${probe.rung}`);
    return inspect({ events, stderr, stateDir, rungs });
  } finally {
    launchLog.stopRunning();
    repo.cleanup();
    agent.cleanup();
  }
}

function subagentResults(events: readonly PiEvent[]): PiEvent[] {
  return events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
}

/** The worker's one decision record: keyed by its session id, chosen in live
 *  mode, with `ranOn` equal to the chosen rung, a Haiku tier-map rung. */
function assertRoutedRecord(records: readonly DecisionRecord[], sessionId: string, rungs: readonly string[]): string {
  const own = records.filter((record) => record.delegationId === sessionId);
  assert.equal(own.length, 1, `one decision record for worker ${sessionId}: ${JSON.stringify(records.map((record) => record.delegationId))}`);
  const [record] = own;
  assert.equal(record!.mode, "live");
  assert.equal(record!.route.outcome, "chosen", JSON.stringify(record!.route));
  if (record!.route.outcome !== "chosen") throw new Error("unreachable");
  const chosen = record!.route.rung.rung;
  assert.ok(rungs.includes(chosen), `the chosen rung is a Haiku tier-map rung: ${chosen}`);
  assert.equal(record!.ranOn, chosen, "the worker ran on the chosen rung");
  // The classifier ran in the worker's process on Haiku :off. Its answer is
  // not asserted: Haiku now and then answers off-schema, and the keyword hop
  // then decides, which still routes the worker.
  assert.equal(record!.classification.hops[0]?.hop, `${HAIKU}:off`, `the in-process classifier ran first: ${JSON.stringify(record!.classification.hops)}`);
  return chosen;
}

/** Every request of the worker went to `rung`: the first one new, the rest
 *  on the pin. Returns the number of requests. */
function assertPinnedRequests(probes: readonly ProbeRequest[], sessionId: string, rung: string): number {
  const own = probes.filter((probe) => probe.sessionId === sessionId);
  assert.ok(own.length > 0, `no probe line for worker ${sessionId}: ${JSON.stringify(probes)}`);
  assert.deepEqual(own.map((probe) => probe.rung), own.map(() => rung), `every request of worker ${sessionId} went to ${rung}`);
  assert.deepEqual(own.map((probe) => probe.pin), own.map((_, index) => index === 0 ? "new" : "reused"));
  return own.length;
}

test(`live ${HAIKU} session: a foreground and a background worker on ${AUTO_MODEL} answer on their routed rungs`, async (t) => {
  const foregroundCall = { agent: "auto-foreground", task: "Reply with the single word PING.", context: "fresh", async: false };
  const backgroundCall = { agent: "auto-background", task: "Reply with the single word PONG.", context: "fresh", async: true };
  const reply = "Reply with exactly the single word the task asks for. Do not call any tool.";
  await withParentSession(t, {
    agents: {
      "auto-foreground": agentFile("auto-foreground", "read", reply),
      "auto-background": agentFile("auto-background", "read", reply),
    },
    prompt:
      "Call the subagent tool exactly twice, one call at a time, with exactly these arguments and no others, and do nothing else yourself.\n" +
      `First call: ${JSON.stringify(foregroundCall)}\n` +
      `When the first call returns, second call: ${JSON.stringify(backgroundCall)}\n` +
      "When the second call returns, reply with the single word DONE.",
  }, ({ events, stderr, stateDir, rungs }) => {
    const calls = subagentResults(events);
    assert.equal(calls.length, 2, `two subagent calls: ${JSON.stringify(calls).slice(0, 2000)}`);
    const [foreground, background] = calls;
    for (const call of calls) assert.equal(call.isError, false, JSON.stringify(call.result?.content).slice(0, 2000));
    const records = decisionRecords(stateDir);

    // Foreground: in the parent's process, its result in the tool result.
    const foregroundResult = foreground!.result?.details?.results?.[0] as { agent?: string; exitCode?: number; model?: string; finalOutput?: string; sessionFile?: string } | undefined;
    assert.equal(foregroundResult?.agent, "auto-foreground", JSON.stringify(foregroundResult).slice(0, 2000));
    assert.equal(foregroundResult?.exitCode, 0);
    assert.equal(foregroundResult?.model, `${AUTO_MODEL}:off`, "pi-subagents launched the worker on the auto model");
    assert.match(foregroundResult?.finalOutput ?? "", /\bPING\b/);
    const foregroundSession = workerSessionId(foregroundResult!.sessionFile!);
    const foregroundRung = assertRoutedRecord(records, foregroundSession, rungs);
    assertPinnedRequests(probeRequests(stderr), foregroundSession, foregroundRung);

    // Background: in pi-subagents' runner process, which loaded the installed
    // packages; the parent drained it before exiting.
    const details = background!.result?.details as { asyncId?: string; asyncDir?: string } | undefined;
    assert.ok(details?.asyncDir, `no background run folder: ${JSON.stringify(details).slice(0, 2000)}`);
    const status = JSON.parse(readFileSync(join(details.asyncDir, "status.json"), "utf8")) as { state?: string; steps?: { agent?: string; status?: string; exitCode?: number; model?: string; sessionFile?: string; recentOutput?: string[]; error?: string }[] };
    const step = status.steps?.[0];
    assert.equal(status.state, "complete", JSON.stringify(status).slice(0, 2000));
    assert.equal(step?.agent, "auto-background");
    assert.equal(step?.status, "complete", JSON.stringify(step).slice(0, 2000));
    assert.equal(step?.exitCode, 0);
    assert.equal(step?.model, `${AUTO_MODEL}:off`, "pi-subagents launched the worker on the auto model");
    assert.match((step?.recentOutput ?? []).join("\n"), /\bPONG\b/);
    const runnerStderr = readFileSync(join(details.asyncDir, "runner.stderr.log"), "utf8");
    assert.doesNotMatch(`${JSON.stringify(status)}${runnerStderr}`, /model_verification_failed/);
    assert.doesNotMatch(runnerStderr, /pi-orchestrator router disabled/, runnerStderr.slice(-2000));
    for (const rung of classifierRungs(runnerStderr)) assert.equal(rung, `${HAIKU}:off`);
    const backgroundSession = workerSessionId(step!.sessionFile!);
    assert.notEqual(backgroundSession, foregroundSession);
    const backgroundRung = assertRoutedRecord(records, backgroundSession, rungs);
    assert.deepEqual(probeRequests(stderr).filter((probe) => probe.sessionId === backgroundSession), [], "the background worker's requests were served in its own process");
    assertPinnedRequests(probeRequests(runnerStderr), backgroundSession, backgroundRung);

    // One record per worker, both in the one state folder.
    assert.deepEqual(records.map((record) => record.delegationId).sort(), [foregroundSession, backgroundSession].sort());
    t.diagnostic(`foreground ${foregroundSession} on ${foregroundRung}; background ${backgroundSession} on ${backgroundRung}`);
  });
});

// Forced compact-and-retry, cheaply. pi retries a reply after compaction
// only when it stopped with an overflow error or with a recoverable length
// stop: `stopReason` "length" below the auto model's declared output limit
// (agent-session.js `_checkCompaction`, pi-ai `isRecoverableLength`). A
// threshold compaction, or a completed reply over the window, compacts
// without a retry. pi-ai clamps each request's output limit to the rung's
// context window minus the estimated context minus 4096
// (`clampMaxTokensToContext`), so a rung with a small declared window stops a
// reply at "length" once the context has grown.
//
// The worker runs on the dated Haiku id, whose context window the models.json
// override shrinks to 13k; the parent and the classifier stay on the undated
// id with its real window. The worker reads a.txt (about 6k estimated
// tokens), whose last line names b.txt, a one-line file, so the two reads
// come one after the other. The request that reads b.txt still has about 1k
// of output room (13k minus about 8k of context minus 4096); the next one has
// about the same, which cannot hold the integers 1 to 800 (about 2k tokens),
// so that reply stops at "length". pi omits that attempt and compacts once.
// pi cannot summarize the last tool result, but the 1000-token keep-recent
// budget keeps only the b.txt read and summarizes a.txt (the summary request
// carries it truncated to 2000 characters, so it fits the small window too).
// The retry then sees about 3k of context and has about 6k of room. A
// 2000-token reserve keeps pi's threshold compaction (above 11k) out of the
// way. Both compaction settings apply to `orchestrator/auto` only. Measured:
// a.txt came to 5.8k real tokens, the prompt to 1.9k, and the reply that
// stopped at "length" had about 1050 tokens of room.
const RETRY_RUNG = `${HAIKU}-20251001:off`;
const RETRY_RUNG_WINDOW = 13_000;
const RETRY_RESERVE_TOKENS = 2_000;
const RETRY_KEEP_RECENT_TOKENS = 1_000;
const FILLER_LINES = 250;
const END_WORD = "FINISHED";

function fillerFile(name: string, lines: number, lastLine: string): string {
  const body = Array.from({ length: lines }, (_, index) =>
    `${name} line ${index + 1}: the quiet harbour town repaints its old lighthouse white every spring morning.`);
  return `${[...body, lastLine].join("\n")}\n`;
}

test(`live ${HAIKU} session: a worker on ${AUTO_MODEL} that stops at length is compacted once and retried on the same rung`, async (t) => {
  const call = {
    agent: "auto-writer",
    task: "Use the read tool to read a.txt. Its last line names a second file: read that file with the read tool too. " +
      `Then write the integers from 1 to 800 in order, separated by single spaces, followed by the word ${END_WORD}, and nothing else.`,
    context: "fresh",
    async: false,
  };
  await withParentSession(t, {
    agents: { "auto-writer": agentFile("auto-writer", "read", "Do exactly what the task says, one tool call at a time, and nothing more.") },
    repoFiles: { "a.txt": fillerFile("a.txt", FILLER_LINES, "Second file: b.txt"), "b.txt": "b.txt is the second file.\n" },
    tiers: { mechanical: [RETRY_RUNG], standard: [RETRY_RUNG], elevated: [RETRY_RUNG], critical: [RETRY_RUNG] },
    models: { providers: { anthropic: { modelOverrides: { [`${HAIKU_ID}-20251001`]: { contextWindow: RETRY_RUNG_WINDOW } } } } },
    settings: {
      compaction: { modelOverrides: { [AUTO_MODEL]: { reserveTokens: RETRY_RESERVE_TOKENS, keepRecentTokens: RETRY_KEEP_RECENT_TOKENS } } },
    },
    prompt:
      "Call the subagent tool exactly once, with exactly these arguments and no others, and do nothing else yourself:\n" +
      `${JSON.stringify(call)}\n` +
      "When the tool returns, reply with the single word DONE.",
  }, ({ events, stderr, stateDir, rungs }) => {
    const calls = subagentResults(events);
    assert.equal(calls.length, 1, `one subagent call: ${JSON.stringify(calls).slice(0, 2000)}`);
    assert.equal(calls[0]!.isError, false, JSON.stringify(calls[0]!.result?.content).slice(0, 2000));
    const result = calls[0]!.result?.details?.results?.[0] as { exitCode?: number; model?: string; finalOutput?: string; sessionFile?: string } | undefined;
    assert.equal(result?.exitCode, 0, JSON.stringify(result).slice(0, 2000));
    assert.equal(result?.model, `${AUTO_MODEL}:off`);
    assert.match(result?.finalOutput ?? "", new RegExp(`\\b${END_WORD}\\b`));

    const entries = sessionEntries(result!.sessionFile!);
    // Context and stop reason per reply, to re-tune the window above.
    t.diagnostic(`worker session: ${entries.flatMap((entry) => entry.type === "compaction" ? [`compaction(before ${entry.tokensBefore})`]
      : entry.type === "message" && entry.message?.role === "assistant" ? [`reply(${entry.message.stopReason}, ${entry.message.usage?.totalTokens} tokens, ${entry.message.usage?.output} out)`]
      : entry.type === "message" ? [entry.message?.role ?? "message"] : [entry.type]).join(" ")}`);
    const compactions = entries.flatMap((entry, index) => entry.type === "compaction" ? [index] : []);
    assert.equal(compactions.length, 1, `exactly one compaction: ${JSON.stringify(entries.map((entry) => entry.type))}`);
    const compaction = compactions[0]!;
    const replies = entries.flatMap((entry, index) => entry.type === "message" && entry.message?.role === "assistant" ? [{ index, message: entry.message }] : []);
    for (const { message } of replies) assert.equal(`${message.provider}/${message.model}`, AUTO_MODEL, "every reply is labelled orchestrator/auto");
    const before = replies.filter((reply) => reply.index < compaction);
    const after = replies.filter((reply) => reply.index > compaction);
    assert.equal(before.at(-1)?.message.stopReason, "length", "the reply before the compaction stopped at length");
    assert.equal(after.length, 1, "one retried reply after the compaction");
    const retry = after[0]!;
    assert.equal(retry.message.stopReason, "stop");
    assert.match(textOf(retry.message.content), new RegExp(`\\b${END_WORD}\\b`));
    const userAfter = entries.slice(compaction + 1).filter((entry) => entry.type === "message" && entry.message?.role === "user");
    assert.deepEqual(userAfter, [], "the reply after the compaction is pi's retry, not a new user turn");

    const sessionId = workerSessionId(result!.sessionFile!);
    const rung = assertRoutedRecord(decisionRecords(stateDir), sessionId, rungs);
    assert.equal(rung, RETRY_RUNG);
    const requests = assertPinnedRequests(probeRequests(stderr), sessionId, rung);
    assert.equal(requests, replies.length, "one routed request per reply, the retry included, all on the pin");
    t.diagnostic(`worker ${sessionId} on ${rung}: ${requests} requests, compaction at entry ${compaction}`);
  });
});
