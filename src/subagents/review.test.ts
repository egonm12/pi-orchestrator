import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext as ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, readUsableRoutingRecords, type DecisionRecord } from "../routing/decision-record.ts";
import { providerStream } from "../fixtures/provider-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import { createSubagentsExtension, type SubagentResult, type SubagentsDetails } from "./extension.ts";
import { orchestratorProtocol } from "./orchestrator-protocol.ts";
import { reviewRules } from "./review.ts";
import { REVIEWER_EDIT_DENIED, REVIEWER_MCP_DENIED } from "./editing.ts";
import { markWorkerSession } from "./worker-sessions.ts";
import { workerBoard } from "./worker-board.ts";
import { compactLines, workerRows } from "./worker-widget.ts";

// Independent reviewers of editing delegations (ADR 0010), as the
// orchestrator sees them: the subagents tool with a review item, and
// subagents_verdict. As in extension.test.ts, each worker is a real
// in-process pi session; the model provider, the classifier call, the
// evidence, the clock, settings files and the environment are fakes.
// Assertions read the tool results, the requests the provider got and the
// records in the state folder.

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
/** An elevated or critical worker runs on haiku:high, which leaves sonnet:high for its reviewer. */
const TIERS = { mechanical: [`${HAIKU}:low`], standard: [`${HAIKU}:medium`], elevated: [`${HAIKU}:high`, `${SONNET}:high`], critical: [`${HAIKU}:high`, `${SONNET}:high`] };
const ROUTING = { enabled: true, mode: "live", classifier: { model: `${HAIKU}:low`, timeoutMs: 1_000 }, tiers: TIERS };

interface Harness {
  readonly agentDir: string;
  readonly projectDir: string;
  readonly stateDir: string;
  cleanup(): void;
}

