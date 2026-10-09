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

function evidence(): RouterEvidence {
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

test("a climb from a dynamic rung's top to a listed max builds a single-effort rung, with no band", () => {
  // The band's top is xhigh, so the next effort on Opus 5.5 is max, listed below.
  const tierMap = tierMapWith([`${OPUS_5_5}:medium-xhigh`, `${OPUS_5_5}:max`]);
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
  assert.deepEqual(decision.rung, { rung: `${OPUS_5_5}:max`, model: OPUS_5_5, effort: "max", origin: "personal" });
});
