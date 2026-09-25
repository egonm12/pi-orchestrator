import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ModelInfo } from "../subagents/model-info.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { HARNESS_ALLOW_PATTERNS, HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { loadTierMap, tierMapFromSettings, type ResolvedTierMap, type TierMapInputs } from "./tier-map.ts";
import { OWNER_BAN_LIST_SETTINGS, useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

// Seam (ticket 22): the loader's returned value. The pure core takes parsed
// settings objects; the file loader reads a temp agent dir and a temp project
// dir. Ticket 27's extension hook will pass the same value through unchanged.

/** The example tier map in harness/README.md "Tier map (ticket 22)". The
 *  spec has no literal example map, so this one is built from the spec's
 *  literals: Codex first and Claude second in a tier (story 8), the rung
 *  `anthropic/claude-sonnet-5:high` (the ticket's story 9 case) kept out of
 *  the personal elevated tier so an override is visible, and only models the
 *  harness allow list admits. */
const EXAMPLE_TIERS = {
  mechanical: ["openai-codex/gpt-6-luna:low", "anthropic/claude-haiku-4-5:low"],
  standard: ["openai-codex/gpt-6-sol:medium", "anthropic/claude-sonnet-5:medium"],
  elevated: ["openai-codex/gpt-6-sol:high", "anthropic/claude-opus-5:high"],
  critical: ["anthropic/claude-opus-5:xhigh", "openai-codex/gpt-6-sol:xhigh"],
};

const examplePersonal = (routing: Record<string, unknown> = {}) => ({
  orchestrator: { ...OWNER_BAN_LIST_SETTINGS, routing: { enabled: true, ...routing, tiers: EXAMPLE_TIERS } },
});

const projectTiers = (tiers: Record<string, unknown>) => ({ orchestrator: { routing: { tiers } } });

/** A real pi-ai 0.87.1 model on a third provider, not installed here. */
const GEMINI: ModelInfo = {
  provider: "google",
  id: "gemini-3.1-pro-preview",
  fullId: "google/gemini-3.1-pro-preview",
  reasoning: true,
  thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high", xhigh: null, max: null },
};

const INPUTS: TierMapInputs = { installedModels: INSTALLED_MODEL_INFO, modelScope: HARNESS_MODEL_SCOPE };
const WITH_GEMINI_INSTALLED: TierMapInputs = { ...INPUTS, installedModels: [...INSTALLED_MODEL_INFO, GEMINI] };

const personalRungs = (tier: readonly string[]) => tier.map((rung) => ({ rung, origin: "personal" }));
const projectRungs = (tier: readonly string[]) => tier.map((rung) => ({ rung, origin: "project" }));

/** Tier contents reduced to `{rung, origin}` for readable comparisons. */
function rungsByTier(map: ResolvedTierMap | undefined) {
  assert.ok(map, "expected a resolved tier map");
  return Object.fromEntries(
    Object.entries(map.tiers).map(([tier, rungs]) => [tier, rungs.map(({ rung, origin }) => ({ rung, origin }))]),
  );
}

const EXAMPLE_BY_TIER = {
  mechanical: personalRungs(EXAMPLE_TIERS.mechanical),
  standard: personalRungs(EXAMPLE_TIERS.standard),
  elevated: personalRungs(EXAMPLE_TIERS.elevated),
  critical: personalRungs(EXAMPLE_TIERS.critical),
};

interface TempSettings {
  agentDir: string;
  projectCwd: string;
  cleanup(): void;
}

/** A redirected agent dir and project, both inside one mkdtemp dir. Never the
 *  real ~/.pi/agent. Removed by exact path. */
function tempSettings(personal?: unknown, project?: unknown): TempSettings {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-tier-map-"));
  const agentDir = join(root, "agent");
  const projectCwd = join(root, "project");
  mkdirSync(agentDir);
  mkdirSync(join(projectCwd, ".pi"), { recursive: true });
  if (personal !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(personal));
  if (project !== undefined) writeFileSync(join(projectCwd, ".pi", "settings.json"), JSON.stringify(project));
  return { agentDir, projectCwd, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

function loadFromFiles(personal: unknown, project?: unknown, inputs: TierMapInputs = INPUTS) {
  const dirs = tempSettings(personal, project);
  try {
    return loadTierMap({ ...inputs, agentDir: dirs.agentDir, projectCwd: dirs.projectCwd });
  } finally {
    dirs.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Fixture: the installed models' thinking facts
// ---------------------------------------------------------------------------

test("the installed model info fixture covers exactly the installed registry ids", () => {
  assert.deepEqual(
    INSTALLED_MODEL_INFO.map((model) => model.fullId),
    [...INSTALLED_MODEL_IDS],
  );
});

// ---------------------------------------------------------------------------
// Personal tier map (stories 7, 8)
// ---------------------------------------------------------------------------

test("the example map loads with four tiers, rungs in written order, each tagged origin personal, no drops", () => {
  const map = tierMapFromSettings(examplePersonal(), undefined, INPUTS);
  assert.deepEqual(rungsByTier(map), EXAMPLE_BY_TIER);
  assert.deepEqual(Object.keys(map!.tiers), ["mechanical", "standard", "elevated", "critical"]);
  assert.deepEqual(map!.drops, []);
  assert.deepEqual(map!.ignoredProjectKeys, []);
  assert.deepEqual(map!.tiers.mechanical[0], {
    rung: "openai-codex/gpt-6-luna:low",
    model: "openai-codex/gpt-6-luna",
    effort: "low",
    origin: "personal",
  });

  assert.deepEqual(loadFromFiles(examplePersonal()), map);
});

test("a tier listing three rungs from three providers loads all three in order", () => {
  const standard = [
    "openai-codex/gpt-6-sol:medium",
    "anthropic/claude-sonnet-5:medium",
    "google/gemini-3.1-pro-preview:medium",
  ];
  const map = tierMapFromSettings(
    { orchestrator: { routing: { tiers: { ...EXAMPLE_TIERS, standard } } } },
    undefined,
    { ...WITH_GEMINI_INSTALLED, modelScope: { ...HARNESS_MODEL_SCOPE, allow: [...HARNESS_ALLOW_PATTERNS, GEMINI.fullId] } },
  );
  assert.deepEqual(rungsByTier(map).standard, personalRungs(standard));
  assert.deepEqual(
    map!.tiers.standard.map((rung) => rung.model.split("/")[0]),
    ["openai-codex", "anthropic", "google"],
  );
  assert.deepEqual(map!.drops, []);
});

// ---------------------------------------------------------------------------
// Project override (story 9)
// ---------------------------------------------------------------------------

test("a project file with only elevated replaces that tier with a project rung and inherits the other three", () => {
  const project = projectTiers({ elevated: ["anthropic/claude-sonnet-5:high"] });
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    elevated: [{ rung: "anthropic/claude-sonnet-5:high", origin: "project" }],
  });
  assert.deepEqual(map!.drops, []);
  assert.deepEqual(map!.ignoredProjectKeys, []);

  assert.deepEqual(loadFromFiles(examplePersonal(), project), map);
});

test("a project file without orchestrator.routing.tiers leaves the personal map in force", () => {
  for (const project of [{}, { defaultModel: "anthropic/claude-haiku-4-5" }, { orchestrator: {} }, { orchestrator: { routing: {} } }]) {
    const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
    assert.deepEqual(rungsByTier(map), EXAMPLE_BY_TIER);
    assert.deepEqual(map!.drops, []);
  }
  assert.deepEqual(rungsByTier(loadFromFiles(examplePersonal())), EXAMPLE_BY_TIER);
});

// ---------------------------------------------------------------------------
// Project drops (story 10)
// ---------------------------------------------------------------------------

test("project rungs on the subagent ban list or outside the allowed-model list are dropped with their reason, tier, rung and origin", () => {
  const project = projectTiers({
    elevated: [
      "anthropic/claude-fable-5:high",
      "openai-codex/gpt-6-astra:low",
      "google/gemini-3.1-pro-preview:high",
      "anthropic/claude-sonnet-5:high",
    ],
  });
  const map = tierMapFromSettings(examplePersonal(), project, WITH_GEMINI_INSTALLED);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    elevated: projectRungs(["anthropic/claude-sonnet-5:high"]),
  });
  assert.deepEqual(map!.drops, [
    { tier: "elevated", rung: "anthropic/claude-fable-5:high", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", rung: "openai-codex/gpt-6-astra:low", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", rung: "google/gemini-3.1-pro-preview:high", origin: "project", reason: "allowed-model list" },
  ]);

  assert.deepEqual(loadFromFiles(examplePersonal(), project, WITH_GEMINI_INSTALLED), map);
});

test("the ban list the project drops use is the personal subagentBanList, and a project cannot change it", () => {
  // The example's only sonnet rung is replaced, so the personal map itself passes.
  const personal = {
    orchestrator: {
      subagentBanList: ["fable", "astra", "sonnet"],
      routing: { tiers: { ...EXAMPLE_TIERS, standard: ["openai-codex/gpt-6-sol:medium"] } },
    },
  };
  const project = {
    orchestrator: {
      subagentBanList: [],
      routing: { tiers: { standard: ["anthropic/claude-sonnet-5:medium", "anthropic/claude-fable-5:medium"] } },
    },
  };
  const map = tierMapFromSettings(personal, project, INPUTS);
  assert.deepEqual(rungsByTier(map).standard, personalRungs(["openai-codex/gpt-6-sol:medium"]));
  assert.deepEqual(map!.drops, [
    { tier: "standard", rung: "anthropic/claude-sonnet-5:medium", origin: "project", reason: "subagent ban list" },
    { tier: "standard", rung: "anthropic/claude-fable-5:medium", origin: "project", reason: "subagent ban list" },
    { tier: "standard", origin: "project", reason: "inherited after drops" },
  ]);
  assert.deepEqual(map!.ignoredProjectKeys, ["orchestrator.subagentBanList"]);
});

test("a project tier whose every rung is dropped resolves to the personal tier and the drop list says inherited after drops", () => {
  const project = projectTiers({
    elevated: ["anthropic/claude-fable-5:high", "openai-codex/gpt-6-astra:low"],
    critical: ["anthropic/claude-opus-5:max"],
  });
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    critical: projectRungs(["anthropic/claude-opus-5:max"]),
  });
  assert.deepEqual(map!.drops, [
    { tier: "elevated", rung: "anthropic/claude-fable-5:high", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", rung: "openai-codex/gpt-6-astra:low", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", origin: "project", reason: "inherited after drops" },
  ]);

  assert.deepEqual(loadFromFiles(examplePersonal(), project), map);
});

