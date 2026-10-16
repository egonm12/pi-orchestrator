import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../models/model-info.ts";
import {
  DEFAULT_EFFORT_JUDGE_CONFIG,
  effortJudgeConfigFromSettings,
  judgeEffort,
  loadEffortJudgeChain,
  type EffortJudgeInput,
} from "./effort-judge.ts";

const CLASSIFIER = "anthropic/claude-sonnet-5-5:high";
const CLASSIFIER_FALLBACK = "openai-codex/gpt-6-luna:low";

test("effort judge settings default the model and inherit the classifier chain as fallbacks", () => {
  assert.deepEqual(effortJudgeConfigFromSettings({}), DEFAULT_EFFORT_JUDGE_CONFIG);
  assert.deepEqual(DEFAULT_EFFORT_JUDGE_CONFIG, {
    model: "anthropic/claude-haiku-5-5:low",
    timeoutMs: 8_000,
    fallback: ["openai-codex/gpt-6-luna:low"],
  });

  const settings = {
    orchestrator: {
      routing: {
        classifier: { model: CLASSIFIER, fallback: [CLASSIFIER_FALLBACK] },
        effortJudge: { model: "anthropic/claude-haiku-5-5:medium", timeoutMs: 5_000 },
      },
    },
  };
  assert.deepEqual(effortJudgeConfigFromSettings(settings), {
    model: "anthropic/claude-haiku-5-5:medium",
    timeoutMs: 5_000,
    fallback: [CLASSIFIER, CLASSIFIER_FALLBACK],
  });
});

test("the effort judge loader refuses a level unsupported by its installed model", () => {
  const model: ModelInfo = {
    provider: "anthropic",
    id: "claude-haiku-5-5",
    fullId: "anthropic/claude-haiku-5-5",
    reasoning: true,
    thinkingLevelMap: { max: null },
  };
  const chain = loadEffortJudgeChain({
    model: "anthropic/claude-haiku-5-5:max",
    timeoutMs: 1_000,
    fallback: [],
  }, [model]);

  assert.equal(chain.entries.length, 1);
  assert.match(chain.entries[0]!.refusal ?? "", /effort 'max' is not supported/);
});

test("the inherited fallback drops the judge's own model, so no rung is tried twice", () => {
  const sameAsJudge = effortJudgeConfigFromSettings({
    orchestrator: { routing: { classifier: { model: "anthropic/claude-haiku-5-5:low", fallback: [CLASSIFIER_FALLBACK] } } },
  });
  assert.deepEqual(sameAsJudge.fallback, [CLASSIFIER_FALLBACK]);
  const chain = effortJudgeConfigFromSettings({
    orchestrator: { routing: { classifier: { model: "anthropic/claude-haiku-5-5:low", fallback: ["openai-codex/gpt-6-luna:low"] } } },
  });
  assert.deepEqual([chain.model, ...chain.fallback], ["anthropic/claude-haiku-5-5:low", "openai-codex/gpt-6-luna:low"]);
});

test("an explicit empty fallback list overrides the classifier's inherited fallback", () => {
  const config = effortJudgeConfigFromSettings({
    orchestrator: {
      routing: {
        classifier: { model: CLASSIFIER, fallback: [CLASSIFIER_FALLBACK] },
        effortJudge: { fallback: [] },
      },
    },
  });

  assert.deepEqual(config.fallback, []);
});

test("unknown effort judge settings fail closed with the key named", () => {
  assert.throws(
    () => effortJudgeConfigFromSettings({ orchestrator: { routing: { effortJudge: { timeOutMs: 5_000 } } } }),
    /unknown key\(s\) orchestrator\.routing\.effortJudge\.timeOutMs/,
  );
});

test("effort judge settings validate the timeout and fallback list", () => {
  assert.throws(
    () => effortJudgeConfigFromSettings({ orchestrator: { routing: { effortJudge: { timeoutMs: 0 } } } }),
    /orchestrator\.routing\.effortJudge\.timeoutMs/,
  );
  assert.throws(
    () => effortJudgeConfigFromSettings({ orchestrator: { routing: { effortJudge: { fallback: "anthropic/claude-haiku-5-5:low" } } } }),
    /orchestrator\.routing\.effortJudge\.fallback/,
  );
});

const LOW_HIGH = { min: "low", max: "high" } as const;
const JUDGE_RUNG = "anthropic/claude-haiku-5-5:low";
const testChain = { timeoutMs: 100, entries: [{ rung: JUDGE_RUNG }], refusals: [] } as const;

