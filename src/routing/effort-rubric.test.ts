import assert from "node:assert/strict";
import { test } from "node:test";
import { effortJudgePrompt } from "./effort-rubric.ts";

const band = { min: "low", max: "xhigh" } as const;

const promptInput = {
  message: "Evaluate this work",
  kind: "task" as const,
  tier: "standard" as const,
  band,
  currentEffort: "medium" as const,
  turnRunning: false,
};

test("the effort judge rubric prioritizes correctness and includes the required effort cues", () => {
  const prompt = effortJudgePrompt(promptInput);
  for (const cue of [
    "Choose the lowest effort inside the supplied band",
    "Correctness comes before speed.",
    "Questions, lookups and mechanical edits usually need low effort.",
    "Multi-file design, debugging and security work usually need high effort.",
    "choose at least high",
    "pushes back because a previous answer was bad",
  ]) {
    assert.ok(prompt.includes(cue), `missing rubric cue: ${cue}`);
  }
});

test("the effort judge prompt bounds the message and orchestrator context, and excludes tool results", () => {
  const input = {
    message: `${"M".repeat(2_000)}MESSAGE-OVERFLOW`,
    kind: "user-prompt" as const,
    tier: "orchestrator" as const,
    band,
    currentEffort: "medium" as const,
    turnRunning: false,
    lastUserMessage: `${"U".repeat(400)}USER-OVERFLOW`,
    lastAssistantReply: `REPLY-OVERFLOW${"R".repeat(2_000)}`,
    toolResults: "PRIVATE-TOOL-RESULT",
  };
  const prompt = effortJudgePrompt(input);

  assert.equal(prompt.includes("M".repeat(2_000)), true);
  assert.equal(prompt.includes("MESSAGE-OVERFLOW"), false);
  assert.equal(prompt.includes("U".repeat(400)), true);
  assert.equal(prompt.includes("USER-OVERFLOW"), false);
  assert.equal(prompt.includes("REPLY-OVERFLOW"), false);
  assert.equal(prompt.includes("R".repeat(2_000)), true);
  assert.equal(prompt.includes("PRIVATE-TOOL-RESULT"), false);
  assert.match(prompt, /Effort judge rubric version: effort-rubric-1/);
});

test("worker steering context includes only the task's first 400 characters", () => {
  const input = {
    message: "Please revise the approach",
    kind: "steer" as const,
    tier: "standard" as const,
    band,
    currentEffort: "low" as const,
    turnRunning: false,
    taskPrefix: `${"T".repeat(400)}TASK-OVERFLOW`,
    lastUserMessage: "not worker context",
    lastAssistantReply: "not worker context",
    toolResults: "PRIVATE-TOOL-RESULT",
  };
  const prompt = effortJudgePrompt(input);

  assert.equal(prompt.includes("T".repeat(400)), true);
  assert.equal(prompt.includes("TASK-OVERFLOW"), false);
  assert.equal(prompt.includes("not worker context"), false);
  assert.equal(prompt.includes("PRIVATE-TOOL-RESULT"), false);
});
