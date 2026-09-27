import { truncateToVisualLines, type ExtensionUIContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { shortTask } from "./render.ts";
import { elapsedMs, type BoardWorker, type WorkerBoardView, type WorkerModel, type WorkerState } from "./worker-board.ts";

// The worker widget above the editor (epic a338): one line per active worker
// of the orchestrator session, read from the worker board. Which workers show
// is a pure function of the board's workers and the time, so alt+a's focus
// (arrows, Enter) works on the same rows. The widget only observes: it never
// steers a worker.
//
// Focus (xytd): a widget above the editor cannot take the keyboard through
// pi's extension API, and the editor sends a key to an extension only as a
// shortcut. So alt+a opens a capturing overlay through ctx.ui.custom that
// draws nothing and only takes the keys, while the widget marks the selected
// row. The overlay gets pi's keybindings manager, so every key is matched as
// pi binds it (rcjm: never raw bytes, and always leave on tui.select.cancel),
// and closing it gives the keyboard back to the editor with its text
// untouched, as pi does for every overlay.

/** At most this many worker lines; the rest are counted on a "+N more" line. */
export const MAX_WIDGET_ROWS = 6;
/** How long a finished worker stays in the widget with its end state. */
export const LINGER_MS = 10_000;

/** One worker's line in the widget. */
export interface WidgetRow {
  readonly worker: BoardWorker;
  /** 0 for a worker of the orchestrator, 1 for a worker a shown worker started. */
  readonly depth: number;
}

/** What the widget shows: its worker lines and how many more workers did not fit. */
export interface WidgetRows {
  readonly rows: readonly WidgetRow[];
  readonly more: number;
}

const ENDED: readonly WorkerState[] = ["completed", "failed", "aborted"];

/** Whether `worker` belongs in the widget at `now`: active, or finished less than LINGER_MS ago. */
function shown(worker: BoardWorker, now: number): boolean {
  if (!ENDED.includes(worker.state)) return true;
  return worker.endedAt !== undefined && now - worker.endedAt < LINGER_MS;
}

/** A row for each of `workers`, in board order: each nested worker right
 *  after its parent delegation's worker, one level deeper when that worker is
 *  among `workers`. */
export function workerRows(workers: readonly BoardWorker[]): WidgetRow[] {
  const depths = new Map<string, number>();
  return workers.map((worker) => {
    const parentDepth = worker.parentId === undefined ? undefined : depths.get(worker.parentId);
    const depth = parentDepth === undefined ? 0 : parentDepth + 1;
    depths.set(worker.id, depth);
    return { worker, depth };
  });
}

/** The widget's rows at `now` from the board's workers, in board order: each
 *  nested worker right after its parent delegation's worker, one level deeper. */
export function widgetRows(workers: readonly BoardWorker[], now: number): WidgetRows {
  const rows = workerRows(workers.filter((worker) => shown(worker, now)));
  return { rows: rows.slice(0, MAX_WIDGET_ROWS), more: Math.max(0, rows.length - MAX_WIDGET_ROWS) };
}

/** The label of a worker whose item names no agent definition, as the subagents tool shows it. */
const NO_AGENT = "worker";

/** A worker's agent name, `worker` without one, and `(fork)` for a fork. */
export function agentLabel(worker: Pick<BoardWorker, "agent" | "model">): string {
  return `${worker.agent ?? NO_AGENT}${worker.model.kind === "fork" ? " (fork)" : ""}`;
}

/** A worker's model and effort: a routed worker's latest rung, marked when its routing escalated. */
function modelText(model: WorkerModel): string {
  switch (model.kind) {
    case "routing": return "routing…";
    case "routed": {
      const latest = model.rungs.at(-1)!;
      const escalation = [...model.rungs].reverse().find((rung) => rung.escalation !== undefined)?.escalation;
      return `${latest.model}:${latest.effort}${escalation === undefined ? "" : ` ↑${escalation.to}`}`;
    }
    case "fork":
    case "preserved": return model.effort === undefined ? model.model : `${model.model}:${model.effort}`;
  }
}

/** Each worker state's colour, shared with the transcript view. */
export const STATE_COLOR: Record<WorkerState, ThemeColor> = {
  queued: "muted", running: "warning", asking: "accent", completed: "success", failed: "error", aborted: "warning",
};

/** `12s`, `3m04s` or `1h02m`. */
function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The first or last non-empty line of `text`, its whitespace collapsed. */
function oneLine(text: string, which: "first" | "last"): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
  return (which === "first" ? lines[0] : lines.at(-1)) ?? "";
}

/** What the worker is doing: its current tool, its latest text, why it failed,
 *  or, before any of those, its short task. */
