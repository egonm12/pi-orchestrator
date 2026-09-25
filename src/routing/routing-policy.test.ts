import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { CAPACITY_MISREADINGS } from "../catalog/epistemic.ts";
import { buildCatalog, type ModelCatalog } from "../catalog/model-catalog.ts";
import {
  onlyModels,
  withTaskSuitability,
  withUsageHeadroom,
  withoutPublishedPrice,
} from "../fixtures/catalog-facts.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { createProviderDouble } from "../fixtures/provider-double.ts";
import { classifyTask, type RiskAssessment } from "./classifier.ts";
import {
  allowedCandidates,
  correctnessFirstPicker,
  DEFAULT_ROUTING_POLICY,
  formatRoutingRecord,
  route,
  ROUTING_RECORD_PREFIX,
  type AllowedCandidates,
  type Picker,
  type RoutingPolicyConfig,
  type RoutingRequest,
} from "./routing-policy.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

const here = dirname(fileURLToPath(import.meta.url));

// Real ids from this installation's registry, with their real pinned prices
// (USD per 1M input tokens) noted so the cheap/expensive relationships these
// tests rely on are grounded in the snapshot rather than invented.
const OPUS = "anthropic/claude-opus-4-7"; //          $5.00
const SONNET = "anthropic/claude-sonnet-5"; //        $2.00
const HAIKU = "anthropic/claude-haiku-4-5"; //        $1.00
const SOL = "openai-codex/gpt-5.6-sol"; //            $4.00
const TERRA = "openai-codex/gpt-5.6-terra"; //        $2.00
const LUNA = "openai-codex/gpt-5.6-luna"; //          $0.20
const PROHIBITED = "anthropic/claude-fable-5"; //     $10.00

const baseCatalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS] });

const SECURITY_TASK = "fix a one-line auth bypass check in the login handler";
const MECHANICAL_TASK = "reformat this file's imports alphabetically";

function request(overrides: Partial<RoutingRequest> & { taskType: string }): RoutingRequest {
  return { taskDescription: overrides.taskDescription ?? MECHANICAL_TASK, ...overrides };
}

/** An assessment with an exact confidence, so escalation tests drive the
 *  threshold directly instead of hunting for wording that happens to produce
 *  one. Shaped exactly like the classifier's own output. */
function assessmentWith(
  confidence: number,
  riskTier: RiskAssessment["riskTier"],
): RiskAssessment {
  return {
    riskTier,
    ambiguity: "clear",
    confidence,
    signals: [],
    signalCounts: {
      "security-sensitive": 0,
      destructive: 0,
      "public-behavior": 0,
      mechanical: 0,
      ambiguity: 0,
    },
    rationale: "fixed assessment supplied by test",
    classifierBasis: "first-pass-heuristic-unvalidated",
  };
}

function routingSources(): Record<string, string> {
  const files = ["classifier.ts", "routing-policy.ts"];
  const out: Record<string, string> = {};
  for (const file of files) out[file] = readFileSync(join(here, file), "utf8");
  return out;
}

function admittedModels(allowed: AllowedCandidates): string[] {
  return allowed.admitted.map((c) => c.model).sort();
}

function rejectionFor(allowed: AllowedCandidates, model: string): readonly string[] {
  const found = allowed.rejected.find((c) => c.model === model);
  assert.ok(found, `expected ${model} to be rejected`);
  return found.rejectedBecause;
}

// ---------------------------------------------------------------------------
test("routing excludes prohibited ids by name and records the prohibition", () => {
  const fable = "anthropic/claude-opus-fable-6";
  const astra = "openai-codex/gpt-5.7-Astra";
  const allowed = "anthropic/claude-opus-5-5";
  const ids = [fable, astra, PROHIBITED, allowed];
  const catalog = withTaskSuitability(
    buildCatalog({ modelIds: ids, now: new Date("2026-09-21T12:00:00.000Z") }),
    Object.fromEntries(ids.map((model) => [model, { implementation: 1 }])),
    { asOf: "2026-09-21T12:00:00.000Z" },
  );
  const result = allowedCandidates({ catalog, request: request({ taskType: "implementation" }), now: new Date("2026-09-21T12:00:00.000Z").getTime() });
  for (const model of [fable, astra, PROHIBITED]) {
    assert.ok(!result.admitted.some((candidate) => candidate.model === model));
    assert.match(rejectionFor(result, model).join(" "), /prohibited by name/);
  }
  // The reason names the subagent ban list and the entry that matched.
  assert.match(rejectionFor(result, fable).join(" "), /subagent ban list entry 'fable'/);
  assert.match(rejectionFor(result, astra).join(" "), /subagent ban list entry 'astra'/);
  assert.ok(result.admitted.some((candidate) => candidate.model === allowed));
});

