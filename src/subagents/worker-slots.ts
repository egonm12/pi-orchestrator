// The worker limit (CONTEXT.md): at most this many workers run at once.
// Each worker takes a slot before it starts and gives it back when it ends;
// a worker without a free slot waits, first come first served, and is never
// refused. The orchestrator and its nested workers share one set. A worker
// gives up its slot while waiting on children and queues to regain it before
// resuming, so even a limit of one cannot deadlock a parent and child.

/** A slot's release; calling it more than once releases once. */
export type ReleaseSlot = () => void;

const SHARED_SLOTS = Symbol.for("pi-orchestrator.subagents.worker-slots");
const SLOT_LEASES = Symbol.for("pi-orchestrator.subagents.worker-slot-leases");
type Lease = { slots: WorkerSlots; release?: ReleaseSlot; pauses: number; disposed: boolean; resumed?: Promise<void>; resume?: () => void };
type ProcessGlobal = typeof globalThis & {
  [SHARED_SLOTS]?: Map<string, WorkerSlots>;
  [SLOT_LEASES]?: Map<string, Lease>;
};
const sharedSlots = () => (globalThis as ProcessGlobal)[SHARED_SLOTS] ??= new Map<string, WorkerSlots>();
const leases = () => (globalThis as ProcessGlobal)[SLOT_LEASES] ??= new Map<string, Lease>();

/** One worker limit for the orchestrator and all workers it started. */
export function workerSlotsFor(rootSessionId: string, limit: number, update = true): WorkerSlots {
  const slots = sharedSlots().get(rootSessionId) ?? new WorkerSlots(limit);
  sharedSlots().set(rootSessionId, slots);
  if (update) slots.setLimit(limit);
  return slots;
}

export function forgetWorkerSlots(rootSessionId: string): void {
  sharedSlots().delete(rootSessionId);
}

/** Associate a running worker's held slot with its session until the worker
 *  ends. The returned disposer gives back whatever slot the lease holds then. */
export function registerWorkerSlot(sessionId: string, slots: WorkerSlots, release: ReleaseSlot): () => void {
  const lease: Lease = { slots, release, pauses: 0, disposed: false };
  leases().set(sessionId, lease);
  return () => {
    lease.disposed = true;
    lease.release?.();
    lease.release = undefined;
    lease.resume?.();
    if (leases().get(sessionId) === lease) leases().delete(sessionId);
  };
}

/** Whether the worker of `sessionId` has given up its slot for a wait. */
export function workerSlotPaused(sessionId: string): boolean {
  return (leases().get(sessionId)?.pauses ?? 0) > 0;
}

/** Run a wait without occupying the calling worker's slot. The worker joins
 *  the same FIFO queue as its children before it resumes. Overlapping waits of
 *  one worker, such as a subagents call and a report question run in parallel,
 *  give the slot up once and take it back once, when the last of them ends. A
 *  lease disposed meanwhile takes no slot back. */
export async function withoutWorkerSlot<T>(sessionId: string, signal: AbortSignal | undefined, work: () => Promise<T>): Promise<T> {
  const lease = leases().get(sessionId);
  if (lease === undefined) return work();
  if (lease.pauses++ === 0) {
    lease.release?.();
    lease.release = undefined;
    lease.resumed = new Promise<void>((resolve) => { lease.resume = resolve; });
  }
  try { return await work(); }
  finally {
    if (--lease.pauses === 0) {
      const resume = lease.resume;
      const release = lease.disposed ? undefined : await lease.slots.acquire(signal);
      // A wait that started while this one queued holds no slot: it takes one back when it ends.
      if (lease.disposed || lease.pauses > 0) release?.();
      else lease.release = release;
      resume?.();
      if (lease.resume === resume) {
        lease.resume = undefined;
        lease.resumed = undefined;
      }
    } else await lease.resumed;
  }
}

export class WorkerSlots {
  #limit: number;
  #running = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Workers holding a slot. */
  get running(): number {
    return this.#running;
  }

  /** Workers waiting for a slot. */
  get queued(): number {
    return this.#waiting.length;
  }

  /** A changed limit holds from now on: a higher one starts waiting workers, a lower one lets running workers finish. */
  setLimit(limit: number): void {
    this.#limit = limit;
    this.#grant();
  }

  /** Waits for a slot. Resolves `undefined`, holding none, when `signal` aborts first. */
  acquire(signal?: AbortSignal): Promise<ReleaseSlot | undefined> {
    if (signal?.aborted) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = () => {
        const index = this.#waiting.indexOf(grant);
        if (index >= 0) this.#waiting.splice(index, 1);
        resolve(undefined);
      };
      const grant = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve(this.#release());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#waiting.push(grant);
      this.#grant();
    });
  }

  #grant(): void {
    while (this.#running < this.#limit && this.#waiting.length > 0) {
      this.#running++;
      this.#waiting.shift()!();
    }
  }

  #release(): ReleaseSlot {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#running--;
      this.#grant();
    };
  }
}
