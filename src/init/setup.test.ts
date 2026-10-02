import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { loadAuthorization } from "../recipients/authorization.ts";
import { tierMapFromSettings } from "../routing/tier-map.ts";
import { DONE, TYPE_OWN } from "./ban-list-picker.ts";
import { runInit, type InitContext } from "./command.ts";
import { currentTierRungs, eligibleRoutingModels, planSettings, recipientProviders, RECIPIENTS_FILE, setupNotice, setupStatus, starterTierMap } from "./setup.ts";

const NO_BANS = { subagentBanList: [], sessionBanList: [] };

function tempDirs() {
  const root = mkdtempSync(join(tmpdir(), "pi-orchestrator-init-"));
  const agentDir = join(root, "agent");
  const stateDir = join(agentDir, "pi-orchestrator");
  mkdirSync(agentDir, { recursive: true });
  return { root, agentDir, stateDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("a fresh install names both missing pieces and the init command", () => {
  const dirs = tempDirs();
  try {
    const status = setupStatus({}, dirs.stateDir);
    assert.deepEqual(status, { tiersMissing: true, recipientsMissing: true });
    const notice = setupNotice(status, dirs.stateDir)!;
    assert.equal(notice.split("\n").length, 1);
    assert.match(notice, /no tier map/);
    assert.match(notice, /no approved recipients/);
    assert.match(notice, /\/pi-orchestrator init/);
    mkdirSync(dirs.stateDir, { recursive: true });
    writeFileSync(join(dirs.stateDir, RECIPIENTS_FILE), "{}");
    const tiers = { orchestrator: { routing: { tiers: {} } } };
    assert.equal(setupNotice(setupStatus(tiers, dirs.stateDir), dirs.stateDir), undefined);
  } finally { dirs.cleanup(); }
});

test("the starter tier map loads through the router's own loader and skips banned models", () => {
  const starter = starterTierMap(INSTALLED_MODEL_INFO, { subagentBanList: ["opus"], sessionBanList: [] });
  assert.ok(starter);
  for (const rungs of Object.values(starter.tiers)) {
    assert.ok(rungs.length > 0);
    assert.ok(rungs.every((rung) => !rung.includes("opus")), rungs.join(", "));
  }
  assert.ok(starter.skipped.some((line) => line.includes("opus") && line.includes("ban list")));
  const settings = { orchestrator: { routing: { enabled: true, tiers: starter.tiers } } };
  const map = tierMapFromSettings(settings, undefined, { installedModels: INSTALLED_MODEL_INFO, banLists: { subagentBanList: ["opus"], sessionBanList: [] } });
  assert.ok(map);
  assert.deepEqual(map.drops, []);
});

test("the orchestrator auto model is ineligible for routing and starter picks", () => {
  const auto = { provider: "orchestrator", id: "auto", fullId: "orchestrator/auto", api: "pi-virtual", reasoning: true };
  const installed = [...INSTALLED_MODEL_INFO, auto];
  const eligible = eligibleRoutingModels(installed, NO_BANS);
  assert.equal(eligible.models.some((model) => model.fullId === auto.fullId), false);
  assert.ok(eligible.skipped.includes("orchestrator/auto: orchestrator auto model"));
  const starter = starterTierMap(installed, NO_BANS)!;
  assert.equal(starter.classifier.startsWith("orchestrator/auto:"), false);
  assert.equal(Object.values(starter.tiers).flat().some((rung) => rung.startsWith("orchestrator/auto:")), false);
});

test("eligible routing models include unpriced models but starter selection excludes them", () => {
  const unpriced = { provider: "anthropic", id: "claude-sonnet-5-5", fullId: "anthropic/claude-sonnet-5-5", reasoning: true };
  const priced = INSTALLED_MODEL_INFO.find((model) => model.fullId === "anthropic/claude-haiku-4-5")!;
  const installed = [priced, unpriced];
  const eligible = eligibleRoutingModels(installed, NO_BANS);
  assert.ok(eligible.models.some((model) => model.fullId === unpriced.fullId));
  const starter = starterTierMap(installed, NO_BANS)!;
  assert.equal(Object.values(starter.tiers).flat().some((rung) => rung.startsWith(`${unpriced.fullId}:`)), false);
  assert.ok(starter.skipped.includes(`${unpriced.fullId}: no published price`));
});

test("planSettings adds what is missing, starts in shadow mode, never replaces an existing map and replaces a changed ban list", () => {
  const starter = starterTierMap(INSTALLED_MODEL_INFO, NO_BANS)!;
  const fresh = planSettings({ theme: "dark" }, starter, ["fable"]);
  const orchestrator = fresh.settings.orchestrator as Record<string, any>;
  assert.equal(fresh.settings.theme, "dark");
  assert.equal(orchestrator.routing.mode, "shadow");
  assert.equal(orchestrator.routing.enabled, true);
  assert.deepEqual(orchestrator.subagentBanList, ["fable"]);
  assert.deepEqual(orchestrator.sessionBanList, []);
  const kept = { orchestrator: { subagentBanList: ["astra"], sessionBanList: [], routing: { tiers: { mechanical: ["x/y:low"] } } } };
  const again = planSettings(kept, starter, ["astra"]);
  assert.deepEqual(again.changes, []);
  assert.equal(again.settings, kept);
  const replaced = planSettings(kept, starter, ["fable"]);
  assert.deepEqual(replaced.changes, ["orchestrator.subagentBanList = [fable]"]);
  assert.deepEqual((replaced.settings.orchestrator as Record<string, any>).subagentBanList, ["fable"]);
  assert.deepEqual((replaced.settings.orchestrator as Record<string, any>).routing, kept.orchestrator.routing);
});

test("rebuilding tiers preserves existing per-tier order fields and reads existing rungs", () => {
  const starter = starterTierMap(INSTALLED_MODEL_INFO, NO_BANS)!;
  const personal = {
    orchestrator: {
      routing: {
        mode: "live",
        tiers: {
          mechanical: { order: "ordered", rungs: ["anthropic/claude-haiku-4-5:low"] },
          standard: ["anthropic/claude-sonnet-4-5:medium"],
          elevated: { order: "balanced", rungs: ["anthropic/claude-opus-5:high"] },
          critical: ["anthropic/claude-opus-5:xhigh"],
        },
      },
    },
  };
  assert.deepEqual(currentTierRungs(personal)?.mechanical, ["anthropic/claude-haiku-4-5:low"]);
  const rebuilt = planSettings(personal, starter, [], { rebuildTiers: true });
  const tiers = (rebuilt.settings.orchestrator as any).routing.tiers;
  assert.equal(tiers.mechanical.order, "ordered");
  assert.deepEqual(tiers.mechanical.rungs, starter.tiers.mechanical);
  assert.equal(tiers.elevated.order, "balanced");
  assert.deepEqual(tiers.elevated.rungs, starter.tiers.elevated);
  assert.deepEqual(tiers.standard, starter.tiers.standard);
  assert.equal((rebuilt.settings.orchestrator as any).routing.mode, "live");
});

/** The ban list step is answered by typing `banList` (when not empty),
 *  then Done. */
function fakeCtx(answers: { banList: string; approve: Record<string, boolean> }, notes: string[]): InitContext {
  const selects = [...(answers.banList ? [TYPE_OWN] : []), DONE];
  return {
    hasUI: true,
    modelRegistry: { getAvailable: () => [...INSTALLED_MODEL_INFO] },
    ui: {
      notify: (message) => { notes.push(message); },
      input: async () => answers.banList,
      select: async () => selects.shift(),
      confirm: async (title) => answers.approve[/Approve (\S+) as/.exec(title)![1]!] ?? false,
    },
  };
}

test("init writes settings and approves only the providers the owner said yes to", async () => {
  const dirs = tempDirs();
  try {
    const notes: string[] = [];
    const starter = starterTierMap(INSTALLED_MODEL_INFO, NO_BANS)!;
    const providers = recipientProviders(starter);
    assert.ok(providers.length >= 1);
    const [first, ...rest] = providers;
    await runInit("init", fakeCtx({ banList: "fable, astra", approve: { [first!]: true } }, notes), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    const settings = JSON.parse(readFileSync(join(dirs.agentDir, "settings.json"), "utf8"));
    assert.deepEqual(settings.orchestrator.subagentBanList, ["fable", "astra"]);
    assert.ok(settings.orchestrator.routing.tiers);
    const store = loadAuthorization(join(dirs.stateDir, RECIPIENTS_FILE));
    assert.deepEqual(store.recipients.map((r) => r.provider), [first]);
    for (const provider of rest) assert.match(notes.at(-1)!, new RegExp(`not approved: .*${provider}`));
  } finally { dirs.cleanup(); }
});

test("init does not add or edit another extension's settings", async () => {
  const dirs = tempDirs();
  try {
    const settingsPath = join(dirs.agentDir, "settings.json");
    const subagents = { defaultModel: "anthropic/claude-haiku-4-5", asyncByDefault: true };
    writeFileSync(settingsPath, JSON.stringify({ subagents }));
    const notes: string[] = [];
    await runInit("init", fakeCtx({ banList: "", approve: {} }, notes), { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")).subagents, subagents);

    const fresh = tempDirs();
    try {
      await runInit("init", fakeCtx({ banList: "", approve: {} }, []), { stateDir: fresh.stateDir, agentDir: fresh.agentDir });
      assert.equal(Object.hasOwn(JSON.parse(readFileSync(join(fresh.agentDir, "settings.json"), "utf8")), "subagents"), false);
    } finally { fresh.cleanup(); }
  } finally { dirs.cleanup(); }
});

test("without a UI, init approves nothing and writes nothing", async () => {
  const dirs = tempDirs();
  try {
    const original = process.stderr.write;
    process.stderr.write = (() => true) as typeof process.stderr.write;
    try {
      await runInit("init", { hasUI: false }, { stateDir: dirs.stateDir, agentDir: dirs.agentDir });
    } finally { process.stderr.write = original; }
    assert.equal(existsSync(join(dirs.agentDir, "settings.json")), false);
    assert.equal(existsSync(join(dirs.stateDir, RECIPIENTS_FILE)), false);
  } finally { dirs.cleanup(); }
});
