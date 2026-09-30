import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { createAgentSessionFromServices, createAgentSessionServices, createEventBus, DefaultPackageManager, initTheme, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionToolContext as ExtensionContext, type InlineExtension, type Theme } from "@earendil-works/pi-coding-agent";
// pi's own keybindings manager, which pi hands a ctx.ui.custom factory; its public entry exports only the type.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords, readUsableRoutingRecordEntries } from "../routing/decision-record.ts";
import { attachVerdict } from "../routing/verdicts.ts";
import { buildRoutingReport } from "../routing/routing-report.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { autoStream } from "../router/auto-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import personalGuard from "../guard/extension.ts";
import { recordUsageObservation, usageObservationsPath, type UsageObservation } from "../router/usage-observations.ts";
import { createSubagentsExtension, MAX_TEXT_BYTES, type SubagentResult, type SubagentsDependencies, type SubagentsDetails, type SubagentsProgressDetails } from "./extension.ts";
import { markWorkerSession } from "./worker-sessions.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { orchestratorProtocol } from "./orchestrator-protocol.ts";
import { workerBoard, type BoardWorker } from "./worker-board.ts";
import { openTranscript } from "./transcript-view.ts";
import { compactLines, workerRows, widgetLines, widgetRows } from "./worker-widget.ts";

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
const ORCHESTRATOR_TOOLS = ["read", "bash", "edit", "write", "probe", "hold", "subagents", "subagents_status", "subagents_message"];

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
  /** Runs the extension's handlers of an agent event, as pi does for the agent of the session `ctx` is. */
  agentEvent(type: "agent_start" | "agent_settled" | "turn_end", ctx: ExtensionContext): Promise<void>;
  /** Runs the extension's tool_call handlers, as pi does before a call runs, and returns the first block. */
  toolCall(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext): Promise<unknown>;
  /** Runs the extension's tool_result handlers, as pi does after a call ran with a result of `content`, and returns the content they leave. */
  toolResult(toolName: string, input: Record<string, unknown>, ctx: ExtensionContext, content?: readonly TextPart[]): Promise<TextPart[]>;
  /** Runs a registered command as the owner types it, and returns what it showed. */
  runCommand(name: string, args: string, ctx: ExtensionContext): Promise<string[]>;
  /** Runs a registered command with `ctx` exactly as given, for a test that
   *  supplies its own ui.custom to mount the picker or the transcript view. */
  runCommandWithUI(name: string, args: string, ctx: ExtensionContext): Promise<void>;
  /** The argument completions a registered command offers for `prefix`. */
  commandCompletions(name: string, prefix: string): Promise<{ value: string; label: string }[] | null>;
  /** Runs a registered shortcut's handler, as pi does on the key. */
  runShortcut(key: string, ctx: ExtensionContext): Promise<void>;
  /** Every message the extension sent into the orchestrator's session. */
  readonly messages: readonly SentMessage[];
}

/** A text part of a tool result. */
type TextPart = { type: string; text?: string };
type Command = Parameters<ExtensionAPI["registerCommand"]>[1];
type Shortcut = Parameters<ExtensionAPI["registerShortcut"]>[1];

/** The subagents extension as pi loads it in the orchestrator's session. */
function loadSubagents(workerExtensions: readonly InlineExtension[]): LoadedSubagents {
  const tools: Tool[] = [];
  const handlers = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
  const commands = new Map<string, Command>();
  const shortcuts = new Map<string, Shortcut>();
  const messages: SentMessage[] = [];
  createSubagentsExtension({ workerExtensions })({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand(name: string, command: Command) { commands.set(name, command); },
    registerShortcut(key: string, shortcut: Shortcut) { shortcuts.set(key, shortcut); },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { handlers.set(event, [...handlers.get(event) ?? [], handler]); },
    sendMessage(message: SentMessage["message"], options: SentMessage["options"]) { messages.push({ message, options }); },
    getActiveTools: () => [...ORCHESTRATOR_TOOLS],
    // As pi gives each session's extensions one bus, on which pi-orchestrator's subcommands join one command.
    events: createEventBus(),
  } as unknown as ExtensionAPI);
  const emit = async (event: { type: string; reason?: string }, ctx: ExtensionContext) => {
    for (const handler of handlers.get(event.type) ?? []) await handler(event, ctx);
  };
  const getCommand = (name: string) => {
    const command = commands.get(name);
    assert.ok(command, `command /${name} is registered`);
    return command;
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
    agentEvent: (type, ctx) => emit({ type }, ctx),
    async toolCall(toolName, input, ctx) {
      for (const handler of handlers.get("tool_call") ?? []) {
        const result = await handler({ type: "tool_call", toolCallId: "call", toolName, input }, ctx);
        if (result !== undefined) return result;
      }
      return undefined;
    },
    async toolResult(toolName, input, ctx, content = [{ type: "text", text: "(no output)" }]) {
      let current = [...content];
      for (const handler of handlers.get("tool_result") ?? []) {
        const result = await handler({ type: "tool_result", toolCallId: "call", toolName, input, content: current, isError: false, details: undefined }, ctx) as
          { content?: TextPart[] } | undefined;
        if (result?.content !== undefined) current = result.content;
      }
      return current;
    },
    async runCommand(name, args, ctx) {
      const shown: string[] = [];
      const ui = { notify: (text: string) => { shown.push(text); } };
      await getCommand(name).handler(args, { ...ctx, hasUI: true, ui } as never);
      return shown;
    },
    async runCommandWithUI(name, args, ctx) { await getCommand(name).handler(args, ctx as never); },
    async commandCompletions(name, prefix) { return getCommand(name).getArgumentCompletions?.(prefix) ?? null; },
    async runShortcut(key, ctx) {
      const shortcut = shortcuts.get(key);
      assert.ok(shortcut, `shortcut ${key} is registered`);
      await shortcut.handler(ctx);
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

async function callSubagents(tool: Tool, ctx: ExtensionContext, task: string, agent?: string, label?: string) {
  const result = await tool.execute("call-1", { items: [{ task, ...(agent === undefined ? {} : { agent }), ...(label === undefined ? {} : { label }) }] } as never, undefined, undefined, ctx);
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

test("a labelled subagents item appears on the routed worker board with its tier", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    const tool = loadSubagentsTool([routerExtension(), fakeAnthropic("Done").extension]);
    const itemSchema = (tool.parameters as unknown as { properties: { items: { items: { properties: Record<string, unknown>; required: string[] } } } }).properties.items.items;
    assert.ok(itemSchema.properties.label);
    assert.ok(!itemSchema.required.includes("label"));
    const main = orchestrator(h);
    const result = await tool.execute("label-call", { items: [{ task: "Check budget", label: "research: budget code" }] } as never, undefined, undefined, main.ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.label, "research: budget code");
    const shown = workerBoard().byDelegation(worker.sessionId!);
    assert.equal(shown?.label, "research: budget code");
    assert.equal(shown?.tier, "mechanical");
  } finally { h.cleanup(); }
});

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
    assert.deepEqual(buildRoutingReport(recordDir).totals.verdicts, { accept: 1, request_changes: 0 });
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
    assert.deepEqual(workerBoard().byDelegation(fork.sessionId!)?.model, { kind: "fork", model: HAIKU, effort: "high" }, "the worker board shows the resumed fork's fixed model");
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
    const resumedRow = workerBoard().workers().at(-1)!;
    assert.equal(resumedRow.agent, "reviewer", "the resumed run reads its saved agent definition");
    const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    assert.match(compactLines({ rows: workerRows([resumedRow]), more: 0 }, Date.now(), plain, 200)[0]!, /^reviewer · haiku-4-5:medium · \d+s · completed$/);
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).filter((record) => record.recordType === "agent-model").length, 1);
    assert.ok(provider.requests[1]!.systemText.includes("Review carefully."));
    assert.deepEqual(provider.requests.map((request) => request.tools), [["read", "report"], ["read", "report"]]);
  } finally { h.cleanup(); }
});

test("a resumed named worker retains its saved label in the board and widget", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts" }, "Find files.");
    const provider = fakeAnthropic("Done");
    const main = orchestrator(h);
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const first = await callSubagents(tool, main.ctx, "First task", "scout", "research: budget code");
    const resumed = await tool.execute("resume", { items: [{ resume: first.worker.sessionId, task: "Second task" }] } as never, undefined, undefined, main.ctx);
    assert.equal((resumed.details as SubagentsDetails).results[0]!.status, "completed");
    const row = workerBoard().workers().at(-1)!;
    assert.equal(row.agent, "scout");
    assert.equal(row.label, "research: budget code");
    const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
    assert.match(widgetLines(widgetRows([row], Date.now()), undefined, Date.now(), plain, 200)[3]!, /^  ○ research: budget code   mechanical · haiku-4-5:low · \d+s · completed$/);
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

/** Whether a worker's system prompt carries the reporting rules and the Result's five sections (ADR 0010). */
function hasReportingRules(systemText: string): boolean {
  return /file:line/.test(systemText) && ["Confirmed", "Changed", "Unverified", "Could not check", "Verified by"]
    .every((section) => systemText.includes(`## ${section}`));
}

test("every non-fork worker gets the reporting rules, and an agent definition's instructions follow them", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    writeAgentDefinition(join(h.projectDir, ".pi", "agents"), "reviewer.md", { name: "reviewer", description: "Reviews" }, "REVIEWER INSTRUCTIONS");
    const provider = fakeAnthropic("Done.");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const main = orchestrator(h);

    const plain = await callSubagents(tool, main.ctx, "Say done.");
    assert.equal(plain.worker.status, "completed", JSON.stringify(plain.worker));
    assert.ok(hasReportingRules(provider.requests[0]!.systemText), provider.requests[0]!.systemText);

    const reviewer = await callSubagents(tool, main.ctx, "Review the diff.", "reviewer");
    assert.equal(reviewer.worker.status, "completed", JSON.stringify(reviewer.worker));
    const systemText = provider.requests[1]!.systemText;
    assert.ok(hasReportingRules(systemText), systemText);
    assert.ok(systemText.indexOf("## Verified by") < systemText.indexOf("REVIEWER INSTRUCTIONS"), "the definition's instructions follow the rules");

    // A resumed worker's rebuilt system prompt has them again.
    await tool.execute("call-2", { items: [{ resume: plain.worker.sessionId, task: "Go on." }] } as never, undefined, undefined, main.ctx);
    assert.ok(hasReportingRules(provider.requests[2]!.systemText), provider.requests[2]!.systemText);
  } finally { h.cleanup(); }
});

test("a Result missing sections gets a note naming them in the tool result; a complete Result gets none", async () => {
  const h = harness();
  try {
    const partial = fakeAnthropic("## Confirmed\nThe typo is fixed (README.md:3).\n\n**Changed**: README.md\n\nVerified by: npm test");
    const partialCall = await callSubagents(loadSubagentsTool([routerExtension(), partial.extension]), orchestrator(h).ctx, "Fix the typo.");
    assert.equal(partialCall.worker.status, "completed", JSON.stringify(partialCall.worker));
    assert.deepEqual(partialCall.worker.missingSections, ["Unverified", "Could not check"]);
    assert.match(partialCall.text, /The typo is fixed/);
    assert.match(partialCall.text, /Result check: this Result has no Unverified, Could not check sections/);
    assert.equal(partialCall.worker.finalText.includes("Result check"), false, "the worker's own text is unchanged");

    const complete = fakeAnthropic(["## Confirmed", "README.md:3", "## Changed", "README.md", "## Unverified", "None.",
      "## Could not check", "None.", "## Verified by", "npm test: pass"].join("\n"));
    const completeCall = await callSubagents(loadSubagentsTool([routerExtension(), complete.extension]), orchestrator(h).ctx, "Fix the typo.");
    assert.equal(completeCall.worker.status, "completed", JSON.stringify(completeCall.worker));
    assert.equal(completeCall.worker.missingSections, undefined);
    assert.equal(completeCall.text.includes("Result check"), false, completeCall.text);
  } finally { h.cleanup(); }
});

