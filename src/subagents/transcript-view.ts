import { truncateToVisualLines, type AgentSessionEvent, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import { readWorkerTranscript, Transcript, type TranscriptContext } from "./transcript.ts";
import { hasEnded, type BoardWorker, type WorkerBoard, type WorkerBoardView } from "./worker-board.ts";
import { agentLabel, MAX_WIDGET_ROWS, STATE_COLOR, widgetLines } from "./worker-widget.ts";

// The transcript view (epic a338): one worker's transcript on the whole
// screen, read from the worker board. It is a full-screen overlay through
// ctx.ui.custom, the mechanism the rcjm spike chose: pi-tui composites it
// over the whole viewport in both tuiModes, never writes to the scrollback and
// never touches the editor, so closing it leaves the orchestrator's session as
// it was. A running worker's transcript is live; a finished one's comes from
// its session file. The view is read-only: answering and steering stay with
// the orchestrator's subagents_message, and the one thing it sends a worker
// is the x stop, after a confirmation. It never closes on its own, so a
// worker that finishes stays open with its end state.
//
// Keys are matched through the keybindings manager pi hands the factory,
// never as raw bytes: pi turns on the kitty keyboard protocol, so Esc arrives
// as `\x1b[27u`, and an overlay that missed Esc and ctrl+c would trap the user
// (rcjm's first live try).
//
// The view is drawn in slots, top to bottom: a bar, the header, the worker's
// nested workers, the transcript and a footer. The header and the bar are
// options (TranscriptSlot), so a fuller header and an orchestrator bar can
// replace them without touching the rest.

/** The overlay covers the whole terminal. */
export const TRANSCRIPT_OVERLAY = { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } as const;

/** What the view needs of pi's TUI: the terminal's height, read on every
 *  render so a resize redraws at the new size, and a redraw request. */
export interface TranscriptViewTui {
  requestRender(): void;
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
  /** The worker's place among the board's workers, from 1; 0 once it is no longer on the board. */
  readonly position: number;
  readonly count: number;
  /** Epoch milliseconds. */
  readonly now: number;
  readonly theme: Theme;
  readonly width: number;
}

/** A slot's lines; the view cuts each to the width. */
export type TranscriptSlot = (frame: TranscriptFrame) => readonly string[];

export interface TranscriptViewOptions {
  /** The workers' working directory, for the built-in tools' paths. Default: the process's. */
  readonly cwd?: string;
  /** The header. Default: transcriptHeader. */
  readonly header?: TranscriptSlot;
  /** A bar above the header. Default: none. */
  readonly bar?: TranscriptSlot;
  /** Whether tool output starts expanded. */
  readonly expanded?: boolean;
  /** Epoch milliseconds. */
  readonly now?: () => number;
  /** Reads a finished worker's messages from its session file. Default: readWorkerTranscript. */
  readonly readSession?: (file: string) => readonly unknown[];
}

const SEPARATOR = " · ";
/** pi marks user messages for terminal prompt navigation; an overlay is no prompt. */
const PROMPT_MARKS = /\x1b\]133;[A-D]\x07/g;

