import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

interface Reservation {
  readonly delegationId: string;
  readonly provider: string;
  readonly pid: number;
  readonly at: string;
}

const WINDOW_MS = 5 * 60 * 60 * 1000;
const folder = (recordDir: string) => `${recordDir}.choice-reservations`;
const file = (recordDir: string, id: string) => join(folder(recordDir), `${createHash("sha256").update(id).digest("hex")}.json`);

/** Called under the shared choice queue. A pending request participates in
 * next worker's balancing choice, even before its first provider event arrives. */
export function reserveRoutingChoice(recordDir: string, delegationId: string, provider: string, at: Date): void {
  const dir = folder(recordDir);
  mkdirSync(dir, { recursive: true });
  const target = file(recordDir, delegationId);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify({ delegationId, provider, pid: process.pid, at: at.toISOString() } satisfies Reservation));
    renameSync(temporary, target);
  } finally { rmSync(temporary, { force: true }); }
}

/** Called under the same queue when the request emits or fails to start. */
export function releaseRoutingChoice(recordDir: string, delegationId: string): void {
  rmSync(file(recordDir, delegationId), { force: true });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Read-only: the provider of each choice in flight, by delegation id. A dead
 * process or a reservation outside the rolling window cannot steer new
 * delegations. A delegation with a committed decision can still have one: a
 * failover's new choice, pending until its request's first event. */
export function pendingRoutingChoices(recordDir: string, at: Date): ReadonlyMap<string, string> {
  let names: string[];
  try { names = readdirSync(folder(recordDir)).filter((name) => name.endsWith(".json")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const pending = new Map<string, string>();
  for (const name of names) {
    try {
      const entry: unknown = JSON.parse(readFileSync(join(folder(recordDir), name), "utf8"));
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
      const candidate = entry as Reservation;
      const timestamp = Date.parse(candidate.at);
      if (typeof candidate.delegationId !== "string" || typeof candidate.provider !== "string" || !Number.isInteger(candidate.pid) ||
        !Number.isFinite(timestamp) || timestamp < at.getTime() - WINDOW_MS || timestamp > at.getTime() ||
        !alive(candidate.pid)) continue;
      pending.set(candidate.delegationId, candidate.provider);
    } catch (error) {
      // A torn or older-format reservation is not evidence that a provider
      // started work. Skip it as the decision-record reader skips bad lines;
      // it must not disable routing for every later worker.
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return pending;
}
