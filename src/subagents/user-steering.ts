import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BackgroundCalls, BackgroundMessageMode } from "./background.ts";
import { sendWorkerMessage } from "./message.ts";
import { hasEnded, type BoardWorker, type WorkerBoardView } from "./worker-board.ts";
import { agentLabel } from "./worker-widget.ts";

// User steering (bean mj35): the user messages a running background worker
// from its transcript view. The text goes through sendWorkerMessage, the
// subagents_message tool's own path (message.ts), so the worker gets it
// exactly as it would get the orchestrator's: a steer after its current tool
// call, a follow-up when it would stop, or the answer to its question. The
// orchestrator did not send it, so it is told twice: a custom message in its
// session, which never starts a turn, and a User steering part in the
// worker's Result, in the completion notice or the foreground tool result.

/** The custom message type of a user steer in the orchestrator's session. */
export const USER_STEER = "subagents-user-steer";

/** One message the user sent a worker from its transcript view. */
export interface UserSteer {
  readonly text: string;
  readonly mode: BackgroundMessageMode;
  /** It answered the worker's question, as the worker's next message does (background.ts). */
  readonly answer: boolean;
}

/** A user steer message's `details`. */
export interface UserSteerDetails extends UserSteer {
  readonly delegationId: string;
  readonly label: string;
}

/** What the transcript view needs to let the user message the worker it shows. */
export interface WorkerSteering {
  /** Whether `worker` takes a message now: a running background worker, asking or not. */
  accepts(worker: BoardWorker): boolean;
  /** Sends the user's `text` to `worker`; rejects with why it was not sent. */
  send(worker: BoardWorker, text: string, mode: BackgroundMessageMode): Promise<void>;
  /** Whether the user sent `text` to `worker`'s delegation, in any of its runs. */
  sentByUser(worker: BoardWorker, text: string): boolean;
}

/** The orchestrator's line about one user steer. */
export function userSteerText(delegationId: string, label: string, steer: UserSteer): string {
  return steer.answer
    ? `The user answered the question of worker ${delegationId} (${label}) directly: "${steer.text}"`
    : `The user steered worker ${delegationId} (${label}) directly: "${steer.text}" (mode ${steer.mode})`;
}

/** The User steering part of a worker's Result: what the user sent it, in order. */
export function userSteeringNote(steers: readonly UserSteer[]): string {
  const lines = steers.map((steer) => `- ${steer.answer ? "answer to its question" : steer.mode}: "${steer.text}"`);
  return ["User steering: the user messaged this worker directly from its transcript view. These came from the user, not from you:", ...lines].join("\n");
}

/** The user steers of one orchestrator session, by board entry: one run of a delegation. */
export class UserSteering implements WorkerSteering {
  readonly #pi: Pick<ExtensionAPI, "sendMessage">;
  readonly #calls: BackgroundCalls;
  readonly #board: Pick<WorkerBoardView, "workers">;
  readonly #byEntry = new Map<string, UserSteer[]>();

  constructor(pi: Pick<ExtensionAPI, "sendMessage">, calls: BackgroundCalls, board: Pick<WorkerBoardView, "workers">) {
    this.#pi = pi;
    this.#calls = calls;
    this.#board = board;
  }

  accepts(worker: BoardWorker): boolean {
    return worker.background && worker.delegationId !== undefined && !hasEnded(worker) && worker.state !== "queued" && this.#calls.accepts(worker.delegationId);
  }

  async send(worker: BoardWorker, text: string, mode: BackgroundMessageMode): Promise<void> {
    const id = worker.delegationId;
    if (id === undefined || !worker.background) throw new Error("Only a running background worker takes messages.");
    const answer = this.#calls.asking(id);
    await sendWorkerMessage(this.#calls, id, text, mode);
    const steer: UserSteer = { text, mode, answer };
    this.#byEntry.set(worker.id, [...this.#byEntry.get(worker.id) ?? [], steer]);
    const label = agentLabel(worker);
    const details: UserSteerDetails = { delegationId: id, label, ...steer };
    // Without a turn: an idle orchestrator sees it at its next turn, a busy one
    // after its current turn's tool results (pi's sendCustomMessage).
    this.#pi.sendMessage({ customType: USER_STEER, content: userSteerText(id, label, steer), display: true, details }, { triggerTurn: false });
  }

  sentByUser(worker: BoardWorker, text: string): boolean {
    const runs = worker.delegationId === undefined ? [worker.id]
      : this.#board.workers().filter((other) => other.delegationId === worker.delegationId).map((other) => other.id);
    const trimmed = text.trim();
    return [worker.id, ...runs].some((id) => this.#byEntry.get(id)?.some((steer) => steer.text.trim() === trimmed) === true);
  }

  /** What the user sent the board entry `entryId`, in order. */
  steers(entryId: string): readonly UserSteer[] {
    return this.#byEntry.get(entryId) ?? [];
  }
}
