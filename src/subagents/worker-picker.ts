import { truncateToVisualLines, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import type { BoardWorker, WorkerBoardView } from "./worker-board.ts";
import { moveSelection, selectedRow, widgetLines, workerRows, type RowSelection, type SelectionKeys } from "./worker-widget.ts";

// The /subagents picker (xytd): every worker of the orchestrator session,
// finished ones included, one worker widget line each, numbered in board
// order with nested workers indented under their parent delegation. The
// number is the worker's list number, which `/subagents <n>` opens directly.
//
// It is a small component in the editor's place through ctx.ui.custom, as
// pi's own selector is, rather than ctx.ui.select: the selector wraps a long
// line instead of cutting it, shows every option however many there are, and
// draws each option as one plain string that it cannot redraw. Here each line
// is the widget's line, fitted to the width and redrawn as the board changes,
// and a long list scrolls. Keys are matched through the keybindings manager
// pi hands the factory, and Esc or ctrl+c (tui.select.cancel) always leaves
// (rcjm). Closing it restores the editor with its text, as pi does.

/** At most this many workers show at once; the list scrolls to keep the selected one in view. */
export const MAX_PICKER_ROWS = 10;
/** How often an open picker redraws, for the elapsed times. */
const TICK_MS = 1_000;
const TITLE = "Workers of this session";
const HINT = "↑↓ select · Enter open · Esc cancel";
const SEPARATOR = " · ";
/** The text listing has no terminal to fit; its lines are cut at this width. */
const LISTING_WIDTH = 200;
const PLAIN = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;

/** Each worker's line, `workers` being the board's workers: its list number,
 *  then the worker widget's line, nested workers indented. Each line is at
 *  most `width` columns wide. */
function workerLines(workers: readonly BoardWorker[], now: number, theme: Theme, width: number): string[] {
  const digits = String(workers.length).length;
  return widgetLines({ rows: workerRows(workers), more: 0 }, now, theme, Math.max(1, width - digits - 2))
    .map((line, index) => `${String(index + 1).padStart(digits)}. ${line}`);
}

/** The picker's list as text, for a session without a UI to pick in. */
export function workerListing(workers: readonly BoardWorker[], now: number): string {
  return workerLines(workers, now, PLAIN, LISTING_WIDTH).map((line) => line.trimEnd()).join("\n");
}

/** Where `/subagents <ref>` leads: a worker on the board, or why there is none. */
export type FoundWorker = { readonly workerId: string; readonly refusal?: never } | { readonly workerId?: never; readonly refusal: string };

/** The worker `ref` names: a list number, as the picker numbers the board's
 *  workers, or a delegation id, whose latest run it is (a resume is a new
 *  entry with the same delegation id). */
export function findWorker(board: Pick<WorkerBoardView, "workers" | "byDelegation">, ref: string): FoundWorker {
  if (/^\d+$/.test(ref)) {
    const workers = board.workers();
    const worker = workers[Number(ref) - 1];
    if (worker !== undefined && Number(ref) > 0) return { workerId: worker.id };
    const has = workers.length === 0 ? "no workers yet." : `${workers.length} ${workers.length === 1 ? "worker" : "workers"}. /subagents lists them.`;
    return { refusal: `No worker has the list number ${ref}: this session has ${has}` };
  }
  const worker = board.byDelegation(ref);
  return worker === undefined ? { refusal: `No worker of this session has the delegation id ${ref}. /subagents lists every worker.` } : { workerId: worker.id };
}

/** What the picker needs of pi's TUI. */
export interface WorkerPickerTui {
  requestRender(): void;
}

export interface WorkerPickerOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** `line` cut to `width` columns. */
function fit(line: string, width: number): string {
  return truncateToVisualLines(line, Number.POSITIVE_INFINITY, width).visualLines[0] ?? "";
}

export class WorkerPicker {
  readonly #tui: WorkerPickerTui;
  readonly #theme: Theme;
  readonly #keys: SelectionKeys;
  readonly #board: WorkerBoardView;
  readonly #done: (workerId: string | undefined) => void;
  readonly #now: () => number;
  readonly #unsubscribe: () => void;
  readonly #stopTimer: () => void;
  readonly #selection: RowSelection = { selected: undefined, index: 0 };
  /** The first row shown. */
  #first = 0;
  #disposed = false;

  constructor(tui: WorkerPickerTui, theme: Theme, keys: SelectionKeys, board: WorkerBoardView, done: (workerId: string | undefined) => void,
    options: WorkerPickerOptions = {}) {
    this.#tui = tui;
    this.#theme = theme;
    this.#keys = keys;
    this.#board = board;
    this.#done = done;
    this.#now = options.now ?? Date.now;
    this.#unsubscribe = board.subscribe(() => tui.requestRender());
    const setTimer = options.setInterval ?? ((tick, ms) => setInterval(tick, ms).unref());
    const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
    const timer = setTimer(() => tui.requestRender(), TICK_MS);
    this.#stopTimer = () => clearTimer(timer);
  }

  handleInput(data: string): void {
    if (this.#disposed) return;
    const keys = this.#keys;
    if (keys.matches(data, "tui.select.cancel")) return this.#finish(undefined);
    const rows = workerRows(this.#board.workers());
    selectedRow(this.#selection, rows);
    if (keys.matches(data, "tui.select.confirm")) {
      if (this.#selection.selected !== undefined) this.#finish(this.#selection.selected);
      return;
    }
    const step = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : 0;
    if (step === 0) return;
    moveSelection(this.#selection, rows, step);
    this.#tui.requestRender();
  }

  render(width: number): string[] {
    const theme = this.#theme;
    const workers = this.#board.workers();
    const selected = selectedRow(this.#selection, workerRows(workers));
    const count = workers.length;
    this.#first = Math.max(0, Math.min(this.#first, selected, count - MAX_PICKER_ROWS), selected - MAX_PICKER_ROWS + 1);
    const lines = workerLines(workers, this.#now(), theme, Math.max(1, width - 2)).slice(this.#first, this.#first + MAX_PICKER_ROWS)
      .map((line, index) => `${this.#first + index === selected ? theme.fg("accent", "›") : " "} ${line}`);
    // A new orchestrator session empties the board while the picker is open.
    if (count === 0) lines.push(theme.fg("muted", "No workers in this session."));
    const range = count > MAX_PICKER_ROWS ? `${SEPARATOR}${this.#first + 1}–${this.#first + lines.length} of ${count}` : "";
    const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
    return [rule, theme.fg("accent", theme.bold(TITLE)), ...lines, theme.fg("dim", `${HINT}${range}`), rule].map((line) => fit(line, width));
  }

  invalidate(): void {}

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribe();
    this.#stopTimer();
  }

  #finish(workerId: string | undefined): void {
    this.dispose();
    this.#done(workerId);
  }
}

/** The part of pi's UI the picker uses. */
export type WorkerPickerUI = Pick<ExtensionUIContext, "custom">;

/** Shows the picker in the editor's place until the user picks a worker with
 *  Enter, and resolves with its id, or leaves with Esc (or ctrl+c), and
 *  resolves with `undefined`. The editor comes back with its text. */
export function pickWorker(ui: WorkerPickerUI, board: WorkerBoardView, options: WorkerPickerOptions = {}): Promise<string | undefined> {
  return ui.custom<string | undefined>((tui, theme, keys, done) => new WorkerPicker(tui, theme, keys, board, done, options));
}
