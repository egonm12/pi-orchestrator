import { existsSync } from "node:fs";
import { join } from "node:path";
import { buildCatalog, loadCatalog, type ModelCatalog, type UsageHeadroom } from "../catalog/model-catalog.ts";
import { emptyRefreshState, loadRefreshState, type RefreshState, type ThrottlingObservation } from "../catalog/refresh-lifecycle.ts";
import { providerOf } from "../recipients/authorized-delegation.ts";
import { loadAuthorizationOrEmpty, type RecipientAuthorization } from "../recipients/authorization.ts";
import type { ProviderUsage } from "../routing/tier-router.ts";

// Ticket 27: the evidence the router's hard filters read, and the one place
// ticket 08's per-model observations become ticket 24's per-provider state.

/** What the hard filters read for one worker's first request. */
export interface RoutingEvidence {
  /** Context windows, prices and ticket 08's `usageHeadroom` per model. */
  readonly catalog: ModelCatalog;
  /** Ticket 08's throttling observations. */
  readonly refreshState: RefreshState;
  /** Ticket 07's approved data recipients. */
  readonly authorization: RecipientAuthorization;
}

/** Called once per routed request, so the evidence is as current as the files. */
export type RoutingEvidenceSource = () => RoutingEvidence;

export interface EvidenceSetup {
  /** The harness state folder, resolved once at session start. */
  readonly stateDir: string;
  /** pi's available models, `provider/id`, for a catalog when none is saved. */
  readonly installedModelIds: readonly string[];
}

/**
 * The real source: the harness state folder's files, read on every call.
 *
 *   model-catalog.json          ticket 05/08's saved catalog; when absent, a
 *                               catalog built once from pi's available models
 *                               and the pinned models.dev snapshot.
 *   refresh-state.json          ticket 08's refresh state; empty when absent.
 *   authorized-recipients.json  ticket 07's store, fail closed: absent or
 *                               unreadable means no approved recipient.
 */
export function stateFolderEvidence(setup: EvidenceSetup): RoutingEvidenceSource {
  const catalogPath = join(setup.stateDir, "model-catalog.json");
  const refreshStatePath = join(setup.stateDir, "refresh-state.json");
  const recipientsPath = join(setup.stateDir, "authorized-recipients.json");
  let built: ModelCatalog | undefined;
  return () => ({
    catalog: existsSync(catalogPath) ? loadCatalog(catalogPath) : (built ??= buildCatalog({ modelIds: setup.installedModelIds })),
    refreshState: existsSync(refreshStatePath) ? loadRefreshState(refreshStatePath) : emptyRefreshState(),
    authorization: loadAuthorizationOrEmpty(recipientsPath),
  });
}

/** How long a known "nothing left" holds when it names no reset: the five
 *  hour usage window of the Claude and Codex subscriptions. */
export const USAGE_OBSERVATION_WINDOW_MS = 5 * 60 * 60 * 1000;
/** How long a throttle holds when it carries no `retryAfterSeconds`. */
export const THROTTLE_DEFAULT_WINDOW_MS = 5 * 60 * 1000;

function exhausted(headroom: UsageHeadroom): string | undefined {
  if (headroom.kind === "metered") return headroom.remainingUsd <= 0 ? `$${headroom.remainingUsd} remaining` : undefined;
  return headroom.remaining <= 0 ? `${headroom.remaining} requests remaining` : undefined;
}

/** Still true at `now`: before its reset when it names one, else within the
 *  usage window from when it was learned. */
function exhaustionHolds(headroom: UsageHeadroom, asOf: string, now: number): boolean {
  const resetsAt = headroom.kind === "requests" && headroom.resetsAt !== undefined ? Date.parse(headroom.resetsAt) : Number.NaN;
  if (!Number.isNaN(resetsAt)) return now < resetsAt;
  const learned = Date.parse(asOf);
  return !Number.isNaN(learned) && now < learned + USAGE_OBSERVATION_WINDOW_MS;
}

function throttleHolds(observation: ThrottlingObservation, now: number): boolean {
  const observed = Date.parse(observation.observedAt);
  if (Number.isNaN(observed)) return false;
  const window = observation.retryAfterSeconds === undefined ? THROTTLE_DEFAULT_WINDOW_MS : observation.retryAfterSeconds * 1000;
  return now < observed + window;
}

/**
 * Ticket 24's `providerUsage`, derived from ticket 08's per-model facts.
 *
 * Roll-up: one model is enough. A provider is out of usage when any of its
 * catalog entries has a known `usageHeadroom` with nothing left, and throttled
 * when any `ThrottlingObservation` names one of its models. Subscription
 * limits are per account, so a limit seen on one model is taken to bind the
 * provider; a per-model limit is therefore over-applied, which moves a task
 * to another provider or up a tier, never down.
 *
 * Staleness: ticket 08's facts never expire on their own. A "nothing left"
 * holds until its `resetsAt` when it names one, else for
 * `USAGE_OBSERVATION_WINDOW_MS` after `asOf`. A throttle holds for its
 * `retryAfterSeconds`, else for `THROTTLE_DEFAULT_WINDOW_MS`, after
 * `observedAt`. Out of usage wins over throttled.
 */
export function deriveProviderUsage(evidence: RoutingEvidence, now: Date): Record<string, ProviderUsage> {
  const at = now.getTime();
  const usage: Record<string, ProviderUsage> = {};
  for (const observation of evidence.refreshState.throttling) {
    const provider = providerOf(observation.model);
    if (provider === "" || !throttleHolds(observation, at) || usage[provider] !== undefined) continue;
    usage[provider] = {
      state: "throttled",
      detail: `${observation.model} throttled at ${observation.observedAt}` +
        (observation.retryAfterSeconds === undefined ? "" : `, retry after ${observation.retryAfterSeconds} s`),
    };
  }
  for (const entry of Object.values(evidence.catalog.entries)) {
    const fact = entry.usageHeadroom;
    if (fact.state !== "known") continue;
    const left = exhausted(fact.value);
    if (left === undefined || !exhaustionHolds(fact.value, fact.asOf, at)) continue;
    if (usage[entry.provider]?.state === "out-of-usage") continue;
    usage[entry.provider] = { state: "out-of-usage", detail: `${entry.model} reported ${left} as of ${fact.asOf}` };
  }
  return usage;
}