function activity(worker: BoardWorker): [ThemeColor, string] {
  if (worker.tool !== undefined) return ["accent", worker.tool];
  if (worker.state === "failed" && worker.error !== undefined) return ["error", oneLine(worker.error, "first")];
  const text = oneLine(worker.text, "last");
  return text === "" ? ["dim", shortTask(worker.task)] : ["muted", text];
}

type Part = readonly [ThemeColor, string];

/** A worker's line, before it is fitted to the render width. */
function rowParts(row: WidgetRow, now: number): { indent: string; parts: Part[] } {
  const { worker } = row;
  const parts: Part[] = [["accent", agentLabel(worker)], ["dim", modelText(worker.model)], [STATE_COLOR[worker.state], worker.state]];
  const elapsed = elapsedMs(worker, now);
  if (elapsed !== undefined) parts.push(["dim", formatElapsed(elapsed)], ["dim", `${worker.turns} ${worker.turns === 1 ? "turn" : "turns"}`]);
  parts.push(activity(worker));
  return { indent: row.depth === 0 ? "" : `${"  ".repeat(row.depth - 1)}└ `, parts };
}

const SEPARATOR = " · ";

/** `parts` joined and styled, cut with an ellipsis to `width` columns. */
function fitted(indent: string, parts: readonly Part[], theme: Theme, width: number): string {
  let room = width - indent.length;
  let line = indent;
  for (const [index, [color, text]] of parts.entries()) {
    const separator = index === 0 ? "" : SEPARATOR;
    const needed = separator.length + text.length;
    if (needed <= room) {
      line += `${theme.fg("muted", separator)}${theme.fg(color, text)}`;
      room -= needed;
      continue;
    }
    const kept = text.slice(0, Math.max(0, room - separator.length - 1)).trimEnd();
    if (room > separator.length) line += `${theme.fg("muted", separator)}${theme.fg(color, `${kept}…`)}`;
    break;
  }
  // Character counts undercount wide characters; pi wraps by display width, so its first line always fits.
  return (truncateToVisualLines(line, Number.POSITIVE_INFINITY, width).visualLines[0] ?? "").trimEnd();
}

/** The widget's lines at `now`, each at most `width` columns wide. */
export function widgetLines(rows: WidgetRows, now: number, theme: Theme, width: number): string[] {
  const lines = rows.rows.map((row) => {
    const { indent, parts } = rowParts(row, now);
    return fitted(indent, parts, theme, width);
  });
  if (rows.more > 0) lines.push(fitted("", [["muted", `+${rows.more} more`]], theme, width));
  return lines;
}

/** The widget's key among pi's extension widgets. */
export const WORKER_WIDGET = "pi-orchestrator.workers";
/** How often a shown widget redraws, for the elapsed times and the linger. */
const TICK_MS = 1_000;

/** The part of pi's UI the widget uses. */
export type WorkerWidgetUI = Pick<ExtensionUIContext, "setWidget">;

/** The part of pi's UI the widget's focus uses. */
export type WorkerWidgetFocusUI = Pick<ExtensionUIContext, "custom">;

/** How a focus ended: a worker chosen with Enter, or none. `empty` when the
 *  widget showed no worker, `left` on Esc or ctrl+c, and when the widget
 *  emptied or stopped while focused. */
export type WidgetFocusResult =
  | { readonly workerId: string; readonly reason?: never }
  | { readonly workerId?: never; readonly reason: "empty" | "left" };

/** The shown widget, and alt+a's focus on it. */
export interface WorkerWidget {
  /** Takes the keyboard until the user chooses a worker with Enter or leaves
   *  with Esc (or ctrl+c), marking the selected row; the keyboard then goes
   *  back to the editor. */
  focus(ui: WorkerWidgetFocusUI): Promise<WidgetFocusResult>;
  /** Stops following the board and removes the widget. */
  stop(): void;
}

/** The focus overlay draws nothing; it only holds the keyboard. */
const FOCUS_OVERLAY = { width: 1, maxHeight: 1, anchor: "bottom-left", margin: 0 } as const;
const FOCUS_HINT = "↑↓ select · Enter open · Esc back";

/** The part of pi's keybindings manager the focus and the picker use. */
export interface SelectionKeys {
  matches(data: string, keybinding: string): boolean;
}

/** A selected row in a list of worker rows that changes under it: the
 *  selected worker, and its row index, which a worker that drops out passes
 *  on to the row in its place. Shared with the /subagents picker. */
export interface RowSelection {
  selected: string | undefined;
  index: number;
}

/** The selected row of `rows`, kept on the selected worker while it is among them. */
export function selectedRow(selection: RowSelection, rows: readonly WidgetRow[]): number {
  const index = rows.findIndex((row) => row.worker.id === selection.selected);
  selection.index = index >= 0 ? index : Math.max(0, Math.min(selection.index, rows.length - 1));
  selection.selected = rows[selection.index]?.worker.id;
  return selection.index;
}

