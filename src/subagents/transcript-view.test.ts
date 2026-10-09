import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, mock } from "node:test";
import { AssistantMessageComponent, createBashToolDefinition, getMarkdownTheme, initTheme, SessionManager, ToolExecutionComponent, UserMessageComponent, type AgentSessionEvent, type Theme, type ThemeBg } from "@earendil-works/pi-coding-agent";
// pi's own keybindings manager, the one it hands a ctx.ui.custom factory. pi's
// public entry exports only its type, so the test reaches into the package:
// matching the real binding ids is what keeps the view from trapping the user.
import { KeybindingsManager } from "../../node_modules/@earendil-works/pi-coding-agent/dist/core/keybindings.js";
// pi's global theme, the one its tool boxes are painted with: the view's theme
// below draws text plainly, but the tints of a tool box come from here.
import { theme as paintTheme } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { WorkerBoard, type BoardWorker, type WorkerFeed, type WorkerSession } from "./worker-board.ts";
import { LINGER_MS } from "./worker-widget.ts";
import { openTranscript, type TranscriptUI } from "./transcript-view.ts";
import { formatCost, formatTokens } from "./transcript-header.ts";
// pi's own renderer for each tuiMode (pi-tui's alt screen in fullscreen, its main screen in regular), built the way pi builds it.
import { createInteractiveTui } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js";
// pi's fullscreen layout: the chat in a ScrollView, and the editor, widgets and footer in a dock below it.
import { createChatViewport } from "../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { Container, type Component, type ScrollView, type Terminal, type TuiMainScreen, type ViewportTUI } from "@earendil-works/pi-tui";

// The transcript view as xytd's ways in will open it: openTranscript on a real
// worker board, through pi's own TUI (see fakeUI) and a ctx.ui.custom that
// mounts the view the way pi mounts a component that is not an overlay: in pi's
// editor container, with the focus. Worker sessions are fakes that hold
// messages and emit pi's session events. pi's message components draw with
// pi's global theme; the view's own lines use a plain theme, and the assertions
// read the lines without their escape codes, as the user sees them.

initTheme("dark");
const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text, bg: (color: ThemeBg, text: string) => paintTheme.bg(color, text) } as unknown as Theme;
const WIDTH = 100;

const KEY = {
  escape: "\x1b", kittyEscape: "\x1b[27u", ctrlC: "\x03", pageUp: "\x1b[5~", pageDown: "\x1b[6~", home: "\x1b[H", end: "\x1b[F",
  left: "\x1b[D", right: "\x1b[C", up: "\x1b[A", down: "\x1b[B", enter: "\r", ctrlO: "\x0f",
};

/** The bytes a terminal sends for the keys pi-tui's viewport binds. pi-tui 0.99 binds
 *  top and bottom to home and end; pi-tui 1.1, which pi runs, binds ctrl+home and
 *  ctrl+end, so a test asks pi's keybindings which key does what. */
const SEQUENCES: Readonly<Record<string, string>> = {
  home: "\x1b[H", end: "\x1b[F", "ctrl+home": "\x1b[1;5H", "ctrl+end": "\x1b[1;5F",
  pageUp: "\x1b[5~", pageDown: "\x1b[6~", "ctrl+up": "\x1b[1;5A", "ctrl+down": "\x1b[1;5B",
  "ctrl+shift+up": "\x1b[1;6A", "ctrl+shift+down": "\x1b[1;6B",
};

type KeybindingId = Parameters<KeybindingsManager["getKeys"]>[0];

/** The bytes for the first key pi's keybindings give `binding`. */
function keyFor(binding: KeybindingId): string {
  const [key] = new KeybindingsManager().getKeys(binding);
  const bytes = key === undefined ? undefined : SEQUENCES[key];
  assert.ok(bytes !== undefined, `the test has no bytes for ${binding}, which pi binds to ${key}`);
  return bytes;
}

/** The key pi's keybindings give the follow-the-end action, as the footer names it, and that key as a pattern. */
const FOLLOW_KEY = new KeybindingsManager().getKeys("tui.altScreen.bottom")[0];
const FOLLOW_PATTERN = (FOLLOW_KEY ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The ScrollView pi-tui scrolls and follows in fullscreen: the chat's, or the worker view's while it is shown. */
function primaryScroll(tui: unknown): ScrollView {
  return (tui as { getPrimaryScrollView(): ScrollView }).getPrimaryScrollView();
}

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

/** A terminal of a fixed size. It keeps what pi-tui writes to it, and `send` gives pi-tui's input callback the input the terminal reports. */
class CapturingTerminal implements Terminal {
  /** Everything pi-tui wrote, in order. */
  readonly written: string[] = [];
  columns: number;
  rows: number;
  private input: ((data: string) => void) | undefined;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
  }

  get kittyProtocolActive(): boolean { return false; }
  start(onInput?: (data: string) => void): void { this.input = onInput; }
  /** A key or a mouse report from the terminal, as pi-tui's input callback gets it. */
  send(data: string): void { this.input?.(data); }
  stop(): void {}
  async drainInput(): Promise<void> {}
  write(data: string): void { this.written.push(data); }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
  setProgramStatus(): void {}
}

/** The scrollbar pi-tui paints over a fullscreen transcript's last column for a second after a scroll. */
const SCROLLBAR_CELL = /[│┃█]$/u;

/** A component that draws one line, as pi's chat, editor, widgets and footer do. */
const textLine = (text: string): Component => ({ render: () => [text], invalidate() {} });

/** A container holding one component, as pi's containers hold their children. */
function containing(child: Component): Container {
  const container = new Container();
  container.addChild(child);
  return container;
}

/** pi's interactive UI in one tuiMode, mounted as pi mounts it. The renderer is pi's own for the mode (createInteractiveTui),
 *  on a terminal the test reads and feeds. Pi's chat and editor sit in pi's layout: createChatViewport in fullscreen, pi's
 *  containers in regular. ctx.ui.custom runs as showExtensionCustom runs it for a component that is not an overlay: the
 *  component replaces the editor in the editor container and takes the focus, and closing puts the editor back with the
 *  focus. Keys and mouse reports go through pi-tui's input callback, so pi-tui's listeners see them first: in fullscreen,
 *  the alt screen's wheel and page keys. */
function fakeUI(rows = 20, mode: "regular" | "fullscreen" = "fullscreen", theme: Theme = PLAIN) {
  const terminal = new CapturingTerminal(WIDTH, rows);
  // Copy on select is off, so a test never writes the clipboard. The wheel moves one line a notch: pi's "auto" scales a
  // notch by how quickly the notches arrive, which would make the counts depend on timing.
  const tui = createInteractiveTui({ tuiMode: mode, showHardwareCursor: false, logDirectory: tmpdir(), terminal, fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 1 });
  const editor = textLine("editor text");
  const pi = {
    document: containing(textLine("chat line")), pendingMessages: new Container(), status: new Container(),
    widgetsAbove: new Container(), editor: containing(editor), widgetsBelow: containing(textLine("worker widget")),
    footer: containing(textLine("pi footer")),
  };
  if (mode === "fullscreen") (tui as unknown as ViewportTUI).setLayoutRoot(createChatViewport({ ...pi, scrollbar: "auto" }).root);
  else for (const child of [pi.document, pi.pendingMessages, pi.status, pi.widgetsAbove, pi.editor, pi.widgetsBelow, pi.footer]) tui.addChild(child);
  tui.setFocus(editor);
  // Every requestRender the TUI gets, in order: true for a forced reprint of the whole terminal.
  const requests: boolean[] = [];
  const requestRender = tui.requestRender.bind(tui);
  tui.requestRender = (force = false) => { requests.push(force); requestRender(force); };
  tui.start();

  let closed = false;
  let childrenAtClose: readonly Component[] | undefined;
  let mounted: (Component & { handleInput(data: string): void; dispose(): void }) | undefined;
  const customArguments: unknown[][] = [];
  const keysGiven: string[] = [];
  const ui: TranscriptUI = {
    custom: ((factory: (...args: unknown[]) => unknown, ...rest: unknown[]) => {
      customArguments.push(rest);
      return new Promise<unknown>((resolve) => {
        const close = (result: unknown) => {
          if (closed) return;
          closed = true;
          childrenAtClose = [...tui.children];
          pi.editor.clear();
          pi.editor.addChild(editor);
          tui.setFocus(editor);
          tui.requestRender();
          resolve(result);
          mounted?.dispose();
        };
        const component = factory(tui, theme, new KeybindingsManager(), close) as Component & { handleInput(data: string): void; dispose(): void };
        mounted = component;
        const handleInput = component.handleInput.bind(component);
        component.handleInput = (data: string) => { keysGiven.push(data); handleInput(data); };
        pi.editor.clear();
        pi.editor.addChild(component);
        tui.setFocus(component);
        tui.requestRender();
      });
    }) as TranscriptUI["custom"],
    getToolsExpanded: () => false,
  };
  // pi-tui's last frame: the fullscreen screen it drew, or regular mode's whole document.
  const frame = (): readonly string[] => mode === "regular"
    ? (tui as unknown as TuiMainScreen).captureRenderState().previousLines
    : (tui as unknown as { readonly previousScreen: readonly string[] }).previousScreen;
  return {
    ui, tui, terminal, requests, customArguments,
    get closed(): boolean { return closed; },
    get childrenAtClose(): readonly Component[] | undefined { return childrenAtClose; },
    /** Whether pi's editor, rather than the view, has the focus. */
    get editorFocused(): boolean { return tui.getFocusedComponent() === editor; },
    /** The keys the focused view took, in order. */
    get keysGiven(): readonly string[] { return keysGiven; },
    /** Everything pi-tui wrote so far. */
    get output(): string { return terminal.written.join(""); },
    press(...keys: string[]) { for (const key of keys) terminal.send(key); },
    /** Wheel notches over the screen, as the terminal reports them: SGR button 64 scrolls up, 65 down. */
    wheel(direction: "up" | "down", notches = 1) {
      for (let notch = 0; notch < notches; notch++) terminal.send(`\x1b[<${direction === "up" ? 64 : 65};50;6M`);
    },
    /** The screen as drawn now, without colours but with the scrollbar's cell, so a test can see which glyph and tag it has. */
    raw(): string[] {
      tui.renderNow();
      return frame().map((line) => plain(line).trimEnd());
    },
    /** The screen as the user reads it: drawn now, at `width` columns and the terminal's height, without colours and, in fullscreen, without the scrollbar. Regular mode is the whole document. */
    text(width = WIDTH): string[] {
      terminal.columns = width;
      tui.renderNow();
      return frame().map((line) => {
        const shown = plain(line);
        return (mode === "fullscreen" ? shown.replace(SCROLLBAR_CELL, "") : shown).trimEnd();
      });
    },
    /** Draws now and returns what pi-tui wrote for it: a reprint clears the whole screen with `\x1b[2J`. */
    draw(): string {
      terminal.written.length = 0;
      tui.renderNow();
      return terminal.written.join("");
    },
    stop(): void { tui.stop(); },
  };
}

