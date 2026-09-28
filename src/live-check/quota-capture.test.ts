import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import quotaCapture, { REDACTED } from "./quota-capture.ts";

// The capture extension, loaded through its pi entry point with a fake
// ExtensionAPI and fed fake events. The records in the JSONL file are the
// behaviour under test.

const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-quota-capture-"));
const saved = { file: process.env.PI_QUOTA_CAPTURE_FILE, label: process.env.PI_QUOTA_CAPTURE_CASE, state: process.env.PI_ORCHESTRATOR_STATE_DIR, agent: process.env.PI_CODING_AGENT_DIR };
process.env.PI_CODING_AGENT_DIR = join(root, "agent");
after(() => {
  for (const [name, value] of [["PI_QUOTA_CAPTURE_FILE", saved.file], ["PI_QUOTA_CAPTURE_CASE", saved.label],
    ["PI_ORCHESTRATOR_STATE_DIR", saved.state], ["PI_CODING_AGENT_DIR", saved.agent]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(file: string | undefined, label?: string): Map<string, Handler> {
  if (file === undefined) delete process.env.PI_QUOTA_CAPTURE_FILE; else process.env.PI_QUOTA_CAPTURE_FILE = file;
  if (label === undefined) delete process.env.PI_QUOTA_CAPTURE_CASE; else process.env.PI_QUOTA_CAPTURE_CASE = label;
  const handlers = new Map<string, Handler>();
  quotaCapture({ on(event: string, handler: Handler) { handlers.set(event, handler); } } as unknown as ExtensionAPI);
  return handlers;
}

function context(provider: string, id: string, notices: string[] = []) {
  return {
    cwd: root, hasUI: true, model: { provider, id },
    sessionManager: { getSessionId: () => "session-1" },
    modelRegistry: { isUsingOAuth: () => true },
    ui: { notify: (message: string) => { notices.push(message); } },
  };
}

function records(file: string): Record<string, unknown>[] {
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

const assistant = (fields: Record<string, unknown>) => ({ type: "message_end", message: { role: "assistant", content: [], ...fields } });

test("a response is recorded with the request in flight, its status and every header, credentials and cookies redacted", async () => {
  const file = join(root, "anthropic.jsonl");
  const handlers = load(file, "anthropic-subscription");
  const notices: string[] = [];
  const ctx = context("anthropic", "claude-haiku-4-5", notices);
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);
  await handlers.get("before_provider_request")!({ type: "before_provider_request",
    payload: { model: "claude-haiku-4-5", messages: [{ role: "user", content: "a private prompt" }] } }, ctx);
  await handlers.get("after_provider_response")!({ type: "after_provider_response", status: 200, headers: {
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-tokens-remaining": "12000",
    "request-id": "req_1",
    "set-cookie": "__cf_bm=abc; path=/",
    "x-debug": "Bearer sk-ant-oat01-secretsecret",
  } }, ctx);
  await handlers.get("message_end")!(assistant({ provider: "anthropic", model: "claude-haiku-4-5", stopReason: "stop" }), ctx);

  assert.deepEqual(notices, [`quota capture: writing to ${file}`]);
  const [session, request, response, result, ...rest] = records(file);
  assert.equal(rest.length, 0);
  assert.equal(session?.kind, "session");
  assert.equal(session?.case, "anthropic-subscription");
  assert.equal(session?.oauth, true);
  assert.deepEqual({ ...request, at: undefined }, { v: 1, kind: "request", at: undefined, case: "anthropic-subscription",
    sessionId: "session-1", seq: 1, provider: "anthropic", model: "claude-haiku-4-5", oauth: true,
    payloadModel: "claude-haiku-4-5", openRequests: 1 });
  assert.equal(response?.kind, "response");
  assert.equal(response?.seq, 1);
  assert.equal(response?.attempt, 1);
  assert.equal(response?.provider, "anthropic");
  assert.equal(response?.model, "claude-haiku-4-5");
  assert.equal(response?.status, 200);
  assert.deepEqual(response?.headers, {
    "anthropic-ratelimit-tokens-remaining": "12000",
    "anthropic-ratelimit-unified-status": "allowed",
    "request-id": "req_1",
    "set-cookie": REDACTED,
    "x-debug": REDACTED,
  });
  assert.equal(result?.kind, "result");
  assert.equal(result?.stopReason, "stop");
  assert.equal(result?.responses, 1);
  assert.equal(result?.errorMessage, undefined);
  const raw = readFileSync(file, "utf8");
  assert.doesNotMatch(raw, /a private prompt|__cf_bm|sk-ant-oat01/);
});

test("a failed request keeps its error text and the count of response events it got", async () => {
  const file = join(root, "codex.jsonl");
  const handlers = load(file);
  const ctx = context("openai-codex", "gpt-5.5");
  await handlers.get("session_start")!({ type: "session_start", reason: "startup" }, ctx);

  // The SSE path: a 429 reaches after_provider_response, then the request fails.
  await handlers.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "gpt-5.5" } }, ctx);
  await handlers.get("after_provider_response")!({ type: "after_provider_response", status: 429, headers: { "x-codex-primary-used-percent": "100" } }, ctx);
  await handlers.get("message_end")!(assistant({ provider: "openai-codex", model: "gpt-5.5", stopReason: "error",
    errorMessage: "You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min. Bearer abc.def.ghi" }), ctx);

  // The WebSocket path: no response event at all, only the result.
  await handlers.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "gpt-5.5" } }, ctx);
  await handlers.get("message_end")!(assistant({ provider: "openai-codex", model: "gpt-5.5", stopReason: "error",
    errorMessage: "Codex error: usage_limit_reached",
    diagnostics: [{ type: "provider_transport_failure", timestamp: 1, error: { message: "closed", stack: "at x" }, details: { phase: "before_message_stream_start" } }] }), ctx);

  const all = records(file);
  assert.equal(all[0]?.case, "codex", "the case label defaults to the file name");
  const results = all.filter((record) => record.kind === "result");
  const responses = all.filter((record) => record.kind === "response");
  assert.equal(responses.length, 1);
  assert.equal(responses[0]?.seq, 1);
  assert.equal(responses[0]?.status, 429);
  assert.deepEqual(responses[0]?.headers, { "x-codex-primary-used-percent": "100" });
  assert.deepEqual(results.map((record) => [record.seq, record.provider, record.responses, record.errorMessage]), [
    [1, "openai-codex", 1, `You have hit your ChatGPT usage limit (plus plan). Try again in ~42 min. ${REDACTED}`],
    [2, "openai-codex", 0, "Codex error: usage_limit_reached"],
  ]);
  assert.deepEqual(results[1]?.diagnostics, [{ type: "provider_transport_failure", timestamp: 1, error: { message: "closed" }, details: { phase: "before_message_stream_start" } }]);
});

