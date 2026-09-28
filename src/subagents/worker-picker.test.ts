import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
// pi's own keybindings manager, the one it hands a ctx.ui.custom factory; its public entry exports only the type.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { WorkerBoard, type WorkerSession } from "./worker-board.ts";
import { findWorker, pickWorker, workerListing, type WorkerPickerUI } from "./worker-picker.ts";

// The /subagents picker (xytd) on a real worker board, fed as the subagents
// extension feeds it, through a fake ctx.ui.custom that mounts the picker in
// the editor's place as pi does. The clock is a counter, so a finished worker
// can be long past the widget's linger. A plain theme leaves the text
// uncoloured, so each line reads as the user sees it.

const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", kittyEscape: "\x1b[27u", ctrlC: "\x03" };
const WIDTH = 60;

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function fakeSession(sessionId: string, listeners = new Set<(event: AgentSessionEvent) => void>()): WorkerSession {
  return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, effort: "medium", messages: () => [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

/** A reply's usage, as pi reports it at message_end: `total` tokens, all input. */
const usage = (total: number) => ({ type: "message_end", message: { role: "assistant", content: [], timestamp: 0,
  usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { total: 0 } } } }) as unknown as AgentSessionEvent;

interface Mounted {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
}

/** ctx.ui.custom as pi mounts a component in the editor's place: with a TUI,
 *  a theme, pi's keybindings manager and a done that restores the editor. */
function fakeUI() {
  let mounted: Mounted | undefined;
  let renders = 0;
  const options: unknown[] = [];
  const ui: WorkerPickerUI = {
    custom: ((factory: (...args: unknown[]) => Mounted, customOptions: unknown) => {
      options.push(customOptions);
      return new Promise((resolve) => {
        const component = factory({ requestRender: () => { renders++; } }, PLAIN, new KeybindingsManager(), (result: unknown) => {
          mounted = undefined;
          component.dispose?.();
          resolve(result as never);
        });
        mounted = component;
      });
    }) as WorkerPickerUI["custom"],
  };
  return {
    ui, options,
    get open() { return mounted !== undefined; },
    get renders() { return renders; },
    lines: (width = WIDTH) => mounted!.render(width).map((line) => line.trimEnd()),
    press(...keys: string[]) { for (const key of keys) mounted!.handleInput(key); },
  };
}

/** A session's workers: a lead that finished long ago with its nested worker, and a queued one. */
function session() {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const lead = board.add({ callId: "call-1", background: false, task: "Lead the refactor", agent: "lead", model: { kind: "routed" } });
  lead.started();
  lead.session(fakeSession("lead-1"));
  const nested = board.add({ callId: "nested-call", background: false, task: "Check the tests", agent: "tester", parentDelegationId: "lead-1", model: { kind: "routed" } });
  nested.started();
  nested.session(fakeSession("nested-1"));
  nested.ended({ state: "completed" });
  lead.ended({ state: "failed", error: "the provider refused the request" });
  time.advance(60_000);
  board.add({ callId: "call-2", background: true, task: "Fix the typo", delegationId: "bg-1", model: { kind: "routed" } });
  return { time, board };
}

const HINT = "  ↑/↓ to select · Enter to open · Esc to cancel";
/** Wide enough for the tags, which count as columns when a line is fitted. */
const TAGGED_WIDTH = 200;
/** A picker row: the marks, the list number and name padded to the list's `column`, then its details. */
function pickerRow(selected: boolean, name: string, details: string, column: number): string {
  return `${selected ? "❯ ●" : "  ○"} ${name.padEnd(column)}   ${details}`;
}
const TAGGED = { fg: (color: string, text: string) => text === "" ? "" : `<${color}>${text}</>`, bold: (text: string) => `**${text}**` } as unknown as Theme;

test("the picker shows a labelled worker's row as the widget does: label, tier, short rung, elapsed time, state and one-word activity", async () => {
  const { time, board } = session();
  const feed = board.add({ callId: "call-3", background: false, task: "Check budget", label: "budget code", model: { kind: "routed" } });
  feed.started();
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  feed.session(fakeSession("budget-1", listeners));
  board.setTier("budget-1", "elevated");
  board.served({ delegationId: "budget-1", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
  for (const listener of listeners) listener({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" } as unknown as AgentSessionEvent);
  const screen = fakeUI();
  const picked = pickWorker(screen.ui, board, { now: time.now });
  assert.equal(screen.lines(140)[7], pickerRow(false, "4. budget code", "elevated · opus-5-5:xhigh · 0s · running · bash", 14));
  screen.press(KEY.escape);
  await picked;
});

test("the picker lists every worker of the session, finished ones included, as the worker widget's agent list: numbered in board order with nested workers indented; Enter picks one and Esc none", async () => {
  const { time, board } = session();
  const [lead, nested] = board.workers();
  const screen = fakeUI();

  const picked = pickWorker(screen.ui, board, { now: time.now });
  assert.deepEqual(screen.options, [undefined], "in the editor's place, as pi's own selector");
  const rule = "─".repeat(WIDTH);
  assert.deepEqual(screen.lines(), [
    rule,
    "Workers of this session",
    HINT,
    "",
    pickerRow(true, "1. lead", "routing… · 0s · failed", 11),
    pickerRow(false, "2. └ tester", "routing… · 0s · completed", 11),
    pickerRow(false, "3. worker", "routing… · queued", 11),
    rule,
  ], "no main row: the orchestrator has no transcript to open");
  screen.press(KEY.down);
  assert.deepEqual(screen.lines().slice(4, 6), [
    pickerRow(false, "1. lead", "routing… · 0s · failed", 11),
    pickerRow(true, "2. └ tester", "routing… · 0s · completed", 11),
  ], "the selected row has the cursor and the filled dot, every other one two spaces and a hollow dot");
  const renders = screen.renders;
  board.add({ callId: "call-3", background: false, task: "Arrives while picking", model: { kind: "routed" } });
  assert.ok(screen.renders > renders, "a board change redraws the picker");
  assert.equal(screen.lines()[7], pickerRow(false, "4. worker", "routing… · queued", 11));
  screen.press("q", KEY.enter);
  assert.equal(await picked, nested!.id);
  assert.equal(screen.open, false);

  for (const leave of [KEY.escape, KEY.kittyEscape, KEY.ctrlC]) {
    const none = pickWorker(screen.ui, board, { now: time.now });
    screen.press(KEY.down, leave);
    assert.equal(await none, undefined, JSON.stringify(leave));
    assert.equal(screen.open, false);
  }

  assert.equal(workerListing(board.workers(), time.now()), [
    "1. lead · routing… · 0s · failed",
    "2. └ tester · routing… · 0s · completed",
    "3. worker · routing… · queued",
    "4. worker · routing… · queued",
  ].join("\n"), "the list as text, where there is no UI to pick in, has the same rows");
  assert.ok(lead);
});

test("the picker's selected row has the cursor, a filled dot and a bold accent name; every other row a hollow dot and a muted name", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 2; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  const ui: WorkerPickerUI = { custom: ((factory: (...args: unknown[]) => Mounted) => {
    const component = factory({ requestRender() {} }, TAGGED, new KeybindingsManager(), () => {});
    rendered = component.render(TAGGED_WIDTH).map((line) => line.trimEnd());
    return new Promise(() => {});
  }) as WorkerPickerUI["custom"] };
  let rendered: string[] = [];
  void pickWorker(ui, board, { now: time.now });
  assert.deepEqual(rendered.slice(2, -1), [
    "  <dim>↑/↓ to select · Enter to open · Esc to cancel</>",
    "",
    "<accent>❯ ●</> <dim>1. </><accent>**worker**</>   <dim>routing…</><muted> · </><muted>queued</>",
    "  <dim>○</> <dim>2. </><muted>worker</>   <dim>routing…</><muted> · </><muted>queued</>",
  ]);
});

test("in the picker a narrow terminal shortens the name first, then cuts the row's details from the end, never past the width", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const worker = board.add({ callId: "call", background: false, task: "Weighing Entra state-parameter guidance", agent: "orchestrator:verifying-work", model: { kind: "routed" } });
  worker.started();
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  worker.session(fakeSession("worker-1", listeners));
  for (const listener of listeners) listener(usage(133_000));
  time.advance(488_000);
  const screen = fakeUI();
  void pickWorker(screen.ui, board, { now: time.now });

  const row = (width: number) => screen.lines(width)[4];
  assert.equal(row(100), "❯ ● 1. orchestrator:verifying-work   routing… · 8m08s · running", "a row that fits keeps its whole name");
  assert.equal(row(50), "❯ ● 1. orchestrator:…   routing… · 8m08s · running", "the name takes the room the details leave");
  assert.equal(screen.lines(50)[4]!.length, 50);
  assert.equal(row(30), "❯ ● 1. or…   routing… · 8m08s", "a short name, then the details cut from the end");
  assert.equal(row(12), "❯ ● 1. or…", "only the name when no details fit");
  for (const width of [100, 72, 60, 50, 40, 30, 20, 12, 8, 4, 1]) {
    for (const line of screen.lines(width)) assert.ok(line.length <= width, `${width}: ${line}`);
  }
});

test("a long list scrolls to keep the selected worker in view", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 12; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  const screen = fakeUI();
  const picked = pickWorker(screen.ui, board, { now: time.now });

  const rows = () => screen.lines().slice(4, -1);
  assert.equal(rows().length, 10);
  assert.equal(rows()[0], "❯ ●  1. worker   routing… · queued");
  assert.equal(screen.lines()[2], `${HINT} · 1–10 of 12`);
  screen.press(...Array.from({ length: 11 }, () => KEY.down));
  assert.equal(rows()[0], "  ○  3. worker   routing… · queued");
  assert.equal(rows()[9], "❯ ● 12. worker   routing… · queued");
  assert.equal(screen.lines()[2], `${HINT} · 3–12 of 12`);
  screen.press(KEY.enter);
  assert.equal(await picked, board.workers()[11]!.id);
});

test("a worker is found by its list number or delegation id, a resumed delegation by its latest run, and anything else is refused", () => {
  const { board } = session();
  board.add({ callId: "call-4", background: false, task: "Carry on", delegationId: "lead-1", model: { kind: "routed" } });
  const workers = board.workers();
  const resumed = workers.find((worker) => worker.task === "Carry on")!;

  assert.deepEqual(findWorker(board, "2"), { workerId: workers[1]!.id });
  assert.deepEqual(findWorker(board, "lead-1"), { workerId: resumed.id }, "the latest run of the delegation");
  assert.deepEqual(findWorker(board, "bg-1"), { workerId: workers.find((worker) => worker.delegationId === "bg-1")!.id });
  assert.deepEqual(findWorker(board, "5"), { refusal: "No worker has the list number 5: this session has 4 workers. /subagents lists them." });
  assert.deepEqual(findWorker(board, "0"), { refusal: "No worker has the list number 0: this session has 4 workers. /subagents lists them." });
  assert.deepEqual(findWorker(board, "call-1"), { refusal: "No worker of this session has the delegation id call-1. /subagents lists every worker." });
  assert.deepEqual(findWorker(new WorkerBoard(), "1"), { refusal: "No worker has the list number 1: this session has no workers yet." });
});
