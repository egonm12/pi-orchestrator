import type {
  AssistantMessageEvent,
  RegistryModel,
  SessionModelRegistry,
  StreamContext,
  StreamedAssistantMessage,
  StreamSimpleOptions,
} from "../routing/model-stream.ts";
import { INSTALLED_MODEL_INFO } from "./installed-model-info.ts";

// A fake of pi's session model registry (`ctx.modelRegistry`) for seam 1 of
// the in-session classifier call: `find` over the installed-model fixture and
// a `streamSimple` that plays a scripted event stream. Each call is recorded
// with the context and options it was given, the abort signal included.

export interface RecordedStreamCall {
  readonly model: RegistryModel;
  readonly context: StreamContext;
  readonly options: StreamSimpleOptions | undefined;
}

/** What one `streamSimple` call does: play these events in order, throw
 *  synchronously (defensive; pi 0.87.1 reports setup and auth failures as an
 *  `error` event, which `errorEvents` scripts), or never end until the call's
 *  signal aborts, then end with pi's `aborted` error event. */
export type StreamScript =
  | { readonly events: readonly AssistantMessageEvent[] }
  | { readonly throws: string }
  | { readonly hangUntilAborted: true };

export interface FakeSessionRegistry extends SessionModelRegistry {
  readonly calls: RecordedStreamCall[];
  readonly finds: (readonly [string, string])[];
}

export function assistantMessage(overrides: Partial<StreamedAssistantMessage> = {}): StreamedAssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { total: 0 } },
    ...overrides,
  };
}

/** A successful stream: start, one thinking delta, the text as one delta, done. */
export function answerEvents(text: string, overrides: Partial<StreamedAssistantMessage> = {}): AssistantMessageEvent[] {
  const message = assistantMessage({ content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text }], ...overrides });
  return [
    { type: "start" },
    { type: "thinking_delta", delta: "hmm" },
    { type: "text_delta", delta: text },
    { type: "done", reason: "stop", message },
  ];
}

/** A stream that fails the way pi-ai ends one: an `error` event whose message
 *  has stopReason `error` and the provider's error message. */
export function errorEvents(errorMessage: string): AssistantMessageEvent[] {
  return [{ type: "error", reason: "error", error: assistantMessage({ stopReason: "error", errorMessage }) }];
}

async function* play(
  script: Exclude<StreamScript, { readonly throws: string }>,
  signal: AbortSignal | undefined,
): AsyncGenerator<AssistantMessageEvent> {
  if ("events" in script) {
    for (const event of script.events) yield event;
    return;
  }
  await new Promise<void>((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
  yield { type: "error", reason: "aborted", error: assistantMessage({ stopReason: "aborted", errorMessage: "Request was aborted" }) };
}

export function fakeSessionRegistry(
  scripts: readonly StreamScript[],
  models: readonly RegistryModel[] = INSTALLED_MODEL_INFO,
): FakeSessionRegistry {
  const calls: RecordedStreamCall[] = [];
  const finds: (readonly [string, string])[] = [];
  return {
    calls,
    finds,
    getAvailable: () => [...models],
    find(provider, modelId) {
      finds.push([provider, modelId]);
      return models.find((model) => model.provider === provider && model.id === modelId);
    },
    streamSimple(model, context, options) {
      const script = scripts[calls.length];
      calls.push({ model, context, options });
      if (script === undefined) throw new Error(`fake registry: no stream scripted for call ${calls.length}`);
      if ("throws" in script) throw new Error(script.throws);
      return play(script, options?.signal);
    },
  };
}
