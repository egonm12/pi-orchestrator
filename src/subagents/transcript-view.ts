import { getSelectListTheme, truncateToVisualLines, type AgentSessionEvent, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type TUI } from "@earendil-works/pi-tui";
import type { BackgroundMessageMode } from "./background.ts";
import { readWorkerTranscript, Transcript, type TranscriptContext } from "./transcript.ts";
import { liveStats, orchestratorBar, transcriptHeader, transcriptTop } from "./transcript-header.ts";
import { hasEnded, type BoardWorker, type OrchestratorState, type WorkerBoard, type WorkerBoardView } from "./worker-board.ts";
import { sessionPickerIndex, sessionPickerLines, sessionPickerWorkerId, STATE_COLOR, widgetWorkers, workerRows } from "./worker-widget.ts";
import type { WorkerSteering } from "./user-steering.ts";

// The transcript view (epic a338): one worker's transcript on the whole
// screen, read from the worker board. It is a full-screen overlay through
// ctx.ui.custom, the mechanism the rcjm spike chose: pi-tui composites it
// over the whole viewport in both tuiModes, never writes to the scrollback and
// never touches the editor, so closing it leaves the orchestrator's session as
// it was. A running worker's transcript is live; a finished one's comes from
// its session file. It sends a worker two things: the x stop, after a
// confirmation, and the user's own messages to a running background worker,
// typed in an input like pi's editor at the bottom (bean mj35). Tab gives the
// input the keys and Esc gives them back, so every other key of the view
// keeps its meaning. A message goes the way subagents_message sends one, and
// the orchestrator is told of it (user-steering.ts). The view never closes on
// its own, so a worker that finishes stays open with its end state.
//
// Keys are matched through the keybindings manager pi hands the factory,
// never as raw bytes: pi turns on the kitty keyboard protocol, so Esc arrives
// as `\x1b[27u`, and an overlay that missed Esc and ctrl+c would trap the user
// (rcjm's first live try).
//
// The view is drawn in slots, top to bottom: a bar, the header, the main-plus-workers
// picker, the transcript and a footer. They make three parts (head, body and
// live lines) that a layout arranges. The header and the bar are options
// (TranscriptSlot), drawn by transcript-header.ts by default. The bar
// only tells: an asking worker or an idle orchestrator never closes the view,
// moves it or takes a key, so the user leaves when they choose to.

/** The overlay covers the whole terminal. */
export const TRANSCRIPT_OVERLAY = { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } as const;

/** In regular tuiMode the overlay pi mounts only takes the keys: the view
 *  itself is in pi's root, in place of pi's view (ADR 0009). */
export const KEYS_OVERLAY = { width: 1, maxHeight: 1, anchor: "bottom-left", margin: 0 } as const;

/** What the view needs of pi's TUI: its tuiMode, the terminal's height, read
 *  on every render so a resize redraws at the new size, and a redraw request,
 *  forced to reprint the whole terminal. A TUI that names no tuiMode gets the overlay. */
export interface TranscriptViewTui {
  readonly mode?: "regular" | "fullscreen";
  requestRender(force?: boolean): void;
  readonly terminal: { readonly rows: number };
}

/** The part of pi's keybindings manager the view uses. */
export interface TranscriptKeys {
  matches(data: string, keybinding: string): boolean;
}

/** The board as the transcript view reads it, and the one thing it may do to a worker: stop it. */
export type TranscriptBoard = WorkerBoardView & Pick<WorkerBoard, "stop">;

/** What a slot draws from. */
export interface TranscriptFrame {
  readonly worker: BoardWorker;
  /** The board's workers, in its order: a nested worker's parent, the workers asking. */
  readonly workers: readonly BoardWorker[];
  /** The worker's place among the board's workers, from 1; 0 once it is no longer on the board. */
  readonly position: number;
  readonly count: number;
  readonly orchestrator: OrchestratorState;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly theme: Theme;
  readonly width: number;
}

/** A slot's lines; the view cuts each to the width. */
export type TranscriptSlot = (frame: TranscriptFrame) => readonly string[];

/** Where the overlay's window on the body is, for the live lines' hint. */
export interface BodyWindow {
  readonly following: boolean;
  /** The first body line shown, from 0. */
  readonly top: number;
  readonly length: number;
}

