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
import { LINGER_MS } from "./worker-widget.ts";
import { openTranscript, TRANSCRIPT_OVERLAY, type TranscriptUI } from "./transcript-view.ts";
import { formatCost, formatTokens } from "./transcript-header.ts";

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
function running(board: WorkerBoard, task: string, sessionId: string, extra: { agent?: string; label?: string; review?: string; parentDelegationId?: string; background?: boolean } = {}, messages: Message[] = [user(task)]) {
  const feed = board.add({ callId: "call-1", background: false, task, ...extra, model: { kind: "routed" } });
  feed.started();
  const fake = fakeSession(sessionId, messages);
  feed.session(fake.session);
  return { feed, fake };
}

/** ctx.ui.custom as pi mounts a full-screen overlay: the factory gets a TUI,
 *  a theme, pi's keybindings manager and done, which resolves the call. */
function fakeUI(rows = 20, mode?: "fullscreen") {
  const tui = { mode, terminal: { rows }, renders: 0, requestRender() { this.renders++; } };
  let component: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
  let options: unknown;
  let closed = false;
  const ui: TranscriptUI = {
    custom: (async (factory: (...args: unknown[]) => unknown, customOptions: unknown) => {
      options = customOptions;
      return new Promise<void>((resolve) => {
        component = factory(tui, PLAIN, new KeybindingsManager(), (result: unknown) => {
          closed = true;
          component?.dispose();
          resolve(result as never);
        }) as typeof component;
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

/** A clock a test moves on, from a local time of day, so `since` times read the same in any time zone. */
function clock(start = new Date(2026, 8, 26, 12, 0, 0).getTime()) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

/** The session picker's hint and rows: the cursor and a filled dot, or two spaces and a hollow dot. */
const SESSION_PICKER_HINT = "  ↑/↓ to select · Enter to open · Esc to go back";
const PICKER_ROW = /^(?:❯ ●|  ○) /;
const NESTED_ROW = /^(?:❯ ●|  ○) └ /;

/** The header's lines: after the orchestrator bar, up to the session picker or the rule. */
function header(view: ReturnType<typeof fakeUI>, width = WIDTH): string[] {
  const text = view.text(width);
  const start = text[0]!.startsWith("orchestrator ") ? 1 : 0;
  const end = text.findIndex((line, index) => index > start && (line.startsWith("─") || line === SESSION_PICKER_HINT));
  return text.slice(start, end);
}

/** Which worker the view shows: its agent, worker state and place, from the header's first line. */
function shownWorker(view: ReturnType<typeof fakeUI>): string {
  const parts = header(view)[0]!.split(" · ");
  return [parts[0], parts[1], parts.at(-1)].join(" · ");
}

/** The visible main-plus-workers picker rows. */
function pickerLines(view: ReturnType<typeof fakeUI>, width = WIDTH): string[] {
  return view.text(width).filter((line) => PICKER_ROW.test(line));
}

/** The visible nested worker rows. */
function nestedLines(view: ReturnType<typeof fakeUI>, width = WIDTH): string[] {
  return view.text(width).filter((line) => NESTED_ROW.test(line));
}

/** A worker's reply with its usage, as pi reports it at message_end. */
const usage = (input: number, output: number, cacheRead: number, cacheWrite: number, cost: number) => ({
  role: "assistant", content: [{ type: "text", text: "Working" }], timestamp: 0,
  usage: { input, output, cacheRead, cacheWrite, totalTokens: input + output + cacheRead + cacheWrite, cost: { total: cost } },
});

test("the view covers the whole screen, fits every line to it, and Esc or ctrl+c restores the orchestrator's session", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Fix the typo", "worker-1", { agent: "fixer" }, [user("Fix the typo"), reply(`A long line ${"x".repeat(300)}`)]);
  const view = fakeUI(12);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const options = view.options as { overlay: boolean; overlayOptions: () => unknown };
  assert.equal(options.overlay, true);
  assert.deepEqual(options.overlayOptions(), TRANSCRIPT_OVERLAY, "fullscreen tuiMode, and a TUI that names none, keep the overlay");
  assert.deepEqual(TRANSCRIPT_OVERLAY, { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 });

  const lines = view.lines(60);
  assert.equal(lines.length, 12, "exactly the terminal's height");
  assert.ok(lines.every((line) => plain(line).length <= 60), JSON.stringify(lines.map(plain)));
  assert.equal(shownWorker(view), "fixer · running · worker 1 of 1");
  assert.deepEqual(pickerLines(view), ["  ○ main", "❯ ● fixer   routing… · 0s · running"], "the viewed worker is highlighted beside main");
  assert.ok(view.text().some((line) => line.includes("Fix the typo")));
  view.tui.terminal.rows = 30;
  assert.equal(view.lines().length, 30, "a resize redraws at the new size");

  view.press("q", KEY.left, "z");
  assert.equal(view.closed, false, "other keys keep it open");
  view.press(KEY.kittyEscape);
  assert.equal(await shown, "back");
  assert.equal(view.closed, true, "Esc under the kitty keyboard protocol leaves");
  assert.equal(fake.listeners.size, 1, "the view stopped following the worker's session; only the board does");
  const renders = view.tui.renders;
  fake.emit({ type: "turn_start" });
  board.add({ callId: "call-2", background: false, task: "Later", model: { kind: "routed" } });
  board.setOrchestratorState("running");
  assert.equal(view.tui.renders, renders, "nor does the board redraw it, the orchestrator bar included");

  for (const key of [KEY.escape, KEY.ctrlC, "\x1b[99;5u"]) {
    const again = fakeUI();
    const reopened = openTranscript(again.ui, board, board.workers()[0]!.id);
    again.press(key);
    await reopened;
    assert.equal(again.closed, true, `${JSON.stringify(key)} leaves`);
  }
  await assert.rejects(openTranscript(fakeUI().ui, board, "no-such-worker"), /No worker on the board has the id no-such-worker/);
});

test("the session picker switches workers and Enter on main returns to the orchestrator editor", async () => {
  const board = new WorkerBoard();
  running(board, "Lead the work", "lead-1", { agent: "lead" });
  const other = running(board, "Other work", "other-1", { agent: "other" });
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[1]!.id);

  assert.deepEqual(pickerLines(view), [
    "  ○ main",
    "  ○ lead    routing… · 0s · running",
    "❯ ● other   routing… · 0s · running",
  ]);
  view.press(KEY.up, KEY.enter);
  assert.equal(shownWorker(view), "lead · running · worker 1 of 2", "Enter opens the selected worker from the picker");
  assert.equal(other.fake.listeners.size, 1, "the view stopped following the prior worker");
  view.press(KEY.up, KEY.enter);
  assert.equal(pickerLines(view)[0], "❯ ● main", "main is selected before it is opened");
  assert.equal(await shown, "main", "Enter on main leaves the transcript view");
  assert.equal(view.closed, true);
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

test("left and right switch workers, and the session picker opens any worker or returns to main", async () => {
  const board = new WorkerBoard();
  const lead = running(board, "Lead the work", "lead-1", { agent: "lead" });
  running(board, "Other work", "other-1", { agent: "other" });
  const nested = running(board, "Nested work", "nested-1", { parentDelegationId: "lead-1" }, [user("Nested work"), reply("Nested reply")]);
  running(board, "Second nested", "nested-2", { parentDelegationId: "lead-1" });
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);

  assert.equal(shownWorker(view), "lead · running · worker 1 of 4");
  assert.equal(view.text().filter((line) => line === SESSION_PICKER_HINT).length, 1, "the session picker shows the same controls above the rows");
  assert.equal(pickerLines(view).length, 5, "main and every worker have a row");
  assert.equal(pickerLines(view)[0], "  ○ main");
  assert.match(pickerLines(view)[1]!, /^❯ ● lead/);
  assert.match(pickerLines(view)[2]!, /^  ○ └ worker/);
  assert.match(pickerLines(view)[3]!, /^  ○ └ worker/);
  assert.match(pickerLines(view)[4]!, /^  ○ other/);

  view.press(KEY.right);
  assert.equal(shownWorker(view), "worker · running · worker 2 of 4", "right switches to the next worker");
  assert.equal(lead.fake.listeners.size, 1, "only the board follows the lead now, not the view");
  assert.ok(view.text().some((line) => line.includes("Nested reply")));
  view.press(KEY.right, KEY.right);
  assert.equal(shownWorker(view), "other · running · worker 4 of 4");
  view.press(KEY.right);
  assert.equal(shownWorker(view), "other · running · worker 4 of 4", "the last worker stays");
  view.press(KEY.left, KEY.left, KEY.left, KEY.left);
  assert.equal(shownWorker(view), "lead · running · worker 1 of 4", "the first worker stays");

  view.press(KEY.down, KEY.enter);
  assert.equal(shownWorker(view), "worker · running · worker 2 of 4");
  assert.ok(view.text().some((line) => line.includes("Nested reply")), "Enter opened the selected nested worker");
  assert.equal(nested.fake.listeners.size, 2, "the board and the view follow it");
  view.press(KEY.down, KEY.enter);
  assert.equal(shownWorker(view), "worker · running · worker 3 of 4", "the next picker row opens the second nested worker");
  view.press(KEY.enter);
  assert.equal(shownWorker(view), "worker · running · worker 3 of 4", "Enter keeps the selected worker open");
  view.press(KEY.up, KEY.up, KEY.up, KEY.enter);
  assert.equal(await shown, "main", "the main row returns to the orchestrator editor");
  assert.equal(view.closed, true);
});

test("the session picker lists the workers the main widget lists: a finished worker only while it lingers or while viewed", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const done = running(board, "Done work", "done-1", { agent: "done" });
  running(board, "Live work", "live-1", { agent: "live" });
  done.feed.ended({ state: "completed" });
  time.advance(LINGER_MS + 1);
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[1]!.id, { now: time.now });

  assert.deepEqual(pickerLines(view).map((line) => line.slice(0, 10).trimEnd()), ["  ○ main", "❯ ● live"], "the finished worker is hidden, the running one listed");
  assert.equal(shownWorker(view), "live · running · worker 2 of 2", "stepping and the count still cover every worker");
  view.press(KEY.left);
  assert.equal(shownWorker(view), "done · completed · worker 1 of 2", "left still steps onto the finished worker");
  assert.deepEqual(pickerLines(view).map((line) => line.slice(0, 10).trimEnd()), ["  ○ main", "❯ ● done", "  ○ live"], "the viewed finished worker is listed and highlighted");
  view.press(KEY.down);
  view.press(KEY.right);
  assert.deepEqual(pickerLines(view).map((line) => line.slice(0, 10).trimEnd()), ["  ○ main", "❯ ● live"], "it is hidden again once another worker is viewed");
});

test("the session picker lists a worker that finished moments ago", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const done = running(board, "Done work", "done-1", { agent: "done" });
  running(board, "Live work", "live-1", { agent: "live" });
  done.feed.ended({ state: "completed" });
  time.advance(LINGER_MS - 1);
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[1]!.id, { now: time.now });
  assert.equal(pickerLines(view).length, 3, "main, the lingering worker and the running worker");
  time.advance(2);
  assert.equal(pickerLines(view).length, 2, "the linger is over");
});

test("the picker keeps nested worker names in one column and fits narrow rows", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  running(board, "Lead the work", "lead-1", { agent: "lead" });
  const nested = running(board, "Weighing Entra state-parameter guidance", "nested-1", { agent: "orchestrator:verifying-work", parentDelegationId: "lead-1" });
  running(board, "Check the tests", "nested-2", { agent: "tester", parentDelegationId: "lead-1" });
  nested.fake.emit({ type: "message_end", message: usage(133_000, 0, 0, 0, 0) });
  time.advance(488_000);
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now });

  assert.deepEqual(nestedLines(view, 100), [
    "  ○ └ orchestrator:verifying-work   routing… · 8m08s · running",
    "  ○ └ tester                        routing… · 8m08s · running",
  ]);
  assert.deepEqual(nestedLines(view, 50), [
    "  ○ └ orchestrator:v…   routing… · 8m08s · running",
    "  ○ └ tester            routing… · 8m08s · running",
  ], "the name takes the room the details leave");
  assert.equal(nestedLines(view, 30)[0], "  ○ └ orc…   routing… · 8m08s", "a short name, then the details cut from the end");
  assert.equal(nestedLines(view, 12)[0], "  ○ └ orc…", "only the name when no details fit");
  for (const width of [100, 72, 50, 40, 30, 20, 12, 8, 4, 1]) {
    for (const line of view.text(width)) assert.ok(line.length <= width, `${width}: ${line}`);
  }
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
  assert.equal(shownWorker(view), "worker · aborted · worker 1 of 1");
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
    const view = fakeUI(32);
    void openTranscript(view.ui, board, board.workers()[0]!.id);
    const text = view.text();
    assert.equal(shownWorker(view), "worker · completed · worker 1 of 1");
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
    // Wider than the screen whatever the temp folder, so the notice must wrap, not lose the path.
    const missing = join(dir, `${"missing-".repeat(15)}.jsonl`);
    broken.ended({ state: "failed", sessionFile: missing, error: "the worker's model call failed" });
    view.press(KEY.right);
    const shown = view.text();
    const notice = shown.findIndex((line) => line.startsWith("The transcript could not be read from"));
    assert.ok(notice >= 0, JSON.stringify(shown));
    assert.ok(shown.slice(notice, notice + 4).join("").replace(/\s/g, "").includes(missing.replace(/\s/g, "")), JSON.stringify(shown));
    assert.ok(view.text().includes("The worker failed: the worker's model call failed"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("the header's first line shows the worker's agent, worker state, elapsed time, turns, tokens, cost, activity, and which worker of how many it is", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const { fake } = running(board, "Check the tests", "worker-1", { agent: "tester" });
  board.add({ callId: "call-1", background: false, task: "Waits its turn", model: { kind: "routed" } });
  fake.emit({ type: "turn_start" });
  fake.emit({ type: "message_end", message: usage(8_000, 1_200, 3_000, 134, 0.0421) });
  fake.emit({ type: "turn_start" });
  time.advance(75_000);
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now });

  assert.equal(header(view)[0], "tester · running · 1m15s · 2 turns · 12.3k tok · $0.042 · thinking… · worker 1 of 2");
  fake.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "npm test" } });
  assert.equal(header(view)[0], "tester · running · 1m15s · 2 turns · 12.3k tok · $0.042 · bash · worker 1 of 2",
    "the tool's name, as the worker widget shows it");
  view.press(KEY.right);
  assert.equal(header(view)[0], "worker · queued · worker 2 of 2", "a queued worker has no elapsed time, turns, tokens or cost yet");
});

