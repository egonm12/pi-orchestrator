import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, type DecisionRecord, type EffortLadderRecord, type RoutingRecord } from "../routing/decision-record.ts";
import { buildRoutingReport } from "../routing/routing-report.ts";
import { autoStream } from "../router/auto-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import { orchestratorRouter } from "../router/orchestrator-router.ts";
import { createSubagentsExtension, type SubagentResult, type SubagentsDetails } from "./extension.ts";
import { orchestratorProtocol } from "./orchestrator-protocol.ts";
import { readWorkerOutcome } from "./resume.ts";
import { markWorkerSession } from "./worker-sessions.ts";
import { workerBoard } from "./worker-board.ts";

// Retries on the effort ladder (ADR 0010), as the orchestrator sees them:
// subagents_verdict's request_changes reply, and the subagents tool with a
// retry item. As in review.test.ts, each worker is a real in-process pi
// session; the model provider, the classifier call, the evidence, the clock,
// settings files and the environment are fakes. The orchestrator's session
// loads the router extension too, as pi loads it, so a retry climbs through
// that session's tier map. Assertions read the tool results, the requests the
// provider got and the records in the state folder.

const originalEnv = {
  HOME: process.env.HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_ORCHESTRATOR_STATE_DIR: process.env.PI_ORCHESTRATOR_STATE_DIR,
  PI_ORCHESTRATOR_ROUTER_PROBE: process.env.PI_ORCHESTRATOR_ROUTER_PROBE,
  PI_ORCHESTRATOR_SESSION_MODEL: process.env.PI_ORCHESTRATOR_SESSION_MODEL,
  PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD,
};
delete process.env.PI_ORCHESTRATOR_ROUTER_PROBE;
delete process.env.PI_SUBAGENT_CHILD;
after(() => {
  for (const [name, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  resetBanLists();
});

const HAIKU = "anthropic/claude-haiku-4-5";
const SONNET = "anthropic/claude-sonnet-5";
const NOW = new Date("2026-09-28T12:00:00.000Z");
/** A standard worker runs on haiku:medium; the ladder climbs haiku's efforts first. Critical has one rung, whose next effort, max, is not listed. */
const TIERS = { mechanical: [`${HAIKU}:low`], standard: [`${HAIKU}:medium`, `${SONNET}:medium`], elevated: [`${SONNET}:high`], critical: [`${SONNET}:xhigh`] };
const ROUTING = { enabled: true, mode: "live", classifier: { model: `${HAIKU}:low`, timeoutMs: 1_000 }, tiers: TIERS };
/** The orchestrator's session model, which workers fall back to. */
const SESSION_MODEL = `${SONNET}:low`;

interface Harness {
  readonly agentDir: string;
  readonly projectDir: string;
  readonly stateDir: string;
  records(): RoutingRecord[];
  cleanup(): void;
}

function harness(routing: Record<string, unknown> = ROUTING): Harness {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-retry-"));
  const agentDir = join(home, "agent"), projectDir = join(home, "project"), stateDir = join(home, "state");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  mkdirSync(stateDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing } }));
  saveAuthorization(join(stateDir, "authorized-recipients.json"), approvedAnthropic());
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
  return { agentDir, projectDir, stateDir, records: () => readRoutingRecords(join(stateDir, "routing")),
    cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function approvedAnthropic() {
  const approval = grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: "send delegation data to anthropic" });
  return authorizeRecipient(emptyAuthorization(), "anthropic", approval);
}

/** The router extension's dependencies. Its classifier answers the tier a
 *  task names in brackets, such as `[standard]`, and mechanical otherwise. */
function routerDependencies(approved = true) {
  const answer = (tier: string) => JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `fake classifier says ${tier}` });
  return {
    classifierCall: () => async (prompt: string) => answer(/\[(standard|elevated|critical)\]/.exec(prompt)?.[1] ?? "mechanical"),
    evidence: () => () => ({ catalog: buildCatalog({ modelIds: [HAIKU, SONNET], now: NOW }), refreshState: emptyRefreshState(),
      authorization: approved ? approvedAnthropic() : emptyAuthorization() }),
    now: () => NOW,
  };
}

type ProviderConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;

interface Request {
  readonly sessionId: string | undefined;
  /** `provider/model:effort`. */
  readonly rung: string;
  readonly task: string;
  readonly systemPrompt: string;
}

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");

