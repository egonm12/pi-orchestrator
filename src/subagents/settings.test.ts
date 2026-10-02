import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentsSettingsFromSettings } from "./settings.ts";

test("without personal settings the defaults apply and allowProjectOverrides is off", () => {
  assert.deepEqual(subagentsSettingsFromSettings({}), {
    settings: { workerLimit: 4, agentDefinitionModel: { use: "route", allowBanned: false }, explorationNudge: 3, gateLevel: "medium" },
    allowProjectOverrides: false,
    ignoredProjectKeys: [],
    warnings: [],
    workerLimitSource: "default",
  });
});

test("with allowProjectOverrides a project key replaces the personal value and the flag stays personal", () => {
  const personal = { orchestrator: { subagents: { allowProjectOverrides: true, maxParallel: 3, agentDefinitionModel: { use: "preserve" } } } };
  const project = { orchestrator: { subagents: { maxParallel: 6, allowProjectOverrides: false } } };
  assert.deepEqual(subagentsSettingsFromSettings(personal, project), {
    settings: { workerLimit: 6, agentDefinitionModel: { use: "preserve", allowBanned: false }, explorationNudge: 3, gateLevel: "medium" },
    allowProjectOverrides: true,
    ignoredProjectKeys: ["orchestrator.subagents.allowProjectOverrides"],
    warnings: [],
    workerLimitSource: "project",
  });
});

test("without allowProjectOverrides a project's subagents value is ignored whatever its shape", () => {
  const personal = { orchestrator: { subagents: { maxParallel: 2 } } };
  const ignored = (project: unknown) => subagentsSettingsFromSettings(personal, project).ignoredProjectKeys;
  assert.deepEqual(ignored({ orchestrator: { subagents: "all" } }), ["orchestrator.subagents"]);
  assert.deepEqual(ignored({ orchestrator: { subagents: { maxParallel: 8 } } }), ["orchestrator.subagents.maxParallel"]);
  assert.equal(subagentsSettingsFromSettings(personal, { orchestrator: { subagents: { maxParallel: 8 } } }).settings.workerLimit, 2);
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

test("workerLimit defaults to 4, takes a positive integer, and a project may set it higher or lower only with allowProjectOverrides", () => {
  const limit = (personal: unknown, project?: unknown) => subagentsSettingsFromSettings(personal, project).settings.workerLimit;
  assert.equal(limit({}), 4);
  assert.equal(limit({ orchestrator: { subagents: { workerLimit: 12 } } }), 12);
  const personal = (workerLimit: number, allowProjectOverrides = true) => ({ orchestrator: { subagents: { allowProjectOverrides, workerLimit } } });
  const project = (workerLimit: number) => ({ orchestrator: { subagents: { workerLimit } } });
  assert.equal(limit(personal(4), project(10)), 10, "higher");
  assert.equal(limit(personal(4), project(1)), 1, "lower");
  assert.equal(limit(personal(4, false), project(10)), 4, "without allowProjectOverrides the personal limit stays");
  assert.deepEqual(subagentsSettingsFromSettings(personal(4, false), project(10)).ignoredProjectKeys, ["orchestrator.subagents.workerLimit"]);
  for (const value of [0, 1.5, "8", -2]) {
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { workerLimit: value } } }), /workerLimit must be a positive integer/);
  }
});

test("a workerLimit above the ceiling of 32 is cut to 32 with one warning", () => {
  const loaded = subagentsSettingsFromSettings({ orchestrator: { subagents: { workerLimit: 100 } } });
  assert.equal(loaded.settings.workerLimit, 32);
  assert.deepEqual(loaded.warnings, ["orchestrator.subagents.workerLimit 100 is above the ceiling of 32; 32 workers run at once"]);
  assert.deepEqual(subagentsSettingsFromSettings({ orchestrator: { subagents: { workerLimit: 32 } } }).warnings, []);
  assert.deepEqual(subagentsSettingsFromSettings({ orchestrator: { subagents: { maxParallel: 40 } } }).warnings,
    ["orchestrator.subagents.maxParallel 40 is above the ceiling of 32; 32 workers run at once"], "a deprecated key is cut too, under its own name");
});

test("without workerLimit the deprecated maxParallel, then maxBackgroundWorkers, set it", () => {
  const limit = (subagents: Record<string, unknown>) => subagentsSettingsFromSettings({ orchestrator: { subagents } }).settings.workerLimit;
  assert.equal(limit({ maxBackgroundWorkers: 12 }), 12);
  assert.equal(limit({ maxParallel: 6, maxBackgroundWorkers: 12 }), 6);
  assert.equal(limit({ workerLimit: 3, maxParallel: 6, maxBackgroundWorkers: 12 }), 3);
  assert.equal(limit({ maxParallel: 16 }), 16, "no longer capped at 8");
  assert.throws(() => limit({ maxParallel: 0 }), /maxParallel must be a positive integer/);
  assert.throws(() => limit({ maxBackgroundWorkers: "8" }), /maxBackgroundWorkers must be a positive integer/);
  const project = { orchestrator: { subagents: { maxParallel: 2 } } };
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true } } }, project).settings.workerLimit, 2);
});

