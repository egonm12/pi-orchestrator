// Ticket 05: the model catalog routing reads instead of researching the world.
//
// Layer 1 is published data, pinned in `vendor/models-dev.snapshot.json` and
// copied verbatim (see refresh-snapshot.ts for why it is vendored).
// Layer 2 is this file: the epistemic wrapper the published data does not have.
//
// The catalog keeps apart four things the ticket warns are easy to conflate.
// A model appearing in a registry establishes that it is LISTED. It does not
// establish working authentication, live callability, real pricing, upstream
// identity, or task suitability. Each of those is a separate field, and each
// starts `unknown` with a reason -- building an entry never fills them in.
//
// This module performs no network I/O and imports nothing that can.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_FRESHNESS,
  describeFact,
  known,
  readFact,
  unknown,
  type Evidence,
  type Fact,
  type FreshnessPolicy,
} from "./epistemic.ts";
import {
  loadSnapshot,
  lookupUpstream,
  type Snapshot,
  type UpstreamModel,
} from "./snapshot.ts";
import { mappingFor, type RouteBilling } from "./upstream-mapping.ts";

export const CATALOG_SCHEMA_VERSION = 1;

/** USD per 1,000,000 tokens, matching models.dev's `cost` units and the
 *  `inputUsdPerMTok` convention already used in fixtures/provider-double.ts. */
export interface TokenPrice {
  readonly inputUsdPerMTok: number;
  readonly outputUsdPerMTok: number;
  readonly cacheReadUsdPerMTok?: number;
  readonly cacheWriteUsdPerMTok?: number;
}

export interface ContextWindow {
  readonly contextTokens: number;
  readonly maxOutputTokens?: number;
}

export interface Capabilities {
  readonly toolCall: boolean;
  readonly reasoning: boolean;
  readonly structuredOutput: boolean;
  readonly attachment: boolean;
  readonly inputModalities: readonly string[];
  readonly outputModalities: readonly string[];
}

/** Remaining capacity on a route. No published catalog carries this, so it is
 *  always `unknown` when an entry is built. Ticket 08 fills it from session
 *  refresh and observed call results. */
export type UsageHeadroom =
  | { readonly kind: "metered"; readonly remainingUsd: number }
  | { readonly kind: "requests"; readonly remaining: number; readonly resetsAt?: string };

export interface CatalogEntry {
  /** pi routing identity, e.g. "anthropic/claude-sonnet-5". */
  readonly model: string;
  readonly provider: string;
  readonly id: string;

  /** The one claim a registry listing supports, and the only field that is
   *  unconditionally known at build time. */
  readonly listing: {
    readonly listedInRegistry: true;
    readonly evidence: Extract<Evidence, "local-registry-listing">;
    readonly asOf: string;
  };

  /** An assumption from name matching, never confirmation. */
  readonly upstreamIdentity: Fact<string>;
  /** Whether the route bills per call at all. Decides if a dollar figure means
   *  anything, so it is kept apart from the price itself. */
  readonly routeBilling: Fact<RouteBilling>;

  /** Upstream list price. NOT what this route bills -- see effectiveBilledCost. */
  readonly publishedListPrice: Fact<TokenPrice>;
  /** What this route actually charges per call. Unknown on subscription
   *  routes: there is no per-call metered amount to report. */
  readonly effectiveBilledCost: Fact<TokenPrice>;

  readonly contextWindow: Fact<ContextWindow>;
  readonly capabilities: Fact<Capabilities>;
  readonly upstreamLastUpdated: Fact<string>;

  /** Never known at build time. */
  readonly usageHeadroom: Fact<UsageHeadroom>;
  readonly authentication: Fact<"working">;
  readonly liveCallability: Fact<"reachable">;
  /** Per task type. Requires owner-approved capability research (spec). */
  readonly taskSuitability: Fact<Record<string, number>>;
}

export interface ModelCatalog {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  readonly source: Snapshot["source"];
  readonly entries: Record<string, CatalogEntry>;
}

function priceFrom(upstream: UpstreamModel): TokenPrice | undefined {
  const cost = upstream.cost;
  if (!cost || cost.input === undefined || cost.output === undefined) return undefined;
  return {
    inputUsdPerMTok: cost.input,
    outputUsdPerMTok: cost.output,
    ...(cost.cache_read === undefined ? {} : { cacheReadUsdPerMTok: cost.cache_read }),
    ...(cost.cache_write === undefined ? {} : { cacheWriteUsdPerMTok: cost.cache_write }),
  };
}

function contextFrom(upstream: UpstreamModel): ContextWindow | undefined {
  const context = upstream.limit?.context;
  if (context === undefined) return undefined;
  return {
    contextTokens: context,
    ...(upstream.limit?.output === undefined ? {} : { maxOutputTokens: upstream.limit.output }),
  };
}

