import assert from "node:assert/strict";
import { test } from "node:test";
import { subagentsSettingsFromSettings } from "./settings.ts";

test("without personal settings the defaults apply and allowProjectOverrides is off", () => {
  assert.deepEqual(subagentsSettingsFromSettings({}), {
    settings: { maxParallel: 4, agentDefinitionModel: { use: "route" } },
    allowProjectOverrides: false,
    ignoredProjectKeys: [],
  });
});

test("with allowProjectOverrides a project key replaces the personal value and the flag stays personal", () => {
  const personal = { orchestrator: { subagents: { allowProjectOverrides: true, maxParallel: 3, agentDefinitionModel: { use: "preserve" } } } };
  const project = { orchestrator: { subagents: { maxParallel: 6, allowProjectOverrides: false } } };
  assert.deepEqual(subagentsSettingsFromSettings(personal, project), {
    settings: { maxParallel: 6, agentDefinitionModel: { use: "preserve" } },
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
