import assert from "node:assert/strict";
import { test } from "node:test";
import { WorkerLimits, WORKERS_USAGE, type SettingsWorkerLimit } from "./worker-limit.ts";

// The worker limit in force in one orchestrator session: the owner's settings,
// or the limit `/pi-orchestrator workers <n>` set for the session.
// Seam: `WorkerLimits` over a settings reader and a session id.

const session = (id: string) => ({ cwd: "/project", sessionManager: { getSessionId: () => id } });

function limits(settings: SettingsWorkerLimit = { limit: 4, source: "default" }) {
  let fromSettings = settings;
  return { workers: new WorkerLimits(() => fromSettings), setSettings: (next: SettingsWorkerLimit) => { fromSettings = next; } };
}

test("without a session limit the settings' limit and its source are in force, read each time", () => {
  const { workers, setSettings } = limits({ limit: 4, source: "default" });
  assert.deepEqual(workers.inForce(session("a")), { limit: 4, source: "default" });
  assert.equal(workers.session(session("a")), undefined);
  setSettings({ limit: 6, source: "personal" });
  assert.deepEqual(workers.inForce(session("a")), { limit: 6, source: "personal" });
});

test("workers <n> sets the limit for this session only, until the next session start", () => {
  const { workers } = limits({ limit: 4, source: "default" });
  assert.deepEqual(workers.command("8", session("a")), { line: "pi-orchestrator: worker limit 8 for this session (default 4).", type: "info" });
  assert.deepEqual(workers.inForce(session("a")), { limit: 8, source: "session" });
  assert.equal(workers.session(session("a")), 8);
  assert.deepEqual(workers.inForce(session("b")), { limit: 4, source: "default" }, "another session keeps the settings' limit");
  assert.equal(workers.session(session("b")), undefined);
  workers.command("1", session("a"));
  assert.deepEqual(workers.inForce(session("a")), { limit: 1, source: "session" }, "lower than the settings too");
  workers.reset();
  assert.deepEqual(workers.inForce(session("a")), { limit: 4, source: "default" }, "a session start drops the session limit");
});

test("workers without a number shows the limit in force and its source", () => {
  const { workers, setSettings } = limits({ limit: 4, source: "default" });
  assert.deepEqual(workers.command("", session("a")), { line: `pi-orchestrator: worker limit 4, the default.\n${WORKERS_USAGE}`, type: "info" });
  setSettings({ limit: 6, source: "personal" });
  assert.deepEqual(workers.command("", session("a")), { line: `pi-orchestrator: worker limit 6, from personal settings.\n${WORKERS_USAGE}`, type: "info" });
  setSettings({ limit: 2, source: "project" });
  assert.deepEqual(workers.command("", session("a")), { line: `pi-orchestrator: worker limit 2, from project settings.\n${WORKERS_USAGE}`, type: "info" });
  workers.command("12", session("a"));
  assert.deepEqual(workers.command("", session("a")),
    { line: `pi-orchestrator: worker limit 12, set for this session (project settings 2).\n${WORKERS_USAGE}`, type: "info" });
});

test("a number above 32 is cut to 32 with a notice, as in settings", () => {
  const { workers } = limits({ limit: 6, source: "personal" });
  assert.deepEqual(workers.command("50", session("a")), {
    line: "pi-orchestrator: 50 is above the ceiling of 32; worker limit 32 for this session (personal settings 6).",
    type: "warning",
  });
  assert.deepEqual(workers.inForce(session("a")), { limit: 32, source: "session" });
  workers.command("32", session("a"));
  assert.deepEqual(workers.inForce(session("a")), { limit: 32, source: "session" });
});

test("a bad argument prints the usage and changes nothing", () => {
  const { workers } = limits({ limit: 4, source: "default" });
  workers.command("3", session("a"));
  for (const rest of ["0", "-1", "1.5", "abc", "4 now", "+3", "1e2", "0x10"]) {
    assert.deepEqual(workers.command(rest, session("a")), { line: WORKERS_USAGE, type: "warning" }, rest);
  }
  assert.equal(WORKERS_USAGE, "usage: /pi-orchestrator workers [1-32]");
  assert.deepEqual(workers.inForce(session("a")), { limit: 3, source: "session" });
});
