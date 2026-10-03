import { closeSync, fstatSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
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
// file. A waiting writer does not block the event loop.
//
// The lock names its writer's pid and a token of its own, and a writer
// removes only the lock with its own token. A lock whose writer no longer
// runs is broken at once; one older than any write takes (a hung writer, or a
// pid another process now has) is broken too. Of the waiters that find the
// same lock abandoned, only the one that claims it first breaks it, and only
// while it is still that lock (breakAbandoned). While holding the lock, a
// writer removes the temporary files and claims that writers which died or
// hung left behind. Known limit: a writer that hangs past STALE_LOCK_MS and
// then resumes can overwrite the write of the writer that broke its lock.
//
// A write that fails still counts in this process: its observation is kept in
// memory, read with the file and saved with the next write that succeeds.

const USAGE_OBSERVATIONS_FILE = "usage-observations.json";
const SCHEMA_VERSION = "usage-observations/1";
/** A lock this old is broken even when its writer still runs: no write takes
 *  this long, so its writer hangs or its pid now belongs to another process. */
const STALE_LOCK_MS = 10_000;
const LOCK_RETRY_MS = 5;

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

/** Observations this process could not save yet, per store path. The router
 *  extension copies of one process share them through the process's global
 *  object, like the routing-choice queue. */
const UNSAVED = Symbol.for("pi-orchestrator.router.unsaved-usage-observations");
type ProcessGlobal = typeof globalThis & { [UNSAVED]?: Map<string, Record<string, UsageObservation>> };

function unsaved(): Map<string, Record<string, UsageObservation>> {
  return (globalThis as ProcessGlobal)[UNSAVED] ??= new Map();
}

const laterThan = (a: UsageObservation, b: UsageObservation) => Date.parse(a.observedAt) > Date.parse(b.observedAt);

/** Whether the exhausted or throttled observation `limit` outranks `other`,
 *  which is no limit: the limit still holds at `now`, and `other` was observed
 *  before it lifts. A success response's headers say nothing about a usage
 *  limit an error reported (quota-headers.ts), so while the limit holds they
 *  never end it, whether they were observed before or after it, and in
 *  whichever order two sessions commit them. Once it lifts they do. */
function limitOutranks(limit: UsageObservation, other: UsageObservation, now: Date): boolean {
  const lifts = limitLiftsAt(limit);
  return lifts !== undefined && limitLiftsAt(other) === undefined && now.getTime() < lifts && Date.parse(other.observedAt) < lifts;
}

/** Whether `observation` may take `kept`'s place at `now`. A limit that holds
 *  outranks a non-limit observed before it lifts (limitOutranks); otherwise
 *  the later observation wins, and at the same time the new one. */
export function replaces(observation: UsageObservation, kept: UsageObservation | undefined, now: Date): boolean {
  if (kept === undefined) return true;
  if (limitOutranks(kept, observation, now)) return false;
  if (limitOutranks(observation, kept, now)) return true;
  return !laterThan(kept, observation);
}

/** `base` with each of `extra`'s observations that replaces `base`'s at `now`. */
function withLatest(base: UsageObservations, extra: UsageObservations, now: Date): Record<string, UsageObservation> {
  const merged: Record<string, UsageObservation> = { ...base };
  for (const [provider, observation] of Object.entries(extra)) {
    if (replaces(observation, merged[provider], now)) merged[provider] = observation;
  }
  return merged;
}

/** Every valid observation in the store at `path`, with the ones this process
 *  could not save there, the one per provider that wins at `now` (replaces).
 *  A missing or unreadable file, or an entry that is not an observation, adds
 *  nothing: the store is advice, and the next limit error writes it again. */
export function readUsageObservations(path: string, now: Date = new Date()): UsageObservations {
  return withLatest(savedObservations(path), unsaved().get(path) ?? {}, now);
}

function savedObservations(path: string): UsageObservations {
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

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException).code;

/** Whether a process with `pid` runs. EPERM: it runs as another user. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return errorCode(error) === "EPERM"; }
}

/** A lock file's content: its writer's pid and a token of its own. */
const LOCK_CONTENT = /^(\d+) [0-9a-f-]{36}\n$/;

/** A lock file as a waiter found it: its content, inode and modification
 *  time, read through one open file so they belong to the same lock. */
interface SeenLock { readonly content: string; readonly ino: number; readonly mtimeMs: number }

function seenLock(lock: string): SeenLock | undefined {
  let fd: number;
  try { fd = openSync(lock, "r"); } catch { return undefined; }
  try {
    const { ino, mtimeMs } = fstatSync(fd);
    return { content: readFileSync(fd, "utf8"), ino, mtimeMs };
  } catch { return undefined; } finally { closeSync(fd); }
}

/** Whether `lock` was left behind: its writer died, or it is older than any
 *  write takes. */
function abandoned(lock: SeenLock): boolean {
  const pid = LOCK_CONTENT.exec(lock.content)?.[1];
  return Date.now() - lock.mtimeMs > STALE_LOCK_MS || (pid !== undefined && !running(Number(pid)));
}

/** The temporary file a writer with this process's pid writes next to the store at `path`. */
function temporaryPath(path: string): string {
  return `${path}.${process.pid}.${randomUUID()}.tmp`;
}

const TEMPORARY_NAME = /^(\d+)\.[0-9a-f-]{36}\.tmp$/;
const CLAIM_NAME = /^lock\.[0-9a-f]{16}\.break$/;

/** Removes what writers that died or hung left next to the store at `path`:
 *  temporary files of a writer that no longer runs or is older than any write
 *  takes, and claims on abandoned locks. Run while holding the lock, when no
 *  running writer is between writing and renaming its file. A waiter's young
 *  file of a lock it is taking is kept; a claim a waiter is still checking
 *  only makes that waiter try again. */
function removeLeftovers(path: string): void {
  const dir = dirname(path);
  const prefix = `${basename(path)}.`;
  let names: string[];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const rest = name.slice(prefix.length);
    const file = join(dir, name);
    if (CLAIM_NAME.test(rest)) { rmSync(file, { force: true }); continue; }
    const pid = TEMPORARY_NAME.exec(rest)?.[1];
    if (pid === undefined) continue;
    let ageMs: number;
    try { ageMs = Date.now() - statSync(file).mtimeMs; } catch { continue; }
    if (ageMs > STALE_LOCK_MS || !running(Number(pid))) rmSync(file, { force: true });
  }
}

