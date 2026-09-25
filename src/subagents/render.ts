import { truncateToVisualLines, type AgentToolResult, type Theme, type ToolDefinition, type ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import type { SubagentProgress, SubagentsProgressDetails } from "./extension.ts";

// The subagents tool in pi's TUI: the call is one header line, and the result,
// partial or final, is one line per worker with its agent, its short task and
// its current tool or state. Expanded, each finished worker's final text
// follows its line. The text is built by pure functions; the component only
// wraps it to the render width.

type Component = ReturnType<NonNullable<ToolDefinition["renderCall"]>>;

/** The label of a worker whose item names no agent definition. */
const NO_AGENT = "worker";
const SHORT_TASK_LENGTH = 60;

/** A plain text component. pi-tui's Text does not resolve from here, so this
 *  wraps through pi's truncateToVisualLines, which uses it. */
function textComponent(text: string): Component {
  return { render: (width) => truncateToVisualLines(text, Number.POSITIVE_INFINITY, width).visualLines, invalidate() {} };
}

/** The task's first line, its whitespace collapsed, cut at 60 characters. */
function shortTask(task: string): string {
  const line = (task.trim().split(/\r?\n/, 1)[0] ?? "").replace(/\s+/g, " ");
  return line.length <= SHORT_TASK_LENGTH ? line : `${line.slice(0, SHORT_TASK_LENGTH - 1).trimEnd()}…`;
}

function stateText(item: SubagentProgress, theme: Theme): string {
  switch (item.status) {
    case "queued": return theme.fg("muted", "queued");
    case "running": return theme.fg("warning", item.tool === undefined ? "running" : `running: ${item.tool}`);
    case "completed": return theme.fg("success", "done");
    case "failed": return theme.fg("error", "error");
    case "aborted": return theme.fg("warning", "aborted");
    case "not-started": return theme.fg("muted", "not started");
  }
}

function workerLine(item: SubagentProgress, theme: Theme): string {
  const separator = theme.fg("muted", " · ");
  const parts = [theme.fg("accent", item.agent ?? NO_AGENT), theme.fg("dim", shortTask(item.task)), stateText(item, theme)];
  const model = item.status === "queued" ? undefined : item.model;
  if (model !== undefined) {
    const exception = item.status !== "queued" && item.banListException === true ? ` ${theme.fg("warning", "(ban-list exception)")}` : "";
    parts.push(`${theme.fg("dim", model)}${exception}`);
  }
  return parts.join(separator);
}

/** What follows a finished worker's line when the result is expanded. */
function workerBody(item: SubagentProgress, theme: Theme): string[] {
  if (item.status === "queued" || item.status === "running") return [];
  const body: string[] = [];
  if (item.status === "failed") body.push(theme.fg("error", `Error: ${item.error ?? "unknown"}`));
  if (item.finalText !== "") body.push(theme.fg("toolOutput", item.finalText));
  else if (item.status === "completed") body.push(theme.fg("muted", "(no final text)"));
  return body;
}

/** The call's header: the tool's name and how many tasks it hands out. The
 *  arguments may still be streaming, so any shape is accepted. */
export function subagentsCallText(args: unknown, theme: Theme): string {
  const items = (args as { items?: unknown } | undefined)?.items;
  const title = theme.fg("toolTitle", theme.bold("subagents"));
  if (!Array.isArray(items) || items.length === 0) return title;
  return `${title} ${theme.fg("muted", `${items.length} ${items.length === 1 ? "task" : "tasks"}`)}`;
}

/** One line per worker; expanded, each finished worker's final text or error follows its line. */
export function subagentsResultText(details: SubagentsProgressDetails, expanded: boolean, theme: Theme): string {
  if (!expanded) return details.results.map((item) => workerLine(item, theme)).join("\n");
  return details.results.map((item) => [workerLine(item, theme), ...workerBody(item, theme)].join("\n")).join("\n\n");
}

export function renderSubagentsCall(args: unknown, theme: Theme): Component {
  return textComponent(subagentsCallText(args, theme));
}

/** A partial or final result. Without per-worker details, as when the call
 *  was refused, it shows the result's text. */
export function renderSubagentsResult(result: AgentToolResult<unknown>, options: ToolRenderResultOptions, theme: Theme): Component {
  const details = result.details as SubagentsProgressDetails | undefined;
  if (details === undefined || !Array.isArray(details.results) || details.results.length === 0) {
    return textComponent(result.content.map((part) => part.type === "text" ? part.text : "").join(""));
  }
  return textComponent(subagentsResultText(details, options.expanded, theme));
}
