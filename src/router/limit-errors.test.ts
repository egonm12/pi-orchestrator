import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { limitErrorObservation } from "./limit-errors.ts";

// The error-text classifier against real limit errors from pi session logs
// (src/fixtures/usage/session-errors, bean pi-orchestrator-ugoi). Each fixture
// holds one assistant message's redacted error text, nothing else. These tests
// pin only which state the classifier gives each captured text; they do not
// claim what the provider meant by it.

const SESSION_ERRORS = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "usage", "session-errors");

interface SessionError { readonly provider: string; readonly timestamp: string; readonly stopReason: string; readonly errorMessage: string; readonly provenance: string }

function sessionError(file: string): SessionError {
  return JSON.parse(readFileSync(join(SESSION_ERRORS, file), "utf8")) as SessionError;
}

test("the captured Anthropic 429 rate_limit_error text is classified throttled with no reset, since it states none", () => {
  const error = sessionError("anthropic-rate-limit-error.json");
  assert.equal(error.provider, "anthropic");
  assert.equal(error.stopReason, "error");
  const at = new Date(error.timestamp);
  assert.deepEqual(limitErrorObservation(error.errorMessage, at), { state: "throttled", observedAt: at.toISOString(), source: "error" });
});

test("the captured Codex 'usage limit has been reached' text is classified exhausted with no reset, since it states none", () => {
  const error = sessionError("openai-codex-usage-limit-error.json");
  assert.equal(error.provider, "openai-codex");
  assert.equal(error.stopReason, "error");
  const at = new Date(error.timestamp);
  assert.deepEqual(limitErrorObservation(error.errorMessage, at), { state: "exhausted", observedAt: at.toISOString(), source: "error" });
});

test("every session-error fixture names its provenance and redacts the request id", () => {
  for (const file of ["anthropic-rate-limit-error.json", "openai-codex-usage-limit-error.json"]) {
    const error = sessionError(file);
    assert.equal(error.provenance, "pi session assistant message", file);
    assert.doesNotMatch(error.errorMessage, /req_[A-Za-z0-9]/, file);
  }
});

test("the quota and billing errors pi never retries are classified exhausted", () => {
  const at = new Date("2026-09-26T12:00:00.000Z");
  for (const text of ["insufficient_quota: You exceeded your current quota", "429 Quota exceeded for this project", "Your credit balance is too low to access the API. Please go to Plans & Billing",
    "You are out of budget", "Monthly usage limit reached. Enable available balance usage", "GoUsageLimitError", "subscription_sharing_usage_limit_exceeded"]) {
    assert.deepEqual(limitErrorObservation(text, at), { state: "exhausted", observedAt: at.toISOString(), source: "error" }, text);
  }
});