test("the header shows a routed worker's rung history, live, each rung since when and its escalation; a fork's and a preserved model's fixed model", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  running(board, "Routed work", "routed-1");
  board.add({ callId: "call-1", background: false, task: "Forked work", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });
  board.add({ callId: "call-1", background: false, task: "Preserved work", agent: "scout", model: { kind: "preserved", model: "anthropic/claude-sonnet-4-5", effort: "medium" } });
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now });
  assert.equal(header(view)[1], "routing…", "before its first request");

  time.advance(5_000);
  const renders = view.tui.renders;
  board.served({ delegationId: "routed-1", model: "anthropic/claude-haiku-4-5", effort: "low", escalation: { from: "mechanical", to: "standard" } });
  assert.ok(view.tui.renders > renders, "a served rung redraws the view");
  assert.equal(header(view)[1], "anthropic/claude-haiku-4-5:low since 12:00:05 (escalated from mechanical to standard)");
  time.advance(60_000);
  board.served({ delegationId: "routed-1", model: "anthropic/claude-sonnet-4-5", effort: "high" });
  assert.equal(header(view, 200)[1],
    "anthropic/claude-haiku-4-5:low since 12:00:05 (escalated from mechanical to standard), then anthropic/claude-sonnet-4-5:high since 12:01:05");
  assert.equal(header(view)[1], "… then anthropic/claude-sonnet-4-5:high since 12:01:05", "a narrow terminal keeps the rung serving the latest request");

  view.press(KEY.right);
  assert.equal(header(view)[1], "anthropic/claude-opus-4-5:high (the session model, not routed)");
  view.press(KEY.right);
  assert.equal(header(view)[1], "anthropic/claude-sonnet-4-5:medium (the agent definition's model, not routed)");
});

