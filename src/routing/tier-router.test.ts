import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { allowanceConstraint, newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { known, unknown } from "../catalog/epistemic.ts";
import { buildCatalog, type ContextWindow } from "../catalog/model-catalog.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { DEFAULT_BAN_LISTS } from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, type RecipientAuthorization } from "../recipients/authorization.ts";
import { NO_BUDGET_CONSTRAINT, type AuthorizedDelegationOutcome } from "../recipients/authorized-delegation.ts";
import { tierMapFromSettings, type ResolvedTierMap } from "./tier-map.ts";
import { routeTier, type RouterEvidence, type TierRouteDecision, type TierRouteInput } from "./tier-router.ts";

// Seam (ticket 24): `routeTier` with every piece of evidence injected as a
// plain value. Ticket 27's extension hook will call this function with the
// classified tier, the loaded tier map and live evidence. The tier map comes
// from ticket 22's real loader, so the rungs are the ones a settings file
// would produce.

const NOW = new Date("2026-09-24T12:00:00.000Z");
const AS_OF = NOW.toISOString();

const LUNA = "openai-codex/gpt-6-luna";
const SOL = "openai-codex/gpt-6-sol";
const HAIKU = "anthropic/claude-haiku-4-5"; //  200k context window in the pinned snapshot
const SONNET = "anthropic/claude-sonnet-5"; // 1M
const OPUS = "anthropic/claude-opus-5"; //      1M

const TIERS = {
  mechanical: [`${LUNA}:low`, `${HAIKU}:low`],
  standard: [`${LUNA}:medium`, `${SONNET}:medium`],
  elevated: [`${SOL}:high`, `${OPUS}:high`],
  critical: [`${OPUS}:xhigh`, `${SOL}:xhigh`],
};

type Tiers = Record<keyof typeof TIERS, readonly string[]>;

/** The map as ticket 22's loader resolves it from a personal settings file. */
function tierMap(tiers: Tiers = TIERS): ResolvedTierMap {
  const map = tierMapFromSettings({ orchestrator: { routing: { enabled: true, tiers } } }, undefined, {
    installedModels: INSTALLED_MODEL_INFO,
    modelScope: HARNESS_MODEL_SCOPE,
    banLists: DEFAULT_BAN_LISTS,
  });
  assert.ok(map, "expected a resolved tier map");
  return map;
}

/** The catalog built from the real pinned snapshot. Every `taskSuitability`
 *  is unknown there, so a test that routes on it shows no earned score is
 *  needed to route (ADR 0001). */
const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS], now: NOW });

function authorizedFor(providers: readonly string[]): RecipientAuthorization {
  let authorization = emptyAuthorization();
  for (const provider of providers) {
    authorization = authorizeRecipient(
      authorization,
      provider,
      grantOwnerApproval({
        approvedBy: "owner (test fixture)",
        scope: "data-recipient",
        acknowledgement: `test fixture approves ${provider}`,
        grantedAt: AS_OF,
      }),
    );
  }
  return authorization;
}

/** Evidence under which no hard filter removes anything. */
function evidence(overrides: Partial<RouterEvidence> = {}): RouterEvidence {
  return {
    providerUsage: {},
    catalog,
    estimatedPromptTokens: 20_000,
    allowance: NO_BUDGET_CONSTRAINT,
    authorization: authorizedFor(["anthropic", "openai-codex"]),
    banLists: DEFAULT_BAN_LISTS,
    modelScope: HARNESS_MODEL_SCOPE,
    ...overrides,
  };
}

function input(tier: TierRouteInput["tier"], overrides: Partial<RouterEvidence> = {}, tiers: Tiers = TIERS): TierRouteInput {
  return { tier, tierMap: tierMap(tiers), evidence: evidence(overrides) };
}

// ---------------------------------------------------------------------------
// Story 23: the first surviving rung of the classified tier
// ---------------------------------------------------------------------------

