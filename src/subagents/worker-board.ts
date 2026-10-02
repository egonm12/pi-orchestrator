import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { watchServedRungs, type RungEscalation, type ServedRung } from "../router/served-rungs.ts";
import type { RiskTier } from "../routing/tiers.ts";

// The worker board: one in-process record of every worker of the
// orchestrator session, foreground, background and nested, for the live
// worker view (epic a338). The subagents extension feeds it; it reads each
// worker's own session events for turns, tokens, cost and activity (by
// phase, held ACTIVITY_HOLD_MS; CONTEXT.md, Activity), and the
// router's served rungs (src/router/served-rungs.ts) for a routed worker's
// model. It also keeps whether the orchestrator itself is running or idle,
// for the transcript view's bar. Views read it and get a change signal. It
// only observes, with one exception: the transcript view's stop (x) reaches a
// worker through stop(), which calls the stop the subagents extension handed
// over for it.

/** CONTEXT.md, Worker state. Only a background worker can be asking. */
export type WorkerState = "queued" | "running" | "asking" | "completed" | "failed" | "aborted";
export type WorkerEndState = Extract<WorkerState, "completed" | "failed" | "aborted">;

/** CONTEXT.md, Activity: what a worker is doing right now, by phase. */
export type Activity =
  /** Waiting on its model, or its model thinks. */
  | { readonly kind: "thinking" }
  /** Its model writes a reply or a tool call. */
  | { readonly kind: "writing" }
  /** The tool it runs, the latest when several run. */
  | { readonly kind: "tool"; readonly tool: string }
  | { readonly kind: "failed"; readonly error: string };

/** How long an activity stays shown at least before a newer one replaces it:
 *  a phase that changes every few hundred milliseconds would flicker. */
export const ACTIVITY_HOLD_MS = 1_500;

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
  readonly label?: string;
  /** Known before the worker starts for a background item and a resume item. */
  readonly delegationId?: string;
  /** The delegation of the worker that made this delegation (ADR 0008). */
  readonly parentDelegationId?: string;
  /** The delegation this worker reviews, for a reviewer (ADR 0010). */
  readonly review?: string;
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
  /** A tool's definition in the worker's session, for its renderers in a transcript. */
  readonly toolDefinition?: (name: string) => ToolDefinition | undefined;
}

/** One worker on the board. Each run is one entry: a resumed delegation is a
 *  new entry with the same delegation id. */
export interface BoardWorker extends Omit<NewWorker, "model"> {
  readonly model: WorkerModel;
  readonly tier?: RiskTier;
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
  /** What it is doing, by phase; `undefined` before its first session
   *  event and once it ended, unless it failed. The same for every view. */
  readonly activity?: Activity;
}

