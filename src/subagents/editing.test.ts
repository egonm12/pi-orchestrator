import assert from "node:assert/strict";
import { test } from "node:test";
import { buildEditRecord, DECISION_RECORD_SCHEMA_VERSION, type RoutingRecord, type Verdict, type VerdictRecord } from "../routing/decision-record.ts";
import { isEditingToolCall, unjudgedDelegations } from "./editing.ts";

// Which of a worker's tool calls make its delegation an editing delegation
// (ADR 0010). Seam: `isEditingToolCall` over a tool name and its input.

const editing = (calls: readonly [string, unknown][]) => calls.map(([name, input]) => isEditingToolCall(name, input));

test("edit, write, and bash that is neither read-only nor a build or test run are editing", () => {
  assert.deepEqual(editing([
    ["edit", { path: "a.ts" }], ["write", { path: "a.ts", content: "x" }],
    ["bash", { command: "sed -i 's/a/b/' a.ts" }], ["bash", { command: "echo hi > out.txt" }], ["bash", { command: "rm -rf dist" }],
    ["bash", { command: "npm test && git commit -am wip" }], ["bash", { command: "git checkout main" }], ["bash", { command: "git push" }],
    ["bash", {}], ["powershell", { command: "Get-ChildItem" }],
  ]), Array(10).fill(true));
});

test("ctx_execute and ctx_execute_file are editing, although the exploration budget counts them as exploratory", () => {
  assert.deepEqual(editing([["ctx_execute", { language: "shell", code: "ls" }], ["ctx_execute_file", { path: "a.log", code: "x" }]]), [true, true]);
});

test("reads, searches, builds, tests, delegation and unknown tools are not editing", () => {
  assert.deepEqual(editing([
    ["read", { path: "a.ts" }], ["grep", { pattern: "x" }], ["web_search", { query: "pi" }], ["ctx_search", {}], ["mcp", { tool: "x" }],
    ["bash", { command: "rg foo | head" }], ["bash", { command: "git diff HEAD~1" }], ["bash", { command: "npm test" }],
    ["bash", { command: "npm run typecheck > /dev/null" }],
    ["subagents", { items: [] }], ["subagents_verdict", {}], ["report", { kind: "progress", text: "x" }], ["probe", {}],
  ]), Array(13).fill(false));
});

// Which editing delegations of one orchestrator session still wait for a
// verdict (ADR 0010). Seam: `unjudgedDelegations` over the record folder's
// records, in file order.

const edit = (delegationId: string, at: string, extra: { orchestratorSession?: string; nestedDelegationId?: string } = {}) =>
  buildEditRecord({ delegationId, orchestratorSession: extra.orchestratorSession ?? "main", tool: "write", at: new Date(at),
    ...(extra.nestedDelegationId === undefined ? {} : { nestedDelegationId: extra.nestedDelegationId }) });
const verdict = (delegationId: string, at: string, kind: Verdict = "accept"): VerdictRecord => ({
  recordType: "verdict", schemaVersion: DECISION_RECORD_SCHEMA_VERSION, delegationId, timestamp: new Date(at).toISOString(),
  verdict: kind, decisionFile: "2026-09-28.jsonl",
});
const unjudged = (records: readonly RoutingRecord[], session = "main") => unjudgedDelegations(records, session).map((item) => item.delegationId);

test("an editing delegation without a verdict is unjudged; a verdict of either kind judges it", () => {
  const records = [edit("a", "2026-09-28T10:00:00Z"), edit("b", "2026-09-28T10:01:00Z"), edit("c", "2026-09-28T10:02:00Z"),
    verdict("a", "2026-09-28T10:03:00Z", "accept"), verdict("c", "2026-09-28T10:04:00Z", "request_changes")];
  assert.deepEqual(unjudged(records), ["b"]);
  assert.deepEqual(unjudged([...records, verdict("b", "2026-09-28T10:05:00Z")]), []);
});

test("an edit after the latest verdict, from a resume, makes the delegation unjudged again, named by its latest edit", () => {
  const records = [edit("a", "2026-09-28T10:00:00Z"), verdict("a", "2026-09-28T10:01:00Z"), edit("a", "2026-09-28T11:00:00Z")];
  assert.deepEqual(unjudgedDelegations(records, "main"), [{ delegationId: "a", lastEdit: "2026-09-28T11:00:00.000Z" }]);
  assert.deepEqual(unjudged([...records, verdict("a", "2026-09-28T11:05:00Z")]), []);
});

test("only the orchestrator session's own delegations count; a nested worker's edit counts for its top-level delegation", () => {
  const records = [edit("a", "2026-09-28T10:00:00Z", { orchestratorSession: "other" }),
    edit("lead", "2026-09-28T10:01:00Z", { nestedDelegationId: "leaf" })];
  assert.deepEqual(unjudged(records), ["lead"]);
  assert.deepEqual(unjudged(records, "other"), ["a"]);
  // A verdict never lands on the nested id (subagents_verdict refuses it); if one did, it would not judge the lead.
  assert.deepEqual(unjudged([...records, verdict("leaf", "2026-09-28T10:02:00Z")]), ["lead"]);
});
