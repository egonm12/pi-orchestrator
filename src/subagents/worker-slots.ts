// The worker limit (CONTEXT.md): at most this many workers run at once.
// Each worker takes a slot before it starts and gives it back when it ends;
// a worker without a free slot waits, first come first served, and is never
// refused. The orchestrator's session has one set of slots for its foreground
// and background calls; a worker's own call has slots of its own
// (extension.ts), so a worker holding a slot never waits on itself.

/** A slot's release; calling it more than once releases once. */
export type ReleaseSlot = () => void;

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