test("a short owner reply after an assistant question is judged, and after a statement it keeps the effort", async () => {
  for (const lastAssistantReply of ["Should I archive the old branches?", "Should I archive them?  \n"]) {
    let calls = 0;
    const decision = await judgeEffort(judgeInput({ kind: "user-prompt", message: "yes", currentEffort: "medium", lastAssistantReply }), {
      chain: testChain,
      callModel: async () => { calls += 1; return JSON.stringify({ effort: "low", why: "one small action" }); },
    });
    assert.equal(calls, 1, lastAssistantReply);
    assert.equal(decision.judgeModel, JUDGE_RUNG, lastAssistantReply);
  }
  for (const lastAssistantReply of ["Done.", "Archived the old branches? No, I left them.", ""]) {
    const decision = await judgeEffort(judgeInput({ kind: "user-prompt", message: "thanks", currentEffort: "medium", lastAssistantReply }), {
      chain: testChain,
      callModel: async () => { throw new Error("the judge must be skipped"); },
    });
    assert.equal(decision.judgeModel, "skipped", lastAssistantReply);
  }
});

test("a short steer or follow-up after an assistant question keeps the effort", async () => {
  for (const kind of ["steer", "follow-up"] as const) {
    const decision = await judgeEffort(judgeInput({ kind, message: "yes", currentEffort: "medium", lastAssistantReply: "Should I continue?" }), {
      chain: testChain,
      callModel: async () => { throw new Error("the judge must be skipped"); },
    });
    assert.equal(decision.judgeModel, "skipped", kind);
  }
});

test("the judge reads the first balanced JSON object, even inside a code fence or surrounded by prose", async () => {
  const replies = [
    'Here is my answer:\n```json\n{"effort":"medium","why":"Two files change."}\n```\nThanks.',
    'I think {this} is it. {"effort":"medium","why":"Use {braces} and \\"quotes\\" in a reason."} Also {"effort":"high"}',
  ];
  for (const reply of replies) {
    const decision = await judgeEffort(judgeInput(), { chain: testChain, callModel: async () => reply });
    assert.equal(decision.to, "medium", reply);
    assert.equal(decision.judgeModel, JUDGE_RUNG, reply);
  }
  const why = await judgeEffort(judgeInput(), {
    chain: testChain,
    callModel: async () => 'Answer: {"effort":"medium","why":"Use {braces} and \\"quotes\\" here."}',
  });
  assert.equal(why.reason, 'Use {braces} and "quotes" here.');
});

test("the tolerant parse still checks the schema of the object it finds", async () => {
  const decision = await judgeEffort(judgeInput(), {
    chain: testChain,
    callModel: async () => 'Sure: {"effort":"medium"} and {"effort":"low","why":"later"}',
  });
  assert.equal(decision.judgeModel, "fallback");
  assert.match(decision.reason, /non-empty why/);
});

function judgeInput(overrides: Partial<EffortJudgeInput> = {}): EffortJudgeInput {
  return {
    message: "Add a small validation check",
    kind: "task",
    tier: "standard",
    band: LOW_HIGH,
    currentEffort: "low",
    turnRunning: false,
    ...overrides,
  };
}

test("a higher judged effort applies now and records the model's reason", async () => {
  const decision = await judgeEffort(judgeInput({ turnRunning: true }), {
    chain: testChain,
    callModel: async () => JSON.stringify({ effort: "high", why: "The change spans several files." }),
  });

  assert.deepEqual(decision, {
    from: "low",
    to: "high",
    applyAt: "now",
    reason: "The change spans several files.",
    judgeModel: JUDGE_RUNG,
  });
});

test("a short follow-up keeps the current effort without calling the judge", async () => {
  const decision = await judgeEffort(judgeInput({ kind: "follow-up", message: "  yes  ", currentEffort: "medium" }), {
    chain: testChain,
    callModel: async () => { throw new Error("the judge must be skipped"); },
  });

  assert.deepEqual(decision, {
    from: "medium",
    to: "medium",
    applyAt: "none",
    reason: "short follow-up kept the current effort",
    judgeModel: "skipped",
  });
});

test("a short message containing ultrathink is judged, in any case", async () => {
  for (const message of ["ultrathink", "UltraThink pls"]) {
    let calls = 0;
    const decision = await judgeEffort(judgeInput({ kind: "user-prompt", message, currentEffort: "low" }), {
      chain: testChain,
      callModel: async () => { calls += 1; return JSON.stringify({ effort: "high", why: "asked to think" }); },
    });
    assert.equal(calls, 1, message);
    assert.equal(decision.to, "high", message);
  }
});

test("a short user prompt or steer keeps the current effort, but a short task or retry feedback is judged", async () => {
  for (const kind of ["user-prompt", "steer"] as const) {
    const decision = await judgeEffort(judgeInput({ kind, message: "thanks", currentEffort: "high" }), {
      chain: testChain,
      callModel: async () => { throw new Error("the judge must be skipped"); },
    });
    assert.equal(decision.judgeModel, "skipped", kind);
    assert.equal(decision.to, "high", kind);
  }
  for (const kind of ["task", "retry-feedback"] as const) {
    let calls = 0;
    await judgeEffort(judgeInput({ kind, message: "fix it" }), {
      chain: testChain,
      callModel: async () => { calls += 1; return JSON.stringify({ effort: "low", why: "small" }); },
    });
    assert.equal(calls, 1, kind);
  }
});

