import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { WorkerBoard, type WorkerSession } from "./worker-board.ts";
// pi's own keybindings manager, the one it hands a ctx.ui.custom factory; its public entry exports only the type.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { startWorkerWidget, widgetLines, widgetRows, WORKER_WIDGET, type WorkerWidgetFocusUI, type WorkerWidgetUI } from "./worker-widget.ts";

// The worker widget above the editor. Its rows come from a real worker board,
// fed as the subagents extension feeds it; the workers' sessions are fakes
// that emit pi's session events, and the clock is a counter. A plain theme
// leaves the text uncoloured, so each line reads as the user sees it.

const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const WIDE = 200;

function clock(start = 1_000_000) {
  let now = start;
  return { now: () => now, advance: (ms: number) => { now += ms; } };
}

function fakeSession(sessionId: string) {
  const listeners = new Set<(event: AgentSessionEvent) => void>();
  const session: WorkerSession = {
    sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, effort: "medium", messages: () => [],
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { session, emit: (event: object) => { for (const listener of listeners) listener(event as AgentSessionEvent); } };
}

const reply = (text: string) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] } });

/** The widget's lines for `board` at the clock's time. */
function lines(board: WorkerBoard, now: number, width = WIDE): string[] {
  return widgetLines(widgetRows(board.workers(), now), now, PLAIN, width);
}

test("each worker's line shows its agent, model and effort, worker state, elapsed time, turns and current tool or latest text, nested workers indented under their parent", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const lead = board.add({ callId: "call-1", background: false, task: "Lead the refactor", agent: "lead", model: { kind: "routed" } });
  const fork = board.add({ callId: "call-1", background: false, task: "Review in context", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });
  const preserved = board.add({ callId: "call-2", background: true, task: "Scout the config", agent: "scout", delegationId: "bg-1",
    model: { kind: "preserved", model: "openai/gpt-5", effort: "low" } });
  const queued = board.add({ callId: "call-2", background: true, task: "Fix the typo\nin README.md", delegationId: "bg-2", model: { kind: "routed" } });

  lead.started();
  const leadSession = fakeSession("lead-1");
  lead.session(leadSession.session);
  board.served({ delegationId: "lead-1", model: "anthropic/claude-sonnet-4-5", effort: "high", escalation: { from: "standard", to: "elevated" } });
  leadSession.emit({ type: "turn_start" });
  leadSession.emit({ type: "turn_start" });
  leadSession.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "subagents" });
  const nested = board.add({ callId: "nested-call", background: false, task: "Check the tests", agent: "tester", parentDelegationId: "lead-1", model: { kind: "routed" } });
  nested.started();
  nested.session(fakeSession("nested-1").session);
  fork.started();
  const forkSession = fakeSession("fork-1");
  fork.session(forkSession.session);
  forkSession.emit({ type: "turn_start" });
  forkSession.emit(reply("Reading the diff.\n\nThe change looks   right so far."));
  preserved.started();
  preserved.session(fakeSession("bg-1").session);
  board.asking("bg-1", true);
  time.advance(75_000);

  assert.deepEqual(lines(board, time.now()), [
    "lead · anthropic/claude-sonnet-4-5:high ↑elevated · running · 1m15s · 2 turns · subagents",
    "└ tester · routing… · running · 1m15s · 0 turns · Check the tests",
    "worker (fork) · anthropic/claude-opus-4-5:high · running · 1m15s · 1 turn · The change looks right so far.",
    "scout · openai/gpt-5:low · asking · 1m15s · 0 turns · Scout the config",
    "worker · routing… · queued · Fix the typo",
  ]);
  const rows = widgetRows(board.workers(), time.now()).rows;
  assert.deepEqual(rows.map((row) => [row.worker.id, row.depth]), [[lead.id, 0], [nested.id, 1], [fork.id, 0], [preserved.id, 0], [queued.id, 0]],
    "each row knows its worker, so a later selection can open it");
});

test("the widget shows at most 6 worker lines, then \"+N more\" for the rest", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 8; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });

  assert.deepEqual(lines(board, time.now()), [
    "worker · routing… · queued · Item 1",
    "worker · routing… · queued · Item 2",
    "worker · routing… · queued · Item 3",
    "worker · routing… · queued · Item 4",
    "worker · routing… · queued · Item 5",
    "worker · routing… · queued · Item 6",
    "+2 more",
  ]);
  assert.equal(widgetRows(board.workers(), time.now()).more, 2);

  const six = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 6; item++) six.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  assert.equal(lines(six, time.now()).length, 6, "exactly 6 workers need no \"+N more\" line");
});

test("a line longer than the render width is cut with an ellipsis", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  board.add({ callId: "call", background: false, task: "Find every place the config loader reads the environment", agent: "scout", model: { kind: "routed" } });

  assert.deepEqual(lines(board, time.now(), 40), ["scout · routing… · queued · Find every…"]);
  assert.deepEqual(lines(board, time.now(), 12), ["scout · rou…"]);
  for (const line of lines(board, time.now(), 40)) assert.ok(line.length <= 40);
});

