import type { ModelInfo } from "./model-info.ts";

// Which models may carry a dynamic rung (ADR 0018, bean pi-orchestrator-ghlt).
// A dynamic rung moves its effort within a band, so the model's prompt cache
// must survive an effort change. Two facts decide it: pi flags the model
// `compat.supportsMidConvoEffort`, and the effort cache probe measured its cache
// kept. The flag alone is not enough: a model stays out of the list until a
// live probe run shows its cache kept (docs/research/effort-cache-probe.md).

/** Lower-case `provider/id`. Measured 2026-10-09 with the probe: the cache
 *  was kept on each (docs/research/effort-cache-probe.md, Result). */
export const MEASURED_EFFORT_CACHE_MODELS: readonly string[] = Object.freeze([
  "anthropic/claude-haiku-5-5",
  "anthropic/claude-sonnet-5-5",
  "anthropic/claude-opus-5-5",
]);

/** Why `model` may not carry a dynamic rung, as the end of a sentence that
 *  starts "gives the dynamic rung ... but model ..."; `undefined` when it may.
 *  `installed` is the model's registry entry when pi has one: its flag is then
 *  required. Without an entry only the measured list decides. */
export function dynamicRungRefusal(model: string, installed: ModelInfo | undefined): string | undefined {
  if (installed !== undefined && installed.compat?.supportsMidConvoEffort !== true) {
    return "is not cache-safe for effort changes: pi does not flag it supportsMidConvoEffort";
  }
  if (!MEASURED_EFFORT_CACHE_MODELS.includes(model.toLowerCase())) {
    return "is not measured for effort changes: its prompt cache has not been probed (docs/research/effort-cache-probe.md)";
  }
  return undefined;
}
