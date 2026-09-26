import { randomUUID } from "node:crypto";
import type { SubagentProgress, SubagentsDetails } from "./extension.ts";
import { shortTask } from "./render.ts";

// Background calls (ADR 0008). A `background: true` subagents call returns at
// once and its items run on here. When every item has finished, the call's one
// completion notice is delivered. The tool's abort signal, which Ctrl+C fires,
// does not reach these workers: each call has signals of its own, which
// `/subagents stop` and session shutdown fire.

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
}

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
}

interface RunningCall {
  readonly call: BackgroundCall;
  readonly delegationIds: readonly string[];
  readonly stopCall: () => void;
  readonly stopItem: (index: number) => void;
  /** Settles once the notice is delivered; never rejects. */
  readonly finished: Promise<void>;
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
    const delegationIds = call.progress.map(() => randomUUID());
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
      this.#deliver(notice, !this.#shuttingDown);
    }).catch((error: unknown) => {
      process.stderr.write(`pi-orchestrator subagents: the completion notice of background call ${callId} was not delivered: ${errorText(error)}\n`);
    });
    this.#running.set(callId, {
      call, delegationIds, finished,
      stopCall: () => callController.abort(),
      stopItem: (index) => itemControllers[index]?.abort(),
    });
    return { delegationIds, callSignal: callController.signal, itemSignals, finish };
  }

  /** The `/subagents` command: `list` (the default) or `stop <id | all>`. Returns the text to show. */
  command(args: string): string {
    const [verb = "", ...rest] = args.trim().split(/\s+/).filter((word) => word !== "");
    if (verb === "" || (verb === "list" && rest.length === 0)) return this.#list();
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

  #list(): string {
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