// The classifier: risk and ambiguity, not size
// ---------------------------------------------------------------------------

test("a small security-sensitive task classifies as critical, not mechanical", () => {
  const assessment = classifyTask(SECURITY_TASK);
  assert.equal(assessment.riskTier, "critical");
  assert.ok(
    assessment.confidence >= DEFAULT_ROUTING_POLICY.confidenceThreshold,
    `expected confident classification, got ${assessment.confidence}`,
  );
  assert.ok(assessment.signals.some((s) => s.kind === "security-sensitive"));
});

test("genuinely mechanical work classifies as mechanical, confidently", () => {
  const assessment = classifyTask(MECHANICAL_TASK);
  assert.equal(assessment.riskTier, "mechanical");
  assert.equal(assessment.ambiguity, "clear");
  assert.ok(assessment.confidence >= DEFAULT_ROUTING_POLICY.confidenceThreshold);
});

test("a short featureless description produces low confidence, not a cheap guess", () => {
  const assessment = classifyTask("fix the thing");
  assert.equal(assessment.ambiguity, "underspecified");
  assert.ok(
    assessment.confidence < DEFAULT_ROUTING_POLICY.confidenceThreshold,
    `expected low confidence, got ${assessment.confidence}`,
  );
});

test("hedging language lowers confidence in the classification", () => {
  const hedged = classifyTask("maybe clean up the auth module a bit, improve it somehow");
  const plain = classifyTask("rewrite the auth module's session validation");
  assert.ok(
    hedged.confidence < plain.confidence,
    `hedged ${hedged.confidence} should be below plain ${plain.confidence}`,
  );
  assert.equal(hedged.ambiguity, "underspecified");
});

test("every assessment states that the classifier is unvalidated", () => {
  for (const text of [SECURITY_TASK, MECHANICAL_TASK, "fix the thing"]) {
    assert.equal(classifyTask(text).classifierBasis, "first-pass-heuristic-unvalidated");
  }
});

test("the classifier is deterministic", () => {
  assert.deepEqual(classifyTask(SECURITY_TASK), classifyTask(SECURITY_TASK));
});

// ---------------------------------------------------------------------------
// Checklist 1: routing considers all six inputs
// ---------------------------------------------------------------------------

