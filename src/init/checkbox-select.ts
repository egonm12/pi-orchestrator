import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, wrapTextWithAnsi, type Component, type TUI } from "@earendil-works/pi-tui";

export interface CheckboxSelectUi {
  readonly mode?: string;
  notify?(message: string, type?: "info" | "warning" | "error"): void;
  select(title: string, options: string[]): Promise<string | undefined>;
  custom?<T>(
    factory: (tui: TUI, theme: Theme, keybindings: unknown, done: (result: T) => void) => Component | Promise<Component>,
    options?: { overlay?: boolean },
  ): Promise<T>;
}

export interface CheckboxRowValueConfig {
  readonly choices: Readonly<Record<string, readonly string[]>>;
  readonly initial: Readonly<Record<string, string>>;
}

export interface CheckboxSelectState {
  readonly options: readonly string[];
  readonly cursor: number;
  readonly selected: readonly string[];
  readonly rowValues: Readonly<Record<string, string>>;
  readonly rowValueChoices: Readonly<Record<string, readonly string[]>>;
  readonly validationMessage?: string;
}

export type CheckboxSelectOutcome = "confirm" | "cancel";

export interface CheckboxInputResult {
  readonly state: CheckboxSelectState;
  readonly outcome?: CheckboxSelectOutcome;
}

export interface CheckboxSelectWithValuesResult {
  readonly selected: readonly string[];
  readonly values: Readonly<Record<string, string>>;
}

const FALLBACK_REMOVE = "Remove an entry…";
const FALLBACK_DONE = "Done";
const MAX_VISIBLE_OPTIONS = 12;
export const MIN_SELECTED_MESSAGE = "Tick at least one model";

export interface CheckboxSelectOptions {
  readonly minSelected?: number;
}

function orderedSelection(options: readonly string[], selected: Iterable<string>): string[] {
  const selectedSet = new Set(selected);
  return options.filter((option) => selectedSet.has(option));
}

function normalizeRowValues(options: readonly string[], config?: CheckboxRowValueConfig): {
  rowValues: Record<string, string>;
  rowValueChoices: Record<string, readonly string[]>;
} {
  const rowValues: Record<string, string> = {};
  const rowValueChoices: Record<string, readonly string[]> = {};
  if (!config) return { rowValues, rowValueChoices };
  for (const option of options) {
    const choices = config.choices[option]?.filter((choice, index, all) => all.indexOf(choice) === index) ?? [];
    if (choices.length === 0) continue;
    rowValueChoices[option] = choices;
    const initial = config.initial[option];
    rowValues[option] = initial && choices.includes(initial) ? initial : choices[0]!;
  }
  return { rowValues, rowValueChoices };
}

export function createCheckboxSelectState(
  options: readonly string[],
  preselected: readonly string[] = [],
  rowValueConfig?: CheckboxRowValueConfig,
): CheckboxSelectState {
  const optionList = [...options];
  const { rowValues, rowValueChoices } = normalizeRowValues(optionList, rowValueConfig);
  return {
    options: optionList,
    cursor: 0,
    selected: orderedSelection(optionList, preselected),
    rowValues,
    rowValueChoices,
  };
}

export function checkboxSelectedValues(state: CheckboxSelectState): string[] {
  return orderedSelection(state.options, state.selected);
}

export function checkboxRowValues(state: CheckboxSelectState): Record<string, string> {
  return Object.fromEntries(state.options.flatMap((option) => {
    const value = state.rowValues[option];
    return value === undefined ? [] : [[option, value]];
  }));
}

function moveCursor(state: CheckboxSelectState, delta: number): CheckboxSelectState {
  if (state.options.length === 0) return state;
  return { ...state, cursor: (state.cursor + delta + state.options.length) % state.options.length };
}

function toggleCursor(state: CheckboxSelectState): CheckboxSelectState {
  const value = state.options[state.cursor];
  if (value === undefined) return state;
  const selected = new Set(state.selected);
  if (selected.has(value)) selected.delete(value);
  else selected.add(value);
  return { ...state, selected: orderedSelection(state.options, selected), validationMessage: undefined };
}

