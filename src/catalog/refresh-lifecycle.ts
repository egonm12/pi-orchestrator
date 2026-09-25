// Ticket 08: the catalog refresh lifecycle.
//
// Ticket 05 built the catalog and left every runtime field `unknown` by
// construction. This module is when and how those fields legitimately change,
// and -- more importantly -- the boundary between refreshes that are free and
// activities that cost money.
//
// Three refreshes are cheap and need no approval:
//   1. session start  -- ask each provider that actually reports availability
//                        and usage, once, and leave the silent ones visibly
//                        unknown rather than guessed.
//   2. call results   -- read consumption and throttling off results that
//                        already came back. Issues no request at all: the
//                        function takes no provider access, so it cannot.
//   3. scoped refresh -- after one provider fails or is reconfigured, refresh
//                        that provider only. Recovery is not a sweep.
//
// One activity is not cheap. Capability research and active benchmarking run
// real work and spend real money, so they require an owner approval minted
// through ticket 07's `grantOwnerApproval` and a budget authorization, and they
// refuse to run without both.
//
// This module performs no network I/O, imports nothing that can, and contains
// no timer: there is no polling schedule to approve, because there is no
// schedule. `refresh-lifecycle.test.ts` asserts that structurally.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { known, unknown, type Fact } from "./epistemic.ts";
import type {
  CatalogEntry,
  ModelCatalog,
  UsageHeadroom,
} from "./model-catalog.ts";
import {
  isOwnerApprovalGranted,
  type AuthorizationScope,
  type OwnerApproval,
} from "../recipients/authorization.ts";
import {
  NO_BUDGET_CONSTRAINT,
  type BudgetPreflightConstraint,
} from "../recipients/authorized-delegation.ts";
import type {
  ProviderAdapter,
  ProviderQuota,
  ProviderRefreshSupport,
} from "../fixtures/provider-double.ts";

// ---------------------------------------------------------------------------
// Ticket-08-owned state, kept beside the catalog rather than inside it
// ---------------------------------------------------------------------------
//
// Throttling observations, locally tracked consumption and the capability
// observation ledger are ticket 08's, not ticket 05's. They live in their own
// structure so `CatalogEntry` keeps the shape ticket 06's routing already
// reads. The catalog is still updated -- but only in fields it already has.

export const REFRESH_STATE_SCHEMA_VERSION = 1;

export interface ThrottlingObservation {
  readonly model: string;
  /** ISO-8601. */
  readonly observedAt: string;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;
}

/**
 * Locally tracked consumption, as REPORTED. Not a bill.
 *
 * On subscription routes there is no per-call metered amount (ticket 05 keeps
 * `effectiveBilledCost` unknown with reason `not-metered`), and ticket 01
 * §B.2 found pi reports $0 for runs on the since-uninstalled
 * claude-bridge route and a list-price-derived estimate for openai-codex. So
 * this is a consumption signal, not spend.
 * Tickets 09/10 own real allowance accounting.
 */
export interface ConsumptionTally {
  readonly model: string;
  readonly reportedConsumptionUsd: number;
  readonly calls: number;
  readonly lastObservedAt: string;
}

export type ObservationSource =
  /** A real delegated task that was verified to have succeeded or failed. */
  | "verified-task-outcome"
  /** A representative check run under approved capability research. */
  | "representative-check"
  /** Published capability data. Seeds a provisional profile; see below, it can
   *  never on its own promote a suitability score to a known fact. */
  | "published-seed";

export const OBSERVATION_SOURCES: readonly ObservationSource[] = [
  "verified-task-outcome",
  "representative-check",
  "published-seed",
];

/** Sources that count toward the promotion bar. `published-seed` is absent on
 *  purpose: the ticket allows published information to seed a provisional
 *  profile, and requires representative checks or verified outcomes to refine
 *  it. Seeding is therefore recorded but never sufficient. */
export const QUALIFYING_SOURCES: readonly ObservationSource[] = [
  "verified-task-outcome",
  "representative-check",
];