test("a forked worker gets no reporting rules, with or without an agent definition, and neither does its resume", async () => {
  const h = harness();
  try {
    mkdirSync(h.stateDir);
    saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
    writeAgentDefinition(join(h.agentDir, "agents"), "reviewer.md", { name: "reviewer", description: "Reviews" }, "Review carefully.");
    const provider = fakeAnthropic("Reviewed.");
    const tool = loadSubagentsTool([routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Review", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "high" } as unknown as ExtensionContext;
    const result = await tool.execute("fork-call", { items: [{ task: "Review", fork: true }, { task: "Review", agent: "reviewer", fork: true }] } as never,
      undefined, undefined, ctx);
    const [fork] = (result.details as SubagentsDetails).results;
    assert.deepEqual((result.details as SubagentsDetails).results.map((worker) => worker.status), ["completed", "completed"]);
    await tool.execute("call-2", { items: [{ resume: fork!.sessionId, task: "Go on." }] } as never, undefined, undefined, ctx);
    assert.equal(provider.requests.length, 3);
    for (const request of provider.requests) assert.equal(hasReportingRules(request.systemText), false, request.systemText);
    assert.ok(provider.requests.some((request) => request.systemText.includes("Review carefully.")), "the fork's definition still applies");
    assert.equal(fork!.missingSections, undefined, "a fork's reply is not checked as a Result");
    assert.equal(result.content.map((part) => part.type === "text" ? part.text : "").join("").includes("Result check"), false);
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

test("neither a worker nor a forked worker is the orchestrator's session, as the extensions it loads see it", async () => {
  const h = harness();
  try {
    const seen: { sessionId: string; orchestrator: boolean }[] = [];
    const probe: InlineExtension = {
      name: "orchestrator-session-probe",
      factory: (pi) => { pi.on("session_start", (_event, ctx) => { seen.push({ sessionId: ctx.sessionManager.getSessionId(), orchestrator: isOrchestratorSession(ctx) }); }); },
    };
    const provider = fakeAnthropic("Done.");
    const tool = loadSubagentsTool([probe, routerExtension(), provider.extension]);
    const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
    parent.appendMessage({ role: "user", content: "Delegate", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" } as unknown as ExtensionContext;
    assert.equal(isOrchestratorSession(ctx), true);

    const { worker } = await callSubagents(tool, ctx, "Fix the typo in README.md");
    const forked = await tool.execute("fork-call", { items: [{ task: "Finish", fork: true }] } as never, undefined, undefined, ctx);
    const fork = (forked.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(fork.status, "completed", JSON.stringify(fork));
    assert.deepEqual(seen, [{ sessionId: worker.sessionId, orchestrator: false }, { sessionId: fork.sessionId, orchestrator: false }]);
    assert.equal(isOrchestratorSession(ctx), true, "the orchestrator's session still is once its workers ended");
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
    // Sorted: the router's clock is fixed at NOW, but fork records carry the real
    // date, so on any other day they land in a later day file than the decision.
    assert.deepEqual(readRoutingRecords(join(h.stateDir, "routing")).map((record) => record.recordType).sort(), ["decision", "fork", "fork"]);
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
  /** The system prompt as the model has it at this request: every system
   *  message's text (a forced prompt), then its sections applied in order, a removed one dropped. */
  readonly systemPrompt: string;
}

/** What a scripted provider answers: a final text, or one tool call, which a text may come before. */
type ScriptedReply = { readonly text: string } | { readonly text?: string; readonly toolCall: { readonly name: string; readonly arguments: Record<string, unknown> } };

/** A fake `anthropic` provider serving claude-haiku-4-5 offline, answering each
 *  request with what `script` returns for it. A request `hold` returns true for
 *  is answered only when the worker is aborted. */
function scriptedAnthropic(script: (request: ScriptedRequest) => ScriptedReply, hold?: (request: ScriptedRequest) => boolean) {
  const requests: ScriptedRequest[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
    streamSimple(model, context, options) {
      const tools = new Set<string>();
      const sections = new Map<string, string>();
      const forced: string[] = [];
      const text = (content: string | readonly { type: string; text?: string }[]) =>
        typeof content === "string" ? content : content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        if (text(message.content).length > 0) forced.push(text(message.content));
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
        for (const [name, section] of Object.entries(message.sections ?? {})) {
          if (section === null) sections.delete(name);
          else sections.set(name, section);
        }
      }
      const firstUser = context.messages.find((message) => message.role === "user");
      const request: ScriptedRequest = {
        sessionId: options?.sessionId, task: firstUser ? text(firstUser.content) : "", tools: [...tools],
        toolResults: context.messages.flatMap((message) => message.role === "toolResult" ? [{ text: text(message.content), isError: message.isError }] : []),
        userMessages: context.messages.flatMap((message) => message.role === "user" ? [text(message.content)] : []),
        systemPrompt: [...forced, ...sections.values()].join("\n\n"),
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
      const finish = () => {
        push({ type: "done", reason: message.stopReason, message } as never);
        end({ api: model.api, provider: model.provider, model: model.id });
      };
      if (hold?.(request)) options?.signal?.addEventListener("abort", finish, { once: true });
      else finish();
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
    // "stop all" is unchanged from before xytd's picker replaced empty args' text notice.
    assert.deepEqual(await subagents.runCommand("subagents", "stop all", ctx), ["No background subagents calls are running."]);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("/subagents stop is unchanged: it still stops one worker or a whole background call by id, and an unrecognized word (xytd: no longer a usage message) is refused as an unknown direct jump", async () => {
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
    // Before xytd, an unrecognized word such as a bare "list" fell through backgroundCalls.command
    // to a fixed usage string; now it is tried as a direct jump like any other ref and refused by name.
    assert.deepEqual(await subagents.runCommand("subagents", "list", ctx),
      ["No worker of this session has the delegation id list. /subagents lists every worker."]);
    assert.deepEqual(await subagents.runCommand("subagents", "halt", ctx),
      ["No worker of this session has the delegation id halt. /subagents lists every worker."]);

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
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", tools: "hold" }, "Check the parser.");
    const provider = scriptedAnthropic((request) => request.task === "Fix the parser" && request.toolResults.length === 0
      ? { text: "Reading the parser.\nFound the bug.", toolCall: { name: "hold", arguments: {} } } : { text: "done" });
    const subagents = loadSubagents([routerExtension(), provider.extension, hold.extension]);
    const main = orchestrator(h);
    const start = (await subagents.tool().execute("call-1", { items: [{ task: "Fix the parser", agent: "scout", label: "parser repair" }, { task: "Update the docs" }], background: true } as never,
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
      `  ${runningId} · parser repair · mechanical · haiku-4-5:low · 0s · running · thinking…`,
      `  ${queuedId} · worker · routing… · queued`,
    ].join("\n"));

    const call = await status({ id: "call-1" });
    assert.deepEqual(call.details.calls.map((snapshot) => snapshot.callId), ["call-1"]);
    const [running, queued] = call.details.calls[0]!.workers;
    assert.deepEqual({ ...running, elapsedMs: undefined, sessionFile: undefined }, {
      delegationId: runningId, task: "Fix the parser", agent: "scout", state: "running", tool: "hold", turns: 1,
      elapsedMs: undefined, lastLines: ["Reading the parser.", "Found the bug."], sessionFile: undefined,
    });
    assert.ok(typeof running?.elapsedMs === "number" && running.elapsedMs >= 0, JSON.stringify(running));
    assert.ok(running?.sessionFile?.startsWith(join(main.sessionDir, "subagents", main.sessionId)), running?.sessionFile);
    assert.deepEqual(queued, { delegationId: queuedId, task: "Update the docs", state: "queued", turns: 0, lastLines: [] });
    for (const shown of [`Worker ${runningId}: running: hold`, "Turns: 1", "Rung: anthropic/claude-haiku-4-5:low", `Session file: ${running!.sessionFile}`, "  Found the bug.",
      `Worker ${queuedId}: queued`]) {
      assert.ok(call.text.includes(shown), `${shown} in:\n${call.text}`);
    }
    assert.doesNotMatch(call.text, /Agent:/, "the snapshot must not repeat a conflicting agent identity beside its board row");
    assert.match(call.text, /parser repair · mechanical/, "the snapshot uses the worker's visible identity");

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

// The worker board (worker-board.ts) as the subagents extension feeds it from
// real workers. The board is the process's, so each test starts the
// orchestrator's session first, which gives it an empty board.

/** The board's workers without their changing ids, times and counters. */
function boardShape(workers: readonly BoardWorker[]) {
  return workers.map(({ task, agent, background, state, parentDelegationId, model }) => ({
    task, ...(agent === undefined ? {} : { agent }), background, state,
    ...(parentDelegationId === undefined ? {} : { parentDelegationId }),
    model: model.kind === "routed" ? { kind: "routed", rungs: model.rungs.map(({ model: rung, effort, escalation }) => ({ model: rung, effort, ...(escalation ? { escalation } : {}) })) } : model,
  }));
}

test("the worker board shows a call's workers and a nested worker under its parent delegation, each with the rung that served it and its end state", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript);
    const subagents = loadSubagents(installedWithSubagents(provider.extension));
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const task = `Delegate:${JSON.stringify({ items: [{ task: "Find the config file" }] })}`;
    const { worker } = await callSubagents(subagents.tool(), main.ctx, task, "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));

    const workers = workerBoard().workers();
    const haiku = { kind: "routed", rungs: [{ model: HAIKU, effort: "low" }] };
    assert.deepEqual(boardShape(workers), [
      { task, agent: "lead", background: false, state: "completed", model: haiku },
      { task: "Find the config file", background: false, state: "completed", parentDelegationId: worker.sessionId, model: haiku },
    ]);
    const [lead, nested] = workers;
    assert.equal(lead!.delegationId, worker.sessionId);
    assert.equal(lead!.sessionFile, worker.sessionFile);
    assert.equal(nested!.parentId, lead!.id);
    assert.equal(lead!.turns, 2, "the delegating turn and the reply");
    assert.equal(nested!.turns, 1);
    assert.equal(lead!.activity, undefined, "a finished worker is doing nothing");
    assert.ok(lead!.endedAt !== undefined && lead!.startedAt !== undefined && lead!.endedAt >= lead!.startedAt);
  } finally { h.cleanup(); }
});

test("the worker board follows items through the queue: queued, routing, running on its rung, then aborted, a queued item included", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 1 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const seen: string[] = [];
    const stop = workerBoard().subscribe((changed) => {
      if (changed?.task === "Item 1") seen.push(`${changed.state} ${changed.model.kind}`);
    });
    const controller = new AbortController();
    const call = subagents.tool().execute("call-1", { items: [{ task: "Item 1" }, { task: "Item 2" }] } as never, controller.signal, undefined, main.ctx);
    await waitFor(() => pending.length === 1, "the first worker's request is in");
    assert.deepEqual(boardShape(workerBoard().workers()), [
      { task: "Item 1", background: false, state: "running", model: { kind: "routed", rungs: [{ model: HAIKU, effort: "low" }] } },
      { task: "Item 2", background: false, state: "queued", model: { kind: "routing" } },
    ]);
    controller.abort();
    await call;
    stop();
    assert.deepEqual(workerBoard().workers().map((worker) => worker.state), ["aborted", "aborted"]);
    assert.equal(workerBoard().workers()[1]!.startedAt, undefined, "the queued item never started");
    assert.deepEqual([...new Set(seen)].slice(0, 3), ["queued routing", "running routing", "running routed"], "routing until the first request");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("the worker board shows a background worker asking while its question waits, then completed", async () => {
  const h = harness();
  try {
    const provider = reportingAnthropic("question", "Which config file?");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const start = (await subagents.tool().execute("call-1", { items: [{ task: "Ask first" }], background: true } as never,
      undefined, undefined, main.ctx)).details as BackgroundStart;
    const id = start.delegationIds[0]!;
    await waitFor(() => subagents.messages.length === 1, "the question is in");
    const asking = workerBoard().byDelegation(id);
    assert.equal(asking?.state, "asking");
    assert.equal(asking?.background, true);
    assert.equal(asking?.callId, "call-1");
    await subagents.tool("subagents_message").execute("message-1", { id, text: "Use config.json" } as never, undefined, undefined, main.ctx);
    await waitFor(() => subagents.messages.length === 2, "the completion notice");
    assert.equal(workerBoard().byDelegation(id)?.state, "completed");
  } finally { h.cleanup(); }
});

test("the worker board marks an escalated rung, and shows a fork's and a preserved agent's fixed model", async () => {
  const sonnet = "anthropic/claude-sonnet-5";
  // The catalog has no Sonnet, so the hard filters empty the mechanical tier and the task moves up to standard.
  const h = harness({ orchestrator: {
    routing: { ...ROUTING, tiers: { mechanical: [`${sonnet}:low`], standard: [RUNG], elevated: [RUNG], critical: [RUNG] } },
    subagents: { agentDefinitionModel: { use: "preserve" } },
  } });
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "scout.md", { name: "scout", description: "Scouts", model: HAIKU, thinking: "high" }, "Find files.");
    const provider = fakeAnthropic("done", undefined, ["claude-haiku-4-5", "claude-sonnet-5"]);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const parent = SessionManager.inMemory(h.projectDir);
    parent.appendMessage({ role: "user", content: "Earlier turn", timestamp: Date.now() });
    parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagents", arguments: {} }], timestamp: Date.now() } as never);
    const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent,
      model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "medium" } as unknown as ExtensionContext;
    await subagents.startSession(ctx);
    const result = await subagents.tool().execute("call-1", { items: [{ task: "Routed" }, { task: "Forked", fork: true }, { task: "Scout", agent: "scout" }] } as never,
      undefined, undefined, ctx);
    assert.deepEqual((result.details as SubagentsDetails).results.map((worker) => worker.status), ["completed", "completed", "completed"]);
    assert.deepEqual(boardShape(workerBoard().workers()).map((worker) => worker.model), [
      { kind: "routed", rungs: [{ model: HAIKU, effort: "low", escalation: { from: "mechanical", to: "standard" } }] },
      { kind: "fork", model: HAIKU, effort: "medium" },
      { kind: "preserved", model: HAIKU, effort: "high" },
    ]);
  } finally { h.cleanup(); }
});

test("the orchestrator's session shows its workers in the widget below the editor, a nested worker indented under its parent, until the session ends", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript);
    const subagents = loadSubagents(installedWithSubagents(provider.extension));
    const main = orchestrator(h);
    const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    let component: { render(width: number): string[]; dispose?(): void } | undefined;
    const seen: string[][] = [];
    const snapshot = () => { if (component) seen.push(component.render(200).map((line) => line.trimEnd())); };
    const ui = {
      notify() {},
      setWidget(_key: string, content: unknown, options?: { placement?: string }) {
        component?.dispose?.();
        assert.ok(content === undefined || options?.placement === "belowEditor");
        component = (content as ((tui: unknown, theme: unknown) => typeof component) | undefined)?.({ requestRender: snapshot }, plain);
        snapshot();
      },
      onTerminalInput: () => () => {},
    };
    const ctx = { ...main.ctx, hasUI: true, ui } as unknown as ExtensionContext;
    await subagents.startSession(ctx);
    assert.equal(component, undefined, "no widget while no worker runs");
    const task = `Delegate:${JSON.stringify({ items: [{ task: "Find the config file" }] })}`;
    const { worker } = await callSubagents(subagents.tool(), ctx, task, "lead", "coordinate config");
    assert.equal(worker.status, "completed", JSON.stringify(worker));

    const running = (name: string, status: string) =>
      new RegExp(`^  ○ ${name} {2,}mechanical · [^ ]+ · \\d+s · running · ${status}$`);
    const nestedShown = seen.find((lines) => lines.length === 5 && lines[2] === "❯ ● main" && running("└ worker", "\\S.*").test(lines[4]!));
    assert.ok(nestedShown, JSON.stringify(seen));
    // Its tool call follows its turn's start within the 1.5 s hold, so the lead still shows thinking.
    assert.match(nestedShown[3]!, running("coordinate config", "thinking…"));
    assert.match(component!.render(200)[3]!, /^  ○ coordinate config {2,}mechanical · [^ ]+ · \d+s · completed$/, "a finished worker lingers, its row ending with its end state");
    await subagents.shutdownSession(ctx);
    assert.equal(component, undefined, "the session's end removes the widget");
  } finally { h.cleanup(); }
});

// The transcript view's x (transcript-view.ts) on real workers: the view
// opens as xytd's ways in will open it, through a fake ctx.ui.custom with pi's
// own keybindings manager, and the stop reaches the worker through the board.

/** Opens `workerId`'s transcript view on the process's board; `closed` settles when it is left. */
function openView(workerId: string) {
  initTheme("dark");
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  let component: { render(width: number): string[]; handleInput(data: string): void } | undefined;
  const ui = {
    custom: (async (factory: (...args: unknown[]) => unknown) => new Promise<void>((resolve) => {
      component = factory({ terminal: { rows: 40 }, requestRender() {} }, plainTheme, new KeybindingsManager(), () => resolve()) as typeof component;
    })) as never,
  };
  const closed = openTranscript(ui, workerBoard(), workerId);
  return {
    closed,
    press(...keys: string[]) { for (const key of keys) component!.handleInput(key); },
    /** The header's agent, worker state and place, under the orchestrator bar; its elapsed time and the rest tick with the clock. */
    header: () => {
      const parts = component!.render(200)[1]!.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split(" · ");
      return [parts[0], parts[1], parts.at(-1)].join(" · ");
    },
  };
}

test("x in the transcript view stops one worker of a call after a confirmation, a queued one at once, and the others run on", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { maxParallel: 2 } } });
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const call = subagents.tool().execute("call-1", { items: [{ task: "Keeps going" }, { task: "Gets stopped" }, { task: "Never starts" }] } as never,
      undefined, undefined, main.ctx);
    await waitFor(() => pending.length === 2, "both running workers' requests are in");
    const [keeps, stopped, queued] = workerBoard().workers();

    const view = openView(queued!.id);
    assert.equal(view.header(), "worker · queued · worker 3 of 3");
    view.press("x", "y");
    assert.equal(workerBoard().worker(queued!.id)?.state, "aborted", "a queued worker ends at once");
    assert.equal(view.header(), "worker · aborted · worker 3 of 3", "the view stays open with its end state");

    view.press("\x1b[D", "x");
    assert.equal(view.header(), "worker · running · worker 2 of 3");
    assert.equal(workerBoard().worker(stopped!.id)?.state, "running", "nothing stops before the confirmation");
    view.press("y");
    await waitFor(() => workerBoard().worker(stopped!.id)?.state === "aborted", "the stopped worker has ended");
    assert.equal(view.header(), "worker · aborted · worker 2 of 3");
    assert.equal(workerBoard().worker(keeps!.id)?.state, "running", "the other worker runs on");
    assert.equal(pending.length, 2, "the queued worker never started in the freed slot");

    for (const finish of pending) finish();
    const results = ((await call).details as SubagentsDetails).results;
    assert.deepEqual(results.map((result) => result.status), ["completed", "aborted", "not-started"]);
    view.press("\x1b");
    await view.closed;
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("x in the transcript view stops a nested worker alone: its parent hears it was aborted and completes", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript, (request) => request.task === "Hold on");
    const subagents = loadSubagents(installedWithSubagents(provider.extension));
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const lead = callSubagents(subagents.tool(), main.ctx, `Delegate:${JSON.stringify({ items: [{ task: "Hold on" }] })}`, "lead");
    await waitFor(() => provider.requests.some((request) => request.task === "Hold on"), "the nested worker's request is in");
    const nested = workerBoard().workers().find((worker) => worker.task === "Hold on")!;
    assert.ok(nested.parentId !== undefined);

    const view = openView(nested.id);
    view.press("x", "y");
    const { worker } = await lead;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.match(worker.finalText, /^delegated: Worker \S+ aborted\./, worker.finalText);
    assert.deepEqual(workerBoard().workers().map((entry) => entry.state), ["completed", "aborted"]);
    assert.equal(view.header(), "worker · aborted · worker 2 of 2");
    view.press("\x1b");
    await view.closed;
  } finally { h.cleanup(); }
});


// The ways in (xytd): alt+a, the /subagents picker and its direct jumps.
// Every opener goes through the same ctx.ui.custom pi mounts a component with,
// so one fake stands in for the picker's overlay, the focus overlay and the
// transcript view alike; a test drives it with pi's own keybindings manager,
// never raw bytes, matching openView above.

/** ctx.ui.custom as pi mounts it, generalised over every opener: the picker,
 *  alt+a's focus overlay and the transcript view all reach it the same way. */
function fakeCustomUI() {
  const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
  let mounted: { render(width: number): string[]; handleInput(data: string): void; dispose?(): void } | undefined;
  let opens = 0;
  const ui = {
    custom: (async (factory: (...args: unknown[]) => unknown) => new Promise<unknown>((resolve) => {
      opens++;
      const component = factory({ terminal: { rows: 40 }, requestRender() {} }, plainTheme, new KeybindingsManager(), (result: unknown) => {
        mounted = undefined;
        (component as { dispose?(): void }).dispose?.();
        resolve(result);
      }) as typeof mounted;
      mounted = component;
    })) as never,
  };
  return {
    ui,
    get opens() { return opens; },
    get open() { return mounted !== undefined; },
    lines: (width = 200) => mounted!.render(width).map((line) => line.trimEnd()),
    press(...keys: string[]) { for (const key of keys) mounted!.handleInput(key); },
  };
}

test("/subagents with no arguments opens the picker of every worker when there is a UI, and Esc leaves without opening one; without a UI it lists every worker as text, replacing the old background-only notice", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    await subagents.startSession(ctx);
    await subagents.tool().execute("call-1", { items: [{ task: "Unique widget marker one" }], background: true } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 1, "the worker is running");

    const screen = fakeCustomUI();
    const opening = subagents.runCommandWithUI("subagents", "", { ...ctx, hasUI: true, ui: screen.ui } as unknown as ExtensionContext);
    assert.equal(screen.opens, 1, "the picker opened, not the old background-only text notice");
    assert.ok(screen.lines().some((line) => line.includes("Workers of this session")), screen.lines().join("\n"));
    // A running worker's row shows its activity, not its task (CONTEXT.md, Activity).
    assert.ok(screen.lines().some((line) => /^(?:❯ ●|  ○) \d+\. worker +mechanical · [^ ]+ · \d+s · running · thinking…$/.test(line)),  `every worker of the session, not only background calls:\n${screen.lines().join("\n")}`);
    screen.press("\x1b");
    await opening;
    assert.equal(screen.opens, 1, "Esc left without opening a transcript next");

    const shown: string[] = [];
    const noUI = { notify: (text: string) => { shown.push(text); } };
    await subagents.runCommandWithUI("subagents", "", { ...ctx, hasUI: false, ui: noUI } as unknown as ExtensionContext);
    assert.equal(shown.length, 1);
    assert.match(shown[0]!, /^\d+\. worker · mechanical · [^ ]+ · \d+s · running · thinking…$/m, "the same row as text, where there is no UI to pick in");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("/subagents <list number> and /subagents <delegation id> open that worker's transcript directly, with no picker in between; an unrecognized ref is refused", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const before = workerBoard().workers().length;
    const started = (await subagents.tool().execute("call-1", { items: [{ task: "Direct jump target" }], background: true } as never,
      undefined, undefined, ctx)).details as BackgroundStart;
    await waitFor(() => pending.length === 1, "the worker is running");
    const listNumber = String(before + 1);

    const byNumber = fakeCustomUI();
    const openingByNumber = subagents.runCommandWithUI("subagents", listNumber, { ...ctx, hasUI: true, ui: byNumber.ui } as unknown as ExtensionContext);
    assert.equal(byNumber.opens, 1, "the transcript opened directly by list number");
    byNumber.press("\x1b");
    await openingByNumber;

    const byDelegation = fakeCustomUI();
    const openingByDelegation = subagents.runCommandWithUI("subagents", started.delegationIds[0]!, { ...ctx, hasUI: true, ui: byDelegation.ui } as unknown as ExtensionContext);
    assert.equal(byDelegation.opens, 1, "the transcript opened directly by delegation id");
    byDelegation.press("\x1b");
    await openingByDelegation;

    const shown: string[] = [];
    const refusing = { notify: (text: string, kind?: string) => { shown.push(`${kind}:${text}`); } };
    await subagents.runCommandWithUI("subagents", "not-a-worker", { ...ctx, hasUI: true, ui: refusing } as unknown as ExtensionContext);
    assert.deepEqual(shown, ["warning:No worker of this session has the delegation id not-a-worker. /subagents lists every worker."]);
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("alt+a or Down at the editor's end focuses the worker widget for the orchestrator's session; Enter opens the focused worker's transcript and leaving it comes back to the list; a worker session's own alt+a does nothing", async () => {
  const h = harness();
  const pending: (() => void)[] = [];
  try {
    const provider = fakeAnthropic("done", (finish) => pending.push(finish));
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
    let widget: { render(width: number): string[] } | undefined;
    const custom = fakeCustomUI();
    const inputs: ((data: string) => { consume?: boolean } | undefined)[] = [];
    // pi's editor, focused, its cursor on its only line.
    const editor = { keybindings: new KeybindingsManager(), getLines: () => [""], getCursor: () => ({ line: 0, col: 0 }), historyIndex: -1, autocompleteState: null };
    const ui = {
      ...custom.ui,
      notify() {},
      setWidget(_key: string, content: unknown, options?: { placement?: string }) {
        assert.ok(content === undefined || options?.placement === "belowEditor");
        widget = (content as ((tui: unknown, theme: unknown) => typeof widget) | undefined)?.({ requestRender() {}, getFocusedComponent: () => editor }, plainTheme);
      },
      onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
        inputs.push(handler);
        return () => { inputs.splice(inputs.indexOf(handler), 1); };
      },
    };
    const ctx = { ...main.ctx, hasUI: true, ui } as unknown as ExtensionContext;
    await subagents.startSession(ctx);
    await subagents.tool().execute("call-1", { items: [{ task: "Alt-a focus target" }], background: true } as never, undefined, undefined, ctx);
    await waitFor(() => pending.length === 1, "a worker is running for the widget to show");
    assert.ok(widget, "the widget is shown while a worker runs");

    const focusing = subagents.runShortcut("alt+a", ctx);
    assert.equal(custom.opens, 1, "alt+a opened the widget's focus overlay");
    custom.press("\r");
    // The overlay's Enter resolves the focus; the shortcut's own continuation
    // (opening the transcript) runs on the next microtask, before the overlay
    // it opens is ever closed, so it cannot be awaited yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(custom.opens, 2, "Enter opened the chosen worker's transcript next");
    custom.press("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(custom.opens, 3, "leaving the transcript comes back to the list");
    assert.ok(custom.open);
    custom.press("\x1b");
    await focusing;

    assert.equal(inputs.length, 1, "one listener sees each key before the editor");
    assert.equal(inputs[0]!("x"), undefined, "any other key goes to the editor");
    assert.deepEqual(inputs[0]!("\x1b[B"), { consume: true }, "Down at the editor's end is the widget's");
    assert.equal(custom.opens, 4, "and focuses it");
    custom.press("\x1b");
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(custom.open, false);

    // A worker's own copy of this extension shows no widget (session_start
    // guards it), so its alt+a is a no-op even though the shortcut is registered.
    const unmark = markWorkerSession(ctx.sessionManager.getSessionId());
    try {
      await subagents.runShortcut("alt+a", ctx);
      assert.equal(custom.opens, 4, "no widget to focus in a worker's own session");
    } finally { unmark(); }

    await subagents.shutdownSession(ctx);
    assert.equal(inputs.length, 0, "the session's end stops the Down entry");
  } finally {
    for (const finish of pending) finish();
    h.cleanup();
  }
});

test("the /subagents command's argument completions offer stop and every worker's list number", async () => {
  const h = harness();
  try {
    const provider = fakeAnthropic("done");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const ctx = orchestrator(h).ctx;
    const before = workerBoard().workers().length;
    await callSubagents(subagents.tool(), ctx, "Completion target");
    const listNumber = String(before + 1);

    const all = await subagents.commandCompletions("subagents", "");
    assert.ok(all?.some((item) => item.value === "stop"));
    assert.ok(all?.some((item) => item.value === listNumber), JSON.stringify(all));

    const stopOnly = await subagents.commandCompletions("subagents", "st");
    assert.deepEqual(stopOnly?.map((item) => item.value), ["stop"]);

    assert.equal(await subagents.commandCompletions("subagents", "zzz-no-match"), null);
  } finally { h.cleanup(); }
});

test("the board's orchestrator state follows the orchestrator's own agent runs, never a worker's", async () => {
  const h = harness();
  try {
    // A lead lists the subagents tool, so its worker loads the subagents extension, whose handlers hear the worker's own agent run.
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const provider = scriptedAnthropic(delegatingScript);
    const subagents = loadSubagents(installedWithSubagents(provider.extension, 1));
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const seen: string[] = [];
    const unsubscribe = workerBoard().subscribe(() => { seen.push(workerBoard().orchestratorState()); });
    try {
      const { worker } = await callSubagents(subagents.tool(), main.ctx, "Look around", "lead");
      assert.equal(worker.status, "completed", JSON.stringify(worker));
      assert.ok(seen.length > 0, "the worker changed the board");
      assert.deepEqual([...new Set(seen)], ["idle"], "a worker's run is not the orchestrator's");

      await subagents.agentEvent("agent_start", main.ctx);
      assert.equal(workerBoard().orchestratorState(), "running");
      await subagents.agentEvent("agent_settled", main.ctx);
      assert.equal(workerBoard().orchestratorState(), "idle");
    } finally { unsubscribe(); }
  } finally { h.cleanup(); }
});

/** The orchestrator's own pi session with the subagents extension installed: a
 *  real saved session that loads `provider`, `others` and the subagents
 *  extension, whose workers load `workerExtensions`. */
async function orchestratorSession(h: Harness, provider: InlineExtension, workerExtensions: readonly InlineExtension[], others: readonly InlineExtension[] = [],
  overrides: Partial<SubagentsDependencies> = {}) {
  const services = await createAgentSessionServices({ cwd: h.projectDir, agentDir: h.agentDir, resourceLoaderOptions: {
    extensionFactories: [provider, ...others, { name: "subagents", factory: createSubagentsExtension({ ...overrides, workerExtensions }) }],
  } });
  const model = services.modelRuntime.getModel("anthropic", "claude-haiku-4-5");
  assert.ok(model, "the fake provider serves claude-haiku-4-5");
  const sessionManager = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
  const { session } = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "low" });
  await session.bindExtensions({});
  return session;
}

test("the orchestrator's session has the protocol in its system prompt on every turn, after a compaction too", async () => {
  const h = harness({ orchestrator: { routing: ROUTING }, compaction: { keepRecentTokens: 1 } });
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    // Each prompt reads README.md, then answers: two turns. The compaction's summary request has no tools.
    let readNext = false;
    const provider = scriptedAnthropic((request) => {
      if (!readNext || !request.tools.includes("read")) return { text: "done" };
      readNext = false;
      return { toolCall: { name: "read", arguments: { path: "README.md" } } };
    });
    const session = await orchestratorSession(h, provider.extension, [provider.extension]);
    try {
      readNext = true;
      await session.prompt("Read README.md");
      await session.compact();
      assert.ok(session.sessionManager.getBranch().some((entry) => entry.type === "compaction"), "the session was compacted");
      readNext = true;
      await session.prompt("Read README.md again");
    } finally { session.dispose(); }
    const turns = provider.requests.filter((request) => request.tools.length > 0);
    assert.equal(turns.length, 4, "two turns per prompt");
    for (const turn of turns) assert.ok(turn.systemPrompt.includes(orchestratorProtocol(3, "medium")), turn.systemPrompt);
  } finally { h.cleanup(); }
});

/** Resolves once `ready` holds, polling; fails after `timeoutMs`. */
async function until(ready: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("a completion notice that wakes the idle orchestrator runs with the protocol on every turn, after its tool call too", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    // The background worker sleeps first, so its notice arrives after the orchestrator's run has settled.
    const provider = plannedAnthropic((request) => request.tools.includes("bash") && request.toolResults.length === 0
      ? { toolCall: { name: "bash", arguments: { command: "sleep 0.5" } } } : { text: "leaf done" });
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 0));
    const orchestratorRequests = () => provider.requests.filter((request) => request.sessionId === session.sessionId);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push({ toolCall: { name: "subagents", arguments: { items: [{ task: "Find the config file" }], background: true } } },
        { text: "started" }, READ, { text: "judged" });
      await session.prompt("Start a background worker");
      assert.equal(orchestratorRequests().length, 2, "the prompt's run settled before the notice");
      await until(() => orchestratorRequests().length === 4 && session.isIdle, "the run the notice started");
    } finally { session.dispose(); }
    const woken = orchestratorRequests().slice(2);
    const notice = woken[0]!.userMessages.find((text) => text.includes("Background subagents call"));
    assert.ok(notice?.includes("leaf done"), `the worker ran and finished: ${notice}`);
    assert.equal(woken[1]!.toolResults.length, woken[0]!.toolResults.length + 1, "the second turn follows the read");
    for (const request of woken) assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium")), request.systemPrompt);
  } finally { h.cleanup(); }
});

