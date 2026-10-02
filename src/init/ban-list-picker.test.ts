import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { runInit, type InitContext } from "./command.ts";
import {
  BACK,
  BAN_LIST_HINT,
  DONE,
  EDIT_LIST,
  installedFamilies,
  modelFamily,
  NO_MATCH_NOTE,
  pickSubagentBanList,
  REMOVE_ENTRY,
  SAVE_LIST,
  TYPE_OWN,
  type PickerUi,
} from "./ban-list-picker.ts";

/** A fake pi UI that answers select and input calls from a script, in
 *  order, and records every call. `undefined` in the script is Escape. */
function scriptedUi(script: (string | undefined)[]) {
  const calls: { kind: "select" | "input" | "notify"; title: string; options?: string[] }[] = [];
  const answers = [...script];
  const next = (kind: string, title: string) => {
    if (answers.length === 0) throw new Error(`script ran out at ${kind}: ${title}`);
    return answers.shift();
  };
  const ui: PickerUi & { confirm(title: string, message: string): Promise<boolean> } = {
    notify: (message) => { calls.push({ kind: "notify", title: message }); },
    select: async (title, options) => { calls.push({ kind: "select", title, options: [...options] }); return next("select", title); },
    input: async (title) => { calls.push({ kind: "input", title }); return next("input", title); },
    confirm: async () => false,
  };
  return { ui, calls, remaining: () => answers.length };
}

test("a model family is the id without provider, date and version suffixes", () => {
  assert.equal(modelFamily("claude-opus-4-5-20251101"), "claude-opus");
  assert.equal(modelFamily("anthropic/claude-sonnet-4-6"), "claude-sonnet");
  assert.equal(modelFamily("gpt-5.6-luna"), "gpt-5");
  assert.equal(modelFamily("gpt-5.3-codex-spark"), "gpt-5");
  assert.equal(modelFamily("gpt-6-astra"), "gpt-6");
  assert.equal(modelFamily("gemini-2.5-pro"), "gemini-2");
  assert.equal(modelFamily("mistral-large"), "mistral-large");
  assert.deepEqual(installedFamilies(INSTALLED_MODEL_INFO), ["claude-fable", "claude-haiku", "claude-opus", "claude-sonnet", "gpt-5", "gpt-6"]);
  for (const model of INSTALLED_MODEL_INFO) assert.ok(model.fullId.toLowerCase().includes(modelFamily(model.id)), model.fullId);
});

test("the picker shows the hint, offers families not yet chosen and shows the selection in the title", async () => {
  const { ui, calls } = scriptedUi(["claude-opus", "gpt-6", DONE, SAVE_LIST]);
  const picked = await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, []);
  assert.deepEqual(picked, ["claude-opus", "gpt-6"]);
  assert.equal(calls[0]!.kind, "notify");
  assert.equal(calls[0]!.title, BAN_LIST_HINT);
  assert.match(BAN_LIST_HINT, /contains it/);
  assert.match(BAN_LIST_HINT, /case-insensitive/);
  assert.match(BAN_LIST_HINT, /`opus` excludes every Opus model/);
  const selects = calls.filter((call) => call.kind === "select");
  assert.match(selects[0]!.title, /\(none\)/);
  assert.deepEqual(selects[0]!.options, ["claude-fable", "claude-haiku", "claude-opus", "claude-sonnet", "gpt-5", "gpt-6", TYPE_OWN, DONE]);
  assert.match(selects[1]!.title, /claude-opus/);
  assert.equal(selects[1]!.options!.includes("claude-opus"), false);
  assert.ok(selects[1]!.options!.includes(REMOVE_ENTRY));
  assert.match(selects[2]!.title, /claude-opus, gpt-6/);
});

test("own entries are typed comma-separated and duplicates are dropped", async () => {
  const { ui, calls } = scriptedUi([TYPE_OWN, "Fable, astra, , OPUS", "claude-opus", DONE, SAVE_LIST]);
  const picked = await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, ["opus"]);
  assert.deepEqual(picked, ["opus", "Fable", "astra", "claude-opus"]);
  assert.ok(calls.some((call) => call.kind === "input"));
});

test("the preview lists the installed models each entry matches and marks an entry that matches none", async () => {
  const { ui, calls } = scriptedUi([TYPE_OWN, "OPUS-5, nebula", DONE, SAVE_LIST]);
  const picked = await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, []);
  assert.deepEqual(picked, ["OPUS-5", "nebula"]);
  const preview = calls.filter((call) => call.kind === "notify").map((call) => call.title).join("\n");
  assert.match(preview, /OPUS-5: anthropic\/claude-opus-5, anthropic\/claude-opus-5-5/);
  assert.doesNotMatch(preview, /OPUS-5:[^\n]*claude-opus-4/);
  assert.match(preview, new RegExp(`nebula: ${NO_MATCH_NOTE}`));
  const confirm = calls.filter((call) => call.kind === "select").at(-1)!;
  assert.deepEqual(confirm.options, [SAVE_LIST, EDIT_LIST]);
});

