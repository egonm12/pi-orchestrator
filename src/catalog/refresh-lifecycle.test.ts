import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readFact, isTrustworthy } from "./epistemic.ts";
import { buildCatalog, lookup, describeEntry } from "./model-catalog.ts";
import {
  CAPABILITY_ACTIVITIES,
  DEFAULT_REFRESH_STATE_PATH,
  MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN,
  QUALIFYING_SOURCES,
  SELF_RATING_KEYS,
  SelfRatingNotEvidenceError,
  UnapprovedCapabilityResearchError,
  UnbudgetedCapabilityResearchError,
  applyCapabilityProfile,
  deriveSuitability,
  emptyRefreshState,
  loadRefreshState,
  recordCapabilityObservation,
  refreshAtSessionStart,
  refreshProvider,
  runCapabilityResearch,
  saveRefreshState,
  updateFromCallResult,
  type CapabilityObservation,
  type CapabilityResearchInput,
  type RefreshState,
} from "./refresh-lifecycle.ts";
import { onlyModels } from "../fixtures/catalog-facts.ts";
import {
  adapterRegistry,
  createProviderAdapter,
  type ProviderAdapter,
} from "../fixtures/provider-double.ts";
import {
  authorizeRecipient,
  emptyAuthorization,
  grantOwnerApproval,
  isAuthorizedRecipient,
  isOwnerApprovalGranted,
  approvedRecipients,
} from "../recipients/authorization.ts";
import {
  NO_BUDGET_CONSTRAINT,
  type BudgetPreflightConstraint,
} from "../recipients/authorized-dispatch.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const CLAUDE = "anthropic/claude-sonnet-5";
const CLAUDE_TWO = "anthropic/claude-haiku-4-5";
const CODEX = "openai-codex/gpt-5.6-sol";

/** A catalog over two real providers, built from the pinned snapshot. */
function twoProviderCatalog() {
  return onlyModels(buildCatalog({ modelIds: [CLAUDE, CLAUDE_TWO, CODEX] }), [
    CLAUDE,
    CLAUDE_TWO,
    CODEX,
  ]);
}

/** Reports both availability and usage. */
function reportingAdapter(provider: string, remainingUsd = 42.5): ProviderAdapter {
  return createProviderAdapter({
    provider,
    supports: { usage: true, availability: true },
    snapshot: {
      models: {
        "claude-sonnet-5": { status: "available" },
        "claude-haiku-4-5": { status: "available" },
        "gpt-5.6-sol": { status: "available" },
      },
      quota: { kind: "metered", remainingUsd },
    },
  });
}

/** Reports nothing at all -- the common real case. */
function silentAdapter(provider: string): ProviderAdapter {
  return createProviderAdapter({
    provider,
    supports: { usage: false, availability: false },
  });
}

const ALLOWING_BUDGET: BudgetPreflightConstraint = {
  describe: "test allowance: $5 task budget (ticket 09 owns real accounting)",
  check: () => ({ ok: true }),
};

const REFUSING_BUDGET: BudgetPreflightConstraint = {
  describe: "test allowance: exhausted",
  check: () => ({ ok: false, why: "the task allowance is exhausted" }),
};

function researchInput(
  overrides: Partial<CapabilityResearchInput> = {},
): CapabilityResearchInput {
  return {
    request: {
      activity: "capability-research",
      model: CLAUDE,
      taskType: "mechanical-edit",
      instances: ["inst-1", "inst-2", "inst-3"],
    },
    approval: grantOwnerApproval({
      approvedBy: "owner",
      scope: "capability-research",
      acknowledgement: "run 3 representative mechanical-edit checks on claude-sonnet-5",
    }),
    budget: ALLOWING_BUDGET,
    run: (instance) => ({ instance, outcome: "pass" }),
    now: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Checklist 1: session start refreshes availability and usage only for
// providers that support it, and leaves the rest unknown
// ---------------------------------------------------------------------------

test("session start refreshes the provider that reports, and asks the silent one nothing", () => {
  const claude = reportingAdapter("anthropic");
  const codex = silentAdapter("openai-codex");
  const result = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([claude, codex]),
    now: "2026-09-21T12:00:00.000Z",
  });

  assert.deepEqual(
    claude.refreshRequests.map((r) => r.reason),
    ["session-start"],
    "the reporting provider is asked exactly once, per provider not per model",
  );
  assert.deepEqual(codex.refreshRequests, [], "a provider that reports nothing is not asked");

  const refreshed = lookup(result.catalog, CLAUDE);
  assert.ok(refreshed);
  assert.equal(refreshed.usageHeadroom.state, "known");
  assert.equal(refreshed.liveCallability.state, "known");
});