/** The view's parts, built apart from how a layout arranges them (s993): the
 *  head (the bar, the header and the session picker), the body (the transcript
 *  with its notices and end state) and the live lines (the picker in regular
 *  tuiMode, stats and the footer). The live lines take the body's window when
 *  a layout windows it; their count never depends on it, so a layout can size
 *  the window by them. */
export interface TranscriptParts {
  readonly head: readonly string[];
  readonly body: readonly string[];
  readonly live: (window?: BodyWindow) => readonly string[];
}

export type TranscriptViewExit = "back" | "main";

export interface TranscriptViewOptions {
  /** The workers' working directory, for the built-in tools' paths. Default: the process's. */
  readonly cwd?: string;
  /** The overlay's header. Default: transcriptHeader (transcript-header.ts). */
  readonly header?: TranscriptSlot;
  /** A bar above the header. Default: orchestratorBar (transcript-header.ts). */
  readonly bar?: TranscriptSlot;
  /** Whether tool output starts expanded. */
  readonly expanded?: boolean;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  /** Reads a finished worker's messages from its session file. Default: readWorkerTranscript. */
  readonly readSession?: (file: string) => readonly unknown[];
  /** Lets the user message a running background worker. Without it the view has no input. */
  readonly steering?: WorkerSteering;
  /** The redraw timer, for the elapsed time. Default: an unref'd setInterval, so an open view never keeps pi's process alive. */
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** How often an open view redraws, for the elapsed time. */
const TICK_MS = 1_000;

const SEPARATOR = " · ";
/** pi marks user messages for terminal prompt navigation; an overlay is no prompt. */
const PROMPT_MARKS = /\x1b\]133;[A-D]\x07/g;

/** `line` cut to `width` columns. Components wrap to the width already;
 *  slots and marks may not, and pi-tui refuses a line wider than the terminal. */
function fit(line: string, width: number): string {
  return truncateToVisualLines(line.replace(PROMPT_MARKS, ""), Number.POSITIVE_INFINITY, width).visualLines[0] ?? "";
}

/** A plain printable key, `x` or `y`, as the terminal sends it: as itself, or
 *  as a kitty CSI-u sequence without modifiers. */
