import assert from "node:assert/strict";
import { test } from "node:test";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import {
  createProviderDouble,
  type ModelCondition,
} from "../fixtures/provider-double.ts";
import { SUBSCRIPTION_TEST_MODEL } from "./live-model.ts";
import {
  allowListAdmitsProhibitedModel,
  HARNESS_ALLOW_PATTERNS,
  HARNESS_MODEL_SCOPE,
  isProhibitedModel,
  resolveDelegationModel,
} from "./model-resolution.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

// Every model id the user prohibits, as it really appears in this registry.
// `openai/fable-1` is 01-findings.md's example and is kept even though this
// installation does not list it.
const PROHIBITED_IDS = [
  "anthropic/claude-fable-5",
  "anthropic/claude-fable-5-1",
  "openai-codex/gpt-6-astra",
  "openai/fable-1",
];

// The exact Claude subscription route, shared with the live-model policy so
// there is one spelling of "the subscription route" in the harness.
const GOOD = SUBSCRIPTION_TEST_MODEL;

// ---------------------------------------------------------------------------
// Explicit provider + model identity
// ---------------------------------------------------------------------------

test("a delegation resolves to an explicit provider and model identity", () => {
  const decision = resolveDelegationModel({
    model: "anthropic/claude-sonnet-5:medium",
    source: "explicit",
  });
  assert.equal(decision.ok, true);
  assert.ok(decision.ok);
  assert.equal(decision.provider, "anthropic");
  assert.equal(decision.id, "claude-sonnet-5");
  assert.equal(decision.baseModel, "anthropic/claude-sonnet-5");
  assert.equal(decision.thinkingSuffix, ":medium");
  assert.equal(decision.requestedModel, "anthropic/claude-sonnet-5:medium");
});

test("a model with no provider prefix is rejected, not guessed", () => {
  const decision = resolveDelegationModel({ model: "claude-sonnet-5", source: "explicit" });
  assert.equal(decision.ok, false);
  assert.ok(!decision.ok);
  assert.equal(decision.code, "out_of_scope");
});

// ---------------------------------------------------------------------------
// Missing model must fail rather than inherit
// ---------------------------------------------------------------------------

for (const [label, model] of [
  ["undefined", undefined],
  ["empty string", ""],
  ["blank", "   "],
] as const) {
  test(`a delegation with no model selection (${label}) fails rather than inheriting`, () => {
    const decision = resolveDelegationModel({ model, source: "explicit" });
    assert.equal(decision.ok, false);
    assert.ok(!decision.ok);
    assert.equal(decision.code, "missing_model");
    assert.match(decision.message, /explicit provider\/model/);
  });
}

test("the real checkModelScope no-ops on a missing model, so the harness must catch it", async () => {
  // Guards the reason the check above exists. If pi-subagents ever starts
  // rejecting a missing model itself, this fails and the harness check can
  // be revisited rather than silently duplicating product behaviour.
  const { checkModelScope } = await import(
    "../subagents/model-scope.ts"
  );
  assert.equal(checkModelScope(undefined, HARNESS_MODEL_SCOPE, "explicit"), undefined);
  assert.equal(checkModelScope("", HARNESS_MODEL_SCOPE, "explicit"), undefined);
});

// ---------------------------------------------------------------------------
// Prohibited models: Fable and Astra
// ---------------------------------------------------------------------------

for (const model of PROHIBITED_IDS) {
  for (const source of ["explicit", "inherited"] as const) {
    test(`a delegation naming ${model} is rejected (${source})`, () => {
      const decision = resolveDelegationModel({ model, source });
      assert.equal(decision.ok, false);
      assert.ok(!decision.ok);
      assert.equal(decision.code, "out_of_scope");
      assert.equal(decision.requestedModel, model);
      assert.deepEqual(decision.allowedPatterns, [...HARNESS_ALLOW_PATTERNS]);
    });
  }
}

