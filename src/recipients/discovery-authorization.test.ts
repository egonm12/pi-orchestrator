import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildCatalog } from "../catalog/model-catalog.ts";
import { onlyModels, withTaskSuitability } from "../fixtures/catalog-facts.ts";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import { createProviderDouble, type ModelCondition } from "../fixtures/provider-double.ts";
import {
  allowedCandidates,
  type Picker,
  type Stage1Input,
} from "../routing/routing-policy.ts";
import type { RiskAssessment } from "../routing/classifier.ts";
import {
  approvedRecipients,
  authorizeRecipient,
  DEFAULT_RECIPIENTS_PATH,
  discoverProviders,
  discoverProvidersFromModelIds,
  emptyAuthorization,
  grantOwnerApproval,
  isAuthorizedRecipient,
  loadAuthorization,
  loadAuthorizationOrEmpty,
  RECIPIENTS_SCHEMA_VERSION,
  reviewDiscovery,
  saveAuthorization,
  UnapprovedAuthorizationError,
  type OwnerApproval,
  type RecipientAuthorization,
} from "./authorization.ts";
import {
  checkRecipient,
  delegateNamedModel,
  delegateWithSwitch,
  formatRecipientRecord,
  formatSwitchRecord,
  NO_BUDGET_CONSTRAINT,
  privacyConstraintFor,
  providerOf,
  RECIPIENT_RECORD_PREFIX,
  recordRecipientOutcome,
  SWITCH_RECORD_PREFIX,
  type BudgetConstraint,
  type BudgetVerdict,
} from "./authorized-delegation.ts";
import {
  canReassign,
  checkpointRun,
  completeRun,
  markStarted,
  planRun,
  reassignRun,
  reconcileRun,
  stopRun,
} from "./run-state.ts";
import { useOwnerBanLists } from "../fixtures/owner-ban-lists.ts";

useOwnerBanLists();

const here = dirname(fileURLToPath(import.meta.url));

// Real ids from this installation's registry (fixtures/installed-models.ts),
// with their real pinned prices (USD per 1M input tokens) noted so the
// cheap/expensive relationships below are grounded in the snapshot.
const OPUS = "anthropic/claude-opus-4-7"; //          $5.00
const SONNET = "anthropic/claude-sonnet-5"; //        $2.00
const HAIKU = "anthropic/claude-haiku-4-5"; //        $1.00
const CODEX = "openai-codex/gpt-5.6-sol"; //          $4.00
const LUNA = "openai-codex/gpt-5.6-luna"; //          $0.20
const PROHIBITED = "anthropic/claude-fable-5"; //     $10.00

const CLAUDE = "anthropic";
const OPENAI = "openai-codex";

const baseCatalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS] });

const TASK_TYPE = "implementation";

/** An assessment with an exact tier and confidence, so these tests drive the
 *  candidate boundary directly instead of depending on classifier wording. */
function assessmentWith(
  riskTier: RiskAssessment["riskTier"],
  confidence = 0.95,
): RiskAssessment {
  return {
    riskTier,
    ambiguity: "clear",
    confidence,
    signals: [],
    rationale: `fixed assessment for tests (${riskTier})`,
    signalCounts: {
      "security-sensitive": 0,
      destructive: 0,
      "public-behavior": 0,
      mechanical: 0,
      ambiguity: 0,
    },
    classifierBasis: "first-pass-heuristic-unvalidated",
  };
}

/** Owner approval, minted the only way the module allows. */
function approval(scope: OwnerApproval["scope"] = "data-recipient"): OwnerApproval {
  return grantOwnerApproval({
    approvedBy: "owner (test fixture)",
    scope,
    acknowledgement: `test fixture approves ${scope}`,
    grantedAt: "2026-09-21T00:00:00.000Z",
  });
}

function authorizedFor(
  providers: readonly string[],
  scope: OwnerApproval["scope"] = "data-recipient",
): RecipientAuthorization {
  let auth = emptyAuthorization();
  for (const provider of providers) {
    auth = authorizeRecipient(auth, provider, approval(scope));
  }
  return auth;
}

/** Catalog restricted to `models`, with suitability evidence overlaid so
 *  stage 1 can admit anything at all. The builder always leaves suitability
 *  unknown, which is correct and is why the overlay exists (ticket 06). */
function catalogWith(scores: Readonly<Record<string, number>>) {
  const models = Object.keys(scores);
  const perTaskType: Record<string, Record<string, number>> = {};
  for (const [model, score] of Object.entries(scores)) {
    perTaskType[model] = { [TASK_TYPE]: score };
  }
  return withTaskSuitability(onlyModels(baseCatalog, models), perTaskType);
}

/** SONNET evidenced, HAIKU in the catalog with no suitability evidence, so
 *  stage 1 rejects HAIKU on capability grounds. Ticket 24 removed the
 *  per-tier floor, so a low score no longer does that; missing evidence still
 *  does on this legacy path. */
function stage1RejectingHaiku(): Stage1Input {
  return {
    ...stage1For({ [SONNET]: 0.95 }),
    catalog: withTaskSuitability(onlyModels(baseCatalog, [SONNET, HAIKU]), { [SONNET]: { [TASK_TYPE]: 0.95 } }),
  };
}