test("with no filter removing anything, the first rung of the classified tier wins and nothing is removed", () => {
  for (const tier of ["mechanical", "standard", "elevated", "critical"] as const) {
    const decision = routeTier(input(tier));
    assert.equal(decision.ok, true, tier);
    if (!decision.ok) continue;
    assert.equal(decision.rung.rung, TIERS[tier][0], `${tier}: the first rung in map order`);
    assert.equal(decision.model, decision.rung.model);
    assert.deepEqual(decision.removed, [], `${tier}: nothing removed`);
    assert.equal(decision.startedAtTier, tier);
    assert.equal(decision.tier, tier);
    assert.deepEqual(decision.tiersTried, [tier]);
    assert.equal(decision.refused, false);
  }
  // No earned score was needed: the pinned catalog evidences no suitability.
  assert.equal(catalog.entries[LUNA]?.taskSuitability.state, "unknown");
});

// ---------------------------------------------------------------------------
// Story 22: one test per hard filter, each removing exactly one rung
// ---------------------------------------------------------------------------

/** The standard tier is [luna, sonnet]; each filter below removes luna only,
 *  so sonnet wins in the same tier and the removal is the only difference. */
function assertOnlyLunaRemoved(decision: TierRouteDecision, reason: string, detail: RegExp): void {
  assert.equal(decision.ok, true, "sonnet survives, so the tier does not empty");
  if (!decision.ok) return;
  assert.equal(decision.rung.rung, `${SONNET}:medium`);
  assert.equal(decision.tier, "standard");
  assert.deepEqual(decision.tiersTried, ["standard"]);
  assert.equal(decision.removed.length, 1, JSON.stringify(decision.removed));
  const [removed] = decision.removed;
  assert.ok(removed);
  assert.equal(removed.tier, "standard");
  assert.equal(removed.rung, `${LUNA}:medium`);
  assert.equal(removed.model, LUNA);
  assert.equal(removed.reason, reason);
  assert.match(removed.detail, detail);
}

test("a banned rung is removed with the reason 'subagent ban list'", () => {
  // The map loaded under the default list; the owner has since banned luna.
  const decision = routeTier(input("standard", { banLists: { subagentBanList: ["luna"], sessionBanList: [] } }));
  assertOnlyLunaRemoved(decision, "subagent ban list", /subagent ban list entry 'luna'/);
});

test("a rung outside the allowed-model list is removed with the reason 'allowed-model list'", () => {
  const scope = { enforce: true, strict: true, allow: ["anthropic/claude-sonnet-*"] };
  const decision = routeTier(input("standard", { modelScope: scope }));
  assertOnlyLunaRemoved(decision, "allowed-model list", /outside the configured subagent model scope/);
});

test("a rung whose provider is out of usage is removed with the reason 'provider out of usage'", () => {
  const decision = routeTier(input("standard", {
    providerUsage: { "openai-codex": { state: "out-of-usage", detail: "weekly limit reached" } },
  }));
  assertOnlyLunaRemoved(decision, "provider out of usage", /'openai-codex' is out of usage: weekly limit reached/);
});

test("a rung whose provider is throttled is removed with the reason 'provider throttled'", () => {
  const decision = routeTier(input("standard", {
    providerUsage: { "openai-codex": { state: "throttled", detail: "429, retry after 60s" } },
  }));
  assertOnlyLunaRemoved(decision, "provider throttled", /'openai-codex' is throttled: 429, retry after 60s/);
});

test("a rung whose catalog context window cannot hold the prompt plus five percent is removed with the reason 'context window'", () => {
  const tiers = { ...TIERS, standard: [`${HAIKU}:medium`, `${SONNET}:medium`] };
  // 195,000 + 5% = 204,750 tokens needed; haiku's window is 200,000.
  const decision = routeTier(input("standard", { estimatedPromptTokens: 195_000 }, tiers));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.rung.rung, `${SONNET}:medium`);
  assert.deepEqual(decision.removed.map(({ rung, reason }) => ({ rung, reason })), [
    { rung: `${HAIKU}:medium`, reason: "context window" },
  ]);
  assert.match(decision.removed[0]?.detail ?? "", /200000-token context window is smaller than the 204750 tokens needed \(195000 estimated plus 5% headroom\)/);

  // 190,000 + 5% = 199,500 fits in 200,000, so haiku stays first.
  const fits = routeTier(input("standard", { estimatedPromptTokens: 190_000 }, tiers));
  assert.equal(fits.ok && fits.rung.rung, `${HAIKU}:medium`);
  assert.deepEqual(fits.ok && fits.removed, []);
});