test("a provider that cannot report is left explicitly unknown, not silently skipped", () => {
  const result = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([reportingAdapter("anthropic"), silentAdapter("openai-codex")]),
    now: "2026-09-21T12:00:00.000Z",
  });

  const entry = lookup(result.catalog, CODEX);
  assert.ok(entry);
  assert.equal(entry.usageHeadroom.state, "unknown");
  // Visibly still-unknown: we looked at the configuration at this timestamp
  // and this provider reports nothing. That is distinguishable from an entry
  // nobody ever examined, which carries no checkedAt at all.
  assert.equal(
    entry.usageHeadroom.state === "unknown" ? entry.usageHeadroom.checkedAt : undefined,
    "2026-09-21T12:00:00.000Z",
  );
  assert.match(
    entry.usageHeadroom.state === "unknown" ? (entry.usageHeadroom.note ?? "") : "",
    /reports neither availability nor usage/,
  );

  const built = lookup(twoProviderCatalog(), CODEX);
  assert.ok(built);
  assert.equal(
    built.usageHeadroom.state === "unknown" ? built.usageHeadroom.checkedAt : "absent",
    undefined,
    "before any refresh there is no checkedAt, so the stamp is what makes the look visible",
  );

  const outcome = result.outcomes.find((o) => o.provider === "openai-codex");
  assert.equal(outcome?.requested, false);
  assert.deepEqual(outcome?.updatedModels, []);
  assert.deepEqual(outcome?.leftUnknown, [CODEX]);
});

test("an unsupported provider never gets a fabricated value", () => {
  const result = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([silentAdapter("anthropic"), silentAdapter("openai-codex")]),
    now: "2026-09-21T12:00:00.000Z",
  });

  for (const model of [CLAUDE, CLAUDE_TWO, CODEX]) {
    const entry = lookup(result.catalog, model);
    assert.ok(entry);
    assert.equal(entry.usageHeadroom.state, "unknown", `${model} must stay unknown`);
    assert.equal(entry.liveCallability.state, "unknown", `${model} reachability is unproven`);
  }

  // And the unknown still cannot be rendered as capacity (ticket 05's guarantee
  // must survive a refresh that learned nothing).
  const described = describeEntry(lookup(result.catalog, CODEX)!);
  assert.match(described.usageHeadroom ?? "", /^unknown \(/);
});

test("a provider with no adapter at all is asked nothing and stays unknown", () => {
  const result = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([reportingAdapter("anthropic")]),
    now: "2026-09-21T12:00:00.000Z",
  });

  const outcome = result.outcomes.find((o) => o.provider === "openai-codex");
  assert.equal(outcome?.requested, false);
  assert.match(outcome?.why ?? "", /no adapter configured/);
  assert.equal(lookup(result.catalog, CODEX)?.usageHeadroom.state, "unknown");
});

test("a supported refresh that returns no quota does not invent one", () => {
  const availabilityOnly = createProviderAdapter({
    provider: "anthropic",
    supports: { usage: true, availability: true },
    snapshot: { models: { "claude-sonnet-5": { status: "available" } } },
  });
  const result = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([availabilityOnly]),
    now: "2026-09-21T12:00:00.000Z",
  });

  const entry = lookup(result.catalog, CLAUDE);
  assert.ok(entry);
  assert.equal(entry.liveCallability.state, "known", "availability was reported");
  assert.equal(entry.usageHeadroom.state, "unknown", "quota was not reported, so not known");
  assert.match(
    entry.usageHeadroom.state === "unknown" ? (entry.usageHeadroom.note ?? "") : "",
    /asked but reported no remaining quota/,
  );
});

