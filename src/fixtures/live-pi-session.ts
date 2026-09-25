// Shared by the live-pi tests (router/auto-model-session.test.ts,
// acceptance/routing-acceptance.test.ts): pi's `--mode json` events and the
// provider-refusal pattern that turns a live run into a skip.

/** The fields of one pi `--mode json` event that the live tests read. */
export interface PiEvent {
  readonly type?: string;
  readonly toolName?: string;
  readonly toolCallId?: string;
  readonly args?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly result?: { readonly content?: readonly { readonly text?: string }[]; readonly details?: { readonly results?: readonly Record<string, unknown>[] } };
  readonly message?: { readonly role?: string; readonly usage?: Record<string, unknown> };
}

/** Every JSON line of one `--mode json` stdout, skipping any that do not parse. */
export function piEvents(stdout: string): PiEvent[] {
  return stdout.split("\n").filter((line) => line.startsWith("{")).flatMap((line) => {
    try { return [JSON.parse(line) as PiEvent]; } catch { return []; }
  });
}

/** A provider refusal (usage, quota, rate limit, 429, credit, overloaded) in
 *  pi's output: the live test reports a skip, never a pass or a failure. */
export const PROVIDER_REFUSAL = /"errorMessage":"[^"]*(?:usage|quota|rate.?limit|429|credit|overloaded)[^"]*"/i;