/** Moves `selection` one row up or down `rows`, stopping at either end. */
export function moveSelection(selection: RowSelection, rows: readonly WidgetRow[], step: -1 | 1): void {
  selection.index = Math.max(0, Math.min(rows.length - 1, selectedRow(selection, rows) + step));
  selection.selected = rows[selection.index]?.worker.id;
}

/** An active focus. */
interface Focus extends RowSelection {
  readonly end: (result: WidgetFocusResult) => void;
}

/** The focused widget's lines: the selected row marked, and the keys it takes. */
function focusedLines(rows: WidgetRows, selected: number, now: number, theme: Theme, width: number): string[] {
  const lines = widgetLines(rows, now, theme, Math.max(1, width - 2))
    .map((line, index) => `${index === selected ? theme.fg("accent", "›") : " "} ${line}`);
  return [...lines, fitted("", [["dim", FOCUS_HINT]], theme, width)];
}

export interface WorkerWidgetOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** Shows the board's active workers above the editor until it is stopped.
 *  The widget is there while any worker is active or lingering, and gone
 *  otherwise; a timer runs only while it is there. */
export function startWorkerWidget(ui: WorkerWidgetUI, board: WorkerBoardView, options: WorkerWidgetOptions = {}): WorkerWidget {
  const now = options.now ?? Date.now;
  const setTimer = options.setInterval ?? ((tick, ms) => setInterval(tick, ms).unref());
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let timer: unknown;
  /** pi's render request of the shown widget; `undefined` while it is hidden. */
  let requestRender: (() => void) | undefined;
  let stopped = false;
  let focus: Focus | undefined;

  const hide = () => {
    // An emptied widget has nothing to select: the keyboard goes back to the editor.
    focus?.end({ reason: "left" });
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (requestRender === undefined) return;
    requestRender = undefined;
    ui.setWidget(WORKER_WIDGET, undefined);
  };
  const refresh = () => {
    if (stopped) return;
    if (widgetRows(board.workers(), now()).rows.length === 0) return hide();
    if (requestRender !== undefined) return requestRender();
    // The component renders the board afresh each time, so a change only needs a render request.
    ui.setWidget(WORKER_WIDGET, (tui, theme) => {
      const component = {
        render: (width: number) => {
          const rows = widgetRows(board.workers(), now());
          return focus === undefined ? widgetLines(rows, now(), theme, width) : focusedLines(rows, selectedRow(focus, rows.rows), now(), theme, width);
        },
        invalidate() {},
        // pi drops every widget on its own, as on a reload: the next refresh sets it again.
        dispose() { if (requestRender === rerender) requestRender = undefined; },
      };
      const rerender = () => tui.requestRender();
      requestRender = rerender;
      return component;
    }, { placement: "aboveEditor" });
    timer ??= setTimer(refresh, TICK_MS);
  };

  // A worker's change never hides a shown widget, since a finished worker
  // lingers, so while it is shown only the timer and a whole-board change
  // need the rows; streamed replies change the board often.
  const unsubscribe = board.subscribe((worker) => worker !== undefined && requestRender !== undefined ? requestRender() : refresh());
  refresh();

  const onKey = (active: Focus, keys: SelectionKeys, data: string) => {
    if (keys.matches(data, "tui.select.cancel")) return active.end({ reason: "left" });
    const rows = widgetRows(board.workers(), now()).rows;
    selectedRow(active, rows);
    if (keys.matches(data, "tui.select.confirm")) {
      if (active.selected !== undefined) active.end({ workerId: active.selected });
      return;
    }
    const step = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : 0;
    if (step === 0) return;
    moveSelection(active, rows, step);
    requestRender?.();
  };

  return {
    focus(focusUI) {
      if (stopped || focus !== undefined || widgetRows(board.workers(), now()).rows.length === 0) {
        return Promise.resolve({ reason: focus === undefined ? "empty" : "left" });
      }
      return focusUI.custom<WidgetFocusResult>((_tui, _theme, keys, done) => {
        const active: Focus = { selected: undefined, index: 0, end: (result) => {
          if (focus !== active) return;
          focus = undefined;
          requestRender?.();
          done(result);
        } };
        focus = active;
        requestRender?.();
        return {
          render: () => [],
          invalidate() {},
          handleInput: (data: string) => { if (focus === active) onKey(active, keys, data); },
          // pi closes the overlay on its own only when it drops the whole UI, as on a reload.
          dispose: () => active.end({ reason: "left" }),
        };
      }, { overlay: true, overlayOptions: FOCUS_OVERLAY });
    },
    stop() {
      stopped = true;
      unsubscribe();
      hide();
    },
  };
}