test("a worker's question sent with triggerTurn wakes the idle orchestrator with the protocol on every turn", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    let api: ExtensionAPI | undefined;
    const waker: InlineExtension = { name: "waker", factory: (pi) => { api = pi; } };
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [waker]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push({ text: "ready" }, READ, { text: "answered" });
      await session.prompt("Wait for questions");
      // As report.ts sends a worker's question.
      await api!.sendMessage({ customType: "worker-question", content: "A worker asks: which config?", display: true }, { triggerTurn: true, deliverAs: "steer" });
      await until(() => provider.requests.length === 3 && session.isIdle, "the woken run");
    } finally { session.dispose(); }
    const woken = provider.requests.slice(1);
    assert.ok(woken[0]!.userMessages.some((text) => text.includes("which config?")), JSON.stringify(woken[0]!.userMessages));
    for (const request of woken) assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium")), request.systemPrompt);
  } finally { h.cleanup(); }
});

test("a typed skill prompt keeps the protocol when an extension loaded earlier forces the whole system prompt", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    mkdirSync(join(h.agentDir, "skills", "survey"), { recursive: true });
    writeFileSync(join(h.agentDir, "skills", "survey", "SKILL.md"), "---\nname: survey\ndescription: Survey the project\n---\n\nRead the README first.\n");
    // Like pi-claude-rules: returns the prompt it was handed plus its own section, which forces that text for the run.
    const forcing: InlineExtension = { name: "forcing-rules", factory: (pi) => { pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n## Project rules` })); } };
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [forcing]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, { text: "surveyed" });
      await session.prompt("/skill:survey the project");
    } finally { session.dispose(); }
    assert.equal(provider.requests.length, 2);
    assert.ok(provider.requests[0]!.userMessages[0]!.includes("Read the README first."), "the skill was expanded");
    for (const request of provider.requests) {
      assert.ok(request.systemPrompt.includes("## Project rules"), "the forced prompt is what the model got");
      assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium")), request.systemPrompt);
    }
  } finally { h.cleanup(); }
});