test("retried responses to one request are numbered in order", async () => {
  const file = join(root, "retries.jsonl");
  const handlers = load(file);
  const ctx = context("openai-codex", "gpt-5.5");
  await handlers.get("before_provider_request")!({ type: "before_provider_request", payload: { model: "gpt-5.5" } }, ctx);
  await handlers.get("after_provider_response")!({ type: "after_provider_response", status: 429, headers: { "retry-after": "2" } }, ctx);
  await handlers.get("after_provider_response")!({ type: "after_provider_response", status: 200, headers: {} }, ctx);
  await handlers.get("message_end")!(assistant({ stopReason: "stop" }), ctx);
  const responses = records(file).filter((record) => record.kind === "response");
  assert.deepEqual(responses.map((record) => [record.seq, record.attempt, record.status]), [[1, 1, 429], [1, 2, 200]]);
  assert.equal(records(file).find((record) => record.kind === "result")?.responses, 2);
});

test("without a named file, one file per pi process lands in the state folder's live-check folder", async () => {
  const state = join(root, "state");
  process.env.PI_ORCHESTRATOR_STATE_DIR = state;
  const first = load(undefined);
  await first.get("session_start")!({ type: "session_start", reason: "startup" }, context("anthropic", "claude-haiku-4-5"));
  // A reload loads the extension again; it keeps writing to the same file.
  const second = load(undefined);
  await second.get("session_start")!({ type: "session_start", reason: "reload" }, context("anthropic", "claude-haiku-4-5"));
  const folder = join(state, "live-check");
  assert.ok(existsSync(folder));
  const files = readdirSync(folder);
  assert.equal(files.length, 1);
  assert.match(files[0]!, new RegExp(`^quota-capture-.*-${process.pid}\\.jsonl$`));
  assert.deepEqual(records(join(folder, files[0]!)).map((record) => record.reason), ["startup", "reload"]);
});