function harness(orchestratorSettings: Record<string, unknown> = { routing: ROUTING }): Harness {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-review-"));
  const agentDir = join(home, "agent"), projectDir = join(home, "project"), stateDir = join(home, "state");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  mkdirSync(stateDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: orchestratorSettings }));
  saveAuthorization(join(stateDir, "authorized-recipients.json"), approvedAnthropic());
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
  process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:medium`;
  return { agentDir, projectDir, stateDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

function approvedAnthropic() {
  const approval = grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: "send delegation data to anthropic" });
  return authorizeRecipient(emptyAuthorization(), "anthropic", approval);
}

/** The router extension as a worker loads it. Its classifier answers the
 *  tier a task names in brackets, such as `[elevated]`, and mechanical otherwise. */
function routerExtension(): InlineExtension {
  const answer = (tier: string) => JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `fake classifier says ${tier}` });
  return {
    name: "router",
    factory: createRouterExtension({
      classifierCall: () => async (prompt) => answer(/\[(standard|elevated|critical)\]/.exec(prompt)?.[1] ?? "mechanical"),
      evidence: () => () => ({ catalog: buildCatalog({ modelIds: [HAIKU, SONNET], now: NOW }), refreshState: emptyRefreshState(), authorization: approvedAnthropic() }),
      now: () => NOW,
    }),
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

/** A fake `anthropic` provider serving claude-haiku-4-5 and claude-sonnet-5. A worker whose
 *  latest user message holds "Run:" makes that one tool call
 *  (`{ "name": ..., "arguments": ... }` as JSON) and then says "ran"; a
 *  reviewer answers accept; any other worker says "done". */
function anthropic() {
  const requests: Request[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: ["claude-haiku-4-5", "claude-sonnet-5"].map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 })),
    streamSimple(model, context, options) {
      const sections = new Map<string, string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const [name, section] of Object.entries(message.sections ?? {})) {
          if (section === null) sections.delete(name);
          else sections.set(name, section);
        }
      }
      const users = context.messages.flatMap((message) => message.role === "user" ? [textOf(message.content)] : []);
      const systemPrompt = [...sections.values()].join("\n\n");
      requests.push({ sessionId: options?.sessionId, rung: `${model.provider}/${model.id}:${options?.reasoning ?? "off"}`, task: users[0] ?? "", systemPrompt });
      const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
      const latest = users.at(-1) ?? "";
      const run = latest.indexOf("Run:");
      const reply: { readonly text: string } | { readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> } } = run >= 0 && toolResults < users.filter((text) => text.includes("Run:")).length
        ? { toolCall: JSON.parse(latest.slice(run + "Run:".length)) as { name: string; arguments: Record<string, unknown> } }
        : { text: run >= 0 ? "ran" : systemPrompt.includes("# Review rules") ? "## Confirmed\nAnswer: accept" : "done" };
      const { stream, push, end } = providerStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: "toolCall" in reply ? [{ type: "toolCall", id: `call-${requests.length}`, name: reply.toolCall.name, arguments: reply.toolCall.arguments }]
          : [{ type: "text", text: reply.text }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolCall" in reply ? "toolUse" : "stop", timestamp: Date.now(),
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

/** The subagents extension's tools as pi registers them in the orchestrator's session. */
function loadSubagents(workerExtensions: readonly InlineExtension[]): (name: string) => Tool {
  const tools: Tool[] = [];
  createSubagentsExtension({ workerExtensions })({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand() {}, registerShortcut() {}, on() {}, sendMessage() {},
    getActiveTools: () => ["read", "bash", "edit", "write", "subagents", "subagents_status", "subagents_message"],
  } as unknown as ExtensionAPI);
  return (name) => {
    const found = tools.filter((tool) => tool.name === name).at(-1);
    assert.ok(found, `tool ${name} is registered`);
    return found;
  };
}

/** The orchestrator's context on a saved pi session whose latest entry is
 *  the assistant message making the subagents call `callId`, so a fork can copy the branch before it. */
function orchestrator(h: Harness, callId = "call"): ExtensionContext {
  const sessionManager = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
  sessionManager.appendMessage({ role: "user", content: "Write the notes", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: callId, name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
  return { cwd: h.projectDir, hasUI: false, sessionManager, model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" } as unknown as ExtensionContext;
}

const toolText = (result: { content: readonly { type: string; text?: string }[] }) => result.content.map((part) => part.text ?? "").join("");

/** One subagents call; its results and text. */
async function call(tools: (name: string) => Tool, ctx: ExtensionContext, items: readonly Record<string, unknown>[], callId = "call") {
  const result = await tools("subagents").execute(callId, { items, background: false } as never, undefined, undefined, ctx);
  return { results: (result.details as SubagentsDetails).results, text: toolText(result) };
}

async function one(tools: (name: string) => Tool, ctx: ExtensionContext, item: Record<string, unknown>, callId = "call"): Promise<SubagentResult & { text: string }> {
  const { results: [result], text } = await call(tools, ctx, [item], callId);
  assert.ok(result);
  return { ...result, text };
}

async function verdict(tools: (name: string) => Tool, ctx: ExtensionContext, params: Record<string, unknown>): Promise<string> {
  try { return toolText(await tools("subagents_verdict").execute("verdict", params as never, undefined, undefined, ctx)); } catch (error) { return (error as Error).message; }
}

const runTask = (name: string, args: Record<string, unknown>) => `Run:${JSON.stringify({ name, arguments: args })}`;
const WRITE_NOTES = runTask("write", { path: "notes.md", content: "# Notes\n" });

function decisionOf(h: Harness, delegationId: string): DecisionRecord {
  const record = readRoutingRecords(join(h.stateDir, "routing")).find((entry): entry is DecisionRecord => entry.recordType === "decision" && entry.delegationId === delegationId);
  assert.ok(record, `a decision record for ${delegationId}`);
  return record;
}

test("a review item is routed at or above the implementer's tier and never on its rung, its decision record links to the reviewed delegation, and it gets the review rules and the delegation's task, Result and files", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    assert.equal(implementer.status, "completed", JSON.stringify(implementer));
    const id = implementer.sessionId!;
    assert.equal(decisionOf(h, id).ranOn, `${HAIKU}:high`);
    assert.ok(implementer.text.includes(`This delegation edited and is elevated: at the medium gate level it needs an independent reviewer. Start one with a subagents item whose review is ${id}`), implementer.text);

    const reviewer = await one(tools, ctx, { task: "Check that notes.md has a heading", review: id });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    assert.equal(reviewer.review, id);
    const record = decisionOf(h, reviewer.sessionId!);
    assert.equal(record.reviewedDelegationId, id);
    assert.equal(record.classification.tier, "mechanical", "the reviewer's own task classifies lower");
    assert.ok(record.route.outcome === "chosen");
    assert.deepEqual([record.route.startedAtTier, record.route.tier, record.route.rung.rung, record.ranOn], ["elevated", "elevated", `${SONNET}:high`, `${SONNET}:high`]);
    assert.deepEqual(record.route.removed.map((removed) => [removed.rung, removed.reason]), [[`${HAIKU}:high`, "excluded rung"]]);
    assert.deepEqual(record.constraints, { minimumTier: "elevated", excludedRung: `${HAIKU}:high` });
    const requests = provider.requests.filter((request) => request.sessionId === reviewer.sessionId);
    assert.deepEqual(requests.map((request) => request.rung), [`${SONNET}:high`]);
    const prompt = requests[0]!.systemPrompt;
    assert.ok(prompt.includes(reviewRules("medium")), prompt);
    assert.ok(prompt.indexOf("# Reporting rules") < prompt.indexOf(reviewRules("medium")), "the review rules follow the reporting rules");
    for (const part of [`Delegation ${id}, routed at the elevated tier.`, `Its saved session, with the whole transcript: ${implementer.sessionFile}`,
      `<task>\n[elevated] ${WRITE_NOTES}\n</task>`, "<result>\nran\n</result>", "Files its edit and write calls named: notes.md."]) {
      assert.ok(prompt.includes(part), `${part}\n---\n${prompt}`);
    }
    assert.equal(requests[0]!.task, "Check that notes.md has a heading", "the orchestrator's task is the reviewer's task");
    assert.equal(reviewer.edited, undefined, "a review that only reads does not edit");
  } finally { h.cleanup(); }
});

const PLAIN_THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as never;

/** The compact row of the board's latest worker, as the widget, picker and status show it. */
const latestRow = () => compactLines({ rows: workerRows([workerBoard().workers().at(-1)!]), more: 0 }, Date.now(), PLAIN_THEME, 200)[0]!;

test("a reviewer's row names it by the reviewed delegation's label, or by its own label when it has one", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}`, label: "notes file" });
    const reviewer = await one(tools, ctx, { task: "Check the notes", review: implementer.sessionId! });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    assert.match(latestRow(), /^reviewer: notes file · elevated · [^ ]+ · \d+s · completed$/, latestRow());
    await one(tools, ctx, { task: "Check the heading", review: implementer.sessionId!, label: "heading check" });
    assert.match(latestRow(), /^reviewer: heading check · /, latestRow());

    const unlabelled = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    await one(tools, ctx, { task: "Check the notes", review: unlabelled.sessionId! });
    assert.match(latestRow(), /^reviewer · elevated · /, "a reviewer of an unlabelled delegation without its own label is plain reviewer");
  } finally { h.cleanup(); }
});

