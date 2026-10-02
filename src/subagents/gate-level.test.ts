import assert from "node:assert/strict";
import { test } from "node:test";
import type { GateLevel } from "./quality-gate.ts";
import { GateLevels, GATE_USAGE } from "./gate-level.ts";

// The gate level in force in one orchestrator session (ADR 0011): the owner's
// setting, or the level `/pi-orchestrator gate <level>` set for the session.
// Seam: `GateLevels` over a settings reader and a session id.

const session = (id: string) => ({ cwd: "/project", sessionManager: { getSessionId: () => id } });

function levels(settings: GateLevel = "medium") {
  let fromSettings = settings;
  return { gate: new GateLevels(() => fromSettings), setSettings: (level: GateLevel) => { fromSettings = level; } };
}

test("without a session level the settings' level is in force, read each time", () => {
  const { gate, setSettings } = levels("high");
  assert.deepEqual(gate.inForce(session("a")), { level: "high", source: "settings" });
  setSettings("low");
  assert.deepEqual(gate.inForce(session("a")), { level: "low", source: "settings" });
});

test("gate <level> sets the level for this session only, lower or higher than the settings", () => {
  const { gate } = levels("medium");
  assert.deepEqual(gate.command("max", session("a")), { line: "pi-orchestrator: gate level max for this session (settings say medium).", type: "info" });
  assert.deepEqual(gate.inForce(session("a")), { level: "max", source: "session" });
  assert.deepEqual(gate.inForce(session("b")), { level: "medium", source: "settings" }, "another session keeps the settings' level");
  gate.command("low", session("a"));
  assert.deepEqual(gate.inForce(session("a")), { level: "low", source: "session" });
  gate.reset();
  assert.deepEqual(gate.inForce(session("a")), { level: "medium", source: "settings" }, "a session start drops the session level");
});

test("gate without a level shows the level in force and where it comes from", () => {
  const { gate } = levels("medium");
  assert.deepEqual(gate.command("", session("a")), { line: `pi-orchestrator: gate level medium, from settings.\n${GATE_USAGE}`, type: "info" });
  gate.command("high", session("a"));
  assert.deepEqual(gate.command("", session("a")), { line: `pi-orchestrator: gate level high, set for this session (settings say medium).\n${GATE_USAGE}`, type: "info" });
});

test("an invalid level is refused with the usage and changes nothing", () => {
  const { gate } = levels("medium");
  for (const rest of ["strict", "High", "high now", "none"]) {
    assert.deepEqual(gate.command(rest, session("a")), { line: GATE_USAGE, type: "warning" }, rest);
  }
  assert.equal(GATE_USAGE, "usage: /pi-orchestrator gate [off|low|medium|high|max]");
  assert.deepEqual(gate.inForce(session("a")), { level: "medium", source: "settings" });
});

test("gate off turns the quality gate off for this session, and the settings may say off too", () => {
  const { gate, setSettings } = levels("medium");
  assert.deepEqual(gate.command("off", session("a")), { line: "pi-orchestrator: gate level off for this session (settings say medium).", type: "info" });
  assert.deepEqual(gate.inForce(session("a")), { level: "off", source: "session" });
  setSettings("off");
  assert.deepEqual(gate.inForce(session("b")), { level: "off", source: "settings" });
});