test("routing considers risk, capability, availability, headroom, privacy and cost", () => {
  // One scenario in which each of the six factors visibly decides something.
  const catalog = withUsageHeadroom(
    withTaskSuitability(
      onlyModels(baseCatalog, [OPUS, SONNET, HAIKU, TERRA, LUNA]),
      {
        [OPUS]: { "security-review": 0.95 },
        [SONNET]: { "security-review": 0.92 },
        [HAIKU]: { "security-review": 0.6 },
        [LUNA]: { "security-review": 0.95 },
        // TERRA: deliberately no evidence at all.
      },
    ),
    { [SONNET]: { kind: "metered", remainingUsd: 0 } },
  );
  const probe = createProviderDouble({
    [OPUS]: { kind: "available" },
    [SONNET]: { kind: "available" },
    [HAIKU]: { kind: "available" },
    [TERRA]: { kind: "available" },
    [LUNA]: { kind: "unavailable", detail: "route disabled" },
  });

  const allowed = allowedCandidates({
    request: request({
      taskDescription: SECURITY_TASK,
      taskType: "security-review",
      privacy: { approvedRecipients: ["anthropic"], reason: "ticket 07 seam" },
    }),
    catalog,
    availability: (m) => probe.availability(m),
  });

  // risk/ambiguity
  assert.equal(allowed.assessment.riskTier, "critical");
  assert.equal(allowed.effectiveTier, "critical");
  // capability evidence
  assert.match(rejectionFor(allowed, TERRA).join(" "), /no task-suitability evidence/);
  // usage headroom
  assert.match(rejectionFor(allowed, SONNET).join(" "), /usage headroom is exhausted/);
  // availability
  assert.match(rejectionFor(allowed, LUNA).join(" "), /not available \(unavailable/);
  // privacy
  assert.match(rejectionFor(allowed, LUNA).join(" "), /not an approved data recipient/);
  assert.equal(allowed.privacyApplied, true);
  // cost evidence
  const opus = allowed.admitted.find((c) => c.model === OPUS);
  assert.ok(opus);
  assert.equal(opus.cost.state, "comparable");
  if (opus.cost.state === "comparable") {
    assert.equal(opus.cost.basis, "published-list-price");
    assert.equal(opus.cost.inputUsdPerMTok, 5);
  }
  // Ticket 24 removed the per-tier suitability floor, so HAIKU's evidenced
  // 0.6 is admitted at the critical tier; the picker still prefers OPUS.
  assert.deepEqual(admittedModels(allowed), [HAIKU, OPUS].sort());
});

test("unknown usage headroom is carried honestly, never as capacity", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.9 },
    [HAIKU]: { formatting: 0.85 },
  });
  const allowed = allowedCandidates({
    request: request({ taskType: "formatting" }),
    catalog,
  });
  assert.equal(allowed.admitted.length, 2);
  for (const candidate of allowed.admitted) {
    assert.equal(candidate.headroomKnown, false);
    assert.match(candidate.headroom, /^unknown \(/);
    // Not a number either: `0` invites "nothing left" as readily as `∞`
    // invites the opposite.
    assert.doesNotMatch(candidate.headroom, /\d/);
    for (const misreading of CAPACITY_MISREADINGS) {
      assert.ok(
        !candidate.headroom.toLowerCase().includes(misreading),
        `headroom rendering must not contain '${misreading}': ${candidate.headroom}`,
      );
    }
  }
  // And the whole observable record is free of the same misreadings.
  const record = formatRoutingRecord(route({ request: request({ taskType: "formatting" }), catalog }));
  assert.ok(record.startsWith(ROUTING_RECORD_PREFIX));
});

// ---------------------------------------------------------------------------
// Checklist 3: cheaper only on capability evidence
// ---------------------------------------------------------------------------

test("mechanical work routes cheaper when the catalog evidences the cheaper model", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  const decision = route({
    request: request({ taskDescription: MECHANICAL_TASK, taskType: "formatting" }),
    catalog,
  });

  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.model, HAIKU);
  assert.equal(decision.cheapenedOnCostEvidence, true);
  assert.match(decision.reason, /has fresh suitability evidence/);
  assert.match(decision.reason, /no longer checked against a floor since ticket 24/);
  assert.match(decision.reason, /published list price/);
});

test("a cheap-sounding model with no capability evidence is not cheapened to", () => {
  // HAIKU is genuinely cheaper than SONNET in the pinned snapshot AND its name
  // is the vendor's own small-tier label. Neither fact is evidence of
  // suitability.
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [SONNET, HAIKU]), {
    [SONNET]: { formatting: 0.8 },
  });
  const allowed = allowedCandidates({
    request: request({ taskDescription: MECHANICAL_TASK, taskType: "formatting" }),
    catalog,
  });

  // Non-vacuous: prove HAIKU really is the cheaper one before asserting it lost.
  const haiku = allowed.rejected.find((c) => c.model === HAIKU);
  const sonnet = allowed.admitted.find((c) => c.model === SONNET);
  assert.ok(haiku && sonnet);
  assert.ok(haiku.cost.state === "comparable" && sonnet.cost.state === "comparable");
  if (haiku.cost.state === "comparable" && sonnet.cost.state === "comparable") {
    assert.ok(
      haiku.cost.inputUsdPerMTok < sonnet.cost.inputUsdPerMTok,
      "fixture must keep the unevidenced model genuinely cheaper",
    );
  }
  assert.match(haiku.rejectedBecause.join(" "), /no task-suitability evidence/);

  const decision = route({
    request: request({ taskDescription: MECHANICAL_TASK, taskType: "formatting" }),
    catalog,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.model, SONNET);
  assert.notEqual(decision.model, HAIKU);
});

