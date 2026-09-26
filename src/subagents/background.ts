import type { SubagentProgress, SubagentsDetails } from "./extension.ts";
import { shortTask } from "./render.ts";
import type { WorkerActivity } from "./worker.ts";

// Background calls (ADR 0008). A `background: true` subagents call returns at
// once and its items run on here. When every item has finished, the call's one
// completion notice is delivered. The tool's abort signal, which Ctrl+C fires,
// does not reach these workers: each call has signals of its own, which
// `/subagents stop` and session shutdown fire. `subagents_status` reads each
// call's snapshot here and can wait for a call; a result is delivered once, to
// a pending wait, otherwise as the completion notice.

/** The completion notice's details: the call id and the results a foreground call returns. */
export type CompletionNoticeDetails = SubagentsDetails & { readonly callId: string };

/** A background call's completion notice. Without `details` when the call itself failed. */
export interface CompletionNotice {
  readonly text: string;
  readonly details?: CompletionNoticeDetails;
}

/** A finished call's result: the text and details a foreground call returns. */
export interface BackgroundCallResult {
  readonly text: string;
  readonly details: SubagentsDetails;
}

export interface BackgroundCall {
  readonly callId: string;
  /** Each item's current state, kept up to date while the call runs. */
  readonly progress: readonly SubagentProgress[];
  /** Each item's delegation id, chosen by the caller before any fork is copied. */
  readonly delegationIds: readonly string[];
}

/** One item of a background call as `subagents_status` shows it. */
export interface WorkerSnapshot {
  readonly delegationId: string;
  readonly task: string;
  readonly agent?: string;
  readonly state: SubagentProgress["status"];
  /** The tool the worker is running, if any. */
  readonly tool?: string;
  /** The turns the worker has started. */
  readonly turns: number;
  /** How long the worker has run, or ran; absent before it starts. */
  readonly elapsedMs?: number;
  /** The last lines of the worker's latest text. */
  readonly lastLines: readonly string[];
  readonly sessionFile?: string;
}

/** A background call as `subagents_status` shows it. */
export interface CallSnapshot {
  readonly callId: string;
  readonly workers: readonly WorkerSnapshot[];
}

/** A snapshot keeps this many of a worker's last lines of text, each cut at `LAST_LINE_LENGTH` characters. */
const LAST_LINES = 5;
const LAST_LINE_LENGTH = 200;

/** A started background call, for the code that runs its items. */
export interface BackgroundCallHandle {
  /** Each item's delegation id, in item order: its worker's session id, chosen
   *  before the worker starts so the call can return it at once. */
  readonly delegationIds: readonly string[];
  /** Stops the whole call: running workers abort and queued items stay not started. */
  readonly callSignal: AbortSignal;
  /** `itemSignals[i]` stops item i alone; `callSignal` fires it too. */
  readonly itemSignals: readonly AbortSignal[];
  /** Hands over the call's result, which becomes its completion notice when it settles. */
  readonly finish: (result: Promise<BackgroundCallResult>) => void;
  /** `onActivity[i]` takes item i's worker activity, for its snapshot. */
  readonly onActivity: readonly ((activity: WorkerActivity) => void)[];
}

/** An item's worker activity and when its worker started and ended. */
interface ItemActivity {
  readonly activity: WorkerActivity;
  readonly startedAt: number;
  readonly endedAt?: number;
}

interface RunningCall {
  readonly call: BackgroundCall;
  readonly delegationIds: readonly string[];
  readonly stopCall: () => void;
  readonly stopItem: (index: number) => void;
  /** Settles once the notice is delivered, or handed to the pending waits; never rejects. */
  readonly finished: Promise<void>;
  /** `activities[i]`: item i's worker activity, once its worker started. */
  readonly activities: (ItemActivity | undefined)[];
  /** The pending `subagents_status` waits, which get the notice instead of the session. */
  readonly waiters: Set<(notice: CompletionNotice) => void>;
}

const USAGE = "Usage: /subagents [list], or /subagents stop <call id | delegation id | all>";

function unfinished(item: SubagentProgress): boolean {
  return item.status === "queued" || item.status === "running";
}

