// Test fixture (ticket 06): overlay evidence onto a catalog built from the
// real pinned snapshot.
//
// The catalog builder never populates `taskSuitability` or `usageHeadroom` --
// both are `unknown` by construction, because a registry listing establishes
// neither and no published dataset carries them. That is correct, and it is
// also why routing needs a way to be handed the evidence it would have once
// ticket 08 observes it and an operator approves capability research.
//
// These helpers produce a NEW catalog rather than mutating one, so a test
// cannot accidentally leak evidence into another test's view of the world.
// Published values are never touched: prices and capability flags stay exactly
// as the pinned snapshot recorded them.

import { known, unknown, type Evidence } from "../catalog/epistemic.ts";
import type {
  CatalogEntry,
  ModelCatalog,
  UsageHeadroom,
} from "../catalog/model-catalog.ts";

export interface SuitabilityOverlayOptions {
  /** Defaults to `operator-configured`: an operator stating a capability is a
   *  cited source in the catalog's own vocabulary, unlike a guess from a name. */
  readonly evidence?: Evidence;
  readonly asOf?: string;
}

/** Overlay per-model, per-task-type suitability scores. */
export function withTaskSuitability(
  catalog: ModelCatalog,
  scores: Readonly<Record<string, Readonly<Record<string, number>>>>,
  options: SuitabilityOverlayOptions = {},
): ModelCatalog {
  const evidence = options.evidence ?? "operator-configured";
  const asOf = options.asOf ?? new Date().toISOString();
  const entries: Record<string, CatalogEntry> = {};
  for (const [model, entry] of Object.entries(catalog.entries)) {
    const score = scores[model];
    entries[model] =
      score === undefined
        ? entry
        : { ...entry, taskSuitability: known({ ...score }, evidence, asOf) };
  }
  return { ...catalog, entries };
}

/** Overlay known usage headroom. Anything omitted stays `unknown`. */
export function withUsageHeadroom(
  catalog: ModelCatalog,
  headroom: Readonly<Record<string, UsageHeadroom>>,
  options: SuitabilityOverlayOptions = {},
): ModelCatalog {
  const evidence = options.evidence ?? "observed-from-call";
  const asOf = options.asOf ?? new Date().toISOString();
  const entries: Record<string, CatalogEntry> = {};
  for (const [model, entry] of Object.entries(catalog.entries)) {
    const value = headroom[model];
    entries[model] =
      value === undefined
        ? entry
        : { ...entry, usageHeadroom: known(value, evidence, asOf) };
  }
  return { ...catalog, entries };
}

/** Drop the published price, to exercise the incomparable-cost path. */
export function withoutPublishedPrice(
  catalog: ModelCatalog,
  models: readonly string[],
): ModelCatalog {
  const entries: Record<string, CatalogEntry> = {};
  for (const [model, entry] of Object.entries(catalog.entries)) {
    entries[model] = models.includes(model)
      ? { ...entry, publishedListPrice: unknown("absent-from-source", "removed by fixture") }
      : entry;
  }
  return { ...catalog, entries };
}

/** Restrict a catalog to a subset of models, keeping every fact intact. */
export function onlyModels(
  catalog: ModelCatalog,
  models: readonly string[],
): ModelCatalog {
  const entries: Record<string, CatalogEntry> = {};
  for (const model of models) {
    const entry = catalog.entries[model];
    if (entry) entries[model] = entry;
  }
  return { ...catalog, entries };
}
