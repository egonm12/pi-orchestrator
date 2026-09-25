import assert from "node:assert/strict";
import { test } from "node:test";
import { checkModelScope, matchesScopePattern } from "./model-scope.ts";

test("scope patterns are case-insensitive globs on provider/id without the thinking suffix", () => {
  assert.equal(matchesScopePattern("Anthropic/Claude-Haiku-4-5:high", "anthropic/*"), true);
  assert.equal(matchesScopePattern("openai-codex/gpt-6-luna", "openai/*"), false);
  assert.equal(matchesScopePattern("a/b.c", "a/b.c"), true);
  assert.equal(matchesScopePattern("a/bxc", "a/b.c"), false, "a dot is literal");
});

test("a scope pattern matches the whole model, not a part of it", () => {
  assert.equal(matchesScopePattern("anthropic/claude-haiku-4-5", "claude-haiku-*"), false);
  assert.equal(matchesScopePattern("anthropic/claude-haiku-4-5", "*claude-haiku-*"), true);
  assert.equal(matchesScopePattern("openai-codex/gpt-6-luna-x", "openai-codex/gpt-6-luna"), false);
  assert.equal(matchesScopePattern("ollama/qwen:7b", "ollama/qwen:7b"), true, "an unknown suffix stays part of the model");
});

test("scope patterns treat RegExp specials other than * literally", () => {
  assert.equal(matchesScopePattern("a/b+c", "a/b+c"), true);
  assert.equal(matchesScopePattern("a/bbc", "a/b+c"), false);
  assert.equal(matchesScopePattern("a/(x)", "a/(x)"), true);
  assert.equal(matchesScopePattern("a/x", "a/[x]"), false);
});

test("checkModelScope: explicit is an error, inherited a warning unless strict, and no-ops without enforcement", () => {
  const scope = { enforce: true, allow: ["anthropic/*"] };
  assert.equal(checkModelScope("anthropic/claude-haiku-4-5", scope, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna:low", scope, "explicit")?.severity, "error");
  assert.equal(checkModelScope("openai/gpt-6-luna", scope, "inherited")?.severity, "warn");
  assert.equal(checkModelScope("openai/gpt-6-luna", { ...scope, strict: true }, "inherited")?.severity, "error");
  assert.equal(checkModelScope("openai/gpt-6-luna", { allow: ["anthropic/*"] }, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna", { enforce: true, allow: [] }, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna", { enforce: true }, "explicit"), undefined);
  assert.equal(checkModelScope("openai/gpt-6-luna", undefined, "explicit"), undefined);
  assert.equal(checkModelScope(undefined, scope, "explicit"), undefined);
  assert.equal(checkModelScope("", scope, "explicit"), undefined);
});

test("a scope violation names the model without its suffix, the patterns and the origin", () => {
  const scope = { enforce: true, allow: ["anthropic/*"] };
  assert.deepEqual(checkModelScope("openai/gpt-6-luna:low", { ...scope, origin: "custom" }, "explicit"), {
    model: "openai/gpt-6-luna",
    severity: "error",
    allowedPatterns: ["anthropic/*"],
    origin: "custom",
    message: "Model 'openai/gpt-6-luna' is outside the configured subagent model scope (custom). Allowed patterns: anthropic/*.",
  });
  assert.equal(checkModelScope("openai/gpt-6-luna", scope, "explicit")?.origin, "modelScope");
});