// ---------------------------------------------------------------------------
// Ignored project keys (story 9)
// ---------------------------------------------------------------------------

test("a project fifth tier and every orchestrator key other than routing.tiers are left out of the map and named as ignored", () => {
  const project = {
    orchestrator: {
      subagentBanList: [],
      sessionBanList: ["opus"],
      somethingElse: true,
      routing: {
        enabled: false,
        mode: "live",
        classifier: { model: "anthropic/claude-haiku-4-5:low" },
        tiers: {
          experimental: ["anthropic/claude-haiku-4-5:low"],
          elevated: ["anthropic/claude-sonnet-5:high"],
        },
      },
    },
  };
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    elevated: projectRungs(["anthropic/claude-sonnet-5:high"]),
  });
  assert.equal(Object.hasOwn(map!.tiers, "experimental"), false);
  assert.deepEqual(map!.ignoredProjectKeys, [
    "orchestrator.subagentBanList",
    "orchestrator.sessionBanList",
    "orchestrator.somethingElse",
    "orchestrator.routing.enabled",
    "orchestrator.routing.mode",
    "orchestrator.routing.classifier",
    "orchestrator.routing.tiers.experimental",
  ]);
  assert.deepEqual(map!.drops, []);

  assert.deepEqual(loadFromFiles(examplePersonal(), project), map);
});

