import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { DefaultPackageManager, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { attachVerdict } from "../routing/verdicts.ts";
import { buildRoutingReport } from "../routing/routing-report.ts";
import { autoStream } from "../router/auto-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import personalGuard from "../guard/extension.ts";
import { createSubagentsExtension, MAX_TEXT_BYTES, type SubagentsDetails, type SubagentsProgressDetails } from "./extension.ts";
import { markWorkerSession } from "./worker-sessions.ts";

// The subagents extension as pi loads it. A fake ExtensionAPI records the
// registered tool; a test calls its `execute` as pi does. The worker is a real
// in-process pi session built by the SDK from a throwaway agent dir. It loads
// the router extension (with a fake classifier call, evidence and clock) and
// a fake `anthropic` provider as inline extensions, standing in for installed
// ones. The fakes sit at the system boundaries only: the model provider, the
// classifier call, the evidence source, the clock, settings files and the
// environment. Assertions read what the orchestrator or the owner can observe:
// the tool result, the worker's session file, the requests the provider got
// and the records in the state folder.

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
const RUNG = `${HAIKU}:low`;
const NOW = new Date("2026-09-26T12:00:00.000Z");
const CHECKOUT = resolve(import.meta.dirname, "..", "..");
const ROUTING = {
  enabled: true,
  mode: "live",
  classifier: { model: RUNG, timeoutMs: 1_000 },
  tiers: { mechanical: [RUNG], standard: [RUNG], elevated: [RUNG], critical: [RUNG] },
};

interface Harness {
  readonly agentDir: string;
  readonly projectDir: string;
  readonly stateDir: string;
  cleanup(): void;
}

function harness(settings: Record<string, unknown> = { orchestrator: { routing: ROUTING } }): Harness {
  const home = mkdtempSync(join(tmpdir(), "pi-harness-subagents-"));
  const agentDir = join(home, "agent"), projectDir = join(home, "project"), stateDir = join(home, "state");
  mkdirSync(agentDir);
  mkdirSync(projectDir);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  // A throwaway home keeps the owner's files, extensions and credentials out.
  process.env.HOME = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.PI_ORCHESTRATOR_STATE_DIR = stateDir;
  process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:medium`;
  return { agentDir, projectDir, stateDir, cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

type ProviderConfig = NonNullable<Parameters<ExtensionAPI["registerProvider"]>[1]>;

interface ProviderRequest {
  readonly sessionId: string | undefined;
  readonly model: string;
  readonly tools: readonly string[];
  /** The system messages' text and sections, as one string. */
  readonly systemText: string;
  readonly thinkingLevel: string | undefined;
  readonly messages: readonly string[];
}

/** A fake `anthropic` provider serving `modelIds` (claude-haiku-4-5 unless
 *  given) offline: every request is recorded and answered with `reply`, as
 *  one text part. */
function fakeAnthropic(reply: string, onRequest?: (finish: () => void) => void, modelIds: readonly string[] = ["claude-haiku-4-5"]) {
  const requests: ProviderRequest[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: modelIds.map((id) => ({ id, name: id, reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 })),
    streamSimple(model, context, options) {
      // Provider contexts carry tools in system-message deltas, not context.tools.
      const tools = new Set<string>();
      const systemText: string[] = [];
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
        systemText.push(typeof message.content === "string" ? message.content : message.content.map((part) => part.text).join(""));
        systemText.push(...Object.values(message.sections ?? {}).filter((section) => section !== null));
      }
      requests.push({ sessionId: options?.sessionId, model: `${model.provider}/${model.id}`, tools: [...tools], systemText: systemText.join("\n"), thinkingLevel: options?.reasoning,
        messages: context.messages.filter((message) => message.role !== "system").map((message) => JSON.stringify(message)) });
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", content: [{ type: "text", text: reply }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      const finish = () => { push({ type: "done", reason: "stop", message } as never); end({ api: model.api, provider: model.provider, model: model.id }); };
      if (onRequest) {
        options?.signal?.addEventListener("abort", finish, { once: true });
        onRequest(finish);
      }
      else finish();
      return stream;
    },
  };
  const extension: InlineExtension = { name: "fake-anthropic", factory: (pi) => pi.registerProvider("anthropic", config) };
  return { extension, requests };
}

/** An installed extension with a tool of its own, to show extension tools reach the worker. */
const PROBE_TOOL_EXTENSION: InlineExtension = {
  name: "probe-tool",
  factory: (pi) => pi.registerTool({
    name: "probe", label: "Probe", description: "A tool from another installed extension.",
    parameters: { type: "object", properties: {} } as unknown as Tool["parameters"],
    async execute() { return { content: [], details: undefined }; },
  }),
};

function approvedAnthropic() {
  const approval = grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: "send delegation data to anthropic" });
  return authorizeRecipient(emptyAuthorization(), "anthropic", approval);
}

/** The router extension as the worker loads it, with a classifier that
 *  always answers mechanical and a catalog of `modelIds`. */
function routerExtension(modelIds: readonly string[] = [HAIKU]): InlineExtension {
  const classifierAnswer = JSON.stringify({ tier: "mechanical", risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: "fake classifier says mechanical" });
  return {
    name: "router",
    factory: createRouterExtension({
      classifierCall: () => async () => classifierAnswer,
      evidence: () => () => ({ catalog: buildCatalog({ modelIds: [...modelIds], now: NOW }), refreshState: emptyRefreshState(), authorization: approvedAnthropic() }),
      now: () => NOW,
    }),
  };
}

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

/** The orchestrator's active tools in these tests: pi's default built-ins, the probe tool and subagents. */
const ORCHESTRATOR_TOOLS = ["read", "bash", "edit", "write", "probe", "subagents", "subagents_status", "subagents_message"];

/** A message the extension sent into the orchestrator's session, with its delivery options. */
interface SentMessage {
  readonly message: { readonly customType: string; readonly content: string | readonly { readonly type: string; readonly text?: string }[]; readonly display: boolean; readonly details?: unknown };
  readonly options: { readonly triggerTurn?: boolean; readonly deliverAs?: "steer" | "followUp" | "nextTurn" } | undefined;
}

interface LoadedSubagents {
  /** A registered tool by name, as pi exposes it to the orchestrator. */
  tool(name?: string): Tool;
  /** The subagents_status tool. */
  statusTool(): Tool;
  /** Runs the extension's session_start handlers, as pi does when the orchestrator's session starts. */
  startSession(ctx: ExtensionContext): Promise<void>;
  /** Runs the extension's session_shutdown handlers, as pi does when the orchestrator's session ends. */
  shutdownSession(ctx: ExtensionContext): Promise<void>;
  /** Runs a registered command as the owner types it, and returns what it showed. */
  runCommand(name: string, args: string, ctx: ExtensionContext): Promise<string[]>;
  /** Every message the extension sent into the orchestrator's session. */
  readonly messages: readonly SentMessage[];
}

type Command = Parameters<ExtensionAPI["registerCommand"]>[1];

/** The subagents extension as pi loads it in the orchestrator's session. */
function loadSubagents(workerExtensions: readonly InlineExtension[]): LoadedSubagents {
  const tools: Tool[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, Command>();
  const messages: SentMessage[] = [];
  createSubagentsExtension({ workerExtensions })({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) { messages.push({ message, options }); },
    getActiveTools: () => [...ORCHESTRATOR_TOOLS],
  } as unknown as ExtensionAPI);
  const emit = async (event: { type: string; reason: string }, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  return {
    tool(name = "subagents") {
      const found = tools.filter((tool) => tool.name === name).at(-1);
      assert.ok(found, `tool ${name} is registered`);
      return found;
    },
    statusTool() {
      const statusTool = tools.find((tool) => tool.name === "subagents_status");
      assert.ok(statusTool, JSON.stringify(tools.map((tool) => tool.name)));
      return statusTool;
    },
    startSession: (ctx) => emit({ type: "session_start", reason: "startup" }, ctx),
    shutdownSession: (ctx) => emit({ type: "session_shutdown", reason: "quit" }, ctx),
    async runCommand(name, args, ctx) {
      const command = commands.get(name);
      assert.ok(command, `command /${name} is registered`);
      const shown: string[] = [];
      const ui = { notify: (text: string) => { shown.push(text); } };
      await command.handler(args, { ...ctx, hasUI: true, ui } as never);
      return shown;
    },
    messages,
  };
}

/** The subagents tool as pi registers it in the orchestrator's session. */
function loadSubagentsTool(workerExtensions: readonly InlineExtension[]): Tool {
  return loadSubagents(workerExtensions).tool();
}

/** Writes an agent definition file into `dir`. */
function writeAgentDefinition(dir: string, file: string, frontmatter: Record<string, string>, body: string): void {
  mkdirSync(dir, { recursive: true });
  const lines = Object.entries(frontmatter).map(([key, value]) => `${key}: ${value}`);
  writeFileSync(join(dir, file), ["---", ...lines, "---", "", body, ""].join("\n"));
}

interface Orchestrator {
  readonly ctx: ExtensionContext;
  readonly sessionDir: string;
  readonly sessionId: string;
}

/** The orchestrator's context: a saved pi session in the agent dir's sessions folder. */
function orchestrator(h: Harness): Orchestrator {
  const sessionManager = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
  const ctx = { cwd: h.projectDir, hasUI: false, sessionManager } as unknown as ExtensionContext;
  return { ctx, sessionDir: sessionManager.getSessionDir(), sessionId: sessionManager.getSessionId() };
}

async function callSubagents(tool: Tool, ctx: ExtensionContext, task: string, agent?: string) {
  const result = await tool.execute("call-1", { items: [agent === undefined ? { task } : { task, agent }] } as never, undefined, undefined, ctx);
  const details = result.details as SubagentsDetails;
  assert.equal(details.results.length, 1);
  const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
  return { text, worker: details.results[0]! };
}

interface SessionLine {
  readonly type: string;
  readonly id?: string;
  readonly provider?: string;
  readonly modelId?: string;
  readonly message?: { readonly role?: string; readonly content?: readonly { readonly type: string; readonly text?: string }[] };
}

function sessionLines(file: string): SessionLine[] {
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line) as SessionLine);
}

test("a completed worker resumes its saved session with the same delegation and pinned rung", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    const provider = fakeAnthropic("Done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const first = await callSubagents(tool, main.ctx, "First task");
    assert.equal(first.worker.status, "completed");
    if (!first.worker.sessionId || !first.worker.sessionFile) return;
    const resumed = await tool.execute("call-2", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    const worker = (resumed.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.sessionId, first.worker.sessionId);
    assert.equal(worker.sessionFile, first.worker.sessionFile);
    assert.deepEqual(provider.requests.map((request) => request.sessionId), [first.worker.sessionId, first.worker.sessionId]);
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).filter((record) => record.recordType === "decision").length, 1);
    assert.equal(sessionLines(first.worker.sessionFile).filter((line) => line.message?.role === "user").length, 2);
    const recordDir = join(h.stateDir, "routing");
    const refreshStatePath = join(h.stateDir, "refresh-state.json");
    attachVerdict({ recordDir, delegationId: first.worker.sessionId, verdict: "request_changes", refreshStatePath });
    attachVerdict({ recordDir, delegationId: first.worker.sessionId, verdict: "accept", refreshStatePath });
    assert.equal(buildRoutingReport(recordDir).totals.decisions, 1);
    assert.deepEqual(buildRoutingReport(recordDir).totals.verdicts, { accept: 1, request_changes: 0, missing: 0 });
  } finally { h.cleanup(); }
});

test("a finished fork resumes on its fork record's model and effort, and a resume item may be background", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    const provider = fakeAnthropic("Done");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Context", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const first = await subagents.tool().execute("fork-call", { items: [{ task: "Fork task", fork: true }] } as never, undefined, undefined, ctx);
    const fork = (first.details as SubagentsDetails).results[0]!;
    assert.equal(fork.status, "completed", JSON.stringify(fork));
    // A later model switch does not move the resumed fork: its pin is the fork record's.
    (ctx as { thinkingLevel: string }).thinkingLevel = "low";
    const start = (await subagents.tool().execute("call-2", { items: [{ resume: fork.sessionId, task: "Go on" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    assert.deepEqual(start.delegationIds, [fork.sessionId], "a resume keeps its delegation id");
    await waitFor(() => subagents.messages.length === 1, "the notice is in");
    const [resumed] = (subagents.messages[0]!.message.details as NoticeDetails).results;
    assert.equal(resumed?.status, "completed", JSON.stringify(resumed));
    assert.equal(resumed?.sessionId, fork.sessionId);
    assert.deepEqual(provider.requests.map((request) => [request.sessionId, request.model, request.thinkingLevel]),
      [[fork.sessionId, HAIKU, "high"], [fork.sessionId, HAIKU, "high"]]);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["fork"], "a resume writes no record");
  } finally { h.cleanup(); }
});

test("a resume item with fork or agent is refused", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("Done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const first = await callSubagents(tool, main.ctx, "First task");
    const result = await tool.execute("call-2", { items: [{ resume: first.worker.sessionId, task: "Again", fork: true },
      { resume: first.worker.sessionId, task: "Again", agent: "reviewer" }] } as never, undefined, undefined, main.ctx);
    assert.deepEqual((result.details as SubagentsDetails).results.map((worker) => [worker.status, worker.error]),
      [["failed", "resume excludes agent and fork"], ["failed", "resume excludes agent and fork"]]);
    assert.equal(provider.requests.length, 1);
  } finally { h.cleanup(); }
});

test("a preserved agent model resumes without a second record and keeps its agent instructions", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    writeAgentDefinition(join(h.agentDir, "agents"), "reviewer.md", { name: "reviewer", description: "Reviews", model: HAIKU, tools: "read" }, "Review carefully.");
    const provider = fakeAnthropic("Done");
    const main = orchestrator(h);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const first = await callSubagents(tool, main.ctx, "First task", "reviewer");
    assert.equal(first.worker.status, "completed");
    const resumed = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.equal((resumed.details as SubagentsDetails).results[0]!.status, "completed");
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).filter((record) => record.recordType === "agent-model").length, 1);
    assert.ok(provider.requests[1]!.systemText.includes("Review carefully."));
    assert.deepEqual(provider.requests.map((request) => request.tools), [["read", "report"], ["read", "report"]]);
  } finally { h.cleanup(); }
});

test("a preserved-model ban-list exception is rechecked on resume without routed allowance preflight", async () => {
  const settings = { orchestrator: { routing: ROUTING, subagentBanList: ["haiku"], subagents: { agentDefinitionModel: { use: "preserve", allowBanned: true } } } };
  const h = harness(settings);
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    writeAgentDefinition(join(h.agentDir, "agents"), "reviewer.md", { name: "reviewer", description: "Reviews", model: HAIKU }, "Review carefully.");
    const provider = fakeAnthropic("Done");
    const main = orchestrator(h);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const first = await callSubagents(tool, main.ctx, "First task", "reviewer");
    assert.equal(first.worker.status, "completed");
    const resumed = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.equal((resumed.details as SubagentsDetails).results[0]!.status, "completed");
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ orchestrator: { ...settings.orchestrator, subagents: { agentDefinitionModel: { use: "preserve", allowBanned: false } } } }));
    const denied = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Third task" }] } as never, undefined, undefined, main.ctx);
    assert.match((denied.details as SubagentsDetails).results[0]!.error ?? "", /subagent ban list/);
    assert.equal(provider.requests.length, 2);
  } finally { h.cleanup(); }
});

test("a shadow worker resumes on the model that ran, not its hypothetical rung", async () => {
  const h = harness({ orchestrator: { routing: { ...ROUTING, mode: "shadow" } } });
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    const provider = fakeAnthropic("Done");
    const main = orchestrator(h);
    const first = await callSubagents(loadSubagentsTool([routerExtension(), provider.extension]), main.ctx, "First task");
    const second = await loadSubagentsTool([routerExtension(), provider.extension]).execute("resume", {
      items: [{ resume: first.worker.sessionId, task: "Second task" }],
    } as never, undefined, undefined, main.ctx);
    assert.equal((second.details as SubagentsDetails).results[0]!.status, "completed");
    assert.deepEqual(provider.requests.map((request) => request.thinkingLevel), ["medium", "medium"]);
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).filter((record) => record.recordType === "decision").length, 1);
  } finally { h.cleanup(); }
});

test("resume refuses unknown, not-started and other orchestrator session ids without starting a worker", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("Done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const other = orchestrator(h);
    const first = await callSubagents(tool, other.ctx, "First task");
    assert.equal(first.worker.status, "completed");
    for (const id of ["not-an-id", "00000000-0000-0000-0000-000000000000", first.worker.sessionId]) {
      const result = await tool.execute("resume", { items: [{ resume: id, task: "Second task" }] } as never, undefined, undefined, main.ctx);
      const worker = (result.details as SubagentsDetails).results[0]!;
      assert.equal(worker.status, "failed");
      assert.match(worker.error ?? "", /unknown delegation id/);
    }
    assert.equal(provider.requests.length, 1);
  } finally { h.cleanup(); }
});

test("resume refuses a saved worker without a recoverable pin and a pin now blocked by the ban list", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    const provider = fakeAnthropic("Done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const first = await callSubagents(tool, main.ctx, "First task");
    assert.equal(first.worker.status, "completed");
    const settings = { orchestrator: { routing: ROUTING, subagentBanList: ["haiku"] } };
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify(settings));
    const refused = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.match((refused.details as SubagentsDetails).results[0]!.error ?? "", /pin .*subagent ban list/);
    writeFileSync(join(h.agentDir, "settings.json"), JSON.stringify({ orchestrator: { routing: ROUTING } }));
    rmSync(join(h.stateDir, "routing"), { recursive: true });
    const missing = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.match((missing.details as SubagentsDetails).results[0]!.error ?? "", /no recoverable pin/);
    assert.equal(provider.requests.length, 1);
  } finally { h.cleanup(); }
});

test("a running worker cannot be resumed", async () => {
  const h = harness();
  try {
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const provider = fakeAnthropic("Done", (done) => { finish = done; started(); });
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const pending = callSubagents(tool, main.ctx, "First task");
    await ready;
    const id = provider.requests[0]!.sessionId!;
    const result = await tool.execute("resume", { items: [{ resume: id, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.match((result.details as SubagentsDetails).results[0]!.error ?? "", /still running/);
    finish();
    await pending;
    assert.equal(provider.requests.length, 1);
  } finally { h.cleanup(); }
});

test("a call with one task routes the worker on orchestrator/auto and returns its final text, status and session file", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("The typo is fixed.");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const { text, worker } = await callSubagents(tool, main.ctx, "Fix the typo in README.md");

    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.finalText, "The typo is fixed.");
    assert.ok(worker.sessionFile, "the worker's session is saved");
    assert.equal(relative(join(main.sessionDir, "subagents", main.sessionId), worker.sessionFile).includes("/"), false,
      `the session file is in the orchestrator's session folder, under subagents/<orchestrator session id>: ${worker.sessionFile}`);
    assert.match(text, /The typo is fixed\./);
    assert.ok(text.includes(worker.sessionFile), text);

    // orchestrator/auto resolved in the worker's own model runtime.
    const lines = sessionLines(worker.sessionFile);
    assert.equal(lines[0]?.type, "session");
    assert.equal(lines[0]?.id, worker.sessionId, "the session file belongs to the worker");
    assert.deepEqual(lines.filter((line) => line.type === "model_change").map((line) => `${line.provider}/${line.modelId}`), ["orchestrator/auto"]);

    // The router extension routed it: one live decision keyed by the worker's session id.
    const records = readRoutingRecords(join(h.stateDir, "routing"));
    assert.deepEqual(records.map((record) => record.delegationId), [worker.sessionId]);
    const [record] = records;
    assert.ok(record?.recordType === "decision");
    assert.equal(record.mode, "live");
    assert.equal(record.route.outcome === "chosen" && record.route.rung.rung, RUNG);
    assert.equal(record.ranOn, RUNG);
    assert.deepEqual(provider.requests.map((request) => request.sessionId), [worker.sessionId], "the rung got the worker's one request");
  } finally { h.cleanup(); }
});

