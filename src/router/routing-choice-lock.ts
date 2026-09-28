/** The orchestrator's workers run in one process, but each loads its own
 * router extension instance. A process-wide queue makes their choices atomic
 * with respect to one another, including the decision append or pending
 * reservation that the next worker counts. Different processes still share
 * completed decisions and reservations through the owner's state folder.
 * Simultaneous choices in separate processes are not guaranteed to spread. */
const CHOICES = Symbol.for("pi-orchestrator.router.choice-queues");
type ProcessGlobal = typeof globalThis & { [CHOICES]?: Map<string, Promise<void>> };

function queues(): Map<string, Promise<void>> {
  return (globalThis as ProcessGlobal)[CHOICES] ??= new Map();
}

/** Serialize routing choices by state folder across extension copies in one
 * process. Classification normally runs before the queue; an invalidated
 * restored decision can require reclassification inside it. The first worker
 * model event is always awaited only after the queue is released. */
export async function withRoutingChoice<T>(recordDir: string, choose: () => Promise<T>): Promise<T> {
  const all = queues();
  const previous = all.get(recordDir) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  all.set(recordDir, tail);
  await previous;
  try { return await choose(); }
  finally {
    release();
    if (all.get(recordDir) === tail) all.delete(recordDir);
  }
}
