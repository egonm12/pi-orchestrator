// Ticket 05: reading the pinned models.dev snapshot.
//
// Pure local file I/O. No network, by construction -- this module imports
// nothing that can reach one.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const SNAPSHOT_SCHEMA_VERSION = 1;

export const SNAPSHOT_PATH = fileURLToPath(
  new URL("./vendor/models-dev.snapshot.json", import.meta.url),
);

/** models.dev's per-model shape, as far as this harness consumes it. Fields
 *  are optional here because the upstream genuinely omits them for some
 *  models -- that absence is what becomes an explicit `unknown` in the
 *  catalog rather than a missing key. */
export interface UpstreamModel {
  readonly id: string;
  readonly name?: string;
  readonly family?: string;
  readonly attachment?: boolean;
  readonly reasoning?: boolean;
  readonly tool_call?: boolean;
  readonly structured_output?: boolean;
  readonly temperature?: boolean;
  readonly open_weights?: boolean;
  readonly knowledge?: string;
  readonly release_date?: string;
  readonly last_updated?: string;
  readonly modalities?: { readonly input?: string[]; readonly output?: string[] };
  readonly limit?: {
    readonly context?: number;
    readonly input?: number;
    readonly output?: number;
  };
  /** USD per 1M tokens. */
  readonly cost?: {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
  };
}

export interface UpstreamProvider {
  readonly id: string;
  readonly name?: string;
  readonly doc?: string;
  readonly models: Record<string, UpstreamModel>;
}

export interface SnapshotSource {
  readonly name: string;
  readonly url: string;
  readonly license: string;
  readonly licenseUrl: string;
  /** ISO-8601. Drives the freshness of every value derived from this pin. */
  readonly fetchedAt: string;
  readonly upstreamSha256: string;
  readonly upstreamProviderCount: number;
  readonly upstreamModelCount: number;
}

export interface Snapshot {
  readonly schemaVersion: number;
  readonly source: SnapshotSource;
  readonly subset: { readonly reason: string; readonly providers: string[] };
  readonly providers: Record<string, UpstreamProvider>;
}

let cached: Snapshot | undefined;

export function loadSnapshot(path: string = SNAPSHOT_PATH): Snapshot {
  if (path === SNAPSHOT_PATH && cached) return cached;
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Snapshot;
  if (parsed.schemaVersion !== SNAPSHOT_SCHEMA_VERSION) {
    throw new Error(
      `snapshot schemaVersion ${parsed.schemaVersion} != expected ${SNAPSHOT_SCHEMA_VERSION}; re-run npm run catalog:refresh`,
    );
  }
  if (path === SNAPSHOT_PATH) cached = parsed;
  return parsed;
}

export function lookupUpstream(
  snapshot: Snapshot,
  upstreamProvider: string,
  modelId: string,
): UpstreamModel | undefined {
  return snapshot.providers[upstreamProvider]?.models[modelId];
}
