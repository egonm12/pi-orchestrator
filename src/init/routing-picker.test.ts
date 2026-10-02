import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelInfo } from "../models/model-info.ts";
import { DONE, REMOVE_ENTRY, type PickerUi } from "./ban-list-picker.ts";
import {
  CLASSIFIER_MODEL_HINT,
  CLASSIFIER_THINKING_HINT,
  THINKING_LEVEL_HINT,
  TIER_MODEL_USAGE_HINT,
  classifierDefault,
  modelOptions,
  pickRoutingMap,
  starterThinkingLevel,
  thinkingLevelOptions,
  PRICE_UNKNOWN_LABEL,
  modelDisplayOptions,
  tierThinkingValueConfig,
} from "./routing-picker.ts";
import type { StarterTierMap } from "./setup.ts";

interface Call { kind: "select" | "notify"; title: string; options?: string[] }

function scriptedUi(script: (string | undefined)[]) {
  const calls: Call[] = [];
  const answers = [...script];
  const ui: PickerUi = {
    notify: (message) => { calls.push({ kind: "notify", title: message }); },
    input: async () => undefined,
    select: async (title, options) => {
      calls.push({ kind: "select", title, options: [...options] });
      if (answers.length === 0) throw new Error(`script ran out at select: ${title}`);
      return answers.shift();
    },
  };
  return { ui, calls, remaining: () => answers.length };
}

const MODELS: readonly ModelInfo[] = [
  { provider: "p", id: "cheap", fullId: "p/cheap", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } },
  { provider: "p", id: "middle", fullId: "p/middle", reasoning: false },
  { provider: "p", id: "top", fullId: "p/top", reasoning: true, thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh" } },
];

const STARTER: StarterTierMap = {
  classifier: "p/cheap:low",
  tiers: {
    mechanical: ["p/cheap:low", "p/middle:off"],
    standard: ["p/middle:off"],
    elevated: ["p/top:high"],
    critical: ["p/top:xhigh"],
  },
  skipped: [],
};

const optionFor = (id: string) => modelDisplayOptions(MODELS).find((option) => option.startsWith(id))!;

test("routing option helpers put defaults first and only list supported thinking levels", () => {
  assert.deepEqual(modelOptions(MODELS, "p/top"), ["p/top", "p/cheap", "p/middle"]);
  assert.deepEqual(modelOptions(MODELS, "p/missing"), ["p/cheap", "p/middle", "p/top"]);
  assert.deepEqual(thinkingLevelOptions(MODELS[1]!, "high" as never), ["off"]);
  assert.deepEqual(thinkingLevelOptions(MODELS[2]!, "high"), ["high", "minimal", "low", "medium", "xhigh"]);
  assert.equal(classifierDefault({ starter: STARTER, classifier: "p/top:medium" }, MODELS), "p/top");
  assert.equal(classifierDefault({ starter: STARTER, classifier: "p/missing:medium" }, MODELS), "p/cheap");
  assert.equal(starterThinkingLevel(STARTER, "standard", MODELS[2]!), "medium");
});

test("routing picker asks classifier, tier models and one thinking level per picked model", async () => {
  const { ui, calls, remaining } = scriptedUi([
    optionFor("p/top"), "medium",
    REMOVE_ENTRY, optionFor("p/middle"), optionFor("p/top"), DONE, "low", "high",
    undefined,
    undefined,
    DONE, "xhigh",
  ]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER });
  assert.equal(remaining(), 0);
  assert.equal(picked.classifier, "p/top:medium");
  assert.deepEqual(picked.tiers.mechanical, ["p/cheap:low", "p/top:high"]);
  assert.deepEqual(picked.tiers.standard, STARTER.tiers.standard);
  assert.deepEqual(picked.tiers.elevated, STARTER.tiers.elevated);
  assert.deepEqual(picked.tiers.critical, ["p/top:xhigh"]);
  assert.ok(calls.some((call) => call.kind === "notify" && call.title === CLASSIFIER_MODEL_HINT));
  const classifier = calls.find((call) => call.kind === "select" && call.title === "Classifier model")!;
  assert.deepEqual(classifier.options, [optionFor("p/cheap"), optionFor("p/middle"), optionFor("p/top")]);
  assert.ok(classifier.options.every((option) => option.includes(PRICE_UNKNOWN_LABEL)));
  assert.ok(calls.some((call) => call.title === `Thinking level for classifier p/top. ${CLASSIFIER_THINKING_HINT}`));
  const mechanical = calls.find((call) => call.kind === "select" && call.title.startsWith("mechanical tier models"))!;
  assert.match(mechanical.title, /p\/cheap.*p\/middle/);
  assert.match(mechanical.title, /Behaviour-preserving work/);
  assert.ok(mechanical.title.includes(TIER_MODEL_USAGE_HINT));
  assert.ok(calls.some((call) => call.title === `Thinking level for mechanical model p/cheap. ${THINKING_LEVEL_HINT}` && call.options![0] === "low"));
  assert.deepEqual(calls.find((call) => call.title === `Thinking level for mechanical model p/top. ${THINKING_LEVEL_HINT}`)!.options, ["low", "minimal", "medium", "high", "xhigh"]);
});

