import type { InlineExtension } from "@earendil-works/pi-coding-agent";

// The check-in (ADR 0008, amended 2026-10-14): a budget on how long a worker
// runs without reporting back. Once a worker passes `afterMinutes` or
// `afterModelCalls`, whichever comes first, and every `everyMinutes` after its
// last check-in, the harness steers it to check in: what it has done so far,
// what blocks it and its planned next step. A background worker sends the
// check-in with its report tool and waits for the orchestrator's decision,
// which the orchestrator gives with subagents_message: continue, accept, stop
// or a hint. Without a reply within `replyTimeoutMinutes` the worker goes on.
// A foreground worker cannot wait for a reply, as its caller's turn waits on
// it: the check-in ends its run, and its Result is the partial one it gives.

export interface CheckInSettings {
  /** Minutes a worker runs before its first check-in. */
  readonly afterMinutes: number;
  /** Model calls a worker makes before its first check-in, if they come before `afterMinutes`. */
  readonly afterModelCalls: number;
  /** Minutes between later check-ins, counted from the last one's end. */
  readonly everyMinutes: number;
  /** Minutes a background worker waits for the orchestrator's decision before it goes on. */
  readonly replyTimeoutMinutes: number;
}

/** The check-in when the owner sets none. */
export const DEFAULT_CHECK_IN: CheckInSettings = { afterMinutes: 15, afterModelCalls: 40, everyMinutes: 15, replyTimeoutMinutes: 5 };

/** The orchestrator's decision on a background worker's check-in. */
export type CheckInDecision = "continue" | "accept" | "hint" | "stop";

export interface CheckInReply {
  readonly decision: CheckInDecision;
  /** A hint's text. */
  readonly hint?: string;
}

/** What a background worker's check-in gets: the orchestrator's reply, or a timeout. */
export type CheckInAnswer = CheckInReply | { readonly decision: "timeout" };

/** The reply format, for the orchestrator's check-in message and its protocol. */
export const CHECK_IN_REPLY_FORMAT = "Reply with subagents_message and one of: `continue` (it goes on), " +
  "`accept` (it stops and returns its Result as it stands), `stop` (it is aborted), or `hint: <text>` (it goes on with your hint). " +
  "Any other text counts as a hint.";

/** Parses the orchestrator's reply to a check-in: `continue`, `accept` or `stop` alone (case-insensitive, an ending
 *  full stop allowed), or `hint: <text>`. Any other text is a hint, so a reply never stops a worker by accident. */
export function parseCheckInReply(text: string): CheckInReply {
  const trimmed = text.trim();
  const keyword = /^(continue|accept|stop)\.?$/i.exec(trimmed);
  if (keyword) return { decision: keyword[1]!.toLowerCase() as CheckInDecision };
  const hint = /^hint\s*:\s*([\s\S]*)$/i.exec(trimmed);
  return { decision: "hint", hint: hint ? hint[1]!.trim() : trimmed };
}

const MINUTE_MS = 60_000;

/** When a worker's next check-in is due: pure, on the clock and model calls it is given. */
export class CheckInSchedule {
  readonly #settings: CheckInSettings;
  #dueAt: number;
  #first = true;

  constructor(settings: CheckInSettings, startedAt: number) {
    this.#settings = settings;
    this.#dueAt = startedAt + settings.afterMinutes * MINUTE_MS;
  }

  /** Whether a check-in is due at `now` after `modelCalls` model calls. Model calls count for the first check-in only. */
  due(now: number, modelCalls: number): boolean {
    return now >= this.#dueAt || (this.#first && modelCalls >= this.#settings.afterModelCalls);
  }

  /** A check-in was asked for, or answered, at `now`: the next one is due `everyMinutes` later. */
  checkedIn(now: number): void {
    this.#first = false;
    this.#dueAt = now + this.#settings.everyMinutes * MINUTE_MS;
  }
}

/** The harness's steer to a background worker whose check-in is due. */
export const BACKGROUND_CHECK_IN = "Check-in: you have run for a while. Call report now with kind check-in, and in its text say what you have done so far, " +
  "what blocks you, if anything, and your planned next step. You wait for the orchestrator's decision; then follow it.";