test("the worker loads the installed extensions' tools but not the subagents tool", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("done");
    // The subagents extension is installed too, as it is in pi.
    const tool = loadSubagentsTool([routerExtension(), provider.extension, PROBE_TOOL_EXTENSION, createSubagentsExtension()]);
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Say done.");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const tools = provider.requests[0]?.tools ?? [];
    assert.ok(tools.includes("read"), JSON.stringify(tools));
    assert.ok(tools.includes("probe"), `another extension's tool reaches the worker: ${JSON.stringify(tools)}`);
    assert.equal(tools.includes("subagents"), false, JSON.stringify(tools));
  } finally { h.cleanup(); }
});

test("a final text over 50 KB is cut with a pointer to the worker's session file, which keeps the whole text", async () => {
  const h = harness();
  try {
    const long = "x".repeat(60 * 1024);
    const provider = fakeAnthropic(long);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const { text, worker } = await callSubagents(tool, orchestrator(h).ctx, "Write a lot.");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.ok(worker.sessionFile);
    assert.ok(worker.finalText.startsWith("x".repeat(MAX_TEXT_BYTES)));
    assert.equal(worker.finalText.includes("x".repeat(MAX_TEXT_BYTES + 1)), false, "no more than 50 KB of the text is kept");
    assert.ok(worker.finalText.endsWith(`The full text is in the worker's session file: ${worker.sessionFile}]`), worker.finalText.slice(-300));
    assert.ok(text.length < 51 * 1024, `the tool result stays near 50 KB: ${text.length}`);
    const saved = sessionLines(worker.sessionFile).flatMap((line) => line.message?.role === "assistant" ? line.message.content ?? [] : []);
    assert.equal(saved.map((part) => part.text ?? "").join(""), long, "the session file has the whole text");
  } finally { h.cleanup(); }
});

