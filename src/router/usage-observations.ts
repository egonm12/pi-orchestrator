import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { ProviderUsage } from "../routing/tier-router.ts";
import { THROTTLE_DEFAULT_WINDOW_MS, USAGE_OBSERVATION_WINDOW_MS } from "./evidence.ts";

// The usage store (PRD cml8, "Usage observations"): the latest usage
// observation per provider, in one file of its own in the owner's state
// folder, so every session and project of the owner reads it before routing.
// It is not ticket 08's refresh state.
//
//   usage-observations.json  { "schemaVersion": "usage-observations/1",
//                              "providers": { "<provider>": UsageObservation } }
//
// Several sessions can write at once. A write holds a lock file next to the
// store while it reads the file, merges its one provider into it and replaces
// the file by renaming a finished temporary file over it. So a write keeps
// every other provider, and a reader, which takes no lock, never sees half a
// file. A lock left by a process that died mid-write is broken once it is
// older than any write takes.

const USAGE_OBSERVATIONS_FILE = "usage-observations.json";
const SCHEMA_VERSION = "usage-observations/1";
/** A lock this old was left by a process that died holding it. */
const STALE_LOCK_MS = 2_000;
const LOCK_RETRY_MS = 2;

const USAGE_STATES = ["available", "low", "exhausted", "throttled"] as const;
export type UsageState = (typeof USAGE_STATES)[number];
const USAGE_SOURCES = ["error", "header"] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

/** The latest known state of one provider's usage (CONTEXT.md, Usage observation). */
export interface UsageObservation {
  readonly state: UsageState;
  /** 0 to 100, when known. */
  readonly percentLeft?: number;
  /** When the limit lifts, as an ISO time, when the provider said so. */
  readonly resetsAt?: string;
  readonly observedAt: string;
  readonly source: UsageSource;
}

export type UsageObservations = Readonly<Record<string, UsageObservation>>;

export function usageObservationsPath(stateDir: string): string {
  return join(stateDir, USAGE_OBSERVATIONS_FILE);
}

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function observationOf(value: unknown): UsageObservation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const entry = value as Record<string, unknown>;
  if (!USAGE_STATES.includes(entry.state as UsageState) || !USAGE_SOURCES.includes(entry.source as UsageSource)) return undefined;
  if (!isTime(entry.observedAt) || (entry.resetsAt !== undefined && !isTime(entry.resetsAt))) return undefined;
  const percentLeft = entry.percentLeft;
  if (percentLeft !== undefined && (typeof percentLeft !== "number" || !(percentLeft >= 0 && percentLeft <= 100))) return undefined;
  return {
    state: entry.state as UsageState,
    ...(percentLeft === undefined ? {} : { percentLeft }),
    ...(entry.resetsAt === undefined ? {} : { resetsAt: entry.resetsAt as string }),
    observedAt: entry.observedAt,
    source: entry.source as UsageSource,
  };
}

/** Every valid observation in the store at `path`. A missing or unreadable
 *  file, or an entry that is not an observation, adds nothing: the store is
 *  advice, and the next limit error writes it again. */
export function readUsageObservations(path: string): UsageObservations {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return {}; }
  if (typeof parsed !== "object" || parsed === null) return {};
  const { schemaVersion, providers } = parsed as Record<string, unknown>;
  if (schemaVersion !== SCHEMA_VERSION || typeof providers !== "object" || providers === null) return {};
  const observations: Record<string, UsageObservation> = {};
  for (const [provider, value] of Object.entries(providers)) {
    const observation = observationOf(value);
    if (observation !== undefined) observations[provider] = observation;
  }
  return observations;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Runs `write` while holding the lock file `lock`. */
function whileLocked(lock: string, write: () => void): void {
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number;
      try { age = Date.now() - statSync(lock).mtimeMs; } catch { continue; }
      if (age > STALE_LOCK_MS) rmSync(lock, { force: true });
      else sleep(LOCK_RETRY_MS);
    }
  }
  try { write(); } finally { rmSync(lock, { force: true }); }
}

/** Records `observation` as `provider`'s latest, unless the store already
 *  holds a later one. */
export function recordUsageObservation(path: string, provider: string, observation: UsageObservation): void {
  mkdirSync(dirname(path), { recursive: true });
  whileLocked(`${path}.lock`, () => {
    const current = readUsageObservations(path);
    const kept = current[provider];
    if (kept !== undefined && Date.parse(kept.observedAt) > Date.parse(observation.observedAt)) return;
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, providers: { ...current, [provider]: observation } }, null, 2)}\n`);
    renameSync(temporary, path);
  });
}

/** The providers whose observations still limit them at `now`, as the hard
 *  filters read them. Exhausted holds until its reset, or for the five-hour
 *  usage window of the Claude and Codex subscriptions without one. Throttled
 *  holds until its reset, or for five minutes without one: long enough to
 *  spare the next few delegations, short enough that a per-minute rate limit
 *  does not keep a provider out for long. */
export function usageLimits(observations: UsageObservations, now: Date): Record<string, ProviderUsage> {
  const at = now.getTime();
  const limits: Record<string, ProviderUsage> = {};
  for (const [provider, observation] of Object.entries(observations)) {
    if (observation.state !== "exhausted" && observation.state !== "throttled") continue;
    const window = observation.state === "exhausted" ? USAGE_OBSERVATION_WINDOW_MS : THROTTLE_DEFAULT_WINDOW_MS;
    const until = observation.resetsAt === undefined ? Date.parse(observation.observedAt) + window : Date.parse(observation.resetsAt);
    if (!(at < until)) continue;
    const learned = observation.source === "error" ? "a limit error" : "response headers";
    limits[provider] = {
      state: observation.state === "exhausted" ? "out-of-usage" : "throttled",
      detail: `${observation.state} until ${new Date(until).toISOString()}${observation.resetsAt === undefined ? " (no reset stated)" : ""}, ` +
        `from ${learned} at ${observation.observedAt}`,
    };
  }
  return limits;
}