test("routing picker uses inline tier thinking levels in TUI mode", async () => {
  const calls: Call[] = [];
  const selectAnswers = ["p/top", "medium"];
  const customAnswers = [
    { selected: ["p/cheap", "p/top"], values: { "p/cheap": "medium", "p/top": "low" } },
    { selected: ["p/middle"], values: { "p/middle": "off" } },
    { selected: ["p/top"], values: { "p/top": "xhigh" } },
    undefined,
  ];
  const ui: PickerUi = {
    mode: "tui",
    notify: (message) => { calls.push({ kind: "notify", title: message }); },
    input: async () => undefined,
    select: async (title, options) => {
      calls.push({ kind: "select", title, options: [...options] });
      const answer = selectAnswers.shift();
      if (answer === undefined) throw new Error(`script ran out at select: ${title}`);
      return answer;
    },
    custom: async <T>() => customAnswers.shift() as T,
  };
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER });
  assert.equal(selectAnswers.length, 0);
  assert.equal(customAnswers.length, 0);
  assert.equal(picked.classifier, "p/top:medium");
  assert.deepEqual(picked.tiers.mechanical, ["p/cheap:medium", "p/top:low"]);
  assert.deepEqual(picked.tiers.standard, ["p/middle:off"]);
  assert.deepEqual(picked.tiers.elevated, ["p/top:xhigh"]);
  assert.deepEqual(picked.tiers.critical, STARTER.tiers.critical);
  assert.equal(calls.some((call) => call.title.startsWith("Thinking level for mechanical model")), false);
});

test("fallback tier picker refuses an empty tier and keeps asking", async () => {
  const { ui, calls, remaining } = scriptedUi([
    optionFor("p/cheap"), "low",
    REMOVE_ENTRY, optionFor("p/cheap"), REMOVE_ENTRY, optionFor("p/middle"), DONE,
    optionFor("p/top"), DONE, "high",
    undefined, undefined, undefined,
  ]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER });
  assert.equal(remaining(), 0);
  assert.deepEqual(picked.tiers.mechanical, ["p/top:high"]);
  assert.ok(calls.some((call) => call.kind === "notify" && call.title === "Tick at least one model"));
  assert.equal(calls.filter((call) => call.kind === "select" && call.title.startsWith("mechanical tier models")).length, 5);
});

test("tier inline thinking config lists only supported levels with starter defaults", () => {
  const config = tierThinkingValueConfig({ starter: STARTER }, "critical", MODELS);
  assert.deepEqual(config.choices[optionFor("p/middle")], ["off"]);
  assert.equal(config.initial[optionFor("p/top")], "xhigh");
  assert.equal(config.choices[optionFor("p/top")]!.includes("max"), false);
});

test("Escape at the classifier keeps the default map with the existing classifier when eligible", async () => {
  const existing = { mechanical: ["p/top:medium"], standard: ["p/cheap:low"], elevated: ["p/top:high"], critical: ["p/top:xhigh"] };
  const { ui } = scriptedUi([undefined]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER, tiers: existing, classifier: "p/top:high" });
  assert.deepEqual(picked.tiers, existing);
  assert.equal(picked.classifier, "p/top:high");
});

test("routing picker preselects existing tier models and thinking levels", async () => {
  const existing = { mechanical: ["p/top:medium"] };
  const { ui, calls } = scriptedUi([optionFor("p/top"), "medium", DONE, "medium", undefined, undefined, undefined]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER, tiers: existing, classifier: "p/top:medium" });
  assert.deepEqual(picked.tiers.mechanical, ["p/top:medium"]);
  const mechanical = calls.find((call) => call.kind === "select" && call.title.startsWith("mechanical tier models"))!;
  assert.match(mechanical.title, /p\/top/);
  assert.doesNotMatch(mechanical.title, /p\/cheap/);
  const level = calls.find((call) => call.kind === "select" && call.title === `Thinking level for mechanical model p/top. ${THINKING_LEVEL_HINT}`)!;
  assert.equal(level.options![0], "medium");
});

test("Escape at a tier keeps existing tier picks", async () => {
  const existing = { mechanical: ["p/top:medium"] };
  const { ui } = scriptedUi([optionFor("p/cheap"), "low", undefined, undefined, undefined, undefined]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER, tiers: existing });
  assert.deepEqual(picked.tiers.mechanical, ["p/top:medium"]);
});

test("unavailable existing rungs warn and stay out of picker defaults", async () => {
  const existing = { mechanical: ["p/missing:high"] };
  const { ui, calls } = scriptedUi([undefined]);
  const picked = await pickRoutingMap(ui, MODELS, { starter: STARTER, tiers: existing, classifier: "p/missing:low" });
  assert.deepEqual(picked.tiers.mechanical, []);
  const notes = calls.filter((call) => call.kind === "notify").map((call) => call.title).join("\n");
  assert.match(notes, /existing mechanical rung p\/missing:high is not available or eligible/);
  assert.match(notes, /existing classifier p\/missing:low is not available or eligible/);
});

test("unpriced models are marked in picker labels without changing parseable ids", () => {
  const models: readonly ModelInfo[] = [
    { provider: "anthropic", id: "claude-haiku-4-5", fullId: "anthropic/claude-haiku-4-5", reasoning: true },
    { provider: "anthropic", id: "claude-sonnet-5-5", fullId: "anthropic/claude-sonnet-5-5", reasoning: true },
  ];
  const options = modelDisplayOptions(models);
  assert.ok(options.includes("anthropic/claude-haiku-4-5"));
  assert.ok(options.includes(`anthropic/claude-sonnet-5-5 (${PRICE_UNKNOWN_LABEL})`));
});