test("the subagents extension can be filtered out of the package on its own", async () => {
  const enabledExtensions = async (entry: unknown) => {
    const h = harness({ packages: [entry] });
    try {
      const packages = new DefaultPackageManager({ cwd: h.projectDir, agentDir: h.agentDir, settingsManager: SettingsManager.create(h.projectDir, h.agentDir) });
      const { extensions } = await packages.resolve();
      return extensions.filter((extension) => extension.enabled).map((extension) => relative(CHECKOUT, extension.path)).sort();
    } finally { h.cleanup(); }
  };
  const all = ["src/guard/extension.ts", "src/router/extension.ts", "src/subagents/extension.ts"];
  assert.deepEqual(await enabledExtensions(CHECKOUT), all);
  assert.deepEqual(await enabledExtensions({ source: CHECKOUT, extensions: ["!src/subagents/extension.ts"] }), ["src/guard/extension.ts", "src/router/extension.ts"]);
});


test("eight items with maxParallel 2 run at most two workers and return results in item order", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 2 } } });
  const pending: (() => void)[] = [];
  let peak = 0, active = 0;
  try {
    const provider = fakeAnthropic("done", (finish) => {
      active++;
      peak = Math.max(peak, active);
      pending.push(() => { active--; finish(); });
    });
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const tasks = Array.from({ length: 8 }, (_, index) => `Item ${index + 1}`);
    const call = tool.execute("call-1", { items: tasks.map((task) => ({ task })) } as never, undefined, undefined, orchestrator(h).ctx);
    for (let attempt = 0; pending.length < 2 && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(pending.length >= 2, "two workers start before either finishes");
    for (let index = 0; index < 8; index++) {
      for (let attempt = 0; pending.length === 0 && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.ok(pending.length > 0, `item ${index + 1} started`);
      pending.shift()!();
    }
    const details = (await call).details as SubagentsDetails;
    assert.deepEqual(details.results.map((result) => result.task), tasks);
    assert.deepEqual(details.results.map((result) => result.status), Array(8).fill("completed"));
    assert.deepEqual(details.results.map((result) => sessionLines(result.sessionFile!).flatMap((line) =>
      line.message?.role === "user" ? line.message.content?.map((part) => part.text) ?? [] : [])), tasks.map((task) => [task]));
    assert.equal(peak, 2);
    assert.equal(provider.requests.length, 8);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});


test("more than eight items or an empty call is refused before starting workers", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    for (const count of [0, 9]) {
      await assert.rejects(
        tool.execute("call-1", { items: Array.from({ length: count }, (_, index) => ({ task: `Item ${index}` })) } as never, undefined, undefined, orchestrator(h).ctx),
        /1 to 8 items/,
      );
    }
    assert.equal(provider.requests.length, 0);
  } finally { h.cleanup(); }
});

test("abort stops running workers and marks queued items not started", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 2 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const controller = new AbortController();
    const call = tool.execute("call-1", { items: Array.from({ length: 5 }, (_, index) => ({ task: `Item ${index + 1}` })) } as never, controller.signal, undefined, orchestrator(h).ctx);
    for (let attempt = 0; pending.length < 2 && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
    assert.equal(pending.length, 2, "two workers are running before abort");
    controller.abort();
    const details = (await call).details as SubagentsDetails;
    assert.deepEqual(details.results.map((result) => result.status), ["aborted", "aborted", "not-started", "not-started", "not-started"]);
    assert.equal(provider.requests.length, 2, "no queued worker starts");
    assert.ok(details.results[0]?.sessionId);
    assert.equal(details.results[2]?.sessionId, undefined);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("the default concurrency is four and project settings need personal permission to override it", async () => {
  for (const allowProjectOverrides of [false, true]) {
    const h = harness({ orchestrator: { routing: ROUTING, subagents: { allowProjectOverrides } } });
    const pending: (() => void)[] = [];
    try {
      mkdirSync(join(h.projectDir, ".pi"));
      writeFileSync(join(h.projectDir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { subagents: { maxParallel: 2 } } }));
      const provider = fakeAnthropic("done", (finish) => pending.push(finish));
      const tool = loadSubagentsTool([routerExtension(), provider.extension]);
      const controller = new AbortController();
      const call = tool.execute("call-1", { items: Array.from({ length: 5 }, (_, index) => ({ task: `Item ${index}` })) } as never, controller.signal, undefined, orchestrator(h).ctx);
      const expected = allowProjectOverrides ? 2 : 4;
      for (let attempt = 0; pending.length < expected && attempt < 1000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(pending.length, expected);
      controller.abort();
      const details = (await call).details as SubagentsDetails;
      assert.deepEqual(details.results.map((result) => result.status), [
        ...Array(expected).fill("aborted"), ...Array(5 - expected).fill("not-started"),
      ]);
    } finally {
      for (const finish of pending) finish();
      h.cleanup();
    }
  }
});

test("agent definitions come from the owner's and the project's agent folders, the project wins by name, and the tool description lists them at session start", async () => {
  const h = harness();
  try {
    const personalAgents = join(h.agentDir, "agents"), projectAgents = join(h.projectDir, ".pi", "agents");
    writeAgentDefinition(personalAgents, "reviewer.md", { name: "reviewer", description: "The owner's reviewer" }, "OWNER REVIEWER INSTRUCTIONS");
    writeAgentDefinition(personalAgents, "scout.md", { name: "scout", description: "Finds files fast" }, "SCOUT INSTRUCTIONS");
    writeAgentDefinition(projectAgents, "review.md", { name: "reviewer", description: "The project's reviewer" }, "PROJECT REVIEWER INSTRUCTIONS");
    writeFileSync(join(projectAgents, "notes.txt"), "not an agent definition");
    const provider = fakeAnthropic("Reviewed.");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);

    const description = subagents.tool().description;
    assert.match(description, /`agent` is optional/, description);
    assert.ok(description.includes("reviewer: The project's reviewer"), description);
    assert.ok(description.includes("scout: Finds files fast"), description);
    assert.equal(description.includes("The owner's reviewer"), false, `the project's reviewer replaces the owner's: ${description}`);

    const { worker } = await callSubagents(subagents.tool(), main.ctx, "Review the diff.", "reviewer");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.agent, "reviewer");
    const systemText = provider.requests[0]?.systemText ?? "";
    assert.ok(systemText.includes("PROJECT REVIEWER INSTRUCTIONS"), "the worker gets the project definition's instructions");
    assert.equal(systemText.includes("OWNER REVIEWER INSTRUCTIONS"), false);

    // Without an agent, the worker gets no definition's instructions.
    await callSubagents(subagents.tool(), main.ctx, "Say done.");
    assert.equal(provider.requests[1]?.systemText.includes("INSTRUCTIONS"), false, provider.requests[1]?.systemText);
  } finally { h.cleanup(); }
});

test("a definition's tools: list narrows the orchestrator's tools and cannot add one", async () => {
  const h = harness();
  try {
    // grep is a pi built-in the orchestrator does not have on.
    writeAgentDefinition(join(h.projectDir, ".pi", "agents"), "scout.md",
      { name: "scout", description: "Reads only", tools: "read, probe, grep" }, "Read, never write.");
    const provider = fakeAnthropic("done");
    const subagents = loadSubagents([routerExtension(), provider.extension, PROBE_TOOL_EXTENSION]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);

    const { worker } = await callSubagents(subagents.tool(), main.ctx, "Look around.", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual([...(provider.requests[0]?.tools ?? [])].sort(), ["probe", "read", "report"]);
  } finally { h.cleanup(); }
});

test("route mode ignores a definition's model and thinking and warns once per session", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const warnings: string[] = [];
    const ctx = { ...main.ctx, hasUI: true, ui: { notify: (message: string, level: string) => { if (level === "warning") warnings.push(message); } } } as ExtensionContext;
    const first = await callSubagents(tool, ctx, "First task", "scout");
    const second = await callSubagents(tool, ctx, "Second task", "scout");
    assert.equal(first.worker.status, "completed", JSON.stringify(first.worker));
    assert.equal(second.worker.status, "completed", JSON.stringify(second.worker));
    assert.equal(first.worker.model, undefined, "routed workers do not report a preserved model");
    assert.equal(warnings.length, 1, JSON.stringify(warnings));
    assert.match(warnings[0]!, /model.*thinking.*ignored/i);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["decision", "decision"]);
    assert.deepEqual(sessionLines(first.worker.sessionFile!).filter((line) => line.type === "model_change").map((line) => `${line.provider}/${line.modelId}`), ["orchestrator/auto"]);
    assert.notEqual(provider.requests[0]?.thinkingLevel, "high");
  } finally { h.cleanup(); }
});

test("preserve mode uses the named model and effort without routing and records its definition", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    const file = join(h.agentDir, "agents", "scout.md");
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.model, HAIKU, "the result details expose the preserved provider/model to the renderer");
    assert.equal(worker.banListException, undefined);
    assert.deepEqual(sessionLines(worker.sessionFile!).filter((line) => line.type === "model_change").map((line) => `${line.provider}/${line.modelId}`), [HAIKU]);
    assert.equal(provider.requests[0]?.thinkingLevel, "high");
    const records = readRoutingRecords(join(h.stateDir, "routing"));
    assert.equal(records.length, 1, "preserved models do not produce router decisions");
    const [record] = records;
    assert.ok(record?.recordType === "agent-model");
    assert.equal(record.schemaVersion, "decision-record/3");
    assert.equal(record.delegationId, worker.sessionId);
    assert.ok(Number.isFinite(Date.parse(record.timestamp)));
    assert.equal(record.agent, "scout");
    assert.equal(record.definitionFile, file);
    assert.equal(record.model, HAIKU);
    assert.equal(record.effort, "high");
    assert.equal(record.banListException, undefined);
    assert.equal(process.env.PI_ORCHESTRATOR_SESSION_MODEL, `${HAIKU}:medium`, "the worker's model is not remembered as the orchestrator's session model");
  } finally { h.cleanup(); }
});

test("preserve mode runs a named model whose id has a slash after the provider", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    const VENDOR_HAIKU = "anthropic/vendor/claude-haiku-4-5";
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", model: `${VENDOR_HAIKU}:high` }, "Find files.");
    const provider = fakeAnthropic("done", undefined, ["claude-haiku-4-5", "vendor/claude-haiku-4-5"]);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.model, VENDOR_HAIKU);
    assert.deepEqual(provider.requests.map((request) => [request.model, request.thinkingLevel]), [[VENDOR_HAIKU, "high"]]);
  } finally { h.cleanup(); }
});

test("preserve mode still routes definitions without a model, and ignores project model settings", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", thinking: "high" }, "Find files.");
    mkdirSync(join(h.projectDir, ".pi"));
    writeFileSync(join(h.projectDir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { subagents: { agentDefinitionModel: { use: "route" } } } }));
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["decision"]);
    assert.deepEqual(sessionLines(worker.sessionFile!).filter((line) => line.type === "model_change").map((line) => `${line.provider}/${line.modelId}`), ["orchestrator/auto"]);
  } finally { h.cleanup(); }
});