// The usage line (PRD cml8, user story 54): the orchestrator's protocol ends
// with one line of what the usage store knows, on every request of every run.

/** 12:00 on 29 September 2026, local time: the usage line shows local reset times. */
const USAGE_NOON = new Date(2026, 8, 29, 12, 0);
const atLocal = (hours: number, minutes = 0) => new Date(2026, 8, 29, hours, minutes).toISOString();

/** Records `observation` for `provider` in the harness's usage store. This
 *  process reads it at once, so scripted provider replies can call it without
 *  waiting; a failed write surfaces as an unhandled rejection. */
function observe(h: Harness, provider: string, observation: UsageObservation): void {
  void recordUsageObservation(usageObservationsPath(h.stateDir), provider, observation);
}

const occurrences = (text: string, part: string) => text.split(part).length - 1;

test("a prompt's run has the usage line once on every request when the usage store has observations", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    observe(h, "anthropic", { state: "exhausted", resetsAt: atLocal(14), observedAt: atLocal(11, 30), source: "error" });
    observe(h, "openai-codex", { state: "available", percentLeft: 62, observedAt: atLocal(11, 45), source: "header" });
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => USAGE_NOON });
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, { text: "read" });
      await session.prompt("Read README.md");
    } finally { session.dispose(); }
    assert.equal(provider.requests.length, 2, "two turns");
    for (const request of provider.requests) {
      assert.ok(request.systemPrompt.includes("usage: anthropic exhausted until 14:00 · openai-codex 62% left"), request.systemPrompt);
      assert.equal(occurrences(request.systemPrompt, "usage:"), 1, request.systemPrompt);
    }
  } finally { h.cleanup(); }
});

test("a run a message starts with triggerTurn has the usage line on every request, as the store holds it by then", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    let api: ExtensionAPI | undefined;
    const waker: InlineExtension = { name: "waker", factory: (pi) => { api = pi; } };
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [waker], { now: () => USAGE_NOON });
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push({ text: "ready" }, READ, { text: "answered" });
      await session.prompt("Wait for questions");
      // A worker ran into Codex's limit while the orchestrator was idle.
      observe(h, "openai-codex", { state: "throttled", resetsAt: atLocal(12, 5), observedAt: atLocal(11, 59), source: "error" });
      await api!.sendMessage({ customType: "worker-question", content: "A worker asks: which config?", display: true }, { triggerTurn: true, deliverAs: "steer" });
      await until(() => provider.requests.length === 3 && session.isIdle, "the woken run");
    } finally { session.dispose(); }
    const [prompted, ...woken] = provider.requests;
    assert.ok(prompted!.systemPrompt.includes(orchestratorProtocol(3, "medium")), prompted!.systemPrompt);
    assert.equal(prompted!.systemPrompt.includes("usage:"), false, "the store was empty when the prompt ran");
    assert.equal(woken.length, 2, "the woken run's two turns");
    for (const request of woken) {
      assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium", "usage: openai-codex throttled until 12:05")), request.systemPrompt);
      assert.equal(occurrences(request.systemPrompt, "usage:"), 1, request.systemPrompt);
    }
  } finally { h.cleanup(); }
});

test("the usage line follows the store within a run: replaced when an observation changes, gone once the limit lifts", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    observe(h, "anthropic", { state: "exhausted", resetsAt: atLocal(14), observedAt: atLocal(11, 30), source: "error" });
    let clock = USAGE_NOON;
    // Three turns: after the first, Codex runs low; after the second, it is 14:01 and Anthropic's limit has lifted.
    const provider = scriptedAnthropic((request) => {
      if (request.toolResults.length === 0) {
        observe(h, "openai-codex", { state: "low", percentLeft: 8, observedAt: atLocal(12, 1), source: "header" });
        return READ;
      }
      if (request.toolResults.length === 1) { clock = new Date(2026, 8, 29, 14, 1); return READ; }
      return { text: "read twice" };
    });
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => clock });
    try { await session.prompt("Read README.md twice"); } finally { session.dispose(); }
    const lines = provider.requests.map((request) => request.systemPrompt.split("\n").filter((line) => line.startsWith("usage:")));
    assert.deepEqual(lines, [
      ["usage: anthropic exhausted until 14:00"],
      ["usage: anthropic exhausted until 14:00 · openai-codex low, 8% left"],
      ["usage: openai-codex low, 8% left"],
    ]);
    for (const request of provider.requests) assert.ok(request.systemPrompt.includes("# Orchestrator protocol"), request.systemPrompt);
  } finally { h.cleanup(); }
});

test("the usage line leaves the protocol once the only limit has lifted during a run", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    observe(h, "anthropic", { state: "throttled", resetsAt: atLocal(12, 5), observedAt: atLocal(11, 59), source: "error" });
    let clock = USAGE_NOON;
    const provider = scriptedAnthropic((request) => {
      if (request.toolResults.length > 0) return { text: "read" };
      clock = new Date(2026, 8, 29, 12, 6);
      return READ;
    });
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => clock });
    try { await session.prompt("Read README.md"); } finally { session.dispose(); }
    const [first, second] = provider.requests;
    assert.ok(first!.systemPrompt.includes(orchestratorProtocol(3, "medium", "usage: anthropic throttled until 12:05")), first!.systemPrompt);
    assert.ok(second!.systemPrompt.includes(orchestratorProtocol(3, "medium")), second!.systemPrompt);
    assert.equal(second!.systemPrompt.includes("usage:"), false, second!.systemPrompt);
  } finally { h.cleanup(); }
});

test("the usage line leaves out a header reading past its window's reset, or five hours old without one", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    observe(h, "anthropic", { state: "available", percentLeft: 71, resetsAt: atLocal(12, 5), observedAt: atLocal(11, 40), source: "header" });
    observe(h, "openai-codex", { state: "low", percentLeft: 8, resetsAt: atLocal(12, 5), observedAt: atLocal(11, 50), source: "header" });
    // Read at 6:59 without a reset: it holds until 11:59, so it is out already.
    observe(h, "zai", { state: "available", percentLeft: 40, observedAt: atLocal(6, 59), source: "header" });
    let clock = USAGE_NOON;
    const provider = scriptedAnthropic((request) => {
      if (request.toolResults.length > 0) return { text: "read" };
      clock = new Date(2026, 8, 29, 12, 6);
      return READ;
    });
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => clock });
    try { await session.prompt("Read README.md"); } finally { session.dispose(); }
    const [first, second] = provider.requests;
    assert.ok(first!.systemPrompt.includes(orchestratorProtocol(3, "medium", "usage: anthropic 71% left · openai-codex low, 8% left")), first!.systemPrompt);
    assert.equal(second!.systemPrompt.includes("usage:"), false, second!.systemPrompt);
  } finally { h.cleanup(); }
});

test("a prompt an earlier extension forces carries the usage line once, as the run started", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    observe(h, "openai-codex", { state: "available", percentLeft: 62, observedAt: atLocal(11, 45), source: "header" });
    const forcing: InlineExtension = { name: "forcing-rules", factory: (pi) => { pi.on("before_agent_start", (event) => ({ systemPrompt: `${event.systemPrompt}\n\n## Project rules` })); } };
    // After the first turn Anthropic runs into a limit. pi projects the forced text onto every request of the
    // run, after the context handlers (agent-session.js _installAgentForcedPromptProjection), so the run keeps
    // the line it started with: never a second one.
    const provider = scriptedAnthropic((request) => {
      if (request.toolResults.length > 0) return { text: "read" };
      observe(h, "anthropic", { state: "throttled", resetsAt: atLocal(12, 5), observedAt: atLocal(12, 0), source: "error" });
      return READ;
    });
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [forcing], { now: () => USAGE_NOON });
    try { await session.prompt("Read README.md"); } finally { session.dispose(); }
    assert.equal(provider.requests.length, 2);
    for (const request of provider.requests) assert.ok(request.systemPrompt.includes("## Project rules"), "the forced prompt is what the model got");
    const lines = provider.requests.map((request) => request.systemPrompt.split("\n").filter((line) => line.startsWith("usage:")));
    assert.deepEqual(lines, [["usage: openai-codex 62% left"], ["usage: openai-codex 62% left"]]);
    const [first, second] = provider.requests;
    assert.ok(first!.systemPrompt.includes(orchestratorProtocol(3, "medium", "usage: openai-codex 62% left")), first!.systemPrompt);
    assert.equal(occurrences(second!.systemPrompt, "# Orchestrator protocol"), 1, second!.systemPrompt);
  } finally { h.cleanup(); }
});

test("no worker gets the usage line: not a routed worker, not a forked worker", async () => {
  const h = harness();
  try {
    // Not a limit, so routing still serves the fake Anthropic provider.
    observe(h, "openai-codex", { state: "available", percentLeft: 62, observedAt: atLocal(11, 45), source: "header" });
    const items = [{ task: "Find the config file" }, { task: "Finish the work", fork: true }];
    let orchestratorId: string | undefined;
    const provider = scriptedAnthropic((request) => request.sessionId !== orchestratorId ? { text: "leaf done" }
      : request.toolResults.length === 0 ? { toolCall: { name: "subagents", arguments: { items } } } : { text: "done" });
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 0), [], { now: () => USAGE_NOON });
    try {
      orchestratorId = session.sessionId;
      await session.prompt("Hand out the work");
    } finally { session.dispose(); }
    const orchestratorRequests = provider.requests.filter((request) => request.sessionId === orchestratorId);
    assert.equal(orchestratorRequests.length, 2);
    for (const request of orchestratorRequests) assert.ok(request.systemPrompt.includes("usage: openai-codex 62% left"), request.systemPrompt);
    const workerRequests = provider.requests.filter((request) => request.sessionId !== orchestratorId);
    assert.equal(new Set(workerRequests.map((request) => request.sessionId)).size, 2, "a routed worker and a forked worker");
    for (const request of workerRequests) assert.equal(request.systemPrompt.includes("usage:"), false, request.systemPrompt);
  } finally { h.cleanup(); }
});

test("the usage line marks an estimated lift time, dates one on another day, and names a state without a percentage", async () => {
  const h = harness();
  try {
    observe(h, "anthropic", { state: "exhausted", observedAt: atLocal(11, 30), source: "error" });
    observe(h, "google", { state: "throttled", resetsAt: new Date(2026, 8, 30, 9, 0).toISOString(), observedAt: atLocal(11, 50), source: "error" });
    observe(h, "openai-codex", { state: "low", observedAt: atLocal(11, 55), source: "header" });
    observe(h, "zai", { state: "available", observedAt: atLocal(11, 56), source: "header" });
    // Lifted at 11:59, so left out.
    observe(h, "mistral", { state: "throttled", resetsAt: atLocal(11, 59), observedAt: atLocal(11, 58), source: "error" });
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => USAGE_NOON });
    try {
      provider.setOrchestrator(session.sessionId);
      await session.prompt("Say done");
    } finally { session.dispose(); }
    assert.equal(provider.requests.length, 1);
    assert.ok(provider.requests[0]!.systemPrompt.includes(orchestratorProtocol(3, "medium",
      "usage: anthropic exhausted until about 16:30 · google throttled until 2026-09-30 09:00 · openai-codex low · zai available")),
    provider.requests[0]!.systemPrompt);
  } finally { h.cleanup(); }
});

test("an empty usage store adds no usage line to any request", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [], { now: () => USAGE_NOON });
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, { text: "read" });
      await session.prompt("Read README.md");
    } finally { session.dispose(); }
    assert.equal(existsSync(usageObservationsPath(h.stateDir)), false, "no store file");
    assert.equal(provider.requests.length, 2);
    for (const request of provider.requests) {
      assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium")), request.systemPrompt);
      assert.equal(request.systemPrompt.includes("usage:"), false, request.systemPrompt);
    }
  } finally { h.cleanup(); }
});

test("a pi-subagents child's session gets no protocol", async () => {
  const h = harness();
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    const provider = scriptedAnthropic(() => ({ text: "done" }));
    const session = await orchestratorSession(h, provider.extension, [provider.extension]);
    try { await session.prompt("Say done"); } finally { session.dispose(); }
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0]!.systemPrompt.includes("Orchestrator protocol"), false, provider.requests[0]!.systemPrompt);
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
    h.cleanup();
  }
});