test("prohibited names inside allowed families are refused before scope matching", () => {
  const hypothetical = [
    "anthropic/claude-opus-fable-6",
    "anthropic/claude-sonnet-5-astra",
    "anthropic/claude-haiku-ASTRA-1",
    "openai-codex/gpt-5.7-astra",
    "openai-codex/gpt-5.8-Fable",
  ];
  for (const model of hypothetical) {
    for (const source of ["explicit", "inherited"] as const) {
      const decision = resolveDelegationModel({ model, source });
      assert.ok(!decision.ok, `${model} should be refused (${source})`);
      assert.equal(decision.code, "out_of_scope");
      assert.equal(decision.requestedModel, model);
      assert.match(decision.message, /prohibited by name/);
    }
  }
});

test("an exact allow-list entry cannot authorize a prohibited name", () => {
  const model = "anthropic/claude-opus-fable-6";
  const decision = resolveDelegationModel({
    model,
    source: "explicit",
    scope: { enforce: true, strict: true, allow: [model] },
  });
  assert.ok(!decision.ok);
  assert.equal(decision.code, "out_of_scope");
  assert.match(decision.message, /prohibited by name/);
});

test("safe ids in allowed families remain delegatable", () => {
  for (const model of ["anthropic/claude-opus-5", "openai-codex/gpt-6-sol"]) {
    assert.ok(resolveDelegationModel({ model, source: "explicit" }).ok, model);
  }
});

test("prohibited models are rejected with a thinking suffix and in any case", () => {
  for (const model of [
    "openai-codex/gpt-6-astra:low",
    "openai-codex/gpt-6-astra:high",
    "anthropic/claude-fable-5:medium",
    "ANTHROPIC/CLAUDE-FABLE-5",
    "OpenAI-Codex/GPT-6-ASTRA",
  ]) {
    const decision = resolveDelegationModel({ model, source: "inherited" });
    assert.ok(!decision.ok, `${model} should be rejected`);
    assert.equal(decision.code, "out_of_scope");
  }
});

test("strict mode is what makes an inherited prohibited model an error, not a warning", async () => {
  const { checkModelScope } = await import(
    "../subagents/model-scope.ts"
  );
  const allow = [...HARNESS_ALLOW_PATTERNS];
  for (const model of ["anthropic/claude-fable-5", "openai-codex/gpt-6-astra"]) {
    // Without strict, inherited is only a warn (model-scope.js:47) -- that is
    // the hole this ticket closes.
    assert.equal(
      checkModelScope(model, { enforce: true, allow }, "inherited")?.severity,
      "warn",
    );
    assert.equal(
      checkModelScope(model, HARNESS_MODEL_SCOPE, "inherited")?.severity,
      "error",
    );
  }
});

test("enforcement is genuinely on: without enforce, nothing is rejected", async () => {
  const { checkModelScope } = await import(
    "../subagents/model-scope.ts"
  );
  assert.equal(
    checkModelScope("openai-codex/gpt-6-astra", { allow: [...HARNESS_ALLOW_PATTERNS] }, "explicit"),
    undefined,
  );
  assert.equal(HARNESS_MODEL_SCOPE.enforce, true);
  assert.equal(HARNESS_MODEL_SCOPE.strict, true);
});

// ---------------------------------------------------------------------------
// The allow list itself must not admit a prohibited model
// ---------------------------------------------------------------------------

test("the harness allow list admits no prohibited model in the real registry", () => {
  const admitted = allowListAdmitsProhibitedModel(
    HARNESS_ALLOW_PATTERNS,
    INSTALLED_MODEL_IDS,
  );
  assert.deepEqual(admitted, []);
});

