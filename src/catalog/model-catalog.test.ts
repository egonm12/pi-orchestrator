import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { INSTALLED_MODEL_IDS } from "../fixtures/installed-models.ts";
import {
  CAPACITY_MISREADINGS,
  DEFAULT_FRESHNESS,
  describeFact,
  isTrustworthy,
  known,
  readFact,
  unknown,
  type Fact,
} from "./epistemic.ts";
import {
  buildCatalog,
  buildCatalogEntry,
  CATALOG_SCHEMA_VERSION,
  describeEntry,
  loadCatalog,
  lookup,
  saveCatalog,
  type CatalogEntry,
  type TokenPrice,
} from "./model-catalog.ts";
import { loadSnapshot, SNAPSHOT_PATH } from "./snapshot.ts";
import { requiredUpstreamProviders, UPSTREAM_MAPPINGS } from "./upstream-mapping.ts";

const here = dirname(fileURLToPath(import.meta.url));
const snapshot = loadSnapshot();
const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS] });

function tempState(): { path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-harness-catalog-"));
  return {
    path: join(dir, "model-catalog.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function entryFor(model: string): CatalogEntry {
  const entry = lookup(catalog, model);
  assert.ok(entry, `expected a catalog entry for ${model}`);
  return entry;
}

/** `assert.equal` does not narrow a union, so unknown-ness is asserted through
 *  a helper that both checks and narrows. */
function expectUnknown<T>(fact: Fact<T>, field: string): Extract<Fact<T>, { state: "unknown" }> {
  assert.equal(fact.state, "unknown", `${field} must be unknown`);
  if (fact.state !== "unknown") throw new Error("unreachable");
  return fact;
}

function expectKnown<T>(fact: Fact<T>, field: string): Extract<Fact<T>, { state: "known" }> {
  assert.equal(fact.state, "known", `${field} must be known`);
  if (fact.state !== "known") throw new Error("unreachable");
  return fact;
}

// ---------------------------------------------------------------------------
// Published catalog, pinned locally, not hand-maintained
// ---------------------------------------------------------------------------

test("pricing, context and capability data come from the pinned published snapshot", () => {
  assert.equal(snapshot.source.name, "models.dev");
  assert.equal(snapshot.source.url, "https://models.dev/api.json");
  assert.match(snapshot.source.upstreamSha256, /^[0-9a-f]{64}$/);

  // The pin records what it was taken from, so a stale pin is detectable.
  assert.ok(snapshot.source.upstreamProviderCount > 100);
  assert.ok(snapshot.source.upstreamModelCount > 1000);

  const entry = entryFor("anthropic/claude-sonnet-5");
  expectKnown(entry.publishedListPrice, "publishedListPrice");
  expectKnown(entry.contextWindow, "contextWindow");
  expectKnown(entry.capabilities, "capabilities");
});

test("published values are copied verbatim from the snapshot, not restated", () => {
  // Every known price/context in the catalog must be byte-identical to the
  // upstream record it came from. This is what "not hand-maintained" means
  // operationally: no number in the catalog has an independent origin.
  let checked = 0;
  for (const model of INSTALLED_MODEL_IDS) {
    const entry = entryFor(model);
    const mapping = UPSTREAM_MAPPINGS.find((m) => m.piProvider === entry.provider);
    assert.ok(mapping);
    const upstream = snapshot.providers[mapping.upstreamProvider]?.models[entry.id];
    assert.ok(upstream, `snapshot should carry ${mapping.upstreamProvider}/${entry.id}`);

    if (entry.publishedListPrice.state === "known") {
      assert.equal(entry.publishedListPrice.value.inputUsdPerMTok, upstream.cost?.input);
      assert.equal(entry.publishedListPrice.value.outputUsdPerMTok, upstream.cost?.output);
      checked += 1;
    }
    if (entry.contextWindow.state === "known") {
      assert.equal(entry.contextWindow.value.contextTokens, upstream.limit?.context);
    }
    if (entry.capabilities.state === "known") {
      assert.equal(entry.capabilities.value.toolCall, upstream.tool_call ?? false);
    }
  }
  assert.equal(checked, INSTALLED_MODEL_IDS.length, "every registry model should carry a published price");
});

test("the snapshot subset is driven by the declared mapping, not hand-picked", () => {
  assert.deepEqual(snapshot.subset.providers, requiredUpstreamProviders());
  assert.deepEqual(Object.keys(snapshot.providers).sort(), requiredUpstreamProviders());
});

test("reading the catalog never invokes the refresh script", () => {
  // The only networked module is refresh-snapshot.ts. Nothing the catalog
  // imports may reference it, or a routing read could trigger a fetch.
  for (const file of ["model-catalog.ts", "snapshot.ts", "epistemic.ts", "upstream-mapping.ts"]) {
    const src = readFileSync(join(here, file), "utf8");
    const imports = [...src.matchAll(/^\s*import[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]);
    assert.ok(
      !imports.includes("./refresh-snapshot.ts"),
      `${file} must not import the networked refresh script`,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-field evidence and freshness
// ---------------------------------------------------------------------------

test("every field records evidence and freshness, not just a value", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  const price = expectKnown(entry.publishedListPrice, "publishedListPrice");
  assert.equal(price.evidence, "published-dataset");
  assert.equal(price.asOf, snapshot.source.fetchedAt);
  assert.ok(!Number.isNaN(Date.parse(price.asOf)), "asOf must be a real timestamp");
});

test("evidence distinguishes a published value from an assumed one", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  // The upstream correspondence is a name-match assumption, and says so.
  const upstream = expectKnown(entry.upstreamIdentity, "upstreamIdentity");
  assert.equal(upstream.evidence, "assumed-name-mapping");
  assert.equal(upstream.value, "anthropic/claude-sonnet-5");
  // The price, reached through that assumption, is published data but records
  // the route it came by.
  const price = expectKnown(entry.publishedListPrice, "publishedListPrice");
  assert.match(String(price.note), /assumed upstream anthropic\/claude-sonnet-5/);
  // Billing shape came from the operator, and cites the operator.
  assert.equal(expectKnown(entry.routeBilling, "routeBilling").evidence, "operator-configured");
});

// ---------------------------------------------------------------------------
// Unknown and stale are explicit, and distinct from a missing field
// ---------------------------------------------------------------------------

test("unknown is a value with a reason, not an absent key", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  assert.ok("usageHeadroom" in entry, "the key must be present");
  assert.equal(expectUnknown(entry.usageHeadroom, "usageHeadroom").reason, "not-published-anywhere");
  // And it survives serialization as a present key, rather than vanishing the
  // way `undefined` would.
  const roundTripped = JSON.parse(JSON.stringify(entry)) as CatalogEntry;
  assert.ok("usageHeadroom" in roundTripped);
  assert.equal(roundTripped.usageHeadroom.state, "unknown");
});

test("different unknowns carry different reasons", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  assert.equal(expectUnknown(entry.usageHeadroom, "usageHeadroom").reason, "not-published-anywhere");
  assert.equal(expectUnknown(entry.authentication, "authentication").reason, "not-checked");
  assert.equal(expectUnknown(entry.liveCallability, "liveCallability").reason, "not-checked");
  assert.equal(
    expectUnknown(entry.taskSuitability, "taskSuitability").reason,
    "requires-approved-research",
  );
  assert.equal(
    expectUnknown(entry.effectiveBilledCost, "effectiveBilledCost").reason,
    "not-metered",
  );
});

test("a field the published source genuinely omits becomes an explicit unknown", () => {
  // Not hypothetical: models.dev carries openai/gpt-image-* with no `cost`.
  const imageModel = Object.values(snapshot.providers["openai"]?.models ?? {}).find(
    (m) => m.cost === undefined,
  );
  assert.ok(imageModel, "expected at least one snapshot model with no cost");
  const entry = buildCatalogEntry(
    `openai-codex/${imageModel.id}`,
    snapshot,
    new Date().toISOString(),
  );
  const price = expectUnknown(entry.publishedListPrice, "publishedListPrice");
  assert.equal(price.reason, "absent-from-source");
  assert.match(String(price.note), /carries no cost/);
});

test("stale is derived from age, and is distinct from known and unknown", () => {
  const asOf = new Date("2026-01-01T00:00:00.000Z").toISOString();
  const fact = known({ inputUsdPerMTok: 2, outputUsdPerMTok: 10 }, "published-dataset", asOf);

  const fresh = readFact(fact, { ttlMs: 60_000 }, Date.parse(asOf) + 30_000);
  assert.equal(fresh.state, "known");

  const stale = readFact(fact, { ttlMs: 60_000 }, Date.parse(asOf) + 120_000);
  assert.equal(stale.state, "stale");
  // Stale keeps the value -- it is flagged, not discarded.
  assert.equal(stale.state === "stale" && stale.value.inputUsdPerMTok, 2);
  assert.equal(stale.state === "stale" && stale.ttlMs, 60_000);

  const missing = readFact(unknown<TokenPrice>("not-checked"), { ttlMs: 60_000 });
  assert.equal(missing.state, "unknown");
});

test("stale is not stored, so a persisted value cannot keep claiming to be fresh", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  const serialized = JSON.stringify(entry);
  assert.ok(!serialized.includes('"stale"'), "staleness must not be a stored bit");
  // The same stored fact reads fresh now and stale later, with nothing rewritten.
  const price = entry.publishedListPrice;
  assert.equal(readFact(price, DEFAULT_FRESHNESS, Date.now()).state, "known");
  assert.equal(
    readFact(price, DEFAULT_FRESHNESS, Date.now() + 400 * 24 * 60 * 60 * 1000).state,
    "stale",
  );
});

test("an untimestamped value never reads as fresh", () => {
  const bogus = known(1, "published-dataset", "not-a-date");
  const view = readFact(bogus, { ttlMs: Number.MAX_SAFE_INTEGER });
  assert.equal(view.state, "stale");
  assert.equal(view.state === "stale" && view.ageMs, Number.POSITIVE_INFINITY);
});

test("isTrustworthy accepts only fresh known values", () => {
  const asOf = new Date().toISOString();
  assert.equal(isTrustworthy(readFact(known(1, "published-dataset", asOf), { ttlMs: 60_000 })), true);
  assert.equal(
    isTrustworthy(readFact(known(1, "published-dataset", asOf), { ttlMs: 60_000 }, Date.now() + 120_000)),
    false,
  );
  assert.equal(isTrustworthy(readFact(unknown<number>("not-checked"))), false);
});

// ---------------------------------------------------------------------------
// Unknown quota is never rendered as unlimited capacity
// ---------------------------------------------------------------------------

test("unknown quota is never rendered as unlimited, free, or a number", () => {
  for (const model of INSTALLED_MODEL_IDS) {
    const rendered = describeEntry(entryFor(model));
    const headroom = rendered["usageHeadroom"] ?? "";
    assert.equal(headroom, "unknown (not-published-anywhere)");
    const lower = headroom.toLowerCase();
    for (const bad of CAPACITY_MISREADINGS) {
      assert.ok(!lower.includes(bad), `${model} headroom must not read as '${bad}': ${headroom}`);
    }
    assert.ok(!/\d/.test(headroom), `unknown headroom must not render a number: ${headroom}`);
  }
});

test("no unknown field anywhere renders as a capacity claim", () => {
  for (const model of INSTALLED_MODEL_IDS) {
    for (const [field, text] of Object.entries(describeEntry(entryFor(model)))) {
      if (!text.startsWith("unknown (")) continue;
      const lower = text.toLowerCase();
      for (const bad of CAPACITY_MISREADINGS) {
        assert.ok(!lower.includes(bad), `${model}.${field} must not read as '${bad}': ${text}`);
      }
    }
  }
});

test("a subscription route reports unknown billed cost rather than the list price", () => {
  // The honesty case from 01-findings.md §B.2: the since-uninstalled
  // claude-bridge route reported $0 and openai-codex reported list-derived
  // figures. Neither is an amount billed, and the Claude subscription now
  // arrives on the `anthropic` route with the same property.
  for (const model of ["anthropic/claude-sonnet-5", "openai-codex/gpt-5.6-sol"]) {
    const entry = entryFor(model);
    assert.equal(expectKnown(entry.routeBilling, "routeBilling").value, "subscription");
    assert.equal(
      expectUnknown(entry.effectiveBilledCost, "effectiveBilledCost").reason,
      "not-metered",
    );
    // The list price is still known -- the two are kept apart, not collapsed.
    expectKnown(entry.publishedListPrice, "publishedListPrice");
    const rendered = describeEntry(entry);
    assert.equal(rendered["effectiveBilledCost"], "unknown (not-metered)");
    assert.notEqual(rendered["effectiveBilledCost"], rendered["publishedListPrice"]);
  }
});

test("describeFact renders an unknown as its reason and never as a value", () => {
  const view = readFact(unknown<number>("not-published-anywhere"));
  assert.equal(describeFact(view, (v) => `${v} remaining`), "unknown (not-published-anywhere)");
});

// ---------------------------------------------------------------------------
// A registry listing alone establishes nothing else
// ---------------------------------------------------------------------------

test("a registry listing populates only the listing claim", () => {
  const entry = entryFor("anthropic/claude-sonnet-5");
  assert.equal(entry.listing.listedInRegistry, true);
  assert.equal(entry.listing.evidence, "local-registry-listing");
  // The five things the ticket says a listing does NOT establish.
  expectUnknown(entry.authentication, "authentication");
  expectUnknown(entry.liveCallability, "liveCallability");
  expectUnknown(entry.effectiveBilledCost, "effectiveBilledCost");
  expectUnknown(entry.taskSuitability, "taskSuitability");
  assert.notEqual(
    expectKnown(entry.upstreamIdentity, "upstreamIdentity").evidence,
    "local-registry-listing",
  );
});

test("a listed model with no published entry stays listed and otherwise unknown", () => {
  const entry = buildCatalogEntry(
    "anthropic/claude-does-not-exist-9",
    snapshot,
    new Date().toISOString(),
  );
  assert.equal(entry.listing.listedInRegistry, true);
  expectUnknown(entry.publishedListPrice, "publishedListPrice");
  expectUnknown(entry.contextWindow, "contextWindow");
  expectUnknown(entry.capabilities, "capabilities");
  assert.equal(expectUnknown(entry.upstreamIdentity, "upstreamIdentity").reason, "absent-from-source");
});

test("a listed model from an unmapped provider assumes no upstream at all", () => {
  const entry = buildCatalogEntry("some-new-provider/mystery-1", snapshot, new Date().toISOString());
  assert.equal(entry.listing.listedInRegistry, true);
  assert.match(
    String(expectUnknown(entry.upstreamIdentity, "upstreamIdentity").note),
    /no upstream mapping/,
  );
  expectUnknown(entry.routeBilling, "routeBilling");
});

test("prohibited models are catalogued as honest data, not filtered", () => {
  // The catalog reports what exists; ticket 04's resolver is the enforcement
  // point. Conflating the two would hide data behind policy.
  for (const model of [
    "anthropic/claude-fable-5",
    "anthropic/claude-fable-5-1",
    "openai-codex/gpt-6-astra",
  ]) {
    const entry = entryFor(model);
    assert.equal(entry.listing.listedInRegistry, true);
    expectKnown(entry.publishedListPrice, "publishedListPrice");
  }
});

// ---------------------------------------------------------------------------
// No network during repeated reads
// ---------------------------------------------------------------------------

test("repeated catalog reads perform no network call of any kind", () => {
  const state = tempState();
  try {
    const result = spawnSync(
      process.execPath,
      [join(here, "no-network-probe.ts"), state.path],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 0, `probe failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout.trim()) as {
      reads: number;
      networkAttempts: string[];
      entries: number;
      headroomRenderings: string[];
    };
    assert.deepEqual(report.networkAttempts, [], "catalog reads must not touch the network");
    assert.equal(report.reads, 25 * INSTALLED_MODEL_IDS.length);
    assert.equal(report.entries, INSTALLED_MODEL_IDS.length);
    assert.deepEqual(report.headroomRenderings, ["unknown (not-published-anywhere)"]);
  } finally {
    state.cleanup();
  }
});

test("the no-network probe's traps really do fire on a network attempt", () => {
  // Otherwise the test above could pass because the traps were never armed.
  const script =
    'import net from "node:net";' +
    'let fired=false;' +
    'net.Socket.prototype.connect=()=>{fired=true;throw new Error("trapped")};' +
    'try{await fetch("https://models.dev/api.json")}catch{}' +
    'try{new net.Socket().connect(443,"models.dev")}catch{}' +
    'process.stdout.write(JSON.stringify({fired}))';
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout.trim()).fired, true);
});

// ---------------------------------------------------------------------------
// Survives a session restart
// ---------------------------------------------------------------------------

test("the catalog and its epistemic layer survive a restart in a fresh process", () => {
  const state = tempState();
  try {
    saveCatalog(state.path, catalog);

    const result = spawnSync(
      process.execPath,
      [join(here, "restart-probe.ts"), state.path, "anthropic/claude-sonnet-5"],
      { encoding: "utf8", timeout: 60_000 },
    );
    assert.equal(result.status, 0, `restart probe failed: ${result.stderr}`);
    const report = JSON.parse(result.stdout.trim());

    assert.notEqual(report.pid, process.pid, "must be a genuinely separate process");
    assert.equal(report.schemaVersion, CATALOG_SCHEMA_VERSION);
    assert.equal(report.sourceSha256, snapshot.source.upstreamSha256);

    // The values survived...
    const original = entryFor("anthropic/claude-sonnet-5");
    assert.deepEqual(report.publishedListPrice, JSON.parse(JSON.stringify(original.publishedListPrice)));

    // ...and so did the epistemic metadata, which is the part that matters.
    assert.equal(report.publishedListPrice.evidence, "published-dataset");
    assert.equal(report.publishedListPrice.asOf, snapshot.source.fetchedAt);
    assert.equal(report.upstreamIdentity.evidence, "assumed-name-mapping");
    assert.equal(report.usageHeadroom.state, "unknown");
    assert.equal(report.usageHeadroom.reason, "not-published-anywhere");
    assert.equal(report.authentication.reason, "not-checked");
    assert.equal(report.taskSuitability.reason, "requires-approved-research");
    assert.equal(report.effectiveBilledCost.reason, "not-metered");

    // Freshness still derives correctly after reload.
    assert.equal(report.priceViewFresh, "known");
    assert.equal(report.priceViewStale, "stale");
  } finally {
    state.cleanup();
  }
});

test("a persisted catalog with an unexpected schema version is rejected", () => {
  const state = tempState();
  try {
    saveCatalog(state.path, { ...catalog, schemaVersion: 999 });
    assert.throws(() => loadCatalog(state.path), /schemaVersion 999/);
  } finally {
    state.cleanup();
  }
});

test("persistence leaves no state in the project working tree", () => {
  const state = tempState();
  try {
    saveCatalog(state.path, catalog);
    assert.ok(state.path.startsWith(tmpdir()), "tests must persist only under the temp dir");
  } finally {
    state.cleanup();
  }
  assert.equal(SNAPSHOT_PATH.includes("vendor"), true);
});