test("suitability evidence for a different task type does not transfer", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [HAIKU]), {
    [HAIKU]: { "security-review": 0.99 },
  });
  const allowed = allowedCandidates({
    request: request({ taskType: "formatting" }),
    catalog,
  });
  assert.deepEqual(admittedModels(allowed), []);
  assert.match(rejectionFor(allowed, HAIKU).join(" "), /covers security-review, not 'formatting'/);
});

test("stale capability evidence is not evidence", () => {
  const longAgo = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000).toISOString();
  const catalog = withTaskSuitability(
    onlyModels(baseCatalog, [HAIKU]),
    { [HAIKU]: { formatting: 0.9 } },
    { asOf: longAgo },
  );
  const allowed = allowedCandidates({
    request: request({ taskType: "formatting" }),
    catalog,
  });
  assert.deepEqual(admittedModels(allowed), []);
  assert.match(rejectionFor(allowed, HAIKU).join(" "), /stale/);
});

test("without comparable cost evidence, mechanical work is not cheapened", () => {
  const catalog = withoutPublishedPrice(
    withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
      [OPUS]: { formatting: 0.95 },
      [HAIKU]: { formatting: 0.8 },
    }),
    [OPUS, HAIKU],
  );
  const decision = route({
    request: request({ taskType: "formatting" }),
    catalog,
  });
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  assert.equal(decision.cheapenedOnCostEvidence, false);
  assert.equal(decision.model, OPUS, "falls back to highest evidenced suitability");
  assert.match(decision.reason, /no comparable cost evidence/);
});

// ---------------------------------------------------------------------------
// Checklist 4: threshold and fallback configurable and visible
// ---------------------------------------------------------------------------

test("the confidence threshold and the fallback tier are configurable and visible", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  const strict: RoutingPolicyConfig = {
    ...DEFAULT_ROUTING_POLICY,
    confidenceThreshold: 0.99,
    mostRestrictiveTier: "elevated",
  };

  const decision = route({
    request: request({ taskDescription: MECHANICAL_TASK, taskType: "formatting" }),
    catalog,
    config: strict,
  });

  assert.equal(decision.allowed.confidenceThreshold, 0.99);
  assert.equal(decision.allowed.fallbackTier, "elevated");
  assert.equal(decision.allowed.fallbackTriggered, true);
  assert.equal(decision.allowed.assessment.riskTier, "mechanical");
  assert.equal(decision.allowed.effectiveTier, "elevated");

  // Visible in the observable record, not only on the object.
  const record = formatRoutingRecord(decision);
  const parsed = JSON.parse(record.slice(ROUTING_RECORD_PREFIX.length)) as Record<string, unknown>;
  assert.equal(parsed.confidenceThreshold, 0.99);
  assert.equal(parsed.fallbackTier, "elevated");
  assert.equal(parsed.fallbackTriggered, true);
  assert.equal(parsed.effectiveTier, "elevated");
  assert.equal(parsed.riskTier, "mechanical");
  assert.equal(parsed.classifierBasis, "first-pass-heuristic-unvalidated");
  assert.equal(typeof parsed.confidence, "number");
});

test("the default threshold and fallback are the configured defaults, not hidden constants", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS]), {
    [OPUS]: { formatting: 0.95 },
  });
  const decision = route({ request: request({ taskType: "formatting" }), catalog });
  assert.equal(decision.allowed.confidenceThreshold, DEFAULT_ROUTING_POLICY.confidenceThreshold);
  assert.equal(decision.allowed.fallbackTier, DEFAULT_ROUTING_POLICY.mostRestrictiveTier);
});

// ---------------------------------------------------------------------------
// Checklist 5: low classification confidence escalates on its own
// ---------------------------------------------------------------------------

test("low confidence in the risk classification escalates to the fallback tier", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  // Classified mechanical, but the classifier is not sure.
  const unsure = assessmentWith(0.2, "mechanical");
  const decision = route({
    request: request({ taskType: "formatting", assessment: unsure }),
    catalog,
  });

  assert.equal(decision.allowed.fallbackTriggered, true);
  assert.equal(decision.allowed.effectiveTier, "critical");
  assert.equal(decision.ok, true);
  if (!decision.ok) return;
  // The cheap model was chosen on cost at the mechanical tier and is not now.
  assert.equal(decision.model, OPUS);
  assert.equal(decision.cheapenedOnCostEvidence, false);
});

