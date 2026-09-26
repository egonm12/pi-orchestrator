import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { initTheme, SessionManager, type AgentSessionEvent, type Theme } from "@earendil-works/pi-coding-agent";
// pi's own keybindings manager, the one it hands a ctx.ui.custom factory. pi's
// public entry exports only its type, so the test reaches into the package:
// matching the real binding ids is what keeps the view from trapping the user.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { WorkerBoard, type WorkerFeed, type WorkerSession } from "./worker-board.ts";
import { openTranscript, TRANSCRIPT_OVERLAY, type TranscriptUI } from "./transcript-view.ts";

// The transcript view as xytd's ways in will open it: openTranscript on a real
// worker board, through a fake ctx.ui.custom that mounts the overlay the way
// pi does (a TUI with a height and a redraw request, pi's keybindings manager,
// and a done callback). Worker sessions are fakes that hold messages and emit
// pi's session events. pi's message components draw with pi's global theme;
// the view's own lines use a plain theme, and the assertions read the lines
// without their escape codes, as the user sees them.

initTheme("dark");
const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const WIDTH = 100;

const KEY = {
  escape: "\x1b", kittyEscape: "\x1b[27u", ctrlC: "\x03", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F",
  left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", enter: "\r", ctrlO: "\x0f",
};