test("the header shows the delegation id, a nested worker's parent delegation with its agent, short ids on a narrow terminal, and the task", async () => {
  const LEAD = "0199f0b1-7c2d-7e3f-8a4b-5c6d7e8f9a0b", TESTER = "0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0";
  const board = new WorkerBoard();
  running(board, "Lead the work", LEAD, { agent: "lead" });
  running(board, "\n  Check   the tests\nThen report back", TESTER, { agent: "tester", parentDelegationId: LEAD });
  board.add({ callId: "call-2", background: false, task: "Waits its turn", model: { kind: "routed" } });
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[1]!.id);

  assert.deepEqual(header(view, 120).slice(2), [`delegation ${TESTER} · parent delegation ${LEAD} (lead)`, "Check the tests", "Then report back"]);
  assert.deepEqual(header(view, 60).slice(2), ["delegation 0199f0c2… · parent delegation 0199f0b1… (lead)", "Check the tests", "Then report back"],
    "short delegation ids on a narrow terminal");
  view.press(KEY.left);
  assert.equal(header(view)[2], `delegation ${LEAD}`, "a worker of the orchestrator has no parent delegation");
  view.press(KEY.right, KEY.right);
  assert.equal(header(view)[2], "no delegation id yet", "a queued foreground worker");
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
  assert.equal(shownWorker(view), "worker · completed · worker 1 of 2");
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

test("the orchestrator bar shows whether the orchestrator runs and which workers ask, live, and never closes the view or takes its keys", async () => {
  const board = new WorkerBoard();
  running(board, "Lead the work", "lead-1", { agent: "lead" });
  running(board, "Review it", "reviewer-1", { agent: "reviewer", background: true });
  running(board, "Check it", "checker-1", { background: true });
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.equal(view.text()[0], "orchestrator idle");

  let renders = view.tui.renders;
  board.setOrchestratorState("running");
  assert.ok(view.tui.renders > renders, "a change of the orchestrator's state redraws the view");
  assert.equal(view.text()[0], "orchestrator running");
  renders = view.tui.renders;
  board.asking("reviewer-1", true);
  assert.ok(view.tui.renders > renders, "a worker asking redraws the view");
  assert.equal(view.text()[0], "orchestrator running · 1 worker asking: worker 2 (reviewer)");
  board.asking("checker-1", true);
  board.setOrchestratorState("idle");
  assert.equal(view.text()[0], "orchestrator idle · 2 workers asking: worker 2 (reviewer), worker 3");
  assert.equal(view.text(40)[0], "orchestrator idle · 2 workers asking: w…", "a narrow terminal cuts the bar");
  board.asking("reviewer-1", false);
  assert.equal(view.text()[0], "orchestrator idle · 1 worker asking: worker 3");

  await settle();
  assert.equal(view.closed, false, "nothing in the bar closes the view");
  assert.equal(shownWorker(view), "lead · running · worker 1 of 3", "it still shows the worker it showed");
  view.press(KEY.right);
  assert.equal(shownWorker(view), "reviewer · running · worker 2 of 3", "the keys still move the view");
  view.press(KEY.escape);
  await shown;
});

test("the view redraws every second while open, so the elapsed time ticks, and its timer stops when it closes", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  running(board, "Take a while", "worker-1");
  const ticks: (() => void)[] = [];
  const cleared: unknown[] = [];
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, {
    now: time.now,
    setInterval: (tick, ms) => { assert.equal(ms, 1_000); ticks.push(tick); return "timer"; },
    clearInterval: (handle) => { cleared.push(handle); },
  });
  assert.equal(header(view)[0], "worker · running · 0s · 0 turns · 0 tok · $0.000 · worker 1 of 1");
  assert.equal(ticks.length, 1, "one timer while the view is open");

  time.advance(3_000);
  const renders = view.tui.renders;
  ticks[0]!();
  assert.equal(view.tui.renders, renders + 1, "each tick redraws the view");
  assert.equal(header(view)[0], "worker · running · 3s · 0 turns · 0 tok · $0.000 · worker 1 of 1");
  view.press(KEY.escape);
  await shown;
  assert.deepEqual(cleared, ["timer"], "leaving the view stops its timer");
});

