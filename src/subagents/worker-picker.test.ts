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

function fakeSession(sessionId: string): WorkerSession {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  return { sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, effort: "medium", messages: () => [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}

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

test("the picker lists every worker of the session, finished ones included, numbered in board order with nested workers indented; Enter picks one and Esc none", async () => {
  const { time, board } = session();
  const [lead, nested] = board.workers();
  const screen = fakeUI();

  const picked = pickWorker(screen.ui, board, { now: time.now });
  assert.deepEqual(screen.options, [undefined], "in the editor's place, as pi's own selector");
  const rule = "─".repeat(WIDTH);
  assert.deepEqual(screen.lines(), [
    rule,
    "Workers of this session",
    "› 1. lead · routing… · failed · 0s · 0 turns · the provider…",
    "  2. └ tester · routing… · completed · 0s · 0 turns · Check…",
    "  3. worker · routing… · queued · Fix the typo",
    "↑↓ select · Enter open · Esc cancel",
    rule,
  ]);
  screen.press(KEY.down);
  assert.equal(screen.lines()[3], "› 2. └ tester · routing… · completed · 0s · 0 turns · Check…");
  const renders = screen.renders;
  board.add({ callId: "call-3", background: false, task: "Arrives while picking", model: { kind: "routed" } });
  assert.ok(screen.renders > renders, "a board change redraws the picker");
  assert.equal(screen.lines()[5], "  4. worker · routing… · queued · Arrives while picking");
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
  ].join("\n"), "the same list as text, where there is no UI to pick in");
  assert.ok(lead);
});

test("a long list scrolls to keep the selected worker in view", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 12; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  const screen = fakeUI();
  const picked = pickWorker(screen.ui, board, { now: time.now });

  const rows = () => screen.lines().slice(2, -2);
  assert.equal(rows().length, 10);
  assert.equal(rows()[0], "›  1. worker · routing… · queued · Item 1");
  assert.equal(screen.lines().at(-2), "↑↓ select · Enter open · Esc cancel · 1–10 of 12");
  screen.press(...Array.from({ length: 11 }, () => KEY.down));
  assert.equal(rows()[0], "   3. worker · routing… · queued · Item 3");
  assert.equal(rows()[9], "› 12. worker · routing… · queued · Item 12");
  assert.equal(screen.lines().at(-2), "↑↓ select · Enter open · Esc cancel · 3–12 of 12");
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
