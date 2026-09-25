import assert from "node:assert/strict";
import { test } from "node:test";
import {
  getSupportedThinkingLevels,
  splitKnownThinkingSuffix,
  THINKING_LEVELS,
  toModelInfo,
  type ModelInfo,
} from "./model-info.ts";

const model = (provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ provider, id, fullId: `${provider}/${id}`, ...extra });

test("the thinking levels run from off to max", () => {
  assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("splitKnownThinkingSuffix strips only the seven known levels", () => {
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/claude-haiku-4-5:low"), { baseModel: "anthropic/claude-haiku-4-5", thinkingSuffix: ":low" });
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/claude-haiku-4-5:max"), { baseModel: "anthropic/claude-haiku-4-5", thinkingSuffix: ":max" });
  assert.deepEqual(splitKnownThinkingSuffix("ollama/qwen:7b"), { baseModel: "ollama/qwen:7b", thinkingSuffix: "" });
  assert.deepEqual(splitKnownThinkingSuffix("plain"), { baseModel: "plain", thinkingSuffix: "" });
});

test("splitKnownThinkingSuffix reads only the last colon", () => {
  assert.deepEqual(splitKnownThinkingSuffix("a/b:high:low"), { baseModel: "a/b:high", thinkingSuffix: ":low" });
  assert.deepEqual(splitKnownThinkingSuffix("a/b:low:7b"), { baseModel: "a/b:low:7b", thinkingSuffix: "" });
  assert.deepEqual(splitKnownThinkingSuffix(":high"), { baseModel: "", thinkingSuffix: ":high" });
  assert.deepEqual(splitKnownThinkingSuffix("x:"), { baseModel: "x:", thinkingSuffix: "" });
  assert.deepEqual(splitKnownThinkingSuffix("a/b:HIGH"), { baseModel: "a/b:HIGH", thinkingSuffix: "" }, "levels are case-sensitive");
});

test("toModelInfo keeps positive limits, non-empty input and finite cost only", () => {
  const info = toModelInfo({
    provider: "anthropic",
    id: "claude-haiku-4-5",
    api: "anthropic-messages",
    reasoning: true,
    contextWindow: 200000,
    maxTokens: 0,
    input: [],
    cost: { input: 1, output: 5, tiers: [{ upTo: 10 }] },
  });
  assert.deepEqual(info, {
    provider: "anthropic",
    id: "claude-haiku-4-5",
    fullId: "anthropic/claude-haiku-4-5",
    api: "anthropic-messages",
    reasoning: true,
    thinkingLevelMap: undefined,
    contextWindow: 200000,
    cost: { input: 1, output: 5, tiers: [{ upTo: 10 }] },
  });
  assert.equal("cost" in toModelInfo({ provider: "p", id: "m", cost: { input: Number.NaN, output: 1 } }), false);
  assert.deepEqual(
    toModelInfo({ provider: "p", id: "m", api: "x", contextWindow: -1, maxTokens: 10, input: ["text"], cost: { input: 1, output: 2 } }),
    { provider: "p", id: "m", fullId: "p/m", api: "x", reasoning: undefined, thinkingLevelMap: undefined, maxTokens: 10, input: ["text"], cost: { input: 1, output: 2 } },
  );
});

test("toModelInfo copies input and cost tiers instead of sharing them", () => {
  const input = ["text", "image"];
  const tiers = [{ upTo: 10 }];
  const info = toModelInfo({ provider: "p", id: "m", input, cost: { input: 1, output: 2, tiers } });
  input.push("audio");
  tiers[0]!.upTo = 99;
  assert.deepEqual(info.input, ["text", "image"]);
  assert.deepEqual(info.cost?.tiers, [{ upTo: 10 }]);
});

test("getSupportedThinkingLevels follows reasoning and the level map", () => {
  assert.deepEqual(getSupportedThinkingLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(model("p", "m", { reasoning: false })), ["off"]);
  assert.deepEqual(getSupportedThinkingLevels(model("p", "m", { reasoning: true })), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(
    getSupportedThinkingLevels(model("p", "m", { reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh" } })),
    ["minimal", "low", "medium", "high", "xhigh"],
  );
});

test("getSupportedThinkingLevels needs an explicit map entry for xhigh and max", () => {
  assert.deepEqual(
    getSupportedThinkingLevels(model("p", "m", { thinkingLevelMap: { max: "max", low: null } })),
    ["off", "minimal", "medium", "high", "max"],
  );
  assert.deepEqual(
    getSupportedThinkingLevels(model("p", "m", { reasoning: true, thinkingLevelMap: {} })),
    ["off", "minimal", "low", "medium", "high"],
  );
  assert.deepEqual(
    getSupportedThinkingLevels(model("p", "m", { thinkingLevelMap: { xhigh: null, max: null } })),
    ["off", "minimal", "low", "medium", "high"],
  );
});