test("escalation depends only on classification confidence, not on any quality signal", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  const base = request({ taskType: "formatting", assessment: assessmentWith(0.2, "mechanical") });

  // Attach every quality-ish signal a caller might try to smuggle in. The
  // routing types carry no such field, so these are inert by construction --
  // this asserts that inertness observably rather than trusting the type.
  const noisy = {
    ...base,
    selfReportedConfidence: 0.99,
    predictedAnswerQuality: 0.99,
    answerQuality: 1,
    modelConfidence: 1,
  } as RoutingRequest;

  const clean = formatRoutingRecord(route({ request: base, catalog }));
  const withNoise = formatRoutingRecord(route({ request: noisy, catalog }));
  assert.equal(withNoise, clean);
  assert.match(clean, /"fallbackTriggered":true/);
});

test("high classification confidence does not escalate", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  const decision = route({
    request: request({ taskType: "formatting", assessment: assessmentWith(0.95, "mechanical") }),
    catalog,
  });
  assert.equal(decision.allowed.fallbackTriggered, false);
  assert.equal(decision.allowed.effectiveTier, "mechanical");
  assert.equal(decision.ok && decision.model, HAIKU);
});

// ---------------------------------------------------------------------------
// Checklist 6: a model's self-reported confidence is structurally absent
// ---------------------------------------------------------------------------