test("a rung the allowance preflight rejects is removed with the reason 'allowance preflight'", () => {
  // Luna re-priced as a metered route: 100k in + 10k out at $10/$30 is
  // $1.30, and ticket 09's allowance has $1 left. Sonnet stays subscription.
  const metered = {
    ...catalog,
    entries: {
      ...catalog.entries,
      [LUNA]: {
        ...catalog.entries[LUNA]!,
        routeBilling: known<"metered">("metered", "operator-configured", AS_OF),
        publishedListPrice: known({ inputUsdPerMTok: 10, outputUsdPerMTok: 30 }, "published-dataset", AS_OF),
      },
    },
  };
  const owner = new TaskAllowanceOwner(newTaskLedger({ taskId: "task-router", allowanceUsd: 1, now: NOW }));
  const allowance = allowanceConstraint(owner, metered, { role: "subtask", maxInputTokens: 100_000, maxOutputTokens: 10_000 }, { now: NOW.getTime() });
  const decision = routeTier(input("standard", { catalog: metered, allowance }));
  assertOnlyLunaRemoved(decision, "allowance preflight", /\$1\.3000 exceeds the \$1\.0000 remaining/);
  // A preflight is observation: nothing was reserved.
  assert.equal(owner.snapshot().open.length, 0);
});

test("a rung whose provider is not an approved recipient is removed with the reason 'unapproved recipient'", () => {
  const decision = routeTier(input("standard", { authorization: authorizedFor(["anthropic"]) }));
  assertOnlyLunaRemoved(decision, "unapproved recipient", /'openai-codex' is not an approved data recipient/);
});

test("the context window boundary is exact: a prompt needing exactly the window is kept, one token more is removed", () => {
  const tiers = { ...TIERS, standard: [`${HAIKU}:medium`, `${SONNET}:medium`] };
  // 190,476 + ceil(9,523.8) = 200,000 tokens needed: exactly haiku's window.
  const exact = routeTier(input("standard", { estimatedPromptTokens: 190_476 }, tiers));
  assert.equal(exact.ok && exact.rung.rung, `${HAIKU}:medium`, "a window equal to the need holds the prompt");
  assert.deepEqual(exact.ok && exact.removed, []);

  // 190,477 + ceil(9,523.85) = 200,001 tokens needed: one more than the window.
  const over = routeTier(input("standard", { estimatedPromptTokens: 190_477 }, tiers));
  assert.equal(over.ok && over.rung.rung, `${SONNET}:medium`);
  assert.deepEqual(over.ok && over.removed.map(({ rung, reason }) => ({ rung, reason })), [
    { rung: `${HAIKU}:medium`, reason: "context window" },
  ]);
  assert.match(over.ok ? over.removed[0]?.detail ?? "" : "", /smaller than the 200001 tokens needed/);
});

test("a rung failing several filters is removed by the first in order: ban list before scope, scope before usage", () => {
  const sonnetOnly = { enforce: true, strict: true, allow: ["anthropic/claude-sonnet-*"] };

  // Luna is both banned and outside the allowed-model list: the ban reports.
  const bannedAndOutOfScope = routeTier(input("standard", {
    banLists: { subagentBanList: ["luna"], sessionBanList: [] },
    modelScope: sonnetOnly,
  }));
  assertOnlyLunaRemoved(bannedAndOutOfScope, "subagent ban list", /subagent ban list entry 'luna'/);

  // Luna is both outside the allowed-model list and its provider is out of
  // usage: the allowed-model list reports.
  const outOfScopeAndOutOfUsage = routeTier(input("standard", {
    modelScope: sonnetOnly,
    providerUsage: { "openai-codex": { state: "out-of-usage" } },
  }));
  assertOnlyLunaRemoved(outOfScopeAndOutOfUsage, "allowed-model list", /outside the configured subagent model scope/);
});