test("no worker gets the protocol: not a routed worker, not one that delegates, not a forked worker", async () => {
  const h = harness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    const items = [
      { task: "Find the config file" },
      { task: `Delegate:${JSON.stringify({ items: [{ task: "Find the tests" }] })}`, agent: "lead" },
      { task: "Finish the work", fork: true },
    ];
    // The orchestrator hands out the three items in one call; its workers follow delegatingScript.
    let orchestratorId: string | undefined;
    const provider = scriptedAnthropic((request) => request.sessionId !== orchestratorId ? delegatingScript(request)
      : request.toolResults.length === 0 ? { toolCall: { name: "subagents", arguments: { items } } } : { text: "done" });
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 1));
    let results: readonly SubagentResult[] = [];
    try {
      orchestratorId = session.sessionId;
      await session.prompt("Hand out the work");
      const toolResult = session.messages.find((message) => message.role === "toolResult") as { details?: SubagentsDetails } | undefined;
      results = toolResult?.details?.results ?? [];
    } finally { session.dispose(); }
    assert.deepEqual(results.map((result) => result.status), ["completed", "completed", "completed"], JSON.stringify(results));

    const orchestratorRequests = provider.requests.filter((request) => request.sessionId === orchestratorId);
    assert.equal(orchestratorRequests.length, 2);
    for (const request of orchestratorRequests) assert.ok(request.systemPrompt.includes(orchestratorProtocol(3, "medium")), request.systemPrompt);
    const workerRequests = provider.requests.filter((request) => request.sessionId !== orchestratorId);
    assert.equal(new Set(workerRequests.map((request) => request.sessionId)).size, 4, "three workers and the lead's own worker");
    for (const request of workerRequests) assert.equal(request.systemPrompt.includes("Orchestrator protocol"), false, request.systemPrompt);
    // The fork's copied conversation carried the orchestrator's protocol; its own prompt does not.
    const fork = results[2]!;
    assert.ok(fork.sessionFile && readFileSync(fork.sessionFile, "utf8").includes("Orchestrator protocol"), "the fork's copy has the orchestrator's section");
  } finally { h.cleanup(); }
});

// The exploration nudge (ADR 0013), in the orchestrator's real pi session:
// the model's tool calls go through pi's tool_call and tool_result hooks, and
// the model sees what pi hands it as each call's result.

const READ: ScriptedReply = { toolCall: { name: "read", arguments: { path: "README.md" } } };
/** The exploration nudge after `count` exploratory calls in one user prompt. */
const nudge = (count: number) => `${count} exploratory calls this prompt: consider handing the rest to a worker.`;
const NUDGE = /\d+ exploratory calls? this prompt: consider handing the rest to a worker\.$/;

/** A scripted provider whose orchestrator follows `plan`, one reply per request, then says done; other sessions follow `worker`. */
function plannedAnthropic(worker: (request: ScriptedRequest) => ScriptedReply = () => ({ text: "leaf done" })) {
  const plan: ScriptedReply[] = [];
  let orchestratorId: string | undefined;
  const provider = scriptedAnthropic((request) => request.sessionId !== orchestratorId ? worker(request) : plan.shift() ?? { text: "done" });
  return { ...provider, plan, setOrchestrator: (id: string) => { orchestratorId = id; } };
}

/** The tool results of `session`'s messages from `from` on: the tool and, for a
 *  refused call, its reason, or for one that ran, the exploration nudge its result ends with, if any. */
function toolOutcomes(session: { readonly messages: readonly unknown[] }, from = 0): string[] {
  return (session.messages.slice(from) as { role: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] }[])
    .filter((message) => message.role === "toolResult")
    .map((message) => {
      const text = message.content?.map((part) => part.text ?? "").join("\n") ?? "";
      const nudged = text.match(NUDGE)?.[0];
      if (message.isError) return `${message.toolName} refused: ${text}`;
      return `${message.toolName} ok${nudged === undefined ? "" : ` · ${nudged}`}`;
    });
}

test("past the explorationNudge setting the orchestrator's exploratory calls still run and their results carry the nudge with the count; actions are not counted", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, { toolCall: { name: "write", arguments: { path: "notes.md", content: "x\n" } } }, READ, READ, READ, READ);
      await session.prompt("Look around");
      assert.deepEqual(toolOutcomes(session), ["read ok", "write ok", "read ok", "read ok", `read ok · ${nudge(4)}`, `read ok · ${nudge(5)}`]);
    } finally { session.dispose(); }
    // The model got the file and, after it, the nudge.
    const seen = provider.requests.at(-1)!.toolResults;
    assert.equal(seen.length, 6);
    assert.ok(seen[4]!.text.includes("# Project") && seen[4]!.text.endsWith(nudge(4)), seen[4]!.text);
    assert.equal(seen[4]!.isError, false);
    assert.ok(!seen.slice(0, 4).some((result) => NUDGE.test(result.text)), JSON.stringify(seen));
  } finally { h.cleanup(); }
});

test("only read-only and unrecognised bash calls count toward the exploration nudge", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\\n");
    writeFileSync(join(h.projectDir, "counter.test.js"), 'import test from "node:test"; import assert from "node:assert/strict"; test("counter test", () => assert.equal(1, 1));\\n');
    execFileSync("git", ["init", "-q"], { cwd: h.projectDir });
    execFileSync("git", ["config", "user.name", "Pi test"], { cwd: h.projectDir });
    execFileSync("git", ["config", "user.email", "pi-test@example.invalid"], { cwd: h.projectDir });

    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 1));
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(
        READ,
        { toolCall: { name: "bash", arguments: { command: "node --test" } } },
        { toolCall: { name: "bash", arguments: { command: "git commit --allow-empty -m 'nudge counter test'" } } },
        { toolCall: { name: "subagents", arguments: { items: [{ task: "Finish the no-op task" }] } } },
        { toolCall: { name: "bash", arguments: { command: "git show --stat --oneline HEAD" } } },
        { toolCall: { name: "bash", arguments: { command: 'echo "$(printf ok)"' } } },
        READ,
      );
      await session.prompt("Check the project");
      assert.deepEqual(toolOutcomes(session), [
        "read ok",
        "bash ok",
        "bash ok",
        "subagents ok",
        "bash ok",
        "bash ok",
        `read ok · ${nudge(4)}`,
      ]);
    } finally { session.dispose(); }
  } finally { h.cleanup(); }
});

test("the nudge starts after the owner's explorationNudge setting, and the protocol names it and the owner's gate level", async () => {
  const h = harness({ orchestrator: { routing: ROUTING, subagents: { explorationNudge: 1, gateLevel: "high" } } });
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, READ);
      await session.prompt("Look around");
      assert.deepEqual(toolOutcomes(session), ["read ok", `read ok · ${nudge(2)}`]);
    } finally { session.dispose(); }
    assert.equal(provider.requests.length, 3);
    for (const request of provider.requests) {
      assert.ok(request.systemPrompt.includes(orchestratorProtocol(1, "high")), request.systemPrompt);
      assert.match(request.systemPrompt, /After 1 exploratory call in one user prompt/);
      assert.doesNotMatch(request.systemPrompt, /exploration budget|exploratory call is denied|lift the budget/);
      assert.match(request.systemPrompt, /Your gate level is high\./);
    }
  } finally { h.cleanup(); }
});

test("a new user prompt starts the count again; a prompt an extension sends and a run a message starts count on", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    // A command that starts a run with a message, as a background call's completion notice does.
    const owner: InlineExtension = { name: "owner", factory: (pi) => {
      pi.registerCommand("notice", { description: "A message starts a run", handler: async () => {
        pi.sendMessage({ customType: "test-notice", content: "A worker finished", display: true }, { triggerTurn: true });
      } });
    } };
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension], [owner]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, READ, READ, READ);
      await session.prompt("Look around");
      assert.deepEqual(toolOutcomes(session), ["read ok", "read ok", "read ok", `read ok · ${nudge(4)}`]);

      // A user message an extension sends is not a user prompt.
      let from = session.messages.length;
      provider.plan.push(READ);
      await session.sendUserMessage("Look on");
      assert.deepEqual(toolOutcomes(session, from), [`read ok · ${nudge(5)}`]);

      // Nor is a run a message starts.
      from = session.messages.length;
      provider.plan.push(READ);
      await session.prompt("/notice");
      await session.waitForIdle();
      assert.deepEqual(toolOutcomes(session, from), [`read ok · ${nudge(6)}`]);

      from = session.messages.length;
      provider.plan.push(READ, READ, READ, READ);
      await session.prompt("Look again");
      assert.deepEqual(toolOutcomes(session, from), ["read ok", "read ok", "read ok", `read ok · ${nudge(4)}`]);
    } finally { session.dispose(); }
  } finally { h.cleanup(); }
});

test("workers, forked workers and a pi-subagents child's session are never nudged", async () => {
  const h = harness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents" }, "Split the work.");
    // Each worker reads five times, then reports how many of its reads were refused or nudged.
    const provider = plannedAnthropic((request) => request.toolResults.length < 5 ? READ
      : { text: `refused ${request.toolResults.filter((result) => result.isError).length}, nudged ${request.toolResults.filter((result) => NUDGE.test(result.text)).length}` });
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 1));
    let results: readonly SubagentResult[] = [];
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push({ toolCall: { name: "subagents", arguments: { items: [
        { task: "Read five times" }, { task: "Read five times", agent: "lead" }, { task: "Read five times", fork: true },
      ] } } });
      await session.prompt("Hand out the reading");
      const toolResult = session.messages.find((message) => message.role === "toolResult") as { details?: SubagentsDetails } | undefined;
      results = toolResult?.details?.results ?? [];
    } finally { session.dispose(); }
    assert.deepEqual(results.map((result) => [result.status, result.finalText]), Array(3).fill(["completed", "refused 0, nudged 0"]), JSON.stringify(results));
  } finally { h.cleanup(); }

  const child = harness();
  process.env.PI_SUBAGENT_CHILD = "1";
  try {
    writeFileSync(join(child.projectDir, "README.md"), "# Project\n");
    const provider = plannedAnthropic();
    const session = await orchestratorSession(child, provider.extension, [provider.extension]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(READ, READ, READ, READ, READ);
      await session.prompt("Look around");
      assert.deepEqual(toolOutcomes(session), Array(5).fill("read ok"));
    } finally { session.dispose(); }
  } finally {
    delete process.env.PI_SUBAGENT_CHILD;
    child.cleanup();
  }
});

test("/pi-orchestrator has no budget subcommand", async () => {
  const h = harness();
  try {
    const subagents = loadSubagents([]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const [shown = ""] = await subagents.runCommand("pi-orchestrator", "budget off", main.ctx);
    assert.match(shown, /^pi-orchestrator: unknown subcommand 'budget'\./);
    assert.ok(shown.includes("  gate: ") && !shown.includes("  budget: "), shown);
  } finally { h.cleanup(); }
});

// Verdicts on editing delegations (ADR 0010): a worker that edits leaves an
// edit record behind it, its Result tells the orchestrator to judge it, and
// subagents_verdict records the verdict on the decision record.

const EDITED_LINE = "This delegation edited. Judge its Result, then record a verdict with subagents_verdict.";

/** A worker makes one tool call for each of its user messages that starts with
 *  "Run:" (`{ "name": ..., "arguments": ... }` as JSON after it), then says
 *  "ran"; a worker with none follows delegatingScript. */
function runningScript(request: ScriptedRequest): ScriptedReply {
  const runs = request.userMessages.filter((message) => message.startsWith("Run:"));
  if (runs.length === 0) return delegatingScript(request);
  if (request.toolResults.length >= runs.length) return { text: "ran" };
  return { toolCall: JSON.parse(runs.at(-1)!.slice("Run:".length)) as { name: string; arguments: Record<string, unknown> } };
}

/** A task that makes the worker call `name` with `args` once. */
const runTask = (name: string, args: Record<string, unknown>) => `Run:${JSON.stringify({ name, arguments: args })}`;

/** Installed tools a worker may have besides pi's built-ins: context-mode's
 *  ctx_execute, and a guard that blocks writing blocked.txt. */
const CTX_AND_GUARD: InlineExtension = { name: "ctx-and-guard", factory: (pi) => {
  pi.registerTool({
    name: "ctx_execute", label: "ctx_execute", description: "Runs code.",
    parameters: { type: "object", properties: { code: { type: "string" } } } as unknown as Tool["parameters"],
    async execute() { return { content: [{ type: "text", text: "ran" }], details: undefined }; },
  });
  pi.on("tool_call", (event) => (event.input as { path?: string }).path === "blocked.txt" ? { block: true, reason: "blocked by the guard" } : undefined);
} };

function editRecords(h: Harness) {
  return readRoutingRecords(join(h.stateDir, "routing")).flatMap((record) => record.recordType === "edit" ? [record] : []);
}

/** Each gate requirement record as [delegation id, gate level, gate action], in file order. */
function gateRequirements(h: Harness): [string, string, string][] {
  return readRoutingRecords(join(h.stateDir, "routing"))
    .flatMap((record) => record.recordType === "gate-requirement" ? [[record.delegationId, record.gateLevel, record.gateAction] as [string, string, string]] : []);
}

/** The report's gate counts over every routed delegation. */
function reportGate(h: Harness) {
  const { verdicts, sameRungVerdicts, ungated, missing } = buildRoutingReport(join(h.stateDir, "routing")).totals;
  return { verdicts, sameRungVerdicts, ungated, missing };
}

async function recordVerdict(subagents: LoadedSubagents, ctx: ExtensionContext, params: Record<string, unknown>): Promise<string> {
  const result = await subagents.tool("subagents_verdict").execute("verdict-call", params as never, undefined, undefined, ctx);
  return toolText(result);
}

async function refusal(subagents: LoadedSubagents, ctx: ExtensionContext, params: Record<string, unknown>): Promise<string> {
  try { await recordVerdict(subagents, ctx, params); } catch (error) { return (error as Error).message; }
  assert.fail(`subagents_verdict accepted ${JSON.stringify(params)}`);
}

function routedHarness(settings?: Record<string, unknown>): Harness {
  const h = harness(settings);
  mkdirSync(h.stateDir, { recursive: true });
  saveAuthorization(join(h.stateDir, "authorized-recipients.json"), approvedAnthropic());
  return h;
}

test("edit, write, unrecognised bash, git and ctx_execute in a worker make its delegation editing; reads, builds and blocked calls do not", async () => {
  const h = routedHarness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    writeFileSync(join(h.projectDir, "index.js"), "export const x = 1;\n");
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension, CTX_AND_GUARD]);
    const main = orchestrator(h);
    const editing = [
      runTask("write", { path: "notes.md", content: "x\n" }),
      runTask("edit", { path: "README.md", edits: [{ oldText: "# Project", newText: "# The project" }] }),
      runTask("bash", { command: "echo hi > out.txt" }),
      runTask("bash", { command: "git commit -m wip" }),
      runTask("ctx_execute", { code: "ls" }),
    ];
    const notEditing = [
      runTask("read", { path: "README.md" }),
      runTask("bash", { command: "rg Project README.md" }),
      runTask("bash", { command: "node --check index.js" }),
      runTask("write", { path: "blocked.txt", content: "x\n" }),
    ];
    const call = async (id: string, tasks: readonly string[]) => {
      const result = await subagents.tool().execute(id, { items: tasks.map((task) => ({ task })) } as never, undefined, undefined, main.ctx);
      const { results } = result.details as SubagentsDetails;
      assert.deepEqual(results.map((worker) => worker.status), tasks.map(() => "completed"), JSON.stringify(results));
      // Each item's text in the tool result, split at the next item's first line.
      return { results, texts: toolText(result).split(/\n\n(?=Worker )/) };
    };
    const edited = await call("call-edits", editing);
    assert.deepEqual(edited.results.map((worker) => worker.edited), Array(5).fill(true));
    assert.deepEqual(edited.texts.map((text) => text.includes(EDITED_LINE)), Array(5).fill(true), edited.texts.join("\n---\n"));
    const unedited = await call("call-reads", notEditing);
    assert.deepEqual(unedited.results.map((worker) => worker.edited), Array(4).fill(undefined));
    assert.deepEqual(unedited.texts.map((text) => text.includes(EDITED_LINE)), Array(4).fill(false));
    assert.equal(existsSync(join(h.projectDir, "blocked.txt")), false, "the guard blocked the write");
    // The edit outlives the worker: one record per editing delegation, naming the orchestrator's session.
    // Workers run in parallel, so the records come in the order the edits ran.
    const byDelegation = (rows: readonly (readonly unknown[])[]) => [...rows].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    assert.deepEqual(byDelegation(editRecords(h).map((record) => [record.delegationId, record.tool, record.orchestratorSession, record.nestedDelegationId])),
      byDelegation(edited.results.map((worker, index) => [worker.sessionId, ["write", "edit", "bash", "bash", "ctx_execute"][index], main.sessionId, undefined])));
  } finally { h.cleanup(); }
});