function stage1For(
  scores: Readonly<Record<string, number>>,
  tier: RiskAssessment["riskTier"] = "standard",
): Stage1Input {
  return {
    request: {
      taskDescription: "implement the change",
      taskType: TASK_TYPE,
      assessment: assessmentWith(tier),
    },
    catalog: catalogWith(scores),
  };
}

function tempStateDir(): { dir: string; path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-recipients-"));
  return {
    dir,
    path: join(dir, "authorized-recipients.json"),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Check-driven ticket-07 fixture that explicitly implements delegation admission. */
function testBudget(
  describe: string,
  check: (model: string) => BudgetVerdict,
): BudgetConstraint {
  return {
    describe,
    check,
    admitDelegation(model) {
      const verdict = check(model);
      return verdict.ok
        ? { ok: true, admission: { kind: "no-budget-constraint" } }
        : { ok: false, ...(verdict.why === undefined ? {} : { why: verdict.why }) };
    },
  };
}

// ===========================================================================
// Checklist 1: configured providers are discovered WITHOUT becoming
//              authorized recipients
// ===========================================================================

test("discovery sees every configured provider", () => {
  const discovered = discoverProviders(baseCatalog);
  const names = discovered.map((d) => d.provider);
  assert.deepEqual(names, [CLAUDE, OPENAI]);
  // Discovery reports what exists, models included.
  const claude = discovered.find((d) => d.provider === CLAUDE);
  assert.ok(claude);
  assert.ok(claude.models.includes(SONNET));
  assert.equal(claude.discoveredVia, "model-catalog");
});

test("discovery from the installed registry is also just discovery", () => {
  const discovered = discoverProvidersFromModelIds(INSTALLED_MODEL_IDS);
  assert.deepEqual(discovered.map((d) => d.provider), [CLAUDE, OPENAI]);
  for (const entry of discovered) {
    assert.equal(entry.discoveredVia, "installed-registry");
  }
});

test("the authorized set starts empty even though discovery is not", () => {
  const discovered = discoverProviders(baseCatalog);
  assert.ok(discovered.length > 0, "discovery must find something for this test to mean anything");
  assert.deepEqual(approvedRecipients(emptyAuthorization()), []);
});

test("reviewDiscovery makes the gap between the two sets explicit", () => {
  const auth = authorizedFor([CLAUDE]);
  const report = reviewDiscovery(discoverProviders(baseCatalog), auth);
  assert.deepEqual(report.authorized, [CLAUDE]);
  assert.deepEqual(report.discoveredButUnauthorized, [OPENAI]);
  assert.deepEqual(report.authorizedButUndiscovered, []);
});

test("an approval for an undiscovered provider does not conjure the provider", () => {
  const auth = authorizedFor(["some-unconfigured-provider"]);
  const report = reviewDiscovery(discoverProviders(baseCatalog), auth);
  assert.deepEqual(report.authorizedButUndiscovered, ["some-unconfigured-provider"]);
});

test("a discovered-but-unapproved provider is rejected by stage 1, with a recorded reason", () => {
  // Both providers are discovered and both have glowing suitability evidence.
  // Only one is an approved recipient.
  const input = stage1For({ [SONNET]: 0.95, [CODEX]: 0.99 });
  const auth = authorizedFor([CLAUDE]);
  const allowed = allowedCandidates({
    ...input,
    request: { ...input.request, privacy: privacyConstraintFor(auth) },
  });
  assert.deepEqual(allowed.admitted.map((c) => c.model), [SONNET]);
  const rejectedCodex = allowed.rejected.find((c) => c.model === CODEX);
  assert.ok(rejectedCodex, "the unapproved provider's model must appear as rejected");
  assert.ok(
    rejectedCodex.rejectedBecause.some((r) => r.includes("not an approved data recipient")),
    `expected a recipient rejection reason, got ${JSON.stringify(rejectedCodex.rejectedBecause)}`,
  );
  // And it was rejected despite being the BETTER candidate on evidence, which
  // is what makes the recipient constraint non-negotiable rather than a tiebreak.
  assert.ok(rejectedCodex.suitability.state === "evidenced");
  assert.equal(rejectedCodex.suitability.score, 0.99);
});

test("the recipients view is frozen, so a consumer cannot add one through it", () => {
  const view = approvedRecipients(authorizedFor([CLAUDE]));
  assert.throws(() => {
    (view as string[]).push(OPENAI);
  }, TypeError);
  assert.deepEqual(view, [CLAUDE]);
});

test("a missing store fails closed: no recipients, not all discovered ones", () => {
  const state = tempStateDir();
  try {
    const auth = loadAuthorizationOrEmpty(join(state.dir, "does-not-exist.json"));
    assert.deepEqual(approvedRecipients(auth), []);
  } finally {
    state.cleanup();
  }
});

test("an unreadable store also fails closed rather than open", () => {
  const state = tempStateDir();
  try {
    saveAuthorization(state.path, authorizedFor([CLAUDE]));
    // Corrupt it.
    saveAuthorization(state.path, JSON.parse("{}") as RecipientAuthorization);
    const auth = loadAuthorizationOrEmpty(state.path);
    assert.deepEqual(approvedRecipients(auth), []);
  } finally {
    state.cleanup();
  }
});

test("authorization survives a save/load round trip with its approval metadata", () => {
  const state = tempStateDir();
  try {
    const auth = authorizeRecipient(
      emptyAuthorization(),
      CLAUDE,
      approval(),
      "already in active use this session",
    );
    saveAuthorization(state.path, auth);
    const reloaded = loadAuthorization(state.path);
    assert.equal(reloaded.schemaVersion, RECIPIENTS_SCHEMA_VERSION);
    const entry = reloaded.recipients.find((r) => r.provider === CLAUDE);
    assert.ok(entry);
    assert.equal(entry.approvedBy, "owner (test fixture)");
    assert.equal(entry.grantedAt, "2026-09-21T00:00:00.000Z");
    assert.equal(entry.scope, "data-recipient");
    assert.equal(entry.note, "already in active use this session");
    assert.ok(isAuthorizedRecipient(reloaded, CLAUDE));
  } finally {
    state.cleanup();
  }
});

test("a store written by a future schema is rejected, not silently misread", () => {
  const state = tempStateDir();
  try {
    saveAuthorization(state.path, {
      schemaVersion: RECIPIENTS_SCHEMA_VERSION + 1,
      recipients: [],
    });
    assert.throws(() => loadAuthorization(state.path), /schemaVersion/);
  } finally {
    state.cleanup();
  }
});

test("the default store path is runtime state, and git-ignores it", () => {
  assert.equal(DEFAULT_RECIPIENTS_PATH, "src/state/authorized-recipients.json");
  const ignored = readFileSync(join(here, "..", "..", ".gitignore"), "utf8");
  assert.ok(
    ignored.split("\n").includes("src/state/"),
    "src/state/ must stay git-ignored: an authorization store is runtime state",
  );
});

// ===========================================================================
// Checklist 2: a delegate to an unapproved recipient does not execute
// ===========================================================================

test("a delegate to an unapproved recipient is refused at the boundary", () => {
  const outcome = delegateNamedModel({
    model: CODEX,
    authorization: authorizedFor([CLAUDE]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unauthorized_recipient");
  assert.match(outcome.message, /not an approved data recipient/);
  assert.match(outcome.message, /Approved recipients: anthropic/);
});

test("the refusal names what discovery does and does not establish", () => {
  const check = checkRecipient(OPENAI, authorizedFor([CLAUDE]));
  assert.equal(check.ok, false);
  assert.match(check.message, /establishes only that it exists/);
  assert.match(check.message, /requires explicit owner approval/);
});

test("an approved recipient does delegation, so the gate is not refusing everything", () => {
  const outcome = delegateNamedModel({
    model: SONNET,
    authorization: authorizedFor([CLAUDE]),
  });
  assert.equal(outcome.ok, true);
  assert.ok(outcome.ok);
  assert.equal(outcome.delegation.provider, CLAUDE);
  assert.equal(outcome.delegation.baseModel, SONNET);
  assert.equal(outcome.approval.approvedBy, "owner (test fixture)");
});

test("with nothing approved, nothing delegations", () => {
  for (const model of [SONNET, CODEX, HAIKU, LUNA]) {
    const outcome = delegateNamedModel({ model, authorization: emptyAuthorization() });
    assert.equal(outcome.ok, false, `${model} must not delegate with an empty authorization`);
    assert.equal(outcome.code, "unauthorized_recipient");
    assert.match(outcome.message, /Approved recipients: none/);
  }
});

test("an explicitly named prohibited model is rejected without probing or substitution", () => {
  let availabilityCalls = 0;
  const outcome = delegateNamedModel({
    model: PROHIBITED,
    authorization: authorizedFor([CLAUDE]),
    availability: () => { availabilityCalls++; return { status: "available" }; },
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "resolver_rejected");
  assert.equal(outcome.delegation?.ok, false);
  if (outcome.delegation?.ok === false) {
    assert.equal(outcome.delegation.code, "out_of_scope");
    assert.equal(outcome.delegation.requestedModel, PROHIBITED);
  }
  assert.equal(availabilityCalls, 0, "a prohibited explicit model is not replaced with another model");
});

test("the recipient gate does not become the prohibition gate: ticket 04 still rejects first", () => {
  // The provider IS approved. The model is still prohibited, and it is
  // reported as prohibited rather than as a recipient problem.
  const outcome = delegateNamedModel({
    model: PROHIBITED,
    authorization: authorizedFor([CLAUDE]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "resolver_rejected");
  assert.ok(outcome.delegation && !outcome.delegation.ok);
  assert.equal(outcome.delegation.code, "out_of_scope");
});

test("a missing model is still rejected as missing, not as unauthorized", () => {
  const outcome = delegateNamedModel({
    model: undefined,
    authorization: authorizedFor([CLAUDE, OPENAI]),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "resolver_rejected");
  assert.ok(outcome.delegation && !outcome.delegation.ok);
  assert.equal(outcome.delegation.code, "missing_model");
});

test("a rogue picker cannot smuggle an unauthorized recipient past the delegation boundary", () => {
  // Stage 1 narrowing is the first line. This proves the SECOND check is real:
  // a picker that returns a model stage 1 never admitted is still refused.
  const rogue: Picker = () => ({
    model: CODEX,
    reason: "rogue picker returning a model stage 1 rejected",
    cheapenedOnCostEvidence: false,
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [SONNET]: 0.95, [CODEX]: 0.99 }),
    authorization: authorizedFor([CLAUDE]),
    picker: rogue,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unauthorized_recipient");
  assert.match(outcome.message, /openai-codex/);
});

test("an unauthorized recipient is reported as itself, never switched around", () => {
  // The refusal must not be quietly converted into "try the next model".
  const rogue: Picker = () => ({
    model: CODEX,
    reason: "rogue",
    cheapenedOnCostEvidence: false,
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [SONNET]: 0.95, [CODEX]: 0.99 }),
    authorization: authorizedFor([CLAUDE]),
    picker: rogue,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unauthorized_recipient");
  // No switch report, because no switch happened.
  assert.ok(!("switched" in outcome && outcome.switched));
});

test("a rogue picker cannot widen the capability ceiling either, even at an approved recipient", () => {
  // The recipient gate above cannot see this one: HAIKU is at an approved
  // recipient and resolves fine. It is out because stage 1 found no
  // suitability evidence for it, and only the candidate set knows that.
  const rogue: Picker = () => ({
    model: HAIKU,
    reason: "rogue picker returning a model stage 1 rejected on capability",
    cheapenedOnCostEvidence: false,
  });
  const outcome = delegateWithSwitch({
    stage1: stage1RejectingHaiku(),
    authorization: authorizedFor([CLAUDE]),
    picker: rogue,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "selector_error");
  assert.match(outcome.message, /rules-computed candidate set does not contain/);
  assert.match(outcome.message, /not\s+widened to accommodate it/);
  assert.ok(!("switched" in outcome && outcome.switched), "a rejected pick is not a switch");
});

test("a spending hold taken for an out-of-set pick is released, not left open", () => {
  const released: string[] = [];
  let issued = 0;
  const budget: BudgetConstraint = {
    describe: "test allowance that records its releases",
    check: () => ({ ok: true }),
    admitDelegation(model) {
      issued += 1;
      return {
        ok: true,
        admission: {
          kind: "reservation",
          reservationId: `res-${issued}`,
          model,
          reservation: { reservationId: `res-${issued}`, model },
          release: () => void released.push(model),
          reconcile: () => assert.fail("a refused delegation must not reconcile"),
        },
      };
    },
  };
  const rogue: Picker = () => ({
    model: HAIKU,
    reason: "rogue",
    cheapenedOnCostEvidence: false,
  });
  const outcome = delegateWithSwitch({
    stage1: stage1RejectingHaiku(),
    authorization: authorizedFor([CLAUDE]),
    picker: rogue,
    budget,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "selector_error");
  assert.deepEqual(released, [HAIKU], "the hold for the discarded pick was released");
});

test("routing through the store blocks entirely when no recipient is approved", () => {
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [SONNET]: 0.95, [CODEX]: 0.99 }),
    authorization: emptyAuthorization(),
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no_authorized_candidate");
  assert.deepEqual(outcome.approvedRecipients, []);
});

// ===========================================================================
// Checklist 3: adding a recipient, integration, or credential requires
//              explicit approval
// ===========================================================================

test("a forged approval object is refused even with every field filled in", () => {
  const forged = {
    approvedBy: "routing code",
    grantedAt: new Date().toISOString(),
    scope: "data-recipient",
    acknowledgement: "looks exactly like a real approval",
  } as OwnerApproval;
  assert.throws(
    () => authorizeRecipient(emptyAuthorization(), OPENAI, forged),
    (error: unknown) => {
      assert.ok(error instanceof UnapprovedAuthorizationError);
      assert.match(error.message, /not granted through grantOwnerApproval/);
      assert.match(error.message, /Discovery is not authorization/);
      return true;
    },
  );
});

test("a structurally identical clone of a real approval is still refused", () => {
  // Proves the gate is not checking shape. The clone has identical fields and
  // came from a real approval, but it was not the object that was granted.
  const real = approval();
  const clone = { ...real } as OwnerApproval;
  assert.deepEqual(clone, real);
  assert.doesNotThrow(() => authorizeRecipient(emptyAuthorization(), OPENAI, real));
  assert.throws(
    () => authorizeRecipient(emptyAuthorization(), OPENAI, clone),
    UnapprovedAuthorizationError,
  );
});

test("an approval must name who approved it and what they approved", () => {
  assert.throws(
    () =>
      grantOwnerApproval({ approvedBy: "  ", scope: "data-recipient", acknowledgement: "x" }),
    /must name who approved it/,
  );
  assert.throws(
    () =>
      grantOwnerApproval({ approvedBy: "owner", scope: "data-recipient", acknowledgement: " " }),
    /must state what was approved/,
  );
  assert.throws(
    () =>
      grantOwnerApproval({
        approvedBy: "owner",
        // deliberately outside the union, as an untyped caller could pass
        scope: "whatever" as OwnerApproval["scope"],
        acknowledgement: "x",
      }),
    /unknown approval scope/,
  );
});

// `subject` is how a per-instance gate (ticket 11's infrastructure recovery)
// binds an approval to one instance without parsing the owner's prose.
test("an approval's subject is optional, trimmed, and never blank when present", () => {
  const unscoped = grantOwnerApproval({
    approvedBy: "owner",
    scope: "data-recipient",
    acknowledgement: "send data to openai",
  });
  assert.equal(unscoped.subject, undefined, "a gate with no instance leaves it unset");

  const bound = grantOwnerApproval({
    approvedBy: "owner",
    scope: "infrastructure-recovery",
    acknowledgement: "retry it once",
    subject: "  infra-1  ",
  });
  assert.equal(bound.subject, "infra-1");

  assert.throws(
    () =>
      grantOwnerApproval({
        approvedBy: "owner",
        scope: "infrastructure-recovery",
        acknowledgement: "retry it once",
        subject: "   ",
      }),
    /must name a non-blank one/,
    "a blank subject is a hollow binding, not an unset one",
  );
});

test("approving an integration is not approving it as a data recipient", () => {
  const auth = authorizedFor([OPENAI], "integration");
  assert.equal(auth.recipients.length, 1, "the integration approval was recorded");
  assert.equal(isAuthorizedRecipient(auth, OPENAI), false);
  assert.deepEqual(approvedRecipients(auth), []);
  const outcome = delegateNamedModel({ model: CODEX, authorization: auth });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unauthorized_recipient");
});

test("approving a credential is not approving it as a data recipient either", () => {
  const auth = authorizedFor([OPENAI], "credential");
  assert.equal(isAuthorizedRecipient(auth, OPENAI), false);
  const outcome = delegateNamedModel({ model: CODEX, authorization: auth });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "unauthorized_recipient");
});

test("authorizing returns a new store and never widens the one it was given", () => {
  const before = authorizedFor([CLAUDE]);
  const after = authorizeRecipient(before, OPENAI, approval());
  assert.deepEqual(approvedRecipients(before), [CLAUDE]);
  assert.deepEqual(approvedRecipients(after), [CLAUDE, OPENAI]);
});

test("a caller's privacy constraint can narrow the approved set but not widen it", () => {
  const auth = authorizedFor([CLAUDE]);
  const widened = privacyConstraintFor(auth, { approvedRecipients: [CLAUDE, OPENAI] });
  assert.deepEqual(widened.approvedRecipients, [CLAUDE], "the caller must not add a recipient");
  const narrowed = privacyConstraintFor(authorizedFor([CLAUDE, OPENAI]), {
    approvedRecipients: [CLAUDE],
  });
  assert.deepEqual(narrowed.approvedRecipients, [CLAUDE], "the caller may narrow");
});

test("routing and catalog code cannot mutate the authorization store", () => {
  // Structural, in the same shape ticket 06 used for self-reported confidence:
  // the mutators are not reachable from the modules that must not call them.
  const mutators = ["grantOwnerApproval", "authorizeRecipient", "saveAuthorization"];
  const sources = [
    "routing/routing-policy.ts",
    "routing/classifier.ts",
    "catalog/model-catalog.ts",
    "catalog/epistemic.ts",
  ];
  for (const relative of sources) {
    const source = readFileSync(join(here, "..", relative), "utf8");
    for (const mutator of mutators) {
      assert.ok(
        !source.includes(mutator),
        `${relative} must not reference ${mutator}: routing and catalog code may read the approved set, never write it`,
      );
    }
  }
});

test("the approval registry is module-private, so no import can reach it", () => {
  const source = readFileSync(join(here, "authorization.ts"), "utf8");
  assert.ok(
    /^const grantedApprovals = new WeakSet/m.test(source),
    "the granted-approval registry must be a module-scoped const",
  );
  assert.ok(
    !/export\s+(const\s+)?grantedApprovals/.test(source),
    "the granted-approval registry must never be exported",
  );
});

// ===========================================================================
// Checklist 4: a permitted pre-delegation switch happens, is reported, and still
//              satisfies recipient, capability and budget constraints
// ===========================================================================

/** Availability probe from the double, recording every model it is asked
 *  about so "a model was never reached" is observable. */
function doubleFor(spec: Readonly<Record<string, ModelCondition>>) {
  const double = createProviderDouble(spec);
  return { double, probe: (model: string) => double.call(model) };
}

test("capacity exhausted before delegation switches to an authorized alternative", () => {
  const { double, probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "quota exhausted for this billing period" },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
  });
  const outcome = delegateWithSwitch({
    // OPUS scores higher, so the picker chooses it first.
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });

  assert.ok(outcome.ok, `expected a switched delegation, got ${JSON.stringify(outcome)}`);
  assert.equal(outcome.routing.ok && outcome.routing.model, OPUS, "the first choice was OPUS");
  assert.equal(outcome.model, SONNET, "the delegation went to the alternative");

  const report = outcome.switched;
  assert.ok(report, "a switch must be reported, never silent");
  assert.equal(report.from, OPUS);
  assert.equal(report.to, SONNET);
  assert.match(report.reason, /not usable at delegation time/);
  assert.ok(
    report.consideredAndRefused.some(
      (r) => r.model === OPUS && r.why.includes("quota exhausted"),
    ),
    `the original's failure must be recorded, got ${JSON.stringify(report.consideredAndRefused)}`,
  );
  // Both models really were probed, so the switch is a consequence of an
  // observed condition rather than of a configured outcome.
  assert.deepEqual(double.calls.map((c) => c.model), [OPUS, SONNET]);
});

test("the switch report names the recipient, capability and budget constraints it satisfied", () => {
  const budget = testBudget(
    "test allowance: $5 shared across the task",
    () => ({ ok: true }),
  );
  const { probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
    budget,
  });
  assert.ok(outcome.ok);
  const report = outcome.switched;
  assert.ok(report);
  assert.deepEqual(report.recipientConstraint, [CLAUDE]);
  assert.equal(report.budgetApplied, "test allowance: $5 shared across the task");
  assert.match(report.capabilityBasis, /evidenced suitability/);
  assert.equal(outcome.budgetApplied, "test allowance: $5 shared across the task");
});

test("throttling and call failure are switch triggers too", () => {
  for (const condition of [
    { kind: "throttled", retryAfterSeconds: 30, detail: "rate limited" } as const,
    { kind: "call-failure", detail: "upstream 500" } as const,
  ]) {
    const { probe } = doubleFor({
      [OPUS]: condition,
      [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
    });
    const outcome = delegateWithSwitch({
      stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
      authorization: authorizedFor([CLAUDE]),
      delegationAvailability: probe,
    });
    assert.ok(outcome.ok, `${condition.kind} should permit a switch`);
    assert.equal(outcome.model, SONNET);
    assert.ok(outcome.switched);
  }
});

test("a capability-suitable alternative at an unapproved recipient is refused, not used", () => {
  // CODEX has the BEST evidence of all three and is available. It is also not
  // an approved recipient, so the switch must not reach for it.
  const { double, probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
    [CODEX]: { kind: "available", inputUsdPerMTok: 4 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9, [CODEX]: 0.99 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });

  assert.ok(outcome.ok);
  assert.equal(outcome.model, SONNET, "the switch stayed inside the approved recipient");
  // Observable proof the better-but-unapproved model was never reached: the
  // double records every probe, and CODEX is absent from them.
  assert.ok(
    !double.calls.some((c) => c.model === CODEX),
    `the unapproved provider must never be called, got ${JSON.stringify(double.calls)}`,
  );
  // And stage 1 recorded WHY it was out.
  assert.ok(outcome.routing.ok);
  const rejected = outcome.routing.allowed.rejected.find((c) => c.model === CODEX);
  assert.ok(rejected);
  assert.ok(rejected.rejectedBecause.some((r) => r.includes("not an approved data recipient")));
});

test("the switch respects the budget constraint it is given", () => {
  const { double, probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
    [HAIKU]: { kind: "available", inputUsdPerMTok: 1 },
  });
  const budget = testBudget(
    "test allowance that refuses SONNET",
    (model) =>
      model === SONNET
        ? { ok: false, why: "remaining allowance cannot cover this model" }
        : { ok: true },
  );
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9, [HAIKU]: 0.85 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
    budget,
  });

  assert.ok(outcome.ok);
  assert.equal(outcome.model, HAIKU, "the over-budget alternative was skipped");
  const report = outcome.switched;
  assert.ok(report);
  assert.ok(
    report.consideredAndRefused.some(
      (r) => r.model === SONNET && r.why.includes("remaining allowance"),
    ),
    `the budget refusal must be recorded, got ${JSON.stringify(report.consideredAndRefused)}`,
  );
  assert.ok(double.calls.some((c) => c.model === HAIKU));
});

test("an over-budget first choice can itself trigger a reported switch", () => {
  const { probe } = doubleFor({
    [OPUS]: { kind: "available", inputUsdPerMTok: 5 },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
  });
  const budget = testBudget(
    "test allowance that refuses OPUS",
    (model) => (model === OPUS ? { ok: false, why: "over the allowance" } : { ok: true }),
  );
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
    budget,
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.model, SONNET);
  assert.ok(outcome.switched);
  assert.ok(
    outcome.switched.consideredAndRefused.some((r) => r.model === OPUS && r.why.includes("over the allowance")),
  );
});

test("no authorized alternative produces a blocker, not a weakened assignment", () => {
  const { double, probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [SONNET]: { kind: "unavailable", detail: "exhausted" },
    [CODEX]: { kind: "available", inputUsdPerMTok: 4 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9, [CODEX]: 0.99 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no_authorized_alternative");
  assert.match(outcome.message, /no unapproved recipient was used/);
  assert.equal(outcome.consideredAndRefused?.length, 2);
  // The available unapproved model was never called.
  assert.ok(!double.calls.some((c) => c.model === CODEX));
});

test("no switch is reported when the first choice worked", () => {
  const { probe } = doubleFor({ [SONNET]: { kind: "available", inputUsdPerMTok: 2 } });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [SONNET]: 0.95 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.model, SONNET);
  assert.equal(outcome.switched, undefined, "a switch record must mean a switch happened");
});

test("the absence of a budget constraint is stated, not implied to be an approval", () => {
  const { probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });
  assert.ok(outcome.ok);
  assert.equal(outcome.budgetApplied, NO_BUDGET_CONSTRAINT.describe);
  assert.match(outcome.budgetApplied, /no spending constraint applied/);
  assert.ok(outcome.switched);
  assert.match(outcome.switched.budgetApplied, /ticket 09 owns allowance accounting/);
});

test("a switch cannot land on a prohibited model even with the best evidence", () => {
  // Routing excludes prohibited candidates before the capacity-switch path can
  // consider them, even when the probe says they are available.
  const { probe } = doubleFor({
    [OPUS]: { kind: "unavailable", detail: "exhausted" },
    [PROHIBITED]: { kind: "available", inputUsdPerMTok: 10 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [OPUS]: 0.99, [PROHIBITED]: 0.98 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.code, "no_authorized_alternative");
  assert.ok(outcome.consideredAndRefused?.every((candidate) => candidate.model !== PROHIBITED));
});

test("a prohibited first choice is excluded before delegation or switching", () => {
  // The allowed OPUS candidate remains usable; exclusion must not block or
  // substitute when an ordinary candidate is available.
  const { probe } = doubleFor({
    [PROHIBITED]: { kind: "available", inputUsdPerMTok: 10 },
    [OPUS]: { kind: "available", inputUsdPerMTok: 5 },
  });
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [PROHIBITED]: 0.99, [OPUS]: 0.98 }),
    authorization: authorizedFor([CLAUDE]),
    delegationAvailability: probe,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.delegation.baseModel, OPUS);
  assert.notEqual(outcome.delegation.baseModel, PROHIBITED);
});

test("the switch and delegate records are observable JSONL", () => {
  const state = tempStateDir();
  try {
    const { probe } = doubleFor({
      [OPUS]: { kind: "unavailable", detail: "exhausted" },
      [SONNET]: { kind: "available", inputUsdPerMTok: 2 },
    });
    const outcome = delegateWithSwitch({
      stage1: stage1For({ [OPUS]: 0.98, [SONNET]: 0.9 }),
      authorization: authorizedFor([CLAUDE]),
      delegationAvailability: probe,
    });
    assert.ok(outcome.ok);
    assert.ok(outcome.switched);

    const line = formatSwitchRecord(outcome.switched);
    assert.ok(line.startsWith(SWITCH_RECORD_PREFIX));
    const parsed = JSON.parse(line.slice(SWITCH_RECORD_PREFIX.length)) as {
      from: string;
      to: string;
    };
    assert.equal(parsed.from, OPUS);
    assert.equal(parsed.to, SONNET);

    const auditPath = join(state.dir, "audit.jsonl");
    recordRecipientOutcome(auditPath, outcome);
    const written = readFileSync(auditPath, "utf8").trim();
    assert.ok(written.startsWith(RECIPIENT_RECORD_PREFIX));
    const record = JSON.parse(written.slice(RECIPIENT_RECORD_PREFIX.length)) as {
      model: string;
      switched: { from: string } | null;
      approvedRecipients: string[];
    };
    assert.equal(record.model, SONNET);
    assert.equal(record.switched?.from, OPUS);
    assert.deepEqual(record.approvedRecipients, [CLAUDE]);
  } finally {
    state.cleanup();
  }
});

test("a refusal record is observable too", () => {
  const outcome = delegateWithSwitch({
    stage1: stage1For({ [SONNET]: 0.95 }),
    authorization: emptyAuthorization(),
  });
  assert.equal(outcome.ok, false);
  const line = formatRecipientRecord(outcome);
  const record = JSON.parse(line.slice(RECIPIENT_RECORD_PREFIX.length)) as {
    ok: boolean;
    code: string;
    approvedRecipients: string[];
  };
  assert.equal(record.ok, false);
  assert.equal(record.code, "no_authorized_candidate");
  assert.deepEqual(record.approvedRecipients, []);
});

test("providerOf reads the identity ticket 04 established", () => {
  assert.equal(providerOf(SONNET), CLAUDE);
  assert.equal(providerOf(CODEX), OPENAI);
  assert.equal(providerOf("no-slash"), "");
});

// ===========================================================================
// Checklist 5: reassigning already-started work stops or checkpoints and
//              reconciles first, with no duplicated effects
// ===========================================================================

function startedRun() {
  const planned = planRun({
    runId: "run-1",
    taskId: "task-1",
    model: OPUS,
    at: "2026-09-21T10:00:00.000Z",
  });
  const started = markStarted(planned, "2026-09-21T10:00:01.000Z");
  assert.ok(started.ok);
  return started.state;
}

test("a started run records exactly one delegation", () => {
  const run = startedRun();
  assert.equal(run.phase, "started");
  assert.deepEqual(run.delegations, [{ model: OPUS, startedAt: "2026-09-21T10:00:01.000Z" }]);
});

test("starting the same run twice is refused, so a delegation cannot be duplicated", () => {
  const run = startedRun();
  const again = markStarted(run);
  assert.equal(again.ok, false);
  assert.ok(!again.ok);
  assert.equal(again.code, "already_started");
  assert.equal(again.state.delegations.length, 1, "the refused start must add no delegation");
});

test("reassigning started work is refused, with no second delegation", () => {
  const run = startedRun();
  const attempt = reassignRun(run, SONNET);
  assert.equal(attempt.ok, false);
  assert.ok(!attempt.ok);
  assert.equal(attempt.code, "unreconciled_work");
  assert.match(attempt.message, /Stop or checkpoint it and reconcile/);
  assert.match(attempt.message, /would repeat actions the first one may already have taken/);
  // Nothing changed: same phase, same model, same single delegation.
  assert.equal(attempt.state.phase, "started");
  assert.equal(attempt.state.model, OPUS);
  assert.deepEqual(attempt.state.delegations, run.delegations);
  assert.equal(canReassign(attempt.state), false);
});

test("stopping alone is not enough: reconciliation is still required", () => {
  const run = startedRun();
  const stopped = stopRun(run, "capacity exhausted mid-run");
  assert.ok(stopped.ok);
  assert.equal(stopped.state.phase, "stopped");
  const attempt = reassignRun(stopped.state, SONNET);
  assert.equal(attempt.ok, false);
  assert.ok(!attempt.ok);
  assert.equal(attempt.code, "not_reconciled");
  assert.equal(attempt.state.delegations.length, 1);
});

test("checkpointing alone is not enough either", () => {
  const run = startedRun();
  const checkpointed = checkpointRun(run, ["edited src/a.ts", "ran the test suite"]);
  assert.ok(checkpointed.ok);
  assert.equal(checkpointed.state.phase, "checkpointed");
  const attempt = reassignRun(checkpointed.state, SONNET);
  assert.equal(attempt.ok, false);
  assert.ok(!attempt.ok);
  assert.equal(attempt.code, "not_reconciled");
});

test("stop or checkpoint, then reconcile, then reassignment is permitted", () => {
  const run = startedRun();
  const checkpointed = checkpointRun(run, ["edited src/a.ts"], "2026-09-21T10:05:00.000Z");
  assert.ok(checkpointed.ok);
  const reconciled = reconcileRun(checkpointed.state, "2026-09-21T10:06:00.000Z");
  assert.ok(reconciled.ok);
  assert.equal(reconciled.state.phase, "reconciled");
  assert.deepEqual(reconciled.state.reconciledActions, ["edited src/a.ts"]);
  assert.equal(canReassign(reconciled.state), true);

  const reassigned = reassignRun(reconciled.state, SONNET, "2026-09-21T10:07:00.000Z");
  assert.ok(reassigned.ok);
  assert.equal(reassigned.state.phase, "planned");
  assert.equal(reassigned.state.model, SONNET);
  // Reassignment does not delegate. The count is still 1 until the new run
  // is actually started.
  assert.equal(reassigned.state.delegations.length, 1);

  const restarted = markStarted(reassigned.state, "2026-09-21T10:07:01.000Z");
  assert.ok(restarted.ok);
  assert.deepEqual(restarted.state.delegations, [
    { model: OPUS, startedAt: "2026-09-21T10:00:01.000Z" },
    { model: SONNET, startedAt: "2026-09-21T10:07:01.000Z" },
  ]);
  // What the first model already did survives into the second assignment, so
  // the replacement can avoid repeating it.
  assert.deepEqual(restarted.state.reconciledActions, ["edited src/a.ts"]);
});

test("reconciling a still-running run is refused", () => {
  const run = startedRun();
  const attempt = reconcileRun(run);
  assert.equal(attempt.ok, false);
  assert.ok(!attempt.ok);
  assert.equal(attempt.code, "nothing_to_reconcile");
  assert.match(attempt.message, /still executing cannot be reconciled/);
});

test("the full history of an interrupted-and-reassigned run is retained", () => {
  const run = startedRun();
  const stopped = stopRun(run, "quota exhausted");
  assert.ok(stopped.ok);
  const reconciled = reconcileRun(stopped.state);
  assert.ok(reconciled.ok);
  const reassigned = reassignRun(reconciled.state, SONNET);
  assert.ok(reassigned.ok);
  assert.deepEqual(
    reassigned.state.history.map((e) => e.kind),
    ["planned", "started", "stopped", "reconciled", "reassigned"],
  );
});

test("a completed run cannot be started again", () => {
  const run = startedRun();
  const completed = completeRun(run);
  assert.ok(completed.ok);
  const again = markStarted(completed.state);
  assert.equal(again.ok, false);
  assert.ok(!again.ok);
  assert.equal(again.code, "already_completed");
  assert.equal(again.state.delegations.length, 1);
});

test("run state rejects prohibited models at plan, start and reassignment boundaries", () => {
  for (const model of [
    "anthropic/claude-opus-fable-6",
    "openai-codex/gpt-5.7-Astra",
    "anthropic/claude-fable-5",
  ]) {
    let planError: unknown;
    try {
      planRun({ runId: "blocked", taskId: "t", model });
    } catch (cause) {
      planError = cause;
    }
    assert.ok(planError instanceof Error);
    assert.match(planError.message, /prohibited/);
    assert.equal((planError as Error & { code: string }).code, "prohibited_model");

    const allowedPlan = planRun({ runId: "allowed", taskId: "t", model: OPUS });
    const forged = { ...allowedPlan, model };
    const start = markStarted(forged);
    assert.equal(start.ok, false);
    if (!start.ok) assert.equal(start.code, "prohibited_model");

    // Reassignment is only eligible after the original work was reconciled.
    const started = markStarted(allowedPlan);
    assert.ok(started.ok);
    const stopped = stopRun(started.state, "test interruption");
    assert.ok(stopped.ok);
    const reconciled = reconcileRun(stopped.state);
    assert.ok(reconciled.ok);
    const reassigned = reassignRun(reconciled.state, model);
    assert.equal(reassigned.ok, false);
    if (!reassigned.ok) {
      assert.equal(reassigned.code, "prohibited_model");
      assert.equal(reassigned.state, reconciled.state);
    }
  }
  assert.equal(markStarted(planRun({ runId: "allowed", taskId: "t", model: OPUS })).ok, true);
});

test("only a started run can be stopped, checkpointed or completed", () => {
  const planned = planRun({ runId: "r", taskId: "t", model: OPUS });
  for (const transition of [
    stopRun(planned, "why"),
    checkpointRun(planned, []),
    completeRun(planned),
  ]) {
    assert.equal(transition.ok, false);
    assert.ok(!transition.ok);
    assert.equal(transition.code, "not_started");
  }
});