type WidgetFactory = Extract<Parameters<WorkerWidgetUI["setWidget"]>[1], (...args: never[]) => unknown>;

/** The component pi mounts as an overlay for ctx.ui.custom. */
interface FocusOverlay {
  render(width: number): string[];
  handleInput(data: string): void;
  dispose?(): void;
}

/** pi's widget slots as the controller uses them, ctx.ui.custom as pi mounts
 *  an overlay (pi's own keybindings manager, and a done that hides it), and a
 *  timer the test fires by hand. */
function fakeUI() {
  let factory: WidgetFactory | undefined;
  let component: ReturnType<WidgetFactory> | undefined;
  let renders = 0;
  const placements: (string | undefined)[] = [];
  const tui = { requestRender: () => { renders++; } };
  let overlay: FocusOverlay | undefined;
  const customOptions: unknown[] = [];
  const ui: WorkerWidgetUI & WorkerWidgetFocusUI = {
    setWidget(key: string, content: unknown, options?: { placement?: string }) {
      assert.equal(key, WORKER_WIDGET);
      component?.dispose?.();
      factory = content as WidgetFactory | undefined;
      component = factory?.(tui as never, PLAIN);
      placements.push(options?.placement);
    },
    custom: ((factory: (...args: unknown[]) => FocusOverlay, options: unknown) => {
      customOptions.push(options);
      return new Promise((resolve) => {
        const mounted = factory(tui, PLAIN, new KeybindingsManager(), (result: unknown) => {
          // pi hides the overlay, gives focus back to the editor, then disposes the component.
          if (overlay === mounted) overlay = undefined;
          mounted.dispose?.();
          resolve(result as never);
        });
        overlay = mounted;
      });
    }) as WorkerWidgetFocusUI["custom"],
  } as WorkerWidgetUI & WorkerWidgetFocusUI;
  const timers = new Set<() => void>();
  const timer = {
    setInterval: (tick: () => void) => { timers.add(tick); return tick; },
    clearInterval: (handle: unknown) => { timers.delete(handle as () => void); },
  };
  return {
    ui, timer, placements, customOptions,
    /** Whether the focus overlay holds the keyboard. */
    get focused() { return overlay !== undefined; },
    /** Keys as the terminal sends them, to whatever holds the keyboard. */
    press(...keys: string[]) { for (const key of keys) overlay?.handleInput(key); },
    overlayLines: (width = WIDE) => overlay?.render(width),
    /** The widget's lines at `width`, or `undefined` when it is hidden. */
    shown: (width = WIDE) => component?.render(width).map((line) => line.trimEnd()),
    tick: () => { for (const tick of [...timers]) tick(); },
    get timers() { return timers.size; },
    get renders() { return renders; },
  };
}

test("a finished worker stays about 10 s with its end state, then drops out, and the widget disappears when no worker runs", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const screen = fakeUI();
  const widget = startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });
  assert.equal(screen.shown(), undefined, "an empty board shows no widget");
  assert.equal(screen.timers, 0, "and runs no timer");

  const first = board.add({ callId: "call", background: false, task: "First", model: { kind: "routed" } });
  const second = board.add({ callId: "call", background: false, task: "Second", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });
  assert.deepEqual(screen.shown(), ["worker · routing… · queued · First", "worker (fork) · anthropic/claude-opus-4-5:high · queued · Second"]);
  assert.equal(screen.placements.at(-1), "aboveEditor");
  first.started();
  second.started();
  time.advance(3_000);
  screen.tick();
  assert.deepEqual(screen.shown(), ["worker · routing… · running · 3s · 0 turns · First", "worker (fork) · anthropic/claude-opus-4-5:high · running · 3s · 0 turns · Second"],
    "the timer keeps the elapsed time current");

  first.ended({ state: "failed", error: "the provider refused the request" });
  time.advance(9_000);
  screen.tick();
  assert.deepEqual(screen.shown(), ["worker · routing… · failed · 3s · 0 turns · the provider refused the request",
    "worker (fork) · anthropic/claude-opus-4-5:high · running · 12s · 0 turns · Second"]);
  time.advance(1_000);
  screen.tick();
  assert.deepEqual(screen.shown(), ["worker (fork) · anthropic/claude-opus-4-5:high · running · 13s · 0 turns · Second"], "10 s after its end it drops out");

  second.ended({ state: "completed" });
  time.advance(5_000);
  screen.tick();
  assert.deepEqual(screen.shown(), ["worker (fork) · anthropic/claude-opus-4-5:high · completed · 13s · 0 turns · Second"]);
  time.advance(5_000);
  screen.tick();
  assert.equal(screen.shown(), undefined, "with no worker left the widget disappears");
  assert.equal(screen.timers, 0, "and its timer stops");

  board.add({ callId: "call-2", background: true, task: "Third", delegationId: "bg-3", model: { kind: "routed" } });
  assert.deepEqual(screen.shown(), ["worker · routing… · queued · Third"], "a new worker brings it back");
  widget.stop();
  assert.equal(screen.shown(), undefined, "stopping removes the widget");
  assert.equal(screen.timers, 0);
  board.add({ callId: "call-3", background: true, task: "Fourth", delegationId: "bg-4", model: { kind: "routed" } });
  assert.equal(screen.shown(), undefined, "and it no longer follows the board");
});