test("preserve mode refuses a definition's banned model before starting a worker", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagentBanList: ["haiku"], subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU }, "Find files.");
    const provider = fakeAnthropic("done");
    const { worker } = await callSubagents(loadSubagentsTool([routerExtension(), provider.extension]), orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "failed");
    assert.equal(worker.sessionId, undefined);
    assert.match(worker.error ?? "", /subagent ban list/);
    assert.deepEqual(provider.requests, []);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")), []);
  } finally { h.cleanup(); }
});

/** The guard extension as the worker loads it. */
const GUARD_EXTENSION: InlineExtension = { name: "guard", factory: personalGuard };

/** Personal settings that ban haiku for workers and preserve definition
 *  models, with allowBanned and allowProjectOverrides as given. */
function exceptionSettings(allowBanned: boolean, allowProjectOverrides = false) {
  return { orchestrator: { routing: ROUTING, subagentBanList: ["haiku"],
    subagents: { allowProjectOverrides, agentDefinitionModel: { use: "preserve", allowBanned } } } };
}

test("a personal definition's banned model runs only with allowBanned on, past the guard and the router, and records the exception", async () => {
  for (const allowBanned of [false, true]) {
    const h = harness(exceptionSettings(allowBanned));
    try {
      const file = join(h.agentDir, "agents", "scout.md");
      writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
      const provider = fakeAnthropic("done");
      const tool = loadSubagentsTool([GUARD_EXTENSION, routerExtension(), provider.extension]);
      const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
      if (!allowBanned) {
        assert.equal(worker.status, "failed");
        assert.equal(worker.sessionId, undefined);
        assert.match(worker.error ?? "", /subagent ban list/);
        assert.deepEqual(provider.requests, []);
        assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")), []);
        continue;
      }
      assert.equal(worker.status, "completed", JSON.stringify(worker));
      assert.equal(worker.model, HAIKU);
      assert.equal(worker.banListException, true, "the result details mark the exception for the renderer");
      assert.deepEqual(provider.requests.map((request) => request.sessionId), [worker.sessionId], "neither the guard nor the router stopped the request");
      const records = readRoutingRecords(join(h.stateDir, "routing"));
      assert.equal(records.length, 1);
      assert.deepEqual(records[0], { recordType: "agent-model", schemaVersion: "decision-record/3", delegationId: worker.sessionId,
        timestamp: records[0]?.timestamp, agent: "scout", definitionFile: file, model: HAIKU, effort: "high", banListException: true });
    } finally { h.cleanup(); }
  }
});

test("the session ban list does not bind a worker, which is not the orchestrator's session", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, sessionBanList: ["haiku"], subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", model: HAIKU }, "Find files.");
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([GUARD_EXTENSION, routerExtension(), provider.extension]);
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual(provider.requests.map((request) => request.sessionId), [worker.sessionId], "the guard let the worker's request through");
  } finally { h.cleanup(); }
});

test("a project definition's banned model runs only with allowBanned and allowProjectOverrides on", async () => {
  for (const [allowBanned, allowProjectOverrides] of [[true, false], [false, true], [true, true]] as const) {
    const h = harness(exceptionSettings(allowBanned, allowProjectOverrides));
    try {
      writeAgentDefinition(join(h.projectDir, ".pi", "agents"), "scout.md", { name: "scout", description: "Scouts", model: HAIKU }, "Find files.");
      const provider = fakeAnthropic("done");
      const tool = loadSubagentsTool([GUARD_EXTENSION, routerExtension(), provider.extension]);
      const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files", "scout");
      const flags = JSON.stringify({ allowBanned, allowProjectOverrides });
      if (!(allowBanned && allowProjectOverrides)) {
        assert.equal(worker.status, "failed", flags);
        assert.match(worker.error ?? "", /subagent ban list/, flags);
        assert.deepEqual(provider.requests, [], flags);
        continue;
      }
      assert.equal(worker.status, "completed", JSON.stringify(worker));
      assert.equal(worker.banListException, true);
      assert.equal(provider.requests.length, 1);
      const records = readRoutingRecords(join(h.stateDir, "routing"));
      assert.ok(records.length === 1 && records[0]?.recordType === "agent-model", JSON.stringify(records));
      assert.equal(records[0].definitionFile, join(h.projectDir, ".pi", "agents", "scout.md"));
      assert.equal(records[0].banListException, true);
    } finally { h.cleanup(); }
  }
});

test("with the exception on, the tier map and tool calls still refuse the banned model", async () => {
  const SONNET = "anthropic/claude-sonnet-4-5";
  const settings = exceptionSettings(true, true);
  const tiers = { mechanical: [RUNG, `${SONNET}:low`], standard: [`${SONNET}:low`], elevated: [`${SONNET}:low`], critical: [`${SONNET}:low`] };
  const h = harness({ orchestrator: { ...settings.orchestrator, routing: { ...ROUTING, classifier: { ...ROUTING.classifier, model: `${SONNET}:low` }, tiers } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", model: HAIKU }, "Find files.");
    const provider = fakeAnthropic("done", undefined, ["claude-haiku-4-5", "claude-sonnet-4-5"]);
    const tool = loadSubagentsTool([GUARD_EXTENSION, routerExtension([HAIKU, SONNET]), provider.extension]);

    // The tier map path: the banned rung is dropped, and a routed worker runs on the other.
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Find files");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.banListException, undefined);
    assert.deepEqual(provider.requests.map((request) => request.model), [SONNET]);
    const [record] = readRoutingRecords(join(h.stateDir, "routing"));
    assert.ok(record?.recordType === "decision", JSON.stringify(record));
    assert.equal(record.ranOn, `${SONNET}:low`);
    assert.deepEqual(record.tierMap.drops, [{ tier: "mechanical", rung: RUNG, origin: "personal", reason: "subagent ban list" }]);

    // The tool-call path: the guard refuses a delegation tool call naming the banned model.
    const guard = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    personalGuard({ on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { guard.set(event, handler); } } as unknown as ExtensionAPI);
    const refusal = await guard.get("tool_call")!({ type: "tool_call", toolCallId: "1", toolName: "subagent", input: { agent: "scout", task: "Find files", model: HAIKU } },
      { cwd: h.projectDir, hasUI: false });
    assert.deepEqual(refusal, { block: true, reason: `pi-orchestrator guard: prohibited model: ${HAIKU}` });
  } finally { h.cleanup(); }
});

test("route mode with allowBanned on warns once per session that it has no effect", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "route", allowBanned: true } } } });
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const warnings: string[] = [];
    const ctx = { ...main.ctx, hasUI: true, ui: { notify: (message: string, level: string) => { if (level === "warning") warnings.push(message); } } } as ExtensionContext;
    const first = await callSubagents(tool, ctx, "First task");
    const second = await callSubagents(tool, ctx, "Second task");
    assert.deepEqual([first.worker.status, second.worker.status], ["completed", "completed"]);
    assert.deepEqual(warnings, ["pi-orchestrator subagents: agentDefinitionModel.allowBanned has no effect under route mode"]);
  } finally { h.cleanup(); }
});

test("project settings cannot enable preserve mode for a named definition", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.projectDir, ".pi", "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    writeFileSync(join(h.projectDir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { subagents: { agentDefinitionModel: { use: "preserve" } } } }));
    const provider = fakeAnthropic("done");
    const { worker } = await callSubagents(loadSubagentsTool([routerExtension(), provider.extension]), orchestrator(h).ctx, "Find files", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["decision"]);
  } finally { h.cleanup(); }
});

/** Runs `body` with stderr captured, and returns the captured lines. */
async function stderrLines(body: () => Promise<void>): Promise<string[]> {
  const original = process.stderr.write;
  let output = "";
  process.stderr.write = ((chunk: string | Uint8Array) => { output += String(chunk); return true; }) as typeof process.stderr.write;
  try { await body(); } finally { process.stderr.write = original; }
  return output.split("\n");
}

/** Runs `body` with stderr captured, and returns the subagents extension's
 *  lines about ignored project settings keys. */
async function ignoredKeysLog(body: () => Promise<void>): Promise<string[]> {
  return (await stderrLines(body)).filter((line) => line.startsWith("pi-orchestrator subagents: ignored project settings key"));
}

test("a worker does not print the fresh-install notice, which is the orchestrator's", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    let worker: SubagentsDetails["results"][number] | undefined;
    const lines = await stderrLines(async () => { worker = (await callSubagents(tool, orchestrator(h).ctx, "Say done.")).worker; });
    assert.equal(worker?.status, "completed", JSON.stringify(worker));
    assert.deepEqual(lines.filter((line) => line.startsWith("pi-orchestrator: not set up")), [],
      "the state folder has no approved recipients, which the orchestrator's session would report");
  } finally { h.cleanup(); }
});

test("without allowProjectOverrides a project's subagents keys are ignored and each is logged once", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: {} } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    mkdirSync(join(h.projectDir, ".pi"));
    writeFileSync(join(h.projectDir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { subagents: {
      maxParallel: 1, agentDefinitionModel: { use: "preserve" }, allowProjectOverrides: true,
    } } }));
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const workers: SubagentsDetails["results"][number][] = [];
    const log = await ignoredKeysLog(async () => {
      workers.push((await callSubagents(tool, ctx, "First task", "scout")).worker);
      workers.push((await callSubagents(tool, ctx, "Second task", "scout")).worker);
    });
    assert.deepEqual(workers.map((worker) => worker.status), ["completed", "completed"], JSON.stringify(workers));
    assert.deepEqual(workers.map((worker) => worker.model), [undefined, undefined], "the project's preserve mode is ignored");
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["decision", "decision"]);
    assert.deepEqual(log, [
      "pi-orchestrator subagents: ignored project settings key orchestrator.subagents.maxParallel",
      "pi-orchestrator subagents: ignored project settings key orchestrator.subagents.agentDefinitionModel",
      "pi-orchestrator subagents: ignored project settings key orchestrator.subagents.allowProjectOverrides",
    ]);
  } finally { h.cleanup(); }
});

test("with allowProjectOverrides a project's subagents keys apply, and a project value for the flag itself is ignored and logged", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { allowProjectOverrides: true, agentDefinitionModel: { use: "route" } } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md",
      { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    mkdirSync(join(h.projectDir, ".pi"));
    writeFileSync(join(h.projectDir, ".pi", "settings.json"), JSON.stringify({ orchestrator: { subagents: {
      agentDefinitionModel: { use: "preserve" }, allowProjectOverrides: false,
    } } }));
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const workers: SubagentsDetails["results"][number][] = [];
    const log = await ignoredKeysLog(async () => {
      workers.push((await callSubagents(tool, ctx, "First task", "scout")).worker);
      workers.push((await callSubagents(tool, ctx, "Second task", "scout")).worker);
    });
    assert.deepEqual(workers.map((worker) => worker.status), ["completed", "completed"], JSON.stringify(workers));
    assert.deepEqual(workers.map((worker) => worker.model), [HAIKU, HAIKU], "the project's preserve mode applies");
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["agent-model", "agent-model"]);
    assert.deepEqual(log, ["pi-orchestrator subagents: ignored project settings key orchestrator.subagents.allowProjectOverrides"]);
  } finally { h.cleanup(); }
});