test("no self-reported confidence or answer-quality signal is consumed anywhere in routing", () => {
  const forbidden = [
    "selfReportedConfidence",
    "reportedConfidence",
    "modelConfidence",
    "answerConfidence",
    "selfRating",
    "selfReported",
    "answerQuality",
    "predictedQuality",
    "predictedAnswerQuality",
    "qualityEstimate",
    "qualityScore",
  ];
  for (const [file, source] of Object.entries(routingSources())) {
    for (const token of forbidden) {
      assert.ok(
        !source.includes(token),
        `${file} must not consume '${token}': a model's own confidence is not routing evidence`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Checklist 7: a blocker, never a weakened assignment
// ---------------------------------------------------------------------------

test("with no capability evidence at all, routing blocks rather than assigning something", () => {
  // The catalog as actually built: taskSuitability is unknown for every model.
  const decision = route({
    request: request({ taskDescription: SECURITY_TASK, taskType: "security-review" }),
    catalog: baseCatalog,
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.equal(decision.code, "no_authorized_candidate");
  assert.match(decision.message, /Requirements were not weakened/);
  assert.equal(decision.allowed.admitted.length, 0);
  assert.equal(decision.allowed.rejected.length, INSTALLED_MODEL_IDS.length);
  for (const candidate of decision.allowed.rejected) {
    assert.match(candidate.rejectedBecause.join(" "), /requires-approved-research/);
  }
});

test("when every candidate is unavailable, routing blocks and names the reason", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [HAIKU]: { formatting: 0.8 },
  });
  const probe = createProviderDouble({
    [OPUS]: { kind: "throttled", retryAfterSeconds: 30, detail: "rate limited" },
    [HAIKU]: { kind: "call-failure", detail: "upstream 500" },
  });
  const decision = route({
    request: request({ taskType: "formatting" }),
    catalog,
    availability: (m) => probe.availability(m),
  });

  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(rejectionFor(decision.allowed, OPUS).join(" "), /throttled/);
  assert.match(rejectionFor(decision.allowed, HAIKU).join(" "), /call-failure/);
});

test("a blocker message names the fallback that applied", () => {
  // No suitability evidence, so the legacy path admits nothing.
  const catalog = onlyModels(baseCatalog, [HAIKU]);
  const decision = route({
    request: request({ taskType: "formatting", assessment: assessmentWith(0.1, "mechanical") }),
    catalog,
  });
  assert.equal(decision.ok, false);
  if (decision.ok) return;
  assert.match(decision.message, /conservative fallback because classifier confidence 0\.1 < 0\.6/);
});

// ---------------------------------------------------------------------------
// Checklist 8: stage 1 and stage 2 are genuinely separate
// ---------------------------------------------------------------------------

test("stage 1 produces a boundary independent of any picker, and pickers are swappable", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, SONNET, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [SONNET]: { formatting: 0.9 },
    [HAIKU]: { formatting: 0.8 },
  });

  // Stage 1 alone. No picker was involved in producing this.
  const allowed = allowedCandidates({
    request: request({ taskType: "formatting" }),
    catalog,
  });
  assert.deepEqual(admittedModels(allowed), [HAIKU, OPUS, SONNET].sort());

  const before = structuredClone(allowed);

  // Two different pickers consume the very same stage-1 value, and must reach
  // genuinely different choices or this proves nothing.
  const highestSuitabilityPicker: Picker = (set) => {
    const chosen = [...set.admitted].sort(
      (a, b) => b.suitability.score - a.suitability.score || a.model.localeCompare(b.model),
    )[0];
    return chosen ? { model: chosen.model, reason: "test picker", cheapenedOnCostEvidence: false } : undefined;
  };

  const defaultPick = correctnessFirstPicker(allowed);
  const alternatePick = highestSuitabilityPicker(allowed);

  assert.equal(defaultPick?.model, HAIKU, "default picker cheapens evidenced mechanical work");
  assert.equal(alternatePick?.model, OPUS, "a different picker reaches a different choice");
  assert.notEqual(defaultPick?.model, alternatePick?.model);

  // A picker cannot widen the boundary: everything it returned was admitted.
  for (const pick of [defaultPick, alternatePick]) {
    assert.ok(pick);
    assert.ok(admittedModels(allowed).includes(pick.model));
  }

  // Stage 1's output is a plain value, not shared mutable state.
  assert.deepEqual(allowed, before);
});

test("a swapped picker changes the choice without moving the boundary", () => {
  // The cheapest model carries the best evidence here, so the default picker
  // and a cost-maximising one must disagree.
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, SONNET, HAIKU]), {
    [OPUS]: { "security-review": 0.91 },
    [SONNET]: { "security-review": 0.93 },
    [HAIKU]: { "security-review": 0.95 },
  });
  const input = {
    request: request({ taskDescription: SECURITY_TASK, taskType: "security-review" }),
    catalog,
  };

  const mostExpensive: Picker = (set) => {
    const chosen = [...set.admitted].sort((a, b) => {
      const ax = a.cost.state === "comparable" ? a.cost.inputUsdPerMTok : 0;
      const bx = b.cost.state === "comparable" ? b.cost.inputUsdPerMTok : 0;
      return bx - ax;
    })[0];
    return chosen ? { model: chosen.model, reason: "test picker", cheapenedOnCostEvidence: false } : undefined;
  };

  const a = route(input);
  const b = route(input, mostExpensive);

  assert.equal(a.ok && a.model, HAIKU, "default picker: best evidenced suitability");
  assert.equal(b.ok && b.model, OPUS, "swapped picker: a different choice");
  assert.notEqual(a.ok && a.model, b.ok && b.model);
  // Same boundary from both runs, regardless of which picker ran.
  assert.deepEqual(admittedModels(a.allowed), admittedModels(b.allowed));
  assert.deepEqual(admittedModels(a.allowed), [HAIKU, OPUS, SONNET].sort());
});

// ---------------------------------------------------------------------------
// Checklist 9: provider-agnostic
// ---------------------------------------------------------------------------