function capabilitiesFrom(upstream: UpstreamModel): Capabilities | undefined {
  // models.dev marks these per model; if the core flags are absent we do not
  // guess a default, because "probably supports tools" is exactly the kind of
  // unevidenced claim this catalog exists to prevent.
  if (upstream.tool_call === undefined && upstream.reasoning === undefined) return undefined;
  return {
    toolCall: upstream.tool_call ?? false,
    reasoning: upstream.reasoning ?? false,
    structuredOutput: upstream.structured_output ?? false,
    attachment: upstream.attachment ?? false,
    inputModalities: upstream.modalities?.input ?? [],
    outputModalities: upstream.modalities?.output ?? [],
  };
}

export interface BuildOptions {
  readonly modelIds: readonly string[];
  readonly snapshot?: Snapshot;
  readonly now?: Date;
}

export function buildCatalogEntry(
  model: string,
  snapshot: Snapshot,
  listedAt: string,
): CatalogEntry {
  const slash = model.indexOf("/");
  const provider = slash > 0 ? model.slice(0, slash) : "";
  const id = slash > 0 ? model.slice(slash + 1) : model;

  const listing = {
    listedInRegistry: true,
    evidence: "local-registry-listing",
    asOf: listedAt,
  } as const;

  // Fields a listing can never establish. Declared once, up front, so the
  // default is honest ignorance and any known value has to be argued for.
  const neverFromListing = {
    usageHeadroom: unknown<UsageHeadroom>(
      "not-published-anywhere",
      "no published catalog carries remaining quota; ticket 08 fills this from session refresh and observed calls",
    ),
    authentication: unknown<"working">(
      "not-checked",
      "a registry listing does not establish working credentials",
    ),
    liveCallability: unknown<"reachable">(
      "not-checked",
      "a registry listing does not establish that the model answers",
    ),
    taskSuitability: unknown<Record<string, number>>(
      "requires-approved-research",
      "capability research and benchmarks require explicit owner approval before running",
    ),
  };

  const mapping = mappingFor(provider);
  if (!mapping) {
    // Listed, but we cannot even assume an upstream. Everything else unknown.
    return {
      model,
      provider,
      id,
      listing,
      upstreamIdentity: unknown<string>(
        "not-checked",
        `no upstream mapping declared for pi provider '${provider}'`,
      ),
      routeBilling: unknown<RouteBilling>("not-checked"),
      publishedListPrice: unknown<TokenPrice>(
        "absent-from-source",
        "no upstream mapping, so no published entry could be located",
      ),
      effectiveBilledCost: unknown<TokenPrice>("not-checked"),
      contextWindow: unknown<ContextWindow>("absent-from-source"),
      capabilities: unknown<Capabilities>("absent-from-source"),
      upstreamLastUpdated: unknown<string>("absent-from-source"),
      ...neverFromListing,
    };
  }

  const upstreamId = `${mapping.upstreamProvider}/${id}`;
  const upstream = lookupUpstream(snapshot, mapping.upstreamProvider, id);
  const fetchedAt = snapshot.source.fetchedAt;

  // The mapping is a name-matching assumption even when it resolves.
  const upstreamIdentity: Fact<string> = upstream
    ? known(
        upstreamId,
        "assumed-name-mapping",
        fetchedAt,
        "matched by name across namespaces; not confirmed against the provider",
      )
    : unknown<string>(
        "absent-from-source",
        `assumed upstream '${upstreamId}' is not present in the pinned snapshot`,
      );

  // Billing shape uses the provider-specific evidence documented in
  // UPSTREAM_MAPPINGS[].billingBasis: package/software-derived for anthropic,
  // operator-stated for openai-codex.
  const routeBilling = known<RouteBilling>(
    mapping.billing,
    "operator-configured",
    fetchedAt,
    mapping.billingBasis,
  );

  // A subscription route has no per-call billed amount. Reporting the upstream
  // list price here would be the exact conflation ticket 10 depends on avoiding
  // -- and 01-findings.md §B.2 shows pi's own reported figures are $0 for
  // the since-uninstalled claude-bridge route and list-derived estimates for
  // openai-codex, neither of which is an amount billed for the call.
  const effectiveBilledCost: Fact<TokenPrice> =
    mapping.billing === "subscription"
      ? unknown<TokenPrice>(
          "not-metered",
          "subscription-routed: no per-call billed amount exists; pi's reported per-run cost is a list-price-derived consumption estimate, not a charge",
        )
      : unknown<TokenPrice>(
          "not-checked",
          "metered route, but no billed amount has been observed yet",
        );

  if (!upstream) {
    return {
      model,
      provider,
      id,
      listing,
      upstreamIdentity,
      routeBilling,
      publishedListPrice: unknown<TokenPrice>(
        "absent-from-source",
        `no entry for '${upstreamId}' in the pinned models.dev snapshot`,
      ),
      effectiveBilledCost,
      contextWindow: unknown<ContextWindow>("absent-from-source"),
      capabilities: unknown<Capabilities>("absent-from-source"),
      upstreamLastUpdated: unknown<string>("absent-from-source"),
      ...neverFromListing,
    };
  }

  const price = priceFrom(upstream);
  const context = contextFrom(upstream);
  const capabilities = capabilitiesFrom(upstream);

  return {
    model,
    provider,
    id,
    listing,
    upstreamIdentity,
    routeBilling,
    // asOf is the snapshot fetch time, not the model's own last_updated: the
    // question freshness answers is "when did we last confirm this against the
    // source", and that is when we fetched. The upstream's own edit date is
    // carried separately below.
    publishedListPrice: price
      ? known(price, "published-dataset", fetchedAt, `via assumed upstream ${upstreamId}`)
      : unknown<TokenPrice>(
          "absent-from-source",
          `models.dev carries no cost for '${upstreamId}'`,
        ),
    effectiveBilledCost,
    contextWindow: context
      ? known(context, "published-dataset", fetchedAt, `via assumed upstream ${upstreamId}`)
      : unknown<ContextWindow>("absent-from-source"),
    capabilities: capabilities
      ? known(capabilities, "published-dataset", fetchedAt, `via assumed upstream ${upstreamId}`)
      : unknown<Capabilities>("absent-from-source"),
    upstreamLastUpdated: upstream.last_updated
      ? known(upstream.last_updated, "published-dataset", fetchedAt)
      : unknown<string>("absent-from-source"),
    ...neverFromListing,
  };
}

