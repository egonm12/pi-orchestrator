import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionEvent, Theme } from "@earendil-works/pi-coding-agent";
import { WorkerBoard, type WorkerSession } from "./worker-board.ts";
// pi's own keybindings manager, the one it hands a ctx.ui.custom factory; its public entry exports only the type.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
import { compactLines, startWorkerWidget, widgetLines, widgetRows, WORKER_WIDGET, type WorkerWidgetFocusUI, type WorkerWidgetUI } from "./worker-widget.ts";

// The worker widget below the editor, drawn as Claude Code's agent list, and
// the compact worker lines of the /subagents listing, where there is no UI
// to pick in. Its rows come from a real worker board, fed as the subagents
// extension feeds it; the workers' sessions are fakes that emit pi's session
// events, and the clock is a counter. A plain theme leaves the text
// uncoloured, so each line reads as the user sees it.

const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
/** Tags each coloured piece with its colour and bold text with `**`, to check the styling. */
const TAGGED = { fg: (color: string, text: string) => text === "" ? "" : `<${color}>${text}</>`, bold: (text: string) => `**${text}**` } as unknown as Theme;
const WIDE = 200;
/** The width the widget's screen tests read it at: its stats sit against the right edge. */
const SCREEN = 72;
/** The widget's first lines while the editor has the keyboard: the hint and a blank line. */
const HINT_LINES = ["  ↑/↓ to select", ""];
/** The same while the widget has it. */
const FOCUS_HINT_LINES = ["  ↑/↓ to select · Enter to open · Esc to go back", ""];

/** The index of the first worker row, below the hint, its blank line and main. */
const FIRST_ROW = HINT_LINES.length + 1;

/** The widget's lines while the editor has the keyboard: the hint, main selected, then `rows`. */
function unfocused(...rows: string[]): string[] {
  return [...HINT_LINES, "❯ ● main", ...rows];
}

/** A row whose `stats` end at the right edge of a `width` columns wide widget. */
function right(left: string, stats: string, width = SCREEN): string {
  return `${left.padEnd(width - stats.length)}${stats}`;
}

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

const reply = (text: string) => ({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] },
  assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });

/** A reply's usage, as pi reports it at message_end: `total` tokens, all input. */
const usage = (total: number) => ({ type: "message_end", message: { role: "assistant", content: [], timestamp: 0,
  usage: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: total, cost: { total: 0 } } } });

/** The compact worker lines for `board` at the clock's time. */
function compact(board: WorkerBoard, now: number, width = WIDE): string[] {
  return compactLines(widgetRows(board.workers(), now), now, PLAIN, width);
}

/** The widget's lines for `board` at the clock's time, `selected` the focused widget's selected row. */
function lines(board: WorkerBoard, now: number, width = WIDE, selected?: number, theme = PLAIN): string[] {
  return widgetLines(widgetRows(board.workers(), now), selected, now, theme, width);
}

test("labelled routed workers show label, tier, rung, state, elapsed, turns and activity in widget and status", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const feed = board.add({ callId: "call", background: false, task: "Check budget", agent: "scout", label: "research: budget code", model: { kind: "routed" } });
  feed.started();
  feed.session(fakeSession("budget-1").session);
  board.setTier("budget-1", "standard");
  board.served({ delegationId: "budget-1", model: "anthropic/sonnet", effort: "high" });
  time.advance(2_000);
  assert.deepEqual(compact(board, time.now()), ["research: budget code · standard · anthropic/sonnet:high · running · 2s · 0 turns · Check budget"]);
  assert.match(lines(board, time.now(), 200)[3]!, /research: budget co…\s+standard · anthropic\/sonnet:high · running · 2s · 0 turns · Check budget/);
});