test("a resumed reviewer keeps reviewer identity and its label on the real board and in its row", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const first = await one(tools, ctx, { task: "Check the notes", review: implementer.sessionId!, label: "notes check" });
    assert.equal(first.status, "completed", JSON.stringify(first));
    const resumed = await one(tools, ctx, { resume: first.sessionId!, task: "Check again" }, "resume-reviewer");
    assert.equal(resumed.status, "completed", JSON.stringify(resumed));
    const worker = workerBoard().workers().at(-1)!;
    assert.equal(worker.review, implementer.sessionId);
    assert.match(latestRow(), /^reviewer: notes check · elevated · [^ ]+ · \d+s · completed$/, latestRow());
  } finally { h.cleanup(); }
});

test("subagents_verdict refuses a self-judged verdict on an elevated or critical delegation and takes one naming its completed reviewer; a spot check suffices below", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const ids: Record<string, string> = {};
    for (const tier of ["mechanical", "standard", "elevated", "critical"]) {
      const worker = await one(tools, ctx, { task: `[${tier}] ${runTask("write", { path: `${tier}.md`, content: "x\n" })}` });
      assert.equal(worker.status, "completed", JSON.stringify(worker));
      ids[tier] = worker.sessionId!;
    }
    const accept = (tier: string, reviewer?: string) => ({ delegationId: ids[tier], verdict: "accept", reason: "checked", ...(reviewer === undefined ? {} : { reviewer }) });
    for (const tier of ["elevated", "critical"]) {
      assert.equal(await verdict(tools, ctx, accept(tier)), `subagents_verdict: delegation ${ids[tier]} is ${tier} and needs an independent reviewer at the medium gate level: ` +
        `start one with a subagents item whose review is ${ids[tier]}, judge its Result, then name it here as reviewer`);
    }
    for (const tier of ["mechanical", "standard"]) assert.equal(await verdict(tools, ctx, accept(tier)), `Recorded accept on delegation ${ids[tier]}.`);

    const reviewer = await one(tools, ctx, { task: "Check it", review: ids.critical });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const reviewerId = reviewer.sessionId!;
    const reviewerRecord = decisionOf(h, reviewerId);
    assert.ok(reviewerRecord.route.outcome === "chosen");
    assert.deepEqual([decisionOf(h, ids.critical!).ranOn, reviewerRecord.route.tier, reviewerRecord.ranOn], [`${HAIKU}:high`, "critical", `${SONNET}:high`],
      "routed at critical, off the implementer's rung");
    // Not a reviewer, the reviewer of another delegation, and the delegation itself are refused.
    assert.equal(await verdict(tools, ctx, accept("critical", ids.elevated)),
      `subagents_verdict: delegation ${ids.elevated} is not a reviewer of this orchestrator session; start one with a subagents item whose review is ${ids.critical}`);
    assert.equal(await verdict(tools, ctx, accept("elevated", reviewerId)), `subagents_verdict: reviewer ${reviewerId} reviewed delegation ${ids.critical}, not ${ids.elevated}`);
    assert.equal(await verdict(tools, ctx, accept("critical", ids.critical)), `subagents_verdict: delegation ${ids.critical} cannot be its own reviewer`);
    assert.equal(await verdict(tools, ctx, { ...accept("critical"), reviewer: " " }), "subagents_verdict: a reviewer, when given, is the review delegation's id");
    assert.equal(await verdict(tools, ctx, accept("critical", reviewerId)), `Recorded accept on delegation ${ids.critical}, reviewed by delegation ${reviewerId}.`);
    // A reviewer is welcome at any tier.
    const mechanicalReviewer = await one(tools, ctx, { task: "Check it", review: ids.mechanical });
    assert.ok((await verdict(tools, ctx, { ...accept("mechanical", mechanicalReviewer.sessionId!), verdict: "request_changes" }))
      .startsWith(`Recorded request_changes on delegation ${ids.mechanical}, reviewed by delegation ${mechanicalReviewer.sessionId}. It replaces the earlier accept. `));
    const verdicts = readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "verdict" ? [record.delegationId] : []);
    assert.deepEqual(verdicts, [ids.mechanical, ids.standard, ids.critical, ids.mechanical], "a refused verdict is not recorded");
  } finally { h.cleanup(); }
});

