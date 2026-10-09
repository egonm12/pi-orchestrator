import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { dynamicRungRefusal, MEASURED_EFFORT_CACHE_MODELS } from "./effort-capability.ts";
import type { ModelInfo } from "./model-info.ts";

// Seam (ADR 0018): `dynamicRungRefusal`, the one question a dynamic rung asks
// of a model. The installed entries come from pi's registry facts in the
// fixture; the measured list is the code's own table.

function installed(fullId: string): ModelInfo {
  const model = INSTALLED_MODEL_INFO.find((entry) => entry.fullId === fullId);
  assert.ok(model, `${fullId} is in the installed fixture`);
  return model;
}

test("the measured list holds the three Claude 5.5 models the cache probe kept", () => {
  assert.deepEqual([...MEASURED_EFFORT_CACHE_MODELS], [
    "anthropic/claude-haiku-5-5",
    "anthropic/claude-sonnet-5-5",
    "anthropic/claude-opus-5-5",
  ]);
});

test("a flagged model the probe measured may carry a dynamic rung, whatever the case of its name", () => {
  assert.equal(dynamicRungRefusal("anthropic/claude-opus-5-5", installed("anthropic/claude-opus-5-5")), undefined);
  assert.equal(dynamicRungRefusal("ANTHROPIC/Claude-Opus-5-5", installed("anthropic/claude-opus-5-5")), undefined);
});

test("a model pi does not flag is not cache-safe, even under a measured name", () => {
  const unflagged: ModelInfo = { provider: "anthropic", id: "claude-sonnet-5-5", fullId: "anthropic/claude-sonnet-5-5", reasoning: true };
  assert.match(dynamicRungRefusal(unflagged.fullId, unflagged) ?? "", /^is not cache-safe for effort changes: pi does not flag it supportsMidConvoEffort/);
  assert.match(dynamicRungRefusal("anthropic/claude-sonnet-5", installed("anthropic/claude-sonnet-5")) ?? "", /not cache-safe/);
  assert.match(dynamicRungRefusal("openai-codex/gpt-6-sol", installed("openai-codex/gpt-6-sol")) ?? "", /not cache-safe/);
});

test("pi's flag alone does not qualify: a flagged model the probe did not measure is not measured", () => {
  assert.equal(installed("anthropic/claude-opus-5").compat?.supportsMidConvoEffort, true, "the fixture flags opus 5");
  const refusal = dynamicRungRefusal("anthropic/claude-opus-5", installed("anthropic/claude-opus-5"));
  assert.match(refusal ?? "", /^is not measured for effort changes/);
  assert.match(refusal ?? "", /docs\/research\/effort-cache-probe\.md/);
});

test("without a registry entry only the measured list decides, and an unmeasured name is not measured", () => {
  assert.equal(dynamicRungRefusal("anthropic/claude-haiku-5-5", undefined), undefined);
  assert.match(dynamicRungRefusal("anthropic/claude-haiku-9", undefined) ?? "", /not measured/);
});