test("in fullscreen tuiMode the header wraps the task to at most 3 lines, ending in … when it is longer", async () => {
  const board = new WorkerBoard();
  const words = Array.from({ length: 60 }, (_, index) => `word${index + 1}`).join(" ");
  running(board, words, "worker-1");
  running(board, "Short task", "worker-2");
  const view = fakeUI(30, "fullscreen");
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  const task = header(view, 60).slice(3);
  assert.equal(task.length, 3, JSON.stringify(task));
  assert.ok(task.every((line) => line.length <= 60));
  assert.ok(task[0]!.startsWith("word1 word2"));
  assert.ok(task[2]!.endsWith("…"), task[2]);
  assert.ok(!task.join(" ").includes("word60"));
  view.press(KEY.right);
  assert.deepEqual(header(view, 60).slice(3), ["Short task"], "a short task takes one line, with no …");
});

/** ctx.ui.custom in regular tuiMode: pi's root holds its chat, editor and
 *  widgets as children; the view swaps them out and puts them back. The
 *  overlay pi mounts is the view's key stub, which draws nothing. */
function regularUI(rows = 10) {
  const chat = { render: () => ["chat line"], invalidate() {} };
  const editor = { render: () => ["editor text"], invalidate() {} };
  const widget = { render: () => ["worker widget"], invalidate() {} };
  const forced: boolean[] = [];
  const tui = {
    mode: "regular" as const, terminal: { rows }, children: [chat, editor, widget] as { render(width: number): string[] }[],
    clear() { this.children = []; }, addChild(child: { render(width: number): string[] }) { this.children.push(child); },
    requestRender(force?: boolean) { forced.push(force === true); },
  };
  const original = [...tui.children];
  let stub: { render(width: number): string[]; handleInput(data: string): void; dispose(): void } | undefined;
  let overlayOptions: unknown;
  let childrenAtDone: unknown[] | undefined;
  let closed = false;
  const ui: TranscriptUI = {
    custom: (async (factory: (...args: unknown[]) => unknown, options: { overlay?: boolean; overlayOptions?: unknown }) => {
      assert.equal(options.overlay, true);
      return new Promise<unknown>((resolve) => {
        stub = factory(tui, PLAIN, new KeybindingsManager(), (result: unknown) => {
          childrenAtDone = [...tui.children];
          closed = true;
          stub?.dispose();
          resolve(result);
        }) as typeof stub;
        overlayOptions = typeof options.overlayOptions === "function" ? options.overlayOptions() : options.overlayOptions;
      });
    }) as TranscriptUI["custom"],
    getToolsExpanded: () => false,
  };
  /** What the terminal shows: every root child's lines. */
  const text = (width = WIDTH) => tui.children.flatMap((child) => child.render(width)).map((line) => plain(line).trimEnd());
  return {
    ui, tui, original, forced, text,
    get stub() { return stub!; },
    get overlayOptions() { return overlayOptions; },
    get childrenAtDone() { return childrenAtDone; },
    get closed() { return closed; },
    press(...keys: string[]) { for (const key of keys) stub!.handleInput(key); },
  };
}

