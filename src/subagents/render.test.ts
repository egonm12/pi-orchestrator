import assert from "node:assert/strict";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { SubagentProgress, SubagentsProgressDetails } from "./extension.ts";
import { renderSubagentsResult, subagentsCallText, subagentsResultText } from "./render.ts";

// The subagents tool's TUI rendering as pure functions: a call's header, and
// one line per worker with its agent, short task and state, plus the final
// text when expanded. A plain theme leaves the text uncoloured; a marking
// theme shows which colour each part gets.

const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const MARKING = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => text } as unknown as Theme;

function details(...results: SubagentProgress[]): SubagentsProgressDetails {
  return { results };
}

const DONE = { status: "completed", sessionId: "s1", sessionFile: undefined } as const;

test("the call header names the tool and counts the tasks, also while the arguments stream", () => {
  assert.equal(subagentsCallText({ items: [{ task: "a" }, { task: "b" }, { task: "c" }] }, PLAIN), "subagents 3 tasks");
  assert.equal(subagentsCallText({ items: [{ task: "a" }] }, PLAIN), "subagents 1 task");
  assert.equal(subagentsCallText({}, PLAIN), "subagents");
  assert.equal(subagentsCallText(undefined, PLAIN), "subagents");
});

test("a running call shows one line per worker: agent, short task, and queued, running or the current tool", () => {
  const text = subagentsResultText(details(
    { task: "Fix the typo in README.md", status: "queued" },
    { task: "Review the diff", agent: "reviewer", status: "running" },
    { task: "Find the config loader", agent: "scout", status: "running", tool: "read" },
  ), false, PLAIN);
  assert.equal(text, [
    "worker · Fix the typo in README.md · queued",
    "reviewer · Review the diff · running",
    "scout · Find the config loader · running: read",
  ].join("\n"));
});

test("finished workers show done, error, aborted or not started, and the collapsed view leaves out the final text", () => {
  const text = subagentsResultText(details(
    { ...DONE, task: "Item 1", finalText: "The typo is fixed." },
    { task: "Item 2", agent: "reviewr", status: "failed", finalText: "", error: "unknown agent \"reviewr\"" },
    { task: "Item 3", status: "aborted", sessionId: "s3", sessionFile: undefined, finalText: "" },
    { task: "Item 4", status: "not-started", finalText: "" },
  ), false, PLAIN);
  assert.equal(text, [
    "worker · Item 1 · done",
    "reviewr · Item 2 · error",
    "worker · Item 3 · aborted",
    "worker · Item 4 · not started",
  ].join("\n"));
});

test("expanded, each finished worker's line is followed by its final text or its error", () => {
  const text = subagentsResultText(details(
    { ...DONE, task: "Item 1", finalText: "The typo is fixed.\nNothing else changed." },
    { task: "Item 2", agent: "reviewr", status: "failed", finalText: "", error: "unknown agent \"reviewr\"" },
    { ...DONE, task: "Item 3", finalText: "" },
    { task: "Item 4", status: "running", tool: "bash" },
  ), true, PLAIN);
  assert.equal(text, [
    "worker · Item 1 · done",
    "The typo is fixed.",
    "Nothing else changed.",
    "",
    "reviewr · Item 2 · error",
    "Error: unknown agent \"reviewr\"",
    "",
    "worker · Item 3 · done",
    "(no final text)",
    "",
    "worker · Item 4 · running: bash",
  ].join("\n"));
});

test("the short task is the task's first line, cut at 60 characters", () => {
  const long = `${"word ".repeat(20).trim()}\nSecond line with details`;
  const [line] = subagentsResultText(details({ task: long, status: "queued" }), false, PLAIN).split("\n");
  assert.equal(line, `worker · ${"word ".repeat(12).slice(0, 59)}… · queued`);
  assert.equal(subagentsResultText(details({ task: "  Spaced\t  out  ", status: "queued" }), false, PLAIN), "worker · Spaced out · queued");
});

test("a preserved-model worker shows its model, marked when the ban-list exception applied", () => {
  const text = subagentsResultText(details(
    { task: "Plan it", agent: "planner", status: "running", model: "anthropic/claude-opus-4-5" },
    { ...DONE, task: "Review it", agent: "fable", finalText: "ok", model: "openai/fable-1", banListException: true },
    { ...DONE, task: "Routed", finalText: "ok" },
  ), false, PLAIN);
  assert.equal(text, [
    "planner · Plan it · running · anthropic/claude-opus-4-5",
    "fable · Review it · done · openai/fable-1 (ban-list exception)",
    "worker · Routed · done",
  ].join("\n"));
});

test("states are coloured: done as success, error as error, running as warning, the ban-list exception as warning", () => {
  const text = subagentsResultText(details(
    { ...DONE, task: "A", finalText: "ok" },
    { task: "B", status: "failed", finalText: "", error: "boom" },
    { task: "C", status: "running", tool: "read" },
    { task: "D", status: "queued" },
    { ...DONE, task: "E", finalText: "ok", model: "x/fable", banListException: true },
  ), false, MARKING);
  const lines = text.split("\n");
  assert.ok(lines[0]?.includes("<success>done</success>"), lines[0]);
  assert.ok(lines[1]?.includes("<error>error</error>"), lines[1]);
  assert.ok(lines[2]?.includes("<warning>running: read</warning>"), lines[2]);
  assert.ok(lines[3]?.includes("<muted>queued</muted>"), lines[3]);
  assert.ok(lines[4]?.includes("<warning>(ban-list exception)</warning>"), lines[4]);
  assert.ok(lines[0]?.startsWith("<accent>worker</accent>"), lines[0]);
});

test("the result component wraps its lines to the render width, and without details shows the result text", () => {
  const component = renderSubagentsResult(
    { content: [{ type: "text", text: "unused" }], details: details({ ...DONE, task: "Item 1", finalText: "x ".repeat(100) }) },
    { expanded: true, isPartial: false }, PLAIN,
  );
  const lines = component.render(40);
  assert.ok(lines.length > 3, JSON.stringify(lines));
  assert.ok(lines.every((line) => line.trimEnd().length <= 40), JSON.stringify(lines));
  assert.equal(lines[0]?.trimEnd(), "worker · Item 1 · done");

  const fallback = renderSubagentsResult({ content: [{ type: "text", text: "subagents requires 1 to 8 items per call" }], details: undefined },
    { expanded: false, isPartial: false }, PLAIN);
  assert.deepEqual(fallback.render(80).map((line) => line.trimEnd()), ["subagents requires 1 to 8 items per call"]);
});