test("a project that sets any worker limit key wins over every personal one, by the same fallback order", () => {
  const limit = (personal: Record<string, unknown>, project: Record<string, unknown>) => subagentsSettingsFromSettings(
    { orchestrator: { subagents: { allowProjectOverrides: true, ...personal } } }, { orchestrator: { subagents: project } }).settings.workerLimit;
  assert.equal(limit({ workerLimit: 10 }, { maxParallel: 2 }), 2, "a project's deprecated key beats a personal workerLimit");
  assert.equal(limit({ workerLimit: 10, maxParallel: 8 }, { maxBackgroundWorkers: 3 }), 3);
  assert.equal(limit({ workerLimit: 10 }, { maxParallel: 5, maxBackgroundWorkers: 3 }), 5, "within the project the fallback order holds");
  assert.equal(limit({ maxParallel: 6 }, { workerLimit: 12 }), 12);
  assert.equal(limit({ workerLimit: 10 }, { gateLevel: "low" }), 10, "a project without a worker limit key leaves the personal one");
  assert.throws(() => limit({ workerLimit: 10 }, { maxParallel: 0 }), /maxParallel must be a positive integer/);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { workerLimit: 10 } } }, { orchestrator: { subagents: { maxParallel: 2 } } })
    .settings.workerLimit, 10, "without allowProjectOverrides the personal limit stays");
});

test("workerLimitSource names where the worker limit comes from: project, personal or default", () => {
  const source = (personal: Record<string, unknown>, project?: Record<string, unknown>) => subagentsSettingsFromSettings(
    { orchestrator: { subagents: personal } }, project === undefined ? undefined : { orchestrator: { subagents: project } }).workerLimitSource;
  assert.equal(source({}), "default");
  assert.equal(source({ gateLevel: "low" }), "default");
  assert.equal(source({ workerLimit: 6 }), "personal");
  assert.equal(source({ maxBackgroundWorkers: 6 }), "personal", "a deprecated key counts as set");
  assert.equal(source({ allowProjectOverrides: true, workerLimit: 6 }, { maxParallel: 2 }), "project");
  assert.equal(source({ allowProjectOverrides: true }, { gateLevel: "low" }), "default", "a project without a worker limit key");
  assert.equal(source({ workerLimit: 6 }, { workerLimit: 2 }), "personal", "without allowProjectOverrides the project is ignored");
  assert.equal(source({}, { workerLimit: 2 }), "default");
});

test("explorationNudge defaults to 3, takes a positive integer, and a project may replace it only with allowProjectOverrides", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationNudge: 5 } } }).settings.explorationNudge, 5);
  const project = { orchestrator: { subagents: { explorationNudge: 20 } } };
  assert.equal(subagentsSettingsFromSettings({}, project).settings.explorationNudge, 3);
  assert.deepEqual(subagentsSettingsFromSettings({}, project).ignoredProjectKeys, ["orchestrator.subagents.explorationNudge"]);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true } } }, project).settings.explorationNudge, 20);
  for (const value of [0, 2.5, "3", -1]) {
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationNudge: value } } }), /explorationNudge must be a positive integer/);
  }
});

test("the old explorationBudget key sets explorationNudge when the new key is absent, and the new key wins when both are set", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationBudget: 5 } } }).settings.explorationNudge, 5);
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { explorationBudget: 5, explorationNudge: 2 } } }).settings.explorationNudge, 2);
  const project = { orchestrator: { subagents: { explorationBudget: 20 } } };
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { allowProjectOverrides: true } } }, project).settings.explorationNudge, 20);
  assert.deepEqual(subagentsSettingsFromSettings({}, project).ignoredProjectKeys, ["orchestrator.subagents.explorationBudget"]);
  for (const value of [0, 2.5, "3"]) {
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
    assert.throws(() => subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: value } } }), /gateLevel must be off, low, medium, high or max/);
  }
});

test("gateLevel takes off, and a project's level may be lower or higher than the personal one", () => {
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: "off" } } }).settings.gateLevel, "off");
  const personal = (gateLevel: string) => ({ orchestrator: { subagents: { allowProjectOverrides: true, gateLevel } } });
  const project = (gateLevel: string) => ({ orchestrator: { subagents: { gateLevel } } });
  assert.equal(subagentsSettingsFromSettings(personal("high"), project("off")).settings.gateLevel, "off", "lower, down to off");
  assert.equal(subagentsSettingsFromSettings(personal("medium"), project("low")).settings.gateLevel, "low", "lower");
  assert.equal(subagentsSettingsFromSettings(personal("off"), project("max")).settings.gateLevel, "max", "higher");
  assert.equal(subagentsSettingsFromSettings({ orchestrator: { subagents: { gateLevel: "high" } } }, project("off")).settings.gateLevel, "high",
    "without allowProjectOverrides the personal level stays");
});