function cycleCursorValue(state: CheckboxSelectState, delta: number): CheckboxSelectState {
  const option = state.options[state.cursor];
  if (option === undefined) return state;
  const choices = state.rowValueChoices[option];
  if (!choices || choices.length === 0) return state;
  const current = state.rowValues[option];
  const currentIndex = current ? choices.indexOf(current) : -1;
  const nextIndex = (currentIndex + delta + choices.length) % choices.length;
  return { ...state, rowValues: { ...state.rowValues, [option]: choices[nextIndex]! } };
}

export function applyCheckboxInput(state: CheckboxSelectState, data: string, options: CheckboxSelectOptions = {}): CheckboxInputResult {
  if (matchesKey(data, Key.down)) return { state: moveCursor(state, 1) };
  if (matchesKey(data, Key.up)) return { state: moveCursor(state, -1) };
  if (matchesKey(data, Key.left)) return { state: cycleCursorValue(state, -1) };
  if (matchesKey(data, Key.right)) return { state: cycleCursorValue(state, 1) };
  if (matchesKey(data, Key.space)) return { state: toggleCursor(state) };
  if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
    return state.selected.length < (options.minSelected ?? 0)
      ? { state: { ...state, validationMessage: MIN_SELECTED_MESSAGE } }
      : { state, outcome: "confirm" };
  }
  if (matchesKey(data, Key.escape) || matchesKey(data, Key.esc)) return { state, outcome: "cancel" };
  return { state };
}

function visibleRange(cursor: number, length: number): { start: number; end: number } {
  if (length <= MAX_VISIBLE_OPTIONS) return { start: 0, end: length };
  const half = Math.floor(MAX_VISIBLE_OPTIONS / 2);
  const start = Math.max(0, Math.min(cursor - half, length - MAX_VISIBLE_OPTIONS));
  return { start, end: start + MAX_VISIBLE_OPTIONS };
}

function hasRowValues(state: CheckboxSelectState): boolean {
  return Object.keys(state.rowValueChoices).length > 0;
}

function renderOptionLabel(state: CheckboxSelectState, option: string): string {
  const value = state.rowValues[option];
  return value === undefined ? option : `${option}  ‹ ${value} ›`;
}

function renderCheckboxSelect(
  state: CheckboxSelectState,
  title: string,
  hint: string | undefined,
  theme: Theme,
  width: number,
): string[] {
  const lineWidth = Math.max(20, width);
  const lines: string[] = [];
  lines.push(theme.fg("accent", truncateToWidth(theme.bold(title), lineWidth)));
  if (hint) {
    for (const line of wrapTextWithAnsi(theme.fg("muted", hint), lineWidth)) lines.push(line);
  }
  lines.push(theme.fg("dim", `Selected: ${state.selected.length}`));

  const { start, end } = visibleRange(state.cursor, state.options.length);
  if (start > 0) lines.push(theme.fg("dim", `  … ${start} more above`));
  for (let index = start; index < end; index += 1) {
    const option = state.options[index]!;
    const selected = state.selected.includes(option);
    const cursor = index === state.cursor;
    const marker = `${cursor ? "›" : " "} ${selected ? "[x]" : "[ ]"} ${renderOptionLabel(state, option)}`;
    const rendered = cursor ? theme.fg("accent", marker) : marker;
    lines.push(truncateToWidth(rendered, lineWidth));
  }
  if (end < state.options.length) lines.push(theme.fg("dim", `  … ${state.options.length - end} more below`));
  const valueHint = hasRowValues(state) ? " • ←/→ thinking level" : "";
  lines.push(theme.fg("dim", `↑↓ move • space toggle${valueHint} • enter confirm • esc cancel`));
  if (state.validationMessage) lines.push(theme.fg("warning", state.validationMessage));
  return lines;
}

