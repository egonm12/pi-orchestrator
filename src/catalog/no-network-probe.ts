// Ticket 05: proof that repeated catalog reads perform no network research,
// no benchmark run, and no provider-wide poll.
//
// Runs in its own process. Network primitives are trapped BEFORE the catalog
// is imported, so anything the catalog does at import time is caught too.
// A trap records the attempt and throws, meaning a catalog that tried to reach
// the network would both be counted and fail loudly rather than quietly
// succeeding from a cache.
//
// Socket.prototype.connect is the important one: `fetch`/undici, node:http,
// node:https and node:net all bottom out there, so patching it catches a
// network call made through any of them, including one made by a dependency
// that never touches global fetch.

import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

const attempts: string[] = [];

function trap(label: string): (...args: unknown[]) => never {
  return (...args: unknown[]) => {
    const target = typeof args[0] === "string" ? args[0] : JSON.stringify(args[0] ?? null);
    attempts.push(`${label}:${String(target).slice(0, 120)}`);
    throw new Error(`pi-orchestration-harness: network call attempted via ${label}`);
  };
}

globalThis.fetch = trap("fetch") as unknown as typeof fetch;
net.Socket.prototype.connect = trap("net.Socket.connect") as never;
net.connect = trap("net.connect") as never;
net.createConnection = trap("net.createConnection") as never;
http.request = trap("http.request") as never;
http.get = trap("http.get") as never;
https.request = trap("https.request") as never;
https.get = trap("https.get") as never;
tls.connect = trap("tls.connect") as never;
dns.lookup = trap("dns.lookup") as never;
dns.resolve = trap("dns.resolve") as never;
(dns.promises as { lookup: unknown }).lookup = trap("dns.promises.lookup");

// Imported only after the traps are installed.
const { buildCatalog, describeEntry, lookup, loadCatalog, saveCatalog } = await import(
  "./model-catalog.ts"
);
const { INSTALLED_MODEL_IDS } = await import("../fixtures/installed-models.ts");

const statePath = process.argv[2];
if (!statePath) throw new Error("usage: no-network-probe.ts <state-path>");

const catalog = buildCatalog({ modelIds: [...INSTALLED_MODEL_IDS] });
saveCatalog(statePath, catalog);
const reloaded = loadCatalog(statePath);

// Repeated routing-style reads. If any of these researched the world, a trap
// would have fired.
let reads = 0;
const rendered: string[] = [];
for (let round = 0; round < 25; round += 1) {
  for (const model of INSTALLED_MODEL_IDS) {
    const entry = lookup(reloaded, model);
    if (!entry) throw new Error(`missing catalog entry for ${model}`);
    reads += 1;
    if (round === 0) rendered.push(describeEntry(entry)["usageHeadroom"] ?? "");
  }
}

process.stdout.write(
  `${JSON.stringify({
    reads,
    networkAttempts: attempts,
    entries: Object.keys(reloaded.entries).length,
    headroomRenderings: [...new Set(rendered)],
  })}\n`,
);