test("the audit catches the obvious-but-wrong allow patterns", () => {
  // Not hypothetical: anthropic/claude-fable-5, anthropic/claude-fable-5-1 and
  // openai-codex/gpt-6-astra are all really in this installation's registry.
  assert.deepEqual(allowListAdmitsProhibitedModel(["anthropic/*"], INSTALLED_MODEL_IDS), [
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
  ]);
  assert.deepEqual(allowListAdmitsProhibitedModel(["anthropic/claude-*"], INSTALLED_MODEL_IDS), [
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
  ]);
  assert.deepEqual(
    allowListAdmitsProhibitedModel(["openai-codex/*"], INSTALLED_MODEL_IDS),
    ["openai-codex/gpt-6-astra"],
  );
  assert.deepEqual(
    allowListAdmitsProhibitedModel(["openai-codex/gpt-6-*"], INSTALLED_MODEL_IDS),
    ["openai-codex/gpt-6-astra"],
  );
  assert.deepEqual(allowListAdmitsProhibitedModel(["*"], INSTALLED_MODEL_IDS), [
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "openai-codex/gpt-6-astra",
  ]);
});

test("the allow list refuses exactly the prohibited models in the real registry", () => {
  const refused = INSTALLED_MODEL_IDS.filter(
    (id) => !resolveDelegationModel({ model: id, source: "explicit" }).ok,
  );
  assert.deepEqual(refused, [
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "openai-codex/gpt-6-astra",
  ]);
  for (const id of refused) {
    assert.equal(isProhibitedModel(id), true, `${id} is refused because it is prohibited`);
  }

  // Every Claude route the subscription install exposes, apart from Fable,
  // stays delegatable -- this is the route the harness actually runs on.
  const claudeRoutes = INSTALLED_MODEL_IDS.filter(
    (id) => id.startsWith("anthropic/") && !isProhibitedModel(id),
  );
  assert.equal(claudeRoutes.length, 13);
  for (const id of claudeRoutes) {
    assert.ok(
      resolveDelegationModel({ model: id, source: "explicit" }).ok,
      `${id} should be delegatable`,
    );
  }
});

test("the gpt-6 routes are granted by exact id, and the family pattern stays refused", () => {
  // The owner chose these two for agent work. An exact grant cannot widen.
  for (const id of ["openai-codex/gpt-6-luna", "openai-codex/gpt-6-sol"]) {
    assert.ok(
      (HARNESS_ALLOW_PATTERNS as readonly string[]).includes(id),
      `${id} must be granted as an exact id, not through a pattern`,
    );
    assert.ok(resolveDelegationModel({ model: id, source: "explicit" }).ok, `${id} is delegatable`);
  }

  // The family pattern that would have covered them is absent from the allow
  // list, and the audit says why: it admits Astra.
  assert.ok(
    !(HARNESS_ALLOW_PATTERNS as readonly string[]).includes("openai-codex/gpt-6-*"),
    "the gpt-6 family pattern must never be granted",
  );
  assert.deepEqual(
    allowListAdmitsProhibitedModel(["openai-codex/gpt-6-*"], INSTALLED_MODEL_IDS),
    ["openai-codex/gpt-6-astra"],
  );

  // So Astra is still rejected under the real allow list, explicitly and
  // inherited alike, even though its two siblings are now granted.
  for (const source of ["explicit", "inherited"] as const) {
    const decision = resolveDelegationModel({ model: "openai-codex/gpt-6-astra", source });
    assert.equal(decision.ok, false);
    assert.ok(!decision.ok);
    assert.equal(decision.code, "out_of_scope");
  }
});

// ---------------------------------------------------------------------------
// Unavailability: reported failure, never silent substitution
// ---------------------------------------------------------------------------

const UNAVAILABLE_CASES: Array<[string, ModelCondition, string]> = [
  [
    "unavailable",
    { kind: "unavailable", detail: "quota exhausted for this account." },
    "unavailable",
  ],
  [
    "throttled",
    { kind: "throttled", retryAfterSeconds: 42, detail: "rate limited." },
    "throttled",
  ],
  [
    "call failure",
    { kind: "call-failure", detail: "upstream 500." },
    "call_failure",
  ],
];

