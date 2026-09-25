import { OWNER_BAN_LIST_SETTINGS, OWNER_BAN_LISTS } from "./owner-ban-lists.ts";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval } from "../recipients/authorization.ts";
import { NO_BUDGET_CONSTRAINT } from "../recipients/authorized-dispatch.ts";
import type { RiskTier } from "../routing/classifier.ts";
import { classifyTier, loadClassifierChain, type TierClassification } from "../routing/tier-classifier.ts";
import type { KindOfWork } from "../routing/tier-answer-schema.ts";
import { tierMapFromSettings, type ResolvedTierMap } from "../routing/tier-map.ts";
import { routeTier, type ProviderUsage, type TierRouteDecision } from "../routing/tier-router.ts";
import { INSTALLED_MODEL_IDS } from "./installed-models.ts";
import { INSTALLED_MODEL_INFO } from "./installed-model-info.ts";

// Ticket 25: the three values a decision record composes, produced by the
// real ticket 22, 23 and 24 functions (the classifier with a fake model call),
// so record tests hold real shapes rather than hand-written look-alikes.

export const LUNA = "openai-codex/gpt-6-luna";
export const SOL = "openai-codex/gpt-6-sol";
export const HAIKU = "anthropic/claude-haiku-4-5";
export const SONNET = "anthropic/claude-sonnet-5";
export const OPUS = "anthropic/claude-opus-5";

export const FIXTURE_TIERS = {
  mechanical: [`${LUNA}:low`, `${HAIKU}:low`],
  standard: [`${LUNA}:medium`, `${SONNET}:medium`],
  elevated: [`${SOL}:high`, `${OPUS}:high`],
  critical: [`${OPUS}:xhigh`, `${SOL}:xhigh`],
};

/** Personal settings with the fixture map. Extra top-level keys (a token, say)
 *  can be merged in by a test. */
export function fixturePersonalSettings(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { orchestrator: { ...OWNER_BAN_LIST_SETTINGS, routing: { enabled: true, tiers: FIXTURE_TIERS } }, ...extra };
}

/** A project override that replaces `elevated`, drops a banned rung and
 *  carries one key a project may not set, so origin, drops and ignored keys
 *  are all non-empty. */
export const FIXTURE_PROJECT_SETTINGS = {
  orchestrator: {
    subagentBanList: [],
    routing: { tiers: { elevated: ["anthropic/claude-fable-5:high", `${OPUS}:high`] } },
  },
};

export function fixtureTierMap(personal: unknown = fixturePersonalSettings(), project: unknown = FIXTURE_PROJECT_SETTINGS): ResolvedTierMap {
  const map = tierMapFromSettings(personal, project, {
    installedModels: INSTALLED_MODEL_INFO,
    modelScope: HARNESS_MODEL_SCOPE,
    banLists: OWNER_BAN_LISTS,
  });
  if (!map) throw new Error("fixture tier map did not resolve");
  return map;
}

const CLASSIFIER_RUNG = "openai-codex/gpt-6-luna:low";

/** The classifier's record for `task`, decided by a fake model answering
 *  `tier` and `kindOfWork`. */
export async function fixtureClassification(
  task: string,
  tier: RiskTier = "standard",
  kindOfWork: KindOfWork = "implement",
): Promise<TierClassification> {
  const catalog = buildCatalog({ modelIds: [LUNA] });
  const owner = new TaskAllowanceOwner(newTaskLedger({ taskId: "ticket-25-fixture", allowanceUsd: 5 }));
  const reply = JSON.stringify({
    tier,
    risk: { level: "some", reasons: ["fixture reason"] },
    ambiguity: "clear",
    complexity: "medium",
    kindOfWork,
    why: `fixture classifier says ${tier}`,
  });
  return classifyTier(
    { task, role: "worker", paths: [] },
    {
      chain: loadClassifierChain({ model: CLASSIFIER_RUNG, timeoutMs: 1_000, fallback: [] }),
      callModel: async () => reply,
      allowance: { owner, catalog },
    },
  );
}

const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS], now: new Date("2026-09-24T12:00:00.000Z") });

function authorizedFor(providers: readonly string[]) {
  let authorization = emptyAuthorization();
  for (const provider of providers) {
    authorization = authorizeRecipient(
      authorization,
      provider,
      grantOwnerApproval({
        approvedBy: "owner (test fixture)",
        scope: "data-recipient",
        acknowledgement: `test fixture approves ${provider}`,
        grantedAt: "2026-09-24T12:00:00.000Z",
      }),
    );
  }
  return authorization;
}

/** The router's decision for `tier` on `tierMap`. By default the Codex
 *  provider is out of usage, so each tier's first (Codex) rung is removed with
 *  a reason and the Claude rung wins. */
export function fixtureRoute(
  tier: RiskTier,
  tierMap: ResolvedTierMap = fixtureTierMap(),
  providerUsage: Readonly<Record<string, ProviderUsage>> = { "openai-codex": { state: "out-of-usage", detail: "fixture" } },
): TierRouteDecision {
  return routeTier({
    tier,
    tierMap,
    evidence: {
      providerUsage,
      catalog,
      estimatedPromptTokens: 20_000,
      allowance: NO_BUDGET_CONSTRAINT,
      authorization: authorizedFor(["anthropic", "openai-codex"]),
      banLists: OWNER_BAN_LISTS,
      modelScope: HARNESS_MODEL_SCOPE,
    },
  });
}

/** Every provider out of usage, so every tier from `tier` up empties. */
export function fixtureRefusal(tier: RiskTier, tierMap: ResolvedTierMap = fixtureTierMap()): TierRouteDecision {
  return fixtureRoute(tier, tierMap, {
    "openai-codex": { state: "out-of-usage", detail: "fixture" },
    anthropic: { state: "out-of-usage", detail: "fixture" },
  });
}