test("session refresh does not erase headroom a real call already established", () => {
  const observed = updateFromCallResult(twoProviderCatalog(), emptyRefreshState(), {
    model: CODEX,
    outcome: "ok",
    observedAt: "2026-09-21T11:00:00.000Z",
    reportedUsage: { remainingRequests: 900 },
  });
  assert.equal(lookup(observed.catalog, CODEX)?.usageHeadroom.state, "known");

  const refreshed = refreshAtSessionStart({
    catalog: observed.catalog,
    adapters: adapterRegistry([silentAdapter("openai-codex")]),
    now: "2026-09-21T12:00:00.000Z",
  });

  const entry = lookup(refreshed.catalog, CODEX);
  assert.equal(
    entry?.usageHeadroom.state,
    "known",
    "a silent provider must not overwrite observed evidence with unknown",
  );
});

// ---------------------------------------------------------------------------
// Checklist 2: consumption and observed throttling update from call results
// without issuing additional requests
// ---------------------------------------------------------------------------

test("consumption and throttling are recorded from the returned result alone", () => {
  const adapters = [reportingAdapter("anthropic"), reportingAdapter("openai-codex")];
  const catalog = twoProviderCatalog();

  const first = updateFromCallResult(catalog, emptyRefreshState(), {
    model: CLAUDE,
    outcome: "ok",
    observedAt: "2026-09-21T12:00:00.000Z",
    reportedUsage: { costUsd: 0.25, remainingUsd: 4.75 },
  });
  const second = updateFromCallResult(first.catalog, first.state, {
    model: CLAUDE,
    outcome: "throttled",
    observedAt: "2026-09-21T12:01:00.000Z",
    retryAfterSeconds: 30,
    detail: "rate limited",
    reportedUsage: { costUsd: 0.1 },
  });

  assert.equal(second.state.consumption[CLAUDE]?.reportedConsumptionUsd, 0.35);
  assert.equal(second.state.consumption[CLAUDE]?.calls, 2);
  assert.equal(second.state.throttling.length, 1);
  assert.equal(second.state.throttling[0]?.retryAfterSeconds, 30);

  // The point of the checklist item: nothing was fetched to learn any of it.
  for (const adapter of adapters) {
    assert.deepEqual(
      adapter.refreshRequests,
      [],
      "updating from a call result must issue no request",
    );
  }
});

