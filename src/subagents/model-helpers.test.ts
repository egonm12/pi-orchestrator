import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { getSupportedThinkingLevels, splitKnownThinkingSuffix, toModelInfo, type ModelInfo } from "./model-info.ts";
import { checkModelScope, matchesScopePattern } from "./model-scope.ts";
import { INHERIT_MODEL, resolveEffectiveSubagentModel } from "./model-resolution.ts";
import { installedPiSubagentsSrc, PI_SUBAGENTS_VERSION } from "./installed.ts";

const model = (provider: string, id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({ provider, id, fullId: `${provider}/${id}`, ...extra });
const REGISTRY: ModelInfo[] = [
  model("anthropic", "claude-haiku-4-5", { reasoning: true }),
  model("anthropic", "claude-sonnet-5", { reasoning: true }),
  model("openai-codex", "gpt-6-luna", { reasoning: true, thinkingLevelMap: { off: null, xhigh: "xhigh" } }),
  model("openai", "gpt-6-luna"),
  model("google", "gemini-3-pro-20260101"),
];

// ---------------------------------------------------------------------------
// model-info
// ---------------------------------------------------------------------------

test("splitKnownThinkingSuffix strips only the seven known levels", () => {
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/claude-haiku-4-5:low"), { baseModel: "anthropic/claude-haiku-4-5", thinkingSuffix: ":low" });
  assert.deepEqual(splitKnownThinkingSuffix("anthropic/claude-haiku-4-5:max"), { baseModel: "anthropic/claude-haiku-4-5", thinkingSuffix: ":max" });
  assert.deepEqual(splitKnownThinkingSuffix("ollama/qwen:7b"), { baseModel: "ollama/qwen:7b", thinkingSuffix: "" });
  assert.deepEqual(splitKnownThinkingSuffix("plain"), { baseModel: "plain", thinkingSuffix: "" });
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
});

test("getSupportedThinkingLevels follows reasoning and the level map", () => {
  assert.deepEqual(getSupportedThinkingLevels(undefined), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(model("p", "m", { reasoning: false })), ["off"]);
  assert.deepEqual(getSupportedThinkingLevels(model("p", "m", { reasoning: true })), ["off", "minimal", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(REGISTRY[2]), ["minimal", "low", "medium", "high", "xhigh"]);
});

// ---------------------------------------------------------------------------
// model-scope
// ---------------------------------------------------------------------------

test("scope patterns are case-insensitive globs on provider/id without the thinking suffix", () => {
  assert.equal(matchesScopePattern("Anthropic/Claude-Haiku-4-5:high", "anthropic/*"), true);
  assert.equal(matchesScopePattern("openai-codex/gpt-6-luna", "openai/*"), false);
  assert.equal(matchesScopePattern("a/b.c", "a/b.c"), true);
  assert.equal(matchesScopePattern("a/bxc", "a/b.c"), false, "a dot is literal");
});

test("checkModelScope: explicit is an error, inherited a warning unless strict, and no-ops without enforcement", () => {
  const scope = { enforce: true, allow: ["anthropic/*"] };
  assert.equal(checkModelScope("anthropic/claude-haiku-4-5", scope, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna:low", scope, "explicit")?.severity, "error");
  assert.equal(checkModelScope("openai/gpt-6-luna", scope, "inherited")?.severity, "warn");
  assert.equal(checkModelScope("openai/gpt-6-luna", { ...scope, strict: true }, "inherited")?.severity, "error");
  assert.equal(checkModelScope("openai/gpt-6-luna", { allow: ["anthropic/*"] }, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna", { enforce: true, allow: [] }, "explicit"), undefined);
  assert.equal(checkModelScope(undefined, scope, "explicit"), undefined);
  assert.deepEqual(checkModelScope("openai/gpt-6-luna:low", { ...scope, origin: "custom" }, "explicit"), {
    model: "openai/gpt-6-luna",
    severity: "error",
    allowedPatterns: ["anthropic/*"],
    origin: "custom",
    message: "Model 'openai/gpt-6-luna' is outside the configured subagent model scope (custom). Allowed patterns: anthropic/*.",
  });
});

// ---------------------------------------------------------------------------
// model-resolution
// ---------------------------------------------------------------------------

const PARENT = { provider: "anthropic", id: "claude-sonnet-5" };

test("with no agent model, or inherit, the child gets the parent model", () => {
  assert.equal(resolveEffectiveSubagentModel(undefined, undefined, PARENT, REGISTRY), "anthropic/claude-sonnet-5");
  assert.equal(resolveEffectiveSubagentModel(undefined, INHERIT_MODEL, PARENT, REGISTRY), "anthropic/claude-sonnet-5");
  assert.equal(resolveEffectiveSubagentModel(undefined, "  ", PARENT, REGISTRY), "anthropic/claude-sonnet-5");
  assert.equal(resolveEffectiveSubagentModel(undefined, undefined, undefined, REGISTRY), undefined);
});

test("an agent model resolves exactly, by bare id with a preferred provider, and fuzzily", () => {
  assert.equal(resolveEffectiveSubagentModel(undefined, "anthropic/claude-haiku-4-5:low", PARENT, REGISTRY), "anthropic/claude-haiku-4-5:low");
  assert.equal(resolveEffectiveSubagentModel(undefined, "claude-haiku-4-5", PARENT, REGISTRY), "anthropic/claude-haiku-4-5");
  assert.equal(resolveEffectiveSubagentModel(undefined, "gpt-6-luna", PARENT, REGISTRY, "openai-codex"), "openai-codex/gpt-6-luna");
  assert.equal(resolveEffectiveSubagentModel(undefined, "Claude_Haiku_4.5", PARENT, REGISTRY), "anthropic/claude-haiku-4-5");
  assert.equal(resolveEffectiveSubagentModel(undefined, "google/gemini-3-pro", PARENT, REGISTRY), "google/gemini-3-pro-20260101");
});

test("an ambiguous or unknown agent model is kept as written", () => {
  assert.equal(resolveEffectiveSubagentModel(undefined, "gpt-6-luna", PARENT, REGISTRY), "gpt-6-luna");
  assert.equal(resolveEffectiveSubagentModel(undefined, "nobody/nothing", PARENT, REGISTRY), "nobody/nothing");
  assert.equal(resolveEffectiveSubagentModel(undefined, "anything", PARENT, []), "anything");
});

// ---------------------------------------------------------------------------
// Parity with the installed pi-subagents
// ---------------------------------------------------------------------------

test(`the helpers match the installed pi-subagents ${PI_SUBAGENTS_VERSION}`, async (t) => {
  const src = installedPiSubagentsSrc();
  if (!src) return t.skip("pi-subagents is not installed in ~/.pi/agent");
  const version = JSON.parse(readFileSync(join(dirname(src), "package.json"), "utf8")).version;
  if (version !== PI_SUBAGENTS_VERSION) t.diagnostic(`installed pi-subagents is ${version}, reimplemented from ${PI_SUBAGENTS_VERSION}`);
  const info = await import(pathToFileURL(join(src, "shared", "model-info.js")).href);
  const scope = await import(pathToFileURL(join(src, "runs", "shared", "model-scope.js")).href);
  const resolution = await import(pathToFileURL(join(src, "runs", "shared", "model-resolution.js")).href);

  for (const input of ["a/b:low", "a/b:xhigh", "a/b:7b", "a/b", "x:", ":high"]) {
    assert.deepEqual(splitKnownThinkingSuffix(input), info.splitKnownThinkingSuffix(input), input);
  }
  for (const entry of [undefined, ...REGISTRY, model("p", "m", { reasoning: false }), model("p", "m", { thinkingLevelMap: { max: "max", low: null } })]) {
    assert.deepEqual(getSupportedThinkingLevels(entry), info.getSupportedThinkingLevels(entry));
  }
  const registryModel = { provider: "p", id: "m", api: "x", contextWindow: -1, maxTokens: 10, input: ["text"], cost: { input: 1, output: 2 } };
  assert.deepEqual(toModelInfo(registryModel), info.toModelInfo(registryModel));

  const scopes = [undefined, { enforce: true, allow: ["anthropic/*"] }, { enforce: true, strict: true, allow: ["*luna*"] }, { enforce: true, allow: ["a/b.c"], origin: "o" }];
  for (const s of scopes) {
    for (const m of [undefined, "anthropic/claude-haiku-4-5:low", "openai/gpt-6-luna", "a/b.c", "a/bxc"]) {
      for (const source of ["explicit", "inherited"] as const) {
        assert.deepEqual(checkModelScope(m, s, source), scope.checkModelScope(m, s, source), `${m} ${JSON.stringify(s)} ${source}`);
      }
    }
  }

  const agentModels = [undefined, "inherit", "", "claude-haiku-4-5", "gpt-6-luna", "Claude_Haiku_4.5:low", "google/gemini-3-pro", "nobody/nothing", "anthropic:claude-sonnet-5"];
  for (const agentModel of agentModels) {
    for (const provider of [undefined, "openai-codex", "openai"]) {
      for (const parent of [PARENT, undefined]) {
        assert.equal(
          resolveEffectiveSubagentModel(undefined, agentModel, parent, REGISTRY, provider),
          resolution.resolveEffectiveSubagentModel(undefined, agentModel, parent, REGISTRY, provider),
          `${agentModel} ${provider} ${JSON.stringify(parent)}`,
        );
      }
    }
  }
  assert.equal(INHERIT_MODEL, resolution.INHERIT_MODEL);
});
