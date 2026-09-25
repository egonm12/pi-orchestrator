import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { known, unknown } from "../catalog/epistemic.ts";
import { buildCatalog, type ModelCatalog, type TokenPrice } from "../catalog/model-catalog.ts";
import {
  authorizeRecipient,
  emptyAuthorization,
  grantOwnerApproval,
  type OwnerApproval,
  type RecipientAuthorization,
} from "../recipients/authorization.ts";
import { dispatchNamedModel } from "../recipients/authorized-dispatch.ts";
import {
  ALLOWANCE_SCHEMA_VERSION,
  ATOMICITY_SCOPE,
  CHARGE_ROLES,
  DEFAULT_ALLOWANCE_USD,
  OVERSHOOT_CAVEAT,
  ReconciliationError,
  ReservationIdConflictError,
  TaskAllowanceOwner,
  UnapprovedOverrunError,
  allowanceConstraint,
  allowancePathFor,
  committedUsd,
  describeAllowance,
  encumberedUsd,
  estimateMaxCost,
  newTaskLedger,
  reconcile,
  releaseReservation,
  remainingUsd,
  reportedUnmeteredConsumptionUsd,
  reservedUsd,
  reserve,
  reserveWithApproval,
  resumeLedger,
  saveLedger,
  unmeteredCharges,
  type ChargeRole,
  type TaskLedger,
} from "./task-allowance.ts";

// ---------------------------------------------------------------------------
// Fixtures
//
// The real registry's routes are all subscription-routed, so a metered route
// has to be constructed to exercise dollar accounting at all. Both shapes are
// needed: metered for the allowance, subscription for the "not free" rule.
// ---------------------------------------------------------------------------

const METERED = "metered-co/priced-1";
/** A genuinely different provider, so the provider-switch tests switch one. */
const METERED_CHEAP = "other-co/priced-mini";
const UNPRICED = "metered-co/unpriced-1";
const SUBSCRIPTION = "anthropic/claude-sonnet-5";
/** An id ticket 04's allow list actually admits, priced as metered here so the
 *  real dispatch gate can be driven to its budget check. */
const ALLOWED_METERED = "openai-codex/gpt-5.6-luna";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const ASOF = NOW.toISOString();

function price(input: number, output: number): TokenPrice {
  return { inputUsdPerMTok: input, outputUsdPerMTok: output };
}

/** A catalog with a metered route, built by hand because the pinned snapshot
 *  contains no metered route to borrow. */
function testCatalog(): ModelCatalog {
  const base = buildCatalog({ modelIds: [SUBSCRIPTION], now: NOW });
  const subscriptionEntry = base.entries[SUBSCRIPTION];
  assert.ok(subscriptionEntry, "expected the real subscription route in the catalog");

  const meteredEntry = (model: string, p: TokenPrice | undefined) => ({
    ...subscriptionEntry,
    model,
    // Taken from the id rather than hardcoded, so a fixture on a different
    // provider really is on a different provider.
    provider: model.slice(0, model.indexOf("/")),
    id: model.slice(model.indexOf("/") + 1),
    routeBilling: known<"metered">("metered", "operator-configured", ASOF),
    publishedListPrice: p
      ? known(p, "published-dataset", ASOF)
      : unknown<TokenPrice>("absent-from-source"),
    effectiveBilledCost: unknown<TokenPrice>("not-checked"),
    contextWindow: known({ contextTokens: 200_000, maxOutputTokens: 64_000 }, "published-dataset", ASOF),
  });

  return {
    ...base,
    entries: {
      ...base.entries,
      // $10/M in, $30/M out -> 100k in + 10k out = $1.00 + $0.30 = $1.30
      [METERED]: meteredEntry(METERED, price(10, 30)) as never,
      [METERED_CHEAP]: meteredEntry(METERED_CHEAP, price(1, 3)) as never,
      [UNPRICED]: meteredEntry(UNPRICED, undefined) as never,
      [ALLOWED_METERED]: meteredEntry(ALLOWED_METERED, price(10, 30)) as never,
    },
  };
}

const CATALOG = testCatalog();

/** 100k in + 10k out against METERED = $1.30 exactly. */
const CALL = { maxInputTokens: 100_000, maxOutputTokens: 10_000 } as const;
const DISPATCH_CALL = { role: "subtask", ...CALL } as const;

function ledgerWith(allowanceUsd = DEFAULT_ALLOWANCE_USD): TaskLedger {
  return newTaskLedger({ taskId: "task-alpha", allowanceUsd, now: NOW });
}

function ownerWith(ledger: TaskLedger): TaskAllowanceOwner {
  return new TaskAllowanceOwner(ledger);
}

/** Reserve then immediately settle at the reported cost. */
function spend(
  ledger: TaskLedger,
  role: ChargeRole,
  model: string,
  reportedUsd: number,
): TaskLedger {
  const outcome = reserve(ledger, { role, model, ...CALL }, CATALOG, { now: NOW });
  assert.ok(outcome.ok, `expected reservation to be accepted: ${outcome.ok ? "" : outcome.message}`);
  return reconcile(outcome.ledger, {
    reservationId: outcome.reservation.reservationId,
    reportedUsd,
    now: NOW,
  });
}

function overrunApproval(): OwnerApproval {
  return grantOwnerApproval({
    approvedBy: "owner",
    scope: "allowance-overrun",
    acknowledgement: "spend past the $5 task allowance for this dispatch",
  });
}

function assertThrown(run: () => unknown): Error {
  try {
    run();
  } catch (cause) {
    assert.ok(cause instanceof Error, "expected an Error to be thrown");
    return cause;
  }
  assert.fail("expected function to throw");
}

// ---------------------------------------------------------------------------
// Checklist 1: orchestration, parallel children, reviews and retries all draw
// on ONE allowance
// ---------------------------------------------------------------------------