export interface CapabilityObservation {
  readonly model: string;
  /** Capability is per task type, never global. */
  readonly taskType: string;
  /** Distinct task instance. Re-running the SAME instance does not corroborate
   *  anything, so the ledger dedupes on this. */
  readonly instance: string;
  readonly source: ObservationSource;
  readonly outcome: "pass" | "fail";
  /** ISO-8601. */
  readonly observedAt: string;
  readonly note?: string;
}

export interface RefreshState {
  readonly schemaVersion: number;
  readonly throttling: readonly ThrottlingObservation[];
  readonly consumption: Readonly<Record<string, ConsumptionTally>>;
  readonly observations: readonly CapabilityObservation[];
  /** Per provider, when we last attempted a refresh and what came of it. */
  readonly lastRefresh: Readonly<Record<string, ProviderRefreshAttempt>>;
}

export interface ProviderRefreshAttempt {
  readonly provider: string;
  readonly reason: RefreshReason;
  readonly attemptedAt: string;
  readonly requested: boolean;
  readonly reported: boolean;
  readonly why: string;
}

export function emptyRefreshState(): RefreshState {
  return Object.freeze({
    schemaVersion: REFRESH_STATE_SCHEMA_VERSION,
    throttling: Object.freeze([]) as readonly ThrottlingObservation[],
    consumption: Object.freeze({}) as Readonly<Record<string, ConsumptionTally>>,
    observations: Object.freeze([]) as readonly CapabilityObservation[],
    lastRefresh: Object.freeze({}) as Readonly<Record<string, ProviderRefreshAttempt>>,
  });
}

/** Runtime state, not source: git-ignored, same convention as ticket 05's
 *  `DEFAULT_CATALOG_PATH` and ticket 07's `DEFAULT_RECIPIENTS_PATH`. */
export const DEFAULT_REFRESH_STATE_PATH = "src/state/refresh-state.json";

