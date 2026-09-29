import { LOW_USAGE_PERCENT, type UsageObservation } from "./usage-observations.ts";

// The second usage signal (PRD cml8, "Signals", story 50): the quota headers
// of a provider's response, as ticket 12's live check captured them
// (src/fixtures/usage/README.md, bean pi-orchestrator-ugoi).
//
//   anthropic     anthropic-ratelimit-unified-{5h,7d}-utilization, a fraction
//                 used (0.05), with -{5h,7d}-reset in Unix seconds. Seen on
//                 the installed packages' shaped path.
//   openai-codex  x-codex-{primary,secondary}-used-percent, a whole percentage
//                 used (2), with -window-minutes (300, 10080) and -reset-at in
//                 Unix seconds. Seen on the SSE path; the WebSocket path fires
//                 no after_provider_response at all.
//
// Each window becomes a percentage left; the provider's is the tightest
// window's, with that window's reset. Only 2xx responses far from a limit
// were captured, so this reads a success response only, never infers a limit
// from a status header, and never makes a provider exhausted or throttled:
// those still come from limit errors (limit-errors.ts). A value outside the
// captured shape (no number, a fraction above 1, a percentage above 100) is
// skipped, not guessed at.

interface Window { readonly left: number; readonly resetsAt?: string }

const ANTHROPIC_WINDOWS = ["5h", "7d"] as const;
const CODEX_WINDOWS = ["primary", "secondary"] as const;
const NUMBER = /^\s*\d+(?:\.\d+)?\s*$/;

/** A plain non-negative decimal, or undefined. */
function numberOf(value: string | undefined): number | undefined {
  return value !== undefined && NUMBER.test(value) ? Number(value) : undefined;
}

/** Unix seconds as an ISO time, or undefined. */
function resetOf(value: string | undefined): string | undefined {
  const seconds = numberOf(value);
  return seconds === undefined || seconds === 0 ? undefined : new Date(seconds * 1000).toISOString();
}

/** Rounded to hundredths, so 1 - 0.9 reads 10 and not 9.999999999999998. */
const hundredths = (value: number) => Math.round(value * 100) / 100;

function window(left: number | undefined, resetsAt: string | undefined): Window[] {
  if (left === undefined) return [];
  return [{ left: hundredths(left), ...(resetsAt === undefined ? {} : { resetsAt }) }];
}

function anthropicWindows(headers: Readonly<Record<string, string>>): Window[] {
  return ANTHROPIC_WINDOWS.flatMap((name) => {
    const used = numberOf(headers[`anthropic-ratelimit-unified-${name}-utilization`]);
    return window(used === undefined || used > 1 ? undefined : (1 - used) * 100, resetOf(headers[`anthropic-ratelimit-unified-${name}-reset`]));
  });
}

function codexWindows(headers: Readonly<Record<string, string>>): Window[] {
  return CODEX_WINDOWS.flatMap((name) => {
    const used = numberOf(headers[`x-codex-${name}-used-percent`]);
    return window(used === undefined || used > 100 ? undefined : 100 - used, resetOf(headers[`x-codex-${name}-reset-at`]));
  });
}

/** Lower-cased names: pi passes them lower-cased, a proxy might not. */
function lowerCased(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
}

/** The usage observation a response's `status` and `headers` at `at` give,
 *  or undefined when it is no 2xx response or carries no readable quota
 *  header. Under LOW_USAGE_PERCENT left it is low, else available. */
export function quotaHeaderObservation(status: number, headers: Readonly<Record<string, string>>, at: Date): UsageObservation | undefined {
  if (!(status >= 200 && status < 300)) return undefined;
  const named = lowerCased(headers);
  const windows = [...anthropicWindows(named), ...codexWindows(named)];
  if (windows.length === 0) return undefined;
  const tightest = windows.reduce((best, entry) => entry.left < best.left ? entry : best);
  return {
    state: tightest.left < LOW_USAGE_PERCENT ? "low" : "available",
    percentLeft: tightest.left,
    ...(tightest.resetsAt === undefined ? {} : { resetsAt: tightest.resetsAt }),
    observedAt: at.toISOString(),
    source: "header",
  };
}