export interface WorkerTokens {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/** A running worker's session for a view: its messages so far and its events as they come. */
export type LiveWorker = Pick<WorkerSession, "messages" | "subscribe" | "toolDefinition">;

/** What the subagents extension hands the board to act on one worker. */
export interface WorkerControl {
  /** Stops this worker alone: a running one aborts, a queued one never starts. */
  readonly stop: () => void;
}

/** The orchestrator's own agent: running from a prompt until its run settles,
 *  retries and queued continuations included; idle between. */
export type OrchestratorState = "running" | "idle";

/** Called with the worker that changed, or with `undefined` when something
 *  else did: the whole board, as when a new orchestrator session starts, or
 *  the orchestrator's state. */
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
export type WorkerBoardView = Pick<WorkerBoard, "workers" | "worker" | "byDelegation" | "subscribe" | "live" | "unsavedMessages" | "orchestratorState">;

export interface WorkerBoardOptions {
  /** Epoch milliseconds. */
  readonly now?: () => number;
}

interface Entry {
  readonly id: string;
  readonly setup: Omit<NewWorker, "model">;
  model: WorkerModelSetup;
  tier: RiskTier | undefined;
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
  /** The activity shown, and since when. */
  activity: { value: Activity; since: number } | undefined;
  /** The newest activity waiting for the shown one's hold to pass, and since when. */
  pending: { value: Activity; since: number } | undefined;
  session: WorkerSession | undefined;
  unsubscribe: (() => void) | undefined;
  readonly stop: (() => void) | undefined;
  /** A finished worker's last messages when its session was not saved. */
  unsaved: AgentSession["messages"] | undefined;
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
  readonly usage?: Usage;
}

/** The phase a message_update's streamed piece belongs to; `undefined` for a piece of no phase. */
function streamedPhase(event: Extract<AgentSessionEvent, { type: "message_update" }>): Activity | undefined {
  if ((event.message as AssistantMessage).role !== "assistant") return undefined;
  switch (event.assistantMessageEvent?.type) {
    case "thinking_start":
    case "thinking_delta":
    case "thinking_end": return THINKING;
    case "text_start":
    case "text_delta":
    case "text_end":
    case "toolcall_start":
    case "toolcall_delta":
    case "toolcall_end": return WRITING;
    default: return undefined;
  }
}

const THINKING: Activity = Object.freeze({ kind: "thinking" });
const WRITING: Activity = Object.freeze({ kind: "writing" });

/** The activity as one line of text, for comparing two. */
function activityKey(activity: Activity | undefined): string | undefined {
  switch (activity?.kind) {
    case undefined: return undefined;
    case "thinking":
    case "writing": return activity.kind;
    case "tool": return `tool:${activity.tool}`;
    case "failed": return `failed:${activity.error}`;
  }
}

/** The shown activity at `now`: a pending one replaces it once its hold has
 *  passed. It shows from when it could first have, not from when this runs,
 *  so a late settle holds it no longer than its due. */
function settleActivity(entry: Entry, now: number): void {
  const { activity, pending } = entry;
  if (pending === undefined || activity === undefined || now - activity.since < ACTIVITY_HOLD_MS) return;
  entry.activity = { value: pending.value, since: Math.max(activity.since + ACTIVITY_HOLD_MS, pending.since) };
  entry.pending = undefined;
}

/** The worker's phase moved to `activity` at `now`; whether the shown activity changed. */
function enterPhase(entry: Entry, activity: Activity, now: number): boolean {
  settleActivity(entry, now);
  const shown = entry.activity;
  if (activityKey(shown?.value) === activityKey(activity)) {
    entry.pending = undefined;
    return false;
  }
  if (shown === undefined || now - shown.since >= ACTIVITY_HOLD_MS) {
    entry.activity = { value: activity, since: now };
    entry.pending = undefined;
    return true;
  }
  entry.pending = { value: activity, since: now };
  return false;
}

/** The tool phase of the latest tool still running, or thinking when none runs. */
function toolPhase(entry: Entry): Activity {
  const tool = [...entry.tools.values()].at(-1);
  return tool === undefined ? THINKING : Object.freeze({ kind: "tool", tool });
}

/** Moves `entry` on by one of its session's events at `now`; whether anything changed. */
function applyEvent(entry: Entry, event: AgentSessionEvent, now: number): boolean {
  switch (event.type) {
    case "turn_start":
      entry.turns++;
      enterPhase(entry, THINKING, now);
      return true;
    case "message_update": {
      const phase = streamedPhase(event);
      return phase !== undefined && enterPhase(entry, phase, now);
    }
    case "message_end": {
      const message = event.message as AssistantMessage;
      const usage = message.role === "assistant" ? message.usage : undefined;
      if (usage === undefined) return false;
      const { tokens } = entry;
      tokens.input += usage.input ?? 0;
      tokens.output += usage.output ?? 0;
      tokens.cacheRead += usage.cacheRead ?? 0;
      tokens.cacheWrite += usage.cacheWrite ?? 0;
      tokens.total += usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      entry.cost += usage.cost?.total ?? 0;
      return true;
    }
    case "tool_execution_start":
      entry.tools.set(event.toolCallId, event.toolName);
      return enterPhase(entry, toolPhase(entry), now);
    case "tool_execution_end":
      if (!entry.tools.delete(event.toolCallId)) return false;
      return enterPhase(entry, toolPhase(entry), now);
    default:
      return false;
  }
}

const ENDED: readonly WorkerState[] = ["completed", "failed", "aborted"];

/** Whether `worker` has reached its end state. */
export function hasEnded(worker: Pick<BoardWorker, "state">): boolean {
  return ENDED.includes(worker.state);
}

export class WorkerBoard {
  readonly #entries: Entry[] = [];
  readonly #listeners = new Set<BoardListener>();
  readonly #now: () => number;
  #sessionId: string | undefined;
  #orchestrator: OrchestratorState = "idle";

  constructor(options: WorkerBoardOptions = {}) {
    this.#now = options.now ?? Date.now;
  }