/** The harness's steer to a foreground worker whose check-in is due: it ends the run. */
export const FOREGROUND_CHECK_IN = "Check-in: you have run for a while, so your run ends now. Make no more tool calls. " +
  "Reply with your Result as it stands: what you have done so far, what blocks you, if anything, and your planned next step. " +
  "The orchestrator can resume you to go on.";

/** Why a tool call is blocked once a worker's run ends at a check-in. */
export const CHECK_IN_ENDS_RUN = "Check-in: your run ends now. Make no more tool calls; reply with your Result as it stands.";

/** The report tool's result for a check-in's answer. */
export function checkInToolResult(answer: CheckInAnswer): string {
  switch (answer.decision) {
    case "continue": return "The orchestrator read your check-in: go on with your task.";
    case "hint": return `The orchestrator read your check-in and adds:\n\n${answer.hint ?? ""}\n\nGo on with your task, using this.`;
    case "accept": return "The orchestrator accepts your work as it stands. End your run now: make no more tool calls, and reply with your Result as it stands.";
    case "stop": return "The orchestrator stopped you.";
    case "timeout": return "No reply to your check-in in time: go on with your task.";
  }
}

/** How a worker's run ended at a check-in: a foreground worker's check-in, or a background one's accepted work. */
export type CheckInOutcome = "ended" | "accepted";

/** One worker's check-ins: counts its model calls, steers it when one is due and, once its run ends at a check-in,
 *  blocks its tool calls from the next model call on. */
export class WorkerCheckIn {
  readonly #schedule: CheckInSchedule;
  readonly #background: boolean;
  readonly #now: () => number;
  #steer: ((text: string) => void) | undefined;
  #modelCalls = 0;
  /** Tool calls are blocked from this model call on. */
  #endsAt: number | undefined;
  #outcome: CheckInOutcome | undefined;
  /** A background worker waits on its check-in's answer. */
  #waiting = false;

  constructor(settings: CheckInSettings, options: { readonly background: boolean; readonly now: () => number }) {
    this.#background = options.background;
    this.#now = options.now;
    this.#schedule = new CheckInSchedule(settings, this.#now());
  }

  /** How a check-in is sent to the worker, once its session exists. */
  attach(steer: (text: string) => void): void {
    this.#steer = steer;
  }

  /** A model call starts: a due check-in is steered in, delivered once this call's tool calls have run. */
  modelCallStarted(): void {
    this.#modelCalls++;
    if (this.#outcome !== undefined || this.#waiting || this.#steer === undefined) return;
    if (!this.#schedule.due(this.#now(), this.#modelCalls)) return;
    this.#schedule.checkedIn(this.#now());
    if (this.#background) {
      this.#steer(BACKGROUND_CHECK_IN);
      return;
    }
    this.#end("ended");
    this.#steer(FOREGROUND_CHECK_IN);
  }

  /** A background worker's check-in went out and waits for its answer. */
  waiting(): void {
    this.#waiting = true;
  }

  /** A background worker's check-in was answered. */
  answered(answer: CheckInAnswer): void {
    this.#waiting = false;
    this.#schedule.checkedIn(this.#now());
    if (answer.decision === "accept") this.#end("accepted");
  }

  #end(outcome: CheckInOutcome): void {
    this.#outcome = outcome;
    this.#endsAt = this.#modelCalls + 1;
  }

  /** How the run ended at a check-in, if it did. */
  get outcome(): CheckInOutcome | undefined {
    return this.#outcome;
  }

  /** Blocks the worker's tool calls once its run ends at a check-in. */
  extension(): InlineExtension {
    return {
      name: "pi-orchestrator-check-in",
      factory: (pi) => {
        pi.on("tool_call", () => this.#endsAt !== undefined && this.#modelCalls >= this.#endsAt
          ? { block: true, reason: CHECK_IN_ENDS_RUN } : undefined);
      },
    };
  }
}