test("a project orchestrator.routing.enabled cannot switch routing on when the personal file has no tiers", () => {
  const project = { orchestrator: { routing: { enabled: true, tiers: { elevated: ["anthropic/claude-sonnet-5:high"] } } } };
  assert.equal(tierMapFromSettings({}, project, INPUTS), undefined);
});

// ---------------------------------------------------------------------------
// Fail closed, naming the key (story 11)
// ---------------------------------------------------------------------------

const withPersonalTiers = (tiers: Record<string, unknown>) => ({ orchestrator: { ...OWNER_BAN_LIST_SETTINGS, routing: { enabled: true, tiers } } });

const FAIL_CLOSED_CASES: ReadonlyArray<{ name: string; tiers: Record<string, unknown>; key: string; says: RegExp }> = [
  {
    name: "an unknown tier name",
    tiers: { ...EXAMPLE_TIERS, experimental: ["anthropic/claude-haiku-4-5:low"] },
    key: "orchestrator.routing.tiers.experimental",
    says: /not a tier/,
  },
  {
    name: "an empty tier list",
    tiers: { ...EXAMPLE_TIERS, standard: [] },
    key: "orchestrator.routing.tiers.standard",
    says: /non-empty/,
  },
  {
    name: "a rung without :effort",
    tiers: { ...EXAMPLE_TIERS, elevated: ["openai-codex/gpt-6-sol:high", "anthropic/claude-sonnet-5"] },
    key: "orchestrator.routing.tiers.elevated[1]",
    says: /no ':effort'/,
  },
  {
    name: "an effort outside pi's levels",
    tiers: { ...EXAMPLE_TIERS, elevated: ["anthropic/claude-sonnet-5:ultra"] },
    key: "orchestrator.routing.tiers.elevated[0]",
    says: /'ultra' is not one of pi's levels/,
  },
  {
    name: "an effort the named model does not support (max on haiku)",
    tiers: { ...EXAMPLE_TIERS, mechanical: ["anthropic/claude-haiku-4-5:max"] },
    key: "orchestrator.routing.tiers.mechanical[0]",
    says: /does not support effort 'max'/,
  },
  {
    name: "an effort the named model does not support (off on opus 5)",
    tiers: { ...EXAMPLE_TIERS, critical: ["anthropic/claude-opus-5:off"] },
    key: "orchestrator.routing.tiers.critical[0]",
    says: /does not support effort 'off'/,
  },
];