function stateText(item: SubagentProgress): string {
  if (item.status === "running" && item.tool !== undefined) return `running: ${item.tool}`;
  return item.status === "not-started" ? "not started" : item.status;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lastLines(text: string): string[] {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "").slice(-LAST_LINES);
  return lines.map((line) => line.length <= LAST_LINE_LENGTH ? line : `${line.slice(0, LAST_LINE_LENGTH - 1)}…`);
}

function workerSnapshot(delegationId: string, item: SubagentProgress, tracked: ItemActivity | undefined, now: number): WorkerSnapshot {
  const sessionFile = ("sessionFile" in item ? item.sessionFile : undefined) ?? tracked?.activity.sessionFile;
  return {
    delegationId, task: item.task, ...(item.agent === undefined ? {} : { agent: item.agent }), state: item.status,
    ...(item.status === "running" && item.tool !== undefined ? { tool: item.tool } : {}),
    turns: tracked?.activity.turns ?? 0,
    ...(tracked === undefined ? {} : { elapsedMs: (tracked.endedAt ?? now) - tracked.startedAt }),
    lastLines: lastLines(tracked?.activity.text ?? ""),
    ...(sessionFile === undefined ? {} : { sessionFile }),
  };
}

/** One orchestrator session's background calls. */
export class BackgroundCalls {
  readonly #running = new Map<string, RunningCall>();
  readonly #deliver: (notice: CompletionNotice, startTurn: boolean) => void;
  #shuttingDown = false;

  /** `deliver` gets each call's notice once. `startTurn` is false for a call
   *  that ended because the session shut down. */
  constructor(deliver: (notice: CompletionNotice, startTurn: boolean) => void) {
    this.#deliver = deliver;
  }

