import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { newTaskLedger, TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { FIXTURE_TIERS, fixtureClassification, fixtureTierMap } from "../fixtures/routing-decision.ts";
import { OWNER_BAN_LISTS } from "../fixtures/owner-ban-lists.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { loadClassifierChain } from "./tier-classifier.ts";
import { tierMapFromSettings, type ResolvedTierMap } from "./tier-map.ts";
import { DEFAULT_BAN_LISTS } from "../policy/ban-lists.ts";
import { HARNESS_MODEL_SCOPE } from "../policy/model-resolution.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval } from "../recipients/authorization.ts";
import { routeTask, type ActiveRouter } from "../router/route-task.ts";
import { usageObservationsPath } from "../router/usage-observations.ts";
import type { RoutingEvidence } from "../router/evidence.ts";

const NOW = new Date("2026-09-29T13:00:00.000Z");
const ANTHROPIC = "anthropic/claude-sonnet-5";
const OPUS_55 = "anthropic/claude-opus-5-5";
const CODEX = "openai-codex/gpt-6-luna";

function authorization() {
  let result = emptyAuthorization();
  for (const provider of ["anthropic", "openai-codex"]) {
    result = authorizeRecipient(result, provider, grantOwnerApproval({
      approvedBy: "owner (test fixture)",
      scope: "data-recipient",
      acknowledgement: `test approves ${provider}`,
      grantedAt: NOW.toISOString(),
    }));
  }
  return result;
}

function tierMapWithStandardRungs(standard: unknown): ResolvedTierMap {
  return fixtureTierMap({ orchestrator: { routing: { tiers: {
    mechanical: FIXTURE_TIERS.mechanical,
    standard,
    elevated: FIXTURE_TIERS.elevated,
    critical: FIXTURE_TIERS.critical,
  } } } }, undefined);
}

function tierMapWithElevatedRungs(elevated: readonly string[]): ResolvedTierMap {
  const solInfo = INSTALLED_MODEL_INFO.find((model) => model.fullId === "openai-codex/gpt-6-sol");
  assert.ok(solInfo);
  const sol61Info = { ...solInfo, id: "gpt-6-1-sol", fullId: "openai-codex/gpt-6-1-sol" };
  const map = tierMapFromSettings({ orchestrator: { routing: { tiers: {
    mechanical: FIXTURE_TIERS.mechanical,
    standard: FIXTURE_TIERS.standard,
    elevated,
    critical: ["openai-codex/gpt-6-1-sol:xhigh", `${OPUS_55}:high-xhigh`],
  } } } }, undefined, {
    installedModels: [...INSTALLED_MODEL_INFO, sol61Info],
    modelScope: HARNESS_MODEL_SCOPE,
    banLists: OWNER_BAN_LISTS,
  });
  assert.ok(map);
  return map;
}

function stateFolder(t: { after(callback: () => void): void }): string {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-low-usage-repro-"));
  mkdirSync(join(stateDir, "routing-records"));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  return stateDir;
}

function routerFor(stateDir: string, tierMap: ResolvedTierMap = tierMapWithStandardRungs([`${ANTHROPIC}:medium`, `${CODEX}:medium`])): ActiveRouter {
  const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS], now: NOW });
  const evidence: RoutingEvidence = {
    catalog,
    refreshState: emptyRefreshState(),
    authorization: authorization(),
  };
  return {
    mode: "live",
    tierMap,
    banLists: OWNER_BAN_LISTS ?? DEFAULT_BAN_LISTS,
    chain: loadClassifierChain({ model: `${CODEX}:low`, timeoutMs: 1_000, fallback: [] }),
    callModel: async () => "",
    evidence: () => evidence,
    owner: new TaskAllowanceOwner(newTaskLedger({ taskId: "low-usage-repro", allowanceUsd: 5 })),
    recordDir: join(stateDir, "routing-records"),
    usagePath: usageObservationsPath(stateDir),
    installedModels: INSTALLED_MODEL_INFO,
  };
}

function saveUsage(stateDir: string, anthropic: { percentLeft: number; observedAt?: string; resetsAt?: string } = { percentLeft: 5 },
  codexPercentLeft = 92): void {
  const observedAt = anthropic.observedAt ?? NOW.toISOString();
  writeFileSync(usageObservationsPath(stateDir), JSON.stringify({
    schemaVersion: "usage-observations/1",
    providers: {
      anthropic: { state: anthropic.percentLeft < 10 ? "low" : "available", percentLeft: anthropic.percentLeft,
        resetsAt: anthropic.resetsAt ?? "2026-09-30T00:00:00.000Z", observedAt, source: "header" },
      "openai-codex": { state: codexPercentLeft < 10 ? "low" : "available", percentLeft: codexPercentLeft,
        resetsAt: "2026-09-30T00:00:00.000Z", observedAt: NOW.toISOString(), source: "header" },
    },
  }));
}