for (const { name, tiers, key, says } of FAIL_CLOSED_CASES) {
  test(`fails closed naming the key: ${name} in the personal file`, () => {
    const expected = new RegExp(`personal settings key '${key.replace(/[.[\]]/g, "\\$&")}'.*${says.source}`);
    assert.throws(() => tierMapFromSettings(withPersonalTiers(tiers), undefined, INPUTS), expected);
    assert.throws(() => loadFromFiles(withPersonalTiers(tiers)), expected);
  });
}

test("fails closed naming the key: a personal file with no tiers when routing is enabled", () => {
  for (const personal of [{ orchestrator: { routing: { enabled: true } } }, { orchestrator: { routing: { enabled: true, mode: "shadow" } } }]) {
    assert.throws(
      () => tierMapFromSettings(personal, undefined, INPUTS),
      /personal settings key 'orchestrator\.routing\.tiers' is missing while orchestrator\.routing\.enabled is true/,
    );
    assert.throws(() => loadFromFiles(personal), /'orchestrator\.routing\.tiers' is missing/);
  }
});

test("with routing not enabled, a personal file with no tiers yields no tier map", () => {
  for (const personal of [{}, { orchestrator: {} }, { orchestrator: { routing: {} } }, { orchestrator: { routing: { enabled: false } } }]) {
    assert.equal(tierMapFromSettings(personal, undefined, INPUTS), undefined);
  }
  const dirs = tempSettings();
  try {
    assert.equal(loadTierMap({ ...INPUTS, agentDir: dirs.agentDir, projectCwd: dirs.projectCwd }), undefined);
  } finally {
    dirs.cleanup();
  }
});