  /** Background workers, queued or running, in this session's calls. */
  workerCount(): number {
    let count = 0;
    for (const { call } of this.#running.values()) count += call.progress.filter(unfinished).length;
    return count;
  }

  /** Throws the reason when `items` more background workers would exceed `maxBackgroundWorkers`. */
  assertRoom(items: number, maxBackgroundWorkers: number): void {
    const running = this.workerCount();
    if (running + items <= maxBackgroundWorkers) return;
    throw new Error(`subagents refused the background call: its ${items} workers and the ${running} background workers ` +
      `already queued or running would exceed orchestrator.subagents.maxBackgroundWorkers (${maxBackgroundWorkers})`);
  }

  /** Registers `call` as running. Its notice is delivered when the result handed to `finish` settles. */
  start(call: BackgroundCall): BackgroundCallHandle {
    const { callId } = call;
    const { delegationIds } = call;
    const activities: (ItemActivity | undefined)[] = delegationIds.map(() => undefined);
    const onActivity = delegationIds.map((_, index) => (activity: WorkerActivity) => {
      const now = Date.now();
      const tracked = activities[index];
      activities[index] = { activity, startedAt: tracked?.startedAt ?? now, ...(activity.ended ? { endedAt: tracked?.endedAt ?? now } : {}) };
    });
    const waiters = new Set<(notice: CompletionNotice) => void>();
    const callController = new AbortController();
    const itemControllers = delegationIds.map(() => new AbortController());
    const itemSignals = itemControllers.map((controller) => AbortSignal.any([callController.signal, controller.signal]));
    let finish!: (result: Promise<BackgroundCallResult>) => void;
    const result = new Promise<BackgroundCallResult>((resolve) => { finish = resolve; });
    const finished = result.then(
      ({ text, details }): CompletionNotice => ({ text: `Background subagents call ${callId} finished.\n\n${text}`, details: { callId, ...details } }),
      (error: unknown): CompletionNotice => ({ text: `Background subagents call ${callId} failed: ${errorText(error)}` }),
    ).then((notice) => {
      this.#running.delete(callId);
      if (waiters.size === 0) this.#deliver(notice, !this.#shuttingDown);
      for (const waiter of waiters) waiter(notice);
    }).catch((error: unknown) => {
      process.stderr.write(`pi-orchestrator subagents: the completion notice of background call ${callId} was not delivered: ${errorText(error)}\n`);
    });
    this.#running.set(callId, {
      call, delegationIds, finished, activities, waiters,
      stopCall: () => callController.abort(),
      stopItem: (index) => itemControllers[index]?.abort(),
    });
    return { delegationIds, callSignal: callController.signal, itemSignals, finish, onActivity };
  }

  /** Snapshots of every running call; of one call, by its call id; or of one worker, by its delegation id.
   *  Throws for an id no running call has. */
  snapshots(id?: string): CallSnapshot[] {
    const now = Date.now();
    const snapshot = ({ call, delegationIds, activities }: RunningCall, indexes: readonly number[]): CallSnapshot => ({
      callId: call.callId,
      workers: indexes.map((index) => workerSnapshot(delegationIds[index]!, call.progress[index]!, activities[index], now)),
    });
    const all = (running: RunningCall) => snapshot(running, running.delegationIds.map((_, index) => index));
    if (id === undefined) return [...this.#running.values()].map(all);
    const byCall = this.#running.get(id);
    if (byCall) return [all(byCall)];
    for (const running of this.#running.values()) {
      const index = running.delegationIds.indexOf(id);
      if (index >= 0) return [snapshot(running, [index])];
    }
    throw new Error(`No running background call or worker has the id ${id}. A finished call's results are in its completion notice.`);
  }

  /** Waits until the call with the id `id` has ended, and returns its notice, which is then not delivered.
   *  Throws for any other id. `signal` stops the wait alone; the call runs on and delivers its notice if no other wait is pending. */
  wait(id: string, signal?: AbortSignal): Promise<CompletionNotice> {
    const running = this.#running.get(id);
    if (running === undefined) {
      const inCall = [...this.#running.values()].find((candidate) => candidate.delegationIds.includes(id));
      throw new Error(inCall === undefined
        ? `wait needs a background call id, and no running background call has the id ${id}. A finished call's results are in its completion notice.`
        : `wait needs a background call id; ${id} is a worker of background call ${inCall.call.callId}.`);
    }
    const { callId } = running.call;
    return new Promise((resolve, reject) => {
      const stop = () => {
        running.waiters.delete(waiter);
        reject(new Error(`Stopped waiting for background call ${callId}; its workers run on, and its completion notice follows.`));
      };
      const waiter = (notice: CompletionNotice) => {
        signal?.removeEventListener("abort", stop);
        resolve(notice);
      };
      if (signal?.aborted) return stop();
      running.waiters.add(waiter);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /** The `/subagents` command: `list` (the default) or `stop <id | all>`. Returns the text to show. */
  command(args: string): string {
    const [verb = "", ...rest] = args.trim().split(/\s+/).filter((word) => word !== "");
    if (verb === "" || (verb === "list" && rest.length === 0)) return this.listing();
    if (verb === "stop" && rest.length === 1) return rest[0] === "all" ? this.#stopAll() : this.#stop(rest[0]!);
    return USAGE;
  }

  /** Session shutdown: stops every call and waits until each has ended and its notice is delivered without starting a turn. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const calls = [...this.#running.values()];
    for (const running of calls) running.stopCall();
    await Promise.all(calls.map((running) => running.finished));
  }

  /** The `/subagents` listing of the running calls, which `subagents_status` also shows without an id. */
  listing(): string {
    if (this.#running.size === 0) return "No background subagents calls are running.";
    return [...this.#running.values()].map(({ call, delegationIds }) => {
      const done = call.progress.filter((item) => !unfinished(item)).length;
      const lines = call.progress.map((item, index) =>
        `  ${delegationIds[index]} · ${item.agent ?? "worker"} · ${stateText(item)} · ${shortTask(item.task)}`);
      return [`Background call ${call.callId}: ${done}/${call.progress.length} workers done`, ...lines].join("\n");
    }).join("\n\n");
  }

  #stop(id: string): string {
    const byCall = this.#running.get(id);
    if (byCall) {
      byCall.stopCall();
      return `Stopping background call ${id}.`;
    }
    for (const running of this.#running.values()) {
      const index = running.delegationIds.indexOf(id);
      if (index < 0) continue;
      const item = running.call.progress[index];
      if (item === undefined || !unfinished(item)) return `Worker ${id} has already finished.`;
      running.stopItem(index);
      return `Stopping worker ${id}.`;
    }
    return `No running background call or worker has the id ${id}.`;
  }

  #stopAll(): string {
    if (this.#running.size === 0) return "No background subagents calls are running.";
    const ids = [...this.#running.keys()];
    for (const running of this.#running.values()) running.stopCall();
    return `Stopping background calls ${ids.join(", ")}.`;
  }
}
