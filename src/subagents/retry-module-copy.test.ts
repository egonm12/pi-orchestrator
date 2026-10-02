import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { TaskAllowanceOwner } from "../budget/task-allowance.ts";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { emptyRefreshState } from "../catalog/refresh-lifecycle.ts";
import { INSTALLED_MODEL_INFO } from "../fixtures/installed-model-info.ts";
import { DEFAULT_BAN_LISTS } from "../policy/ban-lists.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval } from "../recipients/authorization.ts";
import type { RiskTier } from "../routing/tiers.ts";
import type { RoutingRecord } from "../routing/decision-record.ts";
import type { ResolvedTierMap, TierRung } from "../routing/tier-map.ts";
import type { ActiveRouter } from "../router/route-task.ts";
import { planRetry } from "./retry.ts";

// A retry climbs through the router the router extension published
// (../router/orchestrator-router.ts). pi loads each extension as its own
// module copy (jiti moduleCache: false), so that router, and the
// TaskAllowanceOwner in it, come from a copy of the router modules other than
// the one this extension imports. This test loads the router's side the way
// pi does, with jiti, and plans the retry from its own copy of ./retry.ts.
// Delegation 01a0f15e-cb29-7106-9001-701f831629b4 was retried unplaced
// ("its rung ... has no position in the elevated tier") because the climb ran
// in the subagents copy, whose allowanceConstraint rejected the owner.

/** jiti, as pi's extension loader depends on it. */
const { createJiti } = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"))("jiti") as {
  createJiti(id: string, options: { moduleCache: boolean; fsCache: boolean }): { import(id: string): Promise<unknown> };
};
type RouterCopy = typeof import("../fixtures/router-module-copy.ts");
/** A fresh copy of the router modules, loaded as pi loads an extension. */
async function routerCopy(): Promise<RouterCopy> {
  const jiti = createJiti(import.meta.url, { moduleCache: false, fsCache: false });
  return await jiti.import(`${new URL("../fixtures/router-module-copy.ts", import.meta.url).pathname}`) as RouterCopy;
}

const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai-codex/gpt-6-sol";
const NOW = new Date("2026-09-30T08:35:29.000Z");
const rung = (model: string, effort: TierRung["effort"]): TierRung => ({ rung: `${model}:${effort}`, model, effort, origin: "personal" });
/** The elevated tier as the failed attempt's decision record named it. */
const TIER_MAP: ResolvedTierMap = {
  tiers: { mechanical: [], standard: [], elevated: [rung(SOL, "high"), rung(OPUS, "medium")], critical: [rung(OPUS, "xhigh")] } as Record<RiskTier, TierRung[]>,
  orders: { mechanical: "balanced", standard: "balanced", elevated: "balanced", critical: "balanced" },
  drops: [], ignoredProjectKeys: [],
};
const FAILED_ID = "01a0f15e-cb29-7106-9001-701f831629b4";

function approvedAnthropic() {
  const approval = grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: "send delegation data to anthropic" });
  return authorizeRecipient(emptyAuthorization(), "anthropic", approval);
}

const stateDirs: string[] = [];
after(() => { for (const dir of stateDirs) rmSync(dir, { recursive: true, force: true }); });

/** The orchestrator's router as the router extension's copy builds it, with its owner. */
function routerFrom(copy: RouterCopy, overrides: Partial<ActiveRouter> = {}): ActiveRouter {
  const stateDir = mkdtempSync(join(tmpdir(), "pi-retry-module-copy-"));
  stateDirs.push(stateDir);
  const owner = new copy.TaskAllowanceOwner(copy.newTaskLedger({ taskId: "router-session:orchestrator" })) as unknown as TaskAllowanceOwner;
  return {
    mode: "live", tierMap: TIER_MAP, banLists: DEFAULT_BAN_LISTS, chain: undefined as never, callModel: undefined as never,
    evidence: () => ({ catalog: buildCatalog({ modelIds: [OPUS, SOL], now: NOW }), refreshState: emptyRefreshState(), authorization: approvedAnthropic() }),
    owner, recordDir: join(stateDir, "routing"), usagePath: join(stateDir, "usage-observations.json"), installedModels: INSTALLED_MODEL_INFO,
    ...overrides,
  };
}

/** The failed attempt's decision record, as far as the ladder reads it: it ran on `failed` in the elevated tier. */
function failedAttempt(failed: TierRung): RoutingRecord {
  return { recordType: "decision", delegationId: FAILED_ID, classification: { kindOfWork: "implement" },
    route: { outcome: "chosen", tier: "elevated", rung: failed } } as unknown as RoutingRecord;
}

/** Plans the retry of the failed attempt on `failed`, from this module copy, after `copy` published `router`. */
function planWith(copy: RouterCopy, sessionId: string, router: ActiveRouter, failed: TierRung) {
  copy.publishOrchestratorRouter(sessionId, router);
  try { return planRetry(sessionId, FAILED_ID, [failedAttempt(failed)], `Retry of delegation ${FAILED_ID}`, NOW); }
  finally { copy.publishOrchestratorRouter(sessionId, undefined); }
}

test("a retry climbs through the router another module copy published: opus-5-5:medium is placed on opus-5-5:high", async () => {
  const copy = await routerCopy();
  const plan = planWith(copy, "orchestrator-placed", routerFrom(copy), rung(OPUS, "medium"));
  assert.equal(plan.kind, "placed", JSON.stringify(plan));
  assert.ok(plan.kind === "placed");
  assert.deepEqual([plan.choice.step, plan.choice.tier, plan.choice.rung.rung, plan.climb], ["effort", "elevated", `${OPUS}:high`, 1]);
});

test("a failed rung the tier map does not list is retried unplaced, as having no position", async () => {
  const copy = await routerCopy();
  const plan = planWith(copy, "orchestrator-no-position", routerFrom(copy), rung("anthropic/claude-haiku-4-5", "medium"));
  assert.deepEqual(plan, { kind: "unplaced", mode: "live", climb: 1,
    why: "its rung anthropic/claude-haiku-4-5:medium has no position in the elevated tier of the tier map" });
});

test("any other failure of the climb is reported with its own message, never as having no position", async () => {
  const copy = await routerCopy();
  const router = routerFrom(copy, { evidence: () => { throw new Error("the evidence store is unreadable"); } });
  const plan = planWith(copy, "orchestrator-failing", router, rung(OPUS, "medium"));
  assert.equal(plan.kind, "unplaced", JSON.stringify(plan));
  assert.ok(plan.kind === "unplaced");
  assert.ok(!plan.why.includes("no position"), plan.why);
  assert.equal(plan.why, "the effort ladder failed: the evidence store is unreadable");
});