test("with routing not enabled, personal tiers still load and are still checked", () => {
  const personal = { orchestrator: { routing: { enabled: false, tiers: EXAMPLE_TIERS } } };
  assert.deepEqual(rungsByTier(tierMapFromSettings(personal, undefined, INPUTS)), EXAMPLE_BY_TIER);
  assert.throws(
    () => tierMapFromSettings({ orchestrator: { routing: { tiers: { ...EXAMPLE_TIERS, standard: [] } } } }, undefined, INPUTS),
    /'orchestrator\.routing\.tiers\.standard'/,
  );
});

test("fails closed naming the key: orchestrator.routing.enabled that is not a boolean", () => {
  assert.throws(
    () => tierMapFromSettings({ orchestrator: { routing: { enabled: "true", tiers: EXAMPLE_TIERS } } }, undefined, INPUTS),
    /personal settings key 'orchestrator\.routing\.enabled' must be a boolean/,
  );
});

test("fails closed naming the key: a personal file missing one of the four tiers", () => {
  const { critical: _critical, ...threeTiers } = EXAMPLE_TIERS;
  assert.throws(
    () => tierMapFromSettings(withPersonalTiers(threeTiers), undefined, INPUTS),
    /personal settings key 'orchestrator\.routing\.tiers\.critical' is missing/,
  );
});

// ---------------------------------------------------------------------------
// Personal drops (round 2: every rung failing a hard filter is dropped with a
// recorded reason; only a personal tier emptied by drops fails closed)
// ---------------------------------------------------------------------------

test("personal rungs on the subagent ban list or outside the allowed-model list are dropped with origin personal and the rest of the tier kept", () => {
  const personal = withPersonalTiers({
    ...EXAMPLE_TIERS,
    standard: ["openai-codex/gpt-6-sol:medium", "google/gemini-3.1-pro-preview:medium"],
    critical: ["anthropic/claude-fable-5:max", "anthropic/claude-opus-5:xhigh"],
  });
  const map = tierMapFromSettings(personal, undefined, WITH_GEMINI_INSTALLED);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    standard: personalRungs(["openai-codex/gpt-6-sol:medium"]),
    critical: personalRungs(["anthropic/claude-opus-5:xhigh"]),
  });
  assert.deepEqual(map!.drops, [
    { tier: "standard", rung: "google/gemini-3.1-pro-preview:medium", origin: "personal", reason: "allowed-model list" },
    { tier: "critical", rung: "anthropic/claude-fable-5:max", origin: "personal", reason: "subagent ban list" },
  ]);

  assert.deepEqual(loadFromFiles(personal, undefined, WITH_GEMINI_INSTALLED), map);
});

test("adding a ban-list name the personal map uses drops that rung and keeps routing", () => {
  const personal = { orchestrator: { subagentBanList: ["fable", "astra", "sonnet"], routing: { enabled: true, tiers: EXAMPLE_TIERS } } };
  const map = tierMapFromSettings(personal, undefined, INPUTS);
  assert.deepEqual(rungsByTier(map), { ...EXAMPLE_BY_TIER, standard: personalRungs(["openai-codex/gpt-6-sol:medium"]) });
  assert.deepEqual(map!.drops, [
    { tier: "standard", rung: "anthropic/claude-sonnet-5:medium", origin: "personal", reason: "subagent ban list" },
  ]);
});