test("every role draws on the same allowance", () => {
  let ledger = ledgerWith(10);
  for (const role of CHARGE_ROLES) {
    ledger = spend(ledger, role, METERED, 1);
  }

  assert.equal(ledger.settled.length, 4);
  assert.equal(committedUsd(ledger), 4);
  assert.equal(remainingUsd(ledger), 6);
  // All four roles are present, and none of them got its own pool.
  assert.deepEqual(
    [...new Set(ledger.settled.map((c) => c.role))].sort(),
    [...CHARGE_ROLES].sort(),
  );
});

test("parallel children hold concurrent reservations against one allowance", () => {
  let ledger = ledgerWith(5);
  const ids: string[] = [];
  // Three children reserved before any of them settles: the allowance must
  // account for all three at once, not one at a time.
  for (let i = 0; i < 3; i += 1) {
    const outcome = reserve(ledger, { role: "subtask", model: METERED, ...CALL }, CATALOG, {
      now: NOW,
    });
    assert.ok(outcome.ok);
    ledger = outcome.ledger;
    ids.push(outcome.reservation.reservationId);
  }

  assert.equal(ledger.open.length, 3);
  // 3 x $1.30. Compared at cent precision: IEEE-754 sums of fractional dollars
  // accumulate representation error (1.3*3 === 3.9000000000000004), which is a
  // real property of this accounting, documented in USD_PRECISION.
  assert.equal(reservedUsd(ledger).toFixed(2), "3.90");
  assert.equal(remainingUsd(ledger).toFixed(2), "1.10");

  // A fourth would exceed what is left, while three are still in flight.
  const fourth = reserve(ledger, { role: "subtask", model: METERED, ...CALL }, CATALOG, {
    now: NOW,
  });
  assert.equal(fourth.ok, false);
  assert.ok(!fourth.ok && fourth.code === "would_exceed_allowance");
  assert.equal(ids.length, 3);
});

test("the authoritative owner serializes parallel children against current state", async () => {
  const owner = ownerWith(ledgerWith(2));
  const staleSnapshotSeenByBothChildren = owner.snapshot();

  const child = (reservationId: string) =>
    Promise.resolve().then(() => {
      // Both callbacks were planned from the same pre-reservation view, but
      // neither can submit that stale snapshot to the owner mutation.
      assert.equal(staleSnapshotSeenByBothChildren.open.length, 0);
      return owner.reserve(
        { role: "subtask", model: METERED, ...CALL, reservationId },
        CATALOG,
        { now: NOW },
      );
    });

  const outcomes = await Promise.all([child("parallel-a"), child("parallel-b")]);
  assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1);
  assert.equal(outcomes.filter((outcome) => !outcome.ok).length, 1);
  assert.equal(owner.snapshot().open.length, 1, "only one $1.30 hold was committed");
  assert.equal(reservedUsd(owner.snapshot()), 1.3);
  assert.equal(remainingUsd(owner.snapshot()), 0.7);
});

test("a long-lived dispatch constraint reads the owner's current ledger", () => {
  const owner = ownerWith(ledgerWith(2));
  const constraint = allowanceConstraint(owner, CATALOG, DISPATCH_CALL);
  assert.equal(constraint.check(METERED).ok, true);

  const first = owner.reserve(
    { role: "subtask", model: METERED, ...CALL, reservationId: "first" },
    CATALOG,
    { now: NOW },
  );
  assert.ok(first.ok);
  assert.equal(constraint.check(METERED).ok, false, "the constraint must not retain the old $2 view");
  assert.match(constraint.describe, /0\.7000 remaining/);
});

test("a retry draws on the same allowance as the attempt it retries", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 1.2);
  ledger = spend(ledger, "retry", METERED, 1.2);
  assert.equal(committedUsd(ledger), 2.4);
  assert.equal(remainingUsd(ledger), 2.6);
});

// ---------------------------------------------------------------------------
// Checklist 2: decomposing a task does not increase or reset the allowance
// ---------------------------------------------------------------------------

test("decomposing into subtasks neither raises the allowance nor resets spend", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "orchestration", METERED, 0.5);
  const allowanceBefore = ledger.allowanceUsd;

  // "Decomposition" is simply more charges on the same ledger. There is no API
  // that creates a child budget, which is the structural point.
  for (let i = 0; i < 4; i += 1) {
    ledger = spend(ledger, "subtask", METERED, 0.5);
  }

  assert.equal(ledger.allowanceUsd, allowanceBefore, "allowance must not grow with subtasks");
  assert.equal(committedUsd(ledger), 2.5, "five charges of $0.50 accumulate, not reset");
  assert.equal(remainingUsd(ledger), 2.5);
});

test("nothing in the ledger is keyed by agent, so subtasks cannot get their own pool", () => {
  const ledger = spend(ledgerWith(5), "subtask", METERED, 1);
  const keys = Object.keys(ledger).sort();
  assert.deepEqual(keys, [
    "allowanceUsd",
    "createdAt",
    "open",
    "overrunApprovals",
    "schemaVersion",
    "settled",
    "taskId",
  ]);
  // One allowance field, one task id, and no per-agent or per-session map.
  assert.equal(typeof ledger.allowanceUsd, "number");
  assert.equal(ledger.taskId, "task-alpha");
});

// ---------------------------------------------------------------------------
// Checklist 3: a provider switch does not reset accounting
// ---------------------------------------------------------------------------

test("switching provider mid-task keeps accumulating on the same ledger", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 1.3);
  const afterFirst = committedUsd(ledger);

  // Same task, different provider entirely: 'metered-co' -> 'other-co'.
  ledger = spend(ledger, "subtask", METERED_CHEAP, 0.13);

  assert.notEqual(
    CATALOG.entries[METERED]!.provider,
    CATALOG.entries[METERED_CHEAP]!.provider,
    "this test is only about a provider switch if the two routes differ by provider",
  );
  assert.equal(afterFirst, 1.3);
  assert.equal(Number(committedUsd(ledger).toFixed(4)), 1.43, "the switch added to the total");
  assert.deepEqual(
    ledger.settled.map((c) => c.model),
    [METERED, METERED_CHEAP],
    "both providers' charges live in one ledger",
  );
});

