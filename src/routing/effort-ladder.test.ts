import assert from "node:assert/strict";
import { test } from "node:test";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { DEFAULT_BAN_LISTS } from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval } from "../recipients/authorization.ts";
import { NO_BUDGET_CONSTRAINT } from "../recipients/authorized-delegation.ts";
import { nextRungAfterFailure } from "./effort-ladder.ts";
import { tierMapFromSettings, type ResolvedTierMap } from "./tier-map.ts";
import type { RouterEvidence } from "./tier-router.ts";

// Seam (ADR 0018): `nextRungAfterFailure`, the pure effort-ladder climb, fed a
// tier map loaded by ticket 22's loader. The climb reads a failed rung's text,
// model and effort; this file pins what a generated rung carries.

const NOW = new Date("2026-10-09T12:00:00.000Z");
const OPUS_5_5 = "anthropic/claude-opus-5-5";

const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS], now: NOW });

function evidence(overrides: Partial<RouterEvidence> = {}): RouterEvidence {
  let authorization = emptyAuthorization();
  for (const provider of ["anthropic", "openai-codex"]) {
    authorization = authorizeRecipient(authorization, provider, grantOwnerApproval({
      approvedBy: "owner (test fixture)",
      scope: "data-recipient",
      acknowledgement: `test fixture approves ${provider}`,
      grantedAt: NOW.toISOString(),
    }));
  }
  return {
    providerUsage: {},
    catalog,
    estimatedPromptTokens: 20_000,
    allowance: NO_BUDGET_CONSTRAINT,
    authorization,
    banLists: DEFAULT_BAN_LISTS,
    modelScope: HARNESS_MODEL_SCOPE,
    ...overrides,
  };
}

function tierMapWith(elevated: readonly string[]): ResolvedTierMap {
  const map = tierMapFromSettings({ orchestrator: { routing: { enabled: true, tiers: {
    mechanical: ["openai-codex/gpt-6-luna:low"],
    standard: ["openai-codex/gpt-6-luna:medium"],
    elevated,
    critical: ["openai-codex/gpt-6-sol:xhigh"],
  } } } }, undefined, { installedModels: INSTALLED_MODEL_INFO, modelScope: HARNESS_MODEL_SCOPE, banLists: DEFAULT_BAN_LISTS });
  assert.ok(map, "expected a resolved tier map");
  return map;
}

test("a dynamic rung climb raises its floor one supported level and keeps the same maximum", () => {
  const tierMap = tierMapWith([`${OPUS_5_5}:medium-xhigh`]);
  const failed = tierMap.tiers.elevated[0]!;
  assert.equal(failed.effort, "xhigh");
  const decision = nextRungAfterFailure({
    failed: { delegationId: "attempt-1", tier: "elevated", rung: failed },
    tierMap,
    installedModels: INSTALLED_MODEL_INFO,
    evidence: evidence(),
  });
  assert.equal(decision.step, "effort");
  assert.ok("rung" in decision);
  assert.deepEqual(decision.rung, {
    rung: `${OPUS_5_5}:high-xhigh`, model: OPUS_5_5, effort: "xhigh", band: { min: "high", max: "xhigh" }, origin: "personal",
  });
});

test("a raised dynamic band still passes hard filters before the ladder selects it", () => {
  const nextListed = "openai-codex/gpt-6-luna:high";
  const tierMap = tierMapWith([`${OPUS_5_5}:medium-xhigh`, nextListed]);
  const decision = nextRungAfterFailure({
    failed: { delegationId: "attempt-1", tier: "elevated", rung: tierMap.tiers.elevated[0]! },
    tierMap,
    installedModels: INSTALLED_MODEL_INFO,
    evidence: evidence({ providerUsage: { anthropic: { state: "out-of-usage" } } }),
  });
  assert.equal(decision.step, "same-tier");
  assert.ok("rung" in decision);
  assert.equal(decision.rung.rung, nextListed);
  assert.deepEqual(decision.skipped.map(({ rung, reason }) => [rung, reason]), [[`${OPUS_5_5}:high-xhigh`, "provider out of usage"]]);
});

test("a dynamic rung at its top floor advances to the next listed rung without considering effort above the band", () => {
  const tierMap = tierMapWith([`${OPUS_5_5}:xhigh-xhigh`, "openai-codex/gpt-6-luna:high"]);
  const failed = tierMap.tiers.elevated[0]!;
  const decision = nextRungAfterFailure({
    failed: { delegationId: "attempt-1", tier: "elevated", rung: failed },
    tierMap,
    installedModels: INSTALLED_MODEL_INFO,
    evidence: evidence(),
  });
  assert.equal(decision.step, "same-tier");
  assert.ok("rung" in decision);
  assert.deepEqual(decision.rung, tierMap.tiers.elevated[1]);
  assert.deepEqual(decision.skipped, []);
});

test("a generated dynamic rung keeps its listed position when the next rung uses the same model", () => {
  const tierMap = tierMapWith([`${OPUS_5_5}:medium-xhigh`, `${OPUS_5_5}:xhigh`, "openai-codex/gpt-6-luna:high"]);
  const original = tierMap.tiers.elevated[0]!;
  const failed = { ...original, rung: `${OPUS_5_5}:xhigh-xhigh`, band: { min: "xhigh" as const, max: "xhigh" as const } };
  const decision = nextRungAfterFailure({
    failed: { delegationId: "attempt-1", tier: "elevated", rung: failed },
    tierMap,
    installedModels: INSTALLED_MODEL_INFO,
    evidence: evidence(),
  });
  assert.equal(decision.step, "same-tier");
  assert.ok("rung" in decision);
  assert.deepEqual(decision.rung, tierMap.tiers.elevated[1]);
});