test("a rung with an unknown context window is neither removed nor preferred for it", () => {
  // Luna's entry kept, its window made unknown.
  const unknownLuna = {
    ...catalog,
    entries: {
      ...catalog.entries,
      [LUNA]: { ...catalog.entries[LUNA]!, contextWindow: unknown<ContextWindow>("absent-from-source") },
    },
  };
  const large = { catalog: unknownLuna, estimatedPromptTokens: 195_000 };

  // Not removed: first in its tier, it wins even though haiku's known window
  // would not have held this prompt.
  const first = routeTier(input("standard", large, { ...TIERS, standard: [`${LUNA}:medium`, `${HAIKU}:medium`] }));
  assert.equal(first.ok && first.rung.rung, `${LUNA}:medium`);
  assert.deepEqual(first.ok && first.removed.map((removed) => removed.rung), [`${HAIKU}:medium`], "only haiku's known window removes it");

  // Not demoted either: ahead of a rung whose known window fits, it stays ahead.
  const ahead = routeTier(input("standard", large, { ...TIERS, standard: [`${LUNA}:medium`, `${SONNET}:medium`] }));
  assert.equal(ahead.ok && ahead.rung.rung, `${LUNA}:medium`);
  assert.deepEqual(ahead.ok && ahead.survivors.map((rung) => rung.rung), [`${LUNA}:medium`, `${SONNET}:medium`]);

  // Not preferred: behind a rung whose known window fits, it stays behind.
  const second = routeTier(input("standard", large, { ...TIERS, standard: [`${SONNET}:medium`, `${LUNA}:medium`] }));
  assert.equal(second.ok && second.rung.rung, `${SONNET}:medium`);

  // And behind a rung the window removes, it is simply the next survivor.
  const behindRemoved = routeTier(input("standard", large, { ...TIERS, standard: [`${HAIKU}:medium`, `${LUNA}:medium`] }));
  assert.equal(behindRemoved.ok && behindRemoved.rung.rung, `${LUNA}:medium`);
  assert.deepEqual(behindRemoved.ok && behindRemoved.removed.map((removed) => removed.rung), [`${HAIKU}:medium`]);
});

test("an estimated prompt that is not a non-negative number is refused loudly, not routed", () => {
  for (const estimatedPromptTokens of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.throws(() => routeTier(input("standard", { estimatedPromptTokens })), /estimatedPromptTokens/);
  }
});

test("standard tier [luna, sonnet] with Codex out of usage yields sonnet and no tier move", () => {
  const decision = routeTier(input("standard", { providerUsage: { "openai-codex": { state: "out-of-usage" } } }));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.model, SONNET);
  assert.equal(decision.rung.rung, `${SONNET}:medium`);
  assert.equal(decision.startedAtTier, "standard");
  assert.equal(decision.tier, "standard");
  assert.deepEqual(decision.tiersTried, ["standard"]);
  assert.deepEqual(decision.removed.map(({ rung, reason }) => ({ rung, reason })), [
    { rung: `${LUNA}:medium`, reason: "provider out of usage" },
  ]);
});

// ---------------------------------------------------------------------------
// Story 24: an emptied tier moves up one tier, and the record says so
// ---------------------------------------------------------------------------

