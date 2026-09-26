import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { watchServedRungs, type RungEscalation, type ServedRung } from "../router/served-rungs.ts";

// The worker board: one in-process record of every worker of the
// orchestrator session, foreground, background and nested, for the live
// worker view (epic a338). The subagents extension feeds it; it reads each
// worker's own session events for turns, tokens, cost and activity, and the
// router's served rungs (src/router/served-rungs.ts) for a routed worker's
// model. Views read it and get a change signal. It only observes: nothing
// here steers a worker.

/** CONTEXT.md, Worker state. Only a background worker can be asking. */
export type WorkerState = "queued" | "running" | "asking" | "completed" | "failed" | "aborted";
export type WorkerEndState = Extract<WorkerState, "completed" | "failed" | "aborted">;

/** A worker's model as the subagents extension knows it when the worker is queued or starts. */
export type WorkerModelSetup =
  /** On the auto model: the router picks the rung at its first request. A
   *  resumed worker keeps its original pin, so its rung is known already. */
  | { readonly kind: "routed"; readonly pin?: { readonly model: string; readonly effort: string } }
  /** A forked worker on the orchestrator's session model and effort (ADR 0008). */
  | { readonly kind: "fork"; readonly model: string; readonly effort: string }
  /** A preserved agent definition model (ADR 0007). Without an effort pi's
   *  default applies, which the board learns from the worker's session. */
  | { readonly kind: "preserved"; readonly model: string; readonly effort?: string };

/** What the subagents extension knows of a worker when its item is queued. */
export interface NewWorker {
  /** The subagents call that delegated it. */
  readonly callId: string;
  readonly background: boolean;
  readonly task: string;
  readonly agent?: string;
  /** Known before the worker starts for a background item and a resume item. */
  readonly delegationId?: string;
  /** The delegation of the worker that made this delegation (ADR 0008). */
  readonly parentDelegationId?: string;
  readonly model: WorkerModelSetup;
}

/** A rung that served a routed worker's requests, from `since` on. */
export interface RungServing {
  /** `provider/model`. */
  readonly model: string;
  readonly effort: string;
  /** Epoch milliseconds of the first request it served. */
  readonly since: number;
  /** Present when the rung came from an escalated routing decision. */
  readonly escalation?: RungEscalation;
}

/** A worker's model on the board. */
export type WorkerModel =
  /** A routed worker before its first request. */
  | { readonly kind: "routing" }
  /** A routed worker: each rung that served its requests, in order, the one
   *  serving its latest request last. A worker keeps its pin (ADR 0006), so
   *  there is normally one. */
  | { readonly kind: "routed"; readonly rungs: readonly RungServing[] }
  | Exclude<WorkerModelSetup, { readonly kind: "routed" }>;

/** A started worker's live pi session, as runWorker hands it over. */
export interface WorkerSession {
  /** The delegation id. */
  readonly sessionId: string;
  /** `undefined` when the session is not saved. */
  readonly sessionFile: string | undefined;
  /** The session's thinking level. A routed worker's rung sets its own effort (ADR 0006). */
  readonly effort: string;
  /** The worker's messages so far. */
  readonly messages: () => AgentSession["messages"];
  /** The worker's session events as they come, until the returned function is called. */
  readonly subscribe: (listener: (event: AgentSessionEvent) => void) => () => void;
}

/** One worker on the board. Each run is one entry: a resumed delegation is a
 *  new entry with the same delegation id. */
export interface BoardWorker extends Omit<NewWorker, "model"> {
  readonly model: WorkerModel;
  /** The board's own id for this entry; a queued foreground worker has no delegation id yet. */
  readonly id: string;
  /** The board id of the parent delegation's entry, for a nested worker. */
  readonly parentId?: string;
  readonly state: WorkerState;
  readonly sessionFile?: string;
  /** Epoch milliseconds. */
  readonly queuedAt: number;
  readonly startedAt?: number;
  /** When it reached its end state; a view may keep a finished worker for a while after. */
  readonly endedAt?: number;
  /** Why it failed, when it did. */
  readonly error?: string;
  /** The turns it has started. */
  readonly turns: number;
  /** Summed over its replies. */
  readonly tokens: WorkerTokens;
  /** Its replies' reported cost in USD: a consumption signal on a subscription route, not a bill. */
  readonly cost: number;
  /** The tool it is running, if any; the latest one when several run. */
  readonly tool?: string;
  /** Its latest reply's text; empty until it writes any. */
  readonly text: string;
}