/** Takes the lock file `lock` once, if nobody holds it. The lock appears with
 *  its content in one step: a finished temporary file is linked to its name. */
function tryLock(path: string, lock: string, content: string): boolean {
  const temporary = temporaryPath(path);
  writeFileSync(temporary, content);
  try {
    linkSync(temporary, lock);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally { rmSync(temporary, { force: true }); }
}

/** Removes the abandoned lock `lock` as `seen`, and says whether it did.
 *  Of the waiters that found the same lock abandoned, the one that first links
 *  a claim to it breaks it: the claim is named after that one lock, so no
 *  second waiter can link it. The claim keeps the lock's inode alive, so a
 *  claim that does not show the lock as seen was linked to a lock another
 *  writer took since; it is dropped and that lock left alone. A claim whose
 *  waiter died is dropped once older than any write takes. */
function breakAbandoned(lock: string, seen: SeenLock): boolean {
  const id = createHash("sha256").update(`${seen.ino}:${seen.mtimeMs}:${seen.content}`).digest("hex").slice(0, 16);
  const claim = `${lock}.${id}.break`;
  try { linkSync(lock, claim); } catch (error) {
    if (errorCode(error) === "ENOENT") return true;
    if (errorCode(error) !== "EEXIST") throw error;
    // Linking changes the inode's change time, so ctime is when it was claimed.
    try { if (Date.now() - statSync(claim).ctimeMs > STALE_LOCK_MS) rmSync(claim, { force: true }); } catch { /* dropped already */ }
    return false;
  }
  try {
    const claimed = statSync(claim);
    if (claimed.ino !== seen.ino || claimed.mtimeMs !== seen.mtimeMs || readFileSync(claim, "utf8") !== seen.content) return false;
    rmSync(lock, { force: true });
    return true;
  } catch { return false; } finally { rmSync(claim, { force: true }); }
}

/** Runs `write` while holding the lock file next to the store at `path`.
 *  Waiting for another writer's lock does not block the event loop. A lock
 *  that is neither released nor broken in time, such as one this process
 *  cannot read, fails the write. */
async function whileLocked(path: string, write: () => void): Promise<void> {
  const lock = `${path}.lock`;
  const content = `${process.pid} ${randomUUID()}\n`;
  const giveUpAt = Date.now() + 2 * STALE_LOCK_MS;
  while (!tryLock(path, lock, content)) {
    const seen = seenLock(lock);
    if (seen !== undefined && abandoned(seen) && breakAbandoned(lock, seen)) continue;
    if (Date.now() > giveUpAt) throw new Error(`${lock} was not released within ${(2 * STALE_LOCK_MS) / 1000} s`);
    await delay(LOCK_RETRY_MS);
  }
  try { write(); } finally {
    // Only this writer's own lock, never one another writer took after
    // breaking this one as abandoned.
    if (seenLock(lock)?.content === content) rmSync(lock, { force: true });
  }
}

/** Records `observation` as `provider`'s latest, unless the store holds one
 *  that wins over it at `now` (replaces): a later one, or a limit that still
 *  holds and that it, being no limit observed before the lift, would end. A
 *  limit likewise replaces a later non-limit, so the order in which sessions
 *  commit does not matter. Rejects when the store cannot be written. This
 *  process reads the observation all the same (readUsageObservations), and
 *  saves it with its next write that succeeds; until then other processes
 *  don't see it. */
export async function recordUsageObservation(path: string, provider: string, observation: UsageObservation, now: Date = new Date()): Promise<void> {
  const pending = withLatest(unsaved().get(path) ?? {}, { [provider]: observation }, now);
  unsaved().set(path, pending);
  mkdirSync(dirname(path), { recursive: true });
  await whileLocked(path, () => {
    removeLeftovers(path);
    const saved = savedObservations(path);
    const merged = withLatest(saved, unsaved().get(path) ?? {}, now);
    if (Object.keys(merged).some((name) => merged[name] !== saved[name])) {
      const temporary = temporaryPath(path);
      writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, providers: merged }, null, 2)}\n`);
      renameSync(temporary, path);
    }
    unsaved().delete(path);
  });
}

/** When an exhausted or throttled observation stops limiting its provider, in
 *  epoch milliseconds; undefined for any other state. Exhausted holds until its
 *  reset, or for the five-hour usage window of the Claude and Codex
 *  subscriptions without one. Throttled holds until its reset, or for five
 *  minutes without one: long enough to spare the next few delegations, short
 *  enough that a per-minute rate limit does not keep a provider out for long. */
export function limitLiftsAt(observation: UsageObservation): number | undefined {
  if (observation.state !== "exhausted" && observation.state !== "throttled") return undefined;
  const window = observation.state === "exhausted" ? USAGE_OBSERVATION_WINDOW_MS : THROTTLE_DEFAULT_WINDOW_MS;
  return observation.resetsAt === undefined ? Date.parse(observation.observedAt) + window : Date.parse(observation.resetsAt);
}

/** The providers whose observations still limit them at `now`, as the hard
 *  filters read them, each until limitLiftsAt. */
export function usageLimits(observations: UsageObservations, now: Date): Record<string, ProviderUsage> {
  const at = now.getTime();
  const limits: Record<string, ProviderUsage> = {};
  for (const [provider, observation] of Object.entries(observations)) {
    const until = limitLiftsAt(observation);
    if (until === undefined || !(at < until)) continue;
    const learned = observation.source === "error" ? "a limit error" : "response headers";
    limits[provider] = {
      state: observation.state === "exhausted" ? "out-of-usage" : "throttled",
      detail: `${observation.state} until ${new Date(until).toISOString()}${observation.resetsAt === undefined ? " (no reset stated)" : ""}, ` +
        `from ${learned} at ${observation.observedAt}`,
    };
  }
  return limits;
}

/** Below this percentage left a provider is low on usage (PRD cml8, story 51). */
export const LOW_USAGE_PERCENT = 10;

/** The providers whose observations hold under LOW_USAGE_PERCENT left at
 *  `now`, for balancing to weigh. An exhausted or throttled observation is
 *  the hard filters' (usageLimits), not this. A percentage holds until the
 *  earlier of its window reset and five hours after it was observed. */
export function lowOnUsage(observations: UsageObservations, now: Date): string[] {
  const at = now.getTime();
  return Object.keys(observations).sort().filter((provider) => {
    const observation = observations[provider]!;
    if (limitLiftsAt(observation) !== undefined || observation.percentLeft === undefined || !(observation.percentLeft < LOW_USAGE_PERCENT)) return false;
    return at < percentHoldsUntil(observation);
  });
}

/** When a percentage-left observation stops saying anything: the earlier of
 *  its window reset and five hours after it was observed. The age limit keeps
 *  a cached reading from surviving an early or otherwise unobserved reset. */
export function percentHoldsUntil(observation: UsageObservation): number {
  const freshUntil = Date.parse(observation.observedAt) + USAGE_OBSERVATION_WINDOW_MS;
  const resetAt = observation.resetsAt === undefined ? freshUntil : Date.parse(observation.resetsAt);
  return Math.min(resetAt, freshUntil);
}
