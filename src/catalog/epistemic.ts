// Ticket 05: the epistemic layer.
//
// Published catalogs (models.dev, LiteLLM) record values. They do not record
// how a value was learned, when it was learned, or that it is not known at
// all -- a field they lack is simply absent from the JSON. This harness needs
// the opposite: `unknown` must survive as a first-class value carrying its own
// evidence and freshness, so unknown quota is never mistaken for unlimited
// capacity and stale pricing is never presented as current.
//
// The shape follows the honest-typing precedent ticket 01 found in the product:
// `UsageBudgetState.source` is the literal `"reported"`, documented "Enforced
// from usage reported by completed or streaming child runs; no reservation
// estimates" (`pi-subagents/src/shared/types.d.ts:1097-1098`). The type states
// the provenance of the number instead of leaving the caller to assume it.

/** Where a value came from. Every known value carries exactly one. */
export type Evidence =
  /** The pinned models.dev snapshot in `vendor/`. */
  | "published-dataset"
  /** Inferred by matching names across namespaces. An assumption, not proof. */
  | "assumed-name-mapping"
  /** `pi models` listed the id. Establishes listing and nothing else. */
  | "local-registry-listing"
  /** Learned from a real call result (ticket 08). */
  | "observed-from-call"
  /** Cheap availability/usage refresh at session start (ticket 08). */
  | "session-refresh"
  /** Stated by the operator. The operator is then the cited source. */
  | "operator-configured";

/** Why a value is not known. An unknown must always say which kind it is --
 *  "nobody has checked" and "no published source carries this" are different
 *  problems with different fixes. */
export type UnknownReason =
  /** The source carries this field, but not for this model. */
  | "absent-from-source"
  /** No published dataset carries this at all (quota, usage headroom). */
  | "not-published-anywhere"
  /** Nothing has verified it yet (authentication, live callability). */
  | "not-checked"
  /** Capability research and benchmarks need owner approval before running. */
  | "requires-approved-research"
  /** Subscription-routed: no per-call metered amount exists to report. */
  | "not-metered";

/**
 * A single catalog field.
 *
 * There is deliberately no `undefined` variant and no optional-value variant.
 * A field is either `known` with provenance, or `unknown` with a reason. That
 * is what makes "unknown" distinct from "missing" at the type level rather
 * than by convention: you cannot construct a `Fact` that omits the question.
 */
export type Fact<T> =
  | {
      readonly state: "known";
      readonly value: T;
      readonly evidence: Evidence;
      /** ISO-8601. When this value was last learned or verified. */
      readonly asOf: string;
      readonly note?: string;
    }
  | {
      readonly state: "unknown";
      readonly reason: UnknownReason;
      readonly note?: string;
      /** ISO-8601. When we last tried to find out, if we ever did. */
      readonly checkedAt?: string;
    };

export function known<T>(
  value: T,
  evidence: Evidence,
  asOf: string,
  note?: string,
): Fact<T> {
  return note === undefined
    ? { state: "known", value, evidence, asOf }
    : { state: "known", value, evidence, asOf, note };
}

export function unknown<T>(
  reason: UnknownReason,
  note?: string,
  checkedAt?: string,
): Fact<T> {
  const fact: {
    state: "unknown";
    reason: UnknownReason;
    note?: string;
    checkedAt?: string;
  } = { state: "unknown", reason };
  if (note !== undefined) fact.note = note;
  if (checkedAt !== undefined) fact.checkedAt = checkedAt;
  return fact;
}

/**
 * The read-time view of a fact, which adds `stale`.
 *
 * `stale` is derived, never stored. Staleness is a function of the current
 * time and a freshness policy, so a stored `stale` bit would itself go stale
 * on disk with nothing to rewrite it -- a value written as "fresh" would still
 * claim to be fresh a month later. Storing `asOf` and deciding at read time is
 * the only version that cannot lie.
 *
 * A stale view keeps the value. Callers may still use it, but they cannot do so
 * without seeing that it is past its freshness horizon.
 */
export type FactView<T> =
  | {
      readonly state: "known";
      readonly value: T;
      readonly evidence: Evidence;
      readonly asOf: string;
      readonly ageMs: number;
      readonly note?: string;
    }
  | {
      readonly state: "stale";
      readonly value: T;
      readonly evidence: Evidence;
      readonly asOf: string;
      readonly ageMs: number;
      readonly ttlMs: number;
      readonly note?: string;
    }
  | {
      readonly state: "unknown";
      readonly reason: UnknownReason;
      readonly note?: string;
      readonly checkedAt?: string;
    };

export interface FreshnessPolicy {
  /** A known value older than this reads as `stale`. */
  readonly ttlMs: number;
}

/** Default horizons. models.dev publishes a weekly-ish cadence, so pricing and
 *  capability data older than 30 days is flagged rather than trusted silently. */
export const DEFAULT_FRESHNESS: FreshnessPolicy = { ttlMs: 30 * 24 * 60 * 60 * 1000 };

export function readFact<T>(
  fact: Fact<T>,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
  now: number = Date.now(),
): FactView<T> {
  if (fact.state === "unknown") return fact;
  const asOfMs = Date.parse(fact.asOf);
  // An unparseable timestamp is not treated as fresh. We cannot show a value as
  // current when we cannot tell how old it is.
  const ageMs = Number.isNaN(asOfMs) ? Number.POSITIVE_INFINITY : now - asOfMs;
  const base = {
    value: fact.value,
    evidence: fact.evidence,
    asOf: fact.asOf,
    ageMs,
    ...(fact.note === undefined ? {} : { note: fact.note }),
  };
  return ageMs > policy.ttlMs
    ? { state: "stale", ...base, ttlMs: policy.ttlMs }
    : { state: "known", ...base };
}

/**
 * Renderings that would misrepresent an unknown as capacity. Asserted against
 * in the test suite: unknown quota must never be surfaced as unlimited, and
 * must never be surfaced as a number either -- `0` is as wrong as `infinity`,
 * because it invites "then there is nothing left to spend" just as readily.
 */
export const CAPACITY_MISREADINGS = [
  "unlimited",
  "\u221e",
  "infinity",
  "infinite",
  "no limit",
  "unbounded",
  "unmetered",
  "free",
] as const;

/** Human-readable rendering that cannot present an unknown as a value. */
export function describeFact<T>(
  view: FactView<T>,
  render: (value: T) => string,
): string {
  switch (view.state) {
    case "known":
      return render(view.value);
    case "stale":
      return `${render(view.value)} (stale: ${formatAge(view.ageMs)} old, horizon ${formatAge(view.ttlMs)})`;
    case "unknown":
      return `unknown (${view.reason})`;
  }
}

function formatAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unbounded age";
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(0, Math.floor(ms / 60000))}m`;
}

/** True only when a value is known AND within its freshness horizon. Anything
 *  else -- unknown, stale, untimestamped -- is not a basis for a confident
 *  claim. Routing (ticket 06) is expected to consult this rather than testing
 *  `state === "known"` on the stored fact and thereby skipping staleness. */
export function isTrustworthy<T>(view: FactView<T>): view is Extract<FactView<T>, { state: "known" }> {
  return view.state === "known";
}