/** pi's own fullscreen chat, mounted as pi mounts it: the task and each reply as pi's message components in createChatViewport.
 *  The scroll tests send the same keys and notches to it and to the view, which must scroll the same way. */
function chatUI(rows: number, task: string, replies: readonly string[]) {
  const terminal = new CapturingTerminal(WIDTH, rows);
  const tui = createInteractiveTui({ tuiMode: "fullscreen", showHardwareCursor: false, logDirectory: tmpdir(), terminal, fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 1 });
  const document = new Container();
  const markdown = getMarkdownTheme();
  document.addChild(new UserMessageComponent(task, markdown) as unknown as Component);
  for (const text of replies) {
    document.addChild(new AssistantMessageComponent({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: 0 } as never, false, markdown) as unknown as Component);
  }
  const editor = textLine("editor text");
  const viewport = createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(),
    editor: containing(editor), widgetsBelow: containing(textLine("worker widget")), footer: containing(textLine("pi footer")), scrollbar: "auto" });
  (tui as unknown as ViewportTUI).setLayoutRoot(viewport.root);
  tui.setFocus(editor);
  tui.start();
  return {
    tui,
    press(...keys: string[]) { for (const key of keys) terminal.send(key); },
    wheel(direction: "up" | "down", notches = 1) { for (let notch = 0; notch < notches; notch++) terminal.send(`\x1b[<${direction === "up" ? 64 : 65};50;6M`); },
    /** The screen as the user reads it, as the view's text() reads it. */
    text(): string[] {
      tui.renderNow();
      return (tui as unknown as { readonly previousScreen: readonly string[] }).previousScreen.map((line) => plain(line).replace(SCROLLBAR_CELL, "").trimEnd());
    },
  };
}

/** Pi's chat with the same completed bash boxes as a budget transcript. */
function budgetChat(mode: "fullscreen" | "regular", calls: number) {
  const terminal = new CapturingTerminal(WIDTH, 40);
  const tui = createInteractiveTui({ tuiMode: mode, showHardwareCursor: false, logDirectory: tmpdir(), terminal, fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 1 });
  const document = new Container();
  const markdown = getMarkdownTheme();
  const cwd = process.cwd();
  document.addChild(new UserMessageComponent("Task", markdown) as unknown as Component);
  for (let i = 0; i < calls; i++) {
    const id = `call-${i}`;
    document.addChild(new AssistantMessageComponent(reply(`Round ${i}\n\nA detail.\n\nAnother detail.`) as never, false, markdown) as unknown as Component);
    const tool = new ToolExecutionComponent("bash", id, { command: `seq ${i}` }, {}, createBashToolDefinition(cwd), tui as never, cwd);
    tool.setArgsComplete();
    tool.updateResult({ content: [{ type: "text", text: Array.from({ length: 30 }, (_, k) => `line ${k + 1} of output ${i}`).join("\n") }], isError: false }, false);
    document.addChild(tool as unknown as Component);
  }
  if (mode === "fullscreen") {
    const editor = textLine("editor text");
    (tui as unknown as ViewportTUI).setLayoutRoot(createChatViewport({ document, pendingMessages: new Container(), status: new Container(), widgetsAbove: new Container(),
      editor: containing(editor), widgetsBelow: containing(textLine("worker widget")), footer: containing(textLine("pi footer")), scrollbar: "auto" }).root);
    tui.setFocus(editor);
  } else tui.addChild(document);
  tui.start();
  return { tui, terminal };
}

function medianFrame(render: () => void): number {
  for (let i = 0; i < 10; i++) render();
  const times: number[] = [];
  for (let i = 0; i < 40; i++) { const start = performance.now(); render(); times.push(performance.now() - start); }
  return times.sort((a, b) => a - b)[20]!;
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
  const view = fakeUI(24);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.deepEqual(view.customArguments, [[]], "ctx.ui.custom gets no overlay options: the view is not an overlay");

  const lines = view.text(60);
  assert.equal(lines.length, 24, "exactly the terminal's height");
  assert.ok(lines.every((line) => line.length <= 60), JSON.stringify(lines));
  assert.equal(shownWorker(view), "fixer · running · worker 1 of 1");
  assert.deepEqual(pickerLines(view), ["  ○ main", "❯ ● fixer   routing… · 0s · running"], "the viewed worker is highlighted beside main");
  assert.ok(view.text().some((line) => line.includes("Fix the typo")));
  view.terminal.rows = 30;
  assert.equal(view.text().length, 30, "a resize redraws at the new size");

  view.press("q", KEY.left, "z");
  assert.equal(view.closed, false, "other keys keep it open");
  view.press(KEY.kittyEscape);
  assert.equal(await shown, "back");
  assert.equal(view.closed, true, "Esc under the kitty keyboard protocol leaves");
  assert.equal(view.editorFocused, true, "pi's editor has the focus again");
  assert.equal(fake.listeners.size, 1, "the view stopped following the worker's session; only the board does");
  const renders = view.requests.length;
  fake.emit({ type: "turn_start" });
  board.add({ callId: "call-2", background: false, task: "Later", model: { kind: "routed" } });
  board.setOrchestratorState("running");
  assert.equal(view.requests.length, renders, "nor does the board redraw it, the orchestrator bar included");

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
  view.press(KEY.up);
  assert.equal(pickerLines(view)[0], "❯ ● main", "main is selected before it is opened");
  view.press(KEY.enter);
  assert.equal(await shown, "main", "Enter on main leaves the transcript view");
  assert.equal(view.closed, true);
});

test("a live transcript follows the end until the user scrolls; pi's page keys scroll it, and pi's bottom key follows again", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Count to many", "worker-1");
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.ok(view.text().includes("following · ←→ worker · wheel or PgUp PgDn scroll · x stop · ctrl+o tool output · Esc back"), JSON.stringify(view.text()));

  // A reply as it streams, then saved.
  const renders = view.requests.length;
  const partial = { role: "assistant", content: [{ type: "text", text: "Counting now" }], timestamp: 0 };
  fake.emit({ type: "message_start", message: partial });
  fake.emit({ type: "message_update", message: partial });
  assert.ok(view.requests.length > renders, "each event redraws the view");
  assert.ok(view.text().some((line) => line.includes("Counting now")), "the streaming reply shows");
  const numbers = Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n");
  fake.add(reply(numbers));
  const last = () => view.text().filter((line) => /number \d+/.test(line)).at(-1)?.trim();
  assert.equal(last(), "number 40", "following the end");

  view.press(KEY.pageUp);
  const firstShown = () => view.text().find((line) => /number \d+/.test(line))?.trim();
  const scrolled = firstShown();
  assert.notEqual(last(), "number 40");
  assert.match(view.text().at(-1)!, new RegExp(`^line \\d+, ${FOLLOW_PATTERN} follows`));
  fake.add(reply("A new message below"));
  assert.equal(firstShown(), scrolled, "a scrolled view stays put while the worker goes on");
  assert.ok(!view.text().some((line) => line.includes("A new message below")));

  view.press(keyFor("tui.altScreen.top"));
  assert.ok(view.text().some((line) => line.includes("Count to many")), "pi's top key shows the task");
  view.press(KEY.pageDown);
  assert.match(view.text().at(-1)!, /^line \d+/);
  view.press(keyFor("tui.altScreen.bottom"));
  assert.ok(view.text().some((line) => line.includes("A new message below")), "pi's bottom key shows the end");
  assert.match(view.text().at(-1)!, /^following/);
  fake.add(reply("And it follows again"));
  assert.ok(view.text().some((line) => line.includes("And it follows again")));

  view.press(KEY.pageUp, KEY.pageDown, KEY.pageDown, KEY.pageDown);
  assert.match(view.text().at(-1)!, /^following/, "paging back down to the end follows it too");
  const viewportKeys = [KEY.pageUp, KEY.pageDown, keyFor("tui.altScreen.top"), keyFor("tui.altScreen.bottom")];
  assert.deepEqual(view.keysGiven.filter((key) => viewportKeys.includes(key)), [], "pi-tui's alt screen takes the page, top and bottom keys: the view gets none");
});

test("fullscreen tuiMode: pi-tui's alt screen takes the mouse wheel and scrolls the transcript under the pointer; a notch up stops following, and a notch down to the end follows again", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Count to many", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  fake.add(reply(Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n")));
  const footer = () => view.text().at(-1)!;
  const firstLine = () => Number(new RegExp(`^line (\\d+), ${FOLLOW_PATTERN} follows`).exec(footer())?.[1]);
  assert.match(footer(), /^following · /, "following the end");

  view.wheel("up", 3);
  assert.match(footer(), new RegExp(`^line \\d+, ${FOLLOW_PATTERN} follows`), "a notch up stops following");
  const top = firstLine();
  view.wheel("up");
  assert.equal(firstLine(), top - 1, "a notch up scrolls up a line");
  view.wheel("down", 2);
  assert.equal(firstLine(), top + 1, "a notch down scrolls down");
  view.wheel("down", 100);
  assert.match(footer(), /^following · /, "reaching the end follows again");
  assert.equal(view.text().filter((line) => /number \d+/.test(line)).at(-1)?.trim(), "number 40");
  assert.deepEqual(view.keysGiven, [], "the alt screen takes every notch: none reaches the view's keys");
  view.press(KEY.escape);
  await shown;
});

