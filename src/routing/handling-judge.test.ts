import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../models/model-info.ts";
import { DEFAULT_EFFORT_JUDGE_MODEL, effortJudgeConfigFromSettings, loadEffortJudgeChain } from "./effort-judge.ts";
import { handlingJudgeConfigFromSettings, judgeHandling } from "./handling-judge.ts";

const HAIKU: ModelInfo = {
  provider: "anthropic",
  id: "claude-haiku-5-5",
  fullId: "anthropic/claude-haiku-5-5",
  reasoning: true,
  thinkingLevelMap: { max: null },
};
const JUDGE = "anthropic/claude-haiku-5-5:low";
const chain = loadEffortJudgeChain({ model: JUDGE, timeoutMs: 1_000, fallback: [] }, [HAIKU]);

test("the handling judge reads a delegate verdict and its reason from one model reply", async () => {
  const verdict = await judgeHandling(
    { message: "Rename the helper in three independent modules and update their tests" },
    { chain, callModel: async () => '{"handling":"delegate","why":"three independent edits"}' },
  );
  assert.deepEqual(verdict, { handling: "delegate", reason: "three independent edits", judgeModel: JUDGE });
});

test("a failed handling judgement falls back to self, and the reason names the failure", async () => {
  const verdict = await judgeHandling(
    { message: "Fix the typo in the README" },
    { chain, callModel: async () => { throw new Error("provider unavailable"); } },
  );
  assert.deepEqual(verdict, { handling: "self", reason: "handling judge fallback to self: provider unavailable", judgeModel: "fallback" });
});

test("the handling judge reads its own settings key, defaulting to the effort judge's model", () => {
  assert.equal(handlingJudgeConfigFromSettings({}).model, DEFAULT_EFFORT_JUDGE_MODEL);
  assert.deepEqual(handlingJudgeConfigFromSettings({}), effortJudgeConfigFromSettings({}));
  const settings = { orchestrator: { routing: { handlingJudge: { model: "anthropic/claude-haiku-5-5:medium" } } } };
  assert.equal(handlingJudgeConfigFromSettings(settings).model, "anthropic/claude-haiku-5-5:medium");
  assert.equal(effortJudgeConfigFromSettings(settings).model, DEFAULT_EFFORT_JUDGE_MODEL, "the effort judge keeps its own key");
  assert.throws(
    () => handlingJudgeConfigFromSettings({ orchestrator: { routing: { handlingJudge: { bogus: 1 } } } }),
    /orchestrator\.routing\.handlingJudge has unknown key\(s\) orchestrator\.routing\.handlingJudge\.bogus/,
  );
});

test("a handling judgement that never answers times out and falls back to self, within the chain's timeout", async () => {
  const slow = loadEffortJudgeChain({ model: JUDGE, timeoutMs: 20, fallback: [] }, [HAIKU]);
  const started = Date.now();
  const verdict = await judgeHandling(
    { message: "Look at the logger" },
    { chain: slow, callModel: () => new Promise<string>((resolve) => { setTimeout(() => resolve('{"handling":"delegate","why":"late"}'), 300); }) },
  );
  assert.ok(Date.now() - started < 250, "the judge gave up at its timeout, before the late reply");
  assert.deepEqual(verdict, { handling: "self", reason: "handling judge fallback to self: handling judge timed out after 20 ms", judgeModel: "fallback" });
});

test("a failed handling judge rung hands the judgement to the next rung of the chain", async () => {
  const twoRungs = loadEffortJudgeChain({ model: JUDGE, timeoutMs: 1_000, fallback: ["anthropic/claude-haiku-5-5:medium"] }, [HAIKU]);
  const asked: string[] = [];
  const verdict = await judgeHandling(
    { message: "Rename the helper in three modules" },
    { chain: twoRungs, callModel: async (_prompt, rung) => {
      asked.push(rung);
      if (rung === JUDGE) throw new Error("rate limited");
      return '{"handling":"delegate","why":"three independent edits"}';
    } },
  );
  assert.deepEqual(asked, [JUDGE, "anthropic/claude-haiku-5-5:medium"]);
  assert.deepEqual(verdict, { handling: "delegate", reason: "three independent edits", judgeModel: "anthropic/claude-haiku-5-5:medium" });
});