function printable(data: string): string | undefined {
  if (data.length === 1) return data;
  const code = /^\x1b\[(\d+)(?::\d*)?(?::\d*)?(?:;1(?::1)?)?u$/.exec(data)?.[1];
  return code === undefined ? undefined : String.fromCodePoint(Number(code));
}

/** Where the shown worker's transcript comes from. */
type Source =
  /** Its running session, followed as it goes. */
  | { readonly kind: "live"; readonly messages: () => readonly unknown[]; readonly unsubscribe: () => void }
  /** Read once: from its session file, the board's copy of an unsaved one, or its live session after it ended. */
  | { readonly kind: "read" }
  /** Nothing yet (queued or starting), or nothing to read. */
  | { readonly kind: "none"; readonly notice?: string };

export class TranscriptView {
  readonly #tui: TranscriptViewTui;
  readonly #theme: Theme;
  readonly #keys: TranscriptKeys;
  readonly #board: TranscriptBoard;
  readonly #close: (exit: TranscriptViewExit) => void;
  readonly #options: TranscriptViewOptions;
  readonly #now: () => number;
  readonly #unsubscribeBoard: () => void;
  readonly #stopTimer: () => void;
  readonly #steering: WorkerSteering | undefined;
  #worker!: BoardWorker;
  #transcript: Transcript | undefined;
  #source: Source = { kind: "none" };
  #expanded: boolean;
  /** Follow the end of the transcript, until the user scrolls. */
  #following = true;
  /** The first transcript line shown while scrolled. */
  #top = 0;
  /** The transcript's height and length at the last render, for the scroll keys. */
  #bodyHeight = 1;
  #bodyLength = 0;
  /** The session row selected in the main-plus-workers picker. */
  #selectedSessionId: string | undefined;
  #confirming = false;
  /** A one-off line in the footer, until the next key. */
  #flash: string | undefined;
  #disposed = false;
  /** Regular tuiMode: the view is in pi's root and the terminal scrolls it. */
  readonly #regular: boolean;
  /** The next redraw reprints the whole terminal, as after a switch of worker in regular tuiMode. */
  #reprint = false;
  /** The message input, pi-tui's editor, made the first time it is shown. */
  #input: Editor | undefined;
  /** The input has the keys: Tab gives them to it, Esc or Tab gives them back. */
  #typing = false;

  constructor(tui: TranscriptViewTui, theme: Theme, keys: TranscriptKeys, board: TranscriptBoard, workerId: string, close: (exit: TranscriptViewExit) => void, options: TranscriptViewOptions = {}) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keys = keys;
    this.#board = board;
    this.#close = close;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#expanded = options.expanded ?? false;
    this.#steering = options.steering;
    this.#regular = tui.mode === "regular";
    const worker = board.worker(workerId);
    if (worker === undefined) throw new Error(`No worker on the board has the id ${workerId}`);
    this.#show(worker);
    // Opening reprints through the root swap already.
    this.#reprint = false;
    this.#unsubscribeBoard = board.subscribe(() => this.#boardChanged());
    // The board signals changes, not time passing: without it a running worker's elapsed time would stand still.
    const timer = (options.setInterval ?? ((tick, ms) => setInterval(tick, ms).unref()))(() => this.#tui.requestRender(), TICK_MS);
    const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    this.#stopTimer = () => clearTimer(timer);
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    if (this.#confirming) {
      this.#confirming = false;
      // Any other key, Esc included, keeps the worker running and the view open.
      if (printable(data)?.toLowerCase() === "y") {
        this.#flash = this.#board.stop(this.#worker.id) ? "Stopping this worker." : "This worker can no longer be stopped.";
      }
      return this.#tui.requestRender();
    }
    this.#flash = undefined;
    if (this.#typing) return this.#type(data);
    const keys = this.#keys;
    if (keys.matches(data, "tui.select.cancel")) return this.#leave();
    if (keys.matches(data, "tui.input.tab") && this.#accepts()) this.#typing = true;
    else if (keys.matches(data, "tui.editor.cursorLeft")) this.#step(-1);
    else if (keys.matches(data, "tui.editor.cursorRight")) this.#step(1);
    else if (keys.matches(data, "app.tools.expand")) this.#transcript?.setExpanded(this.#expanded = !this.#expanded);
    else if (printable(data)?.toLowerCase() === "x") this.#askStop();
    else if (keys.matches(data, "tui.select.up")) this.#moveSession(-1);
    else if (keys.matches(data, "tui.select.down")) this.#moveSession(1);
    else if (keys.matches(data, "tui.select.confirm")) {
      if (this.#selectedSessionId === undefined) return this.#leave("main");
      this.#openSelectedSession();
    }
    // In regular tuiMode the terminal scrolls the view: the scroll keys are the overlay's alone.
    else if (this.#regular) return;
    else if (keys.matches(data, "tui.select.pageUp")) this.#scrollTo(this.#currentTop() - this.#bodyHeight);
    else if (keys.matches(data, "tui.select.pageDown")) this.#scrollTo(this.#currentTop() + this.#bodyHeight);
    else if (keys.matches(data, "tui.editor.cursorLineStart")) this.#scrollTo(0, true);
    else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.#following = true;
    else return;
    this.#redraw();
  }

  /** A key while the input has the keys. Esc, ctrl+c and Tab give them back
   *  to the view, keeping the draft; ctrl+o still toggles tool output. Enter
   *  sends the draft as a steer and pi's follow-up key (alt+enter) as a
   *  follow-up; every other key edits. */
  #type(data: string): void {
    const keys = this.#keys;
    const input = this.#inputEditor();
    if (keys.matches(data, "tui.select.cancel") || keys.matches(data, "tui.input.tab")) this.#typing = false;
    else if (keys.matches(data, "app.tools.expand")) this.#transcript?.setExpanded(this.#expanded = !this.#expanded);
    else if (keys.matches(data, "app.message.followUp")) {
      const text = input.getExpandedText().trim();
      input.setText("");
      this.#send(text, "followUp");
    }
    // Enter reaches onSubmit, which sends a steer.
    else input.handleInput(data);
    this.#tui.requestRender();
  }

  /** Whether the shown worker takes the user's messages now. */
  #accepts(): boolean {
    return this.#steering?.accepts(this.#worker) === true;
  }

  /** The input, made once, styled as pi's own editor. */
  #inputEditor(): Editor {
    if (this.#input !== undefined) return this.#input;
    const theme = this.#theme;
    const input = new Editor(this.#tui as unknown as TUI, { borderColor: (text) => theme.fg("borderMuted", text), selectList: getSelectListTheme() });
    input.onSubmit = (text) => this.#send(text, "steer");
    return this.#input = input;
  }

  /** Sends the user's `text` to the shown worker. The draft comes back when it is not sent. */
  #send(text: string, mode: BackgroundMessageMode): void {
    const steering = this.#steering;
    if (text === "" || steering === undefined) return;
    const worker = this.#worker;
    const kind = worker.state === "asking" ? "answer" : mode === "steer" ? "steer" : "follow-up";
    this.#flash = `Sending ${kind}…`;
    steering.send(worker, text, mode).then(() => {
      this.#input?.addToHistory(text);
      if (this.#worker.id === worker.id) this.#flash = `Sent ${kind} to this worker; the orchestrator is told.`;
    }, (error: unknown) => {
      if (this.#input !== undefined && this.#input.getText() === "" && this.#worker.id === worker.id) this.#input.setText(text);
      this.#flash = `Not sent: ${error instanceof Error ? error.message : String(error)}`;
    }).finally(() => { if (!this.#disposed) this.#tui.requestRender(); });
  }

  #askStop(): void {
    if (hasEnded(this.#worker)) this.#flash = "This worker has already finished.";
    else this.#confirming = true;
  }

  /** Asks for a redraw, reprinting the terminal when a switch of worker needs it. */
  #redraw(): void {
    const reprint = this.#reprint;
    this.#reprint = false;
    this.#tui.requestRender(reprint);
  }

  render(width: number): string[] {
    const parts = this.#parts(width);
    return this.#regular ? this.#regularLayout(parts, width) : this.#overlayLayout(parts, width);
  }

  /** The view's parts at `width`. In regular tuiMode the top is printed once
   *  and scrolls away, so everything live goes to the end. */
  #parts(width: number): TranscriptParts {
    const workers = this.#board.workers();
    const index = workers.findIndex((worker) => worker.id === this.#worker.id);
    const frame: TranscriptFrame = { worker: this.#worker, workers, position: index + 1, count: workers.length,
      orchestrator: this.#board.orchestratorState(), now: this.#now(), theme: this.#theme, width };
    const bar = (this.#options.bar ?? orchestratorBar)(frame);
    if (this.#regular) {
      // The session picker stays just above the stats line while regular tuiMode scrolls the body.
      return { head: transcriptTop(frame), body: this.#body(width),
        live: () => [...this.#sessionPickerLines(frame), ...liveStats(frame), ...bar, ...this.#inputLines(width), this.#footer(undefined)] };
    }
    const head = [...bar, ...(this.#options.header ?? transcriptHeader)(frame),
      ...(!this.#expanded ? this.#transcript?.renderTask(width) ?? [] : []), ...this.#sessionPickerLines(frame)];
    return { head, body: this.#body(width, this.#expanded), live: (window) => [...this.#inputLines(width), this.#footer(window)] };
  }

  /** Regular tuiMode's arrangement: the top, the whole transcript and the
   *  live lines, as one tall component the terminal scrolls. */
  #regularLayout(parts: TranscriptParts, width: number): string[] {
    const rule = this.#theme.fg("dim", "─".repeat(width));
    return [...parts.head, rule, ...parts.body, rule, ...parts.live()].map((line) => fit(line, width));
  }

  /** The overlay's arrangement: the head pinned at the top above a rule, the
   *  body windowed and scrolled to fill the terminal, the live lines at the bottom. */
  #overlayLayout(parts: TranscriptParts, width: number): string[] {
    const rows = Math.max(1, this.#tui.terminal.rows);
    const top = [...parts.head, this.#theme.fg("dim", "─".repeat(width))];
    // The live lines' count sizes the window; their text needs the window's top, known only after.
    const height = Math.max(1, rows - top.length - parts.live().length);
    this.#bodyHeight = height;
    this.#bodyLength = parts.body.length;
    const shownTop = this.#currentTop();
    if (!this.#following) this.#top = shownTop;
    const shown = parts.body.slice(shownTop, shownTop + height);
    const padding = Array.from({ length: height - shown.length }, () => "");
    const bottom = parts.live({ following: this.#following, top: shownTop, length: parts.body.length });
    return [...top, ...shown, ...padding, ...bottom].slice(0, rows).map((line) => fit(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopTimer();
    this.#unsubscribeBoard();
    this.#detach();
  }

  #leave(exit: TranscriptViewExit = "back"): void {
    this.dispose();
    this.#close(exit);
  }

  /** The first transcript line to show: the last page while following. */
  #currentTop(): number {
    const last = Math.max(0, this.#bodyLength - this.#bodyHeight);
    return this.#following ? last : Math.min(this.#top, last);
  }

  /** Scrolls to `top`; reaching the end follows it again, unless `hold` keeps it put. */
  #scrollTo(top: number, hold = false): void {
    const last = Math.max(0, this.#bodyLength - this.#bodyHeight);
    this.#top = Math.max(0, Math.min(top, last));
    this.#following = !hold && this.#top >= last;
  }

  #show(worker: BoardWorker): void {
    this.#detach();
    this.#worker = worker;
    this.#selectedSessionId = worker.id;
    this.#following = true;
    this.#top = 0;
    this.#confirming = false;
    // A draft is for the worker it was typed to.
    this.#typing = false;
    this.#input?.setText("");
    // A new transcript in pi's root differs from its first line on: reprint, landing at the bottom.
    this.#reprint = this.#regular;
    this.#attach();
  }

  /** Finds the shown worker's transcript: its live session, or once it has
   *  ended its session file or the board's copy of an unsaved session. */
  #attach(): void {
    const worker = this.#worker;
    const live = this.#board.live(worker.id);
    const transcript = this.#transcript = new Transcript(this.#context(live?.toolDefinition));
    if (live !== undefined) {
      const onEvent = (event: AgentSessionEvent) => {
        transcript.event(event);
        transcript.update(live.messages());
        this.#tui.requestRender();
      };
      this.#source = { kind: "live", messages: live.messages, unsubscribe: live.subscribe(onEvent) };
      transcript.update(live.messages());
      return;
    }
    if (!hasEnded(worker)) {
      this.#source = { kind: "none", notice: worker.state === "queued" ? "The worker is queued: it starts when a parallel slot frees." : "The worker is starting." };
      return;
    }
    const unsaved = this.#board.unsavedMessages(worker.id);
    if (unsaved !== undefined) {
      transcript.update(unsaved);
      this.#source = { kind: "read" };
    } else if (worker.sessionFile !== undefined) {
      try {
        transcript.update((this.#options.readSession ?? readWorkerTranscript)(worker.sessionFile));
        this.#source = { kind: "read" };
      } catch (error) {
        this.#source = { kind: "none", notice: `The transcript could not be read from ${worker.sessionFile}: ${error instanceof Error ? error.message : String(error)}` };
      }
    } else {
      this.#source = { kind: "none", notice: worker.startedAt === undefined ? "The worker never started." : "The worker's session was not saved." };
    }
  }

  #context(toolDefinition: TranscriptContext["toolDefinition"]): TranscriptContext {
    const worker = this.#worker;
    // Every run of the delegation on the board: a resume is a new entry with the same delegation id.
    const tasks = worker.delegationId === undefined ? [worker.task]
      : this.#board.workers().filter((other) => other.delegationId === worker.delegationId).map((other) => other.task);
    const steering = this.#steering;
    return { tui: this.#tui, theme: this.#theme, cwd: this.#options.cwd ?? process.cwd(), tasks, expanded: this.#expanded,
      ...(toolDefinition === undefined ? {} : { toolDefinition }),
      ...(steering === undefined ? {} : { sentByUser: (text: string) => steering.sentByUser(worker, text) }) };
  }

  /** Stops following the shown worker and lets its transcript go. */
  #detach(): void {
    if (this.#source.kind === "live") this.#source.unsubscribe();
    this.#source = { kind: "none" };
    this.#transcript?.dispose();
  }

  #boardChanged(): void {
    const current = this.#board.worker(this.#worker.id);
    // A new orchestrator session empties the board; the view keeps what it showed.
    if (current !== undefined) {
      const was = this.#worker;
      this.#worker = current;
      if (this.#source.kind === "live" && hasEnded(current)) {
        // The live transcript is complete now; keep it rather than rebuild it from the file.
        const { messages } = this.#source;
        this.#source.unsubscribe();
        this.#transcript?.update(messages());
        this.#source = { kind: "read" };
      } else if (this.#source.kind === "none" && (this.#board.live(current.id) !== undefined || (hasEnded(current) && !hasEnded(was)))) {
        this.#attach();
      }
      if (this.#typing && !this.#accepts()) {
        this.#typing = false;
        if (this.#input?.getText().trim()) this.#flash = "This worker no longer takes messages; the draft was not sent.";
      }
    }
    this.#tui.requestRender();
  }

  /** The workers the main view's widget lists (widgetWorkers), plus the viewed
   *  and the selected worker whatever their state, and the viewed worker if a
   *  new session cleared the board. Left and right still step through every worker. */
  #sessionRows() {
    const workers = [...this.#board.workers()];
    if (!workers.some((worker) => worker.id === this.#worker.id)) workers.push(this.#worker);
    return workerRows(widgetWorkers(workers, this.#now(), [this.#worker.id, this.#selectedSessionId]));
  }

  /** The main session and every worker, with the viewed or selected row highlighted. */
  #sessionPickerLines(frame: TranscriptFrame): string[] {
    const rows = this.#sessionRows();
    return sessionPickerLines(rows, sessionPickerIndex(rows, this.#selectedSessionId), frame.now, this.#theme, frame.width);
  }

  #moveSession(step: -1 | 1): void {
    const rows = this.#sessionRows();
    const current = sessionPickerIndex(rows, this.#selectedSessionId);
    const next = Math.max(0, Math.min(rows.length, current + step));
    this.#selectedSessionId = sessionPickerWorkerId(rows, next);
  }

  #openSelectedSession(): void {
    const target = this.#sessionRows().find((row) => row.worker.id === this.#selectedSessionId)?.worker;
    if (target !== undefined) this.#show(target);
  }

  /** Left and right: the previous or next worker in the board's order. */
  #step(step: -1 | 1): void {
    const workers = this.#board.workers();
    const index = workers.findIndex((worker) => worker.id === this.#worker.id);
    const target = index < 0 ? (step > 0 ? workers[0] : workers.at(-1)) : workers[index + step];
    if (target !== undefined) this.#show(target);
  }

  /** The transcript, or a notice when there is none yet, and a finished worker's end state. */
  #body(width: number, includeTask = true): string[] {
    const theme = this.#theme;
    const worker = this.#worker;
    const lines = this.#transcript?.render(width, includeTask) ?? [];
    // Wrapped, not cut: `fit` keeps only a line's first row, and a notice's
    // path or an error is often wider than the screen.
    const wrapped = (text: string) => truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines;
    if (this.#source.kind === "none" && this.#source.notice !== undefined) lines.push("", ...wrapped(theme.fg("muted", this.#source.notice)));
    if (lines.length === 0 && !hasEnded(worker)) lines.push("", theme.fg("muted", "No messages yet."));
    if (hasEnded(worker)) {
      const end = worker.state === "failed" ? `The worker failed${worker.error === undefined ? "." : `: ${worker.error}`}` : `The worker ${worker.state === "aborted" ? "was aborted" : "completed"}.`;
      lines.push("", ...wrapped(theme.fg(STATE_COLOR[worker.state], end)));
    }
    return lines;
  }

  /** The message input while the shown worker takes messages: pi's editor
   *  while it has the keys, else its frame with the draft or a hint. */
  #inputLines(width: number): string[] {
    if (!this.#accepts()) return [];
    if (this.#typing) return this.#inputEditor().render(width);
    const theme = this.#theme;
    const rule = theme.fg("borderMuted", "─".repeat(width));
    const [first = "", ...more] = (this.#input?.getText() ?? "").split("\n");
    const shown = first === "" && more.length === 0 ? theme.fg("dim", "Tab to message this worker")
      : theme.fg("muted", `${first}${more.length > 0 ? " …" : ""}`);
    return [rule, shown, rule];
  }

  #footer(window: BodyWindow | undefined): string {
    const theme = this.#theme;
    if (this.#confirming) return theme.fg("warning", "Stop this worker? y/n");
    if (this.#flash !== undefined) return theme.fg("muted", this.#flash);
    if (this.#typing) {
      const send = this.#worker.state === "asking" ? ["Enter answer its question"] : ["Enter steer", "alt+enter follow-up"];
      return theme.fg("dim", [...send, "shift+enter new line", "Esc done typing"].join(SEPARATOR));
    }
    const stop = hasEnded(this.#worker) ? [] : ["x stop"];
    const message = this.#accepts() ? ["Tab message"] : [];
    if (this.#regular) return theme.fg("dim", ["←→ worker", ...message, ...stop, "ctrl+o tool output", "Esc back"].join(SEPARATOR));
    const where = window === undefined || window.following ? "following" : `line ${window.top + 1} of ${window.length}, End follows`;
    const hints = [where, "←→ worker", "PgUp PgDn Home End scroll", ...message, ...stop, "ctrl+o tool output", "Esc back"];
    return theme.fg("dim", hints.join(SEPARATOR));
  }
}

/** The part of pi's UI openTranscript uses. */
export type TranscriptUI = Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "getToolsExpanded">>;

/** The part of pi-tui's TUI the root swap uses: its root's children. */
interface RootTui {
  readonly children: readonly unknown[];
  clear(): void;
  addChild(component: never): void;
  requestRender(force?: boolean): void;
}

/** Puts `view` in place of everything in pi's root and reprints; the
 *  returned function puts pi's tree back, once (spike jjem, ADR 0009). */
function swapRoot(root: RootTui, view: unknown): () => void {
  const saved = [...root.children];
  root.clear();
  root.addChild(view as never);
  root.requestRender(true);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    root.clear();
    for (const child of saved) root.addChild(child as never);
    root.requestRender(true);
  };
}

/** Shows the worker `workerId` of `board` until the user leaves with Esc or
 *  ctrl+c, or selects main and presses Enter. The result distinguishes those
 *  exits so the widget browser can return directly to the editor. Tool
 *  output starts expanded as the orchestrator's is. Throws when no worker on
 *  the board has the id.
 *
 *  Only the TUI pi hands the factory tells the tuiMode, and pi takes the
 *  overlay choice before it, so the view always opens as an overlay; its
 *  options are read after the factory. In fullscreen tuiMode the view is the
 *  full-screen overlay. In regular tuiMode it swaps pi's root for itself, and
 *  the overlay is a stub that draws nothing and passes it the keys, as the
 *  worker widget's focus does. On leaving it puts pi's tree back before pi
 *  closes the overlay, which gives the editor its focus back. */
export async function openTranscript(ui: TranscriptUI, board: TranscriptBoard, workerId: string, options: TranscriptViewOptions = {}): Promise<TranscriptViewExit> {
  if (board.worker(workerId) === undefined) throw new Error(`No worker on the board has the id ${workerId}`);
  const expanded = options.expanded ?? ui.getToolsExpanded?.() ?? false;
  let regular = false;
  return ui.custom<TranscriptViewExit>((tui, theme, keybindings, done) => {
    if (tui.mode !== "regular") return new TranscriptView(tui, theme, keybindings, board, workerId, (exit) => done(exit), { ...options, expanded });
    regular = true;
    let restore = () => {};
    const view = new TranscriptView(tui, theme, keybindings, board, workerId, (exit) => { restore(); done(exit); }, { ...options, expanded });
    restore = swapRoot(tui as unknown as RootTui, view);
    return {
      render: () => [],
      invalidate() {},
      handleInput: (data: string) => view.handleInput(data),
      // pi closes the overlay on its own only when it drops the whole UI, as on a reload.
      dispose: () => { view.dispose(); restore(); },
    };
  }, { overlay: true, overlayOptions: () => regular ? KEYS_OVERLAY : TRANSCRIPT_OVERLAY });
}
