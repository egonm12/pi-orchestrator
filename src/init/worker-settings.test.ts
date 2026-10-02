import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { DONE, SAVE_LIST } from "./ban-list-picker.ts";
import { runInit, type InitContext } from "./command.ts";
import { starterTierMap } from "./setup.ts";
import {
  CURRENT_MARK,
  gateAndLimitIn,
  gateLevelOptions,
  IGNORED_MARK,
  isProjectDirectory,
  OTHER_LIMIT,
  OVERRIDES_TITLE,
  PERSONAL_TARGET,
  PROJECT_TARGET,
  workerLimitOptions,
} from "./worker-settings.ts";

type Answer = string | boolean | undefined;
interface Call { kind: "select" | "input" | "confirm" | "notify"; title: string; options?: string[] }

/** A fake pi UI answering select, input and confirm calls from a script, in
 *  order. `undefined` is Escape. Recipient approvals are answered no
 *  without using the script. */
function scriptedUi(script: Answer[]) {
  const calls: Call[] = [];
  const answers = [...script];
  const next = (kind: string, title: string) => {
    if (answers.length === 0) throw new Error(`script ran out at ${kind}: ${title}`);
    return answers.shift();
  };
  const ui: NonNullable<InitContext["ui"]> = {
    notify: (message) => { calls.push({ kind: "notify", title: message }); },
    select: async (title, options) => { calls.push({ kind: "select", title, options: [...options] }); return next("select", title) as string | undefined; },
    input: async (title) => { calls.push({ kind: "input", title }); return next("input", title) as string | undefined; },
    confirm: async (title) => {
      calls.push({ kind: "confirm", title });
      if (title.startsWith("Approve ")) return false;
      return next("confirm", title) === true;
    },
  };
  return { ui, calls, remaining: () => answers.length };
}

const BAN_STEP = [DONE, SAVE_LIST];
const GATE_TITLE = /^Gate level/;
const LIMIT_TITLE = /^Worker limit/;
const RUNG = ["anthropic/claude-haiku-4-5:low"];
const TIERS = { mechanical: RUNG, standard: RUNG, elevated: RUNG, critical: RUNG };

