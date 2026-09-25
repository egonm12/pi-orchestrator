import { spawnSync } from "node:child_process";
import { isProhibitedModel } from "./model-resolution.ts";

// The Claude subscription reaches pi through the built-in `anthropic` provider
// (see harness/catalog/upstream-mapping.ts). The owner chose Haiku as the live
// test route, so the generic default and the subscription-semantics route are
// the same exact id again, as they were before `claude-bridge` was uninstalled.
export const DEFAULT_LIVE_PI_MODEL = "anthropic/claude-haiku-4-5";
export const SUBSCRIPTION_TEST_MODEL = "anthropic/claude-haiku-4-5";

// These are exact test routes, not model-family permissions. In particular,
// never admit Fable or Astra through a provider wildcard: this registry really
// lists anthropic/claude-fable-5, anthropic/claude-fable-5-1 and
// openai-codex/gpt-6-astra.
export const APPROVED_LIVE_PI_MODELS = [
  DEFAULT_LIVE_PI_MODEL,
  "openai-codex/gpt-6-luna",
] as const;

export type LivePiModelAvailability =
  | { status: "available" }
  | { status: "unavailable"; reason: "not-listed" };

interface ModelListResult {
  status: number | null;
  stdout?: string;
  stderr?: string;
  error?: Error | null;
}

type ModelListRunner = () => ModelListResult;

/** The `spawnSync` timeout for every `pi --list-models` probe. A lone probe
 *  takes seconds, but under the full suite's parallel load (the acceptance
 *  gate's live sessions beside the policy, guard and router files) 15 s
 *  timed out; activation (../activation/extension-gate.ts) refuses any
 *  failed test, so a probe timeout blocks an install. */
export const PI_LIST_MODELS_TIMEOUT_MS = 60_000;

function runPiModelList(): ModelListResult {
  return spawnSync("pi", ["--list-models"], { encoding: "utf8", timeout: PI_LIST_MODELS_TIMEOUT_MS });
}

export function livePiModelAvailability(
  model: string,
  runList: ModelListRunner = runPiModelList,
): LivePiModelAvailability {
  const result = runList();
  if (result.error) {
    throw new Error(`Could not inspect pi model registry: ${result.error.message}`, {
      cause: result.error,
    });
  }
  if (result.status !== 0) {
    throw new Error(`Could not inspect pi model registry: pi --list-models exited with ${result.status}`);
  }

  const lines = (result.stdout ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  const header = lines.shift()?.trim().split(/\s+/);
  const expectedHeader = ["provider", "model", "context", "max-out", "thinking", "images"];
  if (!header || header.length !== expectedHeader.length || header.some((column, index) => column !== expectedHeader[index])) {
    throw new Error("Could not inspect pi model registry: malformed pi --list-models output");
  }

  const rows = lines.map((line) => line.trim().split(/\s+/));
  if (
    rows.some(
      (columns) =>
        columns.length !== header.length ||
        !columns[0] ||
        !columns[1],
    )
  ) {
    throw new Error("Could not inspect pi model registry: malformed pi --list-models row");
  }
  const listed = rows.some((columns) => `${columns[0]}/${columns[1]}` === model);
  return listed ? { status: "available" } : { status: "unavailable", reason: "not-listed" };
}

export function selectedLivePiModel(
  env: NodeJS.ProcessEnv = process.env,
): (typeof APPROVED_LIVE_PI_MODELS)[number] {
  const requested = env.PI_ORCHESTRATOR_LIVE_MODEL ?? DEFAULT_LIVE_PI_MODEL;
  if (
    isProhibitedModel(requested) ||
    !(APPROVED_LIVE_PI_MODELS as readonly string[]).includes(requested)
  ) {
    throw new Error(
      `Unsupported PI_ORCHESTRATOR_LIVE_MODEL ${JSON.stringify(requested)}. ` +
        `Choose one exact approved ID: ${APPROVED_LIVE_PI_MODELS.join(", ")}`,
    );
  }
  return requested as (typeof APPROVED_LIVE_PI_MODELS)[number];
}
