import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { resetBanLists } from "../policy/ban-lists.ts";
import personalGuard from "./extension.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TestContext as ExtensionContext } from "../fixtures/extension-context.ts";

// The guard reads settings.json from PI_CODING_AGENT_DIR at load. Point it at
// a throwaway dir so these tests never read the real ~/.pi/agent.
const agentDir = mkdtempSync(join(tmpdir(), "pi-harness-guard-ext-"));
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
// This suite may itself run inside a pi-subagents child host; the guard's
// child-host exemption must not leak into the parent-session tests.
const originalChildMarkers = { PI_SUBAGENT_CHILD: process.env.PI_SUBAGENT_CHILD, PI_SUBAGENTS_HERDR_BRIDGE: process.env.PI_SUBAGENTS_HERDR_BRIDGE };
delete process.env.PI_SUBAGENT_CHILD;
delete process.env.PI_SUBAGENTS_HERDR_BRIDGE;
after(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  for (const [name, value] of Object.entries(originalChildMarkers)) if (value !== undefined) process.env[name] = value;
  resetBanLists();
  rmSync(agentDir, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
function loadGuard(): Map<string, Handler> {
  const handlers = new Map<string, Handler>();
  personalGuard({ on(event: string, callback: Handler) { handlers.set(event, callback); } } as unknown as ExtensionAPI);
  return handlers;
}

test("session model is not on the delegated-agent ban; runtime failure disables once on one line", async () => {
  const handler = loadGuard().get("tool_call");
  assert.ok(handler);
  const event = { type: "tool_call", toolCallId: "1", toolName: "read", input: { path: "example" } };
  const ctx = { cwd: "/tmp", hasUI: false, model: { provider: "anthropic", id: "claude-fable-5" } };
  assert.equal(await handler(event, ctx), undefined);
  const original = process.stderr.write;
  let output = "";
  try {
    process.stderr.write = ((chunk: string) => { output += chunk; return true; }) as typeof process.stderr.write;
    const broken = { get cwd(): string { throw new Error("first line\nsecond line"); }, hasUI: false };
    assert.equal(await handler(event, broken), undefined);
    assert.equal(await handler(event, broken), undefined);
  } finally { process.stderr.write = original; }
  assert.equal(output, "pi-orchestrator guard disabled: Error: first line\n");
});

test("selecting a session-banned model mid-session blocks turns until an allowed model is selected", async () => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { sessionBanList: ["opus"] } }));
  const handlers = loadGuard();
  const modelSelect = handlers.get("model_select")!, input = handlers.get("input")!;
  const notices: string[] = [];
  const ctx: ExtensionContext = { cwd: agentDir, hasUI: true, ui: { notify: (message) => { notices.push(message); } } };
  const prompt = { type: "input", text: "hello", source: "interactive" };
  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" }, opus = { provider: "anthropic", id: "claude-opus-5-5" };

  assert.equal(await input(prompt, ctx), undefined);
  await modelSelect({ type: "model_select", model: opus, previousModel: haiku, source: "set" }, ctx);
  assert.deepEqual(await input(prompt, ctx), { action: "handled" });
  assert.equal(notices.length, 2);
  for (const notice of notices) assert.match(notice, /session model 'anthropic\/claude-opus-5-5' is on the session ban list \(entry 'opus'\)/);

  await modelSelect({ type: "model_select", model: haiku, previousModel: opus, source: "set" }, ctx);
  assert.equal(await input(prompt, ctx), undefined);
  assert.equal(notices.length, 2);
});

// pi-subagents hosts delegated sessions in processes it marks: the async
// runner sets PI_SUBAGENT_CHILD=1 (runs/background/subagent-runner.js:85) and
// a herdr pane-native child gets PI_SUBAGENTS_HERDR_BRIDGE=1
// (runs/shared/herdr-placed-run.js:251). Ambient extensions, this guard
// included, load into those children (runs/shared/child-launch.js:187), but a
// delegated agent is not the orchestrator's own session (ADR 0002).
for (const marker of ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"]) {
  test(`in a child-hosting process (${marker}=1) a session-banned model is not refused`, async () => {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { sessionBanList: ["opus"] } }));
    const opus = { provider: "anthropic", id: "claude-opus-5-5" };
    const prompt = { type: "input", text: "hello", source: "interactive" };
    const run = async (childHost: boolean) => {
      const original = process.env[marker];
      if (childHost) process.env[marker] = "1";
      else delete process.env[marker];
      try {
        const handlers = loadGuard();
        const notices: string[] = [];
        const ctx: ExtensionContext = { cwd: agentDir, hasUI: true, model: opus, ui: { notify: (message) => { notices.push(message); } } };
        await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
        return { notices, input: await handlers.get("input")!(prompt, ctx) };
      } finally {
        if (original === undefined) delete process.env[marker];
        else process.env[marker] = original;
      }
    };
    const child = await run(true);
    assert.deepEqual(child.notices, []);
    assert.equal(child.input, undefined);
    const parent = await run(false);
    assert.equal(parent.notices.length, 2);
    assert.deepEqual(parent.input, { action: "handled" });
  });
}

// A turn can start without an `input` event: pi's sendCustomMessage with
// triggerTurn (agent-session.js:1502) runs the agent directly, and
// pi-subagents delivers async completions that way. `turn_start` is awaited
// before each provider request (pi-agent-core agent-loop.js:51 and :113), so
// aborting there stops the turn before the model is called.
test("a turn started without an input event is aborted while the session model is session-banned", async () => {
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ orchestrator: { sessionBanList: ["opus"] } }));
  const handlers = loadGuard();
  const turnStart = handlers.get("turn_start");
  assert.ok(turnStart, "the guard handles turn_start");
  let aborts = 0;
  const notices: string[] = [];
  const ctx: ExtensionContext = {
    cwd: agentDir,
    hasUI: true,
    model: { provider: "anthropic", id: "claude-opus-5-5" },
    ui: { notify: (message) => { notices.push(message); } },
    abort: () => { aborts++; },
  };
  const turn = { type: "turn_start", turnIndex: 0, timestamp: 0 };
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
  await turnStart(turn, ctx);
  assert.equal(aborts, 1);
  assert.match(notices.at(-1)!, /session ban list \(entry 'opus'\)/);

  const haiku = { provider: "anthropic", id: "claude-haiku-4-5" };
  await handlers.get("model_select")!({ type: "model_select", model: haiku, previousModel: ctx.model, source: "set" }, ctx);
  ctx.model = haiku;
  await turnStart(turn, ctx);
  assert.equal(aborts, 1);
});