export interface WorkerTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/** A running worker's session for a view: its messages so far and its events as they come. */
export type LiveWorker = Pick<WorkerSession, "messages" | "subscribe">;

/** Called with the worker that changed, or with `undefined` when the whole
 *  board did, as when a new orchestrator session starts. */
export type BoardListener = (worker: BoardWorker | undefined) => void;

/** How a worker ended, as its result says. */
export interface WorkerEnd {
  readonly state: WorkerEndState;
  readonly sessionFile?: string;
  readonly error?: string;
}

/** How long `worker` has run at `now`, or ran; `undefined` before it starts. */
export function elapsedMs(worker: Pick<BoardWorker, "startedAt" | "endedAt">, now: number): number | undefined {
  return worker.startedAt === undefined ? undefined : (worker.endedAt ?? now) - worker.startedAt;
}

/** The subagents extension's handle on one worker's entry. */
export interface WorkerFeed {
  readonly id: string;
  /** The worker left the queue and runs. `model` replaces the model it was
   *  queued with, when only its start settles it: a preserved agent model or a resume's pin. */
  started(model?: WorkerModelSetup): void;
  /** The worker's session exists: its delegation id, session file and events. */
  session(session: WorkerSession): void;
  /** The worker, or its item before a worker started, reached its end state. */
  ended(end: WorkerEnd): void;
}

/** The board as views read it (the worker widget, the transcript view, the
 *  /subagents picker): they observe, and never feed or steer. */
export type WorkerBoardView = Pick<WorkerBoard, "workers" | "worker" | "byDelegation" | "subscribe" | "live">;

export interface WorkerBoardOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly setup: Omit<NewWorker, "model">;
  model: WorkerModelSetup;
  readonly parentId: string | undefined;
  state: WorkerState;
  delegationId: string | undefined;
  sessionFile: string | undefined;
  readonly queuedAt: number;
  startedAt: number | undefined;
  endedAt: number | undefined;
  error: string | undefined;
  /** A routed worker's rung history. */
  readonly rungs: RungServing[];
  turns: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
  cost: number;
  /** Tool call id to tool name, in start order. */
  readonly tools: Map<string, string>;
  text: string;
  session: WorkerSession | undefined;
  unsubscribe: (() => void) | undefined;
}

interface Usage {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly totalTokens?: number;
  readonly cost?: { readonly total?: number };
}

interface AssistantMessage {
  readonly role?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string }[];
  readonly usage?: Usage;
}

/** An assistant message's text; `undefined` for any other message. */
function assistantText(message: AssistantMessage): string | undefined {
  if (message.role !== "assistant" || message.content === undefined) return undefined;
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => part.type === "text" ? part.text ?? "" : "").join("");
}

/** Moves `entry` on by one of its session's events; whether anything changed. */
function applyEvent(entry: Entry, event: AgentSessionEvent): boolean {
  switch (event.type) {
    case "turn_start":
      entry.turns++;
      return true;
    case "message_update":
    case "message_end": {
      const message = event.message as AssistantMessage;
      const text = assistantText(message);
      if (text === undefined) return false;
      let changed = false;
      if (text !== "" && text !== entry.text) {
        entry.text = text;
        changed = true;
      }
      const usage = event.type === "message_end" ? message.usage : undefined;
      if (usage !== undefined) {
        const { tokens } = entry;
        tokens.input += usage.input ?? 0;
        tokens.output += usage.output ?? 0;
        tokens.cacheRead += usage.cacheRead ?? 0;
        tokens.cacheWrite += usage.cacheWrite ?? 0;
        tokens.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
        entry.cost += usage.cost?.total ?? 0;
        changed = true;
      }
      return changed;
    }
    case "tool_execution_start":
      entry.tools.set(event.toolCallId, event.toolName);
      return true;
    case "tool_execution_end":
      return entry.tools.delete(event.toolCallId);
    default:
      return false;
  }
}

