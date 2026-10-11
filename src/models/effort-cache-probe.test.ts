import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CLAUDE_MID_CONVERSATION_BETA,
  FIRST_TURN,
  NEW_TURN,
  PROBE_MODELS,
  PROBE_NUMBERS,
  PROBE_TOOL_NAME,
  TOOL_TURN,
  assistantMessageOf,
  cacheKept,
  cacheSensitivity,
  mergePayload,
  probeNotes,
  probePlan,
  rawUsageOf,
  runError,
  toolResultChange,
  usageOf,
  type ProbeStep,
  type StepUsage,
} from "./effort-cache-probe.ts";

// Every expected value below is a literal from the docs, the spec or the
// bean, not a recomputation of what the code does.

const step = (plan: readonly ProbeStep[], id: string): ProbeStep => {
  const found = plan.find((candidate) => candidate.id === id);
  assert.ok(found, `the plan has no step ${id}`);
  return found;
};
type Loose = Record<string, unknown>;
const messagesOf = (s: ProbeStep): Loose[] => s.overrides.messages as Loose[];
const inputOf = (s: ProbeStep): Loose[] => s.overrides.input as Loose[];
const usage = (fields: Partial<StepUsage>): StepUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, thinkingChars: 0, stopReason: "stop", ...fields });
const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

test("the Claude first request starts at the low top-level effort, with the stable notes as the cached block of the first user turn", () => {
  const r1 = step(probePlan(PROBE_MODELS.haiku), "R1");
  assert.equal(r1.topEffort, "low");
  assert.deepEqual(r1.overrides.output_config, { effort: "low" });
  assert.deepEqual(r1.overrides.system, [{ type: "text", text: IDENTITY }], "the identity block pi sends for an OAuth token, and nothing else");
  const [first] = messagesOf(r1);
  const [notes, question] = (first?.content ?? []) as Loose[];
  assert.equal(messagesOf(r1).length, 1);
  assert.equal(first?.role, "user");
  assert.deepEqual(notes?.cache_control, { type: "ephemeral" }, "the breakpoint sits on the notes, so the per-message change comes after it");
  assert.equal(question?.text, FIRST_TURN);
  assert.ok(String(notes?.text).length >= 2048, "well above Claude's 512-token minimum at about four characters a token");
});

test("Claude R2 places the per-message effort right before the new user turn and keeps the top-level effort", () => {
  const r2 = step(probePlan(PROBE_MODELS.haiku), "R2");
  assert.equal(r2.topEffort, "low");
  assert.deepEqual(r2.overrides.output_config, { effort: "low" });
  const messages = messagesOf(r2);
  assert.equal((messages[0]?.content as Loose[])[1]?.text, FIRST_TURN);
  assert.deepEqual(messages.slice(1), [
    { role: "assistant", content: "noted." },
    { role: "system", content: [], output_config: { effort: "high" } },
    { role: "user", content: NEW_TURN },
  ]);
});

test("the Claude control is R2 without the per-message effort, at the same top-level effort", () => {
  const c2 = step(probePlan(PROBE_MODELS.haiku), "C2");
  assert.equal(c2.topEffort, "low");
  assert.deepEqual(c2.overrides.output_config, { effort: "low" });
  assert.deepEqual(messagesOf(c2).slice(1), [
    { role: "assistant", content: "noted." },
    { role: "user", content: NEW_TURN },
  ]);
});

test("the negative control moves the top-level effort on the control's messages, with no per-message change", () => {
  const plan = probePlan(PROBE_MODELS.haiku);
  const nc = step(plan, "NC");
  assert.equal(nc.topEffort, "high");
  assert.deepEqual(nc.overrides.output_config, { effort: "high" });
  assert.deepEqual(messagesOf(nc), messagesOf(step(plan, "C2")));
});