/** A fake `anthropic` provider serving claude-haiku-4-5 and claude-sonnet-5.
 *  A worker makes one tool call for each line of its task that starts with
 *  "Run:" (`{ "name": ..., "arguments": ... }` as JSON after it), in order,
 *  then says "ran"; a reviewer answers accept; any other worker says "done". */
function anthropic() {
  const requests: Request[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: ["claude-haiku-4-5", "claude-sonnet-5"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 })),
    streamSimple(model, context, options) {
      const task = context.messages.flatMap((message) => message.role === "user" ? [textOf(message.content)] : []).at(-1) ?? "";
      const reviewer = context.messages.some((message) => message.role === "system" &&
        Object.values(message.sections ?? {}).some((section) => typeof section === "string" && section.includes("# Review rules")));
      const systemPrompt = context.messages.filter((message) => message.role === "system")
        .flatMap((message) => Object.values(message.sections ?? {})).filter((section): section is string => typeof section === "string").join("\n\n");
      requests.push({ sessionId: options?.sessionId, rung: `${model.provider}/${model.id}:${options?.reasoning ?? "off"}`, task, systemPrompt });
      const runs = task.split("\n").filter((line) => line.startsWith("Run:")).map((line) => JSON.parse(line.slice("Run:".length)) as { name: string; arguments: Record<string, unknown> });
      const done = context.messages.filter((message) => message.role === "toolResult").length;
      const call = runs[done];
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: call === undefined ? [{ type: "text", text: runs.length > 0 ? "ran" : reviewer ? "## Confirmed\nAnswer: accept" : "done" }]
          : [{ type: "toolCall", id: `call-${requests.length}`, name: call.name, arguments: call.arguments }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: call === undefined ? "stop" : "toolUse", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      push({ type: "done", reason: message.stopReason, message } as never);
      end({ api: model.api, provider: model.provider, model: model.id });
      return stream;
    },
  };
  return { extension: { name: "fake-anthropic", factory: (pi) => pi.registerProvider("anthropic", config) } as InlineExtension, requests };
}

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];
type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

interface Orchestrator {
  readonly ctx: ExtensionContext;
  tool(name: string): Tool;
  /** Ends the session as pi does, which unpublishes its router. */
  shutdown(): Promise<void>;
}

/** The orchestrator's session: a saved pi session, with the router and
 *  subagents extensions loaded as pi loads them and its session started. */
async function orchestrator(h: Harness, approved = true): Promise<Orchestrator> {
  const provider = anthropic();
  const tools: Tool[] = [];
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerTool(tool: Tool) { tools.push(tool); }, registerProvider() {}, registerCommand() {}, registerShortcut() {}, sendMessage() {},
    on(event: string, handler: Handler) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    getActiveTools: () => ["read", "bash", "edit", "write", "subagents", "subagents_status", "subagents_message"],
  } as unknown as ExtensionAPI;
  createRouterExtension(routerDependencies(approved))(pi);
  createSubagentsExtension({ workerExtensions: [{ name: "router", factory: createRouterExtension(routerDependencies(approved)) }, provider.extension] })(pi);
  const sessionManager = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
  sessionManager.appendMessage({ role: "user", content: "Write the notes", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagents", arguments: {} }],
    stopReason: "toolUse", timestamp: Date.now() } as never);
  const ctx = { cwd: h.projectDir, hasUI: false, sessionManager, model: { provider: "anthropic", id: "claude-sonnet-5" }, thinkingLevel: "low",
    modelRegistry: { getAvailable: () => [...INSTALLED_MODEL_INFO] } } as unknown as ExtensionContext;
  const emit = async (type: string) => { for (const handler of handlers.get(type) ?? []) await handler({ type, reason: "startup" }, ctx); };
  await emit("session_start");
  // The router's session_start keeps the session model for workers; this test names it outright.
  process.env.PI_ORCHESTRATOR_SESSION_MODEL = SESSION_MODEL;
  return {
    ctx,
    tool(name) {
      const found = tools.filter((tool) => tool.name === name).at(-1);
      assert.ok(found, `tool ${name} is registered`);
      return found;
    },
    shutdown: () => emit("session_shutdown"),
    ...{ requests: provider.requests },
  } as Orchestrator & { requests: Request[] };
}