// Editing detection from the working tree (pi-orchestrator-6c1p): in a git
// repository a delegation is editing when the working tree (tracked changes
// plus untracked files) differs between its worker's start and end, or when
// the worker ran edit or write. Without a repository the command rule above stays.

/** The orchestrator's context with `dir`, a git repository, as its working directory. */
function orchestratorIn(h: Harness, dir: string): Orchestrator {
  const sessionManager = SessionManager.create(dir, join(h.agentDir, "sessions", "--repo--"));
  const ctx = { cwd: dir, hasUI: false, sessionManager } as unknown as ExtensionContext;
  return { ctx, sessionDir: sessionManager.getSessionDir(), sessionId: sessionManager.getSessionId() };
}

/** One subagents call of `tasks` in parallel: each worker's result and its item's text in the tool result. */
async function runItems(subagents: LoadedSubagents, ctx: ExtensionContext, id: string, tasks: readonly string[]) {
  const result = await subagents.tool().execute(id, { items: tasks.map((task) => ({ task })) } as never, undefined, undefined, ctx);
  const { results } = result.details as SubagentsDetails;
  assert.deepEqual(results.map((worker) => worker.status), tasks.map(() => "completed"), JSON.stringify(results));
  return { results, texts: toolText(result).split(/\n\n(?=Worker )/) };
}

test("in a git repository, bash that changed nothing is not editing and asks no verdict; bash that changed the tree is editing, and its reviewer gets the changed paths", async () => {
  const h = routedHarness();
  const repo = createTempRepo();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestratorIn(h, repo.dir);
    // Each of these commands made a delegation editing by the command rule.
    const unchanged = await runItems(subagents, main.ctx, "call-unchanged", [
      runTask("bash", { command: "node -e \"console.log(1)\"" }),
      runTask("bash", { command: `git stash list > /dev/null; mkdir -p ${join(h.agentDir, "probe")}` }),
    ]);
    assert.deepEqual(unchanged.results.map((worker) => worker.edited), [undefined, undefined]);
    assert.deepEqual(unchanged.texts.map((text) => text.includes(EDITED_LINE)), [false, false], unchanged.texts.join("\n---\n"));
    assert.deepEqual(editRecords(h), []);
    assert.deepEqual(gateRequirements(h), [], "no verdict is asked");
    const researchId = unchanged.results[0]!.sessionId!;
    assert.equal(await refusal(subagents, main.ctx, { delegationId: researchId, verdict: "accept", reason: "checked" }),
      `subagents_verdict: delegation ${researchId} did not edit; a research Result is checked but gets no verdict`);

    const changed = await runItems(subagents, main.ctx, "call-changed", [runTask("bash", { command: "echo notes > notes.md && echo more >> README.md" })]);
    const worker = changed.results[0]!;
    assert.equal(worker.edited, true);
    assert.ok(changed.texts[0]!.includes(EDITED_LINE), changed.texts[0]);
    assert.deepEqual(gateRequirements(h), [[worker.sessionId, "medium", "spot-check"]]);
    const review = await subagents.tool().execute("call-review", { items: [{ task: "Check the notes", review: worker.sessionId }] } as never,
      undefined, undefined, main.ctx);
    const reviewer = (review.details as SubagentsDetails).results[0]!;
    assert.equal(reviewer.status, "completed", JSON.stringify(reviewer));
    const prompt = provider.requests.find((request) => request.sessionId === reviewer.sessionId)?.systemPrompt ?? "";
    assert.ok(prompt.includes("Files it changed: README.md, notes.md."), prompt);
  } finally {
    repo.cleanup();
    h.cleanup();
  }
});

test("in a git repository, an edit or write outside it is editing", async () => {
  const h = routedHarness();
  const repo = createTempRepo();
  try {
    writeFileSync(join(h.agentDir, "outside.md"), "# Outside\n");
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestratorIn(h, repo.dir);
    const { results, texts } = await runItems(subagents, main.ctx, "call-outside", [
      runTask("write", { path: join(h.agentDir, "written.md"), content: "x\n" }),
      runTask("edit", { path: join(h.agentDir, "outside.md"), edits: [{ oldText: "# Outside", newText: "# Edited outside" }] }),
    ]);
    assert.equal(readFileSync(join(h.agentDir, "outside.md"), "utf8"), "# Edited outside\n");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: repo.dir, encoding: "utf8" }), "", "the repository did not change");
    assert.deepEqual(results.map((worker) => worker.edited), [true, true]);
    assert.deepEqual(texts.map((text) => text.includes(EDITED_LINE)), [true, true], texts.join("\n---\n"));
  } finally {
    repo.cleanup();
    h.cleanup();
  }
});

test("in a git repository, a change made while two workers ran counts for each of them", async () => {
  const h = routedHarness();
  const repo = createTempRepo();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestratorIn(h, repo.dir);
    // The reader only reads, and the command rule calls it research. The writer changes the tree once the reader runs.
    const started = join(h.agentDir, "reader-started");
    const reader = runTask("bash", { command: "while ! test -f notes.md; do sleep 0.01; done; cat notes.md" });
    const writer = runTask("bash", { command: `while ! test -f ${started}; do sleep 0.01; done; echo notes > notes.md` });
    const call = runItems(subagents, main.ctx, "call-overlap", [reader, writer]);
    await waitFor(() => provider.requests.some((request) => request.task === reader), "the reader's first request");
    writeFileSync(started, "");
    const { results, texts } = await call;
    assert.equal(readFileSync(join(repo.dir, "notes.md"), "utf8"), "notes\n");
    assert.deepEqual(results.map((worker) => worker.edited), [true, true]);
    assert.deepEqual(texts.map((text) => text.includes(EDITED_LINE)), [true, true], texts.join("\n---\n"));
    assert.deepEqual(gateRequirements(h).map(([id]) => id).sort(), results.map((worker) => worker.sessionId!).sort());
    // A worker that starts after the change and changes nothing is not editing.
    const later = await runItems(subagents, main.ctx, "call-later", [runTask("bash", { command: "node -e \"console.log(2)\"" })]);
    assert.equal(later.results[0]!.edited, undefined);
  } finally {
    repo.cleanup();
    h.cleanup();
  }
});

/** A `git` first on PATH that logs its arguments and fails `git status` while
 *  `failing` exists, and otherwise runs the real git. */
function failingGitStatus(dir: string) {
  const realGit = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
  const bin = join(dir, "bin");
  const log = join(dir, "git-args.log");
  const failing = join(dir, "fail-status");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "git"), [
    "#!/bin/sh",
    `echo "GIT_OPTIONAL_LOCKS=$GIT_OPTIONAL_LOCKS $*" >> '${log}'`,
    `case " $* " in *" status "*) if [ -f '${failing}' ]; then echo 'fatal: index.lock exists' >&2; exit 128; fi;; esac`,
    `exec '${realGit}' "$@"`,
    "",
  ].join("\n"));
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  return {
    failing,
    /** Each `git status` this git ran, as `GIT_OPTIONAL_LOCKS=<value> <arguments>`. */
    statusCalls: () => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n").filter((line) => / status( |$)/.test(line)),
    restore: () => { process.env.PATH = path; },
  };
}

test("in a git repository, git status runs without optional locks, and when it fails as a worker starts or ends the worker completes and the command rule decides", async () => {
  const h = routedHarness();
  const repo = createTempRepo();
  const git = failingGitStatus(h.agentDir);
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestratorIn(h, repo.dir);
    // Overlapping workers can git add or commit: a snapshot takes no index.lock.
    const snapshots = await runItems(subagents, main.ctx, "call-locks", [runTask("bash", { command: "cat README.md" })]);
    assert.equal(snapshots.results[0]!.edited, undefined);
    const calls = git.statusCalls();
    assert.equal(calls.length, 2, calls.join("\n"));
    for (const call of calls) assert.match(call, /^GIT_OPTIONAL_LOCKS=0 |--no-optional-locks status /, call);

    // git status fails as the workers start: the command rule decides.
    writeFileSync(git.failing, "");
    const atStart = await runItems(subagents, main.ctx, "call-fail-start", [
      runTask("bash", { command: "cat README.md" }),
      runTask("bash", { command: "echo notes > notes.md" }),
    ]);
    assert.deepEqual(atStart.results.map((worker) => worker.edited), [undefined, true]);
    assert.deepEqual(atStart.texts.map((text) => text.includes(EDITED_LINE)), [false, true], atStart.texts.join("\n---\n"));
    rmSync(git.failing);
    rmSync(join(repo.dir, "notes.md"));

    // git status fails as the workers end: the command rule decides.
    const go = join(h.agentDir, "go");
    const reader = runTask("bash", { command: `while ! test -f ${go}; do sleep 0.01; done; cat README.md` });
    const writer = runTask("bash", { command: `while ! test -f ${go}; do sleep 0.01; done; echo notes > notes.md` });
    const call = runItems(subagents, main.ctx, "call-fail-end", [reader, writer]);
    await waitFor(() => [reader, writer].every((task) => provider.requests.some((request) => request.task === task)), "both workers' first requests");
    writeFileSync(git.failing, "");
    writeFileSync(go, "");
    const atEnd = await call;
    assert.deepEqual(atEnd.results.map((worker) => worker.edited), [undefined, true]);
    assert.deepEqual(atEnd.texts.map((text) => text.includes(EDITED_LINE)), [false, true], atEnd.texts.join("\n---\n"));
    assert.deepEqual(editRecords(h).map((record) => record.tool), ["bash", "bash"], "command-rule edit records, no working-tree record");
  } finally {
    git.restore();
    repo.cleanup();
    h.cleanup();
  }
});

test("without a git repository the command rule decides: bash that is neither read-only nor a build or test is editing", async () => {
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    assert.throws(() => execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: h.projectDir, stdio: "ignore" }), "the project is no repository");
    const { results, texts } = await runItems(subagents, main.ctx, "call-no-repo", [
      runTask("bash", { command: "node -e \"console.log(1)\"" }),
      runTask("bash", { command: "ls" }),
    ]);
    assert.deepEqual(results.map((worker) => worker.edited), [true, undefined]);
    assert.deepEqual(texts.map((text) => text.includes(EDITED_LINE)), [true, false], texts.join("\n---\n"));
  } finally { h.cleanup(); }
});

test("subagents_verdict records accept and request_changes with a reason; the report counts the latest verdict per delegation", async () => {
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const { worker } = await callSubagents(subagents.tool(), main.ctx, runTask("write", { path: "notes.md", content: "x\n" }));
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const id = worker.sessionId!;
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "request_changes", reason: "notes.md lacks a heading" }),
      `Recorded request_changes on delegation ${id}. The effort ladder cannot place it: routing is off, so no tier map is loaded to climb. ` +
      `A retry runs on the session model, climb 1 of 2. To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`);
    const recordDir = join(h.stateDir, "routing");
    assert.deepEqual(buildRoutingReport(recordDir).totals.verdicts, { accept: 0, request_changes: 1 });
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked notes.md:1" }),
      `Recorded accept on delegation ${id}. It replaces the earlier request_changes.`);
    assert.deepEqual(buildRoutingReport(recordDir).totals.verdicts, { accept: 1, request_changes: 0 });
    const records = readRoutingRecords(recordDir);
    const decision = records.find((record) => record.recordType === "decision");
    assert.ok(decision);
    const verdicts = records.flatMap((record) => record.recordType === "verdict" ? [record] : []);
    assert.deepEqual(verdicts.map((record) => [record.delegationId, record.verdict, record.reason]),
      [[id, "request_changes", "notes.md lacks a heading"], [id, "accept", "checked notes.md:1"]]);
    assert.equal(verdicts[0]!.decisionFile, `${decision.timestamp.slice(0, 10)}.jsonl`, "attached to the decision record's day file");
    assert.equal(records.some((record) => record.recordType === "orphaned-verdict"), false);
  } finally { h.cleanup(); }
});

test("subagents_verdict records a verdict past an effort-ladder record and a line the reader cannot validate in the routing log", async () => {
  // pi-orchestrator-zb6t: every pi process appends to the same routing log, so it can hold a record type this
  // session's reader does not know, or a torn line. One such line made every verdict fail.
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const { worker } = await callSubagents(subagents.tool(), main.ctx, runTask("write", { path: "notes.md", content: "x\n" }));
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const id = worker.sessionId!;
    const recordDir = join(h.stateDir, "routing");
    const day = `${readRoutingRecords(recordDir).find((record) => record.delegationId === id)!.timestamp.slice(0, 10)}.jsonl`;
    const ladder = { recordType: "effort-ladder", schemaVersion: "decision-record/3", cause: "effort-ladder", delegationId: "bfa81cd8-0000-4000-8000-000000000001",
      timestamp: new Date().toISOString(), previousDecisionId: "01a0e824-0000-4000-8000-000000000001", step: "unplaced", mode: "live",
      detail: "its rung openai-codex/gpt-6-sol:high has no position in the elevated tier of the tier map", taskTextPrefix: "Retry of delegation", agentRole: "unknown" };
    appendFileSync(join(recordDir, day), `${JSON.stringify(ladder)}\n${JSON.stringify({ ...ladder, step: "sideways" })}\n{"recordType":"fail\n`);
    const lines = readFileSync(join(recordDir, day), "utf8").trimEnd().split("\n").length;
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked notes.md:1" }),
      `Recorded accept on delegation ${id}. Skipped 2 routing record lines of other delegations that this session cannot read ` +
      `(${day}:${lines - 1}, ${day}:${lines}); /reload may be needed.`);
    assert.match(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "request_changes", reason: "notes.md lacks a heading" }),
      new RegExp(`^Recorded request_changes on delegation ${id}\\. It replaces the earlier accept\\. The effort ladder cannot place it`));
    const { entries, skipped } = readUsableRoutingRecordEntries(recordDir);
    assert.deepEqual(entries.flatMap(({ record }) => record.recordType === "verdict" ? [[record.delegationId, record.verdict]] : []), [[id, "accept"], [id, "request_changes"]]);
    assert.deepEqual(skipped.map((line) => [line.file, line.error.field]), [[day, "step"], [day, "(record)"]], "the unplaced ladder record is read, the other two are skipped");
  } finally { h.cleanup(); }
});