test("every Claude step sends the same identity, tools and cached notes, so the cached prefix is the same in every request", () => {
  const plan = probePlan(PROBE_MODELS.haiku);
  const [first] = plan;
  assert.ok(first, "the plan is not empty");
  const notesOf = (s: ProbeStep) => (messagesOf(s)[0]?.content as Loose[])[0];
  for (const candidate of plan) {
    assert.deepEqual(candidate.overrides.system, first.overrides.system, `${candidate.id} system`);
    assert.deepEqual(candidate.overrides.tools, first.overrides.tools, `${candidate.id} tools`);
    assert.deepEqual(notesOf(candidate), notesOf(first), `${candidate.id} cached notes`);
  }
  const tools = first.overrides.tools as { name: string }[];
  assert.equal(tools[0]?.name, PROBE_TOOL_NAME);
});

test("the mid-conversation beta is the documented value, and every Claude step asks for it", () => {
  assert.equal(CLAUDE_MID_CONVERSATION_BETA, "mid-conversation-output-config-2026-07-01");
  for (const candidate of probePlan(PROBE_MODELS.sonnet)) {
    assert.deepEqual(candidate.overrides.betas, [CLAUDE_MID_CONVERSATION_BETA], candidate.id);
  }
});

test("the Claude tool_result change follows the tool result, and the control ends on the tool result itself", () => {
  const plan = probePlan(PROBE_MODELS.haiku);
  const ta = messagesOf(step(plan, "TA"));
  const tb = messagesOf(step(plan, "TB"));
  assert.equal((ta[0]?.content as Loose[])[1]?.text, TOOL_TURN);
  const toolUse = (ta.at(-2)?.content as Loose[])[0];
  assert.equal(toolUse?.type, "tool_use");
  assert.equal(toolUse?.name, PROBE_TOOL_NAME);
  const toolResult = (ta.at(-1)?.content as Loose[]) ?? [];
  assert.ok(toolResult.length > 0 && toolResult.every((block) => block.type === "tool_result"), "the last user message holds only tool_result blocks");
  assert.equal(toolResult[0]?.tool_use_id, toolUse?.id);
  assert.equal(toolResult[0]?.content, PROBE_NUMBERS);
  assert.deepEqual(tb.slice(0, -1), ta, "the changed request is the control plus one message");
  assert.deepEqual(tb.at(-1), { role: "system", content: [], output_config: { effort: "high" } });
  assert.deepEqual(step(plan, "TB").overrides.output_config, { effort: "low" });
  assert.deepEqual(step(plan, "TA").overrides.output_config, { effort: "low" });
});

test("the tool_result reference runs the same tool_result request at the changed top-level effort, with no per-message change", () => {
  const plan = probePlan(PROBE_MODELS.haiku);
  const th = step(plan, "TH");
  assert.equal(th.topEffort, "high");
  assert.deepEqual(th.overrides.output_config, { effort: "high" });
  assert.deepEqual(messagesOf(th), messagesOf(step(plan, "TA")));
});

test("every model's plan includes the negative control and the tool_result reference, once each", () => {
  for (const model of Object.values(PROBE_MODELS)) {
    const ids = probePlan(model).map((candidate) => candidate.id);
    assert.deepEqual(ids, ["R1", "R2", "C2", "NC", "TA", "TB", "TH"], model.id);
  }
});

test("GPT-6 R2 sends the configuration update right before the new user turn and leaves the request-level effort alone", () => {
  const r2 = step(probePlan(PROBE_MODELS.astra), "R2");
  assert.deepEqual(r2.overrides.reasoning, { effort: "low", summary: "auto" });
  assert.equal(r2.topEffort, "low");
  assert.deepEqual(inputOf(r2).slice(-2), [{ type: "configuration_update", reasoning: { effort: "high" } }, { role: "user", content: NEW_TURN }]);
  assert.equal(inputOf(r2).filter((item) => item.type === "configuration_update").length, 1);
});