test("in regular tuiMode the view replaces pi's whole view while open and puts it back intact on leaving", async () => {
  const board = new WorkerBoard();
  running(board, "Fix the typo", "worker-1", { agent: "fixer" }, [user("Fix the typo"), reply("Fixed it")]);
  running(board, "Other work", "worker-2", { agent: "other" }, [user("Other work"), reply("Other reply")]);
  const view = regularUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);

  assert.equal(view.tui.children.length, 1, "pi's chat, editor and widgets are swapped out");
  assert.ok(!view.text().some((line) => ["chat line", "editor text", "worker widget"].includes(line)));
  assert.ok(view.text().some((line) => line.includes("Fixed it")));
  assert.deepEqual(view.stub.render(WIDTH), [], "the overlay only takes the keys");
  assert.deepEqual(view.overlayOptions, { width: 1, maxHeight: 1, anchor: "bottom-left", margin: 0 });
  assert.equal(view.forced.at(-1), true, "opening reprints the terminal");

  view.forced.length = 0;
  view.press(KEY.right);
  assert.ok(view.text().some((line) => line.includes("Other reply")), "→ switches worker");
  assert.equal(view.forced.at(-1), true, "switching reprints and lands at the bottom");
  view.press(KEY.left);
  view.press(KEY.up, KEY.enter);
  assert.equal(await shown, "main", "Enter on main leaves the transcript view");
  assert.deepEqual(view.childrenAtDone, view.original, "pi's tree is back before pi's close restores the editor and its focus");
  assert.equal(view.forced.at(-1), true, "leaving reprints");
});