test("subagents_verdict records a verdict beside the reported line: an unplaced effort-ladder record without kindOfWork that retries the judged delegation", async () => {
  // pi-orchestrator-zb6t: 2026-09-28.jsonl:107 as it was written, with the judged delegation's id as the one it retries.
  const line107 = '{"recordType":"effort-ladder","schemaVersion":"decision-record/3","cause":"effort-ladder","delegationId":"bfa81cd8-489b-446a-97ec-3d0f7fa281e7",' +
    '"timestamp":"2026-09-28T13:36:41.308Z","previousDecisionId":"01a0e824-041a-7117-8a16-1e255bab01b4","step":"unplaced","mode":"live",' +
    '"detail":"its rung openai-codex/gpt-6-sol:high has no position in the elevated tier of the tier map",' +
    '"taskTextPrefix":"Retry of delegation 01a0e824-041a-7117-8a16-1e255bab01b4, whose changes were requested. Do its task again and address every point ' +
    'of the feedback. Its changes are still in the working tree unless the ","agentRole":"unknown"}';
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const { worker } = await callSubagents(subagents.tool(), main.ctx, runTask("write", { path: "notes.md", content: "x\n" }));
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    const id = worker.sessionId!;
    const recordDir = join(h.stateDir, "routing");
    const decision = readRoutingRecords(recordDir).find((record) => record.recordType === "decision" && record.delegationId === id)!;
    const ladder = JSON.parse(line107) as Record<string, unknown>;
    assert.equal("kindOfWork" in ladder, false);
    appendFileSync(join(recordDir, `${decision.timestamp.slice(0, 10)}.jsonl`), `${line107.replaceAll("01a0e824-041a-7117-8a16-1e255bab01b4", id)}\n`);
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked notes.md:1" }), `Recorded accept on delegation ${id}.`);
    assert.deepEqual(readUsableRoutingRecordEntries(recordDir).skipped, [], "the ladder record reads");
  } finally { h.cleanup(); }
});

test("subagents_verdict refuses an unknown or non-editing delegation, a running one, another orchestrator session's, and a bad verdict or blank reason", async () => {
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript, (request) => request.task === "Hold on");
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const research = await callSubagents(subagents.tool(), main.ctx, "Look around");
    const editing = await callSubagents(subagents.tool(), main.ctx, runTask("write", { path: "notes.md", content: "x\n" }));
    const researchId = research.worker.sessionId!, editingId = editing.worker.sessionId!;
    const accept = (delegationId: string) => ({ delegationId, verdict: "accept", reason: "checked" });

    assert.equal(await refusal(subagents, main.ctx, accept("0b7c7a5e-0000-4000-8000-000000000000")),
      "subagents_verdict: unknown delegation id 0b7c7a5e-0000-4000-8000-000000000000");
    assert.equal(await refusal(subagents, main.ctx, accept(researchId)),
      `subagents_verdict: delegation ${researchId} did not edit; a research Result is checked but gets no verdict`);
    assert.equal(await refusal(subagents, orchestrator(h).ctx, accept(editingId)),
      `subagents_verdict: delegation ${editingId} belongs to another orchestrator session`);
    assert.equal(await refusal(subagents, main.ctx, { delegationId: editingId, verdict: "maybe", reason: "checked" }),
      "subagents_verdict requires a delegationId, a verdict of accept or request_changes, and a reason");
    assert.equal(await refusal(subagents, main.ctx, { delegationId: editingId, verdict: "accept", reason: "  " }),
      "subagents_verdict requires a delegationId, a verdict of accept or request_changes, and a reason");

    const stop = new AbortController();
    const held = subagents.tool().execute("call-hold", { items: [{ task: "Hold on" }] } as never, stop.signal, undefined, main.ctx);
    await waitFor(() => provider.requests.some((request) => request.task === "Hold on"), "the held worker's first request");
    const heldId = provider.requests.find((request) => request.task === "Hold on")!.sessionId!;
    assert.equal(await refusal(subagents, main.ctx, accept(heldId)),
      `subagents_verdict: delegation ${heldId} is still running; judge its Result once it has finished`);
    stop.abort();
    await held;

    // A worker cannot record verdicts on the orchestrator's delegations.
    const unmark = markWorkerSession(main.sessionId);
    try {
      assert.equal(await refusal(subagents, main.ctx, accept(editingId)), "subagents_verdict: only the orchestrator records verdicts");
    } finally { unmark(); }
    assert.equal(readRoutingRecords(join(h.stateDir, "routing")).some((record) => record.recordType === "verdict" || record.recordType === "orphaned-verdict"), false,
      "a refused verdict is not recorded");
  } finally { h.cleanup(); }
});

test("a worker's own worker's edits count for the delegation that started it, which alone takes the verdict", async () => {
  const h = routedHarness();
  try {
    writeAgentDefinition(join(h.agentDir, "agents"), "lead.md", { name: "lead", description: "Delegates", tools: "read, subagents, subagents_verdict" }, "Split the work.");
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents(installedWithSubagents(provider.extension, 1));
    const main = orchestrator(h);
    const { worker, text } = await callSubagents(subagents.tool(), main.ctx,
      `Delegate:${JSON.stringify({ items: [{ task: runTask("write", { path: "notes.md", content: "x\n" }) }] })}`, "lead");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.edited, true);
    assert.ok(text.includes(EDITED_LINE), text);
    const leadRequests = provider.requests.filter((request) => request.sessionId === worker.sessionId);
    assert.equal(leadRequests[0]?.tools.includes("subagents_verdict"), false, "a worker never gets subagents_verdict");
    assert.equal(leadRequests.at(-1)?.toolResults[0]?.text.includes(EDITED_LINE), false, "the lead is not asked for a verdict");
    const [record, ...others] = editRecords(h);
    assert.deepEqual(others, []);
    assert.ok(record);
    const nestedId = record.nestedDelegationId!;
    assert.equal(record.delegationId, worker.sessionId);
    assert.equal(record.orchestratorSession, main.sessionId);
    assert.equal(provider.requests.some((request) => request.sessionId === nestedId), true, "the nested worker made the edit");
    assert.equal(await refusal(subagents, main.ctx, { delegationId: nestedId, verdict: "accept", reason: "checked" }),
      `subagents_verdict: delegation ${nestedId} is a worker's own worker; its edits count for delegation ${worker.sessionId}, so record the verdict there`);
    // Only the lead's delegation has a gate requirement, recorded as it ended.
    assert.deepEqual(gateRequirements(h), [[worker.sessionId, "medium", "spot-check"]]);
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: worker.sessionId!, verdict: "accept", reason: "checked notes.md" }),
      `Recorded accept on delegation ${worker.sessionId}.`);
  } finally { h.cleanup(); }
});

test("a resumed delegation's edits belong to it, and its verdict attaches to its one decision record", async () => {
  const h = routedHarness();
  try {
    writeFileSync(join(h.projectDir, "README.md"), "# Project\n");
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const first = await callSubagents(subagents.tool(), main.ctx, runTask("read", { path: "README.md" }));
    const id = first.worker.sessionId!;
    assert.equal(first.worker.edited, undefined);
    assert.equal(await refusal(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked" }),
      `subagents_verdict: delegation ${id} did not edit; a research Result is checked but gets no verdict`);
    const resumed = await subagents.tool().execute("call-2", { items: [{ resume: id, task: runTask("write", { path: "notes.md", content: "x\n" }) }] } as never,
      undefined, undefined, main.ctx);
    const worker = (resumed.details as SubagentsDetails).results[0]!;
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.equal(worker.sessionId, id);
    assert.equal(worker.edited, true);
    assert.ok(toolText(resumed).includes(EDITED_LINE));
    assert.deepEqual(editRecords(h).map((record) => record.delegationId), [id]);
    // The research run recorded no gate requirement; the editing resume did, as it ended.
    assert.deepEqual(gateRequirements(h), [[id, "medium", "spot-check"]]);
    const none = { accept: 0, request_changes: 0 };
    assert.deepEqual(reportGate(h), { verdicts: none, sameRungVerdicts: none, ungated: 0, missing: 1 });
    assert.equal(await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked notes.md" }), `Recorded accept on delegation ${id}.`);
    assert.deepEqual(buildRoutingReport(join(h.stateDir, "routing")).totals, {
      decisions: 1, verdicts: { accept: 1, request_changes: 0 }, sameRungVerdicts: none, ungated: 0, missing: 0,
      shadowDecisions: 0, shadowAgreements: 0,
    });
    // A resume that only reads records nothing; one that edits again records a fresh requirement, and its verdict is missing again.
    const resume = async (callId: string, task: string) => {
      const result = await subagents.tool().execute(callId, { items: [{ resume: id, task }] } as never, undefined, undefined, main.ctx);
      assert.equal((result.details as SubagentsDetails).results[0]!.status, "completed", toolText(result));
    };
    await resume("call-3", runTask("read", { path: "README.md" }));
    assert.deepEqual(gateRequirements(h), [[id, "medium", "spot-check"]]);
    assert.deepEqual(reportGate(h).missing, 0);
    await resume("call-4", runTask("write", { path: "more.md", content: "y\n" }));
    assert.deepEqual(gateRequirements(h), [[id, "medium", "spot-check"], [id, "medium", "spot-check"]]);
    assert.deepEqual(reportGate(h), { verdicts: { accept: 1, request_changes: 0 }, sameRungVerdicts: none, ungated: 0, missing: 1 });
    await recordVerdict(subagents, main.ctx, { delegationId: id, verdict: "accept", reason: "checked more.md" });
    assert.deepEqual(reportGate(h).missing, 0);
  } finally { h.cleanup(); }
});

test("a verdict on a fork, an agent's named model or an unrouted worker attaches to its record, is never orphaned, and the report counts it", async () => {
  for (const kind of ["fork", "agent-model", "unrouted"] as const) {
    const h = routedHarness({ orchestrator: {
      routing: kind === "unrouted" ? { ...ROUTING, enabled: false } : ROUTING,
      subagents: { agentDefinitionModel: { use: kind === "agent-model" ? "preserve" : "route" } },
    } });
    try {
      writeAgentDefinition(join(h.agentDir, "agents"), "scribe.md", { name: "scribe", description: "Writes", model: HAIKU }, "Write notes.");
      const provider = scriptedAnthropic(runningScript);
      const subagents = loadSubagents([routerExtension(), provider.extension]);
      const parent = SessionManager.create(h.projectDir, join(h.agentDir, "sessions", "--project--"));
      parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
      const ctx = { cwd: h.projectDir, hasUI: false, sessionManager: parent, model: { provider: "anthropic", id: "claude-haiku-4-5" }, thinkingLevel: "low" } as unknown as ExtensionContext;
      const task = runTask("write", { path: "notes.md", content: "x\n" });
      const item = kind === "fork" ? { task, fork: true } : kind === "agent-model" ? { task, agent: "scribe" } : { task };
      const result = await subagents.tool().execute("call-1", { items: [item] } as never, undefined, undefined, ctx);
      const worker = (result.details as SubagentsDetails).results[0]!;
      assert.equal(worker.status, "completed", `${kind}: ${JSON.stringify(worker)}`);
      assert.equal(worker.edited, true, kind);
      const id = worker.sessionId!;
      // Without a tier, each is gated as elevated and needs a reviewer (ADR 0010), which must run on
      // another rung than the worker's: here the session model it falls back to, moved to another effort.
      process.env.PI_ORCHESTRATOR_SESSION_MODEL = `${HAIKU}:high`;
      const review = await subagents.tool().execute("call-2", { items: [{ task: "Check the notes", review: id }] } as never, undefined, undefined, ctx);
      const reviewer = (review.details as SubagentsDetails).results[0]!;
      assert.equal(reviewer.status, "completed", `${kind}: ${JSON.stringify(reviewer)}`);
      assert.equal(await recordVerdict(subagents, ctx, { delegationId: id, verdict: "request_changes", reason: "no heading", reviewer: reviewer.sessionId }),
        `Recorded request_changes on delegation ${id}, reviewed by delegation ${reviewer.sessionId}. ` +
        `The effort ladder cannot place it: routing is off, so no tier map is loaded to climb. A retry runs on the session model, climb 1 of 2. ` +
        `To retry, start a subagents item whose retry is ${id} and whose task is your feedback.`);
      const records = readRoutingRecords(join(h.stateDir, "routing"));
      // The reviewer's decision carries the router's fixed clock, so it may sit in another day file.
      assert.deepEqual(records.map((record) => record.recordType).sort(), (kind === "unrouted" ? ["edit", "gate-requirement", "verdict"] : [kind, "edit", "gate-requirement", "decision", "verdict"]).sort(), kind);
      const report = buildRoutingReport(join(h.stateDir, "routing"));
      assert.equal(report.orphanedVerdicts, 0, kind);
      // Gated as elevated, it needed a reviewer, and got one: nothing is missing.
      assert.deepEqual(report.unrouted, { verdicts: { accept: 0, request_changes: 1 }, sameRungVerdicts: { accept: 0, request_changes: 0 }, ungated: 0, missing: 0 }, kind);
    } finally { h.cleanup(); }
  }
});

// The commit gate (ADR 0010, amended by ADR 0013), in the orchestrator's real
// pi session: its git commit and git push always run, and the reminder joins
// their result through pi's tool_result hooks; the turn-end notice goes
// through pi's turn_end event.

/** The custom messages of `type` in `session`'s messages from `from` on, as text. */
function customTexts(session: { readonly messages: readonly unknown[] }, type: string, from = 0): string[] {
  return (session.messages.slice(from) as { role: string; customType?: string; content?: unknown }[])
    .filter((message) => message.role === "custom" && message.customType === type)
    .map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
}

/** A commit of everything in the work tree, empty or not, by the orchestrator, with `message`. */
const commit = (message: string) => `git add -A && git -c user.name=o -c user.email=o@x.test commit -q --allow-empty -m ${message}`;

/** The orchestrator's bash results in `session`'s messages from `from` on:
 *  whether each ran without error, and the reminder it ends with, if any. */
function bashResults(session: { readonly messages: readonly unknown[] }, from = 0): { ok: boolean; reminder?: string }[] {
  return (session.messages.slice(from) as { role: string; toolName?: string; isError?: boolean; content?: { type: string; text?: string }[] }[])
    .filter((message) => message.role === "toolResult" && message.toolName === "bash")
    .map((message) => {
      const last = message.content?.at(-1)?.text ?? "";
      return { ok: message.isError !== true, ...(last.startsWith("pi-orchestrator:") ? { reminder: last } : {}) };
    });
}

/** The reminder a git `action`'s result ends with while `waiting` wait. */
const gateReminder = (action: "commit" | "push", waiting: string) =>
  `pi-orchestrator: git ${action} ran while ${waiting} Judge each Result and record its verdict with \`subagents_verdict\`, ` +
  "or tell the user which verdicts are missing.";

/** The turn-end notice while `waiting` wait. */
const unjudgedNotice = (waiting: string) => `pi-orchestrator: ${waiting} Judge each Result and record its verdict with \`subagents_verdict\`.`;

/** The subjects of the commits `dir`'s HEAD reaches, newest first. */
const commitLog = (dir: string) => execFileSync("git", ["log", "--format=%s", "HEAD"], { cwd: dir, encoding: "utf8" }).trim().split("\n");

test("a commit or push with editing delegations waiting goes through, and its result names each one; the report counts them missing until judged", async () => {
  const h = routedHarness();
  try {
    execFileSync("git", ["init", "-q"], { cwd: h.projectDir });
    const origin = join(h.agentDir, "origin.git");
    execFileSync("git", ["init", "-q", "--bare", origin]);
    execFileSync("git", ["remote", "add", "origin", origin], { cwd: h.projectDir });
    writeAgentDefinition(join(h.agentDir, "agents"), "scribe.md", { name: "scribe", description: "Commits", tools: "bash" }, "Commit.");
    const provider = plannedAnthropic(runningScript);
    // Workers load the subagents extension too, and with it the gate's hooks.
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 1), [routerExtension()]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(
        { toolCall: { name: "subagents", arguments: { items: [{ task: runTask("write", { path: "notes.md", content: "x\n" }) }] } } },
        { toolCall: { name: "bash", arguments: { command: commit("orchestrator") } } },
        { toolCall: { name: "bash", arguments: { command: "git -C . push -q origin HEAD" } } },
        { toolCall: { name: "bash", arguments: { command: "ls" } } },
        { toolCall: { name: "subagents", arguments: { items: [{ agent: "scribe",
          task: runTask("bash", { command: "git -c user.name=w -c user.email=w@x.test commit -q --allow-empty -m worker" }) }] } } },
        { toolCall: { name: "bash", arguments: { command: "git status --short; git push -q origin HEAD" } } },
      );
      await session.prompt("Write the notes, commit and push them");
      const results = (session.messages as { role: string; toolName?: string; details?: SubagentsDetails }[])
        .filter((message) => message.role === "toolResult" && message.toolName === "subagents").map((message) => message.details!.results[0]!);
      assert.deepEqual(results.map((worker) => [worker.status, worker.edited]), [["completed", true], ["completed", true]], JSON.stringify(results));
      const [writer, scribe] = results.map((worker) => worker.sessionId!) as [string, string];
      const one = `an editing delegation waits for your verdict: delegation ${writer}.`;
      const both = `2 editing delegations wait for your verdict: delegation ${writer}, delegation ${scribe} (agent scribe).`;
      assert.deepEqual(toolOutcomes(session), ["subagents ok", "bash ok", "bash ok", "bash ok", "subagents ok", "bash ok"]);
      assert.deepEqual(bashResults(session), [
        { ok: true, reminder: gateReminder("commit", one) },
        { ok: true, reminder: gateReminder("push", one) },
        { ok: true },
        { ok: true, reminder: gateReminder("push", both) },
      ]);
      assert.deepEqual(commitLog(h.projectDir), ["worker", "orchestrator"], "the orchestrator's commit ran, and the worker's after it");
      assert.deepEqual(commitLog(origin), ["worker", "orchestrator"], "both pushes reached the origin");
      // The verdicts are still missing, and the report counts them.
      assert.equal(reportGate(h).missing, 2);
      // The turn-end notice stays: once after each change, none while nothing changed; the final reply ended the prompt.
      assert.deepEqual(customTexts(session, "subagents-unjudged"), [unjudgedNotice(one), unjudgedNotice(both)]);
      const orchestratorRequests = () => provider.requests.filter((request) => request.sessionId === session.sessionId);
      assert.equal(orchestratorRequests().length, 7, "six tool calls and the final reply; the notices start no turn");
      assert.ok(orchestratorRequests()[1]!.userMessages.some((text) => text.includes(unjudgedNotice(one))), "the notice reaches the orchestrator's next request");

      // A user prompt answered by a final reply alone: the notice follows the reply, once, and starts no turn.
      let from = session.messages.length;
      await session.prompt("Anything left?");
      assert.deepEqual((session.messages.slice(from) as { role: string }[]).map((message) => message.role), ["user", "assistant", "custom"]);
      assert.deepEqual(customTexts(session, "subagents-unjudged", from), [unjudgedNotice(both)]);
      assert.equal(orchestratorRequests().length, 8);

      // Each verdict judges its delegation, request_changes too; once none waits, a commit's result carries no reminder.
      from = session.messages.length;
      provider.plan.push(
        { toolCall: { name: "subagents_verdict", arguments: { delegationId: writer, verdict: "accept", reason: "checked notes.md:1" } } },
        { toolCall: { name: "bash", arguments: { command: commit("judged-one") } } },
        { toolCall: { name: "subagents_verdict", arguments: { delegationId: scribe, verdict: "request_changes", reason: "an empty commit" } } },
        { toolCall: { name: "bash", arguments: { command: commit("judged-both") } } },
      );
      await session.prompt("Record the verdicts and commit");
      assert.deepEqual(toolOutcomes(session, from), ["subagents_verdict ok", "bash ok", "subagents_verdict ok", "bash ok"]);
      assert.deepEqual(bashResults(session, from), [
        { ok: true, reminder: gateReminder("commit", `an editing delegation waits for your verdict: delegation ${scribe} (agent scribe).`) },
        { ok: true },
      ]);
      assert.deepEqual(commitLog(h.projectDir), ["judged-both", "judged-one", "worker", "orchestrator"]);
      // The new prompt names the one still waiting once; once none wait, nothing is said.
      assert.deepEqual(customTexts(session, "subagents-unjudged", from), [unjudgedNotice(`an editing delegation waits for your verdict: delegation ${scribe} (agent scribe).`)]);
      const none = { accept: 0, request_changes: 0 };
      assert.deepEqual(reportGate(h), { verdicts: { accept: 1, request_changes: 1 }, sameRungVerdicts: none, ungated: 0, missing: 0 });
    } finally { session.dispose(); }
  } finally { h.cleanup(); }
});