async function routeAtTier(stateDir: string, tier: "standard" | "elevated", tierMap?: ResolvedTierMap) {
  const task = "Inspect the implementation";
  return routeTask(routerFor(stateDir, tierMap), task, await fixtureClassification(task, tier), NOW);
}

const routeStandard = (stateDir: string, tierMap?: ResolvedTierMap) => routeAtTier(stateDir, "standard", tierMap);

test("a balanced worker tier routes away from first-listed Anthropic at 5% left when Codex has 92% left", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir);

  const result = await routeStandard(stateDir);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, CODEX);
  assert.deepEqual(result.route.lowUsageProviders, ["anthropic"]);
  assert.equal(result.providerUsage.anthropic, undefined, "low usage is a weight, not a hard exclusion");
});

test("a balanced tier considers greater effective weekly headroom, not just the low-usage threshold", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir, { percentLeft: 77 }, 100);
  const map = tierMapWithStandardRungs([`${ANTHROPIC}:medium`, `${CODEX}:medium`]);

  const result = await routeStandard(stateDir, map);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, CODEX);
  assert.deepEqual(result.route.providerPercentLeft, { anthropic: 77, "openai-codex": 100 });
});

test("missing usage observations leave the first-listed provider eligible to win", async (t) => {
  const stateDir = stateFolder(t);

  const result = await routeStandard(stateDir);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, ANTHROPIC);
  assert.equal(result.route.lowUsageProviders, undefined);
});

test("usage observations older than five hours no longer weight Anthropic down", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir, { percentLeft: 5, observedAt: "2026-09-29T07:59:59.000Z" });

  const result = await routeStandard(stateDir);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, ANTHROPIC);
  assert.equal(result.route.lowUsageProviders, undefined);
});

test("equal 10% headroom is not low and preserves list order", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir, { percentLeft: 10 }, 10);

  const result = await routeStandard(stateDir);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, ANTHROPIC);
  assert.equal(result.route.lowUsageProviders, undefined);
});

test("an ordered tier chooses its first-listed Claude rung despite low usage", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir);
  const map = tierMapWithStandardRungs({ order: "ordered", rungs: [`${ANTHROPIC}:medium`, `${CODEX}:medium`] });

  const result = await routeStandard(stateDir, map);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, ANTHROPIC);
  assert.equal(result.route.tierOrder, "ordered");
});

test("a balanced tier with only a Claude rung still selects that low-usage provider", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir);
  const map = tierMapWithStandardRungs([`${ANTHROPIC}:medium`]);

  const result = await routeStandard(stateDir, map);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, ANTHROPIC);
  assert.deepEqual(result.route.lowUsageProviders, ["anthropic"]);
});

test("the configured gpt-6-1-sol elevated rung is dropped before low-usage balancing", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir);
  const map = tierMapWithElevatedRungs(["openai-codex/gpt-6-1-sol:high", `${OPUS_55}:low-high`]);

  const result = await routeAtTier(stateDir, "elevated", map);

  assert.deepEqual(map.tiers.elevated.map((rung) => rung.model), [OPUS_55]);
  assert.ok(map.drops.some((drop) => "rung" in drop && drop.rung === "openai-codex/gpt-6-1-sol:high" && drop.reason === "allowed-model list"));
  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, "anthropic/claude-opus-5-5");
  assert.deepEqual(result.route.lowUsageProviders, ["anthropic"]);
});

test("an allowed Codex elevated rung wins when Anthropic is low", async (t) => {
  const stateDir = stateFolder(t);
  saveUsage(stateDir);
  const map = tierMapWithElevatedRungs(["openai-codex/gpt-6-sol:high", `${OPUS_55}:low-high`]);

  const result = await routeAtTier(stateDir, "elevated", map);

  assert.equal(result.route.ok, true);
  if (!result.route.ok) return;
  assert.equal(result.route.rung.model, "openai-codex/gpt-6-sol");
  assert.deepEqual(result.route.lowUsageProviders, ["anthropic"]);
});