  /** Puts a queued worker on the board, with the way to stop it when there is one. */
  add(setup: NewWorker, control?: WorkerControl): WorkerFeed {
    const parent = setup.parentDelegationId === undefined ? undefined : this.#entryOf(setup.parentDelegationId);
    const { model, ...rest } = setup;
    const entry: Entry = { id: randomUUID(), setup: rest, model, tier: undefined, parentId: parent?.id, state: "queued", delegationId: setup.delegationId,
      sessionFile: undefined, queuedAt: this.#now(), startedAt: undefined, endedAt: undefined, error: undefined,
      rungs: pinned(model, this.#now()),
      turns: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0, tools: new Map(), activity: undefined, pending: undefined,
      session: undefined, unsubscribe: undefined, stop: control?.stop, unsaved: undefined };
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
        entry.unsubscribe = session.subscribe((event) => { if (applyEvent(entry, event, this.#now())) this.#changed(entry); });
        this.#changed(entry);
      },
      ended: (end) => {
        if (ENDED.includes(entry.state)) return;
        entry.unsubscribe?.();
        entry.unsubscribe = undefined;
        // Nothing on disk, as when the orchestrator's session is in memory: the
        // transcript view has nothing else to read once the worker ends.
        if (end.sessionFile === undefined) entry.unsaved = entry.session?.messages();
        entry.session = undefined;
        entry.tools.clear();
        entry.state = end.state;
        entry.endedAt = this.#now();
        // A failure shows at once; a worker that ended otherwise is doing nothing.
        entry.activity = end.state === "failed"
          ? { value: Object.freeze({ kind: "failed", error: end.error ?? "failed" }), since: entry.endedAt } : undefined;
        entry.pending = undefined;
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
    const changed = this.#entries.length > 0 || this.#orchestrator !== "idle";
    this.#sessionId = sessionId;
    // A session starts idle: whatever the last one's agent did is over.
    this.#orchestrator = "idle";
    for (const entry of this.#entries.splice(0)) entry.unsubscribe?.();
    if (changed) this.#signal(undefined);
  }

  /** The orchestrator's agent started a run or settled. The subagents
   *  extension feeds it from the orchestrator's session only, never a worker's. */
  setOrchestratorState(state: OrchestratorState): void {
    if (state === this.#orchestrator) return;
    this.#orchestrator = state;
    this.#signal(undefined);
  }

  /** Whether the orchestrator is working, for the transcript view's bar: a
   *  user reading a worker's transcript can see when it is their turn again. */
  orchestratorState(): OrchestratorState {
    return this.#orchestrator;
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
    if (session === undefined) return undefined;
    return { messages: session.messages, subscribe: session.subscribe, ...(session.toolDefinition === undefined ? {} : { toolDefinition: session.toolDefinition }) };
  }

  /** A finished worker's last messages when its session was not saved, as
   *  when the orchestrator's session is in memory; `undefined` otherwise. */
  unsavedMessages(id: string): AgentSession["messages"] | undefined {
    return this.#entries.find((entry) => entry.id === id)?.unsaved;
  }

  /** Stops one unfinished worker, for the transcript view's x; whether a stop
   *  was sent. The worker's end state follows when it has ended. */
  stop(id: string): boolean {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    if (entry?.stop === undefined || ENDED.includes(entry.state)) return false;
    entry.stop();
    return true;
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
      ordered.push(this.#snapshot(entry));
      for (const child of children.get(entry.id) ?? []) visit(child);
    };
    for (const entry of this.#entries) if (entry.parentId === undefined) visit(entry);
    return ordered;
  }

  /** One entry by its board id. */
  worker(id: string): BoardWorker | undefined {
    const entry = this.#entries.find((candidate) => candidate.id === id);
    return entry === undefined ? undefined : this.#snapshot(entry);
  }

  /** The latest entry of a delegation. */
  byDelegation(delegationId: string): BoardWorker | undefined {
    const entry = this.#entryOf(delegationId);
    return entry === undefined ? undefined : this.#snapshot(entry);
  }

  /** Records the tier of a routed delegation after its routing decision is available. */
  setTier(delegationId: string, tier: RiskTier): void {
    const entry = this.#entryOf(delegationId);
    if (entry === undefined || entry.tier === tier) return;
    entry.tier = tier;
    this.#changed(entry);
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
    if (this.#listeners.size > 0 && this.#entries.includes(entry)) this.#signal(this.#snapshot(entry));
  }

  /** `entry` as views read it. A pending activity whose hold has passed shows
   *  here: views redraw every second, so the board needs no timer of its own. */
  #snapshot(entry: Entry): BoardWorker {
    settleActivity(entry, this.#now());
    return snapshot(entry);
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
    ...entry.setup, model: modelOf(entry), ...(entry.tier === undefined ? {} : { tier: entry.tier }), id: entry.id, state: entry.state, queuedAt: entry.queuedAt,
    ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }),
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    ...(entry.error === undefined ? {} : { error: entry.error }),
    turns: entry.turns, tokens: Object.freeze({ ...entry.tokens }), cost: entry.cost,
    ...(entry.activity === undefined ? {} : { activity: entry.activity.value }),
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