test("fullscreen tuiMode: pi-tui takes the mouse presses and drags on the transcript, and the view gets none of them", async () => {
  const board = new WorkerBoard();
  running(board, "Count to many", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  view.terminal.send("\x1b[<0;10;3M");
  view.terminal.send("\x1b[<32;14;3M");
  view.terminal.send("\x1b[<0;14;3m");
  assert.deepEqual(view.keysGiven, [], "no press, drag or release reaches the view");
  view.press(KEY.escape);
  await shown;
});

/** What the scroll tests need of a fullscreen screen: its pi-tui, keys and wheel, and the rows it shows. */
type Side = { readonly tui: unknown; press(...keys: string[]): void; wheel(direction: "up" | "down", notches?: number): void; text(): string[] };

/** A worker's transcript whose replies are long enough to scroll, as pi's chat is in the scroll tests. */
const SCROLL_REPLIES = Array.from({ length: 30 }, (_, index) =>
  `Reply ${index + 1}: first paragraph of the answer.\n\nSecond paragraph of reply ${index + 1}, a little longer so that it wraps.\n\nThird paragraph.`);

test("fullscreen tuiMode: the view scrolls as pi's chat does for the same keys and wheel notches, page keys, top, bottom and prompt jumps included", async () => {
  const chat = chatUI(20, "Count the replies", SCROLL_REPLIES);
  const board = new WorkerBoard();
  const { fake } = running(board, "Count the replies", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  for (const text of SCROLL_REPLIES) fake.add(reply(text));
  const sides: [string, Side][] = [["pi's chat", chat], ["the view", view]];
  const position = (side: Side) => {
    side.text(); // pi-tui's layout, and so its primary ScrollView, exists once a frame is drawn
    const scroll = primaryScroll(side.tui);
    const page = scroll.viewportHeight;
    const content = (scroll as unknown as { readonly contentHeight: number }).contentHeight;
    return { top: scroll.scrollTop, following: scroll.isFollowingEnd, page, end: Math.max(0, content - page), shown: side.text().slice(0, 3) };
  };
  type Position = ReturnType<typeof position>;
  /** The same keys to each side, then `expect` on each side's position before and after. */
  const step = (label: string, act: (side: Side) => void, expect: (before: Position, after: Position, message: string) => void) => {
    const before = new Map(sides.map(([name, side]) => [name, position(side)]));
    for (const [, side] of sides) act(side);
    for (const [name, side] of sides) expect(before.get(name)!, position(side), `${name}: ${label}`);
  };
  const isReplyStart = (rows: readonly string[]) => rows.some((row) => /Reply \d+: first paragraph/.test(row));

  step("opens following the end", () => {}, (_before, after, message) => {
    assert.ok(after.following && after.top === after.end, `${message} starts at the end, following it`);
  });
  step("wheel up three notches", (side) => side.wheel("up", 3), (before, after, message) => {
    assert.equal(after.top, before.top - 3, `${message} moves one line a notch`);
    assert.equal(after.following, false, `${message} stops following`);
  });
  step("wheel down one notch", (side) => side.wheel("down"), (before, after, message) => {
    assert.equal(after.top, before.top + 1, message);
  });
  step("page up", (side) => side.press(KEY.pageUp), (before, after, message) => {
    assert.equal(after.top, Math.max(0, before.top - (before.page - 4)), `${message} moves a page less four lines`);
  });
  step("page down", (side) => side.press(KEY.pageDown), (before, after, message) => {
    assert.equal(after.top, Math.min(before.end, before.top + (before.page - 4)), `${message} moves a page less four lines`);
  });
  step("top", (side) => side.press(keyFor("tui.altScreen.top")), (_before, after, message) => {
    assert.equal(after.top, 0, `${message} goes to the top`);
    assert.equal(after.following, false, message);
  });
  step("bottom", (side) => side.press(keyFor("tui.altScreen.bottom")), (_before, after, message) => {
    assert.equal(after.top, after.end, `${message} goes to the end`);
    assert.equal(after.following, true, `${message} follows the end again`);
  });
  step("previous prompt", (side) => side.press(keyFor("tui.altScreen.previousPrompt")), (before, after, message) => {
    assert.ok(after.top < before.top && isReplyStart(after.shown), `${message} jumps to the start of the reply above`);
  });
  step("previous prompt again", (side) => side.press(keyFor("tui.altScreen.previousPrompt")), (before, after, message) => {
    assert.ok(after.top < before.top && isReplyStart(after.shown), `${message} jumps to the reply above that`);
  });
  step("next prompt", (side) => side.press(keyFor("tui.altScreen.nextPrompt")), (before, after, message) => {
    assert.ok(after.top > before.top && isReplyStart(after.shown), `${message} jumps to the reply below`);
  });
  // Home and End are not the view's keys: whatever pi's chat does with them, the view does too.
  for (const key of [KEY.home, KEY.end]) {
    const outcomes = sides.map(([name, side]) => {
      const before = position(side);
      side.press(key);
      const after = position(side);
      const outcome = after.top === 0 && before.top !== 0 ? "top" : after.following && !before.following ? "end" : after.top === before.top ? "unchanged" : "moved";
      return [name, outcome] as const;
    });
    assert.equal(outcomes[1]![1], outcomes[0]![1], `${JSON.stringify(key)} does what it does in pi's chat: ${outcomes[0]![1]}`);
  }
  (chat.tui as unknown as { stop(): void }).stop();
  view.press(KEY.escape);
  await shown;
});

test("fullscreen tuiMode: from the top, the view's next prompt is the task card, which carries the prompt marks pi's user message has", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Count the replies", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  for (const text of SCROLL_REPLIES) fake.add(reply(text));
  view.text();
  view.press(keyFor("tui.altScreen.top"));
  view.press(keyFor("tui.altScreen.nextPrompt"));
  assert.ok(view.text().slice(0, 3).some((row) => row.includes("Count the replies")), JSON.stringify(view.text().slice(0, 3)));
  view.press(KEY.escape);
  await shown;
});

test("fullscreen tuiMode: a scrolled-up transcript keeps its rows while output arrives, the board changes and the worker ends", async () => {
  const board = new WorkerBoard();
  const { fake, feed } = running(board, "Count to many", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  fake.add(reply(Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n")));
  view.text();
  view.wheel("up", 6);
  const scroll = () => primaryScroll(view.tui);
  const page = scroll().viewportHeight;
  const top = scroll().scrollTop;
  const before = view.text();
  /** Without the scroll-to-latest label, which pi draws over the viewport's last row and moves when the dock grows. */
  const withoutLabel = (rows: readonly string[]) => rows.map((row) => row.replace(/\s*\u2193 Jump to latest message.*$/u, ""));
  const held = (label: string) => {
    const now = view.text();
    const rows = Math.min(page, scroll().viewportHeight);
    assert.deepEqual(withoutLabel(now.slice(0, rows)), withoutLabel(before.slice(0, rows)), `${label}: the rows shown are still shown`);
    assert.equal(scroll().scrollTop, top, `${label}: the scroll position holds`);
    assert.equal(scroll().isFollowingEnd, false, `${label}: the view does not follow the end`);
  };
  const partial = { role: "assistant", content: [{ type: "text", text: "Streaming now" }], timestamp: 0 };
  fake.emit({ type: "message_start", message: partial });
  fake.emit({ type: "message_update", message: partial });
  held("a reply streams");
  fake.add(reply("A saved reply"));
  held("a reply is saved");
  const id = "call-live";
  fake.add({ role: "assistant", content: [{ type: "text", text: "Running it" }, { type: "toolCall", id, name: "bash", arguments: { command: "seq 1 200" } }], stopReason: "toolUse", timestamp: 0 });
  fake.emit({ type: "tool_execution_start", toolCallId: id, toolName: "bash", args: { command: "seq 1 200" } });
  held("a tool call starts");
  for (let row = 1; row <= 30; row++) {
    fake.emit({ type: "tool_execution_update", toolCallId: id, toolName: "bash", args: { command: "seq 1 200" }, partialResult: { content: [{ type: "text", text: Array.from({ length: row }, (_, index) => `row ${index + 1}`).join("\n") }] } });
  }
  held("its output grows");
  const output = Array.from({ length: 200 }, (_, index) => `row ${index + 1}`).join("\n");
  fake.emit({ type: "tool_execution_end", toolCallId: id, toolName: "bash", result: { content: [{ type: "text", text: output }] }, isError: false });
  fake.add(toolResult(id, "bash", output));
  held("the call ends with 200 lines");
  board.add({ callId: "call-2", background: false, task: "Another", model: { kind: "routed" } });
  board.setOrchestratorState("running");
  held("another worker starts and the orchestrator runs");
  fake.add(user("Also check the docs"));
  held("the user's message is added");
  feed.ended({ state: "completed" });
  held("the worker completes");
  view.press(KEY.escape);
  await shown;
});

test("fullscreen tuiMode: the dock starts right under the transcript: a message input that takes no messages takes no rows", async () => {
  const board = new WorkerBoard();
  running(board, "Count to many", "worker-1");
  const view = fakeUI(20);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  view.text();
  const page = primaryScroll(view.tui).viewportHeight;
  assert.match(view.text()[page]!, /^running \u00b7 /, "the worker's stats line is the dock's first row");
  view.press(KEY.escape);
  await shown;
});

/** A theme whose scrollbar colours show as zero-width tags (pi-tui's APC sequences), so a test can see which colour pi's scrollbar paints with. */
const TAGGED = { ...PLAIN, fg: (color: string, text: string) => color.startsWith("scrollbar") ? `\x1b_${color}\x07${text}\x1b_end\x07` : text } as unknown as Theme;
const TRACK = "\x1b_scrollbarTrack\x07";
const THUMB = "\x1b_scrollbarThumb\x07";

test("fullscreen tuiMode: the scrollbar follows pi's fullscreenScrollbar setting and paints in pi's track and thumb colours", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Count to many", "worker-1");
  fake.add(reply(Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n")));
  const scrollbarRows = (view: ReturnType<typeof fakeUI>) => view.raw().slice(0, primaryScroll(view.tui).viewportHeight);
  const always = fakeUI(20, "fullscreen", TAGGED);
  const shownAlways = openTranscript(always.ui, board, board.workers()[0]!.id, { scrollbar: "always" });
  const rows = scrollbarRows(always);
  assert.ok(rows.every((row) => /(\x1b_scrollbar(Track|Thumb)\x07)[\u2502\u2503\u2588]\x1b_end\x07$/.test(row)), `always: every row ends with pi's scrollbar: ${JSON.stringify(rows.at(-1))}`);
  assert.ok(rows.some((row) => row.includes(THUMB)) && rows.some((row) => row.includes(TRACK)), "a thumb and a track, in pi's two colours");
  always.press(KEY.escape);
  await shownAlways;

  const auto = fakeUI(20, "fullscreen", TAGGED);
  const shownAuto = openTranscript(auto.ui, board, board.workers()[0]!.id);
  assert.ok(!scrollbarRows(auto).some((row) => row.includes("\x1b_scrollbar")), "auto: no scrollbar while the view follows the end");
  auto.wheel("up", 1);
  assert.ok(scrollbarRows(auto).some((row) => row.includes(THUMB) || row.includes(TRACK)), "auto: a scrollbar shows for a moment after a scroll");
  auto.press(KEY.escape);
  await shownAuto;

  const hidden = fakeUI(20, "fullscreen", TAGGED);
  const shownHidden = openTranscript(hidden.ui, board, board.workers()[0]!.id, { scrollbar: "hidden" });
  hidden.wheel("up", 3);
  assert.ok(!scrollbarRows(hidden).some((row) => row.includes("\x1b_scrollbar")), "hidden: no scrollbar, even after a scroll");
  hidden.press(KEY.escape);
  await shownHidden;
});

test("regular tuiMode: pi-tui asks the terminal for no mouse reports, so the terminal scrolls the view, while fullscreen asks for them", () => {
  const board = new WorkerBoard();
  running(board, "Count to many", "worker-1", {}, [user("Count to many"), reply(Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n"))]);
  const view = fakeUI(12, "regular");
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.doesNotMatch(view.output, /\x1b\[\?100[0236]h/, "no mouse reporting is switched on");
  const before = view.text();
  view.wheel("up", 3);
  assert.deepEqual(view.text(), before, "a wheel notch does not move the view");
  view.press(KEY.escape);
  assert.match(fakeUI(12).output, /\x1b\[\?1000h/, "fullscreen switches mouse reporting on, so the wheel reaches pi-tui");
});

test("the view is not an overlay in either tuiMode: pi mounts it in its editor container with the focus, and leaving gives pi's view and editor back as they were", async () => {
  for (const mode of ["regular", "fullscreen"] as const) {
    const board = new WorkerBoard();
    running(board, "Fix the typo", "worker-1", {}, [user("Fix the typo"), reply("Fixed it")]);
    const view = fakeUI(20, mode);
    const before = view.text();
    const children = [...view.tui.children];
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    assert.deepEqual(view.customArguments, [[]], `${mode}: no overlay options`);
    assert.equal(view.editorFocused, false, `${mode}: the view has the focus`);
    assert.ok(view.text().some((line) => line.includes("Fixed it")), `${mode}: the view is on screen`);
    view.press(KEY.escape);
    assert.equal(await shown, "back");
    assert.equal(view.editorFocused, true, `${mode}: pi's editor has the focus again`);
    assert.deepEqual(view.tui.children, children, `${mode}: pi's children are back`);
    assert.deepEqual(view.text(), before, `${mode}: pi's view is as it was`);
    view.stop();
  }
});

test("streamed tokens update only the live reply, not 200 finished replies", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1", {}, [user("Task"), ...Array.from({ length: 200 }, (_, i) => reply(`Finished ${i}`))]);
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const updates = mock.method(AssistantMessageComponent.prototype, "updateContent");
  try {
    const live = reply("Streaming");
    fake.emit({ type: "message_start", message: live });
    updates.mock.resetCalls();
    for (let i = 0; i < 20; i++) fake.emit({ type: "message_update", message: reply(`Streaming ${i}`) });
    assert.equal(updates.mock.calls.length, 20);
  } finally {
    updates.mock.restore();
    view.press(KEY.escape);
    await shown;
  }
});

test("streamed tokens leave a running tool with long partial output alone", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1");
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const call = { id: "bash-1", name: "bash", arguments: { command: "seq 2000" } };
  fake.add(reply("Running", [call]));
  fake.emit({ type: "tool_execution_start", toolCallId: call.id, toolName: call.name, args: call.arguments });
  fake.emit({ type: "tool_execution_update", toolCallId: call.id, toolName: call.name,
    partialResult: { content: [{ type: "text", text: Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") }] } });
  const args = mock.method(ToolExecutionComponent.prototype, "updateArgs");
  const result = mock.method(ToolExecutionComponent.prototype, "updateResult");
  const complete = mock.method(ToolExecutionComponent.prototype, "setArgsComplete");
  try {
    for (let i = 0; i < 20; i++) fake.emit({ type: "message_update", message: reply(`Streaming ${i}`) });
    assert.equal(args.mock.calls.length + result.mock.calls.length + complete.mock.calls.length, 0);
  } finally {
    args.mock.restore(); result.mock.restore(); complete.mock.restore();
    view.press(KEY.escape);
    await shown;
  }
});

test("a reply completes tool arguments once at its end, not during updates", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1");
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const args = { command: "echo hi" };
  const call = { id: "bash-1", name: "bash", arguments: args };
  const complete = mock.method(ToolExecutionComponent.prototype, "setArgsComplete");
  try {
    fake.emit({ type: "message_start", message: reply("", [call]) });
    for (let i = 0; i < 20; i++) fake.emit({ type: "message_update", message: reply(`Token ${i}`, [call]) });
    assert.equal(complete.mock.calls.length, 0);
    fake.add(reply("Done", [call]));
    assert.equal(complete.mock.calls.length, 1);
  } finally { complete.mock.restore(); view.press(KEY.escape); await shown; }
});

test("a finished call receives one final result with its duration", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1");
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const call = { id: "bash-1", name: "bash", arguments: { command: "echo hi" } };
  fake.add(reply("Running", [call]));
  const result = mock.method(ToolExecutionComponent.prototype, "updateResult");
  try {
    const final = { content: [{ type: "text", text: "hi" }] };
    fake.emit({ type: "tool_execution_end", toolCallId: call.id, toolName: call.name, result: final, isError: false, durationMs: 123 });
    fake.add(toolResult(call.id, call.name, "hi"));
    assert.equal(result.mock.calls.length, 1);
    assert.equal((result.mock.calls[0]?.arguments[0] as { durationMs?: number }).durationMs, 123);
  } finally { result.mock.restore(); view.press(KEY.escape); await shown; }
});

test("a finished streamed reply is reused as its saved message", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1");
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const updates = mock.method(AssistantMessageComponent.prototype, "updateContent");
  try {
    fake.emit({ type: "message_start", message: reply("Part") });
    updates.mock.resetCalls();
    fake.add(reply("Finished"));
    view.text(); view.text();
    assert.equal(updates.mock.calls.length, 1);
    assert.equal(view.text().filter((line) => line.includes("Finished")).length, 1);
  } finally { updates.mock.restore(); view.press(KEY.escape); await shown; }
});

test("attaching mid-stream follows one partial reply without duplicating it", async () => {
  const board = new WorkerBoard();
  const partial = { ...reply("Partial answer"), stopReason: undefined };
  const { fake } = running(board, "Task", "worker-1", {}, [user("Task"), partial]);
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  try {
    fake.emit({ type: "message_update", message: reply("Partial answer continued") });
    fake.add(user("New steer"));
    const lines = view.text();
    assert.equal(lines.filter((line) => line.includes("Partial answer")).length, 1);
    assert.ok(lines.findIndex((line) => line.includes("New steer")) > lines.findIndex((line) => line.includes("Partial answer")));
  } finally { view.press(KEY.escape); await shown; }
});

test("a user steer arriving during a streamed reply appears once after it", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Task", "worker-1");
  const view = fakeUI(50);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  try {
    fake.emit({ type: "message_start", message: reply("Streaming answer") });
    fake.add(user("Steer while streaming"));
    const lines = view.text();
    const answer = lines.findIndex((line) => line.includes("Streaming answer"));
    const steer = lines.findIndex((line) => line.includes("Steer while streaming"));
    assert.ok(answer >= 0 && steer > answer, JSON.stringify(lines));
    assert.equal(lines.filter((line) => line.includes("Steer while streaming")).length, 1);
  } finally { view.press(KEY.escape); await shown; }
});

test("finished sessions and live endings keep every message once", async () => {
  for (const finished of [false, true]) {
    const board = new WorkerBoard();
    const history = [user("Task"), reply("Unique answer")];
    const { fake, feed } = running(board, "Task", "worker-1", {}, history);
    if (finished) feed.ended({ state: "completed" });
    const view = fakeUI();
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    try {
      if (!finished) feed.ended({ state: "completed" });
      assert.equal(view.text().filter((line) => line.includes("Unique answer")).length, 1);
      assert.equal(view.text().filter((line) => line.includes("The worker completed.")).length, 1);
    } finally { view.press(KEY.escape); await shown; fake.listeners.clear(); }
  }
});

test("a left click expands a fullscreen tool result but not the header", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", {}, [user("Task"), reply("Reading", [{ id: "call-1", name: "bash", arguments: { command: "seq 30" } }]), toolResult("call-1", "bash", Array.from({ length: 30 }, (_, i) => `number ${i + 1}`).join("\n"))]);
  const view = fakeUI(60);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  try {
    const click = (y: number) => { view.terminal.send(`\x1b[<0;10;${y}M`); view.terminal.send(`\x1b[<0;10;${y}m`); };
    const row = view.text().findIndex((line) => line.includes("number 26"));
    assert.ok(row >= 0, JSON.stringify(view.text()));
    click(1);
    assert.ok(!view.text().some((line) => line.includes("number 1")));
    click(row + 1);
    assert.ok(view.text().some((line) => line.includes("number 1")));
  } finally { view.press(KEY.escape); await shown; }
});

test("a left click toggles a thinking block in fullscreen", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", {}, [user("Task"), { role: "assistant", content: [{ type: "thinking", thinking: "private thought" }, { type: "text", text: "Answer" }], stopReason: "stop", timestamp: 0 }]);
  const view = fakeUI(45);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  try {
    const row = view.text().findIndex((line) => line.includes("private thought"));
    assert.ok(row >= 0);
    view.terminal.send(`\x1b[<0;10;${row + 1}M`); view.terminal.send(`\x1b[<0;10;${row + 1}m`);
    assert.ok(view.text().some((line) => line.includes("Thinking...")));
    assert.ok(!view.text().some((line) => line.includes("private thought")));
  } finally { view.press(KEY.escape); await shown; }
});

test("trace writes frame JSON only to its configured file", async () => {
  const directory = mkdtempSync(join(tmpdir(), "transcript-trace-"));
  const file = join(directory, "frames.jsonl");
  const previous = process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
  process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE = file;
  const board = new WorkerBoard();
  running(board, "Task", "worker-1");
  const view = fakeUI();
  try {
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    view.draw();
    const before = readFileSync(file, "utf8").trim().split("\n").length;
    view.draw();
    const lines = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.equal(lines.length - before, 1, "one trace record per frame");
    assert.ok(lines.some((line) => line.kind === "frame" && typeof line.renderMs === "number" && Array.isArray(line.events)));
    view.press(KEY.escape); await shown;
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
    else process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE = previous;
    view.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test("trace records a frame count once a second", async () => {
  const directory = mkdtempSync(join(tmpdir(), "transcript-trace-count-"));
  const file = join(directory, "frames.jsonl");
  const previous = process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
  process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE = file;
  const board = new WorkerBoard();
  running(board, "Task", "worker-1");
  const view = fakeUI();
  try {
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    view.text();
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    view.text();
    const records = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    assert.ok(records.some((line) => line.kind === "seconds" && typeof line.frames === "number"));
    view.press(KEY.escape); await shown;
  } finally {
    if (previous === undefined) delete process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
    else process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE = previous;
    view.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test("without the trace variable, no trace file is created", async () => {
  const previous = process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
  delete process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE;
  const directory = mkdtempSync(join(tmpdir(), "transcript-no-trace-"));
  const board = new WorkerBoard();
  running(board, "Task", "worker-1");
  const view = fakeUI();
  try {
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    view.text();
    assert.equal(readdirSync(directory).length, 0);
    view.press(KEY.escape); await shown;
  } finally {
    if (previous !== undefined) process.env.PI_ORCHESTRATOR_TRANSCRIPT_TRACE = previous;
    view.stop(); rmSync(directory, { recursive: true, force: true });
  }
});

test("fifty frames over finished messages call no update method or tint pass", async () => {
  for (const mode of ["fullscreen", "regular"] as const) {
    const board = new WorkerBoard();
    running(board, "Task", "worker-1", {}, [user("Task"), reply("Done", [{ id: "call-1", name: "bash", arguments: { command: "echo hi" } }]), toolResult("call-1", "bash", "hi")]);
    const view = fakeUI(30, mode);
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    view.text();
    const assistant = mock.method(AssistantMessageComponent.prototype, "updateContent");
    const tool = mock.method(ToolExecutionComponent.prototype as unknown as { updateDisplay(): void }, "updateDisplay");
    const tint = mock.method(PLAIN, "bg");
    try {
      for (let i = 0; i < 50; i++) view.tui.renderNow();
      assert.equal(assistant.mock.calls.length + tool.mock.calls.length + tint.mock.calls.length, 0, mode);
    } finally { assistant.mock.restore(); tool.mock.restore(); tint.mock.restore(); view.press(KEY.escape); await shown; }
  }
});

test("a header tick changes elapsed time without rebuilding finished messages", async () => {
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  running(board, "Task", "worker-1", {}, [user("Task"), reply("Done", [{ id: "call-1", name: "bash", arguments: { command: "echo hi" } }]), toolResult("call-1", "bash", "hi")]);
  const ticks: (() => void)[] = [];
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now, setInterval: (tick) => { ticks.push(tick); return 1; }, clearInterval: () => {} });
  view.text();
  const assistant = mock.method(AssistantMessageComponent.prototype, "updateContent");
  const tool = mock.method(ToolExecutionComponent.prototype as unknown as { updateDisplay(): void }, "updateDisplay");
  const tint = mock.method(PLAIN, "bg");
  try {
    time.advance(3_000); ticks[0]!();
    assert.ok(view.text().some((line) => line.includes("3s")));
    assert.equal(assistant.mock.calls.length + tool.mock.calls.length + tint.mock.calls.length, 0);
  } finally { assistant.mock.restore(); tool.mock.restore(); tint.mock.restore(); view.press(KEY.escape); await shown; }
});

test("ctrl+o updates each tool once and subsequent frames do not", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", {}, [user("Task"), reply("Done", [{ id: "call-1", name: "bash", arguments: { command: "echo hi" } }]), toolResult("call-1", "bash", "hi")]);
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  view.text();
  const display = mock.method(ToolExecutionComponent.prototype as unknown as { updateDisplay(): void }, "updateDisplay");
  try {
    view.press(KEY.ctrlO); view.text();
    assert.equal(display.mock.calls.length, 1);
    for (let i = 0; i < 50; i++) view.tui.renderNow();
    assert.equal(display.mock.calls.length, 1);
    view.press(KEY.ctrlO);
    assert.equal(display.mock.calls.length, 2);
  } finally { display.mock.restore(); view.press(KEY.escape); await shown; }
});

test("switching workers disposes a running tool and builds the new messages once", async () => {
  const board = new WorkerBoard();
  const first = running(board, "First", "worker-1", {}, [user("First"), reply("Running", [{ id: "bash-1", name: "bash", arguments: { command: "sleep 1" } }])]);
  running(board, "Second", "worker-2", {}, [user("Second"), reply("One reply")]);
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const result = mock.method(ToolExecutionComponent.prototype, "updateResult");
  const assistant = mock.method(AssistantMessageComponent.prototype, "updateContent");
  try {
    view.press(KEY.right);
    assert.equal(result.mock.calls.length, 1);
    assert.equal(assistant.mock.calls.length, 1);
    for (let i = 0; i < 20; i++) view.tui.renderNow();
    assert.equal(assistant.mock.calls.length, 1);
  } finally { result.mock.restore(); assistant.mock.restore(); view.press(KEY.escape); await shown; first.feed.ended({ state: "completed" }); }
});

test("a finished worker's session is read once across twenty frames", async () => {
  const board = new WorkerBoard();
  const feed = board.add({ callId: "call-1", background: false, task: "Task", model: { kind: "routed" } });
  feed.started(); feed.ended({ state: "completed", sessionFile: "/sessions/worker-1.jsonl" });
  let reads = 0;
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { readSession: () => { reads++; return [user("Task"), reply("Saved")]; } });
  try {
    for (let i = 0; i < 20; i++) view.tui.renderNow();
    assert.equal(reads, 1);
  } finally { view.press(KEY.escape); await shown; }
});

test("a steer's mark needs no board snapshot on any frame", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", { background: true }, [user("Task"), reply("Calling", [{ id: "call-1", name: "read", arguments: { path: "a" } }]), toolResult("call-1", "read", "a"), user("Steer text")]);
  const { steering } = fakeSteering();
  const view = fakeUI(30);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  const snapshots = mock.method(board, "workers");
  try {
    for (let i = 0; i < 20; i++) view.tui.renderNow();
    assert.equal(snapshots.mock.calls.length, 0);
  } finally { snapshots.mock.restore(); view.press(KEY.escape); await shown; }
});

for (const mode of ["fullscreen", "regular"] as const) {
  test(`${mode} frames over 300 bash calls stay within twice pi's chat`, async () => {
    const calls = 300;
    const messages: Message[] = [user("Task")];
    for (let i = 0; i < calls; i++) {
      messages.push(reply(`Round ${i}\n\nA detail.\n\nAnother detail.`, [{ id: `call-${i}`, name: "bash", arguments: { command: `seq ${i}` } }]));
      messages.push(toolResult(`call-${i}`, "bash", Array.from({ length: 30 }, (_, k) => `line ${k + 1} of output ${i}`).join("\n")));
    }
    const chat = budgetChat(mode, calls);
    const board = new WorkerBoard();
    running(board, "Task", "worker-1", {}, messages);
    const view = fakeUI(40, mode);
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    try {
      chat.tui.renderNow(); view.tui.renderNow();
      const rows = mode === "fullscreen" ? (primaryScroll(view.tui) as unknown as { contentHeight: number }).contentHeight
        : (view.tui as unknown as TuiMainScreen).captureRenderState().previousLines.length;
      assert.ok(rows >= 5_100, `${mode}: expected 5,100 rows, got ${rows}`);
      if (mode === "fullscreen") {
        for (let i = 0; i < 5; i++) {
          chat.terminal.send("\x1b[<64;50;6M"); view.terminal.send("\x1b[<64;50;6M");
        }
      }
      const piMs = medianFrame(() => chat.tui.renderNow());
      const viewMs = medianFrame(() => view.tui.renderNow());
      assert.ok(viewMs <= piMs * 2, `${mode}: view ${viewMs.toFixed(2)} ms, pi ${piMs.toFixed(2)} ms`);
    } finally { view.press(KEY.escape); await shown; view.stop(); chat.tui.stop(); }
  });
}

test("streamed-token work stays flat with a thousand finished messages", async () => {
  const measure = async (count: number) => {
    const board = new WorkerBoard();
    const { fake } = running(board, "Task", `worker-${count}`, {}, [user("Task"), ...Array.from({ length: count }, (_, i) => reply(`Finished ${i}`))]);
    const view = fakeUI();
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
    try {
      fake.emit({ type: "message_start", message: reply("") });
      const times: number[] = [];
      for (let i = 0; i < 40; i++) {
        const start = performance.now();
        fake.emit({ type: "message_update", message: reply(`Token ${i}`) });
        times.push(performance.now() - start);
      }
      return times.sort((a, b) => a - b)[20]!;
    } finally { view.press(KEY.escape); await shown; view.stop(); }
  };
  const short = await measure(10);
  const long = await measure(1_000);
  assert.ok(long <= short * 2, `10 replies ${short.toFixed(3)} ms, 1000 replies ${long.toFixed(3)} ms`);
});

test("a recorded steer changes its mark from orchestrator to user", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", { background: true }, [user("Task"), reply("Checking", [{ id: "call-1", name: "read", arguments: { path: "a" } }]), toolResult("call-1", "read", "a"), user("A steer")]);
  const { steering, sent } = fakeSteering();
  const view = fakeUI(40);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  try {
    assert.ok(view.text().some((line) => line.includes("Steer from the orchestrator")));
    sent.push({ workerId: board.workers()[0]!.id, text: "A steer", mode: "steer" });
    assert.ok(view.text().some((line) => line.includes("Steer from the user")));
  } finally { view.press(KEY.escape); await shown; }
});

test("a frame does not snapshot the board for the transcript and picker", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1");
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  const workers = mock.method(board, "workers");
  try {
    view.text();
    assert.ok(workers.mock.calls.length <= 1, `board snapshots: ${workers.mock.calls.length}`);
  } finally {
    workers.mock.restore(); view.press(KEY.escape); await shown;
  }
});

test("finished fullscreen tool boxes use pi's colours without retinting each frame", async () => {
  const board = new WorkerBoard();
  running(board, "Task", "worker-1", {}, [user("Task"), reply("Done", [{ id: "call-1", name: "bash", arguments: { command: "echo hi" } }]), toolResult("call-1", "bash", "hi")]);
  const view = fakeUI();
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  view.text();
  const tint = mock.method(PLAIN, "bg");
  try {
    for (let i = 0; i < 50; i++) view.tui.renderNow();
    assert.equal(tint.mock.calls.length, 0);
  } finally {
    tint.mock.restore(); view.press(KEY.escape); await shown;
  }
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
  const view = fakeUI(20);
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
  const renders = view.requests.length;
  board.served({ delegationId: "routed-1", model: "anthropic/claude-haiku-4-5", effort: "low", escalation: { from: "mechanical", to: "standard" } });
  assert.ok(view.requests.length > renders, "a served rung redraws the view");
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

test("the header shows delegation ids and one Markdown task preview", async () => {
  const LEAD = "0199f0b1-7c2d-7e3f-8a4b-5c6d7e8f9a0b", TESTER = "0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0";
  const board = new WorkerBoard();
  running(board, "Lead the work", LEAD, { agent: "lead" });
  running(board, "\n  Check   the tests\nThen report back", TESTER, { agent: "tester", parentDelegationId: LEAD });
  board.add({ callId: "call-2", background: false, task: "Waits its turn", model: { kind: "routed" } });
  const view = fakeUI(20);
  void openTranscript(view.ui, board, board.workers()[1]!.id);

  assert.deepEqual(header(view, 120).slice(2), [`delegation ${TESTER} · parent delegation ${LEAD} (lead)`, "Check   the tests", "Then report back"]);
  assert.deepEqual(header(view, 60).slice(2), ["delegation 0199f0c2… · parent delegation 0199f0b1… (lead)", "Check   the tests", "Then report back"],
    "short delegation ids on a narrow terminal");
  assert.equal(view.text().filter((line) => line.includes("Then report back")).length, 1, "no second prompt copy in the body");
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

  let renders = view.requests.length;
  board.setOrchestratorState("running");
  assert.ok(view.requests.length > renders, "a change of the orchestrator's state redraws the view");
  assert.equal(view.text()[0], "orchestrator running");
  renders = view.requests.length;
  board.asking("reviewer-1", true);
  assert.ok(view.requests.length > renders, "a worker asking redraws the view");
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
  const renders = view.requests.length;
  ticks[0]!();
  assert.equal(view.requests.length, renders + 1, "each tick redraws the view");
  assert.equal(header(view)[0], "worker · running · 3s · 0 turns · 0 tok · $0.000 · worker 1 of 1");
  view.press(KEY.escape);
  await shown;
  assert.deepEqual(cleared, ["timer"], "leaving the view stops its timer");
});

test("fullscreen tuiMode: the header and the task preview are the transcript's first lines, so they scroll away with it rather than staying pinned", async () => {
  const board = new WorkerBoard();
  const task = "## Goal\n\nCheck `docker desktop`.\n\n## Steps\n\n- Read logs\n- Report back";
  const queued = board.add({ callId: "call-1", background: false, task, model: { kind: "routed" } });
  const view = fakeUI(24);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.equal(view.text().filter((line) => line.includes("Goal")).length, 1, "the preview shows before the session starts");
  assert.ok(view.text().some((line) => line.includes("ctrl+o to expand task")));
  assert.ok(!view.text().some((line) => line.includes("Read logs")));

  queued.started();
  const session = fakeSession("worker-1", [user(task)]);
  queued.session(session.session);
  session.add(reply(Array.from({ length: 40 }, (_, index) => `number ${index + 1}`).join("\n\n")));
  assert.ok(!view.text().some((line) => line.includes("Goal")), "following the end, the preview has scrolled away");
  assert.ok(!view.text().includes("orchestrator idle"), "and so has the bar");
  view.press(keyFor("tui.altScreen.top"));
  assert.equal(view.text()[0], "orchestrator idle", "the top of the transcript is the bar");
  assert.equal(view.text().filter((line) => line.includes("Goal")).length, 1, "and the preview, below the header");
  view.press(KEY.ctrlO, keyFor("tui.altScreen.top"));
  assert.ok(view.text().some((line) => line.includes("Read logs")), "the full task is in the scrollable body");
  assert.equal(view.text().filter((line) => line.includes("Goal")).length, 1, "not repeated in the header");
  view.press(KEY.escape);
  await shown;
});

test("a Markdown task appears once, previews briefly, and expands with the tool-output key", async () => {
  const board = new WorkerBoard();
  const task = "## Goal\n\nCheck `docker desktop`.\n\n## Steps\n\n- Read logs\n- Report back";
  running(board, task, "worker-1");
  const view = fakeUI(10, "regular");
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  const collapsed = view.text();
  assert.equal(collapsed.filter((line) => line.includes("Goal")).length, 1, "no raw header copy");
  assert.ok(collapsed.some((line) => line.includes("docker desktop")));
  assert.ok(collapsed.some((line) => line.includes("ctrl+o to expand task")));
  assert.ok(!collapsed.some((line) => line.includes("Read logs")));
  view.press(KEY.ctrlO);
  const expanded = view.text();
  assert.equal(expanded.filter((line) => line.includes("Goal")).length, 1);
  assert.ok(expanded.some((line) => line.includes("Steps")));
  assert.ok(expanded.some((line) => line.includes("Read logs")));
  assert.ok(expanded.some((line) => line.includes("Report back")));
  assert.ok(!expanded.some((line) => line.includes("ctrl+o to expand task")));
  view.press(KEY.ctrlO);
  assert.ok(!view.text().some((line) => line.includes("Read logs")));
});

test("in regular tuiMode the view replaces pi's whole view while open and puts it back intact on leaving", async () => {
  const board = new WorkerBoard();
  running(board, "Fix the typo", "worker-1", { agent: "fixer" }, [user("Fix the typo"), reply("Fixed it")]);
  running(board, "Other work", "worker-2", { agent: "other" }, [user("Other work"), reply("Other reply")]);
  const view = fakeUI(10, "regular");
  const original = [...view.tui.children];
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id);

  assert.equal(view.tui.children.length, 1, "pi's chat, editor and widgets are swapped out");
  assert.ok(!view.text().some((line) => ["chat line", "editor text", "worker widget"].includes(line)));
  assert.ok(view.text().some((line) => line.includes("Fixed it")));
  assert.equal(view.editorFocused, false, "the view has the focus, not pi's editor");
  assert.ok(view.requests.includes(true), "opening reprints the terminal");

  view.requests.length = 0;
  view.press(KEY.right);
  assert.ok(view.text().some((line) => line.includes("Other reply")), "→ switches worker");
  assert.equal(view.requests.at(-1), true, "switching reprints and lands at the bottom");
  view.press(KEY.left);
  view.press(KEY.up, KEY.enter);
  assert.equal(await shown, "main", "Enter on main leaves the transcript view");
  assert.deepEqual(view.childrenAtClose, original, "pi's tree is back before pi's close restores the editor and its focus");
  assert.equal(view.editorFocused, true, "pi's editor has the focus again");
  assert.ok(view.requests.includes(true), "leaving reprints");
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
  const view = fakeUI(10, "regular");
  void openTranscript(view.ui, board, board.workers()[0]!.id, { now: time.now });
  const text = view.text(60);

  assert.deepEqual(text.slice(0, 3), ["tester", "routing…", "delegation 0199f0c2-5e0a-7c1b-9d3e-3f2a9c1e44b0"]);
  const top = text.slice(3, text.findIndex((line) => line.startsWith("─")));
  assert.deepEqual(top, [], "the header does not repeat the task");
  assert.ok(text.some((line) => line.includes("ctrl+o to expand task")), "the transcript previews the task");
  assert.ok(!text.some((line) => line.includes("The very end.")), "the long task is collapsed");
  assert.ok(text.length > 40, "the transcript in full, not windowed to the terminal");
  assert.ok(text.some((line) => line.trim() === "number 1") && text.some((line) => line.trim() === "number 40"));
  // The live lines come last: the stats line, then the picker, then the footer.
  const screen = view.text();
  const stats = screen.indexOf("running · 1m15s · 1 turn · 0 tok · $0.000 · thinking… · worker 1 of 2");
  assert.ok(stats >= 0 && stats < screen.findIndex((line) => line.startsWith(SESSION_PICKER_HINT)), "the stats line sits above the picker");
  assert.equal(screen.at(-1), "←→ worker · x stop · ctrl+o tool output · Esc back");

  for (const key of [KEY.pageUp, KEY.pageDown, KEY.home, KEY.end]) {
    view.press(key);
    assert.deepEqual(view.text(60), text, `${JSON.stringify(key)} does nothing: the terminal scrolls`);
  }
  view.requests.length = 0;
  view.press(KEY.ctrlO);
  assert.deepEqual(view.requests, [false], "a key that keeps the worker redraws without reprinting");
  view.press(KEY.ctrlO);
  view.press("x");
  assert.equal(view.text(60).at(-1), "Stop this worker? y/n");
  view.press("n");
  const redraws = view.requests.length;
  board.setOrchestratorState("running");
  assert.ok(view.requests.length > redraws, "the board's changes still redraw the view");
  assert.equal(view.closed, false);
});

test("the transcript's nested worker row is the widget's: label, tier, short rung, elapsed time and state, while the header keeps the full rung and turns", () => {
  const board = new WorkerBoard();
  running(board, "Lead", "lead-1");
  const nested = running(board, "Check budget", "nested-1", { parentDelegationId: "lead-1", label: "budget code" });
  board.setTier("nested-1", "standard");
  board.served({ delegationId: "nested-1", model: "anthropic/claude-opus-5-5", effort: "xhigh" });
  nested.fake.emit({ type: "tool_execution_start", toolCallId: "t1", toolName: "bash" });
  const view = fakeUI(10, "regular");
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  assert.match(view.text(160).find((line) => NESTED_ROW.test(line))!, /^  ○ └ budget code   standard · opus-5-5:xhigh · \d+s · running · bash$/);
  view.press(KEY.down, KEY.enter);
  const text = view.text(160);
  assert.ok(text.some((line) => line.startsWith("anthropic/claude-opus-5-5:xhigh since ")), text.join("\n"));
  assert.ok(text.some((line) => /^running · \d+s · 0 turns · /.test(line)), text.join("\n"));
  view.press(KEY.escape);
});

test("in regular tuiMode the session picker stays live below the stats line and scrolls to the selected worker", async () => {
  const board = new WorkerBoard();
  running(board, "Lead the work", "lead-1", { agent: "lead" });
  const feeds: WorkerFeed[] = [];
  for (let item = 1; item <= 8; item++) {
    feeds.push(running(board, `Nested ${item}`, `nested-${item}`, { parentDelegationId: "lead-1", label: `nested ${item}` }, [user(`Nested ${item}`), reply(`Reply ${item}`)]).feed);
  }
  const view = fakeUI(10, "regular");
  void openTranscript(view.ui, board, board.workers()[0]!.id);
  const live = () => {
    const text = view.text();
    const hint = text.findIndex((line) => line.startsWith(SESSION_PICKER_HINT));
    return { picker: text.slice(hint + 2, -1), hint: text[hint], footer: text.at(-1) };
  };

  assert.equal(live().picker.length, 7, "main stays visible above up to 6 worker rows");
  assert.equal(live().hint, `${SESSION_PICKER_HINT} · 1–6 of 9`);
  assert.match(live().picker[0]!, /^  ○ main$/);
  assert.match(live().picker[1]!, /^❯ ● lead/);
  assert.match(live().picker[2]!, /^  ○ └ nested 1/);
  assert.match(live().picker[6]!, /^  ○ └ nested 5/);
  const stats = view.text().findIndex((line) => line.startsWith("running · "));
  assert.ok(stats < view.text().findIndex((line) => line.startsWith(SESSION_PICKER_HINT)), "the stats line sits above the picker");
  assert.equal(live().footer, "←→ worker · x stop · ctrl+o tool output · Esc back");

  view.press(...Array.from({ length: 8 }, () => KEY.down));
  assert.match(live().picker[6]!, /^❯ ● └ nested 8   routing… · \d+s · running$/, "the window scrolls to keep the selected worker visible");
  assert.match(live().picker[1]!, /^  ○ └ nested 3   routing… · \d+s · running$/);
  view.press(KEY.up);
  assert.match(live().picker[6]!, /^❯ ● └ nested 7   routing… · \d+s · running$/, "the window moves with the selection");

  feeds[7]!.ended({ state: "completed" });
  view.press(KEY.down);
  assert.match(live().picker[6]!, /^❯ ● └ nested 8   routing… · \d+s · completed$/, "the list follows the board live");
  view.press(KEY.up);
  view.requests.length = 0;
  view.press(KEY.enter);
  assert.ok(view.text().some((line) => line.includes("Reply 7")), "Enter opens the selected worker in the same view");
  assert.equal(view.requests.at(-1), true, "and reprints");
  assert.match(live().picker[0]!, /^  ○ main$/, "the picker remains visible on a nested worker");
  assert.match(live().picker[6]!, /^❯ ● └ nested 7/, "the viewed worker stays selected");
  assert.equal(view.text().at(-1), "←→ worker · x stop · ctrl+o tool output · Esc back");
});

// pi-tui reprints the whole terminal when a changed line sits above the bottom
// `rows` lines. The live section and the running tool box are at the bottom of
// the view, so a 24-row terminal is the height where ordinary output must stay put.
test("regular tuiMode: ordinary live output never makes pi-tui reprint the terminal, so a scrolled-up transcript keeps its place", async () => {
  const ROWS = 24;
  const time = clock();
  const board = new WorkerBoard({ now: time.now });
  const history: Message[] = [user("Investigate the build")];
  for (let round = 1; round <= 6; round++) {
    history.push(reply(`Round ${round}.\n\n${"Checking one more file. ".repeat(8)}`, [{ id: `read-${round}`, name: "read", arguments: { path: `src/file-${round}.ts` } }]));
    history.push(toolResult(`read-${round}`, "read", `export const value${round} = ${round};\n`.repeat(3)));
  }
  const { fake } = running(board, "Investigate the build", "worker-1", { agent: "researcher", background: true }, history);
  const { steering } = fakeSteering();
  const ticks: (() => void)[] = [];
  const view = fakeUI(ROWS, "regular");
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, {
    now: time.now, steering, setInterval: (tick) => { ticks.push(tick); return ticks.length; }, clearInterval: () => {},
  });
  await settle();
  view.draw();

  const reprints: string[] = [];
  const step = (label: string, act: () => void) => {
    act();
    if (view.draw().includes("\x1b[2J")) reprints.push(label);
  };
  const long = `Looking at the build.\n\n${"More detail on the module. ".repeat(10)}`;
  const output = (lines: number) => Array.from({ length: lines }, (_, index) => `PASS case ${index + 1}`).join("\n");
  const bash = { id: "bash-1", name: "bash", arguments: { command: "npm test" } };
  const lint = { id: "bash-2", name: "bash", arguments: { command: "npm run lint" } };
  const readme = { id: "read-7", name: "read", arguments: { path: "README.md" } };
  step("a turn starts", () => fake.emit({ type: "turn_start" }));
  step("a reply starts streaming", () => fake.emit({ type: "message_start", message: reply("") }));
  step("the reply streams its first words", () => fake.emit({ type: "message_update", message: reply("Looking at") }));
  step("the reply streams more paragraphs", () => fake.emit({ type: "message_update", message: reply(long) }));
  step("the reply is saved with a tool call", () => fake.add(reply(long, [bash])));
  step("the tool starts", () => fake.emit({ type: "tool_execution_start", toolCallId: bash.id, toolName: "bash", args: bash.arguments }));
  for (let lines = 1; lines <= 31; lines += 3) {
    step(`the tool prints ${lines} lines`, () => fake.emit({ type: "tool_execution_update", toolCallId: bash.id, toolName: "bash", args: bash.arguments, partialResult: { content: [{ type: "text", text: output(lines) }] } }));
  }
  step("the tool ends", () => fake.emit({ type: "tool_execution_end", toolCallId: bash.id, toolName: "bash", result: { content: [{ type: "text", text: output(31) }] }, isError: false }));
  step("its result is saved", () => fake.add(toolResult(bash.id, "bash", output(31))));
  step("a reply calls two tools at once", () => fake.add(reply("Two checks at once", [lint, readme])));
  step("the lint starts", () => fake.emit({ type: "tool_execution_start", toolCallId: lint.id, toolName: "bash", args: lint.arguments }));
  step("the readme starts", () => fake.emit({ type: "tool_execution_start", toolCallId: readme.id, toolName: "read", args: readme.arguments }));
  for (let lines = 1; lines <= 13; lines += 3) {
    step(`the lint prints ${lines} lines`, () => fake.emit({ type: "tool_execution_update", toolCallId: lint.id, toolName: "bash", args: lint.arguments, partialResult: { content: [{ type: "text", text: output(lines) }] } }));
  }
  step("the readme ends first", () => fake.emit({ type: "tool_execution_end", toolCallId: readme.id, toolName: "read", result: { content: [{ type: "text", text: "# Readme" }] }, isError: false }));
  step("the readme result is saved", () => fake.add(toolResult(readme.id, "read", "# Readme")));
  step("the lint ends", () => fake.emit({ type: "tool_execution_end", toolCallId: lint.id, toolName: "bash", result: { content: [{ type: "text", text: output(13) }] }, isError: false }));
  step("the lint result is saved", () => fake.add(toolResult(lint.id, "bash", output(13))));
  step("the next reply streams", () => fake.emit({ type: "message_start", message: reply("") }));
  step("the next reply streams its text", () => fake.emit({ type: "message_update", message: reply("Both checks are in.") }));
  step("the next reply is saved", () => fake.add(reply("Both checks are in.")));
  step("a timer tick redraws", () => ticks.at(-1)?.());
  step("the orchestrator starts running", () => board.setOrchestratorState("running"));

  assert.deepEqual(reprints, [], "pi-tui reprinted the terminal during these steps");
  view.press(KEY.escape);
  assert.equal(await shown, "back");
  view.stop();
});

test("regular tuiMode: a tool call that finishes with more output than the terminal shows does not reprint the terminal", async () => {
  for (const rows of [24, 40]) {
    const time = clock();
    const board = new WorkerBoard({ now: time.now });
    const history: Message[] = [user("Build the project")];
    for (let round = 1; round <= 8; round++) {
      history.push(reply(`Round ${round}.\n\n${"Checking one more file. ".repeat(8)}`, [{ id: `read-${round}`, name: "read", arguments: { path: `src/file-${round}.ts` } }]));
      history.push(toolResult(`read-${round}`, "read", `export const value${round} = ${round};\n`.repeat(3)));
    }
    const { fake } = running(board, "Build the project", "worker-1", { agent: "builder", background: true }, history);
    const { steering } = fakeSteering();
    const view = fakeUI(rows, "regular");
    const shown = openTranscript(view.ui, board, board.workers()[0]!.id, {
      now: time.now, steering, expanded: true, setInterval: () => 0, clearInterval: () => {},
    });
    await settle();
    view.draw();

    const reprints: string[] = [];
    const step = (label: string, act: () => void) => {
      act();
      if (view.draw().includes("\x1b[2J")) reprints.push(label);
    };
    const log = (lines: number) => Array.from({ length: lines }, (_, index) => `build line ${index + 1}`).join("\n");
    const build = { id: "bash-1", name: "bash", arguments: { command: "npm run build" } };
    step("the build is called", () => fake.add(reply("Building", [build])));
    step("the build starts", () => fake.emit({ type: "tool_execution_start", toolCallId: build.id, toolName: "bash", args: build.arguments }));
    for (const lines of [5, 15, 30, 45, 60]) {
      step(`the build prints ${lines} lines`, () => fake.emit({ type: "tool_execution_update", toolCallId: build.id, toolName: "bash", args: build.arguments, partialResult: { content: [{ type: "text", text: log(lines) }] } }));
    }
    step("the build ends", () => fake.emit({ type: "tool_execution_end", toolCallId: build.id, toolName: "bash", result: { content: [{ type: "text", text: log(60) }] }, isError: false }));
    step("its result is saved", () => fake.add(toolResult(build.id, "bash", log(60))));
    step("the next reply is saved", () => fake.add(reply("The build passed")));

    assert.deepEqual(reprints, [], `rows ${rows}: pi-tui reprinted the terminal during these steps`);
    view.press(KEY.escape);
    assert.equal(await shown, "back");
    view.stop();
  }
});

test("the header's token counts and cost read short, and a count never rounds up past its unit", () => {
  assert.deepEqual([999, 1_000, 12_345, 99_949, 99_950, 999_499, 999_500, 1_234_567].map(formatTokens),
    ["999", "1.0k", "12.3k", "99.9k", "100k", "999k", "1.0M", "1.2M"]);
  assert.deepEqual([0, 0.0421, 1.5].map(formatCost), ["$0.000", "$0.042", "$1.500"]);
});

// The message input (bean mj35): a fake WorkerSteering stands in for the
// subagents extension's (user-steering.ts), so these tests see what the view
// sends and when it shows the input; extension.test.ts follows a message to a
// real worker and the orchestrator.

/** A steering that takes messages for running background workers, records
 *  what the view sends, and fails a send while `refuse` holds a reason. */
function fakeSteering() {
  const sent: { workerId: string; text: string; mode: string }[] = [];
  const steering = {
    refuse: undefined as string | undefined,
    accepts: (worker: BoardWorker) => worker.background && (worker.state === "running" || worker.state === "asking"),
    async send(worker: BoardWorker, text: string, mode: "steer" | "followUp") {
      if (steering.refuse !== undefined) throw new Error(steering.refuse);
      sent.push({ workerId: worker.id, text, mode });
    },
    sentByUser: (_worker: BoardWorker, text: string) => sent.some((message) => message.text === text),
  };
  return { steering, sent };
}

const ALT_ENTER = "\x1b\r";
const TAB = "\t";
const INPUT_HINT = "Tab to message this worker";

/** Presses each character of `text`, as the terminal sends typing. */
const typed = (text: string) => [...text];

test("the message input shows only while the worker takes messages: not for a foreground, queued or finished worker", async () => {
  const board = new WorkerBoard();
  const { feed } = running(board, "Background job", "worker-1", { background: true });
  running(board, "Foreground job", "worker-2");
  board.add({ callId: "call-1", background: true, task: "Waits its turn", model: { kind: "routed" } });
  const { steering } = fakeSteering();
  const view = fakeUI(30);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  const footer = () => view.text().at(-1)!;

  assert.ok(view.text().includes(INPUT_HINT), view.text().join("\n"));
  assert.match(footer(), /Tab message/);
  for (const worker of ["foreground", "queued"]) {
    view.press(KEY.right);
    assert.ok(!view.text().includes(INPUT_HINT), `no input for a ${worker} worker`);
    assert.doesNotMatch(footer(), /Tab message/);
    view.press(TAB);
    assert.doesNotMatch(footer(), /Enter steer/, `Tab does nothing for a ${worker} worker`);
  }
  view.press(KEY.left, KEY.left);
  assert.ok(view.text().includes(INPUT_HINT));
  feed.ended({ state: "completed", sessionFile: "/nowhere/worker-1.jsonl" });
  assert.ok(!view.text().includes(INPUT_HINT), "a finished worker's input is gone");
  view.press(KEY.escape);
  assert.equal(await shown, "back");
});

test("Tab gives the input the keys: Enter sends a steer, alt+enter a follow-up, x types, and Esc gives the keys back without closing", async () => {
  const board = new WorkerBoard();
  running(board, "Background job", "worker-1", { background: true });
  const { steering, sent } = fakeSteering();
  const view = fakeUI(30);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  const footer = () => view.text().at(-1)!;

  view.press(TAB);
  assert.equal(footer(), "Enter steer · alt+enter follow-up · shift+enter new line · Esc done typing");
  view.press(...typed("fix x first"));
  assert.ok(view.text().some((line) => line.includes("fix x first")), "the editor shows the draft, x included");
  assert.notEqual(footer(), "Stop this worker? y/n", "x is typed, not a stop");
  view.press(KEY.enter);
  assert.deepEqual(sent, [{ workerId: board.workers()[0]!.id, text: "fix x first", mode: "steer" }]);
  await settle();
  assert.equal(footer(), "Sent steer to this worker; the orchestrator is told.");
  assert.ok(!view.text().some((line) => line.includes("fix x first")), "the input is empty after sending");

  view.press(...typed("then the docs"), ALT_ENTER);
  assert.deepEqual(sent.at(-1), { workerId: board.workers()[0]!.id, text: "then the docs", mode: "followUp" });
  await settle();
  assert.equal(footer(), "Sent follow-up to this worker; the orchestrator is told.");
  view.press(KEY.enter);
  assert.equal(sent.length, 2, "an empty input sends nothing");

  view.press(...typed("half a thought"), KEY.escape);
  assert.equal(view.closed, false, "Esc while typing keeps the view open");
  assert.match(footer(), /Tab message/, "and gives the keys back");
  assert.ok(view.text().includes("half a thought"), "the draft stays in the input");
  view.press(KEY.left);
  assert.equal(view.closed, false);
  view.press(TAB, KEY.enter);
  assert.equal(sent.at(-1)?.text, "half a thought", "Tab again goes on with the draft");
  view.press(KEY.escape, KEY.escape);
  assert.equal(await shown, "back", "Esc with the keys back leaves, as before");
});

test("a message the steering refuses comes back to the input with why; a worker that ends while typing gives the keys back", async () => {
  const board = new WorkerBoard();
  const { feed } = running(board, "Background job", "worker-1", { background: true });
  const { steering, sent } = fakeSteering();
  const view = fakeUI(30);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  const footer = () => view.text().at(-1)!;

  steering.refuse = "subagents_message: no running background worker has the delegation id worker-1";
  view.press(TAB, ...typed("too late"), KEY.enter);
  await settle();
  assert.equal(footer(), "Not sent: subagents_message: no running background worker has the delegation id worker-1");
  assert.ok(view.text().some((line) => line.includes("too late")), "the draft is back in the input");
  assert.equal(sent.length, 0);

  feed.ended({ state: "aborted" });
  assert.equal(footer(), "This worker no longer takes messages; the draft was not sent.");
  assert.ok(!view.text().some((line) => line.includes("too late")), "no input once it ended");
  view.press(KEY.escape);
  assert.equal(await shown, "back", "the keys are the view's again: Esc leaves");
});

test("an asking worker's input answers its question, and the transcript marks the user's steers as the user's", async () => {
  const board = new WorkerBoard();
  const { fake } = running(board, "Read the notes", "worker-1", { background: true }, [
    user("Read the notes"),
    reply("Reading", [{ id: "call-1", name: "read", arguments: { path: "notes.md" } }]),
    toolResult("call-1", "read", "first note"),
    user("From the orchestrator"),
  ]);
  const { steering } = fakeSteering();
  const view = fakeUI(60);
  const shown = openTranscript(view.ui, board, board.workers()[0]!.id, { steering });
  const footer = () => view.text().at(-1)!;
  const marks = () => view.text().map((line) => line.trim()).filter((line) => line.startsWith("▸"));

  board.asking("worker-1", true);
  view.press(TAB);
  assert.equal(footer(), "Enter answer its question · shift+enter new line · Esc done typing");
  view.press(...typed("From the user"), KEY.enter);
  await settle();
  assert.equal(footer(), "Sent answer to this worker; the orchestrator is told.");
  board.asking("worker-1", false);
  fake.add(reply("Checking", [{ id: "call-2", name: "read", arguments: { path: "todo.md" } }]));
  fake.add(toolResult("call-2", "read", "todo"));
  fake.add(user("From the user"));
  assert.deepEqual(marks(), ["▸ Steer from the orchestrator", "▸ Steer from the user"]);
  view.press(KEY.escape, KEY.escape);
  await shown;
});