test("fails closed naming the key: a personal tier whose every rung is dropped", () => {
  const personal = withPersonalTiers({
    ...EXAMPLE_TIERS,
    critical: ["anthropic/claude-fable-5:max", "openai-codex/gpt-6-astra:high"],
  });
  const expected = /personal settings key 'orchestrator\.routing\.tiers\.critical' has every rung dropped \(subagent ban list, subagent ban list\)/;
  assert.throws(() => tierMapFromSettings(personal, undefined, INPUTS), expected);
  assert.throws(() => loadFromFiles(personal), expected);
});

// ---------------------------------------------------------------------------
// Not installed (round 2: a rung must name an installed model)
// ---------------------------------------------------------------------------

test("rungs naming a model that is not installed are dropped with reason not installed, from either file", () => {
  const personal = withPersonalTiers({
    ...EXAMPLE_TIERS,
    // A typo of claude-opus-5-5 that still matches anthropic/claude-opus-*.
    critical: ["anthropic/claude-opus-5.5:high", "anthropic/claude-opus-5:xhigh"],
  });
  const project = projectTiers({
    standard: ["anthropic/claude-sonnet-5::high", "openai-codex/gpt-6-sol:medium"],
    // Not installed, so no levels to check: max is dropped, not refused.
    elevated: ["anthropic/claude-sonnet-9:high", "anthropic/claude-opus-9:max"],
  });
  const map = tierMapFromSettings(personal, project, INPUTS);
  assert.deepEqual(rungsByTier(map), {
    ...EXAMPLE_BY_TIER,
    standard: projectRungs(["openai-codex/gpt-6-sol:medium"]),
    critical: personalRungs(["anthropic/claude-opus-5:xhigh"]),
  });
  assert.deepEqual(map!.drops, [
    { tier: "critical", rung: "anthropic/claude-opus-5.5:high", origin: "personal", reason: "not installed" },
    { tier: "standard", rung: "anthropic/claude-sonnet-5::high", origin: "project", reason: "not installed" },
    { tier: "elevated", rung: "anthropic/claude-sonnet-9:high", origin: "project", reason: "not installed" },
    { tier: "elevated", rung: "anthropic/claude-opus-9:max", origin: "project", reason: "not installed" },
    { tier: "elevated", origin: "project", reason: "inherited after drops" },
  ]);

  assert.deepEqual(loadFromFiles(personal, project), map);
});

test("fails closed naming the key: a personal tier whose every rung is not installed", () => {
  assert.throws(
    () => tierMapFromSettings(withPersonalTiers({ ...EXAMPLE_TIERS, mechanical: ["anthropic/claude-haiku-9:low"] }), undefined, INPUTS),
    /personal settings key 'orchestrator\.routing\.tiers\.mechanical' has every rung dropped \(not installed\)/,
  );
});

