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
const TAGGED = { fg: (color: string, text: string) => text === "" ? "" : `<${color}>${text}</>`, bold: (text: string) => `**${text}**` } as unknown as Theme;

test("the picker shows a labelled worker's tier and rung in one row", async () => {
  const { time, board } = session();
  const feed = board.add({ callId: "call-3", background: false, task: "Check budget", label: "budget code", model: { kind: "routed" } });
  feed.started();
  feed.session(fakeSession("budget-1"));
  board.setTier("budget-1", "elevated");
  board.served({ delegationId: "budget-1", model: "anthropic/sonnet", effort: "high" });
  const screen = fakeUI();
  const picked = pickWorker(screen.ui, board, { now: time.now });
  assert.match(screen.lines(140)[7]!, /budget code\s+elevated · anthropic\/sonnet:high · running · 0s · 0 turns · Check budget/);
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
    "❯ ● 1. lead            failed · the provider refused th…  0s",
    "  ○ 2. └ tester        completed · Check the tests        0s",
    "  ○ 3. worker          queued · Fix the typo",
    rule,
  ], "no main row: the orchestrator has no transcript to open");
  screen.press(KEY.down);
  assert.deepEqual(screen.lines().slice(4, 6), [
    "  ○ 1. lead            failed · the provider refused th…  0s",
    "❯ ● 2. └ tester        completed · Check the tests        0s",
  ], "the selected row has the cursor and the filled dot, every other one two spaces and a hollow dot");
  const renders = screen.renders;
  board.add({ callId: "call-3", background: false, task: "Arrives while picking", model: { kind: "routed" } });
  assert.ok(screen.renders > renders, "a board change redraws the picker");
  assert.equal(screen.lines()[7], "  ○ 4. worker          queued · Arrives while picking");
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
    "1. lead · routing… · failed · 0s · 0 turns · the provider refused the request",
    "2. └ tester · routing… · completed · 0s · 0 turns · Check the tests",
    "3. worker · routing… · queued · Fix the typo",
    "4. worker · routing… · queued · Arrives while picking",
  ].join("\n"), "the list as text, where there is no UI to pick in, keeps each worker's model and turns");
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
    "<accent>❯ ●</> <dim>1. </><accent>**worker**</>              <muted>queued</><muted> · </><dim>Item 1</>",
    "  <dim>○</> <dim>2. </><muted>worker</>              <muted>queued</><muted> · </><dim>Item 2</>",
  ]);
});

test("the picker's stats sit against the right edge, and a narrow terminal cuts the status first, then the tokens, then the elapsed time, never past the width", async () => {
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
  assert.equal(row(100), "❯ ● 1. orchestrator:ver…   Weighing Entra state-parameter guidance             8m08s · ↓ 133k tokens");
  assert.equal(screen.lines(100)[4]!.length, 100, "the stats end at the right edge");
  assert.equal(row(50), "❯ ● 1. orchestra…   Weighi…  8m08s · ↓ 133k tokens", "the status cut to the room the stats leave");
  assert.equal(row(30), "❯ ● 1. orc…   Weighing…  8m08s", "the elapsed time alone when the tokens do not fit");
  assert.equal(row(12), "❯ ● 1. or…", "only the name when no stats fit");
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
  assert.equal(rows()[0], "❯ ●  1. worker         queued · Item 1");
  assert.equal(screen.lines()[2], `${HINT} · 1–10 of 12`);
  screen.press(...Array.from({ length: 11 }, () => KEY.down));
  assert.equal(rows()[0], "  ○  3. worker         queued · Item 3");
  assert.equal(rows()[9], "❯ ● 12. worker         queued · Item 12");
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
