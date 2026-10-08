import { readFileSync } from "node:fs";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  BranchSummaryMessageComponent,
  CompactionSummaryMessageComponent,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  CustomMessageComponent,
  getMarkdownTheme,
  parseSessionEntries,
  SessionManager,
  ToolExecutionComponent,
  UserMessageComponent,
  type AgentSessionEvent,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { REPORT_TOOL } from "./report.ts";
import { renderSubagentsCall, renderSubagentsResult, textComponent, type Component } from "./render.ts";
import { SUBAGENTS_TOOL } from "./worker.ts";

// A worker's transcript as pi draws a session (epic a338): its messages go
// into pi's own message components, the way pi's interactive mode feeds its
// chat (assistant text and thinking, tool calls with their results through
// each tool's renderers, custom messages, summaries), so the transcript looks
// like pi and honours the tool-output expand toggle. Two kinds of message are
// marked, because the task prompt and ordinary tool calls look the same
// otherwise: the worker's `report` tool calls (report.ts), and the steers and
// follow-ups subagents_message sends it, which arrive in its session as plain
// user messages (message.ts, worker.ts). The ones the user sent from the
// transcript view are marked as the user's (user-steering.ts).

/** What a transcript needs of pi's TUI: its tool components ask it to redraw. */
export interface TranscriptTui {
  requestRender(): void;
}

/** A tool's renderers, as pi's ToolExecutionComponent takes them. */
type ToolRenderers = NonNullable<ConstructorParameters<typeof ToolExecutionComponent>[4]>;

/** One drawn piece of a transcript. */
interface Part {
  render(width: number): string[];
  setExpanded?(expanded: boolean): void;
}

interface ContentPart {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly arguments?: unknown;
}

/** A message of a worker's session, as much as the transcript reads of it.
 *  pi's message types live in packages this repository cannot name. */
interface SessionMessage {
  readonly role: string;
  readonly content?: string | readonly ContentPart[];
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly toolCallId?: string;
  readonly display?: boolean;
  readonly command?: string;
  readonly output?: string;
  readonly exitCode?: number;
  readonly cancelled?: boolean;
  readonly truncated?: boolean;
  readonly fullOutputPath?: string;
  readonly excludeFromContext?: boolean;
}

/** How a user message reached a worker's session. */
export type UserMessageKind =
  /** The task the worker was given, or a resume's task. */
  | "prompt"
  /** A subagents_message steer: it arrived while the worker was working. */
  | "steer"
  /** A subagents_message follow-up: it arrived when the worker would have stopped. */
  | "followUp"
  /** Part of the orchestrator's conversation a forked worker starts from (ADR 0008). */
  | "inherited";