test("each compact worker line, the /subagents listing's, shows its agent, model and effort, worker state, elapsed time, turns and activity, nested workers indented under their parent", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const lead = board.add({ callId: "call-1", background: false, task: "Lead the refactor", agent: "lead", model: { kind: "routed" } });
  const fork = board.add({ callId: "call-1", background: false, task: "Review in context", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });
  const preserved = board.add({ callId: "call-2", background: true, task: "Scout the config", agent: "scout", delegationId: "bg-1",
    model: { kind: "preserved", model: "openai/gpt-5", effort: "low" } });
  const queued = board.add({ callId: "call-2", background: true, task: "Fix the typo\nin README.md", delegationId: "bg-2", model: { kind: "routed" } });
  const fails = board.add({ callId: "call-3", background: false, task: "Try the build", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });

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
  fails.started();
  const failsSession = fakeSession("fails-1");
  fails.session(failsSession.session);
  failsSession.emit({ type: "turn_start" });
  time.advance(75_000);
  fails.ended({ state: "failed", error: "The model call failed\nwith a 529" });

  assert.deepEqual(compact(board, time.now()), [
    "lead · anthropic/claude-sonnet-4-5:high ↑elevated · running · 1m15s · 2 turns · subagents",
    "└ tester · routing… · running · 1m15s · 0 turns · Check the tests",
    "worker (fork) · anthropic/claude-opus-4-5:high · running · 1m15s · 1 turn · writing…",
    "scout · openai/gpt-5:low · asking · 1m15s · 0 turns · Scout the config",
    "worker · routing… · queued · Fix the typo",
    "worker (fork) · anthropic/claude-opus-4-5:high · failed · 1m15s · 1 turn · The model call failed",
  ]);
  const rows = widgetRows(board.workers(), time.now()).rows;
  assert.deepEqual(rows.map((row) => [row.worker.id, row.depth]), [[lead.id, 0], [nested.id, 1], [fork.id, 0], [preserved.id, 0], [queued.id, 0], [fails.id, 0]],
    "each row knows its worker, so a later selection can open it");
});

test("reviewers ignore their labels and long labels stay on one line", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  board.add({ callId: "call", background: false, task: "Review", agent: "scout", label: "misleading label", review: "original", model: { kind: "routed" } });
  board.add({ callId: "call", background: false, task: "Research", label: "a long description that should not wrap\nonto another line", model: { kind: "routed" } });
  board.add({ callId: "call", background: false, task: "Unlabelled", agent: "scout", model: { kind: "routed" } });
  board.add({ callId: "call", background: false, task: "No definition", model: { kind: "routed" } });
  assert.deepEqual(compact(board, time.now()).map((line) => line.split(" · ")[0]), ["reviewer", "a long description that should not wrap", "scout", "worker"]);
  const widget = lines(board, time.now(), 100);
  assert.equal(widget.length, 7, "one line per worker");
  assert.match(widget[4]!, /a long description…/);
  assert.ok(widget.every((line) => !line.includes("onto another line")));
});

test("a compact worker line longer than the render width is cut with an ellipsis", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  board.add({ callId: "call", background: false, task: "Find every place the config loader reads the environment", agent: "scout", model: { kind: "routed" } });

  assert.deepEqual(compact(board, time.now(), 40), ["scout · routing… · queued · Find every…"]);
  assert.deepEqual(compact(board, time.now(), 12), ["scout · rou…"]);
  for (const line of compact(board, time.now(), 40)) assert.ok(line.length <= 40);
});

test("the widget is Claude Code's agent list: a hint, main first and selected, then each worker's name, its activity or last status, and its elapsed time and tokens against the right edge", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const lead = board.add({ callId: "call-1", background: false, task: "Lead the refactor", agent: "lead", model: { kind: "routed" } });
  const fork = board.add({ callId: "call-1", background: false, task: "Review in context", model: { kind: "fork", model: "anthropic/claude-opus-4-5", effort: "high" } });
  const scout = board.add({ callId: "call-2", background: true, task: "Scout the config", agent: "scout", delegationId: "bg-1", model: { kind: "routed" } });
  board.add({ callId: "call-2", background: true, task: "Fix the typo\nin README.md", delegationId: "bg-2", model: { kind: "routed" } });
  const fails = board.add({ callId: "call-3", background: false, task: "Try the build", model: { kind: "routed" } });

  lead.started();
  const leadSession = fakeSession("lead-1");
  lead.session(leadSession.session);
  leadSession.emit({ type: "turn_start" });
  leadSession.emit(usage(133_000));
  leadSession.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "subagents" });
  const nested = board.add({ callId: "nested-call", background: false, task: "Check the tests", agent: "tester", parentDelegationId: "lead-1", model: { kind: "routed" } });
  nested.started();
  nested.session(fakeSession("nested-1").session);
  fork.started();
  const forkSession = fakeSession("fork-1");
  fork.session(forkSession.session);
  forkSession.emit({ type: "turn_start" });
  forkSession.emit(reply("Reading the diff."));
  forkSession.emit(usage(1));
  scout.started();
  scout.session(fakeSession("bg-1").session);
  board.asking("bg-1", true);
  fails.started();
  fails.session(fakeSession("fails-1").session);
  time.advance(488_000);
  fails.ended({ state: "failed", error: "The model call failed\nwith a 529" });

  const shown = lines(board, time.now(), 100);
  assert.deepEqual(shown, [
    ...HINT_LINES,
    "❯ ● main",
    "  ○ lead                   subagents                                           8m08s · ↓ 133k tokens",
    "  ○ └ tester               Check the tests                                                     8m08s",
    "  ○ worker (fork)          writing…                                                8m08s · ↓ 1 token",
    "  ○ scout                  asking · Scout the config                                           8m08s",
    "  ○ worker                 queued · Fix the typo",
    "  ○ worker                 failed · The model call failed                                      8m08s",
  ]);
  for (const line of shown.filter((line) => / (8m08s|tokens?)$/.test(line))) {
    assert.equal(line.length, 100, `the stats end at the right edge: ${line}`);
  }
  for (const line of shown.slice(3)) assert.match(line, /^.{24} {3}\S/, `every worker's status starts in column 27, after the name column: ${line}`);
});