/** The default header: agent, worker state and which worker of how many. */
export function transcriptHeader(frame: TranscriptFrame): string[] {
  const { worker, theme } = frame;
  const where = frame.position === 0 ? "no longer on the board" : `worker ${frame.position} of ${frame.count}`;
  return [[theme.fg("accent", theme.bold(agentLabel(worker))), theme.fg(STATE_COLOR[worker.state], worker.state), theme.fg("dim", where)]
    .join(theme.fg("muted", SEPARATOR))];
}

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
  readonly #close: () => void;
  readonly #options: TranscriptViewOptions;
  readonly #now: () => number;
  readonly #unsubscribeBoard: () => void;
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
  /** The selected nested worker. */
  #selected = 0;
  #confirming = false;
  /** A one-off line in the footer, until the next key. */
  #flash: string | undefined;
  #disposed = false;

  constructor(tui: TranscriptViewTui, theme: Theme, keys: TranscriptKeys, board: TranscriptBoard, workerId: string, close: () => void, options: TranscriptViewOptions = {}) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keys = keys;
    this.#board = board;
    this.#close = close;
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#expanded = options.expanded ?? false;
    const worker = board.worker(workerId);
    if (worker === undefined) throw new Error(`No worker on the board has the id ${workerId}`);
    this.#show(worker);
    this.#unsubscribeBoard = board.subscribe(() => this.#boardChanged());
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
    const keys = this.#keys;
    if (keys.matches(data, "tui.select.cancel")) return this.#leave();
    if (keys.matches(data, "tui.select.pageUp")) this.#scrollTo(this.#currentTop() - this.#bodyHeight);
    else if (keys.matches(data, "tui.select.pageDown")) this.#scrollTo(this.#currentTop() + this.#bodyHeight);
    else if (keys.matches(data, "tui.editor.cursorLineStart")) this.#scrollTo(0, true);
    else if (keys.matches(data, "tui.editor.cursorLineEnd")) this.#following = true;
    else if (keys.matches(data, "tui.editor.cursorLeft")) this.#step(-1);
    else if (keys.matches(data, "tui.editor.cursorRight")) this.#step(1);
    else if (keys.matches(data, "tui.select.up")) this.#selected = Math.max(0, this.#selected - 1);
    else if (keys.matches(data, "tui.select.down")) this.#selected = Math.min(Math.max(0, this.#nested().length - 1), this.#selected + 1);
    else if (keys.matches(data, "tui.select.confirm")) this.#openNested();
    else if (keys.matches(data, "app.tools.expand")) this.#transcript?.setExpanded(this.#expanded = !this.#expanded);
    else if (printable(data)?.toLowerCase() === "x") {
      if (hasEnded(this.#worker)) this.#flash = "This worker has already finished.";
      else this.#confirming = true;
    } else return;
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const rows = Math.max(1, this.#tui.terminal.rows);
    const workers = this.#board.workers();
    const index = workers.findIndex((worker) => worker.id === this.#worker.id);
    const frame: TranscriptFrame = { worker: this.#worker, position: index + 1, count: workers.length, now: this.#now(), theme: this.#theme, width };
    const theme = this.#theme;
    const top = [...this.#options.bar?.(frame) ?? [], ...(this.#options.header ?? transcriptHeader)(frame), ...this.#nestedLines(frame),
      theme.fg("dim", "─".repeat(width))];
    const body = this.#body(width);
    const height = Math.max(1, rows - top.length - 1);
    this.#bodyHeight = height;
    this.#bodyLength = body.length;
    const shownTop = this.#currentTop();
    if (!this.#following) this.#top = shownTop;
    const shown = body.slice(shownTop, shownTop + height);
    const padding = Array.from({ length: height - shown.length }, () => "");
    return [...top, ...shown, ...padding, this.#footer(shownTop)].slice(0, rows).map((line) => fit(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeBoard();
    this.#detach();
  }

  #leave(): void {
    this.dispose();
    this.#close();
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
    this.#following = true;
    this.#top = 0;
    this.#selected = 0;
    this.#confirming = false;
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
    return { tui: this.#tui, theme: this.#theme, cwd: this.#options.cwd ?? process.cwd(), tasks, expanded: this.#expanded,
      ...(toolDefinition === undefined ? {} : { toolDefinition }) };
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
    }
    this.#tui.requestRender();
  }

  /** The workers the shown worker started, in board order. */
  #nested(): BoardWorker[] {
    return this.#board.workers().filter((worker) => worker.parentId === this.#worker.id);
  }

  /** One line per nested worker, as the worker widget draws it, the selected one marked. */
  #nestedLines(frame: TranscriptFrame): string[] {
    const nested = this.#nested();
    if (nested.length === 0) return [];
    this.#selected = Math.min(this.#selected, nested.length - 1);
    // At most as many lines as the widget, scrolled to keep the selected one in view.
    const first = Math.max(0, Math.min(this.#selected - MAX_WIDGET_ROWS + 1, nested.length - MAX_WIDGET_ROWS));
    const window = nested.slice(first, first + MAX_WIDGET_ROWS);
    const lines = widgetLines({ rows: window.map((worker) => ({ worker, depth: 1 })), more: 0 }, frame.now, this.#theme, Math.max(1, frame.width - 2));
    return lines.map((line, index) => `${first + index === this.#selected ? this.#theme.fg("accent", "›") : " "} ${line}`);
  }

  #openNested(): void {
    const target = this.#nested()[this.#selected];
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
  #body(width: number): string[] {
    const theme = this.#theme;
    const worker = this.#worker;
    const lines = this.#transcript?.render(width) ?? [];
    if (this.#source.kind === "none" && this.#source.notice !== undefined) lines.push("", theme.fg("muted", this.#source.notice));
    if (lines.length === 0 && !hasEnded(worker)) lines.push("", theme.fg("muted", "No messages yet."));
    if (hasEnded(worker)) {
      const end = worker.state === "failed" ? `The worker failed${worker.error === undefined ? "." : `: ${worker.error}`}` : `The worker ${worker.state === "aborted" ? "was aborted" : "completed"}.`;
      lines.push("", theme.fg(STATE_COLOR[worker.state], end));
    }
    return lines;
  }

  #footer(shownTop: number): string {
    const theme = this.#theme;
    if (this.#confirming) return theme.fg("warning", "Stop this worker? y/n");
    if (this.#flash !== undefined) return theme.fg("muted", this.#flash);
    const where = this.#following ? "following" : `line ${shownTop + 1} of ${this.#bodyLength}, End follows`;
    const hints = [where, "←→ worker", "PgUp PgDn Home End scroll", ...this.#nested().length > 0 ? ["↑↓ Enter nested worker"] : [],
      ...hasEnded(this.#worker) ? [] : ["x stop"], "ctrl+o tool output", "Esc back"];
    return theme.fg("dim", hints.join(SEPARATOR));
  }
}

/** The part of pi's UI openTranscript uses. */
export type TranscriptUI = Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "getToolsExpanded">>;

/** Shows the worker `workerId` of `board` on the whole screen until the user
 *  leaves with Esc (or ctrl+c), then resolves; the orchestrator's session is
 *  as it was. Tool output starts expanded as the orchestrator's is. Throws
 *  when no worker on the board has the id. */
export async function openTranscript(ui: TranscriptUI, board: TranscriptBoard, workerId: string, options: TranscriptViewOptions = {}): Promise<void> {
  if (board.worker(workerId) === undefined) throw new Error(`No worker on the board has the id ${workerId}`);
  const expanded = options.expanded ?? ui.getToolsExpanded?.() ?? false;
  await ui.custom<void>((tui, theme, keybindings, done) => new TranscriptView(tui, theme, keybindings, board, workerId, () => done(), { ...options, expanded }),
    { overlay: true, overlayOptions: TRANSCRIPT_OVERLAY });
}