for (const [label, condition, expectedCode] of UNAVAILABLE_CASES) {
  test(`a ${label} model produces a reported failure, never a silent substitution`, () => {
    const double = createProviderDouble({
      [GOOD]: condition,
      // A perfectly good alternative the harness must NOT quietly switch to.
      "anthropic/claude-opus-5": { kind: "available" },
    });

    const decision = resolveDelegationModel({
      model: GOOD,
      source: "explicit",
      availability: (m) => double.call(m),
    });

    assert.ok(!decision.ok);
    assert.equal(decision.code, expectedCode);
    // The failure names the model actually requested.
    assert.equal(decision.requestedModel, GOOD);
    assert.match(decision.message, /No substitute model was selected/);
    // Proof of no substitution: the alternative was never even probed.
    assert.deepEqual(
      double.calls.map((c) => c.model),
      [GOOD],
    );
  });
}

test("throttling reports its retry hint rather than swapping models", () => {
  const double = createProviderDouble({
    [GOOD]: { kind: "throttled", retryAfterSeconds: 30, detail: "slow down." },
  });
  const decision = resolveDelegationModel({
    model: GOOD,
    source: "explicit",
    availability: (m) => double.call(m),
  });
  assert.ok(!decision.ok);
  assert.equal(decision.retryAfterSeconds, 30);
});

test("an available model resolves through the double unchanged", () => {
  const double = createProviderDouble({ [GOOD]: { kind: "available" } });
  const decision = resolveDelegationModel({
    model: GOOD,
    source: "explicit",
    availability: (m) => double.call(m),
  });
  assert.ok(decision.ok);
  assert.equal(decision.baseModel, GOOD);
});

// ---------------------------------------------------------------------------
// Provider double
// ---------------------------------------------------------------------------

test("the provider double simulates its conditions reproducibly", () => {
  const spec: Record<string, ModelCondition> = {
    [GOOD]: { kind: "available", inputUsdPerMTok: 3, outputUsdPerMTok: 15 },
    "anthropic/claude-opus-5": { kind: "available" },
    "openai-codex/gpt-5.6-terra": { kind: "unavailable", detail: "quota exhausted." },
    "openai-codex/gpt-5.5": { kind: "throttled", retryAfterSeconds: 10, detail: "rate limited." },
    "openai-codex/gpt-5.6-sol": { kind: "call-failure", detail: "upstream 500." },
  };

  // Same spec, two independent doubles, identical observations -> deterministic.
  for (const double of [createProviderDouble(spec), createProviderDouble(spec)]) {
    assert.equal(double.availability(GOOD).status, "available");
    assert.equal(double.availability("openai-codex/gpt-5.6-terra").status, "unavailable");
    assert.equal(double.availability("openai-codex/gpt-5.5").status, "throttled");
    assert.equal(double.availability("openai-codex/gpt-5.5").retryAfterSeconds, 10);
    assert.equal(double.availability("openai-codex/gpt-5.6-sol").status, "call-failure");
    // A real registry id the spec says nothing about: absent is its own status,
    // never a silent "available".
    assert.equal(double.availability("anthropic/claude-sonnet-4-6").status, "unknown-model");

    // Pricing gap: unknown must not be reported as free.
    assert.deepEqual(double.pricing(GOOD), {
      known: true,
      inputUsdPerMTok: 3,
      outputUsdPerMTok: 15,
    });
    assert.deepEqual(double.pricing("anthropic/claude-opus-5"), { known: false });
    assert.deepEqual(double.pricing("openai-codex/gpt-5.6-terra"), { known: false });
  }

  // Repeated calls are stable, and calls are recorded for substitution checks.
  const double = createProviderDouble(spec);
  const observed = [1, 2, 3].map(() => double.call("openai-codex/gpt-5.5").status);
  assert.deepEqual(observed, ["throttled", "throttled", "throttled"]);
  assert.equal(double.calls.length, 3);
  double.reset();
  assert.equal(double.calls.length, 0);
});
