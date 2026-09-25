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
import { createSubagentsExtension, MAX_TEXT_BYTES, type SubagentsDetails } from "./extension.ts";

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
}

/** A fake `anthropic` provider serving claude-haiku-4-5 offline: every
 *  request is recorded and answered with `reply`, as one text part. */
function fakeAnthropic(reply: string) {
  const requests: ProviderRequest[] = [];
  const config: ProviderConfig = {
    name: "Fake Anthropic", baseUrl: "http://localhost/unused", apiKey: "unused", api: "fake-anthropic" as never,
    models: [{ id: "claude-haiku-4-5", name: "Claude Haiku 4.5", reasoning: true, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 64_000 }],
    streamSimple(model, context, options) {
      // Provider contexts carry tools in system-message deltas, not context.tools.
      const tools = new Set<string>();
      for (const message of context.messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
        for (const tool of message.toolsAdded ?? []) tools.add(tool.name);
      }
      requests.push({ sessionId: options?.sessionId, tools: [...tools] });
      const { stream, push, end } = autoStream();
      const message = {
        role: "assistant", content: [{ type: "text", text: reply }], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      push({ type: "start", partial: { ...message, content: [] } } as never);
      push({ type: "done", reason: "stop", message } as never);
      end({ api: model.api, provider: model.provider, model: model.id });
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

/** The subagents tool as pi registers it in the orchestrator's session. */
function loadSubagentsTool(workerExtensions: readonly InlineExtension[]): Tool {
  const tools: Tool[] = [];
  createSubagentsExtension({ workerExtensions })({ registerTool(tool: Tool) { tools.push(tool); } } as unknown as ExtensionAPI);
  assert.deepEqual(tools.map((tool) => tool.name), ["subagents"]);
  return tools[0]!;
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

async function callSubagents(tool: Tool, ctx: ExtensionContext, task: string) {
  const result = await tool.execute("call-1", { task } as never, undefined, undefined, ctx);
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
