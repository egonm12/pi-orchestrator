// The classifier model call inside the running pi session (ADR 0004). The
// router extension calls it for a worker's first request to the auto model,
// so each hop is one request
// through the session's own model registry, `ctx.modelRegistry.streamSimple`,
// instead of a fresh `pi -p` child (./pi-classifier-call.ts): no pi startup,
// and the same auth the session has. On the Anthropic subscription route that
// is the path the auth package shapes; pi-ai's `compat.streamSimple` is not
// shaped and is not used.
//
// The contract is the subprocess's: the classifier system prompt and the
// rubric prompt as the one user message, no tools, the rung's effort clamped
// as `pi --thinking` clamps it, the hop's `AbortSignal` passed to the stream,
// and the final assistant message read by ./classifier-reply.ts, so a refusal,
// out of usage, a throttle or an error uses the shared error mapping. There
// is no pi session-level auto-retry. maxTokens is set to
// CLASSIFIER_MAX_OUTPUT_TOKENS; provider thinking can raise that ceiling.

import { splitKnownThinkingSuffix } from "../models/model-info.ts";
import type {
  AssistantMessageEvent,
  RegistryModel,
  SessionModelRegistry,
  StreamedAssistantMessage,
  ThinkingLevel,
} from "./model-stream.ts";
import { CLASSIFIER_SYSTEM_PROMPT, piClassifierReplyFromMessage, type PiClassifierReply } from "./classifier-reply.ts";
import { CLASSIFIER_MAX_OUTPUT_TOKENS } from "./tier-classifier.ts";

/** What one call took, for the router's probe line. */
export interface SessionClassifierCallReport {
  readonly rung: string;
  /** Until the first text, thinking or tool-call delta; absent when none came. */
  readonly firstTokenMs?: number;
  readonly totalMs: number;
  readonly reply?: PiClassifierReply;
  readonly error?: string;
}

export interface SessionClassifierCallOptions {
  /** Milliseconds; defaults to `performance.now`. */
  readonly now?: () => number;
  readonly onCallEnd?: (report: SessionClassifierCallReport) => void;
}

// pi-ai's `getSupportedThinkingLevels` and `clampThinkingLevel`
// (dist/models.js:553-583, installed pi-ai 0.87.1), which `pi --thinking`
// applies to the session model (pi-coding-agent dist/core/sdk.js:138). pi-ai
// does not resolve from this project, so the rule is restated here.
const EXTENDED_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type ModelThinkingLevel = (typeof EXTENDED_THINKING_LEVELS)[number];

function supportedThinkingLevels(model: RegistryModel): ModelThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  return EXTENDED_THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

function clampThinkingLevel(model: RegistryModel, level: ModelThinkingLevel): ModelThinkingLevel {
  const available = supportedThinkingLevels(model);
  if (available.includes(level)) return level;
  const requested = EXTENDED_THINKING_LEVELS.indexOf(level);
  for (let index = requested; index < EXTENDED_THINKING_LEVELS.length; index += 1) {
    const candidate = EXTENDED_THINKING_LEVELS[index]!;
    if (available.includes(candidate)) return candidate;
  }
  for (let index = requested - 1; index >= 0; index -= 1) {
    const candidate = EXTENDED_THINKING_LEVELS[index]!;
    if (available.includes(candidate)) return candidate;
  }
  return available[0] ?? "off";
}

/** pi's agent sends no reasoning option for `off` (pi-agent-core
 *  dist/agent.js:305). A rung without an effort is `off`, as `pi` without
 *  `--thinking` would not be; the chain refuses such a rung at load anyway. */
export function streamReasoning(model: RegistryModel, effort: string): ThinkingLevel | undefined {
  const level = EXTENDED_THINKING_LEVELS.find((candidate) => candidate === effort) ?? "off";
  const clamped = clampThinkingLevel(model, level);
  return clamped === "off" ? undefined : clamped;
}

/** Rejects when `signal` aborts, so the call returns even if a provider
 *  ignores the abort and never ends the stream. */
function abortedBy(signal: AbortSignal): { promise: Promise<never>; dispose(): void } {
  let onAbort: (() => void) | undefined;
  const promise = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Error("pi classifier call aborted"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  promise.catch(() => {});
  return { promise, dispose: () => { if (onAbort) signal.removeEventListener("abort", onAbort); } };
}

const DELTA_EVENTS = new Set<AssistantMessageEvent["type"]>(["text_delta", "thinking_delta", "toolcall_delta"]);

export function sessionClassifierModelCall(
  registry: SessionModelRegistry,
  options: SessionClassifierCallOptions = {},
): (prompt: string, rung: string, signal: AbortSignal) => Promise<PiClassifierReply> {
  const now = options.now ?? (() => performance.now());
  return async (prompt, rung, signal) => {
    const started = now();
    let firstTokenMs: number | undefined;
    const report = (outcome: { reply: PiClassifierReply } | { error: string }) =>
      options.onCallEnd?.({ rung, ...(firstTokenMs === undefined ? {} : { firstTokenMs }), totalMs: now() - started, ...outcome });
    const aborted = abortedBy(signal);
    try {
      if (signal.aborted) throw new Error("pi classifier call aborted");
      const { baseModel, thinkingSuffix } = splitKnownThinkingSuffix(rung);
      const slash = baseModel.indexOf("/");
      const model = slash > 0 ? registry.find(baseModel.slice(0, slash), baseModel.slice(slash + 1)) : undefined;
      if (model === undefined) throw new Error(`pi's model registry has no ${baseModel}`);
      const reasoning = streamReasoning(model, thinkingSuffix.slice(1));
      const stream = registry.streamSimple(
        model,
        { systemPrompt: CLASSIFIER_SYSTEM_PROMPT, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
        { signal, maxTokens: CLASSIFIER_MAX_OUTPUT_TOKENS, ...(reasoning === undefined ? {} : { reasoning }) },
      );
      const iterator = stream[Symbol.asyncIterator]();
      let message: StreamedAssistantMessage | undefined;
      let exhausted = false;
      try {
        while (true) {
          if (signal.aborted) throw new Error("pi classifier call aborted");
          const step = await Promise.race([iterator.next(), aborted.promise]);
          if (signal.aborted) throw new Error("pi classifier call aborted");
          if (step.done) { exhausted = true; break; }
          const event = step.value;
          if (firstTokenMs === undefined && DELTA_EVENTS.has(event.type)) firstTokenMs = now() - started;
          if (event.type === "done") { message = event.message; break; }
          if (event.type === "error") { message = event.error; break; }
        }
      } finally {
        // Closing must not hold up fallback when the provider ignores abort.
        // Both synchronous throws and asynchronous rejection are contained.
        if (!exhausted) {
          try { void Promise.resolve(iterator.return?.()).catch(() => {}); } catch { /* best effort */ }
        }
      }
      if (message === undefined) throw new Error("pi's stream ended with no final assistant message");
      const reply = piClassifierReplyFromMessage(message, "no error message");
      report({ reply });
      return reply;
    } catch (error) {
      report({ error: error instanceof Error ? error.message : String(error) });
      throw error;
    } finally {
      aborted.dispose();
    }
  };
}
