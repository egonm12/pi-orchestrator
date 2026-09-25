// Ticket 05: proof that the catalog and its epistemic layer survive a restart.
//
// A fresh process with no in-memory state reads the persisted catalog and
// prints the epistemic metadata back out -- evidence, asOf, unknown reasons --
// not just the raw values. Round-tripping the numbers alone would not show
// that provenance survived, which is the part this ticket adds.

import { loadCatalog, lookup } from "./model-catalog.ts";
import { readFact } from "./epistemic.ts";

const [, , statePath, model] = process.argv;
if (!statePath || !model) throw new Error("usage: restart-probe.ts <state-path> <model>");

const catalog = loadCatalog(statePath);
const entry = lookup(catalog, model);
if (!entry) throw new Error(`no catalog entry for ${model}`);

const report = {
  pid: process.pid,
  schemaVersion: catalog.schemaVersion,
  sourceName: catalog.source.name,
  sourceSha256: catalog.source.upstreamSha256,
  model: entry.model,
  listing: entry.listing,
  publishedListPrice: entry.publishedListPrice,
  effectiveBilledCost: entry.effectiveBilledCost,
  usageHeadroom: entry.usageHeadroom,
  authentication: entry.authentication,
  taskSuitability: entry.taskSuitability,
  upstreamIdentity: entry.upstreamIdentity,
  // A derived read, to show the freshness layer still works after reload.
  priceViewFresh: readFact(entry.publishedListPrice, { ttlMs: 30 * 24 * 60 * 60 * 1000 }, Date.now()).state,
  priceViewStale: readFact(entry.publishedListPrice, { ttlMs: 1 }, Date.now() + 1_000_000).state,
};

process.stdout.write(`${JSON.stringify(report)}\n`);