export function buildCatalog(options: BuildOptions): ModelCatalog {
  const snapshot = options.snapshot ?? loadSnapshot();
  const now = (options.now ?? new Date()).toISOString();
  const entries: Record<string, CatalogEntry> = {};
  for (const model of options.modelIds) {
    entries[model] = buildCatalogEntry(model, snapshot, now);
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt: now,
    source: snapshot.source,
    entries,
  };
}

// ---------------------------------------------------------------------------
// Persistence: the catalog and its epistemic layer survive a session restart
// ---------------------------------------------------------------------------

/** Default on-disk location. Runtime state, not source: git-ignored. */
export const DEFAULT_CATALOG_PATH = "src/state/model-catalog.json";

export function saveCatalog(path: string, catalog: ModelCatalog): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(catalog, null, 2)}\n`);
}

export function loadCatalog(path: string): ModelCatalog {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as ModelCatalog;
  if (parsed.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(
      `catalog schemaVersion ${parsed.schemaVersion} != expected ${CATALOG_SCHEMA_VERSION}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Reading: the only source consulted during routing
// ---------------------------------------------------------------------------

export function lookup(catalog: ModelCatalog, model: string): CatalogEntry | undefined {
  return catalog.entries[model];
}

/** Human-readable summary of one entry. Every line goes through describeFact,
 *  so an unknown renders as `unknown (reason)` and cannot be printed as a
 *  number or as unlimited capacity. */
export function describeEntry(
  entry: CatalogEntry,
  policy: FreshnessPolicy = DEFAULT_FRESHNESS,
  now: number = Date.now(),
): Record<string, string> {
  const view = <T>(fact: Fact<T>) => readFact(fact, policy, now);
  const money = (p: TokenPrice) =>
    `$${p.inputUsdPerMTok}/M in, $${p.outputUsdPerMTok}/M out`;
  return {
    model: entry.model,
    listing: `listed in registry (as of ${entry.listing.asOf})`,
    upstreamIdentity: describeFact(view(entry.upstreamIdentity), (v) => `${v} (assumed)`),
    routeBilling: describeFact(view(entry.routeBilling), (v) => v),
    publishedListPrice: describeFact(view(entry.publishedListPrice), money),
    effectiveBilledCost: describeFact(view(entry.effectiveBilledCost), money),
    contextWindow: describeFact(
      view(entry.contextWindow),
      (c) => `${c.contextTokens} tokens`,
    ),
    capabilities: describeFact(
      view(entry.capabilities),
      (c) => `tools=${c.toolCall} reasoning=${c.reasoning} structured=${c.structuredOutput}`,
    ),
    usageHeadroom: describeFact(view(entry.usageHeadroom), (h) =>
      h.kind === "metered" ? `$${h.remainingUsd} remaining` : `${h.remaining} requests remaining`,
    ),
    authentication: describeFact(view(entry.authentication), () => "working"),
    liveCallability: describeFact(view(entry.liveCallability), () => "reachable"),
    taskSuitability: describeFact(view(entry.taskSuitability), (s) => JSON.stringify(s)),
  };
}
