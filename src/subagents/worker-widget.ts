import { truncateToVisualLines, type ExtensionUIContext, type Theme, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { elapsedMs, type BoardWorker, type Activity, type WorkerBoardView, type WorkerModel, type WorkerState } from "./worker-board.ts";

// The worker widget below the editor (epic a338, faal), drawn as Claude
// Code's agent list: a hint, then `main`, the orchestrator's own agent, then
// one row per active worker of the orchestrator session, read from the worker
// board. The selected row has the ❯ cursor and a filled dot, every other row a
// hollow one; `main` is selected while the editor has the keyboard. Which
// workers show is a pure function of the board's workers and the time, so
// alt+a's focus (arrows, Enter) works on the same rows. The widget only
// observes: it never steers a worker.
//
// Focus (xytd, faal): a widget cannot take the keyboard through pi's
// extension API, and the editor sends a key to an extension only as a
// shortcut. So Down at the editor's end, or alt+a, opens a capturing overlay through ctx.ui.custom that
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

/** The workers the widget lists at `now`: the active ones and those that
 *  finished less than LINGER_MS ago, plus any worker whose id is in `keep`
 *  whatever its state (the transcript view's viewed and selected sessions). */
export function widgetWorkers(workers: readonly BoardWorker[], now: number, keep: readonly (string | undefined)[] = []): BoardWorker[] {
  return workers.filter((worker) => shown(worker, now) || keep.includes(worker.id));
}

/** The widget's rows at `now` from the board's workers, in board order: each
 *  nested worker right after its parent delegation's worker, one level deeper. */
export function widgetRows(workers: readonly BoardWorker[], now: number): WidgetRows {
  const rows = workerRows(widgetWorkers(workers, now));
  return { rows: rows.slice(0, MAX_WIDGET_ROWS), more: Math.max(0, rows.length - MAX_WIDGET_ROWS) };
}

/** The label of a worker whose item names no agent definition, as the subagents tool shows it. */
const NO_AGENT = "worker";

/** A worker's name (CONTEXT.md, Label): its label, else its agent
 *  definition, else `worker`, with `(fork)` for a fork. A reviewer is
 *  `reviewer: <label>`, its label its own or the reviewed delegation's, which
 *  the subagents extension gives it, and plain `reviewer` without one. */
export function agentLabel(worker: Pick<BoardWorker, "label" | "agent" | "review" | "model">): string {
  const label = oneLine(worker.label ?? "", "first");
  if (worker.review !== undefined) return label === "" ? "reviewer" : `reviewer: ${label}`;
  return `${label || worker.agent || NO_AGENT}${worker.model.kind === "fork" ? " (fork)" : ""}`;
}

/** A model as a row shows it: without its provider, and without the
 *  `claude-` its model names repeat, so `anthropic/claude-opus-5-5` reads `opus-5-5`. */
export function shortModel(model: string): string {
  return model.slice(model.lastIndexOf("/") + 1).replace(/^claude-/, "");
}

/** A worker's model and effort: a routed worker's latest rung, marked when
 *  its routing escalated. Rows show it short (shortModel); the transcript
 *  view and the status snapshot show the full rung. */
export function rungText(model: WorkerModel, form: "short" | "full" = "short"): string {
  const name = (id: string) => form === "short" ? shortModel(id) : id;
  switch (model.kind) {
    case "routing": return "routing…";
    case "routed": {
      const latest = model.rungs.at(-1)!;
      const escalation = [...model.rungs].reverse().find((rung) => rung.escalation !== undefined)?.escalation;
      return `${name(latest.model)}:${latest.effort}${escalation === undefined ? "" : ` ↑${escalation.to}`}`;
    }
    case "fork":
    case "preserved": return model.effort === undefined ? name(model.model) : `${name(model.model)}:${model.effort}`;
  }
}

/** Each worker state's colour, shared with the transcript view. */
export const STATE_COLOR: Record<WorkerState, ThemeColor> = {
  queued: "muted", running: "warning", asking: "accent", completed: "success", failed: "error", aborted: "warning",
};

/** `850`, `12.3k`, `456k` or `1.2M` tokens. The bounds sit where rounding
 *  would reach the next step, so no count reads `100.0k` or `1000k`. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 99_950) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 999_500) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `12s`, `3m04s` or `1h02m`. */
export function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** The first or last non-empty line of `text`, its whitespace collapsed. */
export function oneLine(text: string, which: "first" | "last"): string {
  const lines = text.split(/\r?\n/).map((line) => line.replace(/\s+/g, " ").trim()).filter((line) => line !== "");
  return (which === "first" ? lines[0] : lines.at(-1)) ?? "";
}

/** An activity as a line shows it (CONTEXT.md, Activity): the same in the
 *  worker widget and the transcript view. */
export function activityPart(activity: Activity): Part {
  switch (activity.kind) {
    case "thinking": return ["muted", "thinking…"];
    case "writing": return ["muted", "writing…"];
    case "tool": return ["accent", activity.tool];
    case "failed": return ["error", oneLine(activity.error, "first")];
  }
}

/** A piece of a line and its colour. */
export type Part = readonly [ThemeColor, string];

/** What leads a nested worker's name: `└ `, two columns further in for each level below the first. */
function nestIndent(depth: number): string {
  return depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
}

/** A worker's row before it is fitted (cml8, rm9t): its name, then its
 *  tier, short rung, elapsed time once it started, and worker state, and
 *  while it runs its activity in a word. A row that is not running ends with
 *  its state: never with task text, and never with a failure's reason, which
 *  the transcript view shows. */
function rowParts(row: WidgetRow, now: number): { indent: string; name: string; details: Part[] } {
  const { worker } = row;
  const details: Part[] = [...(worker.tier === undefined ? [] : [["dim", worker.tier] as Part]), ["dim", rungText(worker.model)]];
  const elapsed = elapsedMs(worker, now);
  if (elapsed !== undefined) details.push(["dim", formatElapsed(elapsed)]);
  details.push([STATE_COLOR[worker.state], worker.state]);
  if (worker.state === "running" && worker.activity !== undefined && worker.activity.kind !== "failed") details.push(activityPart(worker.activity));
  return { indent: nestIndent(row.depth), name: agentLabel(worker), details };
}

const SEPARATOR = " · ";

/** `parts` joined with muted separators and cut with an ellipsis to `room`
 *  characters: each part kept follows its separator, the first's empty. */
function cutParts(parts: readonly Part[], room: number): Part[] {
  const kept: Part[] = [];
  for (const [index, [color, text]] of parts.entries()) {
    const separator = index === 0 ? "" : SEPARATOR;
    const needed = separator.length + text.length;
    if (needed <= room) {
      kept.push(["muted", separator], [color, text]);
      room -= needed;
      continue;
    }
    const start = text.slice(0, Math.max(0, room - separator.length - 1)).trimEnd();
    if (room > separator.length) kept.push(["muted", separator], [color, `${start}…`]);
    break;
  }
  return kept;
}

/** How many characters `parts` take. */
function partsWidth(parts: readonly Part[]): number {
  return parts.reduce((sum, [, text]) => sum + text.length, 0);
}

/** `line` cut to `width` columns. Character counts undercount wide
 *  characters; pi wraps by display width, so its first line always fits. */
function fitLine(line: string, width: number): string {
  return (truncateToVisualLines(line, Number.POSITIVE_INFINITY, width).visualLines[0] ?? "").trimEnd();
}

/** `parts` joined and styled, cut with an ellipsis to `width` columns. */
export function fitted(indent: string, parts: readonly Part[], theme: Theme, width: number): string {
  const kept = cutParts(parts, width - indent.length);
  return fitLine(`${indent}${kept.map(([color, text]) => theme.fg(color, text)).join("")}`, width);
}

/** How many characters `parts` take joined with separators. */
function joinedWidth(parts: readonly Part[]): number {
  return parts.length === 0 ? 0 : partsWidth(parts) + SEPARATOR.length * (parts.length - 1);
}

/** The compact worker lines at `now`, one per row, each at most `width`
 *  columns wide: the name, then the row's details after a separator. The
 *  name takes the room the details leave and is shortened only when the row
 *  does not fit; a row too narrow even for a short name cuts its details from
 *  the end. The /subagents listing's, the status output's and the tool
 *  result's, where there is no UI to pick in. */
export function compactLines(rows: WidgetRows, now: number, theme: Theme, width: number): string[] {
  const lines = rows.rows.map((row) => {
    const { indent, name, details } = rowParts(row, now);
    const room = width - indent.length - joinedWidth(details) - SEPARATOR.length;
    return fitted(indent, [["accent", cutText(name, Math.max(MIN_NAME_COLUMN, room))], ...details], theme, width);
  });
  if (rows.more > 0) lines.push(fitted("", [["muted", `+${rows.more} more`]], theme, width));
  return lines;
}

/** The orchestrator's own agent: the widget's first row, selected while the
 *  editor has the keyboard, which ↑ on the first worker gives back. */
export const MAIN_AGENT = "main";

/** The hint above the rows while the editor has the keyboard, and while the widget has it. */
export const SELECT_HINT = "↑/↓ to select";
const FOCUS_HINT = `${SELECT_HINT} · Enter to open · Esc to go back`;
/** The selected row's cursor, and the columns every other row keeps in its place. */
const CURSOR = "❯ ";
const NO_CURSOR = "  ";
/** The selected row's dot, and every other row's. */
const SELECTED_DOT = "●";
const DOT = "○";
/** The cursor's columns, the dot and a space: where the names start. */
const MARKS_WIDTH = 4;
/** A name is cut no shorter than this; a row too narrow for it cuts its details from the end instead. */
const MIN_NAME_COLUMN = 6;
/** The spaces between the name column and a row's details. */
const NAME_GAP = 3;
/** Less room than this leaves the middle text out, rather than a lone `…`. */
const MIN_MIDDLE = 4;

/** One row of an agent list (the widget's, the /subagents picker's and the
 *  transcript view's nested workers) before it is fitted: what leads the name
 *  (a nested worker's indent, a list number), the name, and the row's details. */
export interface AgentRow {
  readonly indent: string;
  readonly name: string;
  readonly details: readonly Part[];
}

const MAIN_ROW: AgentRow = { indent: "", name: MAIN_AGENT, details: [] };

/** A worker's row in an agent list at `now`: the same row as its compact line. */
export function agentRow(row: WidgetRow, now: number): AgentRow {
  return rowParts(row, now);
}

/** The most columns `row`'s indent and name may take at `width`: the room
 *  its details leave, at least MIN_NAME_COLUMN; any number without details. */
function nameLimit(row: AgentRow, width: number): number {
  if (row.details.length === 0) return Number.POSITIVE_INFINITY;
  return Math.max(MIN_NAME_COLUMN, width - MARKS_WIDTH - NAME_GAP - joinedWidth(row.details));
}

/** The columns `row`'s indent and name take at `width`: all they need when
 *  the row fits, else their limit. */
function nameRoom(row: AgentRow, width: number): number {
  return Math.min(row.indent.length + row.name.length, nameLimit(row, width));
}

/** `row` fitted to `width`: its marks, its name cut to its room and padded
 *  to `column`, then its details, cut from the end when even the shortest
 *  name leaves them too little room. */
function agentLine(row: AgentRow, selected: boolean, column: number, theme: Theme, width: number): string {
  const marks = selected ? theme.fg("accent", `${CURSOR}${SELECTED_DOT}`) : `${NO_CURSOR}${theme.fg("dim", DOT)}`;
  const nameWidth = Math.min(column, nameLimit(row, width));
  const name = cutText(row.name, Math.max(1, nameWidth - row.indent.length));
  let line = `${marks} ${theme.fg("dim", row.indent)}${selected ? theme.fg("accent", theme.bold(name)) : theme.fg("muted", name)}`;
  const used = MARKS_WIDTH + row.indent.length + name.length;
  const start = MARKS_WIDTH + nameWidth + NAME_GAP;
  const room = width - start;
  const details = room >= MIN_MIDDLE ? cutParts(row.details, room).filter(([, text]) => text !== "") : [];
  if (details.length > 0) line += `${" ".repeat(Math.max(1, start - used))}${details.map(([color, text]) => theme.fg(color, text)).join("")}`;
  return fitLine(line, width);
}

/** `text` cut with an ellipsis to at most `max` characters. */
function cutText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** An agent list's dim hint, in line with the names' dots, cut to `width`. */
export function hintLine(hint: string, theme: Theme, width: number): string {
  return fitLine(`${NO_CURSOR}${theme.fg("dim", hint)}`, width);
}

/** An agent list's rows, one line each at most `width` columns wide: the
 *  `selected` one with the cursor and a filled dot, every other one with a
 *  hollow dot. The names share one column, as wide as the widest name its
 *  row has room for, so the details line up while the rows fit. */
export function agentLines(rows: readonly AgentRow[], selected: number | undefined, theme: Theme, width: number): string[] {
  const column = Math.max(0, ...rows.map((row) => nameRoom(row, width)));
  return rows.map((row, index) => agentLine(row, index === selected, column, theme, width));
}

/** The widget's lines at `now`, each at most `width` columns wide: the hint,
 *  a blank line, `main`, then the worker rows and "+N more". `selected` is
 *  the focused widget's selected worker row; without it `main` is selected. */
export function widgetLines(rows: WidgetRows, selected: number | undefined, now: number, theme: Theme, width: number): string[] {
  const lines = [
    hintLine(selected === undefined ? SELECT_HINT : FOCUS_HINT, theme, width),
    "",
    ...agentLines([MAIN_ROW, ...rows.rows.map((row) => agentRow(row, now))], selected === undefined ? 0 : selected + 1, theme, width),
  ];
  if (rows.more > 0) lines.push(fitLine(`${" ".repeat(MARKS_WIDTH)}${theme.fg("muted", `+${rows.more} more`)}`, width));
  return lines;
}

/** The row index in the main-plus-workers picker for its current session. */
export function sessionPickerIndex(rows: readonly WidgetRow[], workerId: string | undefined): number {
  if (workerId === undefined) return 0;
  const index = rows.findIndex((row) => row.worker.id === workerId);
  return index < 0 ? 0 : index + 1;
}

/** The worker for a selected picker row; row zero is the orchestrator's main session. */
export function sessionPickerWorkerId(rows: readonly WidgetRow[], selected: number): string | undefined {
  return selected <= 0 ? undefined : rows[selected - 1]?.worker.id;
}

/** The session picker in a worker transcript view, with main fixed above a
 *  scrolling window of workers so the viewed or selected worker stays visible. */
export function sessionPickerLines(rows: readonly WidgetRow[], selected: number, now: number, theme: Theme, width: number): string[] {
  const current = Math.max(0, Math.min(selected, rows.length));
  const first = current === 0 ? 0 : Math.max(0, Math.min(current - MAX_WIDGET_ROWS, rows.length - MAX_WIDGET_ROWS));
  const visible = rows.slice(first, first + MAX_WIDGET_ROWS);
  const range = rows.length > MAX_WIDGET_ROWS ? `${SEPARATOR}${first + 1}–${first + visible.length} of ${rows.length}` : "";
  const selectedRow = current === 0 ? 0 : current - first;
  return [
    hintLine(`${FOCUS_HINT}${range}`, theme, width),
    "",
    ...agentLines([MAIN_ROW, ...visible.map((row) => agentRow(row, now))], selectedRow, theme, width),
  ];
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

/** The shown widget, and the focus on it. */
export interface WorkerWidget {
  /** Takes the keyboard until the user chooses a worker with Enter or leaves
   *  with Esc (or ctrl+c) or ↑ on the first row, marking the selected row;
   *  the keyboard then goes back to the editor. Any other key leaves too and
   *  goes into the editor. `select` starts on that worker while it is shown. */
  focus(ui: WorkerWidgetFocusUI, options?: { readonly select?: string }): Promise<WidgetFocusResult>;
  /** Whether `data`, a key before the editor gets it, is Down that would do
   *  nothing in the editor while the widget shows a worker: then the caller
   *  consumes it and focuses the widget. */
  downEnters(data: string): boolean;
  /** Stops following the board and removes the widget. */
  stop(): void;
}

/** The focus overlay draws nothing; it only holds the keyboard. */
const FOCUS_OVERLAY = { width: 1, maxHeight: 1, anchor: "bottom-left", margin: 0 } as const;

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

/** pi's editor, the focused component, as the Down entry reads it. Only
 *  getLines and getCursor are pi-tui's public Editor API, and keybindings is
 *  pi's CustomEditor's own manager, so Down is matched as the editor binds
 *  it. historyIndex (-1 when not browsing), autocompleteState and
 *  isOnLastVisualLine are pi-tui internals, read only when present. */
interface FocusedEditor {
  readonly keybindings?: SelectionKeys;
  getLines?(): readonly string[];
  getCursor?(): { readonly line: number; readonly col: number };
  isOnLastVisualLine?(): boolean;
  readonly historyIndex?: number;
  readonly autocompleteState?: unknown;
  readonly jumpMode?: unknown;
  handleInput?(data: string): void;
}

/** A key's release or repeat under the kitty keyboard protocol, which pi
 *  turns on: listeners see them before pi-tui drops them, and the key's press already came. */
const RELEASE_OR_REPEAT = /^\x1b\[[\d;:]*:[23][~A-Za-z]$/;

/** The part of pi's TUI the widget reads: the focused component, not in pi-tui's TUI interface but on its every TUI. */
interface FocusTui {
  getFocusedComponent?(): unknown;
}

/** Whether Down would do nothing in `component`: it is pi's editor, `data`
 *  is its Down, its cursor is at the end of its last line, and it is neither
 *  browsing its history, showing an autocomplete list nor waiting on a jump
 *  target, where Down does something. Down on the last line moves the cursor
 *  to its end first. */
export function downDoesNothing(component: unknown, data: string): boolean {
  const editor = component as FocusedEditor | null | undefined;
  if (typeof editor?.getLines !== "function" || typeof editor.getCursor !== "function" || editor.keybindings === undefined) return false;
  if (RELEASE_OR_REPEAT.test(data) || !editor.keybindings.matches(data, "tui.editor.cursorDown")) return false;
  if ((editor.historyIndex ?? -1) > -1 || (editor.autocompleteState ?? null) !== null || (editor.jumpMode ?? null) !== null) return false;
  const lines = editor.getLines();
  const cursor = editor.getCursor();
  if (cursor.line < lines.length - 1 || cursor.col < (lines.at(-1) ?? "").length) return false;
  // A long last line wraps: Down moves between its visual lines first.
  return typeof editor.isOnLastVisualLine !== "function" || editor.isOnLastVisualLine();
}

/** An active focus. */
interface Focus extends RowSelection {
  readonly end: (result: WidgetFocusResult) => void;
}

export interface WorkerWidgetOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
  readonly setInterval?: (tick: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

/** Shows the board's active workers below the editor until it is stopped.
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
  /** pi's TUI, from the shown widget's factory. */
  let widgetTui: FocusTui | undefined;

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
      widgetTui = tui as unknown as FocusTui;
      const component = {
        render: (width: number) => {
          const rows = widgetRows(board.workers(), now());
          return widgetLines(rows, focus === undefined ? undefined : selectedRow(focus, rows.rows), now(), theme, width);
        },
        invalidate() {},
        // pi drops every widget on its own, as on a reload: the next refresh sets it again.
        dispose() { if (requestRender === rerender) requestRender = undefined; },
      };
      const rerender = () => tui.requestRender();
      requestRender = rerender;
      return component;
    }, { placement: "belowEditor" });
    timer ??= setTimer(refresh, TICK_MS);
  };

  // A worker's change never hides a shown widget, since a finished worker
  // lingers, so while it is shown only the timer and a whole-board change
  // need the rows; streamed replies change the board often.
  const unsubscribe = board.subscribe((worker) => worker !== undefined && requestRender !== undefined ? requestRender() : refresh());
  refresh();

  const onKey = (active: Focus, keys: SelectionKeys, tui: FocusTui, data: string) => {
    if (keys.matches(data, "tui.select.cancel")) return active.end({ reason: "left" });
    const rows = widgetRows(board.workers(), now()).rows;
    const index = selectedRow(active, rows);
    if (keys.matches(data, "tui.select.confirm")) {
      if (active.selected !== undefined) active.end({ workerId: active.selected });
      return;
    }
    const step = keys.matches(data, "tui.select.up") ? -1 : keys.matches(data, "tui.select.down") ? 1 : 0;
    // ↑ above the first row goes back up into the editor.
    if (step === -1 && index === 0) return active.end({ reason: "left" });
    if (step === 0) {
      // A key the list does not take is the editor's: closing gives the editor
      // the focus back at once, and the key goes on to it.
      active.end({ reason: "left" });
      (tui.getFocusedComponent?.() as FocusedEditor | null | undefined)?.handleInput?.(data);
      return;
    }
    moveSelection(active, rows, step);
    requestRender?.();
  };

  return {
    focus(focusUI, focusOptions = {}) {
      if (stopped || focus !== undefined || widgetRows(board.workers(), now()).rows.length === 0) {
        return Promise.resolve({ reason: focus === undefined ? "empty" : "left" });
      }
      return focusUI.custom<WidgetFocusResult>((tui, _theme, keys, done) => {
        const active: Focus = { selected: focusOptions.select, index: 0, end: (result) => {
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
          handleInput: (data: string) => { if (focus === active) onKey(active, keys, tui as unknown as FocusTui, data); },
          // pi closes the overlay on its own only when it drops the whole UI, as on a reload.
          dispose: () => active.end({ reason: "left" }),
        };
      }, { overlay: true, overlayOptions: FOCUS_OVERLAY });
    },
    downEnters(data) {
      if (stopped || focus !== undefined || requestRender === undefined || widgetRows(board.workers(), now()).rows.length === 0) return false;
      return downDoesNothing(widgetTui?.getFocusedComponent?.(), data);
    },
    stop() {
      stopped = true;
      unsubscribe();
      hide();
    },
  };
}
