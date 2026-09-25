// Controlled provider double (ticket 04).
//
// Quota exhaustion, throttling, pricing gaps and call failures cannot be
// reproduced against live providers, and live provider canaries require
// approval and are out of scope. This double makes those conditions
// deterministic and offline. It performs no network I/O of any kind.
//
// Later tickets (05 catalog, 06 routing, 08 refresh, 09/10 budget,
// 11 recovery) reuse this. Only the four conditions ticket 04 names are
// modelled here; anything else is for the ticket that needs it.

export type ModelCondition =
  | {
      kind: "available";
      /** USD per 1M tokens. Deliberately optional: absent means UNKNOWN price,
       *  which is not the same as free. Ticket 10 depends on that distinction. */
      inputUsdPerMTok?: number;
      outputUsdPerMTok?: number;
    }
  | { kind: "unavailable"; detail: string }
  | { kind: "throttled"; retryAfterSeconds: number; detail: string }
  | { kind: "call-failure"; detail: string };

export type AvailabilityStatus =
  | "available"
  | "unavailable"
  | "throttled"
  | "call-failure"
  | "unknown-model";

export interface Availability {
  status: AvailabilityStatus;
  detail?: string;
  retryAfterSeconds?: number;
}

export interface Pricing {
  /** `false` when the double has no price for this model. An unknown price must
   *  never be reported as 0. */
  known: boolean;
  inputUsdPerMTok?: number;
  outputUsdPerMTok?: number;
}

export interface CallRecord {
  model: string;
  outcome: AvailabilityStatus;
}

export interface ProviderDouble {
  listModels(): string[];
  availability(model: string): Availability;
  pricing(model: string): Pricing;
  /** Records the attempt, then resolves it from the configured condition.
   *  Tests assert on `calls` to prove a substitute model was never reached. */
  call(model: string): Availability;
  readonly calls: readonly CallRecord[];
  reset(): void;
}

// ---------------------------------------------------------------------------
// Provider-level refresh adapters (ticket 08)
// ---------------------------------------------------------------------------
//
// `ProviderDouble` above is keyed by MODEL. Session-start refresh, and the
// scoped refresh after a failure or a configuration change, are per PROVIDER:
// the question is whether a given provider reports availability and remaining
// usage at all. Real providers differ -- some expose a quota endpoint, some
// expose nothing -- and ticket 08 must leave the silent ones visibly unknown
// rather than guess. That distinction needs a provider-shaped double.
//
// Every refresh is recorded in `refreshRequests`, which is what lets a test
// prove three separate things: that an unsupporting provider was never asked,
// that the call-result update path issues no request at all, and that a scoped
// refresh touched exactly one provider.

export interface ProviderRefreshSupport {
  /** Provider reports remaining quota / usage headroom. */
  readonly usage: boolean;
  /** Provider reports per-model availability. */
  readonly availability: boolean;
}

/** Remaining capacity as a PROVIDER would report it. Deliberately not the
 *  catalog's `UsageHeadroom`: translating provider-shaped data into catalog
 *  facts is the harness's job, not the fixture's. */
export type ProviderQuota =
  | { readonly kind: "metered"; readonly remainingUsd: number }
  | { readonly kind: "requests"; readonly remaining: number; readonly resetsAt?: string };

export interface ProviderUsageSnapshot {
  /** Per-model availability, present only when `supports.availability`. */
  readonly models?: Readonly<
    Record<string, { readonly status: AvailabilityStatus; readonly retryAfterSeconds?: number }>
  >;
  /** Remaining capacity, present only when `supports.usage`. */
  readonly quota?: ProviderQuota;
}

export interface ProviderRefreshRequest {
  readonly provider: string;
  readonly reason: string;
}

export interface ProviderAdapter {
  readonly provider: string;
  readonly supports: ProviderRefreshSupport;
  /**
   * Cheap refresh. Returns `undefined` when the provider reports neither
   * availability nor usage -- an absent report, never a fabricated zero.
   * The request is recorded either way, so "we asked and got nothing" stays
   * distinguishable from "we never asked".
   */
  refresh(reason: string): ProviderUsageSnapshot | undefined;
  readonly refreshRequests: readonly ProviderRefreshRequest[];
  reset(): void;
}

export interface ProviderAdapterSpec {
  readonly provider: string;
  readonly supports: ProviderRefreshSupport;
  /** What a supported refresh returns. Ignored for unsupported dimensions. */
  readonly snapshot?: ProviderUsageSnapshot;
}

export function createProviderAdapter(spec: ProviderAdapterSpec): ProviderAdapter {
  const refreshRequests: ProviderRefreshRequest[] = [];
  return {
    provider: spec.provider,
    supports: spec.supports,
    refresh(reason) {
      refreshRequests.push({ provider: spec.provider, reason });
      if (!spec.supports.usage && !spec.supports.availability) return undefined;
      const snapshot = spec.snapshot;
      if (!snapshot) return undefined;
      // Only hand back the dimensions this provider actually supports, so a
      // fixture cannot accidentally supply usage data for a provider that
      // reports none.
      const report: { models?: ProviderUsageSnapshot["models"]; quota?: ProviderQuota } = {};
      if (spec.supports.availability && snapshot.models) report.models = snapshot.models;
      if (spec.supports.usage && snapshot.quota) report.quota = snapshot.quota;
      return report.models === undefined && report.quota === undefined ? undefined : report;
    },
    refreshRequests,
    reset() {
      refreshRequests.length = 0;
    },
  };
}

/** Index adapters by provider name, the shape ticket 08's refresh takes. */
export function adapterRegistry(
  adapters: readonly ProviderAdapter[],
): Readonly<Record<string, ProviderAdapter>> {
  const byProvider: Record<string, ProviderAdapter> = {};
  for (const adapter of adapters) byProvider[adapter.provider] = adapter;
  return byProvider;
}

export function createProviderDouble(
  spec: Readonly<Record<string, ModelCondition>>,
): ProviderDouble {
  const calls: CallRecord[] = [];

  const availability = (model: string): Availability => {
    const condition = spec[model];
    if (!condition) return { status: "unknown-model" };
    switch (condition.kind) {
      case "available":
        return { status: "available" };
      case "unavailable":
        return { status: "unavailable", detail: condition.detail };
      case "throttled":
        return {
          status: "throttled",
          detail: condition.detail,
          retryAfterSeconds: condition.retryAfterSeconds,
        };
      case "call-failure":
        return { status: "call-failure", detail: condition.detail };
    }
  };

  return {
    listModels: () => Object.keys(spec),
    availability,
    pricing(model) {
      const condition = spec[model];
      if (!condition || condition.kind !== "available") return { known: false };
      const { inputUsdPerMTok, outputUsdPerMTok } = condition;
      if (inputUsdPerMTok === undefined && outputUsdPerMTok === undefined) {
        return { known: false };
      }
      return { known: true, inputUsdPerMTok, outputUsdPerMTok };
    },
    call(model) {
      const result = availability(model);
      calls.push({ model, outcome: result.status });
      return result;
    },
    calls,
    reset() {
      calls.length = 0;
    },
  };
}
