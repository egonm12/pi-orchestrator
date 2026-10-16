import type { SubagentProgress, SubagentResult, SubagentsDetails } from "./extension.ts";
import { shortTask } from "./render.ts";
import type { WorkerActivity } from "./worker.ts";

// Background calls (ADR 0008). A background subagents call, the orchestrator's
// default or `background: true` from a worker, returns at
// once and its items run on here. Each worker's result is delivered once, as
// soon as the worker finishes (ADR 0008, amended 2026-10-13): to a pending
// `subagents_status` wait on its call, otherwise as its own notice. The last
// item's notice also says the call finished, with any results not yet
// delivered. The tool's abort signal, which Ctrl+C fires, does not reach these
// workers: each call has signals of its own, which `/subagents stop` and
// session shutdown fire. `subagents_status` reads each call's snapshot here
// and can wait for a call.

/** A notice's details: the call id, the results it brings, as a foreground call returns them, and whether the call finished.
 *  `delivered` names the workers whose results earlier notices brought, on the call's last notice. */
export type CompletionNoticeDetails = SubagentsDetails & {
  readonly callId: string;
  readonly finished: boolean;
  readonly delivered?: readonly string[];
};

/** A background call's notice: one worker's result, or the call's end. Without `details` when the call itself failed. */
export interface CompletionNotice {
  readonly text: string;
  readonly details?: CompletionNoticeDetails;
}

/** A finished item's outcome: its result and its text, as a foreground call returns them. */
export interface ItemOutcome {
  readonly text: string;
  readonly result: SubagentResult;
}

export type BackgroundMessageMode = "steer" | "followUp";

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
  /** Hands over item i's outcome once it has finished; it is delivered at once, unless a wait takes it or it is the call's last. */
  readonly itemFinished: (index: number, outcome: ItemOutcome) => void;
  /** Hands over the promise that settles when every item has finished; the call's last notice follows it. */
  readonly finish: (ended: Promise<void>) => void;
  /** `onActivity[i]` takes item i's worker activity, for its snapshot. */
  readonly onActivity: readonly ((activity: WorkerActivity) => void)[];
}

/** A pending `subagents_status` wait on a call. */
interface Waiter {
  /** Hands the wait the call's last notice, with every result not yet delivered, which the session then does not get. */
  readonly deliver: (notice: CompletionNotice) => void;
  /** Ends the wait early with `reason`; the call runs on. */
  readonly interrupt: (reason: string) => void;
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
  /** Settles once the last notice is delivered, or handed to the pending waits; never rejects. */
  readonly finished: Promise<void>;
  /** `activities[i]`: item i's worker activity, once its worker started. */
  readonly activities: (ItemActivity | undefined)[];
  /** `outcomes[i]`: item i's outcome, once it finished. */
  readonly outcomes: (ItemOutcome | undefined)[];
  /** `delivered[i]`: whether item i's result reached the session as its own notice. */
  readonly delivered: boolean[];
  /** The pending `subagents_status` waits, which get the results instead of the session. */
  readonly waiters: Set<Waiter>;
}

const ANSWER_HINT = "Answer it with subagents_message, then wait again; the call runs on.";

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

/** A finished worker's own notice. */
function workerNotice(callId: string, running: Pick<RunningCall, "outcomes" | "delegationIds">, index: number): CompletionNotice {
  const { text, result } = running.outcomes[index]!;
  const done = running.outcomes.filter((outcome) => outcome !== undefined).length;
  return {
    text: `Background subagents call ${callId}: worker ${running.delegationIds[index]} finished, ${done} of ${running.outcomes.length} done.\n\n${text}`,
    details: { callId, finished: false, results: [result] },
  };
}

/** The call's last notice: the call-finished line and every result not yet delivered, in item order.
 *  `failure` is the call's own error, if it failed. */
