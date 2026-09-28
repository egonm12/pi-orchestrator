import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentsSettingsFromSettings } from "./settings.ts";

test("without personal settings the defaults apply and allowProjectOverrides is off", () => {
  assert.deepEqual(subagentsSettingsFromSettings({}), {
    settings: { maxParallel: 4, maxBackgroundWorkers: 8, agentDefinitionModel: { use: "route", allowBanned: false }, explorationBudget: 3, gateLevel: "medium" },
    allowProjectOverrides: false,
    ignoredProjectKeys: [],
  });
});

test("with allowProjectOverrides a project key replaces the personal value and the flag stays personal", () => {
  const personal = { orchestrator: { subagents: { allowProjectOverrides: true, maxParallel: 3, agentDefinitionModel: { use: "preserve" } } } };
  const project = { orchestrator: { subagents: { maxParallel: 6, allowProjectOverrides: false } } };
  assert.deepEqual(subagentsSettingsFromSettings(personal, project), {
    settings: { maxParallel: 6, maxBackgroundWorkers: 8, agentDefinitionModel: { use: "preserve", allowBanned: false }, explorationBudget: 3, gateLevel: "medium" },
    allowProjectOverrides: true,
    ignoredProjectKeys: ["orchestrator.subagents.allowProjectOverrides"],
  });
});

test("without allowProjectOverrides a project's subagents value is ignored whatever its shape", () => {
  const personal = { orchestrator: { subagents: { maxParallel: 2 } } };
  const ignored = (project: unknown) => subagentsSettingsFromSettings(personal, project).ignoredProjectKeys;
  assert.deepEqual(ignored({ orchestrator: { subagents: "all" } }), ["orchestrator.subagents"]);
  assert.deepEqual(ignored({ orchestrator: { subagents: { maxParallel: 8 } } }), ["orchestrator.subagents.maxParallel"]);
  assert.equal(subagentsSettingsFromSettings(personal, { orchestrator: { subagents: { maxParallel: 8 } } }).settings.maxParallel, 2);
});

test("a malformed project value fails closed when projects may override", () => {
  const personal = { orchestrator: { subagents: { allowProjectOverrides: true } } };
  assert.throws(() => subagentsSettingsFromSettings(personal, { orchestrator: { subagents: [] } }), /project orchestrator.subagents must be an object/);
  assert.throws(() => subagentsSettingsFromSettings(personal, { orchestrator: { subagents: { maxParallel: 0 } } }), /maxParallel must be a positive integer/);
  assert.throws(() => subagentsSettingsFromSettings(personal, { orchestrator: { subagents: { agentDefinitionModel: { use: "pin" } } } }), /use must be route or preserve/);
});

test("allowBanned is read from agentDefinitionModel, and a project's agentDefinitionModel replaces it whole", () => {
  const personal = { orchestrator: { subagents: { allowProjectOverrides: true, agentDefinitionModel: { use: "preserve", allowBanned: true } } } };
  assert.deepEqual(subagentsSettingsFromSettings(personal).settings.agentDefinitionModel, { use: "preserve", allowBanned: true });
  const project = { orchestrator: { subagents: { agentDefinitionModel: { use: "preserve" } } } };
  assert.deepEqual(subagentsSettingsFromSettings(personal, project).settings.agentDefinitionModel, { use: "preserve", allowBanned: false });
  assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { agentDefinitionModel: { allowBanned: "yes" } } } }), /allowBanned must be a boolean/);
});

test("maxBackgroundWorkers defaults to 8, takes a positive integer, and a project may replace it only with allowProjectOverrides", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { maxBackgroundWorkers: 12 } } }).settings.maxBackgroundWorkers, 12);
  const project = { orchestrator: { subagents: { maxBackgroundWorkers: 2 } } };
  assert.equal(subagentsSettingsFromSettings({}, project).settings.maxBackgroundWorkers, 8);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true } } }, project).settings.maxBackgroundWorkers, 2);
  for (const value of [0, 1.5, "8"]) {
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { maxBackgroundWorkers: value } } }), /maxBackgroundWorkers must be a positive integer/);
  }
});

test("explorationBudget defaults to 3, takes a positive integer, and a project may replace it only with allowProjectOverrides", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationBudget: 5 } } }).settings.explorationBudget, 5);
  const project = { orchestrator: { subagents: { explorationBudget: 20 } } };
  assert.equal(subagentsSettingsFromSettings({}, project).settings.explorationBudget, 3);
  assert.deepEqual(subagentsSettingsFromSettings({}, project).ignoredProjectKeys, ["orchestrator.subagents.explorationBudget"]);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true } } }, project).settings.explorationBudget, 20);
  for (const value of [0, 2.5, "3", -1]) {
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationBudget: value } } }), /explorationBudget must be a positive integer/);
  }
});

test("gateLevel defaults to medium, takes low, medium, high or max, and a project may replace it only with allowProjectOverrides", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: "high" } } }).settings.gateLevel, "high");
  const project = { orchestrator: { subagents: { gateLevel: "low" } } };
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: "max" } } }, project).settings.gateLevel, "max");
  assert.deepEqual(subagentsSettingsFromSettings({}, project).ignoredProjectKeys, ["orchestrator.subagents.gateLevel"]);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true, gateLevel: "max" } } }, project).settings.gateLevel, "low");
  for (const value of ["strict", "Medium", 2]) {
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: value } } }), /gateLevel must be low, medium, high or max/);
  }
});
