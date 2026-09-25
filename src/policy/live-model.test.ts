import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APPROVED_LIVE_PI_MODELS,
  DEFAULT_LIVE_PI_MODEL,
  SUBSCRIPTION_TEST_MODEL,
  livePiModelAvailability,
  selectedLivePiModel,
} from "./live-model.ts";

test("live model selection defaults to the exact Claude subscription route", () => {
  assert.equal(selectedLivePiModel({}), DEFAULT_LIVE_PI_MODEL);
  assert.equal(DEFAULT_LIVE_PI_MODEL, "anthropic/claude-haiku-4-5");
  assert.equal(DEFAULT_LIVE_PI_MODEL, SUBSCRIPTION_TEST_MODEL);
});

test("live model selection accepts only exact approved IDs", () => {
  assert.equal(
    selectedLivePiModel({ PI_HARNESS_LIVE_MODEL: "openai-codex/gpt-6-luna" }),
    "openai-codex/gpt-6-luna",
  );
  assert.equal(
    selectedLivePiModel({ PI_HARNESS_LIVE_MODEL: "anthropic/claude-haiku-4-5" }),
    "anthropic/claude-haiku-4-5",
  );
  for (const value of [
    "openai-codex/*",
    "anthropic/*",
    "anthropic/claude-*",
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "anthropic/claude-haiku-4-5:high",
    "anthropic/claude-haiku-4-5-20251001",
    "anthropic/claude-sonnet-5",
    "openai-codex/gpt-6-astra",
    "anthropic/claude-opus-fable-6",
    "anthropic/claude-sonnet-5-astra",
    "openai-codex/gpt-5.7-astra",
    "openai-codex/gpt-6-luna:high",
    "claude-bridge/claude-sonnet-5",
    "",
  ]) {
    assert.throws(
      () => selectedLivePiModel({ PI_HARNESS_LIVE_MODEL: value }),
      /Unsupported PI_HARNESS_LIVE_MODEL/,
      `expected ${JSON.stringify(value)} to be rejected`,
    );
  }
  assert.ok(!APPROVED_LIVE_PI_MODELS.includes("openai-codex/gpt-6-astra" as never));
  assert.ok(!APPROVED_LIVE_PI_MODELS.includes("anthropic/claude-fable-5" as never));
  assert.ok(!APPROVED_LIVE_PI_MODELS.includes("anthropic/claude-fable-5-1" as never));
});

test("model registry confirms listed and absent routes separately", () => {
  const stdout =
    "provider      model                       context  max-out  thinking  images\n" +
    "openai-codex  gpt-6-luna                  272K     128K     yes       no\n";
  assert.deepEqual(
    livePiModelAvailability("openai-codex/gpt-6-luna", () => ({ status: 0, stdout })),
    { status: "available" },
  );
  assert.deepEqual(
    livePiModelAvailability("anthropic/claude-haiku-4-5", () => ({ status: 0, stdout })),
    { status: "unavailable", reason: "not-listed" },
  );
});

test("truncated model rows under a valid header are malformed, not absent routes", () => {
  const header = "provider model context max-out thinking images";
  for (const row of [
    "openai-codex gpt-6-luna",
    "openai-codex gpt-6-luna 272K 128K yes",
  ]) {
    assert.throws(
      () => livePiModelAvailability("anthropic/claude-haiku-4-5", () => ({
        status: 0,
        stdout: `${header}\n${row}\n`,
      })),
      /malformed pi --list-models row/,
      `expected truncated row ${JSON.stringify(row)} to fail registry validation`,
    );
  }
});

test("model registry failures throw instead of making live checks skippable", () => {
  assert.throws(
    () => livePiModelAvailability("openai-codex/gpt-6-luna", () => ({ status: 1, stderr: "registry error" })),
    /exited with 1/,
  );
  assert.throws(
    () => livePiModelAvailability("openai-codex/gpt-6-luna", () => ({
      status: null,
      error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
    })),
    /timed out/,
  );
  for (const stdout of ["garbled output", "provider model\n"]) {
    assert.throws(
      () => livePiModelAvailability("openai-codex/gpt-6-luna", () => ({ status: 0, stdout })),
      /malformed pi --list-models output/,
      `expected malformed header ${JSON.stringify(stdout)} to fail`,
    );
  }
});

test("Codex portability does not redefine the subscription test route", () => {
  const genericRoute = selectedLivePiModel({ PI_HARNESS_LIVE_MODEL: "openai-codex/gpt-6-luna" });
  assert.notEqual(genericRoute, SUBSCRIPTION_TEST_MODEL);
  assert.equal(SUBSCRIPTION_TEST_MODEL, "anthropic/claude-haiku-4-5");
});
