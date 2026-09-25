// The classifier's contract with pi, shared by both real model calls: the
// in-session call the router uses (./session-classifier-call.ts) and the
// `pi -p` subprocess ticket 23's live test uses (./pi-classifier-call.ts).
// Both end in one pi assistant message; this turns it into a reply or the
// error `classifyTier` maps to a hop outcome. The answer text is validated by
// the caller (`checkTierAnswer`), never here.

import { ProviderOutOfUsageError, type ClassifierModelReply } from "./tier-classifier.ts";

export const CLASSIFIER_SYSTEM_PROMPT =
  "You are a task classifier. You never use tools. You answer with one JSON object only.";

export interface PiClassifierUsage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
}

export interface PiClassifierReply extends ClassifierModelReply {
  readonly usage?: PiClassifierUsage;
}

/** pi's final assistant message, the fields read here. */
export interface PiAssistantMessage {
  readonly role?: string;
  readonly content?: ReadonlyArray<{ readonly type?: string; readonly text?: string }>;
  readonly stopReason?: string;
  readonly errorMessage?: string;
  readonly usage?: PiClassifierUsage & { readonly cost?: { readonly total?: unknown } };
}

/** Read only from the provider's error message, never from raw stderr, which
 *  can mention "usage" for unrelated reasons (a CLI usage line, say). A
 *  throttle (`rate_limit_error`) matches too, so it is out of usage. */
const OUT_OF_USAGE = /usage|quota|rate.?limit|credit|billing|balance|budget/i;

/** The reply in `message`, or the error for a message that ended with pi's
 *  `error` or `aborted` stop reason. `noErrorMessage` is the detail used when
 *  the message carries no error message of its own. */
export function piClassifierReplyFromMessage(message: PiAssistantMessage, noErrorMessage: string): PiClassifierReply {
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    const { errorMessage } = message;
    const described = `pi classifier call ended with ${message.stopReason}: ${errorMessage ?? noErrorMessage}`;
    throw errorMessage !== undefined && OUT_OF_USAGE.test(errorMessage)
      ? new ProviderOutOfUsageError(described)
      : new Error(described);
  }
  const text = (message.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("");
  const cost = message.usage?.cost?.total;
  const { cost: _cost, ...usage } = message.usage ?? {};
  return {
    text,
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { reportedUsd: cost } : {}),
    ...(message.usage === undefined ? {} : { usage }),
  };
}