test("both GPT-6 models send the request-level reasoning as pi does, with no cache option, since the diagnostics showed no cache either way", () => {
  for (const model of [PROBE_MODELS.astra, PROBE_MODELS.sol]) {
    for (const candidate of probePlan(model)) {
      assert.deepEqual(candidate.overrides.reasoning, { effort: candidate.topEffort, summary: "auto" }, `${model.id} ${candidate.id}`);
      assert.equal("prompt_cache_options" in candidate.overrides, false, `${model.id} ${candidate.id}`);
    }
  }
});

test("the GPT-6 control is R2 without the update, at the same request-level effort", () => {
  const c2 = step(probePlan(PROBE_MODELS.astra), "C2");
  assert.deepEqual(c2.overrides.reasoning, { effort: "low", summary: "auto" });
  const [notes, ...rest] = inputOf(c2);
  assert.equal(notes?.role, "developer", "the stable notes open the input, where OpenAI counts the minimum");
  assert.deepEqual(rest, [
    { role: "user", content: FIRST_TURN },
    { role: "assistant", content: "noted." },
    { role: "user", content: NEW_TURN },
  ]);
});

test("the GPT-6 negative control moves the request-level effort on the control's input, with no update", () => {
  const plan = probePlan(PROBE_MODELS.astra);
  const nc = step(plan, "NC");
  assert.deepEqual(nc.overrides.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(inputOf(nc), inputOf(step(plan, "C2")));
});

test("the GPT-6 tool_result change follows the function output, the call and its output stay paired, and the reference moves the request-level effort", () => {
  const plan = probePlan(PROBE_MODELS.astra);
  const ta = inputOf(step(plan, "TA"));
  const tb = inputOf(step(plan, "TB"));
  const call = ta.find((item) => item.type === "function_call");
  const output = ta.find((item) => item.type === "function_call_output");
  assert.equal(call?.name, PROBE_TOOL_NAME);
  assert.equal(output?.call_id, call?.call_id);
  assert.equal(output?.output, PROBE_NUMBERS);
  assert.equal(ta.at(-1)?.type, "function_call_output", "the control ends on the function output");
  assert.deepEqual(tb.slice(0, -1), ta);
  assert.deepEqual(tb.at(-1), { type: "configuration_update", reasoning: { effort: "high" } });
  assert.deepEqual(step(plan, "TB").overrides.reasoning, { effort: "low", summary: "auto" });
  assert.deepEqual(step(plan, "TH").overrides.reasoning, { effort: "high", summary: "auto" });
  assert.deepEqual(inputOf(step(plan, "TH")), ta);
});

test("every GPT-6 step opens with the same notes, tools and cache key, and none asks the model to call a tool", () => {
  const plan = probePlan(PROBE_MODELS.astra);
  const [first] = plan;
  assert.ok(first, "the plan is not empty");
  for (const candidate of plan) {
    assert.deepEqual(inputOf(candidate)[0], inputOf(first)[0], `${candidate.id} notes`);
    assert.equal(candidate.overrides.instructions, first.overrides.instructions, `${candidate.id} instructions`);
    assert.deepEqual(candidate.overrides.tools, first.overrides.tools, `${candidate.id} tools`);
    assert.equal(candidate.overrides.prompt_cache_key, first.overrides.prompt_cache_key, `${candidate.id} cache key`);
    assert.equal(candidate.overrides.tool_choice, "none", candidate.id);
  }
  const notes = (inputOf(first)[0]?.content as Loose[])[0];
  assert.equal(notes?.type, "input_text");
  assert.ok(String(notes?.text).length >= 8000, "the notes must clear OpenAI's 1,024 visible input tokens: 5,800 characters (in instructions) measured about 1,000 tokens and never cached");
  const tools = first.overrides.tools as { type: string; name: string }[];
  assert.deepEqual(tools.map((tool) => [tool.type, tool.name]), [["function", PROBE_TOOL_NAME]]);
});

test("the probe models are the ones the owner named, with the documented minimum cacheable lengths", () => {
  assert.deepEqual(
    Object.values(PROBE_MODELS).map((model) => [model.provider, model.id, model.minimumCacheTokens]),
    [
      ["anthropic", "claude-haiku-5-5", 512],
      ["anthropic", "claude-sonnet-5-5", 512],
      ["anthropic", "claude-opus-5-5", 512],
      ["openai-codex", "gpt-6-astra", 1024],
      ["openai-codex", "gpt-6.1-sol", 1024],
    ],
  );
});

test("mergePayload keeps pi's own fields, replaces the overridden ones, and unions the betas without touching its inputs", () => {
  const payload = { model: "claude-haiku-5-5", stream: true, betas: ["claude-code-20250219", "oauth-2025-04-20"], output_config: { effort: "high" } };
  const overrides = { output_config: { effort: "low" }, betas: [CLAUDE_MID_CONVERSATION_BETA, "oauth-2025-04-20"] };
  assert.deepEqual(mergePayload(payload, overrides), {
    model: "claude-haiku-5-5",
    stream: true,
    betas: ["claude-code-20250219", "oauth-2025-04-20", CLAUDE_MID_CONVERSATION_BETA],
    output_config: { effort: "low" },
  });
  assert.deepEqual(payload.output_config, { effort: "high" });
  assert.deepEqual(payload.betas, ["claude-code-20250219", "oauth-2025-04-20"]);
});

test("the assistant reply is the last assistant message_end, and its usage is read as pi reports it", () => {
  const stdout = [
    JSON.stringify({ type: "session", id: "header" }),
    "not json",
    JSON.stringify({ type: "message_end", message: { role: "user", content: "probe" } }),
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        content: [{ type: "thinking", thinking: "abc" }, { type: "text", text: "noted." }],
        usage: { input: 12, output: 34, cacheRead: 640, cacheWrite: 0, reasoning: 7 },
      },
    }),
  ].join("\n");
  const message = assistantMessageOf(stdout);
  assert.equal(message?.stopReason, "stop");
  assert.deepEqual(usageOf(message), { input: 12, output: 34, cacheRead: 640, cacheWrite: 0, reasoning: 7, thinkingChars: 3, stopReason: "stop" });
});