function lastNotice(callId: string, running: Pick<RunningCall, "outcomes" | "delivered" | "delegationIds">, failure?: string): CompletionNotice {
  const delivered = running.delegationIds.filter((_, index) => running.delivered[index]);
  const rest = running.outcomes.filter((outcome, index): outcome is ItemOutcome => outcome !== undefined && !running.delivered[index]);
  const head = failure === undefined ? `Background subagents call ${callId} finished.` : `Background subagents call ${callId} failed: ${failure}`;
  const earlier = delivered.length === 0 ? "" : ` Earlier notices brought the results of ${delivered.join(", ")}.`;
  const text = [`${head}${earlier}`, ...rest.map((outcome) => outcome.text)].join("\n\n");
  if (failure !== undefined) return { text };
  return { text, details: { callId, finished: true, results: rest.map((outcome) => outcome.result), ...(delivered.length === 0 ? {} : { delivered }) } };
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
  readonly #receivers = new Map<string, (text: string, mode: BackgroundMessageMode) => Promise<void>>();
  readonly #questions = new Map<string, (text: string) => void>();
  /** Questions a delegating worker was already reminded of (remindOrAnswerQuestions). */
  readonly #reminded = new WeakSet<(text: string) => void>();
  readonly #changes = new Set<() => void>();
  readonly #deliver: (notice: CompletionNotice, startTurn: boolean) => void;
  #shuttingDown = false;

  /** `deliver` gets each notice once. `startTurn` is false once the session shuts down. */
  constructor(deliver: (notice: CompletionNotice, startTurn: boolean) => void) {
    this.#deliver = deliver;
  }

  /** Registers `call` as running. Each item's notice is delivered as `itemFinished` hands it over,
   *  and the last notice when the promise handed to `finish` settles. */
  start(call: BackgroundCall): BackgroundCallHandle {
    const { callId } = call;
    const { delegationIds } = call;
    const activities: (ItemActivity | undefined)[] = delegationIds.map(() => undefined);
    const onActivity = delegationIds.map((_, index) => (activity: WorkerActivity) => {
      const now = Date.now();
      const tracked = activities[index];
      activities[index] = { activity, startedAt: tracked?.startedAt ?? now, ...(activity.ended ? { endedAt: tracked?.endedAt ?? now } : {}) };
    });
    const waiters = new Set<Waiter>();
    const outcomes: (ItemOutcome | undefined)[] = delegationIds.map(() => undefined);
    const delivered = delegationIds.map(() => false);
    const callController = new AbortController();
    const itemControllers = delegationIds.map(() => new AbortController());
    const itemSignals = itemControllers.map((controller) => AbortSignal.any([callController.signal, controller.signal]));
    let finish!: (ended: Promise<void>) => void;
    const ended = new Promise<void>((resolve) => { finish = resolve; });
    const parts = { outcomes, delivered, delegationIds };
    const finished = ended.then(
      (): CompletionNotice => lastNotice(callId, parts),
      (error: unknown): CompletionNotice => lastNotice(callId, parts, errorText(error)),
    ).then((notice) => {
      this.#running.delete(callId);
      for (const id of delegationIds) {
        this.#receivers.delete(id);
        this.#questions.delete(id);
      }
      if (waiters.size === 0) this.#deliver(notice, !this.#shuttingDown);
      for (const waiter of waiters) waiter.deliver(notice);
      this.#changed();
    }).catch((error: unknown) => {
      this.#changed();
      process.stderr.write(`pi-orchestrator subagents: the last notice of background call ${callId} was not delivered: ${errorText(error)}\n`);
    });
    const running: RunningCall = {
      call, delegationIds, finished, activities, outcomes, delivered, waiters,
      stopCall: () => callController.abort(),
      stopItem: (index) => itemControllers[index]?.abort(),
    };
    this.#running.set(callId, running);
    const itemFinished = (index: number, outcome: ItemOutcome) => {
      if (outcomes[index] !== undefined || this.#running.get(callId) !== running) return;
      outcomes[index] = outcome;
      this.#deliverFinished(running);
    };
    return { delegationIds, callSignal: callController.signal, itemSignals, itemFinished, finish, onActivity };
  }

  /** Delivers each finished, undelivered item's result as its own notice, unless a wait is pending, which takes them
   *  when the call ends, or every item has finished, when the call's last notice brings them. */
  #deliverFinished(running: RunningCall): void {
    const { outcomes, delivered, waiters, call } = running;
    if (waiters.size > 0 || outcomes.every((outcome) => outcome !== undefined)) return;
    for (const [index, outcome] of outcomes.entries()) {
      if (outcome === undefined || delivered[index]) continue;
      delivered[index] = true;
      this.#deliver(workerNotice(call.callId, running, index), !this.#shuttingDown);
    }
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
    throw new Error(`No running background call or worker has the id ${id}. A finished call's results are in its notices.`);
  }

  /** Waits until the call with the id `id` has ended, and returns its last notice, with every result not yet
   *  delivered, which the session then does not get. Results finished while the wait is pending go to it.
   *  Throws for any other id. `signal` stops the wait alone; the call runs on, and its results finished
   *  meanwhile are delivered as notices if no other wait is pending. */
  wait(id: string, signal?: AbortSignal): Promise<CompletionNotice> {
    const running = this.#running.get(id);
    if (running === undefined) {
      const inCall = this.#callWith(id);
      throw new Error(inCall === undefined
        ? `wait needs a background call id, and no running background call has the id ${id}. A finished call's results are in its notices.`
        : `wait needs a background call id; ${id} is a worker of background call ${inCall.call.callId}.`);
    }
    const { callId } = running.call;
    // A wait would hold the orchestrator's turn, so the question could never reach it.
    const asking = running.delegationIds.find((delegationId) => this.#questions.has(delegationId));
    if (asking !== undefined) throw new Error(`wait refused: worker ${asking} of background call ${callId} is waiting for an answer to its question. ${ANSWER_HINT}`);
    return new Promise((resolve, reject) => {
      const interrupt = (reason: string) => {
        signal?.removeEventListener("abort", stop);
        running.waiters.delete(waiter);
        reject(new Error(reason));
        // The results that finished while the wait was pending are delivered now, unless another wait takes them.
        if (this.#running.get(callId) === running) this.#deliverFinished(running);
      };
      const stop = () => interrupt(`Stopped waiting for background call ${callId}; its workers run on, and their notices follow.`);
      const waiter: Waiter = {
        deliver: (notice) => {
          signal?.removeEventListener("abort", stop);
          resolve(notice);
        },
        interrupt,
      };
      if (signal?.aborted) return stop();
      running.waiters.add(waiter);
      signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /** A worker's active session accepts messages only while its background item is running. */
  registerWorker(id: string, receive: (text: string, mode: BackgroundMessageMode) => Promise<void>): () => void {
    this.#receivers.set(id, receive);
    return () => { if (this.#receivers.get(id) === receive) this.#receivers.delete(id); };
  }

  /** A running background worker's blocking report question. Resolves with the
   *  next subagents_message to the worker, which would otherwise be queued in pi
   *  and deadlock until the report tool returned. Ends the pending waits on the
   *  worker's call, which would hold the orchestrator's turn. Rejects when
   *  `signal` fires: an abort or a `/subagents stop`. */
  question(id: string, signal: AbortSignal | undefined): Promise<string> {
    const running = this.#callWith(id);
    if (running === undefined) return Promise.reject(new Error(`no running background worker has the delegation id ${id}`));
    if (this.#questions.has(id)) return Promise.reject(new Error("ask one question at a time: an earlier question is still waiting for its answer"));
    return new Promise((resolve, reject) => {
      const stop = () => {
        if (this.#questions.get(id) === answer) this.#questions.delete(id);
        reject(new Error("The question was not answered: the worker was stopped."));
      };
      const answer = (text: string) => {
        signal?.removeEventListener("abort", stop);
        resolve(text);
      };
      if (signal?.aborted) return stop();
      this.#questions.set(id, answer);
      this.#changed();
      signal?.addEventListener("abort", stop, { once: true });
      for (const waiter of running.waiters) {
        waiter.interrupt(`Stopped waiting for background call ${running.call.callId}: its worker ${id} asked a question, which follows. ${ANSWER_HINT}`);
      }
    });
  }

  /** Whether `message` would reach the worker `id`: an active background worker, not a call, queued item, or foreground worker. */
  accepts(id: string): boolean {
    const running = this.#callWith(id);
    const index = running?.delegationIds.indexOf(id) ?? -1;
    return running !== undefined && index >= 0 && running.call.progress[index]?.status === "running" && this.#receivers.has(id);
  }

  /** Whether the worker `id` waits on the answer to its question, which its next message is. */
  asking(id: string): boolean {
    return this.#questions.has(id);
  }

  /** Send to one active background worker, not to a call, queued item, or foreground worker. */
  async message(id: string, text: string, mode: BackgroundMessageMode): Promise<void> {
    const receive = this.#receivers.get(id);
    if (!this.accepts(id) || !receive) {
      throw new Error(`subagents_message: no running background worker has the delegation id ${id}`);
    }
    const answer = this.#questions.get(id);
    if (answer) {
      this.#questions.delete(id);
      answer(text);
    } else {
      await receive(text, mode);
    }
  }

  /** The `/subagents` command: `list` (the default) or `stop <id | all>`. Returns the text to show. */
  command(args: string): string {
    const [verb = "", ...rest] = args.trim().split(/\s+/).filter((word) => word !== "");
    if (verb === "" || (verb === "list" && rest.length === 0)) return this.listing();
    if (verb === "stop" && rest.length === 1) return rest[0] === "all" ? this.#stopAll() : this.#stop(rest[0]!);
    return USAGE;
  }

  /** The questions still waiting for an answer when a delegating worker would
   *  end its run. Each question is returned once, so the worker can be reminded
   *  of it; one still unanswered at the next call is answered with `fallback`,
   *  so its worker goes on and its result is not lost. */
  remindOrAnswerQuestions(fallback: string): string[] {
    const remind: string[] = [];
    for (const [id, answer] of [...this.#questions]) {
      if (this.#reminded.has(answer)) {
        this.#questions.delete(id);
        answer(fallback);
      } else {
        this.#reminded.add(answer);
        remind.push(id);
      }
    }
    return remind;
  }

  /** Wait until all child calls settle, or a child asks a question that the
   *  parent must answer in another turn. Completion notices are delivered before
   *  this returns. `signal` stops every call, as session shutdown does. */
  async whenIdleOrQuestion(signal?: AbortSignal): Promise<void> {
    const stop = () => { void this.shutdown(); this.#changed(); };
    signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    try {
      while (this.#running.size > 0 && this.#questions.size === 0) {
        await new Promise<void>((resolve) => { this.#changes.add(resolve); });
      }
    } finally { signal?.removeEventListener("abort", stop); }
  }

  #changed(): void {
    for (const notify of this.#changes) notify();
    this.#changes.clear();
  }

  /** Session shutdown: stops every call and waits until each has ended and its notice is delivered without starting a turn. */
  async shutdown(): Promise<void> {
    this.#shuttingDown = true;
    const calls = [...this.#running.values()];
    for (const running of calls) running.stopCall();
    await Promise.all(calls.map((running) => running.finished));
  }

  /** The `/subagents` listing of the running calls, which `subagents_status` also shows without an id. */
  listing(row?: (delegationId: string) => string | undefined): string {
    if (this.#running.size === 0) return "No background subagents calls are running.";
    return [...this.#running.values()].map(({ call, delegationIds }) => {
      const done = call.progress.filter((item) => !unfinished(item)).length;
      const lines = call.progress.map((item, index) =>
        `  ${delegationIds[index]} · ${row?.(delegationIds[index]!) ?? `${item.agent ?? "worker"} · ${stateText(item)} · ${shortTask(item.task)}`}`);
      return [`Background call ${call.callId}: ${done}/${call.progress.length} workers done`, ...lines].join("\n");
    }).join("\n\n");
  }

  /** The running call with the worker `delegationId`, if any. */
  #callWith(delegationId: string): RunningCall | undefined {
    return [...this.#running.values()].find(({ delegationIds }) => delegationIds.includes(delegationId));
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