test("an emptied elevated tier yields the first surviving critical rung, startedAtTier elevated and tier critical", () => {
  const tiers = { ...TIERS, elevated: [`${SOL}:high`, `${SONNET}:high`] };
  const decision = routeTier(input("elevated", {
    providerUsage: { "openai-codex": { state: "out-of-usage", detail: "weekly limit reached" } },
    banLists: { subagentBanList: ["sonnet"], sessionBanList: [] },
  }, tiers));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.startedAtTier, "elevated");
  assert.equal(decision.tier, "critical");
  assert.deepEqual(decision.tiersTried, ["elevated", "critical"]);
  assert.equal(decision.rung.rung, `${OPUS}:xhigh`, "the first surviving critical rung");
  assert.deepEqual(decision.removed.map(({ tier, rung, reason }) => ({ tier, rung, reason })), [
    { tier: "elevated", rung: `${SOL}:high`, reason: "provider out of usage" },
    { tier: "elevated", rung: `${SONNET}:high`, reason: "subagent ban list" },
    { tier: "critical", rung: `${SOL}:xhigh`, reason: "provider out of usage" },
  ]);
});

test("a tier move climbs one tier at a time and records every tier it passed through", () => {
  // Mechanical and standard emptied by one fact: only luna is installed in them.
  const tiers = { ...TIERS, mechanical: [`${LUNA}:low`], standard: [`${LUNA}:medium`] };
  const decision = routeTier(input("mechanical", { providerUsage: { "openai-codex": { state: "throttled" } } }, tiers));
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.deepEqual(decision.tiersTried, ["mechanical", "standard", "elevated"]);
  assert.equal(decision.tier, "elevated");
  assert.equal(decision.rung.rung, `${OPUS}:high`);
});

// ---------------------------------------------------------------------------
// Story 25: an emptied top tier refuses with ticket 07's blocker shape
// ---------------------------------------------------------------------------

test("an emptied critical tier yields a blocker naming every tier tried and every removed rung with reason, and no model", () => {
  const decision = routeTier(input("elevated", { authorization: emptyAuthorization() }));
  assert.equal(decision.ok, false);
  if (decision.ok) return;

  // The same shape ticket 07's delegation boundary returns for a refusal.
  const blocker: Extract<AuthorizedDelegationOutcome, { readonly ok: false }> = decision;
  assert.equal(blocker.code, "no_authorized_candidate");
  assert.deepEqual(blocker.approvedRecipients, []);

  assert.equal(decision.refused, true);
  assert.equal(decision.startedAtTier, "elevated");
  assert.deepEqual(decision.tiersTried, ["elevated", "critical"]);
  const everyRung = [...TIERS.elevated, ...TIERS.critical];
  assert.deepEqual(decision.removed.map((removed) => removed.rung), everyRung);
  assert.ok(decision.removed.every((removed) => removed.reason === "unapproved recipient"));
  assert.deepEqual(decision.consideredAndRefused.map((refused) => refused.model), everyRung);
  for (const refused of decision.consideredAndRefused) assert.match(refused.why, /unapproved recipient: /);

  // The message names the classified tier, each tier tried, and each rung
  // with its reason, so a reader needs nothing else.
  assert.match(decision.message, /classified elevated/);
  assert.match(decision.message, /tiers tried: elevated, critical/);
  for (const rung of everyRung) assert.ok(decision.message.includes(`${rung} (unapproved recipient)`), decision.message);
  assert.match(decision.message, /No model was chosen/);

  // No model is written into the call: the refusal carries none.
  assert.ok(!("model" in decision), "a refusal names no model");
  assert.ok(!("rung" in decision), "a refusal names no rung");
});

test("a critical task whose critical tier empties refuses without trying any other tier", () => {
  const decision = routeTier(input("critical", {
    providerUsage: { "openai-codex": { state: "throttled", detail: "429" } },
    banLists: { subagentBanList: ["opus"], sessionBanList: [] },
  }));
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.deepEqual(decision.tiersTried, ["critical"]);
  assert.deepEqual(decision.removed.map(({ rung, reason }) => ({ rung, reason })), [
    { rung: `${OPUS}:xhigh`, reason: "subagent ban list" },
    { rung: `${SOL}:xhigh`, reason: "provider throttled" },
  ]);
});