test("at each gate level a commit's result names only the delegations that need a verdict there, and the report counts an ungated one apart", async () => {
  const h = routedHarness();
  try {
    execFileSync("git", ["init", "-q"], { cwd: h.projectDir });
    const provider = plannedAnthropic(runningScript);
    const session = await orchestratorSession(h, provider.extension, installedWithSubagents(provider.extension, 1), [routerExtension()]);
    try {
      provider.setOrchestrator(session.sessionId);
      await session.prompt("/pi-orchestrator gate low");
      // The classifier says mechanical: at low its gate action is none.
      provider.plan.push(
        { toolCall: { name: "subagents", arguments: { items: [{ task: runTask("write", { path: "notes.md", content: "x\n" }) }] } } },
        { toolCall: { name: "bash", arguments: { command: commit("at-low") } } },
      );
      await session.prompt("Write the notes and commit them");
      const worker = (session.messages as { role: string; toolName?: string; details?: SubagentsDetails }[])
        .find((message) => message.role === "toolResult" && message.toolName === "subagents")!.details!.results[0]!;
      assert.equal(worker.edited, true, JSON.stringify(worker));
      assert.deepEqual(bashResults(session), [{ ok: true }], "an ungated delegation is named in no commit's result");
      assert.deepEqual(customTexts(session, "subagents-unjudged"), [], "nor at the turn end");
      const none = { accept: 0, request_changes: 0 };
      assert.deepEqual(reportGate(h), { verdicts: none, sameRungVerdicts: none, ungated: 1, missing: 0 });

      // Back at medium it needs the orchestrator's spot check, and a commit's result names it.
      await session.prompt("/pi-orchestrator gate medium");
      const from = session.messages.length;
      provider.plan.push({ toolCall: { name: "bash", arguments: { command: commit("at-medium") } } });
      await session.prompt("Commit again");
      assert.deepEqual(bashResults(session, from), [{ ok: true, reminder: gateReminder("commit", `an editing delegation waits for your verdict: delegation ${worker.sessionId}.`) }]);
      assert.deepEqual(commitLog(h.projectDir), ["at-medium", "at-low"]);
      // The report keeps the requirement recorded as the delegation ended.
      assert.deepEqual(reportGate(h), { verdicts: none, sameRungVerdicts: none, ungated: 1, missing: 0 });
    } finally { session.dispose(); }
  } finally { h.cleanup(); }
});

test("a commit's result names a delegation that edited and still runs as running", async () => {
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic((request) => request.toolResults.length === 0
      ? { toolCall: { name: "write", arguments: { path: "notes.md", content: "x\n" } } } : { text: "done" },
    (request) => request.toolResults.length > 0);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    const stop = new AbortController();
    const held = subagents.tool().execute("call-hold", { items: [{ task: "Write, then hold" }] } as never, stop.signal, undefined, main.ctx);
    try {
      await waitFor(() => editRecords(h).length === 1, "the worker's edit record");
      const id = editRecords(h)[0]!.delegationId;
      assert.equal(await subagents.toolCall("bash", { command: "git push" }, main.ctx), undefined, "the push is never blocked");
      assert.deepEqual(await subagents.toolResult("bash", { command: "git push" }, main.ctx), [{ type: "text", text: "(no output)" },
        { type: "text", text: gateReminder("push", `an editing delegation waits for your verdict: delegation ${id} (still running).`) }]);
      assert.deepEqual(await subagents.toolResult("bash", { command: "git status" }, main.ctx), [{ type: "text", text: "(no output)" }]);
      // In the worker's session, the orchestrator's unjudged edits are not named.
      const unmark = markWorkerSession(main.sessionId);
      try {
        assert.deepEqual(await subagents.toolResult("bash", { command: "git push" }, main.ctx), [{ type: "text", text: "(no output)" }]);
      } finally { unmark(); }
    } finally {
      stop.abort();
      await held;
    }
  } finally { h.cleanup(); }
});

test("a record folder that cannot be read lets a commit through, and its result says the gate cannot tell what waits", async () => {
  const h = routedHarness();
  try {
    execFileSync("git", ["init", "-q"], { cwd: h.projectDir });
    mkdirSync(join(h.stateDir, "routing"));
    writeFileSync(join(h.stateDir, "routing", "2026-09-28.jsonl"), "not json\n");
    const provider = plannedAnthropic();
    const session = await orchestratorSession(h, provider.extension, [provider.extension]);
    try {
      provider.setOrchestrator(session.sessionId);
      provider.plan.push(
        { toolCall: { name: "bash", arguments: { command: "git status --short" } } },
        { toolCall: { name: "bash", arguments: { command: commit("unread") } } },
      );
      await session.prompt("Commit");
      const [status, committed] = bashResults(session);
      assert.deepEqual(status, { ok: true });
      assert.equal(committed?.ok, true);
      assert.match(committed?.reminder ?? "", /^pi-orchestrator: git commit ran, but the edit records cannot be read to tell whether an editing delegation waits for your verdict \(.*2026-09-28\.jsonl:1.*\)\.$/);
      assert.deepEqual(commitLog(h.projectDir), ["unread"]);
    } finally { session.dispose(); }
  } finally { h.cleanup(); }
});

test("/pi-orchestrator gate sets the session's gate level: an ungated delegation is never named by a commit's result or the turn-end notice, and an invalid level prints the usage", async () => {
  const h = routedHarness();
  try {
    const provider = scriptedAnthropic(runningScript);
    const subagents = loadSubagents([routerExtension(), provider.extension]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);
    const usage = "usage: /pi-orchestrator gate [low|medium|high|max]";
    assert.deepEqual(await subagents.runCommand("pi-orchestrator", "gate", main.ctx), [`pi-orchestrator: gate level medium, from settings.\n${usage}`]);
    for (const args of ["gate none", "gate high please"]) assert.deepEqual(await subagents.runCommand("pi-orchestrator", args, main.ctx), [usage], args);
    assert.deepEqual(await subagents.runCommand("pi-orchestrator", "gate low", main.ctx), ["pi-orchestrator: gate level low for this session (settings say medium)."]);
    // The classifier says mechanical: at low its gate action is none.
    const result = await subagents.tool().execute("call-1", { items: [{ task: runTask("write", { path: "notes.md", content: "x\n" }) }] } as never, undefined, undefined, main.ctx);
    const worker = (result.details as SubagentsDetails).results[0]!;
    assert.equal(worker.edited, true, JSON.stringify(worker));
    assert.ok(toolText(result).includes("At the low gate level a mechanical delegation needs no verdict: it is ungated."), toolText(result));
    assert.deepEqual(await subagents.toolResult("bash", { command: "git commit -m x" }, main.ctx), [{ type: "text", text: "(no output)" }],
      "an ungated delegation is named in no commit's result");
    // Its gate requirement, at the level in force as it ended, makes it ungated in the decision record and the report.
    assert.deepEqual(gateRequirements(h), [[worker.sessionId, "low", "none"]]);
    const none = { accept: 0, request_changes: 0 };
    assert.deepEqual(reportGate(h), { verdicts: none, sameRungVerdicts: none, ungated: 1, missing: 0 });
    await subagents.agentEvent("turn_end", main.ctx);
    assert.deepEqual(subagents.messages.filter(({ message }) => message.customType === "subagents-unjudged"), [], "nor is it named at the turn end");
    // Back at medium it needs the orchestrator's spot check, and waits for it.
    await subagents.runCommand("pi-orchestrator", "gate medium", main.ctx);
    const reminded = await subagents.toolResult("bash", { command: "git commit -m x" }, main.ctx);
    assert.ok(reminded.at(-1)?.text?.includes(`waits for your verdict: delegation ${worker.sessionId}.`), JSON.stringify(reminded));
    await subagents.agentEvent("turn_end", main.ctx);
    assert.equal(subagents.messages.filter(({ message }) => message.customType === "subagents-unjudged").length, 1);
    // The report keeps the requirement recorded as the delegation ended, and neither ungated nor missing is a learning observation.
    assert.deepEqual(reportGate(h), { verdicts: none, sameRungVerdicts: none, ungated: 1, missing: 0 });
    assert.equal(existsSync(join(h.stateDir, "refresh-state.json")), false, "no observation was recorded");
    // Another session starts from the settings' level.
    const other = orchestrator(h);
    assert.deepEqual(await subagents.runCommand("pi-orchestrator", "gate", other.ctx), [`pi-orchestrator: gate level medium, from settings.\n${usage}`]);
  } finally { h.cleanup(); }
});

test("the protocol tells the orchestrator to judge an editing delegation's Result and record the verdict with subagents_verdict", () => {
  const protocol = orchestratorProtocol(3, "medium");
  const paragraph = protocol.split("\n\n").find((text) => text.includes("subagents_verdict"));
  assert.ok(paragraph, protocol);
  for (const phrase of ["edited", "accept", "request_changes", "reason", "replaces", "research", "resume", "git commit or git push always goes through",
    "still waiting for a verdict", "tell the user"]) {
    assert.ok(paragraph.includes(phrase), `${phrase}: ${paragraph}`);
  }
});