test("a review started before the delegation's latest edit, or one that failed, does not count", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    const reviewer = await one(tools, ctx, { task: "Check it", review: id });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    // The delegation edits again after the review.
    const resumed = await one(tools, ctx, { resume: id, task: runTask("write", { path: "notes.md", content: "# Notes\nmore\n" }) });
    assert.equal(resumed.edited, true, JSON.stringify(resumed));
    assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId }),
      `subagents_verdict: reviewer ${reviewer.sessionId} started before delegation ${id}'s latest edit; start a new review`);
    const again = await one(tools, ctx, { task: "Check it again", review: id });
    assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: again.sessionId }),
      `Recorded accept on delegation ${id}, reviewed by delegation ${again.sessionId}.`);
    // The reviewer's system prompt names the later task too.
    const prompt = provider.requests.find((request) => request.sessionId === again.sessionId)!.systemPrompt;
    assert.ok(prompt.includes(`<later-instruction>\n${runTask("write", { path: "notes.md", content: "# Notes\nmore\n" })}\n</later-instruction>`), prompt);
  } finally { h.cleanup(); }
});

/** Rewrites the last line of the routing log whose record `matches` as a newer schema version would write it, one
 *  this reader cannot validate; returns its `<file>:<line>`. */
function makeUnreadable(h: Harness, matches: (record: Record<string, unknown>) => boolean): string {
  const dir = join(h.stateDir, "routing");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort().reverse()) {
    const lines = readFileSync(join(dir, file), "utf8").split("\n");
    const index = lines.map((line) => line.trim() !== "" && matches(JSON.parse(line) as Record<string, unknown>)).lastIndexOf(true);
    if (index === -1) continue;
    lines[index] = JSON.stringify({ ...JSON.parse(lines[index]!), schemaVersion: "decision-record/4" });
    writeFileSync(join(dir, file), lines.join("\n"));
    return `${file}:${index + 1}`;
  }
  assert.fail("no routing record matches");
}

const unreadableRefusal = (id: string, location: string, of = id) => new RegExp(`^subagents_verdict: the verdict on delegation ${id} is refused: ` +
  `routing record ${location.replace(".", "\\.")} of delegation ${of} cannot be read \\(field 'schemaVersion' .*\\); ` +
  "it may come from newer code than this session has loaded, so /reload may be needed$");

const verdictsOn = (h: Harness, id: string) => readUsableRoutingRecords(join(h.stateDir, "routing"))
  .filter((record) => record.recordType === "verdict" && record.delegationId === id).length;

test("at the low gate level a critical delegation whose decision line cannot be read is refused a verdict, with or without a reviewer, never taken as elevated", async () => {
  // pi-orchestrator-zb6t review: without its decision a delegation has no tier, is gated as elevated, and at low
  // an elevated delegation takes a spot check, so a critical one would pass with no reviewer.
  const h = harness({ routing: ROUTING, subagents: { gateLevel: "low" } });
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[critical] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    const reviewer = await one(tools, ctx, { task: "Check it", review: id });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const location = makeUnreadable(h, (record) => record.recordType === "decision" && record.delegationId === id);
    assert.match(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked" }), unreadableRefusal(id, location));
    assert.match(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId }), unreadableRefusal(id, location));
    assert.equal(verdictsOn(h, id), 0, "no verdict was recorded");
  } finally { h.cleanup(); }
});

test("a verdict is refused when the delegation's latest edit line cannot be read, so a review started before that edit cannot pass", async () => {
  // pi-orchestrator-zb6t review: a skipped newer edit record would let a review started before it pass.
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    const reviewer = await one(tools, ctx, { task: "Check it", review: id });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const resumed = await one(tools, ctx, { resume: id, task: runTask("write", { path: "notes.md", content: "# Notes\nmore\n" }) });
    assert.equal(resumed.edited, true, JSON.stringify(resumed));
    const edit = makeUnreadable(h, (record) => record.recordType === "edit" && record.delegationId === id);
    const judged = { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId };
    assert.match(await verdict(tools, ctx, judged), unreadableRefusal(id, edit));
    assert.equal(verdictsOn(h, id), 0, "no verdict was recorded");
  } finally { h.cleanup(); }
});

