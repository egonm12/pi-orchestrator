// Local subset of @earendil-works/pi-coding-agent's extension types.
// That package resolves only inside a running pi session, not from this
// project's dependency tree (confirmed: .scratch/pi-orchestration-harness/
// issues/01-findings.md §E.1). These types mirror only what this harness
// uses, sourced from its installed types.d.ts.

export interface ToolCallEvent {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
  terminate?: boolean;
}

// types.d.ts:771: the union's CustomToolResultEvent arm (:766) is what
// `subagent` reports through, so toolName is widened to string here.
export interface ToolResultEvent {
  type: "tool_result";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: unknown[];
  isError: boolean;
}

// types.d.ts:845: no cancel/terminate field, so a handler cannot abort the
// turn by returning; the registry probe exits the process instead.
export interface BeforeAgentStartEvent {
  type: "before_agent_start";
  prompt: string;
  systemPrompt: string;
}

// types.d.ts:1198
export interface ToolInfo {
  name: string;
  description?: string;
}

// types.d.ts:417
export interface SessionStartEvent {
  type: "session_start";
  reason: "startup" | "reload" | "new" | "resume" | "fork";
}

// types.d.ts:698. A notification: it has no result, so a selection cannot be
// cancelled from here.
export interface ModelSelectEvent {
  type: "model_select";
  model: ModelInfo;
  previousModel: ModelInfo | undefined;
  source: "set" | "cycle" | "restore";
}

// types.d.ts:723
export interface InputEvent {
  type: "input";
  text: string;
  source: "interactive" | "rpc" | "extension";
}

// types.d.ts:735, the two arms this harness uses. `handled` stops the input
// before the agent loop, so no turn runs.
export type InputEventResult = { action: "continue" } | { action: "handled" };

// types.d.ts:643
export interface TurnStartEvent {
  type: "turn_start";
  turnIndex: number;
  timestamp: number;
}

/** The part of pi's `Model` this harness reads (`Model<any>`, pi-ai; used by
 *  `ctx.model` at types.d.ts:224 and `ModelSelectEvent.model` at :700). */
export interface ModelInfo {
  provider: string;
  id: string;
}

/** One entry of pi's model registry, as `toModelInfo` (pi-subagents,
 *  src/shared/model-info.js) reads it. */
export interface RegistryModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

// The part of pi-ai's streaming types (dist/types.d.ts) the in-session
// classifier call uses: `Context` (:438), `SimpleStreamOptions` (:224, with
// `signal` and `maxTokens` from `StreamOptions`), `AssistantMessage` (:353)
// and `AssistantMessageEvent` (:470).

export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface StreamContext {
  systemPrompt?: string;
  messages: { role: "user"; content: string; timestamp: number }[];
}

export interface StreamSimpleOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  reasoning?: ThinkingLevel;
}

export interface StreamedAssistantMessage {
  role: "assistant";
  content: { type: string; text?: string; thinking?: string }[];
  stopReason: string;
  errorMessage?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: unknown };
  };
}

export type AssistantMessageEvent =
  | { type: "start" | "text_start" | "text_end" | "thinking_start" | "thinking_end" | "toolcall_start" | "toolcall_end" }
  | { type: "text_delta" | "thinking_delta" | "toolcall_delta"; delta: string }
  | { type: "done"; reason: string; message: StreamedAssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: StreamedAssistantMessage };

/** pi's `ModelRegistry` as extensions see it (installed pi-coding-agent
 *  0.87.1, dist/core/model-registry.d.ts). `streamSimple` streams through the
 *  configured provider with request-time auth, and is the path the Anthropic
 *  subscription auth package shapes (its src/oauth-transport.ts); pi-ai's own
 *  `compat.streamSimple` is not shaped. It returns an
 *  `AssistantMessageEventStream`, an async iterable of events. */
export interface SessionModelRegistry {
  // :27, the call pi-subagents itself makes (src/agents/agent-management.js:1080).
  getAvailable(): RegistryModel[];
  // :28
  find(provider: string, modelId: string): RegistryModel | undefined;
  // :36
  streamSimple(model: RegistryModel, context: StreamContext, options?: StreamSimpleOptions): AsyncIterable<AssistantMessageEvent>;
}

export interface ExtensionContext {
  hasUI: boolean;
  cwd: string;
  // types.d.ts:224
  model?: ModelInfo;
  // types.d.ts:222
  modelRegistry?: SessionModelRegistry;
  // types.d.ts:220 (`ReadonlySessionManager`, session-manager.d.ts:246).
  sessionManager?: { getSessionId(): string };
  // types.d.ts:212, only `notify` is used here.
  ui?: { notify(message: string, type?: "info" | "warning" | "error"): void };
  // types.d.ts:239
  abort?(): void;
}

export type ExtensionHandler<E, R = undefined> = (
  event: E,
  ctx: ExtensionContext,
) => Promise<R | void> | R | void;

export interface ExtensionAPI {
  on(
    event: "tool_call",
    handler: ExtensionHandler<ToolCallEvent, ToolCallEventResult>,
  ): void;
  on(event: "tool_result", handler: ExtensionHandler<ToolResultEvent>): void;
  on(
    event: "before_agent_start",
    handler: ExtensionHandler<BeforeAgentStartEvent>,
  ): void;
  on(event: "session_start", handler: ExtensionHandler<SessionStartEvent>): void;
  on(event: "model_select", handler: ExtensionHandler<ModelSelectEvent>): void;
  on(event: "input", handler: ExtensionHandler<InputEvent, InputEventResult>): void;
  on(event: "turn_start", handler: ExtensionHandler<TurnStartEvent>): void;
  // types.d.ts:997
  getAllTools(): ToolInfo[];
}

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;
