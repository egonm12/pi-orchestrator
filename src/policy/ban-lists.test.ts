import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { allowanceConstraint, newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { withTaskSuitability } from "../fixtures/catalog-facts.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { route } from "../routing/routing-policy.ts";
import {
  banListsFromSettings,
  configureBanLists,
  DEFAULT_BAN_LISTS,
  loadBanLists,
  loadBanListsOrDefaults,
  personalAgentDir,
  resetBanLists,
  isSessionBannedModel,
  sessionBanListRefusal,
  type BanLists,
} from "./ban-lists.ts";
import {
  allowListAdmitsProhibitedModel,
  isProhibitedModel,
  resolveDispatchModel,
} from "./model-resolution.ts";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = join(here, "..");

// Tests that configure the module-level lists must not leak them into the
// next test in this process.
afterEach(() => resetBanLists());

const WITH_SONNET: BanLists = {
  subagentBanList: ["fable", "astra", "sonnet"],
  sessionBanList: [],
};

interface TempSettings {
  agentDir: string;
  projectCwd: string;
  cleanup(): void;
}

/** A redirected agent dir and project, both inside one mkdtemp dir. Never the
 *  real ~/.pi/agent. Removed by exact path. */
function tempSettings(personal?: unknown, project?: unknown): TempSettings {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-ban-lists-"));
  const agentDir = join(root, "agent");
  const projectCwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  if (personal !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(personal));
  if (project !== undefined) writeFileSync(join(projectCwd, ".pi", "settings.json"), JSON.stringify(project));
  return { agentDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `loadBanListsOrDefaults` over a personal settings value, via a temp agent dir. */
function loadBanListsOrDefaultsFrom(personal: unknown) {
  const dirs = tempSettings(personal);
  try {
    return loadBanListsOrDefaults({ agentDir: dirs.agentDir });
  } finally {
    dirs.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Defaults (stories 2, 6)
// ---------------------------------------------------------------------------

test("with no harness key the subagent ban list defaults to fable and astra and the session ban list is empty", () => {
  for (const personal of [{}, { defaultModel: "anthropic/claude-haiku-4-5" }, { harness: {} }]) {
    const loaded = banListsFromSettings(personal);
    assert.deepEqual(loaded.banLists.subagentBanList, ["fable", "astra"]);
    assert.deepEqual(loaded.banLists.sessionBanList, []);
    assert.deepEqual(loaded.ignoredProjectKeys, []);
  }
  assert.deepEqual(DEFAULT_BAN_LISTS, { subagentBanList: ["fable", "astra"], sessionBanList: [] });
});

test("with no personal settings file the loader returns the defaults and resolveDispatchModel refuses the real Fable and Astra ids", () => {
  const dirs = tempSettings();
  try {
    configureBanLists(loadBanLists({ agentDir: dirs.agentDir, projectCwd: dirs.projectCwd }).banLists);
    for (const model of ["anthropic/claude-fable-5", "anthropic/claude-fable-5-1", "openai-codex/gpt-6-astra"]) {
      const decision = resolveDispatchModel({ model, source: "explicit" });
      assert.ok(!decision.ok, `${model} should be refused`);
      assert.equal(decision.code, "out_of_scope");
      assert.match(decision.message, /prohibited by name/);
      assert.match(decision.message, /subagent ban list/);
    }
  } finally {
    dirs.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A new name binds with no code change (story 1)
// ---------------------------------------------------------------------------

test("adding sonnet to the subagent ban list refuses anthropic/claude-sonnet-5 at dispatch resolution, and removing it admits it again", () => {
  const dirs = tempSettings({ harness: { subagentBanList: ["fable", "astra", "sonnet"] } });
  try {
    configureBanLists(loadBanLists({ agentDir: dirs.agentDir }).banLists);
    const refused = resolveDispatchModel({ model: "anthropic/claude-sonnet-5", source: "explicit" });
    assert.ok(!refused.ok);
    assert.equal(refused.code, "out_of_scope");
    assert.match(refused.message, /subagent ban list/);
    assert.match(refused.message, /'sonnet'/);
    assert.equal(isProhibitedModel("anthropic/claude-sonnet-5"), true);

    writeFileSync(join(dirs.agentDir, "settings.json"), JSON.stringify({ harness: { subagentBanList: ["fable", "astra"] } }));
    configureBanLists(loadBanLists({ agentDir: dirs.agentDir }).banLists);
    assert.ok(resolveDispatchModel({ model: "anthropic/claude-sonnet-5", source: "explicit" }).ok);
    assert.equal(isProhibitedModel("anthropic/claude-sonnet-5"), false);
  } finally {
    dirs.cleanup();
  }
});

test("a configured name is refused by routing and budget admission too, with no change in those layers", () => {
  configureBanLists(WITH_SONNET);
  const sonnet = "anthropic/claude-sonnet-5";
  const now = new Date("2026-09-21T12:00:00.000Z");
  const catalog = withTaskSuitability(
    buildCatalog({ modelIds: [sonnet], now }),
    { [sonnet]: { implementation: 1 } },
    { asOf: now.toISOString() },
  );
  const routed = route({
    request: { taskDescription: "reformat this file's imports alphabetically", taskType: "implementation" },
    catalog,
    now: now.getTime(),
  });
  assert.equal(routed.ok, false);
  assert.match(
    routed.allowed.rejected.find((candidate) => candidate.model === sonnet)?.rejectedBecause.join(" ") ?? "",
    /subagent ban list entry 'sonnet'/,
  );

  const owner = new TaskAllowanceOwner(newTaskLedger({ taskId: "ban-list-sonnet" }));
  const constraint = allowanceConstraint(owner, buildCatalog({ modelIds: [sonnet] }), { role: "subtask", maxInputTokens: 1000 });
  assert.equal(constraint.check(sonnet).ok, false);
  assert.equal(constraint.admitDispatch(sonnet).ok, false);
  assert.equal(owner.snapshot().open.length, 0);

  resetBanLists();
  assert.equal(constraint.check(sonnet).ok, true);
});

test("matching is case-insensitive substring on the model id with the thinking suffix stripped", () => {
  configureBanLists(WITH_SONNET);
  const decision = resolveDispatchModel({ model: "ANTHROPIC/CLAUDE-SONNET-5:high", source: "explicit" });
  assert.ok(!decision.ok);
  assert.equal(decision.code, "out_of_scope");
  assert.match(decision.message, /'sonnet'/);
  // An upper-case entry matches a lower-case id too.
  assert.equal(isProhibitedModel("anthropic/claude-sonnet-5", { subagentBanList: ["SONNET"], sessionBanList: [] }), true);
  // The suffix is not part of the id: an entry naming only the effort bans nothing.
  assert.equal(isProhibitedModel("anthropic/claude-haiku-4-5:high", { subagentBanList: ["high"], sessionBanList: [] }), false);
});

test("the allow-list audit reads the same configured subagent ban list", () => {
  assert.deepEqual(allowListAdmitsProhibitedModel(["anthropic/claude-sonnet-*"], INSTALLED_MODEL_IDS), []);
  configureBanLists(WITH_SONNET);
  const admitted = allowListAdmitsProhibitedModel(["anthropic/claude-sonnet-*"], INSTALLED_MODEL_IDS);
  assert.ok(admitted.length > 0);
  assert.ok(admitted.every((id) => id.includes("sonnet")));
});

// ---------------------------------------------------------------------------
// Session ban list (story 3)
// ---------------------------------------------------------------------------

test("a model on the subagent ban list is not session-banned under the defaults", () => {
  const defaults = banListsFromSettings({}).banLists;
  assert.equal(isSessionBannedModel("anthropic/claude-fable-5-1", defaults), false);
  assert.equal(sessionBanListRefusal("anthropic/claude-fable-5-1", defaults), undefined);
  assert.equal(isProhibitedModel("anthropic/claude-fable-5-1", defaults), true);
});

test("sessionBanList opus refuses anthropic/claude-opus-5-5 as the session model with a message naming the session ban list", () => {
  const banLists = banListsFromSettings({ harness: { sessionBanList: ["opus"] } }).banLists;
  assert.equal(isSessionBannedModel("anthropic/claude-opus-5-5", banLists), true);
  assert.equal(isSessionBannedModel("ANTHROPIC/CLAUDE-OPUS-5-5:high", banLists), true);
  const refusal = sessionBanListRefusal("anthropic/claude-opus-5-5", banLists);
  assert.ok(refusal);
  assert.equal(refusal.entry, "opus");
  assert.match(refusal.message, /session ban list/);
  assert.match(refusal.message, /'opus'/);
  // The session list binds only the session: a subagent on Opus is still dispatchable.
  assert.equal(isProhibitedModel("anthropic/claude-opus-5-5", banLists), false);
  configureBanLists(banLists);
  assert.ok(resolveDispatchModel({ model: "anthropic/claude-opus-5-5", source: "explicit" }).ok);
  assert.equal(isSessionBannedModel("anthropic/claude-opus-5-5"), true);
});

test("the default empty session ban list refuses no installed model", () => {
  for (const id of INSTALLED_MODEL_IDS) {
    assert.equal(isSessionBannedModel(id, DEFAULT_BAN_LISTS), false, id);
    assert.equal(isSessionBannedModel(id), false, id);
  }
});

// ---------------------------------------------------------------------------
// Prose is not a model field (story 4)
// ---------------------------------------------------------------------------

test("a banned name in task text, a commit message, a path or shell text does not refuse a dispatch on an allowed model", () => {
  configureBanLists(WITH_SONNET);
  const allowed = "anthropic/claude-opus-5-5";
  const catalog = withTaskSuitability(
    buildCatalog({ modelIds: [allowed], now: new Date("2026-09-21T12:00:00.000Z") }),
    { [allowed]: { implementation: 1 } },
    { asOf: "2026-09-21T12:00:00.000Z" },
  );
  const taskDescription =
    'rename the heading in notes/astra.md, then run `echo astra` and git commit -m "drop the fable idea"; ' +
    "the doc compares Fable, Astra and Sonnet";
  const result = route({
    request: { taskDescription, taskType: "implementation" },
    catalog,
    now: new Date("2026-09-21T12:00:00.000Z").getTime(),
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok);
  assert.equal(result.model, allowed);
  const dispatch = resolveDispatchModel({ model: result.model, source: "explicit" });
  assert.ok(dispatch.ok);
  assert.equal(dispatch.baseModel, allowed);
});

// ---------------------------------------------------------------------------
// A project cannot change either list (story 5)
// ---------------------------------------------------------------------------

test("a project settings file carrying either ban list changes nothing and the loader names each ignored key", () => {
  const dirs = tempSettings(
    { harness: { sessionBanList: ["opus"] } },
    { harness: { subagentBanList: [], sessionBanList: ["haiku"], routing: { tiers: {} } } },
  );
  try {
    const loaded = loadBanLists({ agentDir: dirs.agentDir, projectCwd: dirs.projectCwd });
    assert.deepEqual(loaded.banLists, { subagentBanList: ["fable", "astra"], sessionBanList: ["opus"] });
    assert.deepEqual(loaded.ignoredProjectKeys, ["harness.subagentBanList", "harness.sessionBanList"]);
    configureBanLists(loaded.banLists);
    assert.ok(!resolveDispatchModel({ model: "anthropic/claude-fable-5", source: "explicit" }).ok);
  } finally {
    dirs.cleanup();
  }
});

test("a project ban-list key is ignored and named even when its value is malformed", () => {
  const loaded = banListsFromSettings({}, { harness: { subagentBanList: "nonsense" } });
  assert.deepEqual(loaded.banLists, DEFAULT_BAN_LISTS);
  assert.deepEqual(loaded.ignoredProjectKeys, ["harness.subagentBanList"]);
});

test("a project file with no ban-list key reports nothing ignored", () => {
  for (const project of [{}, { harness: { routing: { tiers: {} } } }, { defaultModel: "x/y" }]) {
    assert.deepEqual(banListsFromSettings({}, project).ignoredProjectKeys, []);
  }
});

// ---------------------------------------------------------------------------
// Malformed personal lists fail closed
// ---------------------------------------------------------------------------

for (const key of ["subagentBanList", "sessionBanList"] as const) {
  for (const [label, value] of [
    ["not an array", "fable"],
    ["null", null],
    ["a non-string entry", ["fable", 3]],
    ["an empty-string entry", ["fable", ""]],
    ["a blank entry", ["fable", "   "]],
  ] as const) {
    test(`a personal harness.${key} with ${label} fails closed naming the key`, () => {
      assert.throws(
        () => banListsFromSettings({ harness: { [key]: value } }),
        new RegExp(`harness\\.${key}`),
      );
      assert.throws(
        () => configureBanLists({ ...DEFAULT_BAN_LISTS, [key]: value } as unknown as BanLists),
        new RegExp(`harness\\.${key}`),
      );
    });
  }
}

test("a personal harness key that is not an object fails closed naming the key", () => {
  for (const harness of ["x", ["fable"], null]) {
    assert.throws(() => banListsFromSettings({ harness }), /'harness'/);
  }
});

test("an unreadable personal settings file fails closed naming the file", () => {
  const dirs = tempSettings();
  try {
    const path = join(dirs.agentDir, "settings.json");
    writeFileSync(path, "{ not json");
    assert.throws(() => loadBanLists({ agentDir: dirs.agentDir }), (error: Error) => error.message.includes(path));
  } finally {
    dirs.cleanup();
  }
});

test("the guard loader keeps the defaults when personal settings are malformed and reports one error naming the key", () => {
  const dirs = tempSettings({ harness: { subagentBanList: ["fable", ""] } });
  try {
    const loaded = loadBanListsOrDefaults({ agentDir: dirs.agentDir, projectCwd: dirs.projectCwd });
    assert.deepEqual(loaded.banLists, DEFAULT_BAN_LISTS);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0]!, /harness\.subagentBanList/);
  } finally {
    dirs.cleanup();
  }
});

test("the guard loader keeps a valid subagent list when the session list is malformed", () => {
  const dirs = tempSettings({ harness: { subagentBanList: ["fable", "astra", "sonnet"], sessionBanList: "opus" } });
  try {
    const loaded = loadBanListsOrDefaults({ agentDir: dirs.agentDir });
    assert.deepEqual(loaded.banLists.subagentBanList, ["fable", "astra", "sonnet"]);
    assert.equal(isProhibitedModel("anthropic/claude-sonnet-5", loaded.banLists), true);
    assert.equal(loaded.errors.length, 1);
    assert.match(loaded.errors[0]!, /harness\.sessionBanList/);
  } finally {
    dirs.cleanup();
  }
});

test("the guard loader keeps a valid session list when the subagent list is malformed", () => {
  const loaded = loadBanListsOrDefaultsFrom({ harness: { subagentBanList: "sonnet", sessionBanList: ["opus"] } });
  assert.deepEqual(loaded.banLists, { subagentBanList: ["fable", "astra"], sessionBanList: ["opus"] });
  assert.equal(loaded.errors.length, 1);
  assert.match(loaded.errors[0]!, /harness\.subagentBanList/);
});

test("a malformed personal list keeps the defaults plus its valid entries, so it can only narrow", () => {
  const loaded = loadBanListsOrDefaultsFrom({ harness: { subagentBanList: ["sonnet", "", 3, " opus "], sessionBanList: ["haiku", null] } });
  assert.deepEqual(loaded.banLists.subagentBanList, ["fable", "astra", "sonnet", "opus"]);
  assert.deepEqual(loaded.banLists.sessionBanList, ["haiku"]);
  assert.equal(loaded.errors.length, 2);
});

test("the guard loader keeps the personal lists when the project file is unreadable and reports one error naming the file", () => {
  const dirs = tempSettings({ harness: { sessionBanList: ["opus"] } });
  try {
    const projectFile = join(dirs.projectCwd, ".pi", "settings.json");
    writeFileSync(projectFile, "{ not json");
    const loaded = loadBanListsOrDefaults({ agentDir: dirs.agentDir, projectCwd: dirs.projectCwd });
    assert.deepEqual(loaded.banLists, { subagentBanList: ["fable", "astra"], sessionBanList: ["opus"] });
    assert.deepEqual(loaded.ignoredProjectKeys, []);
    assert.equal(loaded.errors.length, 1);
    assert.ok(loaded.errors[0]!.includes(projectFile));
  } finally {
    dirs.cleanup();
  }
});

test("the guard loader matches the strict loader when both files are usable", () => {
  const dirs = tempSettings({ harness: { sessionBanList: ["opus"] } }, { harness: { subagentBanList: [] } });
  try {
    const sources = { agentDir: dirs.agentDir, projectCwd: dirs.projectCwd };
    const strict = loadBanLists(sources);
    const guard = loadBanListsOrDefaults(sources);
    assert.deepEqual(guard.banLists, strict.banLists);
    assert.deepEqual(guard.ignoredProjectKeys, strict.ignoredProjectKeys);
    assert.deepEqual(guard.errors, []);
  } finally {
    dirs.cleanup();
  }
});

test("an entry is trimmed before matching so stray whitespace cannot silently match nothing", () => {
  const banLists = banListsFromSettings({ harness: { subagentBanList: [" sonnet "] } }).banLists;
  assert.deepEqual(banLists.subagentBanList, ["sonnet"]);
  assert.equal(isProhibitedModel("anthropic/claude-sonnet-5", banLists), true);
});

test("an explicit empty personal subagent ban list is honored", () => {
  const banLists = banListsFromSettings({ harness: { subagentBanList: [] } }).banLists;
  assert.equal(isProhibitedModel("anthropic/claude-fable-5", banLists), false);
});

test("the personal agent dir follows PI_CODING_AGENT_DIR and defaults to ~/.pi/agent", () => {
  assert.equal(personalAgentDir({ PI_CODING_AGENT_DIR: "/tmp/somewhere" }, "/home/u"), "/tmp/somewhere");
  assert.equal(personalAgentDir({ PI_CODING_AGENT_DIR: "~/alt" }, "/home/u"), "/home/u/alt");
  assert.equal(personalAgentDir({}, "/home/u"), "/home/u/.pi/agent");
});

// ---------------------------------------------------------------------------
// One definition of the banned-name rule (story 6)
// ---------------------------------------------------------------------------

function harnessSources(): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  for (const entry of readdirSync(harnessRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
    const path = join(entry.parentPath, entry.name);
    const rel = relative(harnessRoot, path);
    if (rel.startsWith("state") || rel.includes("node_modules")) continue;
    out.push({ path: rel, text: readFileSync(path, "utf8") });
  }
  return out;
}

// Marker: a quoted literal that is exactly a banned name or its glob form
// ('fable', "astra", `*fable*`), case-insensitive. A second copy of the rule
// needs one of those literals to name what it bans; model ids such as
// "anthropic/claude-fable-5" in fixtures are not matched.
const BANNED_NAME_LITERAL = /["'`]\*?(fable|astra)\*?["'`]/gi;

test("the banned-name rule and its default names are defined in exactly one harness source file", () => {
  const hits = harnessSources().flatMap(({ path, text }) =>
    [...text.matchAll(BANNED_NAME_LITERAL)].map((match) => `${path}: ${match[0]}`),
  );
  assert.deepEqual(hits, ['policy/ban-lists.ts: "fable"', 'policy/ban-lists.ts: "astra"']);
});