/** A line as the user sees it: without colours, hyperlinks and other escape codes. */
function plain(line: string): string {
  return line.replace(/\x1b\]8;;[^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

type Message = Record<string, unknown>;

/** A running worker's session: its messages, which a test appends to, and its events. */
function fakeSession(sessionId: string, messages: Message[] = []) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: WorkerSession = {
    sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, effort: "medium", messages: () => messages as never,
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return {
    session, messages, listeners,
    emit(event: object) { for (const listener of [...listeners]) listener(event as AgentSessionEvent); },
    /** Appends a saved message, as pi does at its message_end. */
    add(message: Message) { messages.push(message); this.emit({ type: "message_end", message }); },
  };
}

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
const reply = (text: string, calls: { id: string; name: string; arguments: object }[] = []): Message => ({
  role: "assistant", content: [{ type: "text", text }, ...calls.map((call) => ({ type: "toolCall", ...call }))],
  stopReason: calls.length > 0 ? "toolUse" : "stop", timestamp: 0,
});
const toolResult = (toolCallId: string, toolName: string, text: string): Message => ({
  role: "toolResult", toolCallId, toolName, content: [{ type: "text", text }], isError: false, timestamp: 0,
});

/** A worker that has started, with a live session. */
function running(board: WorkerBoard, task: string, sessionId: string, extra: { agent?: string; parentDelegationId?: string } = {}, messages: Message[] = [user(task)]) {
  const feed = board.add({ callId: "call-1", background: false, task, ...extra, model: { kind: "routed" } });
  feed.started();
  const fake = fakeSession(sessionId, messages);
  feed.session(fake.session);
  return { feed, fake };
}

/** ctx.ui.custom as pi mounts a full-screen overlay: the factory gets a TUI,
 *  a theme, pi's keybindings manager and done, which resolves the call. */
function fakeUI(rows = 20) {
  const tui = { terminal: { rows }, renders: 0, requestRender() { this.renders++; } };
  let component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
  let options: unknown;
  let closed = false;
  const ui: TranscriptUI = {
    custom: (async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
      options = customOptions;
      return new Promise<void>((resolve) => {
        component = factory(tui, PLAIN, new KeybindingsManager(), () => { closed = true; component?.dispose(); resolve(); }) as typeof component;
      });
    }) as TranscriptUI["custom"],
    getToolsExpanded: () => false,
  };
  return {
    ui, tui,
    get options() { return options; },
    get closed() { return closed; },
    lines: (width = WIDTH) => component!.render(width),
    text: (width = WIDTH) => component!.render(width).map((line) => plain(line).trimEnd()),
    press(...keys: string[]) { for (const key of keys) component!.handleInput(key); },
  };
}

/** Lets the view's promise settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the view covers the whole screen, fits every line to it, and Esc or ctrl+c restores the orchestrator's session", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Fix the typo", "worker-1", { agent: "fixer" }, [user("Fix the typo"), reply(`A long line ${"x".repeat(300)}`)]);
  const view = fakeUI(12);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.deepEqual(view.options, { overlay: true, overlayOptions: TRANSCRIPT_OVERLAY });
  assert.deepEqual(TRANSCRIPT_OVERLAY, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });

  const lines = view.lines(60);
  assert.equal(lines.length, 12, "exactly the terminal's height");
  assert.ok(lines.every((line) => plain(line).length <= 60), JSON.stringify(lines.map(plain)));
  assert.equal(view.text(60)[0], "fixer · running · worker 1 of 1", "a one-line header");
  assert.ok(view.text().some((line) => line.includes("Fix the typo")));
  view.tui.terminal.rows = 30;
  assert.equal(view.lines().length, 30, "a resize redraws at the new size");

  view.press("q", KEY.left, "z");
  assert.equal(view.closed, false, "other keys keep it open");
  view.press(KEY.kittyEscape);
  await shown;
  assert.equal(view.closed, true, "Esc under the kitty keyboard protocol leaves");
  assert.equal(fake.listeners.size, 1, "the view stopped following the worker's session; only the board does");
  const renders = view.tui.renders;
  fake.emit({ type: "turn_start" });
  board.add({ callId: "call-2", background: false, task: "Later", model: { kind: "routed" } });
  assert.equal(view.tui.renders, renders, "nor does the board redraw it");

  for (const key of [KEY.escape, KEY.ctrlC, "\x1b[99;5u"]) {
    const again = fakeUI();
    const reopened = openTranscript(again.ui, board, board.workers()[0]!.id);
    again.press(key);
    await reopened;
    assert.equal(again.closed, true, `${JSON.stringify(key)} leaves`);
  }
  await assert.rejects(openTranscript(fakeUI().ui, board, "no-such-worker"), /No worker on the board has the id no-such-worker/);
});

test("a live transcript follows the end until the user scrolls; PgUp, PgDn, Home and End scroll, and End follows again", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Count to many", "worker-1");
  const view = fakeUI(12);
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.ok(view.text().includes("following · ←→ worker · PgUp PgDn Home End scroll · x stop · ctrl+o tool output · Esc back"), JSON.stringify(view.text()));

  // A reply as it streams, then saved.
  const renders = view.tui.renders;
  const partial = { role: "assistant", content: [{ type: "text", text: "Counting now" }], timestamp: 0 };
  fake.emit({ type: "message_start", message: partial });
  fake.emit({ type: "message_update", message: partial });
  assert.ok(view.tui.renders > renders, "each event redraws the view");
  assert.ok(view.text().some((line) => line.includes("Counting now")), "the streaming reply shows");
  const numbers = Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n");
  fake.add(reply(numbers));
  const last = () => view.text().filter((line) => /number \d+/.test(line)).at(-1)?.trim();
  assert.equal(last(), "number 40", "following the end");

  view.press(KEY.pageUp);
  const firstShown = () => view.text().find((line) => /number \d+/.test(line))?.trim();
  const scrolled = firstShown();
  assert.notEqual(last(), "number 40");
  assert.match(view.text().at(-1)!, /^line \d+ of \d+, End follows/);
  fake.add(reply("A new message below"));
  assert.equal(firstShown(), scrolled, "a scrolled view stays put while the worker goes on");
  assert.ok(!view.text().some((line) => line.includes("A new message below")));

  view.press(KEY.home);
  assert.ok(view.text().some((line) => line.includes("Count to many")), "Home shows the task");
  view.press(KEY.pageDown);
  assert.match(view.text().at(-1)!, /^line \d+ of \d+/);
  view.press(KEY.end);
  assert.ok(view.text().some((line) => line.includes("A new message below")), "End shows the end");
  assert.match(view.text().at(-1)!, /^following/);
  fake.add(reply("And it follows again"));
  assert.ok(view.text().some((line) => line.includes("And it follows again")));

  view.press(KEY.pageUp, KEY.pageDown, KEY.pageDown, KEY.pageDown);
  assert.match(view.text().at(-1)!, /^following/, "paging back down to the end follows it too");
});

test("pi's message rendering shows tool calls with their results and the expand toggle; reports and steers are marked", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Read the notes", "worker-1", {}, [
    user("Read the notes"),
    reply("Reading", [{ id: "call-1", name: "read", arguments: { path: "notes.md" } }]),
    toolResult("call-1", "read", "first note\nsecond note\nthird note"),
    user("Also check the todo list"),
    reply("Asking", [{ id: "call-2", name: "report", arguments: { kind: "question", text: "Which todo list?" } }]),
    toolResult("call-2", "report", "The orchestrator answered: The one in the repo"),
    reply("Noting progress", [{ id: "call-3", name: "report", arguments: { kind: "progress", text: "Half way" } }]),
    toolResult("call-3", "report", "Progress sent."),
    reply("All done"),
    user("One more thing: add a summary"),
  ]);
  const view = fakeUI(80);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  // pi's tool boxes pad their lines.
  const text = view.text().map((line) => line.trim());
  const index = (pattern: RegExp) => text.findIndex((line) => pattern.test(line));

  assert.ok(index(/read .*notes\.md/) >= 0, JSON.stringify(text));
  assert.ok(index(/third note/) < 0, "tool output starts collapsed, as the orchestrator's");
  assert.ok(index(/^▸ Steer from the orchestrator$/) >= 0, "a message after a tool result is a steer");
    assert.ok(index(/Also check the todo list/) > index(/^▸ Steer from the orchestrator$/));
  assert.ok(index(/^◆ Report: question$/) >= 0 && index(/Which todo list\?/) > index(/^◆ Report: question$/));
  assert.ok(index(/Answer: The one in the repo/) >= 0, "a question's answer");
  assert.ok(index(/^◆ Report: progress$/) >= 0 && index(/Half way/) >= 0);
  assert.ok(index(/Progress sent\./) < 0);
  assert.ok(index(/^▸ Follow-up from the orchestrator$/) > index(/All done/), "a message after the worker stopped is a follow-up");
  assert.equal(text.filter((line) => line.startsWith("▸")).length, 2, "the task prompt is not marked");

  view.press(KEY.ctrlO);
  assert.ok(view.text().some((line) => line.includes("third note")), "ctrl+o expands tool output");
  view.press(KEY.ctrlO);
  assert.ok(!view.text().some((line) => line.includes("third note")));

  // A tool as it runs: its call, then its partial output. Leaving the view
  // mid-run stops the bash renderer's elapsed-time timer, or this test would hang.
  fake.add(reply("Listing", [{ id: "call-9", name: "bash", arguments: { command: "ls" } }]));
  fake.emit({ type: "tool_execution_start", toolCallId: "call-9", toolName: "bash", args: { command: "ls" } });
  fake.emit({ type: "tool_execution_update", toolCallId: "call-9", toolName: "bash", args: { command: "ls" }, partialResult: { content: [{ type: "text", text: "README.md" }] } });
  view.press(KEY.ctrlO);
  assert.ok(view.text().some((line) => line.includes("README.md")), "a running tool's partial output");
  view.press(KEY.escape);
  await shown;
});

test("left and right switch to the previous or next worker in the board's order, and Enter on a nested worker's line opens it", async () => {
  const board = new WorkerBoard();
  const lead = running(board, "Lead the work", "lead-1", { agent: "lead" });
  running(board, "Other work", "other-1", { agent: "other" });
  const nested = running(board, "Nested work", "nested-1", { parentDelegationId: "lead-1" }, [user("Nested work"), reply("Nested reply")]);
  running(board, "Second nested", "nested-2", { parentDelegationId: "lead-1" });
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[0]!.id);

  assert.equal(view.text()[0], "lead · running · worker 1 of 4");
  assert.match(view.text()[1]!, /^› └ worker · routing… · running · \d+s · 0 turns · Nested work$/, "its nested workers, the first selected");
  assert.match(view.text()[2]!, /^  └ worker · routing… · running · \d+s · 0 turns · Second nested$/);
  assert.ok(view.text().at(-1)!.includes("↑↓ Enter nested worker"));

  view.press(KEY.right);
  assert.equal(view.text()[0], "worker · running · worker 2 of 4", "the nested worker comes right after its parent");
  assert.equal(lead.fake.listeners.size, 1, "only the board follows the lead now, not the view");
  assert.ok(view.text().some((line) => line.includes("Nested reply")));
  view.press(KEY.right, KEY.right);
  assert.equal(view.text()[0], "other · running · worker 4 of 4");
  view.press(KEY.right);
  assert.equal(view.text()[0], "other · running · worker 4 of 4", "the last worker stays");
  view.press(KEY.left, KEY.left, KEY.left, KEY.left);
  assert.equal(view.text()[0], "lead · running · worker 1 of 4", "the first worker stays");

  view.press(KEY.down, KEY.down, KEY.up, KEY.enter);
  assert.equal(view.text()[0], "worker · running · worker 2 of 4");
  assert.ok(view.text().some((line) => line.includes("Nested reply")), "Enter opened the selected nested worker");
  assert.equal(nested.fake.listeners.size, 2, "the board and the view follow it");
  view.press(KEY.left, KEY.down, KEY.enter);
  assert.equal(view.text()[0], "worker · running · worker 3 of 4", "the second nested worker");
  view.press(KEY.enter);
  assert.equal(view.text()[0], "worker · running · worker 3 of 4", "Enter without nested workers does nothing");
});

test("x stops the shown worker after a confirmation, and the view stays open with its aborted end state", async () => {
  const board = new WorkerBoard();
  let feed!: WorkerFeed;
  const stops: string[] = [];
  feed = board.add({ callId: "call-1", background: true, task: "Long job", delegationId: "bg-1", model: { kind: "routed" } },
    { stop: () => { stops.push("bg-1"); feed.ended({ state: "aborted" }); } });
  feed.started();
  feed.session(fakeSession("bg-1", [user("Long job")]).session);
  const view = fakeUI(12);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);

  view.press("x");
  assert.equal(view.text().at(-1), "Stop this worker? y/n");
  view.press("n");
  assert.match(view.text().at(-1)!, /^following/);
  view.press("x", KEY.escape);
  assert.equal(view.closed, false, "Esc answers the confirmation, and the view stays open");
  assert.deepEqual(stops, [], "no answers other than y stop the worker");

  view.press("x", "y");
  assert.deepEqual(stops, ["bg-1"]);
  assert.equal(view.text()[0], "worker · aborted · worker 1 of 1");
  assert.ok(view.text().includes("The worker was aborted."));
  assert.equal(view.text().at(-1), "Stopping this worker.");
  assert.equal(view.closed, false, "the view stays open");
  view.press("x");
  assert.equal(view.text().at(-1), "This worker has already finished.");
  assert.ok(!view.text().at(-1)!.includes("Stop this worker"));
  view.press(KEY.escape);
  await shown;
  assert.equal(board.workers()[0]!.state, "aborted");
});

test("a finished worker's transcript is read from its session file without changing it; an unsaved one from the board", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-transcript-view-"));
  try {
    const session = SessionManager.create(dir, dir);
    session.appendMessage(user("Summarise the log") as never);
    session.appendMessage({ ...reply("The log is quiet."), api: "fake", provider: "fake", model: "fake",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } as never);
    const file = session.getSessionFile()!;
    const before = readFileSync(file, "utf8");
    const board = new WorkerBoard();
    const saved = board.add({ callId: "call-1", background: false, task: "Summarise the log", model: { kind: "routed" } });
    saved.started();
    saved.ended({ state: "completed", sessionFile: file });
    const view = fakeUI(20);
    void openTranscript(view.ui, board, board.workers()[0]!.id);
    const text = view.text();
    assert.equal(text[0], "worker · completed · worker 1 of 1");
    assert.ok(text.some((line) => line.includes("Summarise the log")), JSON.stringify(text));
    assert.ok(text.some((line) => line.includes("The log is quiet.")));
    assert.ok(text.includes("The worker completed."), "its end state");
    assert.ok(!text.at(-1)!.includes("x stop"), "a finished worker cannot be stopped");
    assert.equal(readFileSync(file, "utf8"), before, "the session file is only read");

    // The orchestrator's session was in memory, so the worker's was not saved.
    const unsaved = board.add({ callId: "call-2", background: false, task: "In memory", model: { kind: "routed" } });
    unsaved.started();
    unsaved.session({ ...fakeSession("memory-1", [user("In memory"), reply("Kept by the board")]).session, sessionFile: undefined });
    unsaved.ended({ state: "completed" });
    view.press(KEY.right);
    assert.ok(view.text().some((line) => line.includes("Kept by the board")));

    const broken = board.add({ callId: "call-3", background: false, task: "Lost", model: { kind: "routed" } });
    broken.started();
    broken.ended({ state: "failed", sessionFile: join(dir, "missing.jsonl"), error: "the worker's model call failed" });
    view.press(KEY.right);
    assert.ok(view.text().some((line) => line.startsWith(`The transcript could not be read from ${join(dir, "missing.jsonl")}`)), JSON.stringify(view.text()));
    assert.ok(view.text().includes("The worker failed: the worker's model call failed"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a worker that finishes while shown stays open with its whole transcript and end state; a queued one opens once it starts", async () => {
  const board = new WorkerBoard();
  const { feed, fake } = running(board, "Quick job", "worker-1");
  const queued = board.add({ callId: "call-1", background: false, task: "Waits its turn", model: { kind: "routed" } });
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  fake.add(reply("Finished the job"));
  feed.ended({ state: "completed", sessionFile: "/nowhere/worker-1.jsonl" });
  await settle();
  assert.equal(view.closed, false, "the view never closes on its own");
  assert.equal(view.text()[0], "worker · completed · worker 1 of 2");
  assert.ok(view.text().some((line) => line.includes("Finished the job")), "the live transcript is kept, not reread");
  assert.ok(view.text().includes("The worker completed."));

  view.press(KEY.right);
  assert.ok(view.text().includes("The worker is queued: it starts when a parallel slot frees."));
  queued.started();
  const later = fakeSession("worker-2", [user("Waits its turn"), reply("Now running")]);
  queued.session(later.session);
  assert.ok(view.text().some((line) => line.includes("Now running")), "the view follows it once its session exists");
  assert.equal(later.listeners.size, 2);
  view.press(KEY.escape);
  await shown;
});