test("the call-result update path is given no provider access at all", () => {
  // Stronger than counting requests: the function takes (catalog, state,
  // result). There is no adapter parameter, so it cannot reach a provider even
  // if a future edit tried to.
  assert.equal(updateFromCallResult.length, 3);
  const source = readFileSync(join(HERE, "refresh-lifecycle.ts"), "utf8");
  const body = source.slice(
    source.indexOf("export function updateFromCallResult"),
    source.indexOf("// 4. Capability research"),
  );
  assert.ok(body.length > 0);
  assert.doesNotMatch(body, /adapter/i, "no adapter access in this path");
  assert.doesNotMatch(body, /\.refresh\(/, "no refresh call in this path");
});

test("a throttle without a reported remaining count does not become zero remaining", () => {
  const update = updateFromCallResult(twoProviderCatalog(), emptyRefreshState(), {
    model: CLAUDE,
    outcome: "throttled",
    observedAt: "2026-09-21T12:00:00.000Z",
    retryAfterSeconds: 60,
  });

  const entry = lookup(update.catalog, CLAUDE);
  assert.equal(
    entry?.usageHeadroom.state,
    "unknown",
    "an unknown quota is not a number, and 0 is as wrong as unlimited",
  );
  assert.equal(update.state.throttling.length, 1, "but the throttle itself is recorded");
});

test("a successful call establishes authentication and reachability, which a listing never did", () => {
  const built = lookup(twoProviderCatalog(), CLAUDE);
  assert.equal(built?.authentication.state, "unknown");
  assert.equal(built?.liveCallability.state, "unknown");

  const update = updateFromCallResult(twoProviderCatalog(), emptyRefreshState(), {
    model: CLAUDE,
    outcome: "ok",
    observedAt: "2026-09-21T12:00:00.000Z",
  });

  const entry = lookup(update.catalog, CLAUDE);
  assert.equal(entry?.authentication.state, "known");
  assert.equal(
    entry?.authentication.state === "known" ? entry.authentication.evidence : undefined,
    "observed-from-call",
  );
  assert.equal(entry?.liveCallability.state, "known");
});

test("a result for a model that is not in the catalog invents no entry", () => {
  const update = updateFromCallResult(twoProviderCatalog(), emptyRefreshState(), {
    model: "made-up/not-listed",
    outcome: "ok",
    observedAt: "2026-09-21T12:00:00.000Z",
    reportedUsage: { remainingUsd: 100 },
  });

  assert.equal(lookup(update.catalog, "made-up/not-listed"), undefined);
  assert.deepEqual(update.applied, []);
  assert.match(update.why, /no fact was invented/);
});

test("updating from a call result does not mutate the catalog or state it was given", () => {
  const catalog = twoProviderCatalog();
  const state = emptyRefreshState();
  updateFromCallResult(catalog, state, {
    model: CLAUDE,
    outcome: "throttled",
    observedAt: "2026-09-21T12:00:00.000Z",
    reportedUsage: { costUsd: 1 },
  });

  assert.equal(lookup(catalog, CLAUDE)?.usageHeadroom.state, "unknown");
  assert.deepEqual(state.throttling, []);
  assert.deepEqual(state.consumption, {});
});

// ---------------------------------------------------------------------------
// Checklist 3: a call failure or configuration change refreshes only the
// affected provider
// ---------------------------------------------------------------------------

for (const reason of ["call-failure", "configuration-change"] as const) {
  test(`a ${reason} refreshes only the affected provider`, () => {
    const claude = reportingAdapter("anthropic");
    const codex = reportingAdapter("openai-codex");
    const before = twoProviderCatalog();

    const result = refreshProvider({
      catalog: before,
      adapters: adapterRegistry([claude, codex]),
      provider: "anthropic",
      reason,
      now: "2026-09-21T12:00:00.000Z",
    });

    assert.deepEqual(claude.refreshRequests.map((r) => r.reason), [reason]);
    assert.deepEqual(codex.refreshRequests, [], "recovery must not sweep every provider");

    // Identity, not deep equality: the untouched entry is the very same object.
    assert.equal(
      result.catalog.entries[CODEX],
      before.entries[CODEX],
      "an unaffected provider's facts are untouched, down to object identity",
    );
    assert.notEqual(result.catalog.entries[CLAUDE], before.entries[CLAUDE]);
    assert.deepEqual(result.outcomes.map((o) => o.provider), ["anthropic"]);
  });
}

test("a scoped refresh leaves the other provider's freshness exactly as it was", () => {
  const before = refreshAtSessionStart({
    catalog: twoProviderCatalog(),
    adapters: adapterRegistry([reportingAdapter("anthropic"), reportingAdapter("openai-codex")]),
    now: "2026-09-21T10:00:00.000Z",
  });

  const after = refreshProvider({
    catalog: before.catalog,
    adapters: adapterRegistry([reportingAdapter("anthropic", 1.25), reportingAdapter("openai-codex")]),
    provider: "anthropic",
    reason: "call-failure",
    state: before.state,
    now: "2026-09-21T12:00:00.000Z",
  });

  const codex = lookup(after.catalog, CODEX);
  assert.equal(
    codex?.usageHeadroom.state === "known" ? codex.usageHeadroom.asOf : undefined,
    "2026-09-21T10:00:00.000Z",
    "the unaffected provider keeps its original asOf, so it can age honestly",
  );

  const claude = lookup(after.catalog, CLAUDE);
  assert.equal(
    claude?.usageHeadroom.state === "known" && claude.usageHeadroom.value.kind === "metered"
      ? claude.usageHeadroom.value.remainingUsd
      : undefined,
    1.25,
    "the affected provider did refresh",
  );
  assert.equal(after.state.lastRefresh["anthropic"]?.reason, "call-failure");
  assert.equal(after.state.lastRefresh["openai-codex"]?.reason, "session-start");
});

// ---------------------------------------------------------------------------
// Checklist 4: capability research or an active benchmark without explicit
// owner approval is blocked
// ---------------------------------------------------------------------------

test("a forged approval object cannot buy capability research", () => {
  const forged = {
    approvedBy: "owner",
    grantedAt: "2026-09-21T12:00:00.000Z",
    scope: "capability-research" as const,
    acknowledgement: "looks completely legitimate",
  };
  assert.equal(isOwnerApprovalGranted(forged), false);

  assert.throws(
    () => runCapabilityResearch(emptyRefreshState(), researchInput({ approval: forged })),
    (error: unknown) =>
      error instanceof UnapprovedCapabilityResearchError &&
      /not granted through grantOwnerApproval/.test(error.message),
  );
});

test("an approval is not fungible across purposes", () => {
  // A data-recipient approval is a real approval -- it just is not approval to
  // spend money running benchmarks.
  const recipientApproval = grantOwnerApproval({
    approvedBy: "owner",
    scope: "data-recipient",
    acknowledgement: "anthropic may receive task data",
  });
  assert.equal(isOwnerApprovalGranted(recipientApproval), true);

  assert.throws(
    () => runCapabilityResearch(emptyRefreshState(), researchInput({ approval: recipientApproval })),
    (error: unknown) =>
      error instanceof UnapprovedCapabilityResearchError &&
      /scoped 'data-recipient'/.test(error.message),
  );
});

test("a capability-research approval does not authorize an active benchmark", () => {
  const input = researchInput({
    request: {
      activity: "active-benchmark",
      model: CLAUDE,
      taskType: "mechanical-edit",
      instances: ["inst-1"],
    },
  });
  assert.throws(
    () => runCapabilityResearch(emptyRefreshState(), input),
    UnapprovedCapabilityResearchError,
  );
});

test("each capability activity runs only under its own approval", () => {
  for (const activity of CAPABILITY_ACTIVITIES) {
    const result = runCapabilityResearch(
      emptyRefreshState(),
      researchInput({
        request: { activity, model: CLAUDE, taskType: "mechanical-edit", instances: ["a", "b"] },
        approval: grantOwnerApproval({
          approvedBy: "owner",
          scope: activity,
          acknowledgement: `run ${activity}`,
        }),
      }),
    );
    assert.equal(result.observations.length, 2);
  }
});

test("research approval scopes cannot widen data access", () => {
  // The additive scopes must not become a back door into ticket 07's
  // recipient gate, which requires scope === "data-recipient" exactly.
  const approval = grantOwnerApproval({
    approvedBy: "owner",
    scope: "capability-research",
    acknowledgement: "run capability research on anthropic",
  });
  const authorization = authorizeRecipient(emptyAuthorization(), "anthropic", approval);

  assert.equal(
    isAuthorizedRecipient(authorization, "anthropic"),
    false,
    "approving research must never make a provider a data recipient",
  );
  assert.deepEqual(approvedRecipients(authorization), []);
});

test("running an instance twice is refused rather than counted twice", () => {
  assert.throws(
    () =>
      runCapabilityResearch(
        emptyRefreshState(),
        researchInput({
          request: {
            activity: "capability-research",
            model: CLAUDE,
            taskType: "mechanical-edit",
            instances: ["inst-1", "inst-1", "inst-1"],
          },
        }),
      ),
    /does not corroborate/,
  );
});

// ---------------------------------------------------------------------------
// Checklist 5: an approved capability run draws on the applicable approved
// budget
// ---------------------------------------------------------------------------

test("capability research refuses to run with no budget authorization", () => {
  assert.throws(
    () =>
      runCapabilityResearch(
        emptyRefreshState(),
        researchInput({ budget: NO_BUDGET_CONSTRAINT }),
      ),
    (error: unknown) =>
      error instanceof UnbudgetedCapabilityResearchError &&
      /no budget authorization/.test(error.message),
  );
});

test("capability research stops when the budget refuses", () => {
  let ran = 0;
  assert.throws(
    () =>
      runCapabilityResearch(
        emptyRefreshState(),
        researchInput({
          budget: REFUSING_BUDGET,
          run: (instance) => {
            ran += 1;
            return { instance, outcome: "pass" };
          },
        }),
      ),
    (error: unknown) =>
      error instanceof UnbudgetedCapabilityResearchError &&
      /allowance is exhausted/.test(error.message),
  );
  assert.equal(ran, 0, "the budget is checked before any paid work runs");
});

test("an approved run records which budget was applied", () => {
  const result = runCapabilityResearch(emptyRefreshState(), researchInput());
  assert.equal(result.budgetApplied, ALLOWING_BUDGET.describe);
  assert.equal(result.approvedBy, "owner");
  assert.equal(result.observations.length, 3);
});

// ---------------------------------------------------------------------------
// Checklist 6: a single successful task does not become a general capability
// claim, and self-ratings are not accepted as evidence
// ---------------------------------------------------------------------------

function observation(
  overrides: Partial<CapabilityObservation> = {},
): CapabilityObservation {
  return {
    model: CLAUDE,
    taskType: "mechanical-edit",
    instance: "inst-1",
    source: "verified-task-outcome",
    outcome: "pass",
    observedAt: "2026-09-21T12:00:00.000Z",
    ...overrides,
  };
}

test("one verified success stays provisional and does not become a known fact", () => {
  const state = recordCapabilityObservation(emptyRefreshState(), observation());
  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");

  assert.equal(derivation.tier, "provisional");
  assert.equal(derivation.distinctQualifying, 1);
  assert.equal(derivation.promoted, false);

  const applied = applyCapabilityProfile(twoProviderCatalog(), state, "2026-09-21T12:00:00.000Z");
  const entry = lookup(applied.catalog, CLAUDE);
  assert.equal(entry?.taskSuitability.state, "unknown");
  // Recorded and visible, but not usable as a claim.
  assert.match(
    entry?.taskSuitability.state === "unknown" ? (entry.taskSuitability.note ?? "") : "",
    /below the promotion bar/,
  );
  assert.equal(
    isTrustworthy(readFact(entry!.taskSuitability)),
    false,
    "ticket 06 consults isTrustworthy, and a provisional profile must never satisfy it",
  );
});

test("the bar is distinct instances, so replaying one task cannot reach it", () => {
  let state: RefreshState = emptyRefreshState();
  for (let i = 0; i < 5; i += 1) {
    state = recordCapabilityObservation(
      state,
      observation({ observedAt: `2026-09-21T12:0${i}:00.000Z` }),
    );
  }

  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");
  assert.equal(derivation.distinctQualifying, 1, "five replays of one instance is one instance");
  assert.equal(derivation.promoted, false);
});

test("three distinct qualifying instances clear the bar and become a known score", () => {
  let state: RefreshState = emptyRefreshState();
  for (const instance of ["inst-1", "inst-2", "inst-3"]) {
    state = recordCapabilityObservation(state, observation({ instance }));
  }

  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");
  assert.equal(derivation.distinctQualifying, MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN);
  assert.equal(derivation.tier, "corroborated");
  assert.equal(derivation.promoted, true);
  assert.equal(derivation.passRate, 1);

  const applied = applyCapabilityProfile(twoProviderCatalog(), state, "2026-09-21T12:00:00.000Z");
  const entry = lookup(applied.catalog, CLAUDE);
  assert.equal(entry?.taskSuitability.state, "known");
  assert.equal(
    entry?.taskSuitability.state === "known"
      ? entry.taskSuitability.value["mechanical-edit"]
      : undefined,
    1,
  );
  assert.equal(
    entry?.taskSuitability.state === "known" ? entry.taskSuitability.evidence : undefined,
    "observed-from-call",
  );
});

test("the strongest tier is corroborated, never labelled verified", () => {
  let state: RefreshState = emptyRefreshState();
  for (const instance of ["a", "b", "c", "d", "e", "f"]) {
    state = recordCapabilityObservation(state, observation({ instance }));
  }
  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");
  assert.equal(derivation.tier, "corroborated");
  assert.notEqual(derivation.tier as string, "verified");
});

test("a mixed record produces the pass rate, not a rounded-up claim", () => {
  let state: RefreshState = emptyRefreshState();
  state = recordCapabilityObservation(state, observation({ instance: "a", outcome: "pass" }));
  state = recordCapabilityObservation(state, observation({ instance: "b", outcome: "fail" }));
  state = recordCapabilityObservation(state, observation({ instance: "c", outcome: "pass" }));

  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");
  assert.equal(derivation.promoted, true);
  assert.equal(derivation.passRate, 2 / 3);
});

test("published information seeds a provisional profile and can never promote it", () => {
  let state: RefreshState = emptyRefreshState();
  for (const instance of ["pub-1", "pub-2", "pub-3", "pub-4"]) {
    state = recordCapabilityObservation(state, observation({ instance, source: "published-seed" }));
  }

  const derivation = deriveSuitability(state, CLAUDE, "mechanical-edit");
  assert.equal(derivation.distinctQualifying, 0);
  assert.equal(derivation.tier, "provisional");
  assert.equal(derivation.promoted, false);
  assert.match(derivation.why, /cannot promote/);
  assert.equal(
    QUALIFYING_SOURCES.includes("published-seed"),
    false,
    "published data is a seed, not a representative check",
  );
});

test("capability is per task type, so clearing the bar on one does not claim another", () => {
  let state: RefreshState = emptyRefreshState();
  for (const instance of ["a", "b", "c"]) {
    state = recordCapabilityObservation(state, observation({ instance }));
  }
  state = recordCapabilityObservation(
    state,
    observation({ instance: "sec-1", taskType: "security-review" }),
  );

  const applied = applyCapabilityProfile(twoProviderCatalog(), state, "2026-09-21T12:00:00.000Z");
  const entry = lookup(applied.catalog, CLAUDE);
  assert.ok(entry?.taskSuitability.state === "known");
  assert.equal(entry.taskSuitability.value["mechanical-edit"], 1);
  assert.equal(
    entry.taskSuitability.value["security-review"],
    undefined,
    "one observation on a different task type is not a score for it",
  );
  assert.match(entry.taskSuitability.note ?? "", /below the bar: security-review/);
});

test("a self-rating is refused as a capability observation", () => {
  for (const key of SELF_RATING_KEYS) {
    const smuggled = { ...observation(), [key]: 0.99 } as CapabilityObservation;
    assert.throws(
      () => recordCapabilityObservation(emptyRefreshState(), smuggled),
      (error: unknown) =>
        error instanceof SelfRatingNotEvidenceError &&
        new RegExp(`carries '${key}'`).test(error.message),
      `'${key}' must be refused`,
    );
  }
});

test("a self-rating returned by an approved run is refused too", () => {
  assert.throws(
    () =>
      runCapabilityResearch(
        emptyRefreshState(),
        researchInput({
          run: (instance) =>
            ({ instance, outcome: "pass", selfRating: 0.99 }) as never,
        }),
      ),
    SelfRatingNotEvidenceError,
  );
});

test("no self-rating field name appears in the observation or derivation types", () => {
  const source = readFileSync(join(HERE, "refresh-lifecycle.ts"), "utf8");
  const ledger = source.slice(
    source.indexOf("export interface CapabilityObservation"),
    source.indexOf("export interface RefreshState"),
  );
  assert.ok(ledger.length > 0);
  for (const key of ["selfRating", "selfReportedConfidence", "modelConfidence"]) {
    assert.doesNotMatch(
      ledger,
      new RegExp(`${key}\\s*[?:]`),
      `${key} must not be a field on the evidence ledger`,
    );
  }
});

test("an unknown observation source is refused", () => {
  assert.throws(
    () =>
      recordCapabilityObservation(
        emptyRefreshState(),
        observation({ source: "vibes" as never }),
      ),
    SelfRatingNotEvidenceError,
  );
});

// ---------------------------------------------------------------------------
// Checklist 7: no background polling schedule runs without approval
// ---------------------------------------------------------------------------

test("this ticket's code contains no timer, so there is no schedule to approve", () => {
  const source = readFileSync(join(HERE, "refresh-lifecycle.ts"), "utf8");
  // Built from fragments so this assertion does not trip over its own needle.
  for (const timer of ["set" + "Interval", "set" + "Timeout", "set" + "Immediate", "node:" + "timers"]) {
    assert.doesNotMatch(source, new RegExp(timer), `refresh-lifecycle.ts must not use ${timer}`);
  }
});

test("every refresh is caller-driven: a refresh happens only when asked for", () => {
  const adapter = reportingAdapter("anthropic");
  // Constructing state and reading facts must not trigger a refresh.
  const catalog = twoProviderCatalog();
  emptyRefreshState();
  describeEntry(lookup(catalog, CLAUDE)!);
  deriveSuitability(emptyRefreshState(), CLAUDE, "mechanical-edit");
  assert.deepEqual(adapter.refreshRequests, [], "nothing refreshes on its own");

  refreshProvider({
    catalog,
    adapters: adapterRegistry([adapter]),
    provider: "anthropic",
    reason: "configuration-change",
    now: "2026-09-21T12:00:00.000Z",
  });
  assert.equal(adapter.refreshRequests.length, 1, "and exactly one refresh when asked once");
});

// ---------------------------------------------------------------------------
// Persistence: the refresh state survives a restart, like ticket 05's catalog
// ---------------------------------------------------------------------------

test("refresh state survives a save/load round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-refresh-"));
  try {
    const path = join(dir, "refresh-state.json");
    let state = updateFromCallResult(twoProviderCatalog(), emptyRefreshState(), {
      model: CLAUDE,
      outcome: "throttled",
      observedAt: "2026-09-21T12:00:00.000Z",
      retryAfterSeconds: 15,
      reportedUsage: { costUsd: 0.5 },
    }).state;
    state = recordCapabilityObservation(state, observation());

    saveRefreshState(path, state);
    const loaded = loadRefreshState(path);

    assert.deepEqual(loaded.throttling, state.throttling);
    assert.deepEqual(loaded.consumption, state.consumption);
    assert.deepEqual(loaded.observations, state.observations);
    assert.equal(
      deriveSuitability(loaded, CLAUDE, "mechanical-edit").distinctQualifying,
      1,
      "the ledger still counts correctly after a restart",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a state file written by a future schema is rejected, not silently misread", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-refresh-"));
  try {
    const path = join(dir, "refresh-state.json");
    saveRefreshState(path, { ...emptyRefreshState(), schemaVersion: 99 });
    assert.throws(() => loadRefreshState(path), /schemaVersion 99/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the default state path is runtime state, and git-ignores it", () => {
  assert.match(DEFAULT_REFRESH_STATE_PATH, /^src\/state\//);
  const ignore = readFileSync(join(HERE, "..", "..", ".gitignore"), "utf8");
  assert.match(ignore, /src\/state/);
});