test("an unknown agent name fails the item with a reason, and no worker starts", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Finds files fast" }, "Find files.");
    const provider = fakeAnthropic("done");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);

    const { text, worker } = await callSubagents(subagents.tool(), main.ctx, "Review the diff.", "reviewr");
    assert.equal(worker.status, "failed");
    assert.equal(worker.sessionId, undefined, "no worker session was started");
    assert.match(worker.error ?? "", /unknown agent "reviewr".*scout/, worker.error);
    assert.ok(text.includes(worker.error!), text);
    assert.deepEqual(provider.requests, []);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")), []);
  } finally { h.cleanup(); }
});

test("an unknown agent fails only its own item, and the call's other items still run", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Finds files fast" }, "Find files.");
    const provider = fakeAnthropic("done");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);

    const items = [{ task: "Item 1" }, { task: "Item 2", agent: "reviewr" }, { task: "Item 3", agent: "scout" }];
    const result = await subagents.tool().execute("call-1", { items } as never, undefined, undefined, main.ctx);
    const details = result.details as SubagentsDetails;
    assert.deepEqual(details.results.map((item) => item.task), ["Item 1", "Item 2", "Item 3"]);
    assert.deepEqual(details.results.map((item) => item.status), ["completed", "failed", "completed"], JSON.stringify(details.results));
    assert.equal(details.results[1]?.agent, "reviewr");
    assert.equal(details.results[1]?.sessionId, undefined, "no worker session was started for the unknown agent");
    assert.match(details.results[1]?.error ?? "", /unknown agent "reviewr".*scout/);
    assert.ok(details.results[0]?.sessionId && details.results[2]?.sessionId);
    assert.equal(provider.requests.length, 2, "only the two resolvable items start workers");
    const text = result.content.map((part) => part.type === "text" ? part.text : "").join("");
    assert.ok(text.includes(details.results[1]!.error!), text);
  } finally { h.cleanup(); }
});

/** A fake `anthropic` provider whose worker first calls the probe tool, then
 *  replies "done" once the tool's result is in its context. */
function probeCallingAnthropic(): InlineExtension {
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
    streamSimple(model, context) {
      const probed = context.messages.some((message) => message.role === "toolResult");
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: probed ? [{ type: "text", text: "done" }] : [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: probed ? "stop" : "toolUse", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      push({ type: "done", reason: message.stopReason, message } as never);
      end({ api: model.api, provider: model.provider, model: model.id });
      return stream;
    },
  };
  return { name: "fake-anthropic", factory: (pi) => pi.registerProvider("anthropic", config) };
}

test("while a call runs, partial updates show each item queued, running with its worker's current tool, then finished", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  try {
    const tool = loadSubagentsTool([routerExtension(), probeCallingAnthropic(), PROBE_TOOL_EXTENSION]);
    const updates: SubagentsProgressDetails[] = [];
    const items = [{ task: "Probe once" }, { task: "Probe again", agent: "reviewr" }, { task: "Probe last" }];
    const result = await tool.execute("call-1", { items } as never, undefined,
      (update) => { updates.push(update.details as SubagentsProgressDetails); }, orchestrator(h).ctx);
    const final = result.details as SubagentsDetails;
    assert.deepEqual(final.results.map((item) => item.status), ["completed", "failed", "completed"], JSON.stringify(final.results));

    const states = updates.map((update) => update.results.map((item) =>
      item.status === "running" && item.tool !== undefined ? `running: ${item.tool}` : item.status).join(", "));
    assert.equal(states[0], "queued, queued, queued", "the first update shows every item queued");
    const seen = (state: string) => assert.ok(states.includes(state), `${state} in ${JSON.stringify(states, null, 1)}`);
    seen("running, queued, queued");
    seen("running: probe, queued, queued");
    seen("completed, failed, running: probe");
    assert.equal(states.at(-1), "completed, failed, completed");
    assert.ok(updates.every((update) => update.results.map((item) => item.task).join() === items.map((item) => item.task).join()), "updates keep item order");
    assert.equal(updates.at(-1)?.results[1]?.agent, "reviewr");
  } finally { h.cleanup(); }
});

test("a fork copies the current branch before the delegating call and keeps the call-time rung", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("Fork complete.", undefined, ["claude-haiku-4-5", "claude-sonnet-5"]);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Current branch only", timestamp: Date.now() });
    const branchPoint = parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Keep this reply" }], stopReason: "stop", timestamp: Date.now() } as never);
    parent.appendMessage({ role: "user", content: "Abandoned branch", timestamp: Date.now() });
    parent.branch(branchPoint);
    parent.appendMessage({ role: "user", content: "Latest branch", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "text", text: "Delegating call" }, { type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Finish", fork: true }] } as never, undefined, undefined, ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.model, HAIKU);
    assert.ok(worker.sessionFile);
    assert.equal(provider.requests.length, 1, "the fork does not route");
    assert.equal(provider.requests[0]?.model, HAIKU);
    assert.equal(provider.requests[0]?.thinkingLevel, "high");
    assert.equal(provider.requests[0]?.tools.includes("subagents"), false, "forks cannot delegate");
    assert.match(provider.requests[0]!.messages.join(" "), /Latest branch/);
    assert.doesNotMatch(provider.requests[0]!.messages.join(" "), /Abandoned branch|Delegating call/);
    assert.equal(sessionLines(worker.sessionFile).some((entry) => entry.id === branchPoint), true);
    const records = readRoutingRecords(join(h.stateDir, "routing"));
    assert.equal(records.length, 1);
    assert.equal(records[0]?.recordType, "fork");
    assert.equal(records[0]?.delegationId, worker.sessionId);
    assert.deepEqual(records[0], {
      recordType: "fork", schemaVersion: "decision-record/3", delegationId: worker.sessionId,
      timestamp: (records[0] as { timestamp: string }).timestamp,
      model: HAIKU, effort: "high", parentSession: parent.getSessionId(),
      forkPoint: parent.getBranch().at(-2)?.id, banListException: false,
    });
    const verdict = attachVerdict({ recordDir: join(h.stateDir, "routing"), delegationId: worker.sessionId, verdict: "accept",
      refreshStatePath: join(h.stateDir, "refresh-state.json") });
    assert.equal(verdict.status, "attached");
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["fork", "verdict"]);
  } finally { h.cleanup(); }
});

test("a fork on a subagent-banned session model remains unrouted and records its exemption", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagentBanList: ["haiku"] } });
  try {
    const provider = fakeAnthropic("Allowed fork.");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Review", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "medium" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Review", fork: true }] } as never, undefined, undefined, ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.banListException, true);
    assert.equal(provider.requests[0]?.model, HAIKU);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["fork"]);
    const record = readRoutingRecords(join(h.stateDir, "routing"))[0]!;
    assert.equal(record.recordType === "fork" && record.banListException, true);
  } finally { h.cleanup(); }
});

test("a fork with an agent applies its instructions and narrowed tools but not the definition's model", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "reviewer.md",
      { name: "reviewer", description: "Reviews", tools: "read", model: "anthropic/claude-sonnet-5", thinking: "low" }, "Review carefully.");
    const provider = fakeAnthropic("Reviewed.", undefined, ["claude-haiku-4-5", "claude-sonnet-5"]);
    const tool = loadSubagentsTool([routerExtension(), provider.extension, PROBE_TOOL_EXTENSION]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Review", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Review", agent: "reviewer", fork: true }] } as never, undefined, undefined, ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(provider.requests[0]?.model, HAIKU);
    assert.equal(provider.requests[0]?.thinkingLevel, "high");
    assert.match(provider.requests[0]!.systemText, /Review carefully/);
    assert.deepEqual(provider.requests[0]?.tools, ["read", "report"]);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["fork"]);
  } finally { h.cleanup(); }
});

test("queued forks keep their call-time rung when the session switches model; ordinary items still route", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  try {
    let finishFirst: (() => void) | undefined;
    const provider = fakeAnthropic("Done.", (finish) => { if (finishFirst === undefined) finishFirst = finish; else finish(); },
      ["claude-haiku-4-5", "claude-sonnet-5"]);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Delegate", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const pending = tool.execute("fork-call", { items: [{ task: "First", fork: true }, { task: "Second", fork: true }, { task: "Ordinary" }] } as never,
      undefined, undefined, ctx);
    for (let attempt = 0; attempt < 100 && finishFirst === undefined; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.ok(finishFirst, "first fork reached the provider");
    (ctx as { model: unknown }).model = { provider: "anthropic", id: "claude-sonnet-5" };
    (ctx as { thinkingLevel: string }).thinkingLevel = "low";
    finishFirst();
    const result = await pending;
    const workers = (result.details as SubagentsDetails).results;
    assert.deepEqual(workers.map((worker) => worker.status), ["completed", "completed", "completed"]);
    assert.deepEqual(workers.map((worker) => worker.model), [HAIKU, HAIKU, undefined]);
    assert.equal(provider.requests[1]?.model, HAIKU);
    assert.equal(provider.requests[1]?.thinkingLevel, "high");
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType), ["fork", "fork", "decision"]);
  } finally { h.cleanup(); }
});

test("a fork from an unsaved parent keeps the branch in memory", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("Done.");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const parent = SessionManager.inMemory(h.projectDir);
    parent.appendMessage({ role: "user", content: "Earlier turn", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "off" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Finish", fork: true }] } as never, undefined, undefined, ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.sessionFile, undefined);
    assert.match(provider.requests[0]!.messages.join(" "), /Earlier turn/);
  } finally { h.cleanup(); }
});

/** One request a scripted provider got: whose it was, what it offered and what it had seen. */
interface ScriptedRequest {
  readonly sessionId: string | undefined;
  /** The first user message: the worker's task. */
  readonly task: string;
  readonly tools: readonly string[];
  /** The tool results in the request's context, in order. */
  readonly toolResults: readonly { readonly text: string; readonly isError: boolean }[];
  readonly userMessages: readonly string[];
}

/** What a scripted provider answers: a final text, or one tool call, which a text may come before. */
type ScriptedReply = { readonly text: string } | { readonly text?: string; readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> } };

/** A fake `anthropic` provider serving claude-haiku-4-5 offline, answering each
 *  request with what `script` returns for it. */
function scriptedAnthropic(script: (request: ScriptedRequest) => ScriptedReply) {
  const requests: ScriptedRequest[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
    streamSimple(model, context, options) {
      const tools = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      }
      const text = (content: string | readonly { type: string; text?: string }[]) =>
        typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
      const firstUser = context.messages.find((message) => message.role === "user");
      const request: ScriptedRequest = {
        sessionId: options?.sessionId, task: firstUser ? text(firstUser.content) : "", tools: [...tools],
        toolResults: context.messages.flatMap((message) => message.role === "toolResult" ? [{ text: text(message.content), isError: message.isError }] : []),
        userMessages: context.messages.flatMap((message) => message.role === "user" ? [text(message.content)] : []),
      };
      requests.push(request);
      const reply = script(request);
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [...(reply.text === undefined ? [] : [{ type: "text", text: reply.text }]),
          ...("toolCall" in reply ? [{ type: "toolCall", id: `call-${requests.length}`, name: reply.toolCall.name, arguments: reply.toolCall.arguments }] : [])],
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "toolCall" in reply ? "toolUse" : "stop", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      push({ type: "done", reason: message.stopReason, message } as never);
      end({ api: model.api, provider: model.provider, model: model.id });
      return stream;
    },
  };
  const extension: InlineExtension = { name: "fake-anthropic", factory: (pi) => pi.registerProvider("anthropic", config) };
  return { extension, requests };
}

