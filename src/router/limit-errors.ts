import type { UsageObservation } from "./usage-observations.ts";

// The first usage signal (PRD cml8, "Signals"): the error text a worker's
// rung ends with. pi exposes no remaining balance, so a usage-limit error
// (the account's allowance is used up until a reset) and a rate-limit error
// (too many requests for now) are read from the provider's error message.
//
// The texts, as pi 0.87.1 passes them on:
//   openai-codex  "You have hit your ChatGPT usage limit (plus plan). Try again
//                 in ~42 min." for any 429 or usage_limit_reached,
//                 usage_not_included or rate_limit_exceeded code, the reset
//                 left out when Codex names none (pi-ai
//                 openai-codex-responses.js parseErrorResponse); on the
//                 WebSocket path "Codex error: <message or code>".
//   anthropic     "You're out of extra usage." (src/catalog/upstream-mapping.ts),
//                 and a throttle as the SDK's `429 {"type":"error","error":
//                 {"type":"rate_limit_error","message":"This request would
//                 exceed the rate limit"}}` (src/routing/session-classifier-call.test.ts).

//   quota and billing  the texts pi-ai never retries (retry.ts,
//                 NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), such as OpenAI's
//                 insufficient_quota: the allowance is used up, so exhausted.

const USAGE_LIMIT = /usage.?limit|usage_not_included|out of extra usage|insufficient_quota|quota.?exceeded|out of budget|billing|available balance/i;
const RATE_LIMIT = /rate.?limit|too many requests|\b429\b/i;
/** "Try again in ~42 min.", "try again in 20s". */
const TRY_AGAIN_IN = /try again in\s*~?\s*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?)\b/i;

function stated(text: string, at: Date): string | undefined {
  const match = TRY_AGAIN_IN.exec(text);
  if (match === null) return undefined;
  const unit = match[2]!.toLowerCase();
  const seconds = unit.startsWith("h") ? 3600 : unit.startsWith("m") ? 60 : 1;
  return new Date(at.getTime() + Number(match[1]) * seconds * 1000).toISOString();
}

/** The usage observation a rung's error text at `at` gives, or `undefined`
 *  when it is not a limit error. A usage limit is exhausted, a rate limit
 *  throttled, each until the reset the text states. */
export function limitErrorObservation(text: string, at: Date): UsageObservation | undefined {
  const state = USAGE_LIMIT.test(text) ? "exhausted" : RATE_LIMIT.test(text) ? "throttled" : undefined;
  if (state === undefined) return undefined;
  const resetsAt = stated(text, at);
  return { state, ...(resetsAt === undefined ? {} : { resetsAt }), observedAt: at.toISOString(), source: "error" };
}