test("the ban list and the allowed-model list are reported before not installed", () => {
  const project = projectTiers({
    elevated: ["openai/fable-1:high", "google/gemini-3.1-pro-preview:high", "anthropic/claude-sonnet-5:high"],
  });
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.deepEqual(map!.drops, [
    { tier: "elevated", rung: "openai/fable-1:high", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", rung: "google/gemini-3.1-pro-preview:high", origin: "project", reason: "allowed-model list" },
  ]);
});

test("the installed lookup ignores case on the full id, as pi's model resolver does, so the effort check still applies", () => {
  const project = projectTiers({ elevated: ["ANTHROPIC/Claude-Sonnet-5:high"] });
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.deepEqual(rungsByTier(map).elevated, projectRungs(["ANTHROPIC/Claude-Sonnet-5:high"]));
  assert.deepEqual(map!.drops, []);
  // The rung keeps the owner's spelling; `model` is the installed entry's
  // canonical id, so exact-match consumers (pi-subagents' findModelInfo) find it.
  assert.equal(map!.tiers.elevated[0]!.rung, "ANTHROPIC/Claude-Sonnet-5:high");
  assert.equal(map!.tiers.elevated[0]!.model, "anthropic/claude-sonnet-5");
  assert.throws(
    // pi's default levels include off; claude-opus-5's own map excludes it.
    () => tierMapFromSettings(examplePersonal(), projectTiers({ critical: ["ANTHROPIC/CLAUDE-OPUS-5:off"] }), INPUTS),
    /project settings key 'orchestrator\.routing\.tiers\.critical\[0\]'.*does not support effort 'off'/,
  );
});

test("fails closed naming the key: malformed project tiers", () => {
  const cases: ReadonlyArray<{ tiers: Record<string, unknown>; expected: RegExp }> = [
    { tiers: { standard: [] }, expected: /project settings key 'orchestrator\.routing\.tiers\.standard'.*non-empty/ },
    { tiers: { standard: "anthropic/claude-sonnet-5:medium" }, expected: /project settings key 'orchestrator\.routing\.tiers\.standard'.*non-empty/ },
    { tiers: { elevated: ["anthropic/claude-sonnet-5"] }, expected: /project settings key 'orchestrator\.routing\.tiers\.elevated\[0\]'.*no ':effort'/ },
    { tiers: { elevated: ["anthropic/claude-sonnet-5:ultra"] }, expected: /project settings key 'orchestrator\.routing\.tiers\.elevated\[0\]'.*not one of pi's levels/ },
    { tiers: { mechanical: ["anthropic/claude-haiku-4-5:max"] }, expected: /project settings key 'orchestrator\.routing\.tiers\.mechanical\[0\]'.*does not support effort 'max'/ },
    { tiers: { mechanical: ["claude-haiku-4-5:low"] }, expected: /project settings key 'orchestrator\.routing\.tiers\.mechanical\[0\]'.*provider\/model/ },
  ];
  for (const { tiers, expected } of cases) {
    assert.throws(() => tierMapFromSettings(examplePersonal(), projectTiers(tiers), INPUTS), expected);
    assert.throws(() => loadFromFiles(examplePersonal(), projectTiers(tiers)), expected);
  }
  assert.throws(
    () => tierMapFromSettings(examplePersonal(), { orchestrator: { routing: { tiers: ["anthropic/claude-sonnet-5:high"] } } }, INPUTS),
    /project settings key 'orchestrator\.routing\.tiers' must be an object/,
  );
});

test("fails closed on a settings file that is not valid JSON", () => {
  const dirs = tempSettings();
  try {
    writeFileSync(join(dirs.agentDir, "settings.json"), "{ not json");
    assert.throws(() => loadTierMap({ ...INPUTS, agentDir: dirs.agentDir }), /not valid JSON/);
  } finally {
    dirs.cleanup();
  }
});

// ---------------------------------------------------------------------------
// A plain value for the decision record (story 12)
// ---------------------------------------------------------------------------

test("the resolved map is a plain frozen value with per-rung origin and the full drop list", () => {
  const project = projectTiers({
    elevated: ["anthropic/claude-fable-5:high"],
    critical: ["anthropic/claude-opus-5:max", "openai-codex/gpt-6-astra:high"],
    experimental: ["anthropic/claude-haiku-4-5:low"],
  });
  const map = tierMapFromSettings(examplePersonal(), project, INPUTS);
  assert.ok(map);
  assert.deepEqual(JSON.parse(JSON.stringify(map)), map);
  assert.deepEqual(structuredClone(map), map);
  assert.deepEqual(Object.keys(map), ["tiers", "drops", "ignoredProjectKeys"]);

  const frozen = (value: unknown): boolean =>
    typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
  assert.equal(frozen(map), true);

  assert.deepEqual(rungsByTier(map).critical, projectRungs(["anthropic/claude-opus-5:max"]));
  assert.deepEqual(map.drops, [
    { tier: "elevated", rung: "anthropic/claude-fable-5:high", origin: "project", reason: "subagent ban list" },
    { tier: "elevated", origin: "project", reason: "inherited after drops" },
    { tier: "critical", rung: "openai-codex/gpt-6-astra:high", origin: "project", reason: "subagent ban list" },
  ]);
  assert.deepEqual(map.ignoredProjectKeys, ["orchestrator.routing.tiers.experimental"]);
});