test("the selected row has the ❯ cursor, a filled dot and its name in bold accent; every other row two spaces, a hollow dot and a muted name", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 2; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });

  assert.deepEqual(lines(board, time.now(), WIDE, undefined, TAGGED), [
    "  <dim>↑/↓ to select</>",
    "",
    "<accent>❯ ●</> <accent>**main**</>",
    "  <dim>○</> <muted>worker</>                 <muted>queued</><muted> · </><dim>Item 1</>",
    "  <dim>○</> <muted>worker</>                 <muted>queued</><muted> · </><dim>Item 2</>",
  ], "while the editor has the keyboard, main is selected");
  assert.deepEqual(lines(board, time.now(), WIDE, 1, TAGGED), [
    "  <dim>↑/↓ to select · Enter to open · Esc to go back</>",
    "",
    "  <dim>○</> <muted>main</>",
    "  <dim>○</> <muted>worker</>                 <muted>queued</><muted> · </><dim>Item 1</>",
    "<accent>❯ ●</> <accent>**worker**</>                 <muted>queued</><muted> · </><dim>Item 2</>",
  ], "in the focused widget the selected worker has the cursor and the filled dot, and main a hollow one");
});

test("the widget shows at most 6 worker rows below main, then \"+N more\" for the rest", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 8; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });

  assert.deepEqual(lines(board, time.now()), [
    ...HINT_LINES,
    "❯ ● main",
    "  ○ worker                 queued · Item 1",
    "  ○ worker                 queued · Item 2",
    "  ○ worker                 queued · Item 3",
    "  ○ worker                 queued · Item 4",
    "  ○ worker                 queued · Item 5",
    "  ○ worker                 queued · Item 6",
    "    +2 more",
  ]);
  assert.equal(widgetRows(board.workers(), time.now()).more, 2);

  const six = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 6; item++) six.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  assert.equal(lines(six, time.now()).length, 2 + 1 + 6, "exactly 6 workers need no \"+N more\" line");
});

