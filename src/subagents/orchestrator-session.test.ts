import assert from "node:assert/strict";
import { test } from "node:test";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { forkSession } from "./fork-session.ts";
import { isOrchestratorSession } from "./orchestrator-session.ts";
import { markWorkerSession } from "./worker-sessions.ts";

// The one answer to "is this the orchestrator's own session?". The
// subagents tool's workers, forked ones included, share the orchestrator's
// process and are marked per session; pi-subagents children are whole
// processes, marked by an environment variable.

const NO_MARKERS: NodeJS.ProcessEnv = {};

function sessionCtx(sessionManager = SessionManager.inMemory("/project")): Pick<ExtensionContext, "sessionManager"> {
  return { sessionManager };
}

test("the orchestrator's session is the orchestrator's session", () => {
  assert.equal(isOrchestratorSession(sessionCtx(), NO_MARKERS), true);
});

test("a context without a session manager in an unmarked process is the orchestrator's", () => {
  assert.equal(isOrchestratorSession({}, NO_MARKERS), true);
  assert.equal(isOrchestratorSession(undefined, NO_MARKERS), true);
});

test("a worker's session is not the orchestrator's, and only while it is marked", () => {
  const worker = sessionCtx();
  const unmark = markWorkerSession(worker.sessionManager.getSessionId());
  try {
    assert.equal(isOrchestratorSession(worker, NO_MARKERS), false);
    assert.equal(isOrchestratorSession(sessionCtx(), NO_MARKERS), true, "the orchestrator in the same process still is");
  } finally { unmark(); }
  assert.equal(isOrchestratorSession(worker, NO_MARKERS), true);
});

test("a nested worker's session is not the orchestrator's", () => {
  const nested = sessionCtx();
  const unmark = markWorkerSession(nested.sessionManager.getSessionId(), "parent-delegation");
  try { assert.equal(isOrchestratorSession(nested, NO_MARKERS), false); } finally { unmark(); }
});

test("a forked worker's session is not the orchestrator's, though it copies the orchestrator's conversation", () => {
  const parent = SessionManager.inMemory("/project");
  parent.appendMessage({ role: "user", content: "Fork from here", timestamp: Date.now() });
  parent.appendMessage({ role: "assistant", content: [{ type: "toolCall", id: "fork-call", name: "subagents", arguments: {} }], stopReason: "toolUse", timestamp: Date.now() } as never);
  const orchestrator = { cwd: "/project", sessionManager: parent } as unknown as ExtensionContext;
  const fork = sessionCtx(forkSession(orchestrator, "fork-call").sessionManager);
  assert.notEqual(fork.sessionManager.getSessionId(), parent.getSessionId());
  const unmark = markWorkerSession(fork.sessionManager.getSessionId());
  try {
    assert.equal(isOrchestratorSession(fork, NO_MARKERS), false);
    assert.equal(isOrchestratorSession(orchestrator, NO_MARKERS), true);
  } finally { unmark(); }
});

// pi-subagents marks the processes that host its delegated sessions: the
// async runner with PI_SUBAGENT_CHILD=1, a herdr pane-native child with
// PI_SUBAGENTS_HERDR_BRIDGE=1. No session there is the orchestrator's.
for (const marker of ["PI_SUBAGENT_CHILD", "PI_SUBAGENTS_HERDR_BRIDGE"]) {
  test(`no session in a child process (${marker}=1) is the orchestrator's`, () => {
    assert.equal(isOrchestratorSession(sessionCtx(), { [marker]: "1" }), false);
    assert.equal(isOrchestratorSession({}, { [marker]: "1" }), false);
    assert.equal(isOrchestratorSession(sessionCtx(), { [marker]: "0" }), true, "only the value 1 marks a child process");
  });
}

test("the check reads the process environment by default", () => {
  const original = process.env.PI_SUBAGENT_CHILD;
  process.env.PI_SUBAGENT_CHILD = "1";
  try { assert.equal(isOrchestratorSession(sessionCtx()), false); } finally {
    if (original === undefined) delete process.env.PI_SUBAGENT_CHILD;
    else process.env.PI_SUBAGENT_CHILD = original;
  }
});