test("going back from the preview edits the same selection", async () => {
  const { ui } = scriptedUi(["claude-opus", DONE, EDIT_LIST, REMOVE_ENTRY, "claude-opus", "gpt-5", DONE, SAVE_LIST]);
  assert.deepEqual(await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, []), ["gpt-5"]);
});

test("Escape at any select cancels the picker", async () => {
  for (const script of [[undefined], ["claude-opus", undefined], ["claude-opus", DONE, undefined], ["claude-opus", REMOVE_ENTRY, undefined]]) {
    const { ui, remaining } = scriptedUi(script);
    assert.equal(await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, ["fable"]), undefined, JSON.stringify(script));
    assert.equal(remaining(), 0);
  }
});

test("re-running starts from the current list, offers removal, and offers no family already listed", async () => {
  const { ui, calls } = scriptedUi([REMOVE_ENTRY, "fable", DONE, SAVE_LIST]);
  assert.deepEqual(await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, ["fable", "GPT-6"]), ["GPT-6"]);
  const selects = calls.filter((call) => call.kind === "select");
  assert.match(selects[0]!.title, /fable, GPT-6/);
  assert.equal(selects[0]!.options!.includes("gpt-6"), false);
  assert.deepEqual(selects[1]!.options!.slice(0, 2), ["fable", "GPT-6"]);
});

test("an entry named like the back option can be removed", async () => {
  const { ui, calls } = scriptedUi([REMOVE_ENTRY, "Back", DONE, SAVE_LIST]);
  assert.deepEqual(await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, ["Back", "fable"]), ["fable"]);
  const removal = calls.filter((call) => call.kind === "select")[1]!;
  assert.deepEqual(removal.options, ["Back", "fable", BACK]);
  assert.notEqual(BACK, "Back");
});

/** Personal settings whose elevated tier holds only Opus rungs. */
const OPUS_ELEVATED = {
  orchestrator: {
    subagentBanList: [],
    sessionBanList: [],
    routing: {
      tiers: {
        mechanical: ["anthropic/claude-haiku-4-5:low"],
        standard: ["anthropic/claude-sonnet-4-6:medium"],
        elevated: ["anthropic/claude-opus-4-6:high", "anthropic/claude-opus-5:high"],
        critical: ["anthropic/claude-opus-5:high", "anthropic/claude-sonnet-4-6:high"],
      },
    },
  },
};

test("the preview names a tier of the existing map the list would empty and offers only going back", async () => {
  const { ui, calls } = scriptedUi([TYPE_OWN, "opus", DONE, EDIT_LIST, REMOVE_ENTRY, "opus", TYPE_OWN, "opus-5", DONE, SAVE_LIST]);
  const existing = { settings: OPUS_ELEVATED, path: "/home/owner/.pi/agent/settings.json" };
  assert.deepEqual(await pickSubagentBanList(ui, INSTALLED_MODEL_INFO, [], existing), ["opus-5"]);
  const notes = calls.filter((call) => call.kind === "notify").map((call) => call.title);
  assert.ok(notes.includes("tier elevated would have no models left (all its rungs match opus)"), notes.join("\n"));
  assert.equal(notes.some((note) => /tier critical/.test(note)), false);
  const selects = calls.filter((call) => call.kind === "select");
  const blocked = selects[2]!;
  assert.deepEqual(blocked.options, [EDIT_LIST]);
  assert.match(blocked.title, /edit the tier map in \/home\/owner\/\.pi\/agent\/settings\.json first, or ban less/i);
  // `opus-5` removes only some rungs of the elevated tier, so it saves.
  assert.deepEqual(selects.at(-1)!.options, [SAVE_LIST, EDIT_LIST]);
  assert.equal(notes.filter((note) => /would have no models left/.test(note)).length, 1);
});

// ---------------------------------------------------------------------------
// Through `/pi-orchestrator init`
// ---------------------------------------------------------------------------