test("a narrow terminal cuts a worker's status first so its stats still fit against the right edge, then keeps only the elapsed time, then no stats; a long name is cut to the name column", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const worker = board.add({ callId: "call", background: false, task: "Weighing Entra state-parameter guidance", agent: "orchestrator:verifying-work", model: { kind: "routed" } });
  worker.started();
  const session = fakeSession("worker-1");
  worker.session(session.session);
  session.emit(usage(133_000));
  time.advance(488_000);

  const rows = (width: number) => lines(board, time.now(), width).slice(HINT_LINES.length);
  assert.deepEqual(rows(100), ["❯ ● main", "  ○ orchestrator:verify…   Weighing Entra state-parameter guidance             8m08s · ↓ 133k tokens"]);
  assert.deepEqual(rows(50), ["❯ ● main", "  ○ orchestrator…   Weighi…  8m08s · ↓ 133k tokens"], "a third of the row for the name, the status cut to the room the stats leave");
  assert.deepEqual(rows(30), ["❯ ● main", "  ○ orches…   Weighing…  8m08s"], "the elapsed time alone when the tokens do not fit");
  assert.deepEqual(rows(12), ["❯ ● main", "  ○ orche…"], "only the name when no stats fit");
  for (const width of [100, 72, 50, 40, 30, 20, 12, 8, 4, 1]) {
    for (const line of lines(board, time.now(), width)) assert.ok(line.length <= width, `${width}: ${line}`);
  }
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
  let overlay: FocusOverlay | undefined;
  /** pi's editor as the widget reads it: its lines, cursor and history
   *  browsing, pi's keybindings, and the keys that reach it. */
  const editor = {
    keybindings: new KeybindingsManager(), lines: ["draft text"], cursor: { line: 0, col: 10 }, historyIndex: -1,
    autocompleteState: null as unknown, received: [] as string[],
    getLines() { return this.lines; }, getCursor() { return this.cursor; },
    handleInput(data: string) { this.received.push(data); },
  };
  const tui = { requestRender: () => { renders++; }, getFocusedComponent: () => overlay ?? editor };
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
    ui, timer, placements, customOptions, editor,
    /** Whether the focus overlay holds the keyboard. */
    get focused() { return overlay !== undefined; },
    /** Keys as the terminal sends them, to whatever holds the keyboard. */
    press(...keys: string[]) { for (const key of keys) overlay?.handleInput(key); },
    overlayLines: (width = WIDE) => overlay?.render(width),
    /** The widget's lines at `width`, or `undefined` when it is hidden. */
    shown: (width = SCREEN) => component?.render(width).map((line) => line.trimEnd()),
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
  assert.deepEqual(screen.shown(), unfocused("  ○ worker                 queued · First", "  ○ worker (fork)          queued · Second"));
  assert.equal(screen.placements.at(-1), "belowEditor");
  first.started();
  second.started();
  time.advance(3_000);
  screen.tick();
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker                 First", "3s"), right("  ○ worker (fork)          Second", "3s")),
    "the timer keeps the elapsed time current");

  first.ended({ state: "failed", error: "the provider refused the request" });
  time.advance(9_000);
  screen.tick();
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker                 failed · the provider refused the request", "3s"),
    right("  ○ worker (fork)          Second", "12s")));
  time.advance(1_000);
  screen.tick();
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker (fork)          Second", "13s")), "10 s after its end it drops out");

  second.ended({ state: "completed" });
  time.advance(5_000);
  screen.tick();
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker (fork)          completed · Second", "13s")));
  time.advance(5_000);
  screen.tick();
  assert.equal(screen.shown(), undefined, "with no worker left the widget disappears");
  assert.equal(screen.timers, 0, "and its timer stops");

  board.add({ callId: "call-2", background: true, task: "Third", delegationId: "bg-3", model: { kind: "routed" } });
  assert.deepEqual(screen.shown(), unfocused("  ○ worker                 queued · Third"), "a new worker brings it back");
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
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker                 Already running", "0s")), "workers already on the board show when it starts");

  const renders = screen.renders;
  board.asking("bg-1", true);
  assert.ok(screen.renders > renders, "the board's change signal asks pi to render");
  assert.deepEqual(screen.shown(), unfocused(right("  ○ worker                 asking · Already running", "0s")));

  board.startSession("session-2");
  assert.equal(screen.shown(), undefined);
});

// alt+a's focus (xytd): the widget takes the keyboard through an overlay that
// draws nothing, so pi gives the keyboard back to the editor, text untouched,
// when it closes. Keys arrive as the terminal sends them and are matched
// through pi's keybindings manager: Esc as a kitty sequence too, so the focus
// cannot trap the user.

const KEY = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b", kittyEscape: "\x1b[27u", ctrlC: "\x03" };

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
    ...FOCUS_HINT_LINES,
    "  ○ main",
    "❯ ● worker                 queued · Item 1",
    "  ○ worker                 queued · Item 2",
    "  ○ worker                 queued · Item 3",
    "  ○ worker                 queued · Item 4",
    "  ○ worker                 queued · Item 5",
    "  ○ worker                 queued · Item 6",
    "    +1 more",
  ], "the first worker is selected, main no longer");
  screen.press(KEY.down, KEY.down);
  assert.equal(screen.shown()![FIRST_ROW + 2], "❯ ● worker                 queued · Item 3");
  assert.equal(screen.shown()![FIRST_ROW], "  ○ worker                 queued · Item 1");
  screen.press(...Array.from({ length: 9 }, () => KEY.down));
  assert.equal(screen.shown()![FIRST_ROW + 5], "❯ ● worker                 queued · Item 6", "down stops at the last row, not on \"+N more\"");
  screen.press(KEY.enter);
  assert.deepEqual(await chosen, { workerId: ids[5] });
  assert.equal(screen.focused, false, "Enter gives the keyboard back");
  assert.deepEqual(screen.shown()!.slice(0, FIRST_ROW + 1), unfocused("  ○ worker                 queued · Item 1"), "and main is selected again");
  assert.ok(!screen.shown()!.slice(FIRST_ROW).some((line) => line.startsWith("❯")), "no worker keeps the cursor");

  for (const leave of [KEY.escape, KEY.kittyEscape, KEY.ctrlC]) {
    const left = widget.focus(screen.ui);
    screen.press(KEY.down, leave);
    assert.deepEqual(await left, { reason: "left" }, JSON.stringify(leave));
    assert.equal(screen.focused, false);
    assert.equal(screen.shown()!.length, FIRST_ROW + 7, "the widget is as it was");
  }
});