test("the raw usage of a provider stream event is kept only where the provider reports it: Anthropic's message_start and message_delta, OpenAI's response.completed", () => {
  const anthropicStart = { type: "message_start", message: { usage: { input_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 1421, output_tokens: 1 } } };
  assert.deepEqual(rawUsageOf(anthropicStart), { input_tokens: 15, cache_read_input_tokens: 0, cache_creation_input_tokens: 1421, output_tokens: 1 });
  assert.deepEqual(rawUsageOf({ type: "message_delta", usage: { output_tokens: 4 } }), { output_tokens: 4 });
  const openaiDone = { type: "response.completed", response: { usage: { input_tokens: 1830, input_tokens_details: { cached_tokens: 1408 }, output_tokens: 6 } } };
  assert.deepEqual(rawUsageOf(openaiDone), { input_tokens: 1830, input_tokens_details: { cached_tokens: 1408 }, output_tokens: 6 });
  assert.equal(rawUsageOf({ type: "response.output_text.delta", delta: "noted." }), undefined);
  assert.equal(rawUsageOf("not an object"), undefined);
});

test("usage without a reasoning count leaves it out, instead of reporting zero", () => {
  const found = usageOf({ stopReason: "stop", content: [], usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } });
  assert.equal(found.reasoning, undefined);
  assert.equal(usageOf(undefined).output, 0, "no assistant message reads as zero usage");
});