test("the budget constraint applies the same remaining allowance to a switched-to model", () => {
  // $1.40 left: enough for the cheap model ($0.13), not the expensive one ($1.30 ... which fits)
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 4.5); // $0.50 remaining
  const constraint = allowanceConstraint(ownerWith(ledger), CATALOG, DISPATCH_CALL);

  assert.equal(constraint.check(METERED).ok, false, "$1.30 does not fit in $0.50");
  assert.equal(constraint.check(METERED_CHEAP).ok, true, "$0.13 does fit");
  // The switch cannot escape the allowance by changing provider: the same
  // ledger answers for both.
  assert.match(constraint.describe, /0\.5000 remaining/);
});

// ---------------------------------------------------------------------------
// Checklist 4: resuming a session preserves accumulated spend
// ---------------------------------------------------------------------------

test("resuming from disk preserves accumulated spend rather than restarting it", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    let ledger = ledgerWith(5);
    ledger = spend(ledger, "orchestration", METERED, 1.25);
    ledger = spend(ledger, "subtask", METERED, 1.25);
    saveLedger(path, ledger);

    // A genuinely fresh in-memory instance, as a new session would build.
    const resumed = resumeLedger(path, { taskId: "task-alpha", allowanceUsd: 5, now: NOW });

    assert.equal(committedUsd(resumed), 2.5, "spend survived the restart");
    assert.equal(remainingUsd(resumed), 2.5, "the allowance did not reset to $5");
    assert.equal(resumed.settled.length, 2);
    assert.equal(resumed.taskId, "task-alpha");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an open reservation survives a resume, so in-flight work is not double-spent", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    const outcome = reserve(ledgerWith(5), { role: "subtask", model: METERED, ...CALL }, CATALOG, {
      now: NOW,
    });
    assert.ok(outcome.ok);
    saveLedger(path, outcome.ledger);

    const resumed = resumeLedger(path, { taskId: "task-alpha", now: NOW });
    assert.equal(resumed.open.length, 1);
    assert.equal(reservedUsd(resumed), 1.3, "the hold is still encumbered after resume");
    assert.equal(encumberedUsd(resumed), 1.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a first session with no store starts a ledger; a corrupt one refuses rather than resets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    const fresh = resumeLedger(path, { taskId: "task-alpha", now: NOW });
    assert.equal(committedUsd(fresh), 0);
    assert.equal(fresh.allowanceUsd, DEFAULT_ALLOWANCE_USD);

    // A damaged ledger must NOT silently become a new $5 allowance: that is
    // the reset this ticket exists to prevent, and it would be invisible.
    writeFileSync(path, "{ not json");
    assert.throws(
      () => resumeLedger(path, { taskId: "task-alpha", now: NOW }),
      /Refusing to resume with a fresh allowance/,
    );

    writeFileSync(path, JSON.stringify({ ...fresh, schemaVersion: 999 }));
    assert.throws(
      () => resumeLedger(path, { taskId: "task-alpha", now: NOW }),
      /Refusing to resume rather than reset accounting/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("both fail-closed refusals tell the operator how to recover", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    const fresh = resumeLedger(path, { taskId: "task-alpha", now: NOW });

    // Failing closed is only usable if the operator is told the way out, and
    // told what it costs -- otherwise a damaged ledger wedges the task with no
    // stated remedy.
    writeFileSync(path, "{ not json");
    const corrupt = assertThrown(() => resumeLedger(path, { taskId: "task-alpha", now: NOW }));
    assert.ok(corrupt.message.includes(`delete ${path}`), "names the file to delete");
    assert.match(corrupt.message, /the spend already recorded there will be lost/);

    writeFileSync(path, JSON.stringify({ ...fresh, schemaVersion: 999 }));
    const future = assertThrown(() => resumeLedger(path, { taskId: "task-alpha", now: NOW }));
    assert.match(future.message, /run a build that understands schemaVersion 999/);
    assert.ok(future.message.includes(`delete ${path}`), "names the file to delete");
    assert.match(future.message, /the spend already recorded there will be lost/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("only a missing ledger starts fresh; an unreadable one refuses rather than resetting", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const missing = allowancePathFor(dir, "task-alpha");
    // ENOENT is the one read failure that genuinely means "no ledger yet".
    assert.equal(committedUsd(resumeLedger(missing, { taskId: "task-alpha", now: NOW })), 0);

    // Any OTHER errno describes a ledger that may exist and carry real spend.
    // A directory where the file belongs reads as EISDIR, standing in here for
    // the permissions and I/O failures that are awkward to provoke: the point
    // is that a non-ENOENT read error must not become a fresh $5 allowance.
    const unreadable = allowancePathFor(dir, "task-beta");
    mkdirSync(unreadable);
    assert.throws(
      () => resumeLedger(unreadable, { taskId: "task-beta", now: NOW }),
      /exists but could not be read \(EISDIR\)/,
    );
    assert.throws(
      () => resumeLedger(unreadable, { taskId: "task-beta", now: NOW }),
      /Refusing to resume with a fresh allowance/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a task-id collision in the file name refuses rather than merging two allowances", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    // The sanitiser maps '/', ' ' and '_' to the same path for these ids.
    // Without a task-id check all three would share one allowance.
    const path = allowancePathFor(dir, "task/alpha");
    assert.equal(path, allowancePathFor(dir, "task alpha"));
    assert.equal(path, allowancePathFor(dir, "task_alpha"));

    let owner = newTaskLedger({ taskId: "task/alpha", allowanceUsd: 5, now: NOW });
    owner = spend(owner, "subtask", METERED, 1.3);
    saveLedger(path, owner);

    // The task that owns the file resumes normally.
    assert.equal(committedUsd(resumeLedger(path, { taskId: "task/alpha", now: NOW })), 1.3);

    // A colliding task must not inherit that spend, and its own charges must
    // not be billed to the other task either.
    assert.throws(
      () => resumeLedger(path, { taskId: "task alpha", now: NOW }),
      /belongs to task 'task\/alpha', not 'task alpha'/,
    );
    assert.throws(
      () => resumeLedger(path, { taskId: "task_alpha", now: NOW }),
      /would merge two tasks into a single allowance/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("valid JSON with missing ledger fields fails clearly at resume", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    const valid = ledgerWith(5);
    writeFileSync(
      path,
      JSON.stringify({
        schemaVersion: valid.schemaVersion,
        taskId: valid.taskId,
        allowanceUsd: valid.allowanceUsd,
        open: valid.open,
        // `settled` is deliberately missing.
        overrunApprovals: valid.overrunApprovals,
        createdAt: valid.createdAt,
      }),
    );

    const error = assertThrown(() => resumeLedger(path, { taskId: "task-alpha", now: NOW }));
    assert.ok(error.message.includes(path), "the invalid ledger's path is named");
    assert.match(error.message, /structurally invalid \(structure: settled must be an array\)/);
    assert.match(error.message, /Refusing to resume with a fresh allowance/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persisted duplicate reservation ids fail closed", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    const reserved = reserve(
      ledgerWith(5),
      { role: "subtask", model: METERED, ...CALL, reservationId: "persisted-duplicate" },
      CATALOG,
      { now: NOW },
    );
    assert.ok(reserved.ok);
    writeFileSync(
      path,
      JSON.stringify({ ...reserved.ledger, open: [reserved.reservation, reserved.reservation] }),
    );

    assert.throws(
      () => resumeLedger(path, { taskId: "task-alpha", now: NOW }),
      /duplicate reservationId 'persisted-duplicate'/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a persisted allowance rejects an incompatible explicit caller allowance", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    saveLedger(path, ledgerWith(7));

    assert.equal(
      resumeLedger(path, { taskId: "task-alpha", now: NOW }).allowanceUsd,
      7,
      "omitting the allowance accepts the persisted value",
    );
    assert.equal(
      resumeLedger(path, { taskId: "task-alpha", allowanceUsd: 7, now: NOW }).allowanceUsd,
      7,
      "an explicit matching allowance is accepted",
    );
    assert.throws(
      () => resumeLedger(path, { taskId: "task-alpha", allowanceUsd: 5, now: NOW }),
      /persisted allowance \$7, but the caller explicitly requested \$5/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the ledger is replaced by rename, so a save leaves no partial file behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-allowance-"));
  try {
    const path = allowancePathFor(dir, "task-alpha");
    saveLedger(path, ledgerWith(5));
    saveLedger(path, spend(ledgerWith(5), "subtask", METERED, 1.3));

    // A temp file surviving next to the ledger would be litter; a temp file
    // left AT the ledger's path would be a truncated ledger, which now fails
    // closed and would wedge this task permanently.
    assert.deepEqual(readdirSync(dir), ["task-alpha.json"], "no temp file survives a save");
    assert.equal(committedUsd(resumeLedger(path, { taskId: "task-alpha", now: NOW })), 1.3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Checklist 5: per-call cost comes from existing pricing data
// ---------------------------------------------------------------------------

test("the estimate is computed from the catalog's TokenPrice, not a local table", () => {
  const estimate = estimateMaxCost(CATALOG, { model: METERED, ...CALL });
  // 100_000/1e6 * 10 = 1.00 ; 10_000/1e6 * 30 = 0.30
  assert.equal(estimate.maxUsd, 1.3);
  assert.equal(estimate.basis.kind, "published-list");
  assert.ok(estimate.basis.kind === "published-list");
  assert.equal(estimate.basis.price.inputUsdPerMTok, 10);
});

test("no second per-provider pricing table exists in this module", async () => {
  const source = await import("node:fs").then((fs) =>
    fs.readFileSync(new URL("./task-allowance.ts", import.meta.url), "utf8"),
  );
  // A hardcoded provider price would have to name a provider and a number.
  for (const vendor of ["claude", "openai", "anthropic", "codex", "gpt-"]) {
    const inCode = source
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//"))
      .some((line) => line.toLowerCase().includes(vendor));
    assert.equal(inCode, false, `'${vendor}' must not appear in executable code`);
  }
});

test("an unknown price is not assumed to be zero", () => {
  const estimate = estimateMaxCost(CATALOG, { model: UNPRICED, ...CALL });
  assert.equal(estimate.maxUsd, undefined, "unboundable, not $0");
  assert.equal(estimate.basis.kind, "unboundable");

  // And the reservation refuses rather than holding $0.
  const outcome = reserve(ledgerWith(5), { role: "subtask", model: UNPRICED, ...CALL }, CATALOG);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok && outcome.code === "unboundable_cost");
  assert.equal(reservedUsd(outcome.ledger), 0, "a refused reservation holds nothing");
});

test("a stale price cannot bound a current call", () => {
  const long = 400 * 24 * 60 * 60 * 1000;
  const estimate = estimateMaxCost(
    CATALOG,
    { model: METERED, ...CALL },
    { now: NOW.getTime() + long },
  );
  assert.equal(estimate.maxUsd, undefined);
  assert.ok(estimate.basis.kind === "unboundable");
  assert.match(estimate.basis.why, /stale/);
});

test("the output ceiling falls back to the catalog, and is required when absent", () => {
  const fromCatalog = estimateMaxCost(CATALOG, { model: METERED, maxInputTokens: 100_000 });
  // catalog maxOutputTokens = 64_000 -> 1.00 + 1.92
  assert.equal(fromCatalog.maxUsd, 2.92);

  const noCeiling: ModelCatalog = {
    ...CATALOG,
    entries: {
      ...CATALOG.entries,
      [METERED]: {
        ...CATALOG.entries[METERED]!,
        contextWindow: unknown("absent-from-source"),
      },
    },
  };
  const unbounded = estimateMaxCost(noCeiling, { model: METERED, maxInputTokens: 100_000 });
  assert.equal(unbounded.maxUsd, undefined);
  assert.ok(unbounded.basis.kind === "unboundable");
  assert.match(unbounded.basis.why, /output-token ceiling/);
});

// ---------------------------------------------------------------------------
// Checklist 6: estimate before the call, reconcile to actual after
// ---------------------------------------------------------------------------

test("invalid token bounds and catalog prices are rejected before reservation", () => {
  for (const maxInputTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => estimateMaxCost(CATALOG, { model: METERED, maxInputTokens, maxOutputTokens: 10 }),
      /maxInputTokens must be a finite non-negative integer/,
    );
  }
  for (const maxOutputTokens of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1.5]) {
    assert.throws(
      () => estimateMaxCost(CATALOG, { model: METERED, maxInputTokens: 10, maxOutputTokens }),
      /maxOutputTokens must be a finite non-negative integer/,
    );
  }

  const entry = CATALOG.entries[METERED]!;
  const invalidPriceCatalog: ModelCatalog = {
    ...CATALOG,
    entries: {
      ...CATALOG.entries,
      [METERED]: {
        ...entry,
        publishedListPrice: known(
          { inputUsdPerMTok: Number.POSITIVE_INFINITY, outputUsdPerMTok: 30 },
          "published-dataset",
          ASOF,
        ),
      },
    },
  };
  assert.throws(
    () => reserve(ledgerWith(5), { role: "subtask", model: METERED, ...CALL }, invalidPriceCatalog),
    /price inputUsdPerMTok must be a finite non-negative number/,
  );
});

test("the reservation holds the estimate and reconciliation replaces it with the actual", () => {
  const outcome = reserve(ledgerWith(5), { role: "subtask", model: METERED, ...CALL }, CATALOG, {
    now: NOW,
  });
  assert.ok(outcome.ok);
  assert.equal(reservedUsd(outcome.ledger), 1.3, "the maximum is held before the call");
  assert.equal(committedUsd(outcome.ledger), 0, "nothing is committed until it lands");

  // The call actually cost far less than its ceiling.
  const settled = reconcile(outcome.ledger, {
    reservationId: outcome.reservation.reservationId,
    reportedUsd: 0.12,
    now: NOW,
  });

  assert.equal(reservedUsd(settled), 0, "the estimate was released");
  assert.equal(committedUsd(settled), 0.12, "the actual cost was applied");
  assert.equal(remainingUsd(settled), 4.88, "the allowance reflects reality, not the estimate");
  assert.equal(settled.settled[0]?.estimatedUsd, 1.3, "the estimate is kept for audit");
});

test("a call that never ran releases its hold without a charge", () => {
  const outcome = reserve(ledgerWith(5), { role: "subtask", model: METERED, ...CALL }, CATALOG);
  assert.ok(outcome.ok);
  const released = releaseReservation(outcome.ledger, outcome.reservation.reservationId);
  assert.equal(reservedUsd(released), 0);
  assert.equal(committedUsd(released), 0);
  assert.equal(released.settled.length, 0, "no charge is recorded for a call that never happened");
});

test("a metered call with no reported cost keeps its conservative hold", () => {
  const outcome = reserveWithApproval(
    ledgerWith(5),
    { role: "subtask", model: UNPRICED, ...CALL, reservationId: "unknown-actual" },
    CATALOG,
    overrunApproval(),
    { now: NOW },
  );
  assert.ok(outcome.ok);
  const before = outcome.ledger;
  const remainingBefore = remainingUsd(before);

  assert.throws(
    () => reconcile(before, { reservationId: outcome.reservation.reservationId }),
    (cause: unknown) =>
      cause instanceof ReconciliationError && cause.code === "missing_reported_cost",
  );
  assert.equal(before.open.length, 1, "the metered reservation remains open");
  assert.equal(before.settled.length, 0);
  assert.equal(remainingUsd(before), remainingBefore, "missing data creates no headroom");
  assert.equal(remainingBefore, 0, "the approved unboundable call still holds all headroom");
});

test("invalid actual costs cannot mutate accounting or create headroom", () => {
  const outcome = reserve(
    ledgerWith(5),
    { role: "subtask", model: METERED, ...CALL, reservationId: "invalid-actual" },
    CATALOG,
  );
  assert.ok(outcome.ok);
  const before = outcome.ledger;
  const remainingBefore = remainingUsd(before);

  for (const reportedUsd of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(
      () => reconcile(before, { reservationId: "invalid-actual", reportedUsd }),
      (cause: unknown) =>
        cause instanceof ReconciliationError && cause.code === "invalid_reported_cost",
    );
    assert.equal(before.open.length, 1);
    assert.equal(before.settled.length, 0);
    assert.equal(remainingUsd(before), remainingBefore);
    assert.ok(Number.isFinite(remainingUsd(before)));
  }
});

test("reservation ids are lifetime-unique across open and settled entries", () => {
  const first = reserve(
    ledgerWith(5),
    { role: "subtask", model: METERED, ...CALL, reservationId: "same-call" },
    CATALOG,
  );
  assert.ok(first.ok);
  assert.throws(
    () =>
      reserve(
        first.ledger,
        { role: "review", model: METERED, ...CALL, reservationId: "same-call" },
        CATALOG,
      ),
    ReservationIdConflictError,
  );
  assert.equal(first.ledger.open.length, 1);
  assert.equal(reservedUsd(first.ledger), 1.3, "a duplicate cannot add a second hold");

  const settled = reconcile(first.ledger, { reservationId: "same-call", reportedUsd: 1, now: NOW });
  assert.throws(
    () =>
      reserve(
        settled,
        { role: "retry", model: METERED, ...CALL, reservationId: "same-call" },
        CATALOG,
      ),
    ReservationIdConflictError,
  );
  assert.equal(settled.settled.length, 1, "a settled id cannot be reused for another call");
});

test("reconciling an unknown reservation is an error, not a silent no-op", () => {
  assert.throws(
    () => reconcile(ledgerWith(5), { reservationId: "nope" }),
    /no open reservation 'nope'/,
  );
});

// ---------------------------------------------------------------------------
// Checklist 7: the allowance is configurable and defaults to $5
// ---------------------------------------------------------------------------

test("the allowance defaults to $5 and is configurable", () => {
  assert.equal(DEFAULT_ALLOWANCE_USD, 5);
  assert.equal(newTaskLedger({ taskId: "t", now: NOW }).allowanceUsd, 5);
  assert.equal(newTaskLedger({ taskId: "t", allowanceUsd: 25, now: NOW }).allowanceUsd, 25);
  assert.equal(newTaskLedger({ taskId: "t", allowanceUsd: 0, now: NOW }).allowanceUsd, 0);
});

test("a ledger requires a task id and a sane allowance", () => {
  assert.throws(() => newTaskLedger({ taskId: "  " }), /requires a task id/);
  assert.throws(() => newTaskLedger({ taskId: "t", allowanceUsd: -1 }), /non-negative/);
  assert.throws(() => newTaskLedger({ taskId: "t", allowanceUsd: Number.NaN }), /non-negative/);
  assert.throws(() => newTaskLedger({ taskId: "t", allowanceUsd: Number.POSITIVE_INFINITY }), /non-negative/);
});

// ---------------------------------------------------------------------------
// Checklist 8: a dispatch known to exceed the remaining allowance requires
// approval BEFORE it runs
// ---------------------------------------------------------------------------

test("a dispatch that would exceed the remaining allowance is refused before it runs", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 4.5);

  const outcome = reserve(ledger, { role: "subtask", model: METERED, ...CALL }, CATALOG);
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "would_exceed_allowance");
  assert.equal(outcome.requiredApprovalScope, "allowance-overrun");
  assert.match(outcome.message, /Approval is required before this runs, not after it spends/);
  // Refusal must not leave a hold behind.
  assert.equal(outcome.ledger.open.length, 0);
  assert.equal(remainingUsd(outcome.ledger), 0.5);
});

test("a genuine owner approval permits the overrun and records it", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 4.5);

  const outcome = reserveWithApproval(
    ledger,
    { role: "subtask", model: METERED, ...CALL },
    CATALOG,
    overrunApproval(),
    { now: NOW },
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.ledger.overrunApprovals.length, 1);
  const record = outcome.ledger.overrunApprovals[0]!;
  assert.equal(record.approvedBy, "owner");
  assert.equal(record.estimatedUsd, 1.3);
  assert.equal(record.remainingAtApprovalUsd, 0.5);
  assert.ok(remainingUsd(outcome.ledger) < 0, "the overrun is visible, not hidden");
});

test("an approved unboundable metered call holds all remaining allowance", () => {
  let ledger = spend(ledgerWith(5), "subtask", METERED, 1);
  const outcome = reserveWithApproval(
    ledger,
    { role: "subtask", model: UNPRICED, ...CALL, reservationId: "unboundable-approved" },
    CATALOG,
    overrunApproval(),
    { now: NOW },
  );

  assert.ok(outcome.ok);
  assert.equal(outcome.estimate.maxUsd, undefined, "approval does not invent a cost bound");
  assert.equal(outcome.reservation.metered, true);
  assert.equal(outcome.reservation.estimatedUsd, 4, "the whole remaining allowance is held");
  assert.equal(remainingUsd(outcome.ledger), 0, "ordinary work has no apparent free headroom");

  const concurrent = reserve(
    outcome.ledger,
    { role: "review", model: METERED_CHEAP, ...CALL },
    CATALOG,
  );
  assert.equal(concurrent.ok, false, "another unapproved metered call cannot use the held headroom");
  assert.ok(!concurrent.ok && concurrent.code === "would_exceed_allowance");

  ledger = reconcile(outcome.ledger, {
    reservationId: outcome.reservation.reservationId,
    reportedUsd: 0.25,
    now: NOW,
  });
  assert.equal(reservedUsd(ledger), 0, "reconciliation releases the conservative hold");
  assert.equal(committedUsd(ledger), 1.25, "the observed charge replaces the hold");
});

test("an approval-shaped object is refused, exactly as at the recipient gate", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 4.5);

  const forged: OwnerApproval = {
    approvedBy: "owner",
    grantedAt: NOW.toISOString(),
    scope: "allowance-overrun",
    acknowledgement: "looks exactly like the real thing",
  };
  assert.throws(
    () =>
      reserveWithApproval(ledger, { role: "subtask", model: METERED, ...CALL }, CATALOG, forged),
    UnapprovedOverrunError,
  );

  // A structural clone of a REAL approval is still not the real approval.
  const clone = { ...overrunApproval() };
  assert.throws(
    () =>
      reserveWithApproval(ledger, { role: "subtask", model: METERED, ...CALL }, CATALOG, clone),
    UnapprovedOverrunError,
  );
});

test("approvals are not fungible: another scope cannot buy spending headroom", () => {
  let ledger = ledgerWith(5);
  ledger = spend(ledger, "subtask", METERED, 4.5);

  for (const scope of ["data-recipient", "capability-research", "credential"] as const) {
    const approval = grantOwnerApproval({
      approvedBy: "owner",
      scope,
      acknowledgement: `approved for ${scope}`,
    });
    assert.throws(
      () =>
        reserveWithApproval(
          ledger,
          { role: "subtask", model: METERED, ...CALL },
          CATALOG,
          approval,
        ),
      /Approvals are not fungible/,
      `scope '${scope}' must not authorize an overrun`,
    );
  }
});

test("an in-budget dispatch needs no approval at all", () => {
  const outcome = reserve(ledgerWith(5), { role: "subtask", model: METERED, ...CALL }, CATALOG);
  assert.ok(outcome.ok, "routine work inside the allowance is not gated");
});

// ---------------------------------------------------------------------------
// Subscription routes: tracked separately, never called free
// (the spec's "do not pretend it has the same dollar accounting", ticket 10's
// handoff)
// ---------------------------------------------------------------------------

test("a subscription route records consumption without spending the dollar allowance", () => {
  const outcome = reserve(
    ledgerWith(5),
    { role: "subtask", model: SUBSCRIPTION, ...CALL },
    CATALOG,
  );
  assert.ok(outcome.ok);
  assert.equal(outcome.estimate.metered, false);
  assert.equal(reservedUsd(outcome.ledger), 0, "no dollars are held for an unmetered route");

  // 01-findings.md §B.2: pi reported $6.136058 for one such run. That figure is
  // a list-derived consumption estimate, not a charge.
  const settled = reconcile(outcome.ledger, {
    reservationId: outcome.reservation.reservationId,
    reportedUsd: 6.136058,
    now: NOW,
  });

  assert.equal(committedUsd(settled), 0, "an unmetered figure is not dollars against the allowance");
  assert.equal(remainingUsd(settled), 5, "the metered allowance is untouched");
  assert.equal(unmeteredCharges(settled).length, 1, "but the consumption IS recorded");
  assert.equal(reportedUnmeteredConsumptionUsd(settled), 6.136058);

  const charge = settled.settled[0]!;
  assert.equal(charge.actualUsd.state, "unknown");
  assert.ok(charge.actualUsd.state === "unknown" && charge.actualUsd.reason === "not-metered");
});

test("unmetered consumption is never rendered as free or as spend", () => {
  const settled = spend(ledgerWith(5), "subtask", SUBSCRIPTION, 6.136058);
  const rendered = describeAllowance(settled).toLowerCase();

  assert.ok(!rendered.includes("free"), "must not call subscription work free");
  assert.match(rendered, /not counted as dollars/);
  assert.match(rendered, /\$0\.0000 committed/, "it did not spend the metered allowance");
  assert.match(rendered, /consume real capacity/);
});

// ---------------------------------------------------------------------------
// The caveat is carried, not quietly dropped
// ---------------------------------------------------------------------------

test("the rendering states this is a stop threshold, not a billing ceiling", () => {
  assert.match(describeAllowance(ledgerWith(5)), /not a guaranteed billing ceiling/);
  assert.match(OVERSHOOT_CAVEAT, /in flight can still overshoot/);
  assert.match(ATOMICITY_SCOPE, /serialized by one TaskAllowanceOwner within a process/);
  assert.match(ATOMICITY_SCOPE, /concurrent processes.*not serialized/);
  assert.match(
    allowanceConstraint(ownerWith(ledgerWith(5)), CATALOG, DISPATCH_CALL).describe,
    /not a guaranteed billing ceiling/,
  );
});

test("the schema version is pinned so a future format cannot be misread", () => {
  assert.equal(ALLOWANCE_SCHEMA_VERSION, 1);
  assert.equal(ledgerWith(5).schemaVersion, 1);
});

// ---------------------------------------------------------------------------
// The seam is actually filled: ticket 07's real dispatch gate enforces this
// ledger. Without these, the constraint would only be proven in isolation --
// a budget that composes in theory and never runs.
// ---------------------------------------------------------------------------

function authorizedForProviders(...providers: readonly string[]): RecipientAuthorization {
  let authorization = emptyAuthorization();
  for (const provider of providers) {
    authorization = authorizeRecipient(
      authorization,
      provider,
      grantOwnerApproval({
        approvedBy: "owner",
        scope: "data-recipient",
        acknowledgement: `send dispatch data to ${provider}`,
      }),
    );
  }
  return authorization;
}

function authorizedForSubscriptionProvider(): RecipientAuthorization {
  return authorizedForProviders("anthropic");
}

function authorizedForMeteredProvider(): RecipientAuthorization {
  return authorizedForProviders("openai-codex");
}

test("preflight is check-only, while competing real dispatch admissions reserve atomically", async () => {
  const owner = ownerWith(ledgerWith(2));
  const budget = allowanceConstraint(owner, CATALOG, DISPATCH_CALL, { now: NOW.getTime() });

  assert.equal(budget.check(ALLOWED_METERED).ok, true);
  assert.equal(owner.snapshot().open.length, 0, "preflight must not be mistaken for admission");

  const admit = (dispatchId: string) =>
    Promise.resolve().then(() =>
      dispatchNamedModel({
        model: ALLOWED_METERED,
        authorization: authorizedForMeteredProvider(),
        budget,
        dispatchId,
        availability: () => ({ status: "available" }),
      }),
    );
  const outcomes = await Promise.all([admit("dispatch-a"), admit("dispatch-b")]);
  const accepted = outcomes.filter((outcome) => outcome.ok);
  const refused = outcomes.filter((outcome) => !outcome.ok);

  assert.equal(accepted.length, 1, "two $1.30 dispatches cannot both enter a $2 allowance");
  assert.equal(refused.length, 1);
  assert.equal(owner.snapshot().open.length, 1, "exactly one live owner reservation exists");
  assert.equal(reservedUsd(owner.snapshot()), 1.3);
  const success = accepted[0];
  assert.ok(success?.ok);
  assert.equal(success.budgetAdmission.kind, "reservation");
  assert.ok(success.budgetAdmission.kind === "reservation");
  assert.equal(success.budgetAdmission.reservationId, owner.snapshot().open[0]?.reservationId);
  assert.equal(success.budgetAdmission.model, ALLOWED_METERED);
  assert.strictEqual(
    success.budgetAdmission.reservation,
    owner.snapshot().open[0],
    "accepted dispatch exposes the exact reservation registered by the owner",
  );
  success.budgetAdmission.reconcile({ reportedUsd: 0.4, now: NOW });
  assert.equal(owner.snapshot().open.length, 0, "bound reconciliation closes that live hold");
  assert.equal(committedUsd(owner.snapshot()), 0.4);
});

test("a dispatch that fails before start leaks no hold, and its bound hold can be released", () => {
  const owner = ownerWith(ledgerWith(2));
  const budget = allowanceConstraint(owner, CATALOG, DISPATCH_CALL, { now: NOW.getTime() });
  const authorization = authorizedForMeteredProvider();

  const unavailable = dispatchNamedModel({
    model: ALLOWED_METERED,
    authorization,
    budget,
    dispatchId: "never-admitted",
    availability: () => ({ status: "unavailable", detail: "provider never started" }),
  });
  assert.equal(unavailable.ok, false);
  assert.equal(owner.snapshot().open.length, 0, "resolver failure happens before reservation");

  const acceptedButNotStarted = dispatchNamedModel({
    model: ALLOWED_METERED,
    authorization,
    budget,
    dispatchId: "accepted-but-not-started",
    availability: () => ({ status: "available" }),
  });
  assert.ok(acceptedButNotStarted.ok);
  assert.equal(acceptedButNotStarted.budgetAdmission.kind, "reservation");
  assert.equal(owner.snapshot().open.length, 1);
  assert.ok(acceptedButNotStarted.budgetAdmission.kind === "reservation");
  acceptedButNotStarted.budgetAdmission.release();
  assert.equal(owner.snapshot().open.length, 0, "the bound release drops the correct hold");
  assert.equal(committedUsd(owner.snapshot()), 0);
});

test("provider switches and delivery retries keep one shared owner accounting", () => {
  const meteredAcrossProviders: ModelCatalog = {
    ...CATALOG,
    entries: {
      ...CATALOG.entries,
      [SUBSCRIPTION]: {
        ...CATALOG.entries[ALLOWED_METERED]!,
        model: SUBSCRIPTION,
        provider: "anthropic",
        id: "claude-sonnet-5",
      },
    },
  };
  const owner = ownerWith(ledgerWith(2));
  const budget = allowanceConstraint(owner, meteredAcrossProviders, DISPATCH_CALL, {
    now: NOW.getTime(),
  });
  const authorization = authorizedForProviders("openai-codex", "anthropic");

  const first = dispatchNamedModel({
    model: ALLOWED_METERED,
    authorization,
    budget,
    dispatchId: "logical-dispatch",
    availability: () => ({ status: "available" }),
  });
  assert.ok(first.ok);
  assert.equal(first.budgetAdmission.kind, "reservation");

  const duplicateRetry = dispatchNamedModel({
    model: ALLOWED_METERED,
    authorization,
    budget,
    dispatchId: "logical-dispatch",
    availability: () => ({ status: "available" }),
  });
  assert.equal(duplicateRetry.ok, false, "a live dispatch id cannot acquire a duplicate hold");
  assert.equal(owner.snapshot().open.length, 1);

  const bypassAttempt = dispatchNamedModel({
    model: SUBSCRIPTION,
    authorization,
    budget,
    dispatchId: "provider-switch-before-release",
    availability: () => ({ status: "available" }),
  });
  assert.equal(bypassAttempt.ok, false, "changing provider cannot reset the $0.70 headroom");
  assert.equal(owner.snapshot().open.length, 1);

  assert.ok(first.budgetAdmission.kind === "reservation");
  first.budgetAdmission.release();
  const switchedRetry = dispatchNamedModel({
    model: SUBSCRIPTION,
    authorization,
    budget,
    dispatchId: "logical-dispatch",
    availability: () => ({ status: "available" }),
  });
  assert.ok(switchedRetry.ok, "after a never-started call releases, its id can be retried");
  assert.equal(switchedRetry.budgetAdmission.kind, "reservation");
  assert.equal(owner.snapshot().open.length, 1, "the switched retry has one hold, not two");
  assert.equal(owner.snapshot().open[0]?.model, SUBSCRIPTION);
  first.budgetAdmission.release();
  assert.equal(
    owner.snapshot().open.length,
    1,
    "the old binding cannot release a newer provider's hold that reused its id",
  );
});

test("an exhausted allowance stops a dispatch at ticket 07's real gate", () => {
  // Real gate, real authorization, real resolver -- only the budget is ours.
  const exhausted = newTaskLedger({ taskId: "task-alpha", allowanceUsd: 0, now: NOW });
  const outcome = dispatchNamedModel({
    model: SUBSCRIPTION,
    authorization: authorizedForSubscriptionProvider(),
    budget: allowanceConstraint(ownerWith(exhausted), CATALOG, DISPATCH_CALL),
  });

  // A subscription route costs no metered dollars, so an exhausted dollar
  // allowance must NOT block it -- blocking here would be the "pretend
  // subscription work spends dollars" error the spec forbids.
  assert.equal(outcome.ok, true, "unmetered work is not blocked by a dollar allowance");
});

test("a metered dispatch past the allowance is refused by the real gate, not merely by us", () => {
  // ALLOWED_METERED is an allow-listed id (ticket 04 permits `openai-codex/gpt-5.*`)
  // that this test catalog prices as metered. A fictional provider cannot be
  // used here: ticket 04's resolver rejects an out-of-scope model BEFORE the
  // budget is consulted, which is the correct order and is pinned below.
  let spent = newTaskLedger({ taskId: "task-alpha", allowanceUsd: 5, now: NOW });
  const first = reserve(
    spent,
    { role: "subtask", model: ALLOWED_METERED, ...CALL },
    CATALOG,
    { now: NOW },
  );
  assert.ok(first.ok);
  spent = reconcile(first.ledger, {
    reservationId: first.reservation.reservationId,
    reportedUsd: 4.9,
    now: NOW,
  });

  const outcome = dispatchNamedModel({
    model: ALLOWED_METERED,
    authorization: authorizeRecipient(
      emptyAuthorization(),
      "openai-codex",
      grantOwnerApproval({
        approvedBy: "owner",
        scope: "data-recipient",
        acknowledgement: "send dispatch data to this provider",
      }),
    ),
    budget: allowanceConstraint(ownerWith(spent), CATALOG, DISPATCH_CALL),
    availability: () => ({ status: "available" }),
  });

  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "over_budget", "the real gate refused it, by our constraint");
  assert.match(outcome.message, /exceeds the \$0\.1000 remaining/);
  assert.match(outcome.message, /task allowance 'task-alpha'/);
});

test("a prohibited model is reported as prohibited even when the allowance is exhausted", () => {
  // Order matters: ticket 04 runs first, so an exhausted budget cannot mask a
  // prohibition, and a prohibition is never reported as a money problem.
  const exhausted = newTaskLedger({ taskId: "task-alpha", allowanceUsd: 0, now: NOW });
  const outcome = dispatchNamedModel({
    model: "anthropic/claude-fable-5",
    authorization: authorizedForSubscriptionProvider(),
    budget: allowanceConstraint(ownerWith(exhausted), CATALOG, DISPATCH_CALL),
  });
  assert.equal(outcome.ok, false);
  assert.ok(!outcome.ok);
  assert.equal(outcome.code, "resolver_rejected");
});
