import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { SessionManager, type ExtensionAPI, type ExtensionToolContext as ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization, type RecipientAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, type DecisionRecord } from "../routing/decision-record.ts";
import { autoStream } from "../router/auto-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import { createSubagentsExtension, type SubagentResult, type SubagentsDetails } from "./extension.ts";

// The reviewer's provider preference (PRD cml8 user story 34, ADR 0012): a
// reviewer prefers a surviving rung from another provider than the one the
// reviewed delegation ran on, and runs on that same provider when no other
// survives. As in review.test.ts, each worker is a real in-process pi session
// driven through the subagents tool; the providers, the classifier call, the
// evidence, the clock and the settings files are fakes. Assertions read the
// decision records and the requests each provider got.

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
const SOL = "openai-codex/gpt-6-sol";
const LUNA = "openai-codex/gpt-6-luna";
const NOW = new Date("2026-09-28T12:00:00.000Z");

function approved(...providers: string[]): RecipientAuthorization {
  return providers.reduce((store, provider) => authorizeRecipient(store, provider,
    grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: `send delegation data to ${provider}` })), emptyAuthorization());
}

interface Harness {
  readonly stateDir: string;
  readonly ctx: ExtensionContext;
  cleanup(): void;
}

function harness(tiers: Record<string, unknown>): Harness {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-review-provider-"));
  const agentDir = join(home, "agent"), projectDir = join(home, "project"), stateDir = join(home, "state");
  for (const dir of [agentDir, projectDir, stateDir]) mkdirSync(dir);
  const routing = { enabled: true, mode: "live", classifier: { model: `${HAIKU}:low`, timeoutMs: 1_000 }, tiers };
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing } }));
  saveAuthorization(join(stateDir, "authorized-recipients.json"), approved("anthropic", "openai-codex"));
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
  process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:medium`;
  const sessionManager = SessionManager.create(projectDir, join(agentDir, "sessions", "--project--"));
  sessionManager.appendMessage({ role: "user", content: "Write the notes", timestamp: Date.now() });
  sessionManager.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call", name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
  const ctx = { cwd: projectDir, hasUI: false, sessionManager, model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" } as unknown as ExtensionContext;
  return { stateDir, ctx, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

/** The router extension as a worker loads it. Its classifier answers the
 *  tier a task names in brackets, such as `[elevated]`, and mechanical otherwise. */
function routerExtension(): InlineExtension {
  const answer = (tier: string) => JSON.stringify({ tier, risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: `fake classifier says ${tier}` });
  return {
    name: "router",
    factory: createRouterExtension({
      classifierCall: () => async (prompt) => answer(/\[(standard|elevated|critical)\]/.exec(prompt)?.[1] ?? "mechanical"),
      evidence: () => () => ({ catalog: buildCatalog({ modelIds: [HAIKU, SONNET, SOL, LUNA], now: NOW }), refreshState: emptyRefreshState(),
        authorization: approved("anthropic", "openai-codex") }),
      now: () => NOW,
    }),
  };
}

type ProviderConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;

const textOf = (content: string | readonly { type: string; text?: string }[]) =>
  typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");

/** A fake provider serving `models`. A worker whose latest user message holds
 *  "Run:" makes that one tool call and then says "ran"; any other worker says "done". */
function fakeProvider(name: string, models: readonly string[], requests: { sessionId: string | undefined; rung: string }[]): InlineExtension {
  const config: ProviderConfig = {
    name: `Fake ${name}`, baseUrl: "http://localhost/unused", apiKey: "unused", api: `fake-${name}` as never,
    models: models.map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 })),
    streamSimple(model, context, options) {
      requests.push({ sessionId: options?.sessionId, rung: `${model.provider}/${model.id}:${options?.reasoning ?? "off"}` });
      const users = context.messages.flatMap((message) => message.role === "user" ? [textOf(message.content)] : []);
      const latest = users.at(-1) ?? "";
      const run = latest.indexOf("Run:");
      const toolResults = context.messages.filter((message) => message.role === "toolResult").length;
      const toolCall = run >= 0 && toolResults === 0 ? JSON.parse(latest.slice(run + "Run:".length)) as { name: string; arguments: Record<string, unknown> } : undefined;
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: toolCall ? [{ type: "toolCall", id: `call-${requests.length}`, name: toolCall.name, arguments: toolCall.arguments }]
          : [{ type: "text", text: run >= 0 ? "ran" : "done" }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolCall ? "toolUse" : "stop", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      push({ type: "done", reason: message.stopReason, message } as never);
      end({ api: model.api, provider: model.provider, model: model.id });
      return stream;
    },
  };
  return { name: `fake-${name}`, factory: (pi) => pi.registerProvider(name, config) };
}

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

/** The subagents tool as pi registers it in the orchestrator's session, with
 *  fake anthropic and openai-codex providers, and the requests they got. */
function orchestratorTools() {
  const requests: { sessionId: string | undefined; rung: string }[] = [];
  const tools: Tool[] = [];
  createSubagentsExtension({ workerExtensions: [routerExtension(),
    fakeProvider("anthropic", ["claude-haiku-4-5", "claude-sonnet-5"], requests), fakeProvider("openai-codex", ["gpt-6-sol", "gpt-6-luna"], requests)] })({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand() {}, registerShortcut() {}, on() {}, sendMessage() {},
    getActiveTools: () => ["read", "bash", "edit", "write", "subagents", "subagents_status", "subagents_message"],
  } as unknown as ExtensionAPI);
  const subagents = tools.filter((tool) => tool.name === "subagents").at(-1)!;
  async function one(ctx: ExtensionContext, item: Record<string, unknown>): Promise<SubagentResult> {
    const result = await subagents.execute("call", { items: [item] } as never, undefined, undefined, ctx);
    const [first] = (result.details as SubagentsDetails).results;
    assert.ok(first);
    assert.equal(first.status, "completed", JSON.stringify(first));
    return first;
  }
  return { one, requests };
}

const WRITE_NOTES = `Run:${JSON.stringify({ name: "write", arguments: { path: "notes.md", content: "# Notes\n" } })}`;

function decisionOf(h: Harness, delegationId: string): DecisionRecord {
  const record = readRoutingRecords(join(h.stateDir, "routing")).find((entry): entry is DecisionRecord => entry.recordType === "decision" && entry.delegationId === delegationId);
  assert.ok(record, `a decision record for ${delegationId}`);
  return record;
}

test("a reviewer prefers a surviving rung from another provider than the implementer's, over an ordered tier's list order", async () => {
  const h = harness({ mechanical: [`${HAIKU}:low`], standard: [`${HAIKU}:medium`],
    elevated: { order: "ordered", rungs: [`${HAIKU}:high`, `${SONNET}:high`, `${SOL}:high`] }, critical: [`${SONNET}:xhigh`] });
  try {
    const { one, requests } = orchestratorTools();
    const implementer = await one(h.ctx, { task: `[elevated] ${WRITE_NOTES}` });
    assert.equal(decisionOf(h, implementer.sessionId!).ranOn, `${HAIKU}:high`);
    const reviewer = await one(h.ctx, { task: "Check that notes.md has a heading", review: implementer.sessionId! });
    const record = decisionOf(h, reviewer.sessionId!);
    assert.ok(record.route.outcome === "chosen");
    assert.deepEqual([record.route.startedAtTier, record.route.tier, record.ranOn], ["elevated", "elevated", `${SOL}:high`]);
    assert.deepEqual(requests.filter((request) => request.sessionId === reviewer.sessionId).map((request) => request.rung), [`${SOL}:high`]);
  } finally { h.cleanup(); }
});

test("a reviewer prefers another provider even when balancing would pick the implementer's less-used provider", async () => {
  const h = harness({ mechanical: [`${LUNA}:low`], standard: [`${HAIKU}:medium`],
    elevated: [`${HAIKU}:high`, `${SONNET}:high`, `${SOL}:high`], critical: [`${SONNET}:xhigh`] });
  try {
    const { one } = orchestratorTools();
    // Two openai-codex delegations and one anthropic one: anthropic is the less-used provider.
    await one(h.ctx, { task: "Say done" });
    await one(h.ctx, { task: "Say done again" });
    const implementer = await one(h.ctx, { task: `[elevated] ${WRITE_NOTES}` });
    assert.equal(decisionOf(h, implementer.sessionId!).ranOn, `${HAIKU}:high`);
    const reviewer = await one(h.ctx, { task: "Check that notes.md has a heading", review: implementer.sessionId! });
    assert.equal(decisionOf(h, reviewer.sessionId!).ranOn, `${SOL}:high`);
  } finally { h.cleanup(); }
});

test("a reviewer falls back to the implementer's provider when no other provider survives at its tier, never to a lower tier or the excluded rung", async () => {
  // openai-codex has a rung only below the implementer's tier and above it; at elevated only anthropic rungs survive.
  const h = harness({ mechanical: [`${LUNA}:low`], standard: [`${SOL}:medium`],
    elevated: [`${HAIKU}:high`, `${SONNET}:high`], critical: [`${SOL}:xhigh`] });
  try {
    const { one, requests } = orchestratorTools();
    const implementer = await one(h.ctx, { task: `[elevated] ${WRITE_NOTES}` });
    assert.equal(decisionOf(h, implementer.sessionId!).ranOn, `${HAIKU}:high`);
    const reviewer = await one(h.ctx, { task: "Check that notes.md has a heading", review: implementer.sessionId! });
    const record = decisionOf(h, reviewer.sessionId!);
    assert.ok(record.route.outcome === "chosen");
    assert.deepEqual([record.route.startedAtTier, record.route.tier, record.ranOn], ["elevated", "elevated", `${SONNET}:high`]);
    assert.deepEqual(record.route.removed.map((removed) => [removed.rung, removed.reason]), [[`${HAIKU}:high`, "excluded rung"]]);
    assert.deepEqual(record.constraints, { minimumTier: "elevated", excludedRung: `${HAIKU}:high` });
    assert.deepEqual(requests.filter((request) => request.sessionId === reviewer.sessionId).map((request) => request.rung), [`${SONNET}:high`]);
  } finally { h.cleanup(); }
});