test("Down enters the widget only when it would do nothing in the editor: the cursor on its last line, no history browsing, a worker shown", () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const screen = fakeUI();
  const widget = startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });
  assert.equal(widget.downEnters(KEY.down), false, "no worker is shown");
  board.add({ callId: "call", background: false, task: "First", model: { kind: "routed" } });

  assert.equal(widget.downEnters(KEY.down), true, "at the end of the editor's only line");
  assert.equal(widget.downEnters("\x1b[1;1B"), true, "Down as the kitty keyboard protocol sends it");
  assert.equal(widget.downEnters("\x1b[1;1:3B"), false, "not its release: the press already went to the editor");
  assert.equal(widget.downEnters("\x1b[1;1:2B"), false, "nor a repeat");
  screen.editor.cursor = { line: 0, col: 3 };
  assert.equal(widget.downEnters(KEY.down), false, "Down moves the cursor to the end of the last line first");
  assert.equal(widget.downEnters(KEY.up), false, "only Down");
  assert.equal(widget.downEnters("j"), false);
  screen.editor.lines = ["first line", "second line"];
  assert.equal(widget.downEnters(KEY.down), false, "Down moves the cursor to the next line");
  screen.editor.cursor = { line: 1, col: 11 };
  assert.equal(widget.downEnters(KEY.down), true, "at the end of the last line");
  screen.editor.historyIndex = 2;
  assert.equal(widget.downEnters(KEY.down), false, "Down browses the history back");
  screen.editor.historyIndex = -1;
  screen.editor.autocompleteState = { kind: "regular" };
  assert.equal(widget.downEnters(KEY.down), false, "Down moves in the autocomplete list");
  screen.editor.autocompleteState = null;

  void widget.focus(screen.ui);
  assert.equal(widget.downEnters(KEY.down), false, "the focused widget takes Down itself");
  screen.press(KEY.escape);
});

test("in the focused widget ↑ on the first row or Esc returns to the editor untouched; any other key returns and goes into it; a chosen worker can be selected again", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  for (let item = 1; item <= 3; item++) board.add({ callId: "call", background: true, task: `Item ${item}`, delegationId: `bg-${item}`, model: { kind: "routed" } });
  const ids = board.workers().map((worker) => worker.id);
  const screen = fakeUI();
  const widget = startWorkerWidget(screen.ui, board, { now: time.now, ...screen.timer });

  let focus = widget.focus(screen.ui);
  screen.press(KEY.down, KEY.up, KEY.up);
  assert.deepEqual(await focus, { reason: "left" }, "↑ on the first row leaves");
  assert.deepEqual(screen.editor.received, [], "and the editor gets nothing");
  assert.equal(screen.shown()![FIRST_ROW - 1], "❯ ● main", "the cursor is back on main, whose editor has the keyboard");

  focus = widget.focus(screen.ui);
  screen.press("q");
  assert.deepEqual(await focus, { reason: "left" });
  assert.equal(screen.focused, false);
  assert.deepEqual(screen.editor.received, ["q"], "the key goes into the editor");

  focus = widget.focus(screen.ui, { select: ids[2] });
  assert.equal(screen.shown()![FIRST_ROW + 2], "❯ ● worker                 queued · Item 3", "back from a transcript, that worker is selected");
  screen.press(KEY.up, KEY.enter);
  assert.deepEqual(await focus, { workerId: ids[1] });
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
  assert.equal(screen.shown()![FIRST_ROW], right("❯ ● worker                 completed · First", "0s"), "a finished worker lingers, still selected");
  time.advance(10_000);
  screen.tick();
  assert.deepEqual(screen.shown(), [...FOCUS_HINT_LINES, "  ○ main", "❯ ● worker                 queued · Second"], "the row in its place takes the mark");

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