/** A worker whose task starts with "Delegate:" calls subagents once with the
 *  rest of its task as one item (`{ "task": ..., "agent": ... }` as JSON), and
 *  reports the tool result it got; any other worker says "leaf done". */
function delegatingScript(request: ScriptedRequest): ScriptedReply {
  if (!request.task.startsWith("Delegate:")) return { text: "leaf done" };
  const [result] = request.toolResults;
  if (result) return { text: `${result.isError ? "refused" : "delegated"}: ${result.text}` };
  return { toolCall: { name: "subagents", arguments: JSON.parse(request.task.slice("Delegate:".length)) as Record<string, unknown> } };
}

/** The extensions a worker loads when the subagents extension is installed:
 *  the router, `provider` and the subagents extension, whose own workers load
 *  the same set again. */
function installedWithSubagents(provider: InlineExtension, depth = 3): InlineExtension[] {
  const base = [routerExtension(), provider];
  if (depth === 0) return base;
  return [...base, { name: "subagents", factory: createSubagentsExtension({ workerExtensions: installedWithSubagents(provider, depth - 1) }) }];
}

test("a worker gets the subagents tool only when its agent definition lists it, and can then delegate", async () => {
  const h = harness();
  try {
    const agents = join(h.agentDir, "agents");
    writeAgentDefinition(agents, "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents, subagents_message" }, "Split the work.");
    writeAgentDefinition(agents, "scout.md", { name: "scout", description: "Reads only", tools: "read" }, "Read, never write.");
    const provider = scriptedAnthropic(delegatingScript);
    const tool = loadSubagentsTool(installedWithSubagents(provider.extension));
    const main = orchestrator(h);

    const withoutTool = await callSubagents(tool, main.ctx, "Look around.", "scout");
    assert.equal(withoutTool.worker.status, "completed", JSON.stringify(withoutTool.worker));
    assert.deepEqual(provider.requests.find((request) => request.sessionId === withoutTool.worker.sessionId)?.tools, ["read", "report"]);

    const { worker } = await callSubagents(tool, main.ctx, `Delegate:${JSON.stringify({ items: [{ task: "Find the config file" }] })}`, "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const leadRequests = provider.requests.filter((request) => request.sessionId === worker.sessionId);
    assert.deepEqual([...(leadRequests[0]?.tools ?? [])].sort(), ["read", "report", "subagents"]);
    const nested = provider.requests.filter((request) => request.task === "Find the config file");
    assert.equal(nested.length, 1, "the lead's subagents call started one worker");
    assert.notEqual(nested[0]?.sessionId, worker.sessionId);
    assert.match(worker.finalText, /^delegated: Worker \S+ completed\./, worker.finalText);
    assert.match(worker.finalText, /leaf done/);
  } finally { h.cleanup(); }
});

test("a nested worker cannot delegate further, and cannot start a background call", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript);
    const tool = loadSubagentsTool(installedWithSubagents(provider.extension));
    const main = orchestrator(h);

    // The lead hands a nested lead a task that would delegate once more.
    const tooDeep = `Delegate:${JSON.stringify({ items: [{ task: "Too deep" }] })}`;
    const { worker } = await callSubagents(tool, main.ctx, `Delegate:${JSON.stringify({ items: [{ task: tooDeep, agent: "lead" }] })}`, "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const nestedLead = provider.requests.filter((request) => request.task === tooDeep);
    assert.ok(nestedLead.length > 0, "the nested lead ran");
    assert.deepEqual(nestedLead[0]?.tools, ["read", "report"], "the nested lead has no subagents tool although its definition lists it");
    assert.equal(nestedLead.at(-1)?.toolResults[0]?.isError, true, "its subagents call failed");
    assert.deepEqual(provider.requests.filter((request) => request.task === "Too deep"), [], "no worker started two levels down");

    const background = await callSubagents(tool, main.ctx, `Delegate:${JSON.stringify({ items: [{ task: "Run in the background" }], background: true })}`, "lead");
    assert.equal(background.worker.status, "completed", JSON.stringify(background.worker));
    assert.match(background.worker.finalText, /^refused: .*background/s, background.worker.finalText);
    assert.deepEqual(provider.requests.filter((request) => request.task === "Run in the background"), [], "the background call started no worker");
  } finally { h.cleanup(); }
});

test("a worker's subagents call that asks for background is refused before any worker starts", async () => {
  const h = harness();
  const main = orchestrator(h);
  // The call comes from a worker's session, as the lead's did above; pi's schema check is passed by, as a background-capable schema would.
  const unmark = markWorkerSession(main.sessionId);
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    await assert.rejects(tool.execute("call-1", { items: [{ task: "Run in the background" }], background: true } as never, undefined, undefined, main.ctx),
      /a worker's subagents calls run in the foreground only/);
    assert.deepEqual(provider.requests, []);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")), []);
  } finally {
    unmark();
    h.cleanup();
  }
});

/** Waits, a millisecond at a time, until `condition` holds. */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let attempt = 0; !condition() && attempt < 2000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(condition(), `timed out waiting until ${what}`);
}

function toolText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
}

/** The background call's return value: its call id and its items' delegation ids. */
interface BackgroundStart {
  readonly callId: string;
  readonly delegationIds: readonly string[];
}

/** A completion notice's details: the call id and the same results a foreground call returns. */
type NoticeDetails = SubagentsDetails & { readonly callId: string };