test("a thrown judge call falls back to the top of the band", async () => {
  const decision = await judgeEffort(judgeInput(), {
    chain: testChain,
    callModel: async () => { throw new Error("provider unavailable"); },
  });

  assert.deepEqual(decision, {
    from: "low",
    to: "high",
    applyAt: "now",
    reason: "effort judge fallback to band maximum: provider unavailable",
    judgeModel: "fallback",
  });
});

test("a failed primary judge tries the configured fallback before using the band maximum", async () => {
  const secondRung = "openai-codex/gpt-6-luna:low";
  const called: string[] = [];
  const decision = await judgeEffort(judgeInput(), {
    chain: { timeoutMs: 100, entries: [{ rung: JUDGE_RUNG }, { rung: secondRung }], refusals: [] },
    callModel: async (_prompt, rung) => {
      called.push(rung);
      if (rung === JUDGE_RUNG) throw new Error("primary unavailable");
      return JSON.stringify({ effort: "medium", why: "The fallback answered." });
    },
  });

  assert.deepEqual(called, [JUDGE_RUNG, secondRung]);
  assert.equal(decision.to, "medium");
  assert.equal(decision.judgeModel, secondRung);
});

test("a timed-out judge call aborts and falls back to the top of the band", async () => {
  let aborted = false;
  const decision = await judgeEffort(judgeInput(), {
    chain: { timeoutMs: 5, entries: [{ rung: JUDGE_RUNG }], refusals: [] },
    callModel: (_prompt, _rung, signal) => new Promise<string>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new Error("aborted"));
      }, { once: true });
    }),
  });

  assert.equal(aborted, true);
  assert.equal(decision.to, "high");
  assert.equal(decision.judgeModel, "fallback");
  assert.match(decision.reason, /timed out/);
});

test("an unparseable judge reply falls back to the top of the band", async () => {
  const decision = await judgeEffort(judgeInput(), {
    chain: testChain,
    callModel: async () => "not JSON",
  });

  assert.equal(decision.to, "high");
  assert.equal(decision.judgeModel, "fallback");
  assert.match(decision.reason, /not valid JSON/);
});

test("an effort outside the band is clamped to its nearest bound", async () => {
  const decision = await judgeEffort(judgeInput(), {
    chain: testChain,
    callModel: async () => JSON.stringify({ effort: "xhigh", why: "The band stops at high." }),
  });

  assert.deepEqual(decision, {
    from: "low",
    to: "high",
    applyAt: "now",
    reason: "The band stops at high.",
    judgeModel: JUDGE_RUNG,
  });
});

test("a lower effort is declined while a run is in progress", async () => {
  const decision = await judgeEffort(judgeInput({ currentEffort: "high", turnRunning: true }), {
    chain: testChain,
    callModel: async () => JSON.stringify({ effort: "low", why: "This is a straightforward lookup." }),
  });

  assert.deepEqual(decision, {
    from: "high",
    to: "low",
    applyAt: "declined",
    reason: "This is a straightforward lookup.",
    judgeModel: JUDGE_RUNG,
  });
});

test("a lower effort applies now when no turn is running", async () => {
  const decision = await judgeEffort(judgeInput({ currentEffort: "high", turnRunning: false }), {
    chain: testChain,
    callModel: async () => JSON.stringify({ effort: "low", why: "This is a straightforward lookup." }),
  });

  assert.equal(decision.applyAt, "now");
  assert.equal(decision.to, "low");
});

test("an unchanged effort has no apply time", async () => {
  const decision = await judgeEffort(judgeInput({ currentEffort: "medium", turnRunning: true }), {
    chain: testChain,
    callModel: async () => JSON.stringify({ effort: "medium", why: "This is the right amount of thought." }),
  });

  assert.equal(decision.applyAt, "none");
  assert.equal(decision.from, decision.to);
});

test("a follow-up outside either shortness limit is judged", async () => {
  let calls = 0;
  const decision = await judgeEffort(judgeInput({ kind: "follow-up", message: "This is a longer follow-up" }), {
    chain: testChain,
    callModel: async () => {
      calls += 1;
      return JSON.stringify({ effort: "low", why: "The extra detail needs review." });
    },
  });

  assert.equal(calls, 1);
  assert.equal(decision.judgeModel, JUDGE_RUNG);
});

test("one judge reply can carry the handling verdict beside the effort, and the decision keeps it", async () => {
  const decision = await judgeEffort(judgeInput({ turnRunning: false }), {
    chain: testChain,
    callModel: async () => JSON.stringify({
      effort: "high",
      why: "The change spans several files.",
      handling: "delegate",
      handlingWhy: "three independent edits",
    }),
  });

  assert.equal(decision.to, "high");
  assert.deepEqual(decision.handling, { handling: "delegate", reason: "three independent edits" });
});
