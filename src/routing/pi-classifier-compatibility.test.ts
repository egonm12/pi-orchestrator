import assert from "node:assert/strict";
import { test } from "node:test";
import { CLASSIFIER_SYSTEM_PROMPT, type PiClassifierUsage, type PiClassifierReply } from "./classifier-reply.ts";

test("the classifier reply module keeps its public prompt and reply types", () => {
  const usage: PiClassifierUsage = { input: 2, output: 3, totalTokens: 5 };
  const reply: PiClassifierReply = { text: "answer", usage };
  assert.equal(CLASSIFIER_SYSTEM_PROMPT, "You are a task classifier. You never use tools. You answer with one JSON object only.");
  assert.equal(reply.usage?.totalTokens, 5);
});
