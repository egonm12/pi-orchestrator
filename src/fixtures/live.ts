import { test, type TestContext, type TestOptions } from "node:test";

// Live tests start real pi sessions and may spend model usage. They run only
// with PI_ORCHESTRATOR_LIVE=1; `npm test` stays offline otherwise.
export const LIVE_TESTS_ENABLED = process.env.PI_ORCHESTRATOR_LIVE === "1";
export const LIVE_SKIP_REASON = "live test: set PI_ORCHESTRATOR_LIVE=1 to run";

type Body = (t: TestContext) => void | Promise<void>;

/** `node:test`'s `test`, skipped unless live tests are enabled. */
export function liveTest(name: string, optionsOrBody: TestOptions | Body, maybeBody?: Body): void {
  const options = typeof optionsOrBody === "function" ? {} : optionsOrBody;
  const body = (typeof optionsOrBody === "function" ? optionsOrBody : maybeBody)!;
  test(name, { ...options, ...(LIVE_TESTS_ENABLED ? {} : { skip: LIVE_SKIP_REASON }) }, body);
}