function makeCheckboxComponent(
  tui: TUI,
  theme: Theme,
  done: (result: CheckboxSelectWithValuesResult | undefined) => void,
  title: string,
  options: readonly string[],
  preselected: readonly string[],
  hint?: string,
  rowValueConfig?: CheckboxRowValueConfig,
  selectOptions: CheckboxSelectOptions = {},
): Component {
  let state = createCheckboxSelectState(options, preselected, rowValueConfig);
  return {
    render(width: number) {
      return renderCheckboxSelect(state, title, hint, theme, width);
    },
    invalidate() {},
    handleInput(data: string) {
      const result = applyCheckboxInput(state, data, selectOptions);
      state = result.state;
      if (result.outcome === "confirm") done({ selected: checkboxSelectedValues(state), values: checkboxRowValues(state) });
      else if (result.outcome === "cancel") done(undefined);
      tui.requestRender();
    },
  };
}

async function fallbackCheckboxSelect(
  ui: CheckboxSelectUi,
  title: string,
  options: readonly string[],
  preselected: readonly string[],
  hint?: string,
  selectOptions: CheckboxSelectOptions = {},
): Promise<string[] | undefined> {
  const chosen = orderedSelection(options, preselected);
  for (;;) {
    const remaining = options.filter((option) => !chosen.includes(option));
    const choice = await ui.select(
      `${title}: ${chosen.join(", ") || "(none)"}${hint ? `. ${hint}` : ""}`,
      [...remaining, ...(chosen.length > 0 ? [FALLBACK_REMOVE] : []), FALLBACK_DONE],
    );
    if (choice === undefined) return undefined;
    if (choice === FALLBACK_DONE) {
      if (chosen.length < (selectOptions.minSelected ?? 0)) {
        ui.notify?.(MIN_SELECTED_MESSAGE, "warning");
        continue;
      }
      return orderedSelection(options, chosen);
    }
    if (choice === FALLBACK_REMOVE) {
      const removed = await ui.select("Remove which entry?", [...chosen, "Back, remove nothing"]);
      if (removed === undefined) return undefined;
      if (removed !== "Back, remove nothing") chosen.splice(chosen.indexOf(removed), 1);
    } else if (remaining.includes(choice)) {
      chosen.push(choice);
    }
  }
}

export function canUseCustomCheckbox(ui: CheckboxSelectUi): boolean {
  return (ui.mode === undefined || ui.mode === "tui") && typeof ui.custom === "function";
}

export async function checkboxSelectWithValues(
  ui: CheckboxSelectUi,
  title: string,
  options: readonly string[],
  preselected: readonly string[],
  rowValueConfig: CheckboxRowValueConfig,
  hint?: string,
  selectOptions: CheckboxSelectOptions = {},
): Promise<CheckboxSelectWithValuesResult | undefined> {
  const optionList = [...options];
  const selected = orderedSelection(optionList, preselected);
  const custom = ui.custom;
  if (!canUseCustomCheckbox(ui) || custom === undefined) {
    const picked = await fallbackCheckboxSelect(ui, title, optionList, selected, hint, selectOptions);
    if (picked === undefined) return undefined;
    const state = createCheckboxSelectState(optionList, selected, rowValueConfig);
    return { selected: picked, values: checkboxRowValues(state) };
  }
  return custom<CheckboxSelectWithValuesResult | undefined>((tui, theme, _keybindings, done) => (
    makeCheckboxComponent(tui, theme, done, title, optionList, selected, hint, rowValueConfig, selectOptions)
  ));
}

export async function checkboxSelect(
  ui: CheckboxSelectUi,
  title: string,
  options: readonly string[],
  preselected: readonly string[],
  hint?: string,
  selectOptions: CheckboxSelectOptions = {},
): Promise<string[] | undefined> {
  const result = await checkboxSelectWithValues(ui, title, options, preselected, { choices: {}, initial: {} }, hint, selectOptions);
  if (Array.isArray(result)) return [...result];
  return result ? [...result.selected] : undefined;
}
