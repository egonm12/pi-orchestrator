import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { ModelInfo } from "../models/model-info.ts";
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

test(`model resolution matches the installed pi-subagents ${PI_SUBAGENTS_VERSION}`, async (t) => {
  const src = installedPiSubagentsSrc();
  if (!src) return t.skip("pi-subagents is not installed in ~/.pi/agent");
  const version = JSON.parse(readFileSync(join(dirname(src), "package.json"), "utf8")).version;
  if (version !== PI_SUBAGENTS_VERSION) t.diagnostic(`installed pi-subagents is ${version}, reimplemented from ${PI_SUBAGENTS_VERSION}`);
  const resolution = await import(pathToFileURL(join(src, "runs", "shared", "model-resolution.js")).href);

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
