import assert from "node:assert/strict";
import { test } from "node:test";
import { fixtureClassification, fixtureRefusal, fixtureRoute, fixtureTierMap, SONNET } from "../fixtures/routing-decision.ts";
import { buildAgentModelRecord, buildDecisionRecord, buildEditRecord, buildForkRecord, type RoutingRecord } from "../routing/decision-record.ts";
import type { RiskTier } from "../routing/classifier.ts";
import { delegationRouting, gateAction } from "./quality-gate.ts";

// The quality gate's decisions that the records settle (ADR 0010, ADR 0011).
// Seams: `gateAction` over a delegation's tier, and `delegationRouting` over
// the record folder's records, in file order.

test("at the medium gate level elevated and critical need a reviewer, mechanical and standard a spot check, and no tier counts as elevated", () => {
  const tiers: (RiskTier | undefined)[] = ["mechanical", "standard", "elevated", "critical", undefined];
  assert.deepEqual(tiers.map(gateAction), ["spot-check", "spot-check", "reviewer", "reviewer", "reviewer"]);
});

const AT = new Date("2026-09-28T10:00:00.000Z");

async function decision(delegationId: string, tier: RiskTier, overrides: { refused?: boolean; ranOn?: string; mode?: "shadow" } = {}) {
  const tierMap = fixtureTierMap();
  const route = overrides.refused ? fixtureRefusal(tier, tierMap) : fixtureRoute(tier, tierMap);
  const ranOn = overrides.ranOn ?? (route.ok ? route.rung.rung : `${SONNET}:medium`);
  const common = { delegationId, at: AT, taskText: "Fix it", agentRole: "worker", classification: await fixtureClassification("Fix it", tier), tierMap, route, ranOn };
  return buildDecisionRecord(overrides.mode === "shadow" ? { ...common, mode: "shadow", handPickedModel: SONNET } : { ...common, mode: "live" });
}

test("a routed delegation has its routed tier and the rung it ran on; a fork, an agent's named model and an unrouted worker have no tier", async () => {
  const records: RoutingRecord[] = [
    await decision("live", "elevated"),
    await decision("shadow", "standard", { mode: "shadow", ranOn: `${SONNET}:high` }),
    await decision("refused", "critical", { refused: true, ranOn: `${SONNET}:medium` }),
    buildForkRecord({ delegationId: "fork", model: SONNET, effort: "high", parentSession: "main", forkPoint: null, banListException: false, at: AT }),
    buildAgentModelRecord({ delegationId: "agent", agent: "scribe", definitionFile: "/agents/scribe.md", model: SONNET, effort: "low", at: AT }),
    buildEditRecord({ delegationId: "unrouted", orchestratorSession: "main", tool: "write", at: AT }),
  ];
  const live = records[0]!;
  assert.ok(live.recordType === "decision" && live.route.outcome === "chosen");
  assert.deepEqual(delegationRouting(records, "live"), { tier: "elevated", rung: { model: live.route.rung.model, effort: live.route.rung.effort } });
  // Shadow mode and a refusal ran on the session model, which the record names as ranOn.
  assert.deepEqual(delegationRouting(records, "shadow"), { tier: "standard", rung: { model: SONNET, effort: "high" } });
  assert.deepEqual(delegationRouting(records, "refused"), { tier: "critical", rung: { model: SONNET, effort: "medium" } });
  assert.deepEqual(delegationRouting(records, "fork"), { rung: { model: SONNET, effort: "high" } });
  assert.deepEqual(delegationRouting(records, "agent"), { rung: { model: SONNET, effort: "low" } });
  assert.deepEqual(delegationRouting(records, "unrouted"), {});
  assert.deepEqual(delegationRouting(records, "unknown"), {});
});

test("the latest decision of a delegation counts", async () => {
  const records = [await decision("twice", "mechanical"), await decision("twice", "critical")];
  assert.equal(delegationRouting(records, "twice").tier, "critical");
});