test("in regular tuiMode the view prints its top once, the whole transcript, and live lines last; scroll keys are gone", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const task = `Check the tests. ${"Then look further. ".repeat(20)}The very end.`;
  const numbers = Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n");
  const { fake } = running(board, task, "0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0", { agent: "tester" }, [user(task), reply(numbers)]);
  board.add({ callId: "call-2", background: false, task: "Waits its turn", model: { kind: "routed" } });
  fake.emit({ type: "turn_start" });
  time.advance(75_000);
  const view = regularUI(10);
  void openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now });
  const text = view.text(60);

  assert.deepEqual(text.slice(0, 3), ["tester", "routing…", "delegation 0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0"]);
  const top = text.slice(3, text.findIndex((line) => line.startsWith("─")));
  assert.ok(top.length > 3, "the whole task, wrapped without a limit");
  assert.ok(top.every((line) => line.length <= 60));
  assert.equal(top.join(" ").replace(/\s+/g, " "), task.trim());
  assert.ok(text.length > 40, "the transcript in full, not windowed to the terminal");
  assert.ok(text.some((line) => line.trim() === "number 1") && text.some((line) => line.trim() === "number 40"));
  assert.deepEqual(view.text().slice(-3), [
    "running · 1m15s · 1 turn · 0 tok · $0.000 · thinking… · worker 1 of 2",
    "orchestrator idle",
    "←→ worker · x stop · ctrl+o tool output · Esc back",
  ]);

  for (const key of [KEY.pageUp, KEY.pageDown, KEY.home, KEY.end]) {
    view.press(key);
    assert.deepEqual(view.text(60), text, `${JSON.stringify(key)} does nothing: the terminal scrolls`);
  }
  view.forced.length = 0;
  view.press(KEY.ctrlO);
  assert.deepEqual(view.forced, [false], "a key that keeps the worker redraws without reprinting");
  view.press(KEY.ctrlO);
  view.press("x");
  assert.equal(view.text(60).at(-1), "Stop this worker? y/n");
  view.press("n");
  board.setOrchestratorState("running");
  assert.equal(view.text(60).at(-2), "orchestrator running", "the live lines follow the board");
  assert.equal(view.closed, false);
});