// ---------------------------------------------------------------------------
// Story 26: no path moves down
// ---------------------------------------------------------------------------

test("a task classified critical never resolves to a mechanical rung, even when every one is cheaper and available", () => {
  // Non-vacuous: the mechanical rungs really are cheaper than every critical
  // rung on published list price, and nothing below removes them.
  const price = (model: string) => {
    const fact = catalog.entries[model]?.publishedListPrice;
    assert.equal(fact?.state, "known", `${model} has a published price`);
    return fact?.state === "known" ? fact.value.inputUsdPerMTok : Number.NaN;
  };
  const mechanicalModels = [LUNA, HAIKU];
  const criticalModels = [OPUS, SOL];
  for (const cheap of mechanicalModels) {
    for (const dear of criticalModels) assert.ok(price(cheap) < price(dear), `${cheap} is cheaper than ${dear}`);
  }
  const tiers = { ...TIERS, critical: [`${OPUS}:xhigh`, `${SOL}:xhigh`] };
  const lowerRungs = new Set([...tiers.mechanical, ...tiers.standard, ...tiers.elevated]);

  // Critical rungs removed by ban list, one at a time and together; the
  // mechanical rungs stay available in every case.
  for (const subagentBanList of [[], ["opus"], ["gpt-6-sol"], ["opus", "gpt-6-sol"]]) {
    const decision = routeTier(input("critical", { banLists: { subagentBanList, sessionBanList: [] } }, tiers));
    assert.deepEqual(decision.tiersTried, ["critical"], `ban ${subagentBanList.join(",")}`);
    if (decision.ok) {
      assert.equal(decision.tier, "critical");
      assert.ok(!lowerRungs.has(decision.rung.rung), `resolved to a lower rung: ${decision.rung.rung}`);
    } else {
      assert.equal(subagentBanList.length, 2, "only emptying the critical tier refuses");
    }
    const mechanicalCheck = routeTier(input("mechanical", { banLists: { subagentBanList, sessionBanList: [] } }, tiers));
    assert.equal(mechanicalCheck.ok && mechanicalCheck.tier, "mechanical", "the mechanical rungs were available throughout");
  }
});

test("an elevated task whose elevated and critical tiers empty refuses rather than falling to standard or mechanical", () => {
  const decision = routeTier(input("elevated", { banLists: { subagentBanList: ["opus", "gpt-6-sol"], sessionBanList: [] } }));
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.deepEqual(decision.tiersTried, ["elevated", "critical"]);
  assert.ok(decision.removed.every((removed) => removed.tier === "elevated" || removed.tier === "critical"));
});

// ---------------------------------------------------------------------------
// Story 27: one routing path; earned scores gate nothing on it
// ---------------------------------------------------------------------------

const harnessDir = join(dirname(fileURLToPath(import.meta.url)), "..");

test("the suitability floor and the promotion bar are named only by the observation ledger", () => {
  // Built by concatenation so this file does not match its own search.
  const floor = ["minSuitability", "ByTier"].join("");
  const bar = ["MIN_DISTINCT_OBSERVATIONS", "_FOR_KNOWN"].join("");
  const ledger = [
    join(harnessDir, "catalog", "refresh-lifecycle.test.ts"),
    join(harnessDir, "catalog", "refresh-lifecycle.ts"),
  ];
  const filesNaming = (token: string) =>
    spawnSync("grep", ["-rl", token, harnessDir], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).sort();
  assert.deepEqual(filesNaming(floor), [], "the per-tier suitability floor is gone");
  assert.deepEqual(filesNaming(bar), ledger, "the promotion bar lives in the ledger only");

  // The router and ticket 19's candidate computation read no earned score.
  for (const file of [join(harnessDir, "routing", "tier-router.ts")]) {
    const source = readFileSync(file, "utf8");
    assert.ok(!source.includes("taskSuitability"), `${file} reads task suitability`);
    assert.ok(!source.includes("routing-policy"), `${file} imports ticket 06's legacy path`);
  }
});
