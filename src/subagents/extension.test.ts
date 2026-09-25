import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { after, test } from "node:test";
import { DefaultPackageManager, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { resetBanLists } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval } from "../recipients/authorization.ts";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { autoStream } from "../router/auto-stream.ts";
import { createRouterExtension } from "../router/extension.ts";
import { createSubagentsExtension, MAX_TEXT_BYTES, type SubagentsDetails, type SubagentsProgressDetails } from "./extension.ts";

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
  readonly tools: readonly string[];
  /** The system messages' text and sections, as one string. */
  readonly systemText: string;
  readonly thinkingLevel: string | undefined;
}

/** A fake `anthropic` provider serving claude-haiku-4-5 offline: every
 *  request is recorded and answered with `reply`, as one text part. */
function fakeAnthropic(reply: string, onRequest?: (finish: () => void) => void) {
  const requests: ProviderRequest[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
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
      requests.push({ sessionId: options?.sessionId, tools: [...tools], systemText: systemText.join("\n"), thinkingLevel: options?.reasoning });
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
 *  always answers mechanical. */
function routerExtension(): InlineExtension {
  const classifierAnswer = JSON.stringify({ tier: "mechanical", risk: { level: "none", reasons: [] }, ambiguity: "clear", complexity: "low", kindOfWork: "implement", why: "fake classifier says mechanical" });
  return {
    name: "router",
    factory: createRouterExtension({
      classifierCall: () => async () => classifierAnswer,
      evidence: () => () => ({ catalog: buildCatalog({ modelIds: [HAIKU], now: NOW }), refreshState: emptyRefreshState(), authorization: approvedAnthropic() }),
      now: () => NOW,
    }),
  };
}

type Tool = Parameters<ExtensionAPI["registerTool"]>[0];

/** The orchestrator's active tools in these tests: pi's default built-ins, the probe tool and subagents. */
const ORCHESTRATOR_TOOLS = ["read", "bash", "edit", "write", "probe", "subagents"];

interface LoadedSubagents {
  /** The subagents tool as last registered. */
  tool(): Tool;
  /** Runs the extension's session_start handlers, as pi does when the orchestrator's session starts. */
  startSession(ctx: ExtensionContext): Promise<void>;
}

/** The subagents extension as pi loads it in the orchestrator's session. */
function loadSubagents(workerExtensions: readonly InlineExtension[]): LoadedSubagents {
  const tools: Tool[] = [];
  const sessionStart: ((event: unknown, ctx: ExtensionContext) => unknown)[] = [];
  createSubagentsExtension({ workerExtensions })({
    registerTool(tool: Tool) { tools.push(tool); },
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) { if (event === "session_start") sessionStart.push(handler); },
    getActiveTools: () => [...ORCHESTRATOR_TOOLS],
  } as unknown as ExtensionAPI);
  return {
    tool() {
      assert.ok(tools.length > 0 && tools.every((tool) => tool.name === "subagents"), JSON.stringify(tools.map((tool) => tool.name)));
      return tools.at(-1)!;
    },
    async startSession(ctx) {
      for (const handler of sessionStart) await handler({ type: "session_start", reason: "startup" }, ctx);
    },
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
    // grep is a pi built-in the orchestrator does not have on; subagents is never a worker's.
    writeAgentDefinition(join(h.projectDir, ".pi", "agents"), "scout.md",
      { name: "scout", description: "Reads only", tools: "read, probe, grep, subagents" }, "Read, never write.");
    const provider = fakeAnthropic("done");
    const subagents = loadSubagents([routerExtension(), provider.extension, PROBE_TOOL_EXTENSION]);
    const main = orchestrator(h);
    await subagents.startSession(main.ctx);

    const { worker } = await callSubagents(subagents.tool(), main.ctx, "Look around.", "scout");
    assert.equal(worker.status, "completed", JSON.stringify(worker));
    assert.deepEqual([...(provider.requests[0]?.tools ?? [])].sort(), ["probe", "read"]);
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