test("a run stops on an error reply, on a missing assistant message and on a non-zero exit, and names the error text", () => {
  const ok = { stopReason: "stop", content: [], usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } };
  assert.equal(runError(ok, 0, ""), undefined);
  assert.equal(runError({ ...ok, stopReason: "error", errorMessage: "400 messages.2: Extra inputs are not permitted" }, 0, ""), "400 messages.2: Extra inputs are not permitted");
  assert.match(runError(undefined, 0, "boom") ?? "", /no assistant message/);
  assert.match(runError(ok, 2, "stderr text") ?? "", /exit 2/);
});

test("the cache is kept when the changed request reads about what the control reads", () => {
  assert.equal(cacheKept({ control: usage({ cacheRead: 640 }), changed: usage({ cacheRead: 640 }), written: usage({ cacheWrite: 640 }) }).verdict, "yes");
  assert.equal(
    cacheKept({ control: usage({ cacheRead: 1152 }), changed: usage({ cacheRead: 1024 }), written: usage({ cacheWrite: 1280 }) }).verdict,
    "yes",
    "one 128-token cache block of rounding is not a loss",
  );
});

test("the cache is not kept when the changed request has to write the prefix again", () => {
  const verdict = cacheKept({ control: usage({ cacheRead: 640 }), changed: usage({ cacheRead: 0, cacheWrite: 640 }), written: usage({ cacheWrite: 640 }) });
  assert.equal(verdict.verdict, "no");
});

test("the cache is not measured when the control reads nothing, or the first request wrote nothing", () => {
  assert.equal(cacheKept({ control: usage({ cacheRead: 0 }), changed: usage({ cacheRead: 0 }), written: usage({ cacheWrite: 640 }) }).verdict, "not measured");
  assert.equal(cacheKept({ control: usage({ cacheRead: 640 }), changed: usage({ cacheRead: 640 }), written: usage({}) }).verdict, "not measured");
});

test("the cache test can fail: a negative control that breaks the cache shows the test discriminates", () => {
  const control = usage({ cacheRead: 1349 });
  assert.equal(cacheSensitivity({ control, negative: usage({ cacheRead: 0, cacheWrite: 1349 }) }).verdict, "discriminates");
  assert.equal(cacheSensitivity({ control, negative: usage({ cacheRead: 1349 }) }).verdict, "does not discriminate", "a control that keeps the cache too tells nothing");
});

test("a tool_result change is applied when its reply reaches the high reference's effort, using reasoning tokens when reported", () => {
  const verdict = toolResultChange({
    control: usage({ reasoning: 70, output: 85 }),
    changed: usage({ reasoning: 130, output: 150 }),
    reference: usage({ reasoning: 137, output: 160 }),
  });
  assert.equal(verdict.verdict, "applied", verdict.reason);
});

test("a tool_result change is not applied when its reply stays at the control's effort", () => {
  const verdict = toolResultChange({
    control: usage({ reasoning: 70, output: 85 }),
    changed: usage({ reasoning: 74, output: 90 }),
    reference: usage({ reasoning: 137, output: 160 }),
  });
  assert.equal(verdict.verdict, "not applied", verdict.reason);
});

test("a tool_result change is inconclusive when the high reference does not separate from the control", () => {
  const verdict = toolResultChange({
    control: usage({ output: 40 }),
    changed: usage({ output: 300 }),
    reference: usage({ output: 45 }),
  });
  assert.equal(verdict.verdict, "inconclusive", verdict.reason);
});

test("a reply between the control and the reference is inconclusive, not applied", () => {
  const verdict = toolResultChange({
    control: usage({ output: 40 }),
    changed: usage({ output: 90 }),
    reference: usage({ output: 140 }),
  });
  assert.equal(verdict.verdict, "inconclusive", verdict.reason);
});

test("the notes are deterministic and at least the requested length", () => {
  const notes = probeNotes(3200);
  assert.ok(notes.length >= 3200);
  assert.equal(probeNotes(3200), notes);
  assert.ok(notes.startsWith("Stable reference notes"));
});