const ENDED: readonly WorkerState[] = ["completed", "failed", "aborted"];

export class WorkerBoard {
  readonly #entries: Entry[] = [];
  readonly #listeners = new Set<BoardListener>();
  readonly #now: () => number;
  #sessionId: string | undefined;

  constructor(options: WorkerBoardOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Puts a queued worker on the board. */
  add(setup: NewWorker): WorkerFeed {
    const parent = setup.parentDelegationId === undefined ? undefined : this.#entryOf(setup.parentDelegationId);
    const { model, ...rest } = setup;
    const entry: Entry = { id: randomUUID(), setup: rest, model, parentId: parent?.id, state: "queued", delegationId: setup.delegationId,
      sessionFile: undefined, queuedAt: this.#now(), startedAt: undefined, endedAt: undefined, error: undefined,
      rungs: pinned(model, this.#now()),
      turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, tools: new Map(), text: "",
      session: undefined, unsubscribe: undefined };
    this.#entries.push(entry);
    this.#changed(entry);
    return {
      id: entry.id,
      started: (model) => {
        if (entry.state !== "queued") return;
        entry.state = "running";
        entry.startedAt = this.#now();
        if (model !== undefined) {
          entry.model = model;
          entry.rungs.splice(0, entry.rungs.length, ...pinned(model, entry.startedAt));
        }
        this.#changed(entry);
      },
      session: (session) => {
        if (ENDED.includes(entry.state) || entry.session !== undefined) return;
        entry.delegationId = session.sessionId;
        entry.sessionFile = session.sessionFile;
        entry.session = session;
        // A preserved definition without a thinking level runs on pi's default, which only the session knows.
        if (entry.model.kind === "preserved" && entry.model.effort === undefined) entry.model = { ...entry.model, effort: session.effort };
        entry.unsubscribe = session.subscribe((event) => { if (applyEvent(entry, event)) this.#changed(entry); });
        this.#changed(entry);
      },
      ended: (end) => {
        if (ENDED.includes(entry.state)) return;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        entry.session = undefined;
        entry.tools.clear();
        entry.state = end.state;
        entry.endedAt = this.#now();
        entry.sessionFile = end.sessionFile ?? entry.sessionFile;
        entry.error = end.error;
        this.#changed(entry);
      },
    };
  }

  /** The orchestrator session `sessionId` started. Finished workers stay on
   *  the board for the session; a new session, not a reload of the same one,
   *  starts with an empty board. */
  startSession(sessionId: string): void {
    if (sessionId === this.#sessionId) return;
    const hadEntries = this.#entries.length > 0;
    this.#sessionId = sessionId;
    for (const entry of this.#entries.splice(0)) entry.unsubscribe?.();
    if (hadEntries) this.#signal(undefined);
  }

  /** Calls `listener` with each worker that changes, until the returned function is called. */
  subscribe(listener: BoardListener): () => void {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  }

  /** A running worker's live session, for a transcript view; `undefined`
   *  before its session exists and once it has ended, when its session file holds it. */
  live(id: string): LiveWorker | undefined {
    const session = this.#entries.find((entry) => entry.id === id)?.session;
    return session === undefined ? undefined : { messages: session.messages, subscribe: session.subscribe };
  }

  /** A background worker's question waits on the orchestrator's answer, or no longer does. */
  asking(delegationId: string, asking: boolean): void {
    const entry = this.#entryOf(delegationId);
    if (entry === undefined || !entry.setup.background) return;
    if (asking ? entry.state !== "running" : entry.state !== "asking") return;
    entry.state = asking ? "asking" : "running";
    this.#changed(entry);
  }

  /** Every worker of the session, in the order they were queued, each nested
   *  worker right after its parent delegation's entry. */
  workers(): readonly BoardWorker[] {
    const children = new Map<string, Entry[]>();
    for (const entry of this.#entries) {
      if (entry.parentId !== undefined) children.set(entry.parentId, [...children.get(entry.parentId) ?? [], entry]);
    }
    const ordered: BoardWorker[] = [];
    const visit = (entry: Entry) => {
      ordered.push(snapshot(entry));
      for (const child of children.get(entry.id) ?? []) visit(child);
    };
    for (const entry of this.#entries) if (entry.parentId === undefined) visit(entry);
    return ordered;
  }

  /** One entry by its board id. */
  worker(id: string): BoardWorker | undefined {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** The latest entry of a delegation. */
  byDelegation(delegationId: string): BoardWorker | undefined {
    const entry = this.#entryOf(delegationId);
    return entry === undefined ? undefined : snapshot(entry);
  }

  /** The router served a request on `rung` (src/router/served-rungs.ts). A
   *  request of no running routed worker, such as a compaction summary's, changes nothing. */
  served(rung: ServedRung): void {
    const entry = this.#entryOf(rung.delegationId);
    if (entry === undefined || entry.model.kind !== "routed" || ENDED.includes(entry.state)) return;
    const latest = entry.rungs.at(-1);
    if (latest?.model === rung.model && latest.effort === rung.effort) return;
    entry.rungs.push(Object.freeze({ model: rung.model, effort: rung.effort, since: this.#now(),
      ...(rung.escalation === undefined ? {} : { escalation: Object.freeze({ ...rung.escalation }) }) }));
    this.#changed(entry);
  }

  #changed(entry: Entry): void {
    // A worker of an earlier session may still end after a new session cleared the board.
    if (this.#listeners.size > 0 && this.#entries.includes(entry)) this.#signal(snapshot(entry));
  }

  #signal(worker: BoardWorker | undefined): void {
    for (const listener of this.#listeners) {
      // A view's failure must not reach the worker whose event it watched.
      try { listener(worker); } catch { /* ignored */ }
    }
  }

  #entryOf(delegationId: string): Entry | undefined {
    for (let index = this.#entries.length - 1; index >= 0; index--) {
      if (this.#entries[index]!.delegationId === delegationId) return this.#entries[index];
    }
    return undefined;
  }
}

/** A resumed worker's rung history starts with its pin. */
function pinned(model: WorkerModelSetup, now: number): RungServing[] {
  return model.kind === "routed" && model.pin ? [Object.freeze({ model: model.pin.model, effort: model.pin.effort, since: now })] : [];
}

function modelOf(entry: Entry): WorkerModel {
  const { model } = entry;
  if (model.kind !== "routed") return model;
  return entry.rungs.length === 0 ? { kind: "routing" } : { kind: "routed", rungs: [...entry.rungs] };
}

function snapshot(entry: Entry): BoardWorker {
  return Object.freeze({
    ...entry.setup, model: modelOf(entry), id: entry.id, state: entry.state, queuedAt: entry.queuedAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    turns: entry.turns, tokens: Object.freeze({ ...entry.tokens }), cost: entry.cost, text: entry.text,
    ...(entry.tools.size === 0 ? {} : { tool: [...entry.tools.values()].at(-1)! }),
    ...(entry.delegationId === undefined ? {} : { delegationId: entry.delegationId }),
    ...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
    ...(entry.sessionFile === undefined ? {} : { sessionFile: entry.sessionFile }),
  });
}

const BOARD = Symbol.for("pi-orchestrator.subagents.worker-board");
type ProcessGlobal = typeof globalThis & { [BOARD]?: WorkerBoard };

/** The process's worker board. Every worker runs in the orchestrator's
 *  process (ADR 0007), and a nested worker's subagents call runs in its own
 *  copy of the subagents extension, so the board is kept on the process's
 *  global object: pi loads each extension with a fresh module copy (jiti
 *  moduleCache: false). The orchestrator's subagents extension starts it for
 *  each session. */
export function workerBoard(): WorkerBoard {
  const global = globalThis as ProcessGlobal;
  const existing = global[BOARD];
  if (existing !== undefined) return existing;
  const board = new WorkerBoard();
  watchServedRungs((rung) => board.served(rung));
  global[BOARD] = board;
  return board;
}