function dirs(options: { personal?: unknown; project?: unknown; marker?: ".git" | ".pi" | "none" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-worker-settings-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "repo");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const marker = options.marker ?? ".git";
  if (marker !== "none") mkdirSync(join(cwd, marker), { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  const projectPath = join(cwd, ".pi", "settings.json");
  if (options.personal !== undefined) writeFileSync(settingsPath, JSON.stringify(options.personal));
  if (options.project !== undefined) {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(projectPath, JSON.stringify(options.project));
  }
  return {
    agentDir, stateDir: join(agentDir, "pi-orchestrator"), cwd, settingsPath, projectPath,
    personal: () => JSON.parse(readFileSync(settingsPath, "utf8")),
    project: () => JSON.parse(readFileSync(projectPath, "utf8")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

async function init(d: ReturnType<typeof dirs>, script: Answer[], cwd?: string) {
  const scripted = scriptedUi(script);
  const ctx: InitContext = { hasUI: true, ...(cwd ? { cwd } : {}), modelRegistry: { getAvailable: () => [...INSTALLED_MODEL_INFO] }, ui: scripted.ui };
  const lines = await runInit("init", ctx, { stateDir: d.stateDir, agentDir: d.agentDir });
  assert.equal(scripted.remaining(), 0, "every scripted answer was used");
  return { ...scripted, lines: lines.join("\n"), selects: scripted.calls.filter((call) => call.kind === "select") };
}

const option = (options: readonly string[], level: string) => options.find((entry) => entry.startsWith(level))!;

test("the gate level select lists the current level first, marked, and describes every level", () => {
  const options = gateLevelOptions("high");
  assert.equal(options.length, 5);
  assert.match(options[0]!, /^high \(current\): /);
  assert.equal(options.filter((entry) => entry.includes(CURRENT_MARK)).length, 1);
  assert.deepEqual(options.map((entry) => entry.slice(0, entry.search(/[ :]/))), ["high", "off", "low", "medium", "max"]);
  assert.match(option(options, "off"), /no reviews or verdicts, saves tokens/);
  assert.deepEqual(workerLimitOptions(4), ["4 (current)", "1", "2", "6", "8", "12", "16", "32", OTHER_LIMIT]);
  assert.deepEqual(workerLimitOptions(5).slice(0, 2), ["5 (current)", "1"]);
});

test("a project folder needs a .git or .pi folder and is never the home folder", () => {
  const d = dirs({ marker: "none" });
  try {
    assert.equal(isProjectDirectory(d.cwd, d.settingsPath), false);
    mkdirSync(join(d.cwd, ".pi"));
    assert.equal(isProjectDirectory(d.cwd, d.settingsPath), true);
    assert.equal(isProjectDirectory(d.cwd, d.settingsPath, d.cwd), false);
    assert.equal(isProjectDirectory(undefined, d.settingsPath), false);
  } finally { d.cleanup(); }
});

test("outside a project, init asks no target and writes the picked values to personal settings", async () => {
  const d = dirs({ marker: "none" });
  try {
    const run = await init(d, [...BAN_STEP, "high: a reviewer for standard work and up", "8"], d.cwd);
    assert.equal(run.selects.some((call) => call.options!.includes(PROJECT_TARGET)), false);
    const gate = run.selects.find((call) => GATE_TITLE.test(call.title))!;
    assert.match(gate.options![0]!, /^medium \(current\)/);
    const limit = run.selects.find((call) => LIMIT_TITLE.test(call.title))!;
    assert.equal(limit.options![0], "4 (current)");
    assert.deepEqual(d.personal().orchestrator.subagents, { gateLevel: "high", workerLimit: 8 });
    assert.equal(existsSync(d.projectPath), false);
    assert.match(run.lines, /orchestrator\.subagents\.gateLevel = high; orchestrator\.subagents\.workerLimit = 8/);
  } finally { d.cleanup(); }
});

test("re-running init starts from the personal values; keeping them writes nothing for them", async () => {
  const personal = { orchestrator: { subagentBanList: [], sessionBanList: [], subagents: { gateLevel: "low", maxParallel: 6 } } };
  const d = dirs({ personal, marker: "none" });
  try {
    const run = await init(d, [...BAN_STEP, "low (current): x", "6 (current)"], d.cwd);
    assert.match(run.selects.find((call) => GATE_TITLE.test(call.title))!.options![0]!, /^low \(current\)/);
    assert.equal(run.selects.find((call) => LIMIT_TITLE.test(call.title))!.options![0], "6 (current)");
    assert.deepEqual(d.personal().orchestrator.subagents, personal.orchestrator.subagents);
    assert.doesNotMatch(run.lines, /orchestrator\.subagents\./);
  } finally { d.cleanup(); }
});

test("in a project, the target is asked once; the project starts from its own value, else the personal one", async () => {
  const personal = { orchestrator: { subagentBanList: [], sessionBanList: [], subagents: { workerLimit: 2 } } };
  const project = { theme: "dark", orchestrator: { other: true, subagents: { gateLevel: "max", explorationNudge: 5 } } };
  const d = dirs({ personal, project });
  try {
    const run = await init(d, [...BAN_STEP, PROJECT_TARGET, "off: no reviews", OTHER_LIMIT, "abc", "40", "12", true], d.cwd);
    const target = run.selects.filter((call) => call.options!.includes(PROJECT_TARGET));
    assert.equal(target.length, 1);
    assert.deepEqual(target[0]!.options, [PERSONAL_TARGET, PROJECT_TARGET]);
    // Overrides are off, so the project's own gate level is marked as ignored; the limit comes from personal settings.
    assert.equal(run.selects.find((call) => GATE_TITLE.test(call.title))!.options![0]!, `max${IGNORED_MARK}: a reviewer for every edit, who reruns its checks`);
    assert.equal(run.selects.find((call) => LIMIT_TITLE.test(call.title))!.options![0], "2 (current)");
    assert.equal(run.calls.filter((call) => call.kind === "input").length, 3);
    assert.deepEqual(d.project(), { theme: "dark", orchestrator: { other: true, subagents: { gateLevel: "off", explorationNudge: 5, workerLimit: 12 } } });
    assert.deepEqual(d.personal().orchestrator.subagents, { workerLimit: 2, allowProjectOverrides: true });
    assert.ok(run.calls.some((call) => call.kind === "confirm" && call.title === OVERRIDES_TITLE));
    assert.doesNotMatch(run.lines, /ignored until/);
  } finally { d.cleanup(); }
});

test("re-running init in a project that already sets values asks for overrides even when nothing new is written", async () => {
  const personal = { orchestrator: { subagentBanList: [], sessionBanList: [], subagents: { gateLevel: "low" } } };
  const project = { theme: "dark", orchestrator: { subagents: { gateLevel: "high", maxBackgroundWorkers: 6 } } };
  const yes = dirs({ personal, project });
  try {
    const before = readFileSync(yes.projectPath, "utf8");
    const gateOptions = gateLevelOptions("high", IGNORED_MARK);
    const limitOptions = workerLimitOptions(6, IGNORED_MARK);
    // Enter on both selects picks the first option.
    const run = await init(yes, [...BAN_STEP, PROJECT_TARGET, gateOptions[0], limitOptions[0], true], yes.cwd);
    assert.deepEqual(run.selects.find((call) => GATE_TITLE.test(call.title))!.options, gateOptions);
    assert.deepEqual(run.selects.find((call) => LIMIT_TITLE.test(call.title))!.options, limitOptions);
    assert.equal(limitOptions[0], `6${IGNORED_MARK}`);
    assert.ok(run.calls.some((call) => call.kind === "confirm" && call.title === OVERRIDES_TITLE));
    assert.equal(readFileSync(yes.projectPath, "utf8"), before, "the project file is left as it was");
    assert.deepEqual(yes.personal().orchestrator.subagents, { gateLevel: "low", allowProjectOverrides: true });
    assert.match(run.lines, /orchestrator\.subagents\.allowProjectOverrides = true/);
    assert.doesNotMatch(run.lines, /ignored until/);
  } finally { yes.cleanup(); }
  const no = dirs({ personal, project });
  try {
    const before = { personal: readFileSync(no.settingsPath, "utf8"), project: readFileSync(no.projectPath, "utf8") };
    const run = await init(no, [...BAN_STEP, PROJECT_TARGET, gateLevelOptions("high", IGNORED_MARK)[0], `6${IGNORED_MARK}`, false], no.cwd);
    assert.equal(readFileSync(no.projectPath, "utf8"), before.project);
    assert.equal(no.personal().orchestrator.subagents.allowProjectOverrides, undefined);
    assert.match(run.lines, /gate level and worker limit in .*settings\.json are ignored until orchestrator\.subagents\.allowProjectOverrides is true/);
  } finally { no.cleanup(); }
});

test("a project without its own values asks no overrides question when nothing is written", async () => {
  const project = { orchestrator: { subagents: { explorationNudge: 5 } } };
  const d = dirs({ project });
  try {
    const run = await init(d, [...BAN_STEP, PROJECT_TARGET, `medium${CURRENT_MARK}: x`, `4${CURRENT_MARK}`], d.cwd);
    assert.equal(run.calls.some((call) => call.title === OVERRIDES_TITLE), false);
    assert.deepEqual(d.project(), project);
  } finally { d.cleanup(); }
});

test("the worker limit a file sets is resolved by the subagents loader, aliases and ceiling included", () => {
  const file = (subagents: unknown) => ({ orchestrator: { subagents } });
  assert.deepEqual(gateAndLimitIn(file({ maxParallel: 3, maxBackgroundWorkers: 5 })), { workerLimit: 3 });
  assert.deepEqual(gateAndLimitIn(file({ maxBackgroundWorkers: 50, gateLevel: "off" })), { gateLevel: "off", workerLimit: 32 });
  assert.deepEqual(gateAndLimitIn(file({ workerLimit: 0, gateLevel: "nope" })), {});
  assert.deepEqual(gateAndLimitIn(file({ allowProjectOverrides: true })), {});
  assert.deepEqual(gateAndLimitIn(undefined), {});
});

test("declining project overrides still creates the project file and says it is ignored", async () => {
  const d = dirs({ marker: ".pi" });
  try {
    const run = await init(d, [...BAN_STEP, PROJECT_TARGET, "high: x", "16", false], d.cwd);
    assert.deepEqual(d.project(), { orchestrator: { subagents: { gateLevel: "high", workerLimit: 16 } } });
    assert.equal(d.personal().orchestrator.subagents, undefined);
    assert.match(run.lines, /ignored until orchestrator\.subagents\.allowProjectOverrides is true/);
  } finally { d.cleanup(); }
});

test("with project overrides already allowed, init does not ask for them", async () => {
  const personal = { orchestrator: { subagentBanList: [], sessionBanList: [], subagents: { allowProjectOverrides: true } } };
  const d = dirs({ personal, project: { orchestrator: { subagents: { gateLevel: "high" } } } });
  try {
    const run = await init(d, [...BAN_STEP, PROJECT_TARGET, "low: x", "1"], d.cwd);
    assert.match(run.selects.find((call) => GATE_TITLE.test(call.title))!.options![0]!, /^high \(current\): /, "an allowed project value is the current one");
    assert.equal(run.calls.some((call) => call.title === OVERRIDES_TITLE), false);
    assert.deepEqual(d.project().orchestrator.subagents, { gateLevel: "low", workerLimit: 1 });
  } finally { d.cleanup(); }
});

test("Escape at the target skips both values; Escape at one value still asks the next", async () => {
  const d = dirs();
  try {
    const run = await init(d, [...BAN_STEP, undefined], d.cwd);
    assert.equal(run.selects.some((call) => GATE_TITLE.test(call.title) || LIMIT_TITLE.test(call.title)), false);
    assert.equal(d.personal().orchestrator.subagents, undefined);
    assert.ok(d.personal().orchestrator.routing.tiers, "the starter map is still written");
    assert.equal(existsSync(d.projectPath), false);
    assert.match(run.lines, /gate level and worker limit skipped/);
  } finally { d.cleanup(); }
  const e = dirs({ marker: "none" });
  try {
    await init(e, [...BAN_STEP, undefined, "2"], e.cwd);
    assert.deepEqual(e.personal().orchestrator.subagents, { workerLimit: 2 });
  } finally { e.cleanup(); }
  const f = dirs({ marker: "none" });
  try {
    await init(f, [...BAN_STEP, "max: x", OTHER_LIMIT, undefined], f.cwd);
    assert.deepEqual(f.personal().orchestrator.subagents, { gateLevel: "max" });
  } finally { f.cleanup(); }
});

test("an existing tier map is rebuilt only after a yes, and the classifier stays", async () => {
  const classifier = { model: "anthropic/claude-haiku-4-5:low" };
  const personal = { orchestrator: { subagentBanList: [], sessionBanList: [], routing: { enabled: true, mode: "shadow", tiers: TIERS, classifier } } };
  const starter = starterTierMap(INSTALLED_MODEL_INFO, { subagentBanList: [], sessionBanList: [] })!;
  const yes = dirs({ personal, marker: "none" });
  try {
    const run = await init(yes, [...BAN_STEP, undefined, undefined, true], yes.cwd);
    assert.ok(run.calls.some((call) => call.kind === "confirm" && call.title === "Rebuild the tier map from installed models?"));
    const routing = yes.personal().orchestrator.routing;
    assert.deepEqual(routing.tiers, starter.tiers);
    assert.deepEqual(routing.classifier, classifier);
    assert.equal(routing.mode, "shadow");
    assert.match(run.lines, /rebuilt from installed models/);
  } finally { yes.cleanup(); }
  const no = dirs({ personal, marker: "none" });
  try {
    const before = readFileSync(no.settingsPath, "utf8");
    await init(no, [...BAN_STEP, undefined, undefined, false], no.cwd);
    assert.equal(readFileSync(no.settingsPath, "utf8"), before);
  } finally { no.cleanup(); }
});

test("without a tier map, init writes the starter map without asking to rebuild", async () => {
  const d = dirs({ marker: "none" });
  try {
    const run = await init(d, [...BAN_STEP, undefined, undefined], d.cwd);
    assert.equal(run.calls.some((call) => call.title.startsWith("Rebuild")), false);
    assert.ok(d.personal().orchestrator.routing.tiers);
  } finally { d.cleanup(); }
});