test("a verdict is refused when its reviewer's decision line cannot be read", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const id = (await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` })).sessionId!;
    const reviewer = await one(tools, ctx, { task: "Check it", review: id });
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const decision = makeUnreadable(h, (record) => record.recordType === "decision" && record.delegationId === reviewer.sessionId);
    assert.match(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId }),
      unreadableRefusal(id, decision, reviewer.sessionId));
    assert.equal(verdictsOn(h, id), 0, "no verdict was recorded");
  } finally { h.cleanup(); }
});

test("a fork and an agent's named model have no tier: gated as elevated, and reviewed at elevated or higher, off their rung", async () => {
  for (const kind of ["fork", "agent-model"] as const) {
    const h = harness({ routing: ROUTING, subagents: { agentDefinitionModel: { use: kind === "agent-model" ? "preserve" : "route" } } });
    try {
      mkdirSync(join(h.agentDir, "agents"));
      writeFileSync(join(h.agentDir, "agents", "scribe.md"), `---\nname: scribe\ndescription: Writes\nmodel: ${HAIKU}\nthinking: high\n---\n\nWrite notes.\n`);
      const provider = anthropic();
      const tools = loadSubagents([routerExtension(), provider.extension]);
      const ctx = orchestrator(h);
      const implementer = await one(tools, ctx, kind === "fork" ? { task: WRITE_NOTES, fork: true } : { task: WRITE_NOTES, agent: "scribe" });
      assert.equal(implementer.status, "completed", `${kind}: ${JSON.stringify(implementer)}`);
      const id = implementer.sessionId!;
      const rung = kind === "fork" ? `${HAIKU}:low` : `${HAIKU}:high`;
      assert.deepEqual(provider.requests.filter((request) => request.sessionId === id).map((request) => request.rung).at(0), rung, kind);
      assert.ok(implementer.text.includes("This delegation edited and is without a tier, so it is gated as elevated: at the medium gate level it needs an independent reviewer."), implementer.text);
      assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked" }),
        `subagents_verdict: delegation ${id} is without a tier, so it is gated as elevated, and needs an independent reviewer at the medium gate level: ` +
        `start one with a subagents item whose review is ${id}, judge its Result, then name it here as reviewer`, kind);
      // An agent gives the reviewer instructions, but its model does not bypass the constraints.
      const reviewer = await one(tools, ctx, { task: "Check it", review: id, agent: "scribe" });
      assert.equal(reviewer.status, "completed", `${kind}: ${JSON.stringify(reviewer)}`);
      const record = decisionOf(h, reviewer.sessionId!);
      assert.ok(record.route.outcome === "chosen");
      assert.equal(record.route.startedAtTier, "elevated", kind);
      assert.deepEqual(record.constraints, { minimumTier: "elevated", excludedRung: rung }, kind);
      assert.notEqual(record.ranOn, rung, kind);
      assert.equal(record.reviewedDelegationId, id);
      const prompt = provider.requests.find((request) => request.sessionId === reviewer.sessionId)!.systemPrompt;
      assert.ok(prompt.includes(`Delegation ${id}, without a tier, so it is gated as elevated.`), prompt);
      assert.ok(prompt.indexOf(reviewRules("medium")) < prompt.indexOf("Write notes."), "the agent's instructions follow the review rules");
      // A fork's review names only its own task, not the orchestrator's conversation it copied.
      assert.ok(prompt.includes(`<task>\n${WRITE_NOTES}\n</task>`), prompt);
      assert.equal(prompt.includes("<task>\nWrite the notes"), false, prompt);
      assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId }),
        `Recorded accept on delegation ${id}, reviewed by delegation ${reviewer.sessionId}.`, kind);
    } finally { h.cleanup(); }
  }
});

test("in shadow mode and with routing off a reviewer runs on the implementer's rung with a fresh context, and the verdict records a same-rung review", async () => {
  for (const mode of ["shadow", "off"] as const) {
    // In shadow mode and with routing off every worker runs on the session model, the implementer's rung too.
    const h = harness({ routing: mode === "off" ? { ...ROUTING, enabled: false } : { ...ROUTING, mode } });
    try {
      const provider = anthropic();
      const tools = loadSubagents([routerExtension(), provider.extension]);
      const ctx = orchestrator(h);
      const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
      const id = implementer.sessionId!;
      assert.deepEqual(provider.requests.filter((request) => request.sessionId === id).map((request) => request.rung).at(0), `${HAIKU}:medium`, mode);
      const reviewer = await one(tools, ctx, { task: "Check it", review: id });
      assert.equal(reviewer.status, "completed", `${mode}: ${JSON.stringify(reviewer)}`);
      const requests = provider.requests.filter((request) => request.sessionId === reviewer.sessionId);
      assert.deepEqual(requests.map((request) => request.rung), [`${HAIKU}:medium`], `${mode}: the same rung`);
      assert.equal(requests[0]!.task, "Check it", `${mode}: a fresh context, with only the reviewer's own task`);
      if (mode === "shadow") assert.equal(decisionOf(h, reviewer.sessionId!).ranOn, `${HAIKU}:medium`);
      assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: reviewer.sessionId }),
        `Recorded accept on delegation ${id}, reviewed by delegation ${reviewer.sessionId} on the delegation's own rung (a same-rung review).`, mode);
      const verdicts = readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "verdict" ? [record] : []);
      assert.deepEqual(verdicts.map((record) => [record.delegationId, record.sameRungReview]), [[id, true]], mode);
      // A reviewer on another rung backs an ordinary verdict.
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:high`;
      const other = await one(tools, ctx, { task: "Check it again", review: id });
      assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked", reviewer: other.sessionId }),
        `Recorded accept on delegation ${id}, reviewed by delegation ${other.sessionId}. It replaces the earlier accept.`, mode);
      assert.equal(readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "verdict" ? [record] : []).at(-1)?.sameRungReview, undefined);
    } finally { h.cleanup(); }
  }
});

test("a reviewer's editing calls are denied with the reason, its reads, searches, builds and tests run, and it never becomes an editing delegation", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "index.js"), "export const x = 1;\n");
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    const calls = [
      [runTask("write", { path: "review.md", content: "x\n" }), true],
      [runTask("bash", { command: "echo fixed > notes.md" }), true],
      [runTask("read", { path: "notes.md" }), false],
      [runTask("bash", { command: "grep Notes notes.md" }), false],
      [runTask("bash", { command: "npm run build" }), false],
      [runTask("bash", { command: "node --check index.js" }), false],
    ] as const;
    for (const [task, denied] of calls) {
      const reviewer = await one(tools, ctx, { task, review: id });
      assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
      assert.equal(reviewer.edited, undefined, task);
      const session = readFileSync(reviewer.sessionFile!, "utf8");
      assert.equal(session.includes(REVIEWER_EDIT_DENIED), denied, task);
    }
    assert.equal(readFileSync(join(h.projectDir, "notes.md"), "utf8"), "# Notes\n", "the reviewer changed nothing");
    assert.equal(existsSync(join(h.projectDir, "review.md")), false);
    const edits = readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "edit" ? [record.delegationId] : []);
    assert.deepEqual(edits, [id], "only the implementer has an edit record");
  } finally { h.cleanup(); }
});

test("a reviewer may call only MCP tools marked read-only, and a codemode script's editing or MCP calls are denied like direct ones", async () => {
  const h = harness();
  try {
    // The fake MCP server's `lookup` says nothing about changes and its `peek` is read-only; docs' tools need codemode, which the MCP extension activates.
    const server = { command: process.execPath, args: [join(import.meta.dirname, "..", "fixtures", "fake-mcp-server.mjs")] };
    writeFileSync(join(h.agentDir, "mcp.json"), JSON.stringify({ mcpServers: { jira: { ...server, exposure: "direct" }, docs: { ...server, exposure: "codemode" } } }));
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    const calls = [
      [runTask("mcp__jira__lookup", {}), REVIEWER_MCP_DENIED, undefined],
      [runTask("mcp__jira__peek", {}), undefined, "called peek"],
      [runTask("codemode", { code: "return await tools.write({ path: 'review.md', content: 'x' });" }), REVIEWER_EDIT_DENIED, undefined],
      [runTask("codemode", { code: "return await tools.mcp__docs__lookup({});" }), REVIEWER_MCP_DENIED, undefined],
      [runTask("codemode", { code: "return await tools.mcp__docs__peek({});" }), undefined, "called peek"],
      [runTask("codemode", { code: "return await tools.read({ path: 'facts.txt' });" }), undefined, "fact-42"],
    ] as const;
    writeFileSync(join(h.projectDir, "facts.txt"), "fact-42\n");
    for (const [task, reason, ran] of calls) {
      const reviewer = await one(tools, ctx, { task, review: id });
      assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
      assert.equal(reviewer.edited, undefined, task);
      const session = readFileSync(reviewer.sessionFile!, "utf8");
      for (const denial of [REVIEWER_EDIT_DENIED, REVIEWER_MCP_DENIED]) {
        assert.equal(session.includes(JSON.stringify(denial).slice(1, -1)), denial === reason, `${task}: ${denial}`);
      }
      // The call's result, not the task, holds what it ran: the task names no result.
      if (ran !== undefined) assert.ok(session.split("\n").some((line) => line.includes('"toolResult"') && line.includes(ran)), `${task}: ${ran}`);
    }
    assert.equal(existsSync(join(h.projectDir, "review.md")), false, "the reviewer's script wrote nothing");
  } finally { h.cleanup(); }
});

/** An earlier tool_call hook that rewrites a bash command in place, as the
 *  pi-claude-hooks package does with the `rtk hook claude` PreToolUse hook:
 *  each rewrite below is what rtk 0.49.0 answered for that command. */
function rtkHook(rewrites: Readonly<Record<string, string>>): InlineExtension {
  return {
    name: "fake-rtk-hook",
    factory: (pi) => { pi.on("tool_call", (event) => {
      const input = event.input as { command?: unknown };
      if (event.toolName === "bash" && typeof input.command === "string") input.command = rewrites[input.command] ?? input.command;
    }); },
  };
}

test("a reviewer's git inspection, counts and beans reads run when an earlier hook routes them through rtk, and its commit and an rtk shell run are still denied", async () => {
  const h = harness();
  try {
    const dir = h.projectDir;
    const rewrites = {
      [`git -C ${dir} show --stat e0abfd7`]: `rtk git -C ${dir} show --stat e0abfd7`,
      [`cd ${dir} && git show --stat 5d29fa3 && git status --short`]: `cd ${dir} && rtk git show --stat 5d29fa3 && rtk git status --short`,
      [`wc -l ${dir}/notes.md`]: `rtk wc -l ${dir}/notes.md`,
      ["git commit -m x"]: "rtk git commit -m x",
    };
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension, rtkHook(rewrites)]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const id = implementer.sessionId!;
    // The tool calls a reviewer made on 2026-09-28, with the shape pi gave them.
    const calls = [
      [runTask("bash", { command: `git -C ${dir} show --stat e0abfd7`, timeout: 60 }), false],
      [runTask("bash", { command: `cd ${dir} && git show --stat 5d29fa3 && git status --short`, timeout: 30 }), false],
      [runTask("bash", { command: `wc -l ${dir}/notes.md`, timeout: 10 }), false],
      [runTask("bash", { command: `cd ${dir} && beans prime | head -50`, timeout: 30 }), false],
      [runTask("bash", { command: "git commit -m x", timeout: 30 }), true],
      // rtk summary runs `ls > notes.md` through sh -c: it writes.
      [runTask("bash", { command: `cd ${dir} && rtk summary ls '>' notes.md`, timeout: 30 }), true],
    ] as const;
    for (const [task, denied] of calls) {
      const reviewer = await one(tools, ctx, { task, review: id });
      assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
      assert.equal(reviewer.edited, undefined, task);
      assert.equal(readFileSync(reviewer.sessionFile!, "utf8").includes(REVIEWER_EDIT_DENIED), denied, task);
    }
  } finally { h.cleanup(); }
});

test("a review item is refused, without starting a worker, with fork or resume, from a worker, and for a delegation that is unknown or did not edit", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
    const research = await one(tools, ctx, { task: "Look around" });
    const id = implementer.sessionId!;
    const unknown = "0b7c7a5e-0000-4000-8000-000000000000";
    const { results } = await call(tools, ctx, [
      { task: "Check it", review: id, fork: true },
      { task: "Check it", review: id, resume: research.sessionId },
      { task: "Check it", review: unknown },
      { task: "Check it", review: research.sessionId },
    ]);
    assert.deepEqual(results.map((result) => [result.status, result.sessionId, result.error]), [
      ["failed", undefined, "review excludes fork"],
      ["failed", undefined, "resume excludes agent, fork and review"],
      ["failed", undefined, `cannot review delegation ${unknown}: unknown delegation id`],
      ["failed", undefined, `cannot review delegation ${research.sessionId}: it did not edit; only an editing delegation gets a reviewer`],
    ]);
    const unmark = markWorkerSession(ctx.sessionManager.getSessionId());
    try {
      const nested = await one(tools, ctx, { task: "Check it", review: id });
      assert.deepEqual([nested.status, nested.error], ["failed", "only the orchestrator starts reviewers"]);
    } finally { unmark(); }
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).some((record) => record.recordType === "decision" && record.reviewedDelegationId !== undefined), false);
  } finally { h.cleanup(); }
});

test("the protocol describes reviewers: when one is needed, how to start one and how to name it in the verdict", () => {
  const paragraph = orchestratorProtocol(3, "medium").split("\n\n").find((text) => text.includes("`review`"));
  assert.ok(paragraph);
  for (const phrase of ["gate level calls for an independent reviewer", "`review`", "never on its rung", "reruns nothing", "accept or request changes",
    "`reviewer`", "refused", "latest edit", "spot check", "tell the user", "raise the gate level to max"]) {
    assert.ok(paragraph.includes(phrase), `${phrase}: ${paragraph}`);
  }
  const atMax = orchestratorProtocol(3, "max").split("\n\n").find((text) => text.includes("`review`"));
  assert.ok(atMax?.includes("reruns the Result's Verified by commands"), atMax);
  assert.equal(atMax?.includes("reruns nothing"), false, atMax);
});

test("the protocol names the gate level in force and what it asks of each tier", () => {
  const gateParagraph = (level: "low" | "medium" | "high" | "max") =>
    orchestratorProtocol(3, level).split("\n\n").find((text) => text.startsWith("Your gate level is")) ?? "";
  assert.ok(gateParagraph("medium").startsWith("Your gate level is medium. It sets what an editing delegation needs by its tier: " +
    "mechanical and standard need your spot check; elevated and critical need an independent reviewer. " +
    "A delegation without a tier (a forked worker, or one whose agent definition names a model) counts as elevated."), gateParagraph("medium"));
  assert.ok(gateParagraph("low").includes("mechanical and standard need no verdict; elevated needs your spot check; critical needs an independent reviewer."));
  assert.ok(gateParagraph("low").includes("An ungated delegation needs no verdict"));
  assert.ok(gateParagraph("high").includes("mechanical needs your spot check; standard, elevated and critical need an independent reviewer."));
  assert.ok(gateParagraph("max").includes("mechanical, standard, elevated and critical need an independent reviewer. "));
  assert.ok(gateParagraph("max").includes("Every reviewer reruns the Result's Verified by commands."));
  for (const level of ["medium", "high", "max"] as const) {
    assert.equal(gateParagraph(level).includes("ungated"), false, level);
    for (const phrase of ["raise it for one delegation, never lower it", "`gateLevel`", "`gateLevelReason`", "`subagents_verdict`"]) {
      assert.ok(gateParagraph(level).includes(phrase), `${level}: ${phrase}`);
    }
  }
});

test("the owner's gate level sets each tier's gate action: at low mechanical and standard are ungated and elevated takes a spot check, at high standard needs a reviewer", async () => {
  for (const [gateLevel, needsReviewer, ungated] of [["low", ["critical"], ["mechanical", "standard"]], ["high", ["standard", "elevated", "critical"], []]] as const) {
    const h = harness({ routing: ROUTING, subagents: { gateLevel } });
    try {
      const provider = anthropic();
      const tools = loadSubagents([routerExtension(), provider.extension]);
      const ctx = orchestrator(h);
      for (const tier of ["mechanical", "standard", "elevated", "critical"] as const) {
        const worker = await one(tools, ctx, { task: `[${tier}] ${runTask("write", { path: `${tier}.md`, content: "x\n" })}` });
        assert.equal(worker.status, "completed", JSON.stringify(worker));
        const id = worker.sessionId!;
        const reviewer = (needsReviewer as readonly string[]).includes(tier);
        const note = (ungated as readonly string[]).includes(tier)
          ? `This delegation edited. At the ${gateLevel} gate level a ${tier} delegation needs no verdict: it is ungated. You may still judge its Result and record a verdict with subagents_verdict.`
          : reviewer ? `This delegation edited and is ${tier}: at the ${gateLevel} gate level it needs an independent reviewer.`
          : "This delegation edited. Judge its Result, then record a verdict with subagents_verdict.";
        assert.ok(worker.text.includes(note), `${gateLevel} ${tier}: ${worker.text}`);
        // A self-judged verdict: refused where the gate action is a reviewer, taken for a spot check and for an ungated delegation.
        assert.equal(await verdict(tools, ctx, { delegationId: id, verdict: "accept", reason: "checked" }), reviewer
          ? `subagents_verdict: delegation ${id} is ${tier} and needs an independent reviewer at the ${gateLevel} gate level: ` +
            `start one with a subagents item whose review is ${id}, judge its Result, then name it here as reviewer`
          : `Recorded accept on delegation ${id}.`, `${gateLevel} ${tier}`);
      }
    } finally { h.cleanup(); }
  }
});

test("a verdict may raise the gate level for its delegation with a reason, and is then held to it; lowering, keeping the level or a raise without a reason is refused", async () => {
  const h = harness();
  try {
    const provider = anthropic();
    const tools = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h);
    const worker = await one(tools, ctx, { task: `[mechanical] ${WRITE_NOTES}` });
    const id = worker.sessionId!;
    const accept = { delegationId: id, verdict: "accept", reason: "checked" };
    const lower = "subagents_verdict: the gate level is medium, and a verdict may only raise it for its delegation, never lower it: name high or max, or leave gateLevel out";
    assert.equal(await verdict(tools, ctx, { ...accept, gateLevel: "low", gateLevelReason: "trivial" }), lower);
    assert.equal(await verdict(tools, ctx, { ...accept, gateLevel: "medium", gateLevelReason: "as it is" }), lower);
    for (const params of [{ ...accept, gateLevel: "high" }, { ...accept, gateLevelReason: "risky" }, { ...accept, gateLevel: "high", gateLevelReason: " " }]) {
      assert.equal(await verdict(tools, ctx, params),
        "subagents_verdict: a raised gateLevel needs a gateLevelReason saying why, and a gateLevelReason needs a gateLevel", JSON.stringify(params));
    }
    assert.equal(await verdict(tools, ctx, { ...accept, gateLevel: "strict", gateLevelReason: "risky" }), "subagents_verdict: a gateLevel, when given, is one of low, medium, high, max");
    // At max a mechanical delegation needs a reviewer: the raised level holds the verdict to it.
    assert.equal(await verdict(tools, ctx, { ...accept, gateLevel: "max", gateLevelReason: "it rewrites the notes format" }),
      `subagents_verdict: delegation ${id} is mechanical and needs an independent reviewer at the max gate level: ` +
      `start one with a subagents item whose review is ${id}, judge its Result, then name it here as reviewer`);
    assert.equal(await verdict(tools, ctx, { ...accept, gateLevel: "high", gateLevelReason: "the user asked for care" }),
      `Recorded accept on delegation ${id}, with its gate level raised from medium to high.`);
    const reviewer = await one(tools, ctx, { task: "Check it", review: id });
    assert.equal(await verdict(tools, ctx, { ...accept, reviewer: reviewer.sessionId, gateLevel: "max", gateLevelReason: "it rewrites the notes format" }),
      `Recorded accept on delegation ${id}, reviewed by delegation ${reviewer.sessionId}, with its gate level raised from medium to max. It replaces the earlier accept.`);
    const verdicts = readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "verdict" ? [record.gateLevelRaise] : []);
    assert.deepEqual(verdicts, [{ from: "medium", to: "high", reason: "the user asked for care" }, { from: "medium", to: "max", reason: "it rewrites the notes format" }],
      "each raise is recorded on its verdict, and a refused one records nothing");
  } finally { h.cleanup(); }
});

test("at the max gate level a reviewer is told to rerun the Result's Verified by commands; below it, to rerun nothing", async () => {
  for (const gateLevel of ["high", "max"] as const) {
    const h = harness({ routing: ROUTING, subagents: { gateLevel } });
    try {
      const provider = anthropic();
      const tools = loadSubagents([routerExtension(), provider.extension]);
      const ctx = orchestrator(h);
      const implementer = await one(tools, ctx, { task: `[elevated] ${WRITE_NOTES}` });
      const reviewer = await one(tools, ctx, { task: "Check it", review: implementer.sessionId });
      assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
      const prompt = provider.requests.find((request) => request.sessionId === reviewer.sessionId)!.systemPrompt;
      assert.ok(prompt.includes(reviewRules(gateLevel)), prompt);
      assert.equal(prompt.includes("Rerun every command in its Verified by section"), gateLevel === "max", gateLevel);
      assert.equal(prompt.includes("Rerun nothing"), gateLevel !== "max", gateLevel);
    } finally { h.cleanup(); }
  }
});