function textOf(content: SessionMessage["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
}

/** How each user message of a worker's session came in, by its index.
 *  `tasks` are the tasks the delegation was given (each run of it on the
 *  board). The first user message with one of them is the task prompt, or the
 *  first user message when none matches; a fork's copied conversation comes
 *  before it. After it, a user message without a task's text came from
 *  subagents_message: a steer when it followed a tool result, a follow-up otherwise. */
export function userMessageKinds(messages: readonly unknown[], tasks: readonly string[]): Map<number, UserMessageKind> {
  const known = new Set(tasks.map((task) => task.trim()));
  const list = messages as readonly SessionMessage[];
  const users = list.flatMap((message, index) => message.role === "user" ? [index] : []);
  const first = users.find((index) => known.has(textOf(list[index]!.content).trim())) ?? users[0];
  const kinds = new Map<number, UserMessageKind>();
  for (const index of users) {
    const previous = list[index - 1];
    kinds.set(index, first === undefined || index < first ? "inherited"
      : index === first || known.has(textOf(list[index]!.content).trim()) ? "prompt"
      : previous?.role === "toolResult" || previous?.stopReason === "toolUse" ? "steer" : "followUp");
  }
  return kinds;
}

const MARKS: Partial<Record<UserMessageKind, string>> = {
  steer: "▸ Steer from the orchestrator",
  followUp: "▸ Follow-up from the orchestrator",
};

/** The marks of a steer or follow-up the user sent from the transcript view (user-steering.ts). */
const USER_MARKS: Partial<Record<UserMessageKind, string>> = {
  steer: "▸ Steer from the user",
  followUp: "▸ Follow-up from the user",
};

const EMPTY: Component = { render: () => [], invalidate() {} };

/** The board's task is the one task card in the transcript, even before its
 *  prompt reaches the worker's session. Pi's Markdown renderer handles both
 *  the preview and the full task, including lists and code spans. */
function taskPart(task: string, theme: Theme): Part {
  const lines = task.trim().split(/\r?\n/);
  const preview = lines.slice(0, 3).map((line) => line.length > 100 ? `${line.slice(0, 99).trimEnd()}…` : line).join("\n");
  const shortened = preview !== task.trim();
  const markdown = getMarkdownTheme();
  const brief = new Markdown(preview, 0, 0, markdown);
  const full = new Markdown(task, 0, 0, markdown);
  let expanded = false;
  return {
    setExpanded: (value) => { expanded = value; },
    render: (width) => [
      ...(expanded ? full : brief).render(width),
      ...(shortened && !expanded ? [theme.fg("dim", "ctrl+o to expand task")] : []),
    ],
  };
}

/** The worker's `report` tool, marked: its call shows the kind and text, and a
 *  question's result the orchestrator's answer. */
const REPORT_RENDERERS: ToolRenderers = {
  renderCall: (args: { kind?: unknown; text?: unknown } | undefined, theme: Theme) => {
    const label = args?.kind === "question" ? "◆ Report: question" : "◆ Report: progress";
    return textComponent([theme.fg("warning", theme.bold(label)), typeof args?.text === "string" ? args.text : ""].join("\n"));
  },
  renderResult: (result: { content?: readonly ContentPart[] }, _options: unknown, theme: Theme) => {
    const text = textOf(result.content);
    if (text === "Progress sent.") return EMPTY;
    const answer = /^The orchestrator answered: ([\s\S]*)$/.exec(text)?.[1];
    return textComponent(answer === undefined ? theme.fg("toolOutput", text) : `${theme.fg("warning", "Answer:")} ${answer}`);
  },
};

/** The subagents tool's own drawing, for a worker that delegates (ADR 0008). */
const SUBAGENTS_RENDERERS: ToolRenderers = {
  renderCall: (args: unknown, theme: Theme) => renderSubagentsCall(args, theme),
  renderResult: (result: Parameters<typeof renderSubagentsResult>[0], options: Parameters<typeof renderSubagentsResult>[1], theme: Theme) =>
    renderSubagentsResult(result, options, theme),
};

/** pi's built-in tools, whose renderers pi adds to a session's definitions the same way. */
function builtInRenderers(cwd: string): Record<string, ToolRenderers> {
  return {
    read: createReadToolDefinition(cwd), bash: createBashToolDefinition(cwd), edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd), grep: createGrepToolDefinition(cwd), find: createFindToolDefinition(cwd),
    ls: createLsToolDefinition(cwd), [SUBAGENTS_TOOL]: SUBAGENTS_RENDERERS,
  };
}

export interface TranscriptContext {
  readonly tui: TranscriptTui;
  readonly theme: Theme;
  /** The worker's working directory, for the built-in tools' paths. */
  readonly cwd: string;
  /** The tasks the delegation was given, which tell its task prompts from steers and follow-ups. */
  readonly tasks: readonly string[];
  /** The worker's own tool definitions, for their renderers: a running worker's
   *  session has them. Without them, pi's built-in tools and the subagents tool
   *  keep their drawing and any other tool gets pi's plain one. */
  readonly toolDefinition?: (name: string) => ToolRenderers | undefined;
  /** Whether tool output starts expanded. */
  readonly expanded?: boolean;
  /** Whether the user, not the orchestrator, sent a steer or follow-up with this text; asked at each render. */
  readonly sentByUser?: (text: string) => boolean;
}

/** One worker's transcript: its messages as pi's components, and the reply
 *  still streaming when it is live. Components are kept per message and per
 *  tool call, so a live update only builds what is new. */
export class Transcript {
  readonly #context: TranscriptContext;
  readonly #markdown = getMarkdownTheme();
  #builtIn: Record<string, ToolRenderers> | undefined;
  #expanded: boolean;
  #parts: Part[] = [];
  readonly #task: Part | undefined;
  readonly #byMessage = new WeakMap<object, Part[]>();
  readonly #tools = new Map<string, ToolExecutionComponent>();
  /** Tool calls whose final result is shown. */
  readonly #finished = new Set<string>();
  #messages: readonly SessionMessage[] = [];
  #streaming: { message: SessionMessage; component: AssistantMessageComponent } | undefined;