function initDirs(personal?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-ban-picker-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  const settingsPath = join(agentDir, "settings.json");
  if (personal !== undefined) writeFileSync(settingsPath, JSON.stringify(personal));
  return { agentDir, stateDir: join(agentDir, "pi-orchestrator"), settingsPath, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function initCtx(ui: ReturnType<typeof scriptedUi>["ui"]): InitContext {
  return { hasUI: true, modelRegistry: { getAvailable: () => [...INSTALLED_MODEL_INFO] }, ui };
}

test("init replaces an existing ban list with the picked one and leaves an existing tier map alone", async () => {
  const rung = ["anthropic/claude-haiku-4-5:low"];
  const tiers = { mechanical: rung, standard: rung, elevated: rung, critical: rung };
  const dirs = initDirs({ orchestrator: { subagentBanList: ["fable"], sessionBanList: [], routing: { tiers } } });
  try {
    const { ui, calls } = scriptedUi([REMOVE_ENTRY, "fable", "gpt-6", DONE, SAVE_LIST]);
    await runInit("init", initCtx(ui), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    const settings = JSON.parse(readFileSync(dirs.settingsPath, "utf8"));
    assert.deepEqual(settings.orchestrator.subagentBanList, ["gpt-6"]);
    assert.deepEqual(settings.orchestrator.routing.tiers, tiers);
    assert.match(calls.filter((call) => call.kind === "select")[0]!.title, /fable/);
  } finally { dirs.cleanup(); }
});

test("init does not save a list that empties a tier of the existing map; Escape writes nothing", async () => {
  const dirs = initDirs(OPUS_ELEVATED);
  try {
    const before = readFileSync(dirs.settingsPath, "utf8");
    const { ui, calls, remaining } = scriptedUi(["claude-opus", DONE, undefined]);
    const lines = await runInit("init", initCtx(ui), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    assert.equal(remaining(), 0);
    assert.equal(readFileSync(dirs.settingsPath, "utf8"), before);
    assert.match(lines.join("\n"), /ban list unchanged and nothing was written/);
    assert.doesNotMatch(lines.join("\n"), /starter tier map/);
    const blocked = calls.filter((call) => call.kind === "select").at(-1)!;
    assert.deepEqual(blocked.options, [EDIT_LIST]);
    assert.match(blocked.title, new RegExp(`edit the tier map in ${dirs.settingsPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} first`, "i"));
    assert.ok(calls.some((call) => call.kind === "notify" && call.title === "tier elevated would have no models left (all its rungs match claude-opus)"));
  } finally { dirs.cleanup(); }
});

test("init saves a list that removes only some rungs of a tier of the existing map", async () => {
  const dirs = initDirs(OPUS_ELEVATED);
  try {
    const { ui } = scriptedUi([TYPE_OWN, "opus-5", DONE, SAVE_LIST]);
    await runInit("init", initCtx(ui), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    const settings = JSON.parse(readFileSync(dirs.settingsPath, "utf8"));
    assert.deepEqual(settings.orchestrator.subagentBanList, ["opus-5"]);
    assert.deepEqual(settings.orchestrator.routing, OPUS_ELEVATED.orchestrator.routing);
  } finally { dirs.cleanup(); }
});

test("an existing tier map that does not load is named as the existing map, and nothing is written", async () => {
  const dirs = initDirs({ orchestrator: { subagentBanList: [], sessionBanList: [], routing: { tiers: { mechanical: ["anthropic/claude-haiku-4-5:low"] } } } });
  try {
    const before = readFileSync(dirs.settingsPath, "utf8");
    const { ui } = scriptedUi(["gpt-6", DONE, SAVE_LIST]);
    const lines = (await runInit("init", initCtx(ui), { stateDir: dirs.stateDir, agentDir: dirs.agentDir })).join("\n");
    assert.equal(readFileSync(dirs.settingsPath, "utf8"), before);
    assert.match(lines, new RegExp(`the existing tier map in ${dirs.settingsPath.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")} does not load \\(.*standard.*is missing`));
    assert.match(lines, /nothing was written/);
    assert.doesNotMatch(lines, /starter tier map/);
  } finally { dirs.cleanup(); }
});

test("cancelling the ban list step in init keeps the previous list and writes nothing", async () => {
  const personal = { orchestrator: { subagentBanList: ["fable"], sessionBanList: [] } };
  const dirs = initDirs(personal);
  try {
    const before = readFileSync(dirs.settingsPath, "utf8");
    const { ui, calls } = scriptedUi(["claude-opus", undefined]);
    const lines = await runInit("init", initCtx(ui), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    assert.equal(readFileSync(dirs.settingsPath, "utf8"), before);
    assert.match(lines.join("\n"), /ban list unchanged/);
    assert.equal(calls.some((call) => call.kind === "input"), false);
  } finally { dirs.cleanup(); }
});