test("a board change re-renders the shown widget at once, and a new orchestrator session empties it", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  board.startSession("session-1");
  const screen = fakeUI();
  board.add({ callId: "call", background: true, task: "Already running", delegationId: "bg-1", model: { kind: "routed" } }).started();
  startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });
  assert.deepEqual(screen.shown(), ["worker · routing… · running · 0s · 0 turns · Already running"], "workers already on the board show when it starts");

  const renders = screen.renders;
  board.served({ delegationId: "bg-1", model: "anthropic/claude-haiku-4-5", effort: "low" });
  assert.ok(screen.renders > renders, "the board's change signal asks pi to render");
  assert.deepEqual(screen.shown(), ["worker · anthropic/claude-haiku-4-5:low · running · 0s · 0 turns · Already running"]);

  board.startSession("session-2");
  assert.equal(screen.shown(), undefined);
});

// alt+a's focus (xytd): the widget takes the keyboard through an overlay that
// draws nothing, so pi gives the keyboard back to the editor, text untouched,
// when it closes. Keys arrive as the terminal sends them and are matched
// through pi's keybindings manager: Esc as a kitty sequence too, so the focus
// cannot trap the user.

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", kittyEscape: "\x1b[27u", ctrlC: "\x03" };
const HINT = "↑↓ select · Enter open · Esc back";

test("the focused widget marks the selected worker, arrows move over its rows but not \"+N more\", Enter chooses the worker and Esc or ctrl+c leaves", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 7; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  const ids = board.workers().map((worker) => worker.id);
  const screen = fakeUI();
  const widget = startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });

  const chosen = widget.focus(screen.ui);
  assert.ok(screen.focused, "the widget holds the keyboard");
  assert.deepEqual(screen.customOptions, [{ overlay: true, overlayOptions: { width: 1, maxHeight: 1, anchor: "bottom-left", margin: 0 } }]);
  assert.deepEqual(screen.overlayLines(), [], "the overlay itself draws nothing");
  assert.deepEqual(screen.shown(), [
    "› worker · routing… · queued · Item 1",
    "  worker · routing… · queued · Item 2",
    "  worker · routing… · queued · Item 3",
    "  worker · routing… · queued · Item 4",
    "  worker · routing… · queued · Item 5",
    "  worker · routing… · queued · Item 6",
    "  +1 more",
    HINT,
  ]);
  screen.press(KEY.up);
  assert.equal(screen.shown()![0], "› worker · routing… · queued · Item 1", "up stops at the first row");
  screen.press(KEY.down, KEY.down);
  assert.equal(screen.shown()![2], "› worker · routing… · queued · Item 3");
  screen.press(...Array.from({ length: 9 }, () => KEY.down));
  assert.equal(screen.shown()![5], "› worker · routing… · queued · Item 6", "down stops at the last row, not on \"+N more\"");
  screen.press("q", "x");
  assert.ok(screen.focused, "other keys do nothing");
  screen.press(KEY.enter);
  assert.deepEqual(await chosen, { workerId: ids[5] });
  assert.equal(screen.focused, false, "Enter gives the keyboard back");
  assert.equal(screen.shown()![0], "worker · routing… · queued · Item 1", "and the mark goes");

  for (const leave of [KEY.escape, KEY.kittyEscape, KEY.ctrlC]) {
    const left = widget.focus(screen.ui);
    screen.press(KEY.down, leave);
    assert.deepEqual(await left, { reason: "left" }, JSON.stringify(leave));
    assert.equal(screen.focused, false);
    assert.equal(screen.shown()!.length, 7, "the widget is as it was");
  }
});

test("focus on a hidden widget is refused; a selected worker that drops out passes the mark to the row in its place, and an emptied widget gives the keyboard back", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const screen = fakeUI();
  const widget = startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });
  assert.deepEqual(await widget.focus(screen.ui), { reason: "empty" });
  assert.deepEqual(screen.customOptions, [], "no overlay opens");

  const first = board.add({ callId: "call", background: false, task: "First", model: { kind: "routed" } });
  board.add({ callId: "call", background: false, task: "Second", model: { kind: "routed" } });
  first.started();
  const left = widget.focus(screen.ui);
  first.ended({ state: "completed" });
  assert.equal(screen.shown()![0], "› worker · routing… · completed · 0s · 0 turns · First", "a finished worker lingers, still selected");
  time.advance(10_000);
  screen.tick();
  assert.deepEqual(screen.shown(), ["› worker · routing… · queued · Second", HINT], "the row in its place takes the mark");

  board.startSession("another-session");
  assert.equal(screen.shown(), undefined);
  assert.deepEqual(await left, { reason: "left" });
  assert.equal(screen.focused, false);

  board.add({ callId: "call-2", background: false, task: "Third", model: { kind: "routed" } });
  const stopped = widget.focus(screen.ui);
  widget.stop();
  assert.deepEqual(await stopped, { reason: "left" }, "stopping the widget gives the keyboard back");
  assert.equal(screen.focused, false);
});
