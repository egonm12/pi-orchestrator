import assert from "node:assert/strict";
import { test } from "node:test";
import { answerEvents, fakeSessionRegistry } from "../fixtures/session-model-registry.ts";
import { EFFORT_JUDGE_SYSTEM_PROMPT } from "./effort-rubric.ts";
import { sessionEffortJudgeModelCall } from "./session-effort-judge-call.ts";

const RUNG = "anthropic/claude-haiku-4-5:low";
const ANSWER = JSON.stringify({ effort: "low", why: "A brief lookup is straightforward." });

test("the in-session effort judge uses the shared classifier call with its own system prompt", async () => {
  const registry = fakeSessionRegistry([{ events: answerEvents(ANSWER) }]);
  const reply = await sessionEffortJudgeModelCall(registry)("the judge prompt", RUNG, new AbortController().signal);

  assert.equal(reply.text, ANSWER);
  assert.equal(registry.calls.length, 1);
  assert.equal(registry.calls[0]?.context.systemPrompt, EFFORT_JUDGE_SYSTEM_PROMPT);
  assert.deepEqual(
    registry.calls[0]?.context.messages.map((message) => [message.role, message.content]),
    [["user", "the judge prompt"]],
  );
});