test("the transcript's nested worker row is the widget's: label, tier, short rung, elapsed time and state, while the header keeps the full rung and turns", () => {
  const board = new WorkerBoard();
  running(board, "Lead", "lead-1");
  const nested = running(board, "Check budget", "nested-1", { parentDelegationId: "lead-1", label: "budget code" });
  board.setTier("nested-1", "standard");
  board.served({ delegationId: "nested-1", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
  nested.fake.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  const view = regularUI();
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.match(view.text(160).find((line) => NESTED_ROW.test(line))!, /^  ○ └ budget code   standard · opus-5-5:xhigh · \d+s · running · bash$/);
  view.press(KEY.down, KEY.enter);
  const text = view.text(160);
  assert.ok(text.some((line) => line.startsWith("anthropic/claude-opus-5-5:xhigh since ")), text.join("\n"));
  assert.ok(text.some((line) => /^running · \d+s · 0 turns · /.test(line)), text.join("\n"));
  view.press(KEY.escape);
});

test("in regular tuiMode the session picker stays live above the stats line and scrolls to the selected worker", async () => {
  const board = new WorkerBoard();
  running(board, "Lead the work", "lead-1", { agent: "lead" });
  const feeds: WorkerFeed[] = [];
  for (let item = 1; item <= 8; item++) {
    feeds.push(running(board, `Nested ${item}`, `nested-${item}`, { parentDelegationId: "lead-1", label: `nested ${item}` }, [user(`Nested ${item}`), reply(`Reply ${item}`)]).feed);
  }
  const view = regularUI();
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  const live = () => {
    const text = view.text();
    const stats = text.findIndex((line) => line.startsWith("running · "));
    const hint = text.findIndex((line) => line.startsWith(SESSION_PICKER_HINT));
    return { picker: text.slice(hint + 2, stats), hint: text[hint], rest: text.slice(stats) };
  };

  assert.equal(live().picker.length, 7, "main stays visible above up to 6 worker rows");
  assert.equal(live().hint, `${SESSION_PICKER_HINT} · 1–6 of 9`);
  assert.match(live().picker[0]!, /^  ○ main$/);
  assert.match(live().picker[1]!, /^❯ ● lead/);
  assert.match(live().picker[2]!, /^  ○ └ nested 1/);
  assert.match(live().picker[6]!, /^  ○ └ nested 5/);
  assert.equal(live().rest.at(-1), "←→ worker · x stop · ctrl+o tool output · Esc back");

  view.press(...Array.from({ length: 8 }, () => KEY.down));
  assert.match(live().picker[6]!, /^❯ ● └ nested 8   routing… · \d+s · running$/, "the window scrolls to keep the selected worker visible");
  assert.match(live().picker[1]!, /^  ○ └ nested 3   routing… · \d+s · running$/);
  view.press(KEY.up);
  assert.match(live().picker[6]!, /^❯ ● └ nested 7   routing… · \d+s · running$/, "the window moves with the selection");

  feeds[7]!.ended({ state: "completed" });
  view.press(KEY.down);
  assert.match(live().picker[6]!, /^❯ ● └ nested 8   routing… · \d+s · completed$/, "the list follows the board live");
  view.press(KEY.up);
  view.forced.length = 0;
  view.press(KEY.enter);
  assert.ok(view.text().some((line) => line.includes("Reply 7")), "Enter opens the selected worker in the same view");
  assert.equal(view.forced.at(-1), true, "and reprints");
  assert.match(live().picker[0]!, /^  ○ main$/, "the picker remains visible on a nested worker");
  assert.match(live().picker[6]!, /^❯ ● └ nested 7/, "the viewed worker stays selected");
  assert.equal(view.text().at(-1), "←→ worker · x stop · ctrl+o tool output · Esc back");
});

test("the header's token counts and cost read short, and a count never rounds up past its unit", () => {
  assert.deepEqual([999, 1_000, 12_345, 99_949, 99_950, 999_499, 999_500, 1_234_567].map(formatTokens),
    ["999", "1.0k", "12.3k", "99.9k", "100k", "999k", "1.0M", "1.2M"]);
  assert.deepEqual([0, 0.0421, 1.5].map(formatCost), ["$0.000", "$0.042", "$1.500"]);
});