  constructor(context: TranscriptContext) {
    this.#context = context;
    this.#expanded = context.expanded ?? false;
    const task = context.tasks.at(-1);
    this.#task = task ? taskPart(task, context.theme) : undefined;
    this.#task?.setExpanded?.(this.#expanded);
    if (this.#task !== undefined) this.#parts = [this.#task];
  }

  /** Shows the worker's messages so far. */
  update(messages: readonly unknown[]): void {
    this.#messages = messages as readonly SessionMessage[];
    this.#rebuild();
  }

  /** Moves a live transcript on by one of the worker's session events: the
   *  reply as it streams, and each tool as it runs. */
  event(event: AgentSessionEvent): void {
    switch (event.type) {
      case "message_start":
      case "message_update": {
        const message = event.message as unknown as SessionMessage;
        if (message.role !== "assistant") return;
        this.#streaming ??= { message, component: new AssistantMessageComponent(undefined, false, this.#markdown) };
        this.#streaming.message = message;
        this.#streaming.component.updateContent(event.message as never, true);
        break;
      }
      case "message_end":
        this.#streaming = undefined;
        break;
      case "tool_execution_start":
        this.#tool(event.toolCallId, event.toolName, event.args).markExecutionStarted();
        break;
      case "tool_execution_update":
        if (!this.#finished.has(event.toolCallId)) this.#tools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
        break;
      case "tool_execution_end":
        this.#tools.get(event.toolCallId)?.updateResult({ ...event.result, isError: event.isError });
        break;
      default:
        return;
    }
    this.#rebuild();
  }

  /** The tool-output expand toggle, as pi's app.tools.expand. */
  setExpanded(expanded: boolean): void {
    this.#expanded = expanded;
    for (const part of this.#parts) part.setExpanded?.(expanded);
  }

  /** The task may be pinned above an overlay's body when collapsed. */
  renderTask(width: number): string[] {
    return this.#task?.render(width) ?? [];
  }

  render(width: number, includeTask = true): string[] {
    return this.#parts.flatMap((part) => part === this.#task && !includeTask ? [] : part.render(width));
  }

  /** The transcript is no longer shown. A tool still running gets an empty
   *  final result: pi's bash renderer ticks its elapsed time on a timer that
   *  only a final result stops, and this transcript will hear no more events. */
  dispose(): void {
    for (const [id, component] of this.#tools) {
      if (!this.#finished.has(id)) component.updateResult({ content: [], isError: false });
      this.#finished.add(id);
    }
    this.#streaming = undefined;
  }

  #rebuild(): void {
    const parts: Part[] = this.#task === undefined ? [] : [this.#task];
    const messages = this.#messages;
    const kinds = userMessageKinds(messages, this.#context.tasks);
    for (const [index, message] of messages.entries()) {
      switch (message.role) {
        case "assistant":
          parts.push(...this.#cached(message, () => [new AssistantMessageComponent(message as never, false, this.#markdown)]));
          parts.push(...this.#toolCalls(message, false));
          break;
        case "toolResult": {
          const id = message.toolCallId;
          if (id === undefined || this.#finished.has(id)) break;
          this.#tools.get(id)?.updateResult(message as never);
          this.#finished.add(id);
          break;
        }
        case "user": {
          const kind = kinds.get(index) ?? "prompt";
          if (kind !== "prompt") parts.push(...this.#cached(message, () => this.#user(message, kind, parts.length === 0)));
          break;
        }
        default:
          parts.push(...this.#cached(message, () => this.#other(message)));
      }
    }
    const streaming = this.#streaming;
    if (streaming) parts.push(streaming.component, ...this.#toolCalls(streaming.message, true));
    this.#parts = parts;
  }

  #cached(message: SessionMessage, build: () => Part[]): Part[] {
    let parts = this.#byMessage.get(message);
    if (parts === undefined) {
      parts = build();
      for (const part of parts) part.setExpanded?.(this.#expanded);
      this.#byMessage.set(message, parts);
    }
    return parts;
  }

  /** A reply's tool calls, one component each, kept by tool call id from the
   *  streaming reply to the saved one. A reply that was aborted or failed ends
   *  its calls without results, as pi shows it. */
  #toolCalls(message: SessionMessage, streaming: boolean): Part[] {
    if (typeof message.content === "string" || message.content === undefined) return [];
    const parts: Part[] = [];
    for (const call of message.content) {
      if (call.type !== "toolCall" || call.id === undefined) continue;
      const component = this.#tool(call.id, call.name ?? "", call.arguments);
      if (streaming) component.updateArgs(call.arguments);
      else if (!this.#finished.has(call.id)) {
        component.setArgsComplete();
        if (message.stopReason === "aborted" || message.stopReason === "error") {
          component.updateResult({ content: [{ type: "text", text: message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error" }], isError: true });
          this.#finished.add(call.id);
        }
      }
      parts.push(steadyTool(component, this.#context.theme));
    }
    return parts;
  }

  #tool(id: string, name: string, args: unknown): ToolExecutionComponent {
    let component = this.#tools.get(id);
    if (component === undefined) {
      component = new ToolExecutionComponent(name, id, args, {}, this.#renderers(name), this.#context.tui as never, this.#context.cwd);
      component.setExpanded(this.#expanded);
      this.#tools.set(id, component);
    }
    return component;
  }

  /** A tool's renderers: the report tool's marked ones, else the worker's own
   *  definition with pi's built-in renderers filling in, as pi does. */
  #renderers(name: string): ToolRenderers | undefined {
    if (name === REPORT_TOOL) return REPORT_RENDERERS;
    const own = this.#context.toolDefinition?.(name);
    const builtIn = (this.#builtIn ??= builtInRenderers(this.#context.cwd))[name];
    if (own === undefined || builtIn === undefined) return own ?? builtIn;
    return { ...own, renderCall: own.renderCall ?? builtIn.renderCall, renderResult: own.renderResult ?? builtIn.renderResult };
  }

  #user(message: SessionMessage, kind: UserMessageKind, first: boolean): Part[] {
    const text = textOf(message.content);
    if (text === "") return [];
    const component = new UserMessageComponent(text, this.#markdown);
    const { theme, sentByUser } = this.#context;
    const spacer = first ? [] : [""];
    return [{ render: (width) => {
      // At render, not when the part is built: the user's steer is recorded once it was sent, which may be after it reached the session.
      const mark = (sentByUser?.(text) === true ? USER_MARKS : MARKS)[kind];
      return [...spacer, ...(mark === undefined ? [] : [theme.fg("warning", theme.bold(mark))]), ...component.render(width)];
    } }];
  }

  /** Custom messages, summaries and user shell commands, as pi's chat shows them. */
  #other(message: SessionMessage): Part[] {
    const markdown = this.#markdown;
    switch (message.role) {
      case "custom":
        // A custom message's own renderer is registered in the worker's session, out of reach here.
        return message.display === true ? [new CustomMessageComponent(message as never, undefined, markdown)] : [];
      case "compactionSummary":
        return [spaced(new CompactionSummaryMessageComponent(message as never, markdown))];
      case "branchSummary":
        return [spaced(new BranchSummaryMessageComponent(message as never, markdown))];
      case "bashExecution": {
        const component = new BashExecutionComponent(message.command ?? "", this.#context.tui as never, message.excludeFromContext);
        if (message.output) component.appendOutput(message.output);
        component.setComplete(message.exitCode, message.cancelled === true, message.truncated ? { truncated: true } as never : undefined, message.fullOutputPath);
        return [component];
      }
      default:
        return [];
    }
  }
}

/** pi paints a tool call's box by its state: pending, then done or failed.
 *  The tint changes when the call completes, and that repaints every line of
 *  the box. A changed line above the bottom of the terminal makes pi-tui reprint
 *  the whole screen, and a scrolled-up transcript jumps to the bottom
 *  (tui-main-screen.js, doRender). So the transcript keeps the pending tint in
 *  every state: a finished call then changes only its last line, its elapsed time. */
function steadyToolTint(theme: Theme): (line: string) => string {
  const paint = (color: "toolPendingBg" | "toolSuccessBg" | "toolErrorBg"): string => {
    const mark = "\u0000";
    const painted = theme.bg(color, mark);
    const at = painted.indexOf(mark);
    return at < 0 ? "" : painted.slice(0, at);
  };
  const pending = paint("toolPendingBg");
  if (pending === "") return (line) => line;
  const others = [paint("toolSuccessBg"), paint("toolErrorBg")].filter((code) => code !== "" && code !== pending);
  return (line) => others.reduce((text, code) => text.split(code).join(pending), line);
}

/** A tool call's box, drawn with the steady tint. */
function steadyTool(component: ToolExecutionComponent, theme: Theme): Part {
  return {
    render: (width) => component.render(width).map(steadyToolTint(theme)),
    setExpanded: (expanded) => component.setExpanded(expanded),
  };
}

/** A component after an empty line, as pi's chat spaces summaries. */
function spaced(component: Part): Part {
  return { render: (width) => ["", ...component.render(width)], setExpanded: (expanded) => component.setExpanded?.(expanded) };
}

/** A finished worker's messages from its saved session file. The file is only
 *  read: it is parsed and built in memory, because SessionManager.open may
 *  write to it (a version migration, an empty file's header). */
export function readWorkerTranscript(file: string): readonly unknown[] {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));
  if (entries.length === 0) throw new Error(`${file} holds no session`);
  return SessionManager.inMemory(process.cwd(), undefined, entries).buildSessionContext().messages;
}