export function saveRefreshState(path: string, state: RefreshState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

export function loadRefreshState(path: string): RefreshState {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as RefreshState;
  if (parsed.schemaVersion !== REFRESH_STATE_SCHEMA_VERSION) {
    throw new Error(
      `refresh state schemaVersion ${parsed.schemaVersion} != expected ${REFRESH_STATE_SCHEMA_VERSION}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// 1. Session-start refresh: cheap, and only where the provider reports
// ---------------------------------------------------------------------------

export type RefreshReason = "session-start" | "call-failure" | "configuration-change";

export interface ProviderRefreshOutcome {
  readonly provider: string;
  /** Whether a request was actually issued. `false` for a provider that
   *  reports nothing -- that is the cheapness guarantee. */
  readonly requested: boolean;
  readonly supports?: ProviderRefreshSupport;
  readonly updatedModels: readonly string[];
  /** Models left unknown, with `checkedAt` stamped so "we looked and still do
   *  not know" is distinguishable from "nobody ever looked". */
  readonly leftUnknown: readonly string[];
  readonly why: string;
}

export interface RefreshResult {
  readonly catalog: ModelCatalog;
  readonly state: RefreshState;
  readonly outcomes: readonly ProviderRefreshOutcome[];
  readonly refreshedAt: string;
}

function providersOf(catalog: ModelCatalog): Map<string, string[]> {
  const byProvider = new Map<string, string[]>();
  for (const [model, entry] of Object.entries(catalog.entries)) {
    const list = byProvider.get(entry.provider);
    if (list) list.push(model);
    else byProvider.set(entry.provider, [model]);
  }
  return byProvider;
}

function quotaToHeadroom(quota: ProviderQuota): UsageHeadroom {
  return quota.kind === "metered"
    ? { kind: "metered", remainingUsd: quota.remainingUsd }
    : {
        kind: "requests",
        remaining: quota.remaining,
        ...(quota.resetsAt === undefined ? {} : { resetsAt: quota.resetsAt }),
      };
}

/**
 * Stamp an unknown fact as freshly-checked without inventing a value.
 *
 * A KNOWN fact is returned untouched. That matters: a provider that reports no
 * quota must not erase headroom a real call result already established, and
 * overwriting it with `unknown` would throw away evidence we actually have.
 */
function restampUnknown<T>(
  fact: Fact<T>,
  reason: Parameters<typeof unknown<T>>[0],
  note: string,
  checkedAt: string,
): Fact<T> {
  if (fact.state === "known") return fact;
  return unknown<T>(reason, note, checkedAt);
}

export interface SessionRefreshInput {
  readonly catalog: ModelCatalog;
  readonly adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly state?: RefreshState;
  readonly now?: string;
}

/**
 * Refresh availability and usage at session start, for supporting providers
 * only. One request per provider, never one per model.
 */
export function refreshAtSessionStart(input: SessionRefreshInput): RefreshResult {
  return refreshProviders({
    catalog: input.catalog,
    adapters: input.adapters,
    providers: [...providersOf(input.catalog).keys()],
    reason: "session-start",
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

// ---------------------------------------------------------------------------
// 3. Scoped refresh: one provider, because recovery is not a sweep
// ---------------------------------------------------------------------------

export interface ScopedRefreshInput {
  readonly catalog: ModelCatalog;
  readonly adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly provider: string;
  readonly reason: Extract<RefreshReason, "call-failure" | "configuration-change">;
  readonly state?: RefreshState;
  readonly now?: string;
}

/**
 * Refresh exactly one provider after a call failure or a configuration change.
 *
 * Every other provider's entries are returned by REFERENCE, so a test can
 * assert `===` identity rather than deep-compare and hope.
 */
export function refreshProvider(input: ScopedRefreshInput): RefreshResult {
  return refreshProviders({
    catalog: input.catalog,
    adapters: input.adapters,
    providers: [input.provider],
    reason: input.reason,
    ...(input.state === undefined ? {} : { state: input.state }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
}

interface RefreshProvidersInput {
  readonly catalog: ModelCatalog;
  readonly adapters: Readonly<Record<string, ProviderAdapter>>;
  readonly providers: readonly string[];
  readonly reason: RefreshReason;
  readonly state?: RefreshState;
  readonly now?: string;
}

function refreshProviders(input: RefreshProvidersInput): RefreshResult {
  const now = input.now ?? new Date().toISOString();
  const state = input.state ?? emptyRefreshState();
  const byProvider = providersOf(input.catalog);
  const entries: Record<string, CatalogEntry> = { ...input.catalog.entries };
  const outcomes: ProviderRefreshOutcome[] = [];
  const attempts: Record<string, ProviderRefreshAttempt> = { ...state.lastRefresh };

  for (const provider of input.providers) {
    const models = byProvider.get(provider) ?? [];
    const adapter = input.adapters[provider];
    const supports = adapter?.supports;
    const reports = supports ? supports.usage || supports.availability : false;

    if (!adapter || !reports) {
      // No request issued. Every model stays unknown, but stamped: we looked
      // at the configuration, and this provider reports nothing.
      const why = !adapter
        ? `no adapter configured for provider '${provider}'; nothing was requested`
        : `provider '${provider}' reports neither availability nor usage; nothing was requested`;
      for (const model of models) {
        const entry = entries[model];
        if (!entry) continue;
        entries[model] = {
          ...entry,
          usageHeadroom: restampUnknown(
            entry.usageHeadroom,
            "not-published-anywhere",
            why,
            now,
          ),
        };
      }
      outcomes.push({
        provider,
        requested: false,
        ...(supports === undefined ? {} : { supports }),
        updatedModels: [],
        leftUnknown: models,
        why,
      });
      attempts[provider] = {
        provider,
        reason: input.reason,
        attemptedAt: now,
        requested: false,
        reported: false,
        why,
      };
      continue;
    }

    const snapshot = adapter.refresh(input.reason);
    const updated: string[] = [];
    const leftUnknown: string[] = [];

    for (const model of models) {
      const entry = entries[model];
      if (!entry) continue;
      let next = entry;
      let touched = false;

      const reported = snapshot?.models?.[entry.id] ?? snapshot?.models?.[model];
      if (supports?.availability && reported) {
        if (reported.status === "available") {
          next = {
            ...next,
            liveCallability: known("reachable", "session-refresh", now, `reported by ${provider}`),
          };
          touched = true;
        } else {
          // A provider saying "throttled"/"unavailable" is real information,
          // but `Fact<"reachable">` cannot carry a negative. Recording it as
          // `known` would be a lie and recording it as `unknown` would discard
          // an earlier verified success, so the status is reported in the
          // outcome and left out of the fact.
          leftUnknown.push(model);
        }
      }

      if (supports?.usage) {
        if (snapshot?.quota) {
          next = {
            ...next,
            usageHeadroom: known(
              quotaToHeadroom(snapshot.quota),
              "session-refresh",
              now,
              `provider-level quota shared across '${provider}' routes`,
            ),
          };
          touched = true;
        } else {
          next = {
            ...next,
            usageHeadroom: restampUnknown(
              next.usageHeadroom,
              "not-published-anywhere",
              `provider '${provider}' was asked but reported no remaining quota`,
              now,
            ),
          };
          if (!leftUnknown.includes(model)) leftUnknown.push(model);
        }
      }

      if (touched) {
        entries[model] = next;
        if (!updated.includes(model)) updated.push(model);
      } else if (next !== entry) {
        entries[model] = next;
      }
    }

    const why = snapshot
      ? `provider '${provider}' reported ${snapshot.quota ? "quota" : "no quota"}` +
        `${snapshot.models ? " and per-model availability" : " and no per-model availability"}`
      : `provider '${provider}' was asked and reported nothing`;
    outcomes.push({
      provider,
      requested: true,
      ...(supports === undefined ? {} : { supports }),
      updatedModels: updated,
      leftUnknown,
      why,
    });
    attempts[provider] = {
      provider,
      reason: input.reason,
      attemptedAt: now,
      requested: true,
      reported: snapshot !== undefined,
      why,
    };
  }

  return {
    catalog: { ...input.catalog, entries },
    state: { ...state, lastRefresh: attempts },
    outcomes,
    refreshedAt: now,
  };
}

// ---------------------------------------------------------------------------
// 2. Call results: free, because the data already came back
// ---------------------------------------------------------------------------

/** Usage the provider returned alongside the response. Nothing here is fetched. */
export interface ReportedUsage {
  /** Reported consumption for this call. See `ConsumptionTally`: not a bill. */
  readonly costUsd?: number;
  readonly remainingUsd?: number;
  readonly remainingRequests?: number;
  readonly resetsAt?: string;
}

export interface CallResultRecord {
  readonly model: string;
  readonly outcome: "ok" | "throttled" | "unavailable" | "call-failure";
  /** ISO-8601. */
  readonly observedAt: string;
  readonly reportedUsage?: ReportedUsage;
  readonly retryAfterSeconds?: number;
  readonly detail?: string;
}

export interface CallResultUpdate {
  readonly catalog: ModelCatalog;
  readonly state: RefreshState;
  readonly applied: readonly string[];
  readonly why: string;
}

/**
 * Update consumption, throttling and reachability from a result that already
 * came back.
 *
 * Note the signature: there is no adapter, registry or provider parameter.
 * This function CANNOT issue a request, because it is not given anything to
 * issue one to -- which is a stronger guarantee than a test that counts calls,
 * though the test asserts it too.
 */
export function updateFromCallResult(
  catalog: ModelCatalog,
  state: RefreshState,
  result: CallResultRecord,
): CallResultUpdate {
  const entry = catalog.entries[result.model];
  if (!entry) {
    // Do not conjure an entry from a call result. A model that is not in the
    // catalog was never listed, and a result does not establish a listing.
    return {
      catalog,
      state,
      applied: [],
      why: `'${result.model}' is not in the catalog; no fact was invented for it`,
    };
  }

  const applied: string[] = [];
  let next = entry;

  if (result.outcome === "ok") {
    next = {
      ...next,
      liveCallability: known("reachable", "observed-from-call", result.observedAt),
      // A call that returned did authenticate. That is direct evidence, unlike
      // a registry listing (ticket 05) or a quota endpoint responding.
      authentication: known("working", "observed-from-call", result.observedAt),
    };
    applied.push("liveCallability", "authentication");
  }

  const usage = result.reportedUsage;
  if (usage?.remainingUsd !== undefined) {
    next = {
      ...next,
      usageHeadroom: known(
        { kind: "metered", remainingUsd: usage.remainingUsd },
        "observed-from-call",
        result.observedAt,
        "reported with the call result; no additional request was made",
      ),
    };
    applied.push("usageHeadroom");
  } else if (usage?.remainingRequests !== undefined) {
    next = {
      ...next,
      usageHeadroom: known(
        {
          kind: "requests",
          remaining: usage.remainingRequests,
          ...(usage.resetsAt === undefined ? {} : { resetsAt: usage.resetsAt }),
        },
        "observed-from-call",
        result.observedAt,
        "reported with the call result; no additional request was made",
      ),
    };
    applied.push("usageHeadroom");
  }
  // Deliberately no `else`: a throttle without a reported remaining count does
  // NOT become "0 remaining". Ticket 05's whole point is that unknown quota is
  // not a number.

  const throttling =
    result.outcome === "throttled"
      ? [
          ...state.throttling,
          {
            model: result.model,
            observedAt: result.observedAt,
            ...(result.retryAfterSeconds === undefined
              ? {}
              : { retryAfterSeconds: result.retryAfterSeconds }),
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          },
        ]
      : state.throttling;

  const consumption = { ...state.consumption };
  if (usage?.costUsd !== undefined) {
    const previous = consumption[result.model];
    consumption[result.model] = {
      model: result.model,
      reportedConsumptionUsd: (previous?.reportedConsumptionUsd ?? 0) + usage.costUsd,
      calls: (previous?.calls ?? 0) + 1,
      lastObservedAt: result.observedAt,
    };
    applied.push("consumption");
  }

  const entries =
    next === entry ? catalog.entries : { ...catalog.entries, [result.model]: next };

  return {
    catalog: { ...catalog, entries },
    state: { ...state, throttling, consumption },
    applied,
    why:
      applied.length === 0
        ? `result for '${result.model}' carried nothing to record`
        : `recorded ${applied.join(", ")} from the returned result, with no additional request`,
  };
}

// ---------------------------------------------------------------------------
// 4. Capability research and active benchmarks: paid, and therefore gated
// ---------------------------------------------------------------------------

export type CapabilityActivity = Extract<
  AuthorizationScope,
  "capability-research" | "active-benchmark"
>;

export const CAPABILITY_ACTIVITIES: readonly CapabilityActivity[] = [
  "capability-research",
  "active-benchmark",
];

export class UnapprovedCapabilityResearchError extends Error {
  readonly code = "unapproved_capability_research";
  constructor(message: string) {
    super(message);
    this.name = "UnapprovedCapabilityResearchError";
  }
}

export class UnbudgetedCapabilityResearchError extends Error {
  readonly code = "unbudgeted_capability_research";
  constructor(message: string) {
    super(message);
    this.name = "UnbudgetedCapabilityResearchError";
  }
}

export class SelfRatingNotEvidenceError extends Error {
  readonly code = "self_rating_is_not_evidence";
  constructor(message: string) {
    super(message);
    this.name = "SelfRatingNotEvidenceError";
  }
}

/**
 * Field names that would smuggle a model's opinion of itself into the evidence
 * base. Rejected at the door.
 *
 * Ticket 06 excluded self-reported confidence from ROUTING. The same exclusion
 * has to hold here, because this is the path that writes capability evidence:
 * if a self-rating could be recorded as an observation, ticket 06's exclusion
 * would be trivially bypassable one layer down.
 */
export const SELF_RATING_KEYS: readonly string[] = [
  "selfReported",
  "selfReportedConfidence",
  "selfRating",
  "selfAssessment",
  "selfEvaluation",
  "modelConfidence",
  "reportedConfidence",
  "claimedCapability",
  "confidence",
];

function rejectSelfRating(candidate: object, context: string): void {
  for (const key of Object.keys(candidate)) {
    if (SELF_RATING_KEYS.includes(key)) {
      throw new SelfRatingNotEvidenceError(
        `pi-orchestration-harness: refusing ${context}: it carries '${key}'. ` +
          "A model's self-rating is not evidence of capability. Record a " +
          "verified task outcome or a representative check instead.",
      );
    }
  }
}

export interface CapabilityRunOutcome {
  readonly instance: string;
  readonly outcome: "pass" | "fail";
  readonly note?: string;
}

export interface CapabilityResearchRequest {
  readonly activity: CapabilityActivity;
  readonly model: string;
  readonly taskType: string;
  /** Distinct task instances to run. Repeats are rejected: running one task
   *  three times is one observation, not three. */
  readonly instances: readonly string[];
}

export interface CapabilityResearchInput {
  readonly request: CapabilityResearchRequest;
  /** Must come from ticket 07's `grantOwnerApproval`, scoped to the activity. */
  readonly approval: OwnerApproval;
  /** Ticket 09 owns real allowance accounting; this is the seam it plugs into.
   *  Required, and the explicit "no budget" sentinel is refused. */
  readonly budget: BudgetPreflightConstraint;
  /** Runs one instance. Injected so nothing here reaches a live provider. */
  run(instance: string): CapabilityRunOutcome;
  readonly now?: string;
}

export interface CapabilityResearchResult {
  readonly state: RefreshState;
  readonly observations: readonly CapabilityObservation[];
  readonly budgetApplied: string;
  readonly approvedBy: string;
  readonly why: string;
}

/**
 * The only way to run paid capability work.
 *
 * Refuses, in order: a forged approval, an approval minted for a different
 * purpose, a missing budget authorization, and a budget that says no. Each is
 * a separate refusal so the reason is legible rather than a generic denial.
 */
export function runCapabilityResearch(
  state: RefreshState,
  input: CapabilityResearchInput,
): CapabilityResearchResult {
  const { request, approval, budget } = input;
  const now = input.now ?? new Date().toISOString();

  if (!isOwnerApprovalGranted(approval)) {
    throw new UnapprovedCapabilityResearchError(
      `pi-orchestration-harness: refusing to run ${request.activity} for ` +
        `'${request.model}'. The supplied approval was not granted through ` +
        "grantOwnerApproval, so no owner approval is on record. Capability " +
        "research and benchmarks run real work and spend real money.",
    );
  }

  if (approval.scope !== request.activity) {
    throw new UnapprovedCapabilityResearchError(
      `pi-orchestration-harness: refusing to run ${request.activity} for ` +
        `'${request.model}'. The approval on record is scoped ` +
        `'${approval.scope}'. An approval is not fungible across purposes: ` +
        `approving one activity does not approve another.`,
    );
  }

  if (budget === NO_BUDGET_CONSTRAINT) {
    throw new UnbudgetedCapabilityResearchError(
      `pi-orchestration-harness: refusing to run ${request.activity} for ` +
        `'${request.model}' with no budget authorization. Approved capability ` +
        "work draws on the applicable approved budget; ticket 09 owns the real " +
        "allowance accounting this seam plugs into.",
    );
  }

  const verdict = budget.check(request.model);
  if (!verdict.ok) {
    throw new UnbudgetedCapabilityResearchError(
      `pi-orchestration-harness: refusing to run ${request.activity} for ` +
        `'${request.model}': ${verdict.why ?? "the spending constraint refused it"} ` +
        `(${budget.describe}).`,
    );
  }

  const seen = new Set<string>();
  for (const instance of request.instances) {
    if (seen.has(instance)) {
      throw new UnapprovedCapabilityResearchError(
        `pi-orchestration-harness: instance '${instance}' is listed twice for ` +
          `'${request.model}'. Re-running one instance does not corroborate it.`,
      );
    }
    seen.add(instance);
  }

  let next = state;
  const recorded: CapabilityObservation[] = [];
  for (const instance of request.instances) {
    const outcome = input.run(instance);
    rejectSelfRating(outcome, `a ${request.activity} result for '${request.model}'`);
    const observation: CapabilityObservation = {
      model: request.model,
      taskType: request.taskType,
      instance,
      // An active benchmark is a representative check; a verified task outcome
      // comes from real delegated work, recorded through
      // `recordCapabilityObservation` instead.
      source: "representative-check",
      outcome: outcome.outcome,
      observedAt: now,
      ...(outcome.note === undefined ? {} : { note: outcome.note }),
    };
    next = recordCapabilityObservation(next, observation);
    recorded.push(observation);
  }

  return {
    state: next,
    observations: recorded,
    budgetApplied: budget.describe,
    approvedBy: approval.approvedBy,
    why:
      `ran ${recorded.length} instance(s) of '${request.taskType}' for ` +
      `'${request.model}' under ${request.activity} approved by ${approval.approvedBy}`,
  };
}

// ---------------------------------------------------------------------------
// 5. One success is not a capability claim
// ---------------------------------------------------------------------------

/**
 * Distinct qualifying instances required before a suitability score becomes a
 * KNOWN catalog fact.
 *
 * Three, chosen as the smallest bar that resists the failure the ticket names:
 *   - 1 is an anecdote, and is what the ticket explicitly forbids generalising.
 *   - 2 can be two near-identical tasks, and two passes cannot separate
 *     capability from luck -- a fair coin comes up heads twice 25% of the time.
 *   - 3 distinct instances is the smallest set where a majority signal exists
 *     and a single outlier does not decide the score.
 *
 * It is a minimum, not proof, which is why the strongest tier below is
 * `corroborated` rather than `verified`.
 */
export const MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN = 3;

export type SuitabilityTier =
  /** Nothing qualifying has been observed. */
  | "unobserved"
  /** Observed, but below the bar. Recorded and visible; not a claim. */
  | "provisional"
  /** At or above the bar. A minimum standard of evidence, not a guarantee. */
  | "corroborated";

export interface SuitabilityDerivation {
  readonly model: string;
  readonly taskType: string;
  readonly tier: SuitabilityTier;
  readonly distinctQualifying: number;
  readonly passRate?: number;
  /** Whether this became a known catalog fact. */
  readonly promoted: boolean;
  readonly why: string;
}

/**
 * Record one observation.
 *
 * Dedupes on (model, taskType, instance), keeping the newest: the ledger
 * counts distinct instances, so replaying an instance cannot inflate the
 * count toward the promotion bar.
 */
export function recordCapabilityObservation(
  state: RefreshState,
  observation: CapabilityObservation,
): RefreshState {
  rejectSelfRating(observation, "a capability observation");
  if (!OBSERVATION_SOURCES.includes(observation.source)) {
    throw new SelfRatingNotEvidenceError(
      `pi-orchestration-harness: unknown observation source ` +
        `'${observation.source}'. Capability evidence must be a verified task ` +
        "outcome, a representative check, or a published seed.",
    );
  }
  const kept = state.observations.filter(
    (o) =>
      !(
        o.model === observation.model &&
        o.taskType === observation.taskType &&
        o.instance === observation.instance
      ),
  );
  return { ...state, observations: [...kept, observation] };
}

/** Derive the tier and score for one model/task type from the ledger. */
export function deriveSuitability(
  state: RefreshState,
  model: string,
  taskType: string,
): SuitabilityDerivation {
  const relevant = state.observations.filter(
    (o) => o.model === model && o.taskType === taskType,
  );
  const qualifying = relevant.filter((o) => QUALIFYING_SOURCES.includes(o.source));
  const distinct = new Set(qualifying.map((o) => o.instance)).size;
  const seeded = relevant.length - qualifying.length;

  if (distinct === 0) {
    return {
      model,
      taskType,
      tier: seeded > 0 ? "provisional" : "unobserved",
      distinctQualifying: 0,
      promoted: false,
      why:
        seeded > 0
          ? `${seeded} published seed(s) only; published information seeds a provisional profile and cannot promote a suitability score`
          : "nothing qualifying has been observed",
    };
  }

  const passes = qualifying.filter((o) => o.outcome === "pass").length;
  const passRate = passes / qualifying.length;

  if (distinct < MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN) {
    return {
      model,
      taskType,
      tier: "provisional",
      distinctQualifying: distinct,
      passRate,
      promoted: false,
      why:
        `${distinct} distinct qualifying instance(s); the bar for a known ` +
        `suitability fact is ${MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN}. A single ` +
        "success does not generalise into a capability claim",
    };
  }

  return {
    model,
    taskType,
    tier: "corroborated",
    distinctQualifying: distinct,
    passRate,
    promoted: true,
    why:
      `${distinct} distinct qualifying instance(s) at or above the bar of ` +
      `${MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN}; pass rate ${passRate}`,
  };
}

export interface ProfileApplication {
  readonly catalog: ModelCatalog;
  readonly derivations: readonly SuitabilityDerivation[];
}

/**
 * Overlay the ledger onto the catalog's `taskSuitability`.
 *
 * Only promoted task types become known scores. Below the bar the fact stays
 * `unknown` -- restamped with the observation count and `checkedAt`, so the
 * provisional evidence is visible without routing's `isTrustworthy` treating
 * it as usable. That is the concrete mechanism for "one success does not
 * become a general capability claim": ticket 06 consults `isTrustworthy`, and
 * a provisional profile never satisfies it.
 *
 * Returns a NEW catalog; untouched entries keep object identity.
 */
export function applyCapabilityProfile(
  catalog: ModelCatalog,
  state: RefreshState,
  now: string = new Date().toISOString(),
): ProfileApplication {
  const pairs = new Map<string, Set<string>>();
  for (const observation of state.observations) {
    const types = pairs.get(observation.model);
    if (types) types.add(observation.taskType);
    else pairs.set(observation.model, new Set([observation.taskType]));
  }

  const entries: Record<string, CatalogEntry> = { ...catalog.entries };
  const derivations: SuitabilityDerivation[] = [];

  for (const [model, taskTypes] of pairs) {
    const entry = entries[model];
    const scores: Record<string, number> = {};
    const provisional: string[] = [];
    let promotedAny = false;

    for (const taskType of [...taskTypes].sort()) {
      const derivation = deriveSuitability(state, model, taskType);
      derivations.push(derivation);
      if (!entry) continue;
      if (derivation.promoted && derivation.passRate !== undefined) {
        scores[taskType] = derivation.passRate;
        promotedAny = true;
      } else {
        provisional.push(`${taskType}=${derivation.tier}(${derivation.distinctQualifying})`);
      }
    }

    if (!entry) continue;

    if (promotedAny) {
      const note =
        `corroborated from ${MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN}+ distinct ` +
        "qualifying instances per task type" +
        (provisional.length > 0 ? `; below the bar: ${provisional.join(", ")}` : "");
      entries[model] = {
        ...entry,
        taskSuitability: known(scores, "observed-from-call", now, note),
      };
    } else if (provisional.length > 0) {
      entries[model] = {
        ...entry,
        taskSuitability: unknown<Record<string, number>>(
          "requires-approved-research",
          `below the promotion bar: ${provisional.join(", ")}; ` +
            `${MIN_DISTINCT_OBSERVATIONS_FOR_KNOWN} distinct qualifying instances are required`,
          now,
        ),
      };
    }
  }

  return { catalog: { ...catalog, entries }, derivations };
}
