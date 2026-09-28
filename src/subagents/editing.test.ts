import assert from "node:assert/strict";
import { test } from "node:test";
import { isEditingToolCall } from "./editing.ts";

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
