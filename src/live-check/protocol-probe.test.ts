import assert from "node:assert/strict";
import { test } from "node:test";
import { orchestratorProtocol } from "../subagents/orchestrator-protocol.ts";
import { hasProtocol, payloadSystemText, probeFile, summarize, type ProbeRecord } from "./protocol-probe.ts";

const PROTOCOL = orchestratorProtocol(3, "medium");

test("the protocol is found in an Anthropic payload's system blocks and native system messages, not in a tool result", () => {
  assert.ok(hasProtocol(payloadSystemText({ system: [{ type: "text", text: "You are pi." }, { type: "text", text: PROTOCOL }], messages: [] })));
  assert.ok(hasProtocol(payloadSystemText({ system: "You are pi.", messages: [{ role: "system", content: [{ type: "text", text: PROTOCOL }] }] })));
  const readTheSource = { system: "You are pi.", messages: [{ role: "user", content: [{ type: "tool_result", content: PROTOCOL }] }] };
  assert.equal(hasProtocol(payloadSystemText(readTheSource)), false, "a tool result that read the protocol's source does not count");
});

test("the protocol is found in a Responses payload's instructions and developer items", () => {
  assert.ok(hasProtocol(payloadSystemText({ instructions: PROTOCOL, input: [] })));
  assert.ok(hasProtocol(payloadSystemText({ instructions: "You are pi.", input: [{ role: "developer", content: PROTOCOL }] })));
  assert.equal(hasProtocol(payloadSystemText({ instructions: "You are pi.", input: [{ role: "user", content: PROTOCOL }] })), false);
  assert.equal(payloadSystemText(undefined), "");
});

test("the probe file is the configured one, or one per process in the state folder's live-check", () => {
  assert.equal(probeFile({ PI_PROTOCOL_PROBE_FILE: "/tmp/probe.jsonl" }), "/tmp/probe.jsonl");
  const file = probeFile({ PI_ORCHESTRATOR_STATE_DIR: "/tmp/state" }, new Date("2026-09-29T10:00:00.000Z"));
  assert.equal(file, `/tmp/state/live-check/protocol-probe-2026-09-29T10-00-00-000Z-${process.pid}.jsonl`);
});

const record = (fields: Partial<ProbeRecord>): ProbeRecord => ({ v: 1, at: "2026-09-29T10:00:00.000Z", session: "s", orchestrator: true, run: 1,
  start: { by: "prompt", skill: false }, messages: [], queuedSkills: 0, turn: 1, protocol: true, piPrompt: true, projectRules: false, ...fields });

test("the summary passes when a skill prompt's run and a notice's run, past its tool call, all had the protocol and no worker did", () => {
  const { lines, pass } = summarize([
    record({ run: 1, start: { by: "prompt", skill: true }, turn: 1 }),
    record({ run: 1, start: { by: "prompt", skill: true }, turn: 2 }),
    record({ run: 2, start: { by: "message" }, messages: ["subagents-completion"], turn: 1, piPrompt: false }),
    record({ run: 2, start: { by: "message" }, messages: ["subagents-completion"], turn: 2, piPrompt: false }),
    record({ session: "w", orchestrator: false, protocol: false }),
  ]);
  assert.equal(pass, true, lines.join("\n"));
  assert.equal(lines.at(-1), "RESULT: PASS");
  assert.ok(lines.includes("run 2 (message subagents-completion) turn 2: protocol yes · pi's prompt no"), lines.join("\n"));
});

test("the summary fails on a request without the protocol, on a case it did not see, and on a worker with the protocol", () => {
  const missing = summarize([
    record({ run: 1, start: { by: "prompt", skill: true }, projectRules: true, protocol: false }),
    record({ run: 2, start: { by: "message" }, messages: ["subagents-completion"], turn: 2 }),
  ]);
  assert.equal(missing.pass, false);
  assert.ok(missing.lines.includes("FAIL: a typed skill prompt's run (1 request)"), missing.lines.join("\n"));
  assert.ok(missing.lines.some((line) => line.includes("protocol NO") && line.includes("project rules forced")), missing.lines.join("\n"));

  const unseen = summarize([record({ run: 1, start: { by: "prompt", skill: true } })]);
  assert.equal(unseen.pass, false);
  assert.ok(unseen.lines.includes("NOT SEEN: a run a completion notice started (0 requests)"), unseen.lines.join("\n"));

  const leaked = summarize([record({ run: 1, start: { by: "prompt", skill: true } }),
    record({ run: 2, start: { by: "message" }, messages: ["subagents-completion"], turn: 2 }), record({ orchestrator: false })]);
  assert.equal(leaked.pass, false);
  assert.ok(leaked.lines.includes("FAIL: no worker request has the protocol (1 worker request probed)"), leaked.lines.join("\n"));
});