test("a background call returns its call id and delegation ids at once, and one completion notice follows when all its items finish", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const items = [{ task: "Item 1" }, { task: "Item 2" }];
    const first = await subagents.tool().execute("call-1", { items, background: true } as never, undefined, undefined, ctx);
    const second = await subagents.tool().execute("call-2", { items, background: true } as never, undefined, undefined, ctx);
    const starts = [first, second].map((result) => result.details as BackgroundStart);
    assert.deepEqual(starts.map((start) => start.callId), ["call-1", "call-2"]);
    const ids = starts.flatMap((start) => start.delegationIds);
    assert.equal(new Set(ids).size, 4, JSON.stringify(ids));
    for (const [index, result] of [first, second].entries()) {
      const text = toolText(result);
      assert.ok(text.includes(`call-${index + 1}`) && starts[index]!.delegationIds.every((id) => text.includes(id)), text);
    }
    assert.equal(subagents.messages.length, 0, "no notice before the items finish");

    // Each call keeps its own maxParallel of 1: one worker per call runs.
    await waitFor(() => pending.length === 2, "each call starts one worker");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pending.length, 2, "no call runs a second worker at once");
    while (subagents.messages.length < 2) {
      await waitFor(() => pending.length > 0 || subagents.messages.length === 2, "a worker is waiting or both notices are in");
      pending.shift()?.();
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subagents.messages.length, 2, "one notice per call");

    for (const [index, { message, options }] of subagents.messages.entries()) {
      assert.deepEqual(options, { triggerTurn: true, deliverAs: "followUp" }, "a follow-up that starts a turn when idle");
      assert.equal(message.display, true);
      const details = message.details as NoticeDetails;
      const callId = details.callId;
      const start = starts.find((candidate) => candidate.callId === callId);
      assert.ok(start, `notice ${index} names a started call: ${callId}`);
      assert.deepEqual(details.results.map((result) => result.status), ["completed", "completed"]);
      assert.deepEqual(details.results.map((result) => result.sessionId), start.delegationIds, "the delegation ids given at the start are the workers' session ids");
      const text = message.content;
      assert.ok(typeof text === "string", "the notice's content is its text");
      assert.ok(text.includes(callId), text);
      for (const result of details.results) {
        assert.ok(text.includes(`Worker ${result.sessionId} completed.\nSession file: ${result.sessionFile}\n\ndone`), `the foreground result text: ${text}`);
      }
    }
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("subagents_message delivers steer and followUp to a running background worker", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => {
      if (provider.requests.length === 1 || provider.requests.length === 3) pending.push(finish);
      else finish();
    });
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    for (const [index, mode] of ["steer", "followUp"].entries()) {
      const start = (await subagents.tool().execute(`call-${index}`, { items: [{ task: `Task ${index}` }], background: true } as never,
        undefined, undefined, ctx)).details as BackgroundStart;
      await waitFor(() => pending.length === 1, "the worker's current request");
      const response = await subagents.tool("subagents_message").execute(`message-${index}`,
        { id: start.delegationIds[0], text: `${mode} instruction`, ...(index === 0 ? {} : { mode }) } as never, undefined, undefined, ctx);
      assert.match(toolText(response), new RegExp(mode));
      pending.shift()!();
      await waitFor(() => subagents.messages.length === index + 1, "the worker's completion notice");
      assert.equal(provider.requests[index * 2 + 1]?.sessionId, start.delegationIds[0]);
      assert.match(provider.requests[index * 2 + 1]!.messages.join(" "), new RegExp(`${mode} instruction`));
      assert.equal((subagents.messages[index]!.message.details as NoticeDetails).results[0]?.status, "completed");
    }
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("steer waits for the current tool call and followUp waits until the worker would stop", async () => {
  const h = harness();
  let releaseTool!: () => void;
  let toolStarted!: () => void;
  const toolRunning = new Promise<void>((resolve) => { toolStarted = resolve; });
  const toolFinished = new Promise<void>((resolve) => { releaseTool = resolve; });
  try {
    const probe: InlineExtension = { name: "blocking-probe", factory: (pi) => pi.registerTool({
      name: "probe", label: "Probe", description: "Wait for release", parameters: { type: "object", properties: {} } as Tool["parameters"],
      async execute() { toolStarted(); await toolFinished; return { content: [{ type: "text", text: "tool finished" }], details: undefined }; },
    }) };
    const provider = scriptedAnthropic((request) => {
      if (request.toolResults.length === 0) return { toolCall: { name: "probe", arguments: {} } };
      return { text: request.userMessages.includes("follow later") ? "follow-up received" : "steer received" };
    });
    const subagents = loadSubagents([routerExtension(), provider.extension, probe]);
    const ctx = orchestrator(h).ctx;
    const start = (await subagents.tool().execute("call", { items: [{ task: "Use probe" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    await toolRunning;
    const send = (text: string, mode: string) => subagents.tool("subagents_message").execute(`send-${mode}`,
      { id: start.delegationIds[0], text, mode } as never, undefined, undefined, ctx);
    await send("steer now", "steer");
    await send("follow later", "followUp");
    assert.equal(provider.requests.length, 1, "neither message interrupts a tool");
    releaseTool();
    await waitFor(() => subagents.messages.length === 1, "the worker processes both messages");
    assert.deepEqual(provider.requests.map((request) => request.userMessages),
      [["Use probe"], ["Use probe", "steer now"], ["Use probe", "steer now", "follow later"]]);
    assert.equal((subagents.messages[0]!.message.details as NoticeDetails).results[0]?.finalText, "follow-up received");
  } finally { releaseTool?.(); h.cleanup(); }
});

test("subagents_message refuses finished, foreground, and unknown delegation ids", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const start = (await subagents.tool().execute("call", { items: [{ task: "Background" }, { task: "Queued" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    await waitFor(() => pending.length === 1, "background worker starts");
    const message = (id: string) => subagents.tool("subagents_message").execute("message", { id, text: "Look here" } as never, undefined, undefined, ctx);
    await assert.rejects(message("unknown"), /no running background worker/i);
    await assert.rejects(message("call"), /no running background worker/i);
    await assert.rejects(message(start.delegationIds[1]!), /no running background worker/i);
    pending.shift()!();
    await waitFor(() => pending.length === 1, "queued background worker starts");
    await assert.rejects(message(start.delegationIds[0]!), /no running background worker/i);
    pending.shift()!();
    await waitFor(() => subagents.messages.length === 1, "background call finishes");
    await assert.rejects(message(start.delegationIds[0]!), /no running background worker/i);
    const foreground = subagents.tool().execute("foreground", { items: [{ task: "Foreground" }] } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 1, "foreground worker starts");
    const foregroundId = provider.requests.at(-1)!.sessionId!;
    await assert.rejects(message(foregroundId), /no running background worker/i);
    pending.shift()!();
    await foreground;
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("a worker's subagents call with a fork item is refused before any worker starts", async () => {
  const h = harness();
  const main = orchestrator(h);
  const unmark = markWorkerSession(main.sessionId);
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    await assert.rejects(tool.execute("call-1", { items: [{ task: "Plain" }, { task: "Continue me", fork: true }] } as never, undefined, undefined, main.ctx),
      /a worker's subagents calls cannot fork/);
    assert.deepEqual(provider.requests, []);
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")), []);
  } finally {
    unmark();
    h.cleanup();
  }
});

test("a background fork's delegation id is its copied session's id and its fork record's key", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("Fork done.");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Keep this context", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const start = (await subagents.tool().execute("fork-call", { items: [{ task: "Go on", fork: true }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    await waitFor(() => subagents.messages.length === 1, "the notice is in");
    const [worker] = (subagents.messages[0]!.message.details as NoticeDetails).results;
    assert.equal(worker?.status, "completed", JSON.stringify(worker));
    assert.equal(worker?.sessionId, start.delegationIds[0]);
    assert.match(provider.requests[0]!.messages.join(" "), /Keep this context/);
    const records = readRoutingRecords(join(h.stateDir, "routing"));
    assert.deepEqual(records.map((record) => [record.recordType, record.delegationId]), [["fork", start.delegationIds[0]]]);
  } finally { h.cleanup(); }
});

test("maxBackgroundWorkers refuses a background call that would exceed it, with the reason, and frees room as calls finish", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxBackgroundWorkers: 3 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const call = (id: string, count: number) => subagents.tool().execute(id,
      { items: Array.from({ length: count }, (_, index) => ({ task: `Item ${index + 1}` })), background: true } as never, undefined, undefined, ctx);
    await call("call-1", 2);
    await assert.rejects(call("call-2", 2),
      /refused the background call: its 2 workers and the 2 background workers already queued or running would exceed orchestrator\.subagents\.maxBackgroundWorkers \(3\)/);
    await call("call-3", 1);

    await waitFor(() => pending.length === 3, "the three accepted workers run");
    for (const finish of pending.splice(0)) finish();
    await waitFor(() => subagents.messages.length === 2, "both accepted calls sent their notices");
    assert.deepEqual(subagents.messages.map(({ message }) => (message.details as NoticeDetails).callId).sort(), ["call-1", "call-3"]);
    await call("call-4", 3);
    await waitFor(() => pending.length === 3, "a finished call's workers no longer count");
    assert.equal(provider.requests.length, 6, "the refused call started no worker");
    for (const finish of pending.splice(0)) finish();
    await waitFor(() => subagents.messages.length === 3, "the last call sent its notice");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("a fork whose agent definition lists subagents has no subagents tool", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = fakeAnthropic("Forked lead done.");
    const tool = loadSubagentsTool(installedWithSubagents(provider.extension));
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Lead", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Lead on", agent: "lead", fork: true }] } as never, undefined, undefined, ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual(provider.requests[0]?.tools, ["read", "report"]);
  } finally { h.cleanup(); }
});

test("a nested worker is routed, even when its definition names a model under preserve, and its decision record names the parent delegation", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { agentDefinitionModel: { use: "preserve" } } } });
  try {
    const agents = join(h.agentDir, "agents");
    writeAgentDefinition(agents, "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    writeAgentDefinition(agents, "scout.md", { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    const provider = scriptedAnthropic(delegatingScript);
    const tool = loadSubagentsTool(installedWithSubagents(provider.extension));
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, `Delegate:${JSON.stringify({ items: [{ task: "Find the config file", agent: "scout" }] })}`, "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const nestedId = provider.requests.find((request) => request.task === "Find the config file")?.sessionId;
    assert.ok(nestedId && nestedId !== worker.sessionId, "the lead's call started a worker");

    const records = readRoutingRecords(join(h.stateDir, "routing"));
    assert.deepEqual(records.map((record) => [record.recordType, record.delegationId]), [["decision", worker.sessionId], ["decision", nestedId]],
      "both workers were routed, the nested scout on orchestrator/auto rather than its preserved model");
    const [lead, nested] = records;
    assert.ok(lead?.recordType === "decision" && nested?.recordType === "decision");
    assert.equal(lead.parentDelegationId, undefined, "the orchestrator's worker has no parent delegation");
    assert.equal(nested.parentDelegationId, worker.sessionId);
  } finally { h.cleanup(); }
});

test("Ctrl+C does not stop background workers, and session shutdown aborts them and records the notice without starting a turn", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const ctrlC = new AbortController();
    await subagents.tool().execute("call-1", { items: [{ task: "Keep going" }], background: true } as never, ctrlC.signal, undefined, ctx);
    await waitFor(() => pending.length === 1, "the worker runs");
    ctrlC.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(subagents.messages.length, 0, "the worker is still running after Ctrl+C");
    pending.shift()!();
    await waitFor(() => subagents.messages.length === 1, "the notice is in");
    assert.deepEqual((subagents.messages[0]!.message.details as NoticeDetails).results.map((result) => result.status), ["completed"]);

    await subagents.tool().execute("call-2", { items: [{ task: "Run long" }, { task: "Wait in line" }], background: true } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 2, "both workers run");
    await subagents.shutdownSession(ctx);
    assert.equal(subagents.messages.length, 2, "shutdown waits until the call has ended");
    const { message, options } = subagents.messages[1]!;
    assert.deepEqual(options, { triggerTurn: false }, "the notice is recorded without starting a turn");
    const details = message.details as NoticeDetails;
    assert.equal(details.callId, "call-2");
    assert.deepEqual(details.results.map((result) => result.status), ["aborted", "aborted"]);
    assert.deepEqual(await subagents.runCommand("subagents", "", ctx), ["No background subagents calls are running."]);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("/subagents lists background calls with each worker's state, and stops one worker or a whole call", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const background = async (callId: string, tasks: readonly string[]) => (await subagents.tool().execute(callId,
      { items: tasks.map((task) => ({ task })), background: true } as never, undefined, undefined, ctx)).details as BackgroundStart;
    const first = await background("call-1", ["Fix the parser", "Update the docs"]);
    const second = await background("call-2", ["Review the diff", "Run the benchmarks"]);
    await waitFor(() => pending.length === 2, "each call runs its first worker");

    const [listing] = await subagents.runCommand("subagents", "list", ctx);
    assert.equal(listing, [
      "Background call call-1: 0/2 workers done",
      `  ${first.delegationIds[0]} · worker · running · Fix the parser`,
      `  ${first.delegationIds[1]} · worker · queued · Update the docs`,
      "",
      "Background call call-2: 0/2 workers done",
      `  ${second.delegationIds[0]} · worker · running · Review the diff`,
      `  ${second.delegationIds[1]} · worker · queued · Run the benchmarks`,
    ].join("\n"));

    // Stopping one worker aborts it; the call's next item then runs.
    assert.deepEqual(await subagents.runCommand("subagents", `stop ${first.delegationIds[0]}`, ctx), [`Stopping worker ${first.delegationIds[0]}.`]);
    await waitFor(() => provider.requests.length === 3, "call-1's second item starts");
    // Stopping a call aborts its running worker and leaves its queued item not started.
    assert.deepEqual(await subagents.runCommand("subagents", "stop call-2", ctx), ["Stopping background call call-2."]);
    await waitFor(() => subagents.messages.length === 1, "call-2's notice is in");
    const stopped = subagents.messages[0]!.message.details as NoticeDetails;
    assert.equal(stopped.callId, "call-2");
    assert.deepEqual(stopped.results.map((result) => result.status), ["aborted", "not-started"]);

    assert.deepEqual(await subagents.runCommand("subagents", "stop no-such-id", ctx), ["No running background call or worker has the id no-such-id."]);
    assert.match((await subagents.runCommand("subagents", "halt", ctx))[0] ?? "", /^Usage: \/subagents/);

    pending.at(-1)!();
    await waitFor(() => subagents.messages.length === 2, "call-1's notice is in");
    const finished = subagents.messages[1]!.message.details as NoticeDetails;
    assert.deepEqual(finished.results.map((result) => result.status), ["aborted", "completed"]);
    assert.equal(provider.requests.length, 3, "call-2's queued item never started");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("a worker's own subagents call cannot be background", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("done");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const unmark = markWorkerSession(ctx.sessionManager.getSessionId());
    try {
      await assert.rejects(tool.execute("call-1", { items: [{ task: "Nested" }], background: true } as never, undefined, undefined, ctx),
        /a worker's subagents calls run in the foreground only/);
    } finally { unmark(); }
    assert.equal(provider.requests.length, 0);
  } finally { h.cleanup(); }
});

/** A worker's snapshot in a subagents_status result's details. */
interface WorkerSnapshotDetails {
  readonly delegationId: string;
  readonly task: string;
  readonly state: string;
  readonly tool?: string;
  readonly turns: number;
  readonly elapsedMs?: number;
  readonly lastLines: readonly string[];
  readonly sessionFile?: string;
}

/** A subagents_status result's details: one snapshot per background call. */
interface StatusDetails {
  readonly calls: readonly { readonly callId: string; readonly workers: readonly WorkerSnapshotDetails[] }[];
}

/** An installed extension with a `hold` tool that runs until `release` is called. */
function holdToolExtension() {
  let running = 0;
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  const extension: InlineExtension = {
    name: "hold-tool",
    factory: (pi) => pi.registerTool({
      name: "hold", label: "Hold", description: "Runs until the test releases it.",
      parameters: { type: "object", properties: {} } as unknown as Tool["parameters"],
      async execute() {
        running++;
        await released;
        return { content: [{ type: "text", text: "released" }], details: undefined };
      },
    }),
  };
  return { extension, release, running: () => running };
}

test("subagents_status lists background calls, snapshots each item of a call, and one item by its delegation id", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  const hold = holdToolExtension();
  try {
    const provider = scriptedAnthropic((request) => request.task === "Fix the parser" && request.toolResults.length === 0
      ? { text: "Reading the parser.\nFound the bug.", toolCall: { name: "hold", arguments: {} } } : { text: "done" });
    const subagents = loadSubagents([routerExtension(), provider.extension, hold.extension]);
    const main = orchestrator(h);
    const start = (await subagents.tool().execute("call-1", { items: [{ task: "Fix the parser" }, { task: "Update the docs" }], background: true } as never,
      undefined, undefined, main.ctx)).details as BackgroundStart;
    const [runningId, queuedId] = start.delegationIds;
    await waitFor(() => hold.running() === 1, "the first worker is in its hold tool");
    const status = async (params: Record<string, unknown>) => {
      const result = await subagents.statusTool().execute("status-1", params as never, undefined, undefined, main.ctx);
      return { text: toolText(result), details: result.details as StatusDetails };
    };

    const listing = await status({});
    assert.equal(listing.text, [
      "Background call call-1: 0/2 workers done",
      `  ${runningId} · worker · running: hold · Fix the parser`,
      `  ${queuedId} · worker · queued · Update the docs`,
    ].join("\n"));

    const call = await status({ id: "call-1" });
    assert.deepEqual(call.details.calls.map((snapshot) => snapshot.callId), ["call-1"]);
    const [running, queued] = call.details.calls[0]!.workers;
    assert.deepEqual({ ...running, elapsedMs: undefined, sessionFile: undefined }, {
      delegationId: runningId, task: "Fix the parser", state: "running", tool: "hold", turns: 1,
      elapsedMs: undefined, lastLines: ["Reading the parser.", "Found the bug."], sessionFile: undefined,
    });
    assert.ok(typeof running?.elapsedMs === "number" && running.elapsedMs >= 0, JSON.stringify(running));
    assert.ok(running?.sessionFile?.startsWith(join(main.sessionDir, "subagents", main.sessionId)), running?.sessionFile);
    assert.deepEqual(queued, { delegationId: queuedId, task: "Update the docs", state: "queued", turns: 0, lastLines: [] });
    for (const shown of [`Worker ${runningId}: running: hold`, "Turns: 1", `Session file: ${running!.sessionFile}`, "  Found the bug.", `Worker ${queuedId}: queued`]) {
      assert.ok(call.text.includes(shown), `${shown} in:\n${call.text}`);
    }

    const one = await status({ id: queuedId });
    assert.deepEqual(one.details.calls.map((snapshot) => [snapshot.callId, snapshot.workers.map((worker) => worker.delegationId)]), [["call-1", [queuedId]]]);
    await assert.rejects(status({ id: "no-such-id" }), /No running background call or worker has the id no-such-id/);

    hold.release();
    await waitFor(() => subagents.messages.length === 1, "the call's notice is in");
    assert.equal((await status({})).text, "No background subagents calls are running.");
  } finally {
    hold.release();
    h.cleanup();
  }
});

test("subagents_status wait returns a background call's results, and its completion notice is not delivered", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const start = (await subagents.tool().execute("call-1", { items: [{ task: "Keep going" }], background: true } as never, undefined, undefined, ctx)).details as BackgroundStart;
    await assert.rejects(subagents.statusTool().execute("status-1", { id: start.delegationIds[0], wait: true } as never, undefined, undefined, ctx),
      /wait needs a background call id/);
    const waiting = subagents.statusTool().execute("status-2", { id: "call-1", wait: true } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 1, "the worker runs");
    pending.shift()!();
    const result = await waiting;
    const details = result.details as NoticeDetails;
    assert.equal(details.callId, "call-1");
    assert.deepEqual(details.results.map((worker) => [worker.status, worker.sessionId]), [["completed", start.delegationIds[0]]]);
    assert.match(toolText(result), new RegExp(`^Background subagents call call-1 finished\\.\\n\\nWorker ${start.delegationIds[0]} completed\\.`));
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(subagents.messages, [], "the result went to the wait, not to a notice");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("Ctrl+C during a subagents_status wait stops only the wait, and the call's notice still follows", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    await subagents.tool().execute("call-1", { items: [{ task: "Keep going" }], background: true } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 1, "the worker runs");
    const ctrlC = new AbortController();
    const waiting = subagents.statusTool().execute("status-1", { id: "call-1", wait: true } as never, ctrlC.signal, undefined, ctx);
    ctrlC.abort();
    await assert.rejects(waiting, /Stopped waiting for background call call-1; its workers run on/);
    const snapshot = (await subagents.statusTool().execute("status-2", { id: "call-1" } as never, undefined, undefined, ctx)).details as StatusDetails;
    assert.deepEqual(snapshot.calls[0]?.workers.map((worker) => worker.state), ["running"], "the worker still runs");

    pending.shift()!();
    await waitFor(() => subagents.messages.length === 1, "the notice is in");
    assert.deepEqual((subagents.messages[0]!.message.details as NoticeDetails).results.map((worker) => worker.status), ["completed"]);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("a worker whose agent definition lists subagents_status does not get it", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents, subagents_status" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript);
    const tool = loadSubagentsTool(installedWithSubagents(provider.extension));
    const { worker } = await callSubagents(tool, orchestrator(h).ctx, "Look around.", "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual([...(provider.requests[0]?.tools ?? [])].sort(), ["read", "report", "subagents"]);
  } finally { h.cleanup(); }
});

/** A provider whose worker first calls `report` with `kind` and `text`, then
 *  replies with the report's tool result: "answer: " and its text, or
 *  "refused: " and its error. */
function reportingAnthropic(kind: string, text: string) {
  return scriptedAnthropic((request) => {
    const [result] = request.toolResults;
    if (result) return { text: `${result.isError ? "refused" : "answer"}: ${result.text}` };
    return { toolCall: { name: "report", arguments: { kind, text } } };
  });
}

test("a worker's progress report is shown at once and reaches the orchestrator's next turn without starting one", async () => {
  const h = harness();
  try {
    const provider = reportingAnthropic("progress", "Half way there");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const shown: string[] = [];
    let idle = false;
    const ctx = { ...orchestrator(h).ctx, hasUI: true, ui: { notify: (text: string) => { shown.push(text); } }, isIdle: () => idle } as unknown as ExtensionContext;
    const { worker } = await callSubagents(subagents.tool(), ctx, "Work and report");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.match(worker.finalText, /^answer: /, "the report tool returned at once");
    assert.equal(subagents.messages.length, 1);
    const { message, options } = subagents.messages[0]!;
    assert.deepEqual(options, { triggerTurn: false }, "the report waits for the orchestrator's next turn");
    assert.equal(message.customType, "subagents-report");
    assert.equal(message.display, true);
    assert.equal(message.content, `Worker ${worker.sessionId} reports progress:\n\nHalf way there`);
    assert.deepEqual(shown, [`Worker ${worker.sessionId}: Half way there`], "a busy orchestrator's TUI shows the report at once");

    // An idle orchestrator's session shows the report message itself at once.
    idle = true;
    await callSubagents(subagents.tool(), ctx, "Work and report");
    assert.equal(subagents.messages.length, 2);
    assert.equal(shown.length, 1);
  } finally { h.cleanup(); }
});

test("a background worker's question starts an orchestrator turn and blocks the worker until the subagents_message reply", async () => {
  const h = harness();
  try {
    const provider = reportingAnthropic("question", "Which config file?");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const start = (await subagents.tool().execute("call-1", { items: [{ task: "Ask first" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    const id = start.delegationIds[0]!;
    // The orchestrator waits on the call before the worker asks.
    const waitEnded = assert.rejects(subagents.statusTool().execute("status-1", { id: "call-1", wait: true } as never, undefined, undefined, ctx),
      new RegExp(`Stopped waiting for background call call-1: its worker ${id} asked a question, which follows\\. ` +
        "Answer it with subagents_message, then wait again"));
    await waitFor(() => subagents.messages.length === 1, "the question is in");
    const { message, options } = subagents.messages[0]!;
    assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" }, "a turn when idle, after the current tool call when busy");
    assert.equal(message.customType, "subagents-report");
    assert.equal(message.content, `Worker ${id} asks, and waits for the answer:\n\nWhich config file?\n\nAnswer with subagents_message and the id ${id}.`);
    await waitEnded;
    await assert.rejects(subagents.statusTool().execute("status-2", { id: "call-1", wait: true } as never, undefined, undefined, ctx),
      new RegExp(`wait refused: worker ${id} of background call call-1 is waiting for an answer to its question`));

    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(provider.requests.length, 1, "the worker waits for the answer");
    assert.equal(subagents.messages.length, 1, "no completion notice while the worker waits");
    await subagents.tool("subagents_message").execute("message-1", { id, text: "Use config.json" } as never, undefined, undefined, ctx);
    await waitFor(() => subagents.messages.length === 2, "the completion notice");
    const [result] = (subagents.messages[1]!.message.details as NoticeDetails).results;
    assert.equal(result?.status, "completed", JSON.stringify(result));
    assert.equal(result?.finalText, "answer: The orchestrator answered: Use config.json");
  } finally { h.cleanup(); }
});

test("/subagents stop and an aborted call release a worker blocked on its question", async () => {
  const h = harness();
  try {
    const provider = reportingAnthropic("question", "May I delete the cache?");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const first = (await subagents.tool().execute("call-1", { items: [{ task: "Ask first" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    await waitFor(() => subagents.messages.length === 1, "the first question is in");
    await subagents.runCommand("subagents", `stop ${first.delegationIds[0]}`, ctx);
    await waitFor(() => subagents.messages.length === 2, "the stopped call's notice");
    assert.deepEqual((subagents.messages[1]!.message.details as NoticeDetails).results.map((result) => result.status), ["aborted"]);

    await subagents.tool().execute("call-2", { items: [{ task: "Ask again" }], background: true } as never, undefined, undefined, ctx);
    await waitFor(() => subagents.messages.length === 3, "the second question is in");
    await subagents.shutdownSession(ctx);
    assert.equal(subagents.messages.length, 4, "shutdown ended the call");
    assert.deepEqual((subagents.messages[3]!.message.details as NoticeDetails).results.map((result) => result.status), ["aborted"]);
  } finally { h.cleanup(); }
});

test("a foreground worker's report tool has no question kind", async () => {
  const h = harness();
  try {
    const provider = reportingAnthropic("question", "Which config file?");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const { worker } = await callSubagents(subagents.tool(), orchestrator(h).ctx, "Ask first");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.match(worker.finalText, /^refused: .*kind/s, worker.finalText);
    assert.deepEqual(subagents.messages, [], "the orchestrator got no question");
  } finally { h.cleanup(); }
});
