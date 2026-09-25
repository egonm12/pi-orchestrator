// The part of pi's model registry and pi-ai's streaming types the in-session
// classifier call reads. Structural on purpose: pi's real `ModelRegistry`
// (ctx.modelRegistry, @earendil-works/pi-coding-agent) satisfies it, and tests
// can hand in a fake without building pi's whole registry.

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