const toolText = (result: { content: readonly { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

async function call(o: Orchestrator, items: readonly Record<string, unknown>[]): Promise<{ results: readonly SubagentResult[]; text: string }> {
  const result = await o.tool("subagents").execute("call", { items } as never, undefined, undefined, o.ctx);
  return { results: (result.details as SubagentsDetails).results, text: toolText(result) };
}

async function one(o: Orchestrator, item: Record<string, unknown>): Promise<SubagentResult & { text: string }> {
  const { results: [result], text } = await call(o, [item]);
  assert.ok(result);
  return { ...result, text };
}

async function verdict(o: Orchestrator, params: Record<string, unknown>): Promise<string> {
  try { return toolText(await o.tool("subagents_verdict").execute("verdict", params as never, undefined, undefined, o.ctx)); } catch (error) { return (error as Error).message; }
}

const requestsOf = (o: Orchestrator, id: string | undefined) => (o as Orchestrator & { requests: Request[] }).requests.filter((request) => request.sessionId === id);
const runTask = (name: string, args: Record<string, unknown>) => `Run:${JSON.stringify({ name, arguments: args })}`;
const WRITE_NOTES = runTask("write", { path: "notes.md", content: "notes\n" });
const ADD_HEADING = runTask("write", { path: "notes.md", content: "# Notes\nnotes\n" });

function ladderOf(h: Harness, id: string): EffortLadderRecord {
  const record = h.records().find((entry): entry is EffortLadderRecord => entry.recordType === "effort-ladder" && entry.delegationId === id);
  assert.ok(record, `an effort-ladder record for ${id}`);
  return record;
}

function decisionOf(h: Harness, id: string): DecisionRecord {
  const record = h.records().find((entry): entry is DecisionRecord => entry.recordType === "decision" && entry.delegationId === id);
  assert.ok(record, `a decision record for ${id}`);
  return record;
}

const requestChanges = (delegationId: string) => ({ delegationId, verdict: "request_changes", reason: "notes.md has no heading" });

test("request_changes names the next rung; a retry runs there as a new delegation linked to the failed attempt; the third climb is refused", async () => {
  const h = harness();
  const o = await orchestrator(h);
  try {
    const first = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    assert.equal(first.status, "completed", JSON.stringify(first));
    const id = first.sessionId!;
    assert.deepEqual(requestsOf(o, id).map((request) => request.rung).at(0), `${HAIKU}:medium`);
    assert.equal(await verdict(o, requestChanges(id)), `Recorded request_changes on delegation ${id}. ` +
      `The next effort-ladder rung is ${HAIKU}:high at the standard tier (step effort), climb 1 of 2. ` +
      `To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`);

    const retry = await one(o, { retry: id, task: ADD_HEADING });
    assert.equal(retry.status, "completed", JSON.stringify(retry));
    const retryId = retry.sessionId!;
    assert.notEqual(retryId, id, "a new delegation");
    assert.equal(retry.retry, id);
    assert.ok(retry.text.includes(`Retry of delegation ${id}, climb 1 of 2: it runs on ${HAIKU}:high at the standard tier (step effort).`), retry.text);
    assert.equal(retry.edited, true);
    const requests = requestsOf(o, retryId);
    assert.deepEqual(requests.map((request) => request.rung), [`${HAIKU}:high`, `${HAIKU}:high`, `${HAIKU}:high`]);
    // The original task, from the failed attempt's saved session, with the feedback.
    const task = requests[0]!.task;
    for (const part of [`Retry of delegation ${id}, whose changes were requested.`, `<feedback>\n${ADD_HEADING}\n</feedback>`,
      `<task>\n[standard]\n${WRITE_NOTES}\n</task>`, `Its saved session, with the whole transcript: ${first.sessionFile}`]) {
      assert.ok(task.includes(part), `${part}\n---\n${task}`);
    }
    // The link: an effort-ladder record; what ran: the router's decision record under the forced rung.
    const ladder = ladderOf(h, retryId);
    assert.ok(ladder.step !== "unplaced");
    assert.deepEqual([ladder.previousDecisionId, ladder.step, ladder.mode, ladder.route.tier, ladder.route.rung.rung], [id, "effort", "live", "standard", `${HAIKU}:high`]);
    const decision = decisionOf(h, retryId);
    assert.deepEqual(decision.constraints, { forcedRung: { tier: "standard", rung: `${HAIKU}:high` } });
    assert.equal(decision.ranOn, `${HAIKU}:high`);

    // A retry of a retry climbs on from the retry's rung, and is the task's second climb.
    assert.ok((await verdict(o, requestChanges(retryId))).endsWith(
      `The next effort-ladder rung is ${HAIKU}:xhigh at the standard tier (step effort), climb 2 of 2. ` +
      `To retry, start a subagents item whose retry is ${retryId} and whose task is your feedback.`));
    const second = await one(o, { retry: retryId, task: ADD_HEADING });
    assert.equal(second.status, "completed", JSON.stringify(second));
    // The fake provider's haiku has no xhigh, so pi clamps the request's effort; the pin is xhigh.
    assert.equal(decisionOf(h, second.sessionId!).ranOn, `${HAIKU}:xhigh`);
    assert.equal(ladderOf(h, second.sessionId!).previousDecisionId, retryId);

    // The third climb is refused, from the latest attempt or from the first alike.
    const limit = `its task has climbed the effort ladder twice already (delegations ${id}, ${retryId}, ${second.sessionId}). Take the task back to the user`;
    assert.ok((await verdict(o, requestChanges(second.sessionId!))).endsWith(`A retry is refused: ${limit}.`));
    const refused = await call(o, [{ retry: second.sessionId, task: ADD_HEADING }, { retry: id, task: ADD_HEADING }]);
    assert.deepEqual(refused.results.map((result) => [result.status, result.sessionId, result.error]), [
      ["failed", undefined, `cannot retry delegation ${second.sessionId}: ${limit}.`],
      ["failed", undefined, `cannot retry delegation ${id}: its task has climbed the effort ladder twice already (delegations ${id}). Take the task back to the user.`],
    ]);
    assert.equal(h.records().filter((record) => record.recordType === "effort-ladder").length, 2, "a refused retry is no climb");
    // The report lists each climb; a retry's row is its decision record's.
    const report = buildRoutingReport(join(h.stateDir, "routing"));
    assert.deepEqual(report.ladders.map((record) => [record.previousDecisionId, record.delegationId]), [[id, retryId], [retryId, second.sessionId]]);
    assert.equal(report.totals.decisions, 3);
  } finally { await o.shutdown(); h.cleanup(); }
});

test("a retry keeps the failed attempt's label, on the board and in its saved outcome, so a retry of a retry keeps it too", async () => {
  const h = harness();
  const o = await orchestrator(h);
  try {
    const first = await one(o, { task: `[standard]\n${WRITE_NOTES}`, label: "notes file" });
    await verdict(o, requestChanges(first.sessionId!));
    const retry = await one(o, { retry: first.sessionId, task: ADD_HEADING });
    assert.equal(retry.status, "completed", JSON.stringify(retry));
    assert.equal(workerBoard().byDelegation(retry.sessionId!)?.label, "notes file");
    assert.equal(readWorkerOutcome(retry.sessionFile!)?.label, "notes file");
    await verdict(o, requestChanges(retry.sessionId!));
    const second = await one(o, { retry: retry.sessionId, task: ADD_HEADING });
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.equal(workerBoard().byDelegation(second.sessionId!)?.label, "notes file");
  } finally { await o.shutdown(); h.cleanup(); }
});

test("an exhausted effort ladder is named in the reply, and its retry is refused with the take-it-to-the-user message", async () => {
  const h = harness();
  const o = await orchestrator(h);
  try {
    const first = await one(o, { task: `[critical]\n${WRITE_NOTES}` });
    const id = first.sessionId!;
    assert.equal(decisionOf(h, id).ranOn, `${SONNET}:xhigh`);
    // A critical delegation needs a reviewer; only the session model is left for it.
    const reviewer = await one(o, { review: id, task: "Check the heading" });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const exhausted = `the effort ladder is exhausted after ${SONNET}:xhigh: no rung is left in tiers critical. Take the task back to the user`;
    assert.equal(await verdict(o, { ...requestChanges(id), reviewer: reviewer.sessionId }),
      `Recorded request_changes on delegation ${id}, reviewed by delegation ${reviewer.sessionId}. A retry is refused: ${exhausted}.`);
    const retry = await one(o, { retry: id, task: ADD_HEADING });
    assert.deepEqual([retry.status, retry.sessionId, retry.error], ["failed", undefined, `cannot retry delegation ${id}: ${exhausted}.`]);
    assert.equal(h.records().some((record) => record.recordType === "effort-ladder"), false);
  } finally { await o.shutdown(); h.cleanup(); }
});

test("a retry is refused without a climb for a delegation whose latest verdict is not request_changes, and in combination with agent, fork, resume or review, or from a worker", async () => {
  const h = harness();
  const o = await orchestrator(h);
  try {
    const research = await one(o, { task: "Look around" });
    const accepted = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    const unjudged = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    const failed = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    assert.ok((await verdict(o, { delegationId: accepted.sessionId, verdict: "accept", reason: "checked" })).startsWith("Recorded accept"));
    assert.ok((await verdict(o, requestChanges(failed.sessionId!))).startsWith("Recorded request_changes"));
    const unknown = "0b7c7a5e-0000-4000-8000-000000000000";
    const { results } = await call(o, [
      { retry: accepted.sessionId, task: ADD_HEADING },
      { retry: unjudged.sessionId, task: ADD_HEADING },
      { retry: research.sessionId, task: ADD_HEADING },
      { retry: unknown, task: ADD_HEADING },
      { retry: failed.sessionId, task: ADD_HEADING, agent: "scribe" },
      { retry: failed.sessionId, task: ADD_HEADING, fork: true },
      { retry: failed.sessionId, task: ADD_HEADING, resume: failed.sessionId },
      { retry: failed.sessionId, task: ADD_HEADING, review: failed.sessionId },
    ]);
    const excludes = "retry excludes agent, fork, resume and review";
    assert.deepEqual(results.map((result) => [result.status, result.sessionId, result.error]), [
      ["failed", undefined, `cannot retry delegation ${accepted.sessionId}: its latest verdict is accept; only a delegation whose latest verdict is request_changes is retried`],
      ["failed", undefined, `cannot retry delegation ${unjudged.sessionId}: its latest edit has no verdict; record request_changes with subagents_verdict first`],
      ["failed", undefined, `cannot retry delegation ${research.sessionId}: it did not edit; only an editing delegation whose latest verdict is request_changes is retried`],
      ["failed", undefined, `cannot retry delegation ${unknown}: its task is not known, as neither its saved session nor this session's worker board has it`],
      ["failed", undefined, excludes], ["failed", undefined, excludes], ["failed", undefined, excludes], ["failed", undefined, excludes],
    ]);
    // A later accept replaces request_changes, so the retry is refused.
    assert.ok((await verdict(o, { delegationId: failed.sessionId, verdict: "accept", reason: "fine after all" })).startsWith("Recorded accept"));
    assert.match((await one(o, { retry: failed.sessionId, task: ADD_HEADING })).error ?? "", /its latest verdict is accept/);
    assert.ok((await verdict(o, requestChanges(failed.sessionId!))).startsWith("Recorded request_changes"));
    const unmark = markWorkerSession(o.ctx.sessionManager.getSessionId());
    try {
      const nested = await one(o, { retry: failed.sessionId, task: ADD_HEADING });
      assert.deepEqual([nested.status, nested.error], ["failed", "only the orchestrator starts retries"]);
    } finally { unmark(); }
    assert.equal(h.records().some((record) => record.recordType === "effort-ladder"), false, "no refused retry made a climb");
  } finally { await o.shutdown(); h.cleanup(); }
});

test("in shadow mode a retry runs on the session model, its ladder record names the rung it would have used, and the limit holds", async () => {
  const h = harness({ ...ROUTING, mode: "shadow" });
  const o = await orchestrator(h);
  try {
    const first = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    const id = first.sessionId!;
    assert.deepEqual(requestsOf(o, id).map((request) => request.rung).at(0), SESSION_MODEL);
    assert.ok((await verdict(o, requestChanges(id))).endsWith(`The next effort-ladder rung is ${HAIKU}:high at the standard tier (step effort), climb 1 of 2; ` +
      `in shadow mode the retry runs on the session model. To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`));
    let previous = id;
    for (const [climb, rung] of [[1, `${HAIKU}:high`], [2, `${HAIKU}:xhigh`]] as const) {
      const retry = await one(o, { retry: previous, task: ADD_HEADING });
      assert.equal(retry.status, "completed", JSON.stringify(retry));
      assert.ok(retry.text.includes(`Retry of delegation ${previous}, climb ${climb} of 2: in shadow mode it runs on the session model; ` +
        `the effort ladder's rung would be ${rung} at the standard tier (step effort).`), retry.text);
      assert.deepEqual([...new Set(requestsOf(o, retry.sessionId).map((request) => request.rung))], [SESSION_MODEL]);
      const ladder = ladderOf(h, retry.sessionId!);
      assert.ok(ladder.step !== "unplaced");
      assert.deepEqual([ladder.previousDecisionId, ladder.mode, ladder.route.rung.rung], [previous, "shadow", rung]);
      const decision = decisionOf(h, retry.sessionId!);
      assert.deepEqual([decision.mode, decision.ranOn, decision.constraints?.forcedRung?.rung], ["shadow", SESSION_MODEL, rung]);
      assert.ok((await verdict(o, requestChanges(retry.sessionId!))).startsWith("Recorded request_changes"));
      previous = retry.sessionId!;
    }
    assert.match((await one(o, { retry: previous, task: ADD_HEADING })).error ?? "", /climbed the effort ladder twice already .*Take the task back to the user\.$/);
  } finally { await o.shutdown(); h.cleanup(); }
});

test("with routing off a retry is unplaced: it runs on the session model, its ladder record names no rung and says why, and the limit holds", async () => {
  const h = harness({ ...ROUTING, enabled: false });
  const o = await orchestrator(h);
  try {
    assert.equal(orchestratorRouter(o.ctx.sessionManager.getSessionId()), undefined, "routing off publishes no router");
    const first = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    const id = first.sessionId!;
    // Without a tier a delegation is gated as elevated and needs a reviewer; one on another rung than the session model.
    const review = async (reviewed: string) => {
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:high`;
      const reviewer = await one(o, { review: reviewed, task: "Check the heading" });
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = SESSION_MODEL;
      return reviewer.sessionId!;
    };
    const why = "routing is off, so no tier map is loaded to climb";
    assert.ok((await verdict(o, { ...requestChanges(id), reviewer: await review(id) })).endsWith(
      `The effort ladder cannot place it: ${why}. A retry runs on the session model, climb 1 of 2. ` +
      `To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`));
    let previous = id;
    for (const climb of [1, 2]) {
      const retry = await one(o, { retry: previous, task: ADD_HEADING });
      assert.equal(retry.status, "completed", JSON.stringify(retry));
      assert.ok(retry.text.includes(`Retry of delegation ${previous}, climb ${climb} of 2: the effort ladder cannot place it (${why}), so it runs on the session model.`), retry.text);
      assert.deepEqual([...new Set(requestsOf(o, retry.sessionId).map((request) => request.rung))], [SESSION_MODEL]);
      const ladder = ladderOf(h, retry.sessionId!);
      assert.deepEqual([ladder.previousDecisionId, ladder.step, ladder.mode, ladder.step === "unplaced" ? ladder.detail : undefined, "route" in ladder],
        [previous, "unplaced", "off", why, false]);
      assert.ok((await verdict(o, { ...requestChanges(retry.sessionId!), reviewer: await review(retry.sessionId!) })).startsWith("Recorded request_changes"));
      previous = retry.sessionId!;
    }
    assert.match((await one(o, { retry: previous, task: ADD_HEADING })).error ?? "", /climbed the effort ladder twice already .*Take the task back to the user\.$/);
    assert.equal(h.records().some((record) => record.recordType === "decision"), false, "routing off writes no decision record");
    // The retries' verdicts attach to their ladder records, as unrouted delegations the report counts.
    const report = buildRoutingReport(join(h.stateDir, "routing"));
    assert.equal(report.orphanedVerdicts, 0);
    assert.deepEqual(report.unrouted, { verdicts: { accept: 0, request_changes: 3 }, sameRungVerdicts: { accept: 0, request_changes: 0 }, ungated: 0, missing: 0 });
    assert.equal(report.ladders.length, 2);
  } finally { await o.shutdown(); h.cleanup(); }
});

test("forked and named-model attempts retry unplaced without a forced rung, while retaining the named agent's instructions", async () => {
  for (const kind of ["fork", "agent-model"] as const) {
    const h = harness();
    if (kind === "agent-model") {
      mkdirSync(join(h.agentDir, "agents"));
      writeFileSync(join(h.agentDir, "agents", "scribe.md"), `---\nname: scribe\ndescription: Write notes\nmodel: ${HAIKU}\nthinking: high\n---\n\nWrite notes carefully.\n`);
      writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing: ROUTING,
        subagents: { agentDefinitionModel: { use: "preserve" } } } }));
    }
    const o = await orchestrator(h);
    try {
      const first = await one(o, kind === "fork" ? { task: WRITE_NOTES, fork: true } : { task: WRITE_NOTES, agent: "scribe" });
      assert.equal(first.status, "completed", JSON.stringify(first));
      const id = first.sessionId!;
      const reviewer = await one(o, { review: id, task: "Check the notes" });
      assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
      const why = kind === "fork" ? `delegation ${id} is a forked worker, which runs unrouted on the session model`
        : `delegation ${id}'s agent definition names its model, so it was not routed`;
      assert.ok((await verdict(o, { ...requestChanges(id), reviewer: reviewer.sessionId })).includes(
        `The effort ladder cannot place it: ${why}. A retry runs routed as usual, climb 1 of 2.`));
      const retry = await one(o, { retry: id, task: ADD_HEADING });
      assert.equal(retry.status, "completed", JSON.stringify(retry));
      assert.notEqual(retry.sessionId, id);
      const ladder = ladderOf(h, retry.sessionId!);
      assert.deepEqual([ladder.previousDecisionId, ladder.step, ladder.mode, ladder.step === "unplaced" ? ladder.detail : undefined],
        [id, "unplaced", "live", why]);
      const decision = decisionOf(h, retry.sessionId!);
      assert.equal(decision.constraints, undefined, "an unplaced retry routes normally, with no forced rung");
      assert.equal(decision.ranOn, `${HAIKU}:low`);
      if (kind === "agent-model") {
        assert.equal(readWorkerOutcome(retry.sessionFile!)?.agent, "scribe");
        assert.ok(requestsOf(o, retry.sessionId)[0]!.systemPrompt.includes("Write notes carefully."),
          "the retry follows the original agent's instructions");
      }
    } finally { await o.shutdown(); h.cleanup(); }
  }
});

test("a refused first route retries unplaced, with a normal refusal decision on the retry", async () => {
  const h = harness();
  const o = await orchestrator(h, false);
  try {
    const first = await one(o, { task: `[standard]\n${WRITE_NOTES}` });
    assert.equal(first.status, "completed", JSON.stringify(first));
    const id = first.sessionId!;
    assert.equal(decisionOf(h, id).route.outcome, "refused");
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:high`;
    const reviewer = await one(o, { review: id, task: "Check the notes" });
    process.env.PI_ORCHESTRATOR_SESSION_MODEL = SESSION_MODEL;
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const why = `delegation ${id}'s route refused every rung, so it ran on the session model`;
    assert.ok((await verdict(o, { ...requestChanges(id), reviewer: reviewer.sessionId })).includes(
      `The effort ladder cannot place it: ${why}. A retry runs routed as usual, climb 1 of 2.`));
    const retry = await one(o, { retry: id, task: ADD_HEADING });
    assert.equal(retry.status, "completed", JSON.stringify(retry));
    const ladder = ladderOf(h, retry.sessionId!);
    assert.deepEqual([ladder.previousDecisionId, ladder.step, ladder.step === "unplaced" ? ladder.detail : undefined], [id, "unplaced", why]);
    const decision = decisionOf(h, retry.sessionId!);
    assert.equal(decision.route.outcome, "refused");
    assert.equal(decision.constraints, undefined);
    assert.equal(decision.ranOn, SESSION_MODEL);
  } finally { await o.shutdown(); h.cleanup(); }
});

test("the orchestrator's session publishes its router for retries, and its end unpublishes it", async () => {
  const h = harness();
  const o = await orchestrator(h);
  const id = o.ctx.sessionManager.getSessionId();
  try {
    assert.equal(orchestratorRouter(id)?.mode, "live");
  } finally { await o.shutdown(); h.cleanup(); }
  assert.equal(orchestratorRouter(id), undefined);
});

test("the protocol describes retries: how to start one, what it gets, what it excludes and when to take the task back to the user", () => {
  const paragraph = orchestratorProtocol(3, "medium").split("\n\n").find((text) => text.includes("`retry`"));
  assert.ok(paragraph);
  for (const phrase of ["request_changes", "next rung", "`retry`", "feedback", "new delegation", "original task", "own verdict",
    "`agent`, `fork`, `resume` or `review`", "latest verdict is request_changes", "at most twice", "retry of a retry", "exhausted", "back to the user"]) {
    assert.ok(paragraph.includes(phrase), `${phrase}: ${paragraph}`);
  }
});