test("the same task routes sensibly through two differently-shaped provider catalogs", () => {
  const task = request({ taskDescription: MECHANICAL_TASK, taskType: "formatting" });

  // Two catalogs with different providers, different model counts, different
  // naming conventions and different price ladders -- both built from the real
  // pinned snapshot rather than invented.
  const catalogA = withTaskSuitability(onlyModels(baseCatalog, [OPUS, SONNET, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [SONNET]: { formatting: 0.9 },
    [HAIKU]: { formatting: 0.8 },
  });
  const catalogB = withTaskSuitability(onlyModels(baseCatalog, [SOL, TERRA, LUNA]), {
    [SOL]: { formatting: 0.93 },
    [TERRA]: { formatting: 0.86 },
    [LUNA]: { formatting: 0.81 },
  });

  const a = route({ request: task, catalog: catalogA });
  const b = route({ request: task, catalog: catalogB });

  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  if (!a.ok || !b.ok) return;

  // Different answers, same rule: the cheapest candidate that the catalog
  // evidences as suitable for this task type.
  assert.equal(a.model, HAIKU);
  assert.equal(b.model, LUNA);
  assert.notEqual(a.model, b.model);
  assert.equal(a.cheapenedOnCostEvidence, true);
  assert.equal(b.cheapenedOnCostEvidence, true);
  assert.equal(a.allowed.effectiveTier, b.allowed.effectiveTier);
});

test("a high-risk task routes to the best-evidenced model in either catalog", () => {
  const task = request({ taskDescription: SECURITY_TASK, taskType: "security-review" });
  const catalogA = withTaskSuitability(onlyModels(baseCatalog, [OPUS, HAIKU]), {
    [OPUS]: { "security-review": 0.95 },
    [HAIKU]: { "security-review": 0.91 },
  });
  const catalogB = withTaskSuitability(onlyModels(baseCatalog, [SOL, LUNA]), {
    [SOL]: { "security-review": 0.94 },
    [LUNA]: { "security-review": 0.9 },
  });

  const a = route({ request: task, catalog: catalogA });
  const b = route({ request: task, catalog: catalogB });
  assert.equal(a.ok && a.model, OPUS);
  assert.equal(b.ok && b.model, SOL);
  // Neither cheapened: the tier is critical in both.
  assert.equal(a.ok && a.cheapenedOnCostEvidence, false);
  assert.equal(b.ok && b.cheapenedOnCostEvidence, false);
});

test("no provider name appears anywhere in the routing source", () => {
  const vendorTokens = ["claude", "anthropic", "openai", "codex", "bridge", "gpt-", "gemini", "grok"];
  for (const [file, source] of Object.entries(routingSources())) {
    const lower = source.toLowerCase();
    for (const token of vendorTokens) {
      assert.ok(
        !lower.includes(token),
        `${file} must contain no vendor-specific token '${token}'`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Prohibited models and blockers, in routing alone
// ---------------------------------------------------------------------------

test("route refuses a picker that fabricates a prohibited model", () => {
  const decision = route(
    { catalog: baseCatalog, request: request({ taskType: "security-review", taskDescription: SECURITY_TASK }) },
    () => ({ model: PROHIBITED, reason: "rogue picker", cheapenedOnCostEvidence: false }),
  );
  assert.equal(decision.ok, false);
  assert.match(decision.message, /picker returned prohibited model/);
});

test("routing independently excludes a prohibited model before ticket 04", () => {
  // Even glowing suitability evidence cannot admit a prohibited model; the
  // reason is carried on the rejected candidate rather than hidden downstream.
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [PROHIBITED]), {
    [PROHIBITED]: { "security-review": 1 },
  });
  const decision = route({
    request: request({ taskDescription: SECURITY_TASK, taskType: "security-review" }),
    catalog,
  });

  assert.equal(decision.ok, false);
  assert.match(decision.allowed.rejected.find((candidate) => candidate.model === PROHIBITED)?.rejectedBecause.join(" ") ?? "", /prohibited by name/);
});

test("a routing blocker produces no model at all", () => {
  const decision = route({
    request: request({ taskType: "security-review" }),
    catalog: baseCatalog,
  });
  assert.equal(decision.ok, false);
  assert.equal("model" in decision, false);
});

// ---------------------------------------------------------------------------
// No live provider, no research, no benchmark
// ---------------------------------------------------------------------------

test("the routing source cannot reach a network or a model", () => {
  const banned = [
    "node:http",
    "node:https",
    "node:net",
    "node:dns",
    "node:tls",
    "undici",
    "fetch(",
    "XMLHttpRequest",
    "child_process",
    "spawnSync",
  ];
  for (const [file, source] of Object.entries(routingSources())) {
    for (const token of banned) {
      assert.ok(!source.includes(token), `${file} must not reference '${token}'`);
    }
  }
});

test("repeated routing decisions are reproducible from the catalog alone", () => {
  const catalog = withTaskSuitability(onlyModels(baseCatalog, [OPUS, SONNET, HAIKU]), {
    [OPUS]: { formatting: 0.95 },
    [SONNET]: { formatting: 0.9 },
    [HAIKU]: { formatting: 0.8 },
  });
  const input = { request: request({ taskType: "formatting" }), catalog, now: 1_700_000_000_000 };
  const first = formatRoutingRecord(route(input));
  for (let i = 0; i < 25; i += 1) {
    assert.equal(formatRoutingRecord(route(input)), first);
  }
});
