import { truncateToVisualLines, type ExtensionUIContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { shortTask } from "./render.ts";
import { elapsedMs, type BoardWorker, type WorkerBoardView, type WorkerModel, type WorkerState } from "./worker-board.ts";

// The worker widget above the editor (epic a338): one line per active worker
// of the orchestrator session, read from the worker board. Which workers show
// is a pure function of the board's workers and the time, so a later
// selection (alt+a, arrows, Enter) can work on the same rows. The widget only
// observes: it never steers a worker.

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

/** The widget's rows at `now` from the board's workers, in board order: each
 *  nested worker right after its parent delegation's worker, one level deeper. */
export function widgetRows(workers: readonly BoardWorker[], now: number): WidgetRows {
  const depths = new Map<string, number>();
  const rows: WidgetRow[] = [];
  for (const worker of workers) {
    if (!shown(worker, now)) continue;
    const parentDepth = worker.parentId === undefined ? undefined : depths.get(worker.parentId);
    const depth = parentDepth === undefined ? 0 : parentDepth + 1;
    depths.set(worker.id, depth);
    rows.push({ worker, depth });
  }
  return { rows: rows.slice(0, MAX_WIDGET_ROWS), more: Math.max(0, rows.length - MAX_WIDGET_ROWS) };
}

/** The label of a worker whose item names no agent definition, as the subagents tool shows it. */
const NO_AGENT = "worker";

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

const STATE_COLOR: Record<WorkerState, ThemeColor> = {
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
  const agent = `${worker.agent ?? NO_AGENT}${worker.model.kind === "fork" ? " (fork)" : ""}`;
  const parts: Part[] = [["accent", agent], ["dim", modelText(worker.model)], [STATE_COLOR[worker.state], worker.state]];
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

export interface WorkerWidgetOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** Shows the board's active workers above the editor until the returned
 *  function is called. The widget is there while any worker is active or
 *  lingering, and gone otherwise; a timer runs only while it is there. */
export function startWorkerWidget(ui: WorkerWidgetUI, board: WorkerBoardView, options: WorkerWidgetOptions = {}): () => void {
  const now = options.now ?? Date.now;
  const setTimer = options.setInterval ?? ((tick, ms) => setInterval(tick, ms).unref());
  const clearTimer = options.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let timer: unknown;
  /** pi's render request of the shown widget; `undefined` while it is hidden. */
  let requestRender: (() => void) | undefined;
  let stopped = false;

  const hide = () => {
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
        render: (width: number) => widgetLines(widgetRows(board.workers(), now()), now(), theme, width),
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
  return () => {
    stopped = true;
    unsubscribe();
    hide();
  };
}
