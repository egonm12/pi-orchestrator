import { existsSync, readFileSync } from "node:fs";
import { parseSessionEntries, SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { RiskTier } from "../routing/classifier.ts";
import type { EditRecord, ForkRecord, RoutingRecord } from "../routing/decision-record.ts";
import type { ConstraintRung } from "../routing/tier-router.ts";
import { delegationRouting, editingDelegationProblem, isRunningDelegation } from "./quality-gate.ts";
import { readWorkerOutcome } from "./resume.ts";
import { workerBoard } from "./worker-board.ts";
import { workerSessionDir } from "./worker.ts";

// Independent reviewers of editing delegations (ADR 0010). A subagents item
// `review: <delegation id>` starts a reviewer for a finished editing
// delegation of this orchestrator session. The reviewer is routed through the
// auto model at the delegation's tier or higher, elevated for a delegation
// without a tier, and never on the rung the delegation ran on: its routing
// constraints (../router/auto-provider.ts) say so, and when routing leaves no
// rung and the session model it would fall back to is that rung, the reviewer
// fails with the reason instead of running.
//
// Where the facts come from: the tier and rung from the delegation's latest
// decision, fork or agent-model record (./quality-gate.ts), else its rung from
// the worker board, which shows the rung that served it; whether it edited from
// its edit records (./editing.ts); its task, Result and the files its edit and
// write calls named from its saved worker session, or from the board's copy of
// its messages when the session was not saved.
//
// A compaction summary request arrives with a new session id and is routed
// without the reviewer's constraints (ADR 0006). It only condenses the
// reviewer's own context, and the review goes on on the reviewer's pin, so
// that is accepted.
//
// subagents_verdict (./verdict.ts) takes a reviewer's delegation id only for a
// completed review of the same delegation, started after that delegation's
// latest edit: the board and the reviewer's saved outcome record what it reviewed.

/** A reviewer's link to the delegation it reviews, as its saved outcome keeps it. */
export interface SavedReview {
  readonly delegationId: string;
  /** ISO-8601: when the reviewer started. */
  readonly startedAt: string;
}

/** What the reviewer is given to find the change. */
export interface ReviewMaterial {
  /** The delegation's user messages in order: its task, then any resume task or steering message. */
  readonly tasks: readonly string[];
  /** Its latest reply's text, its Result; empty when it gave none. */
  readonly result: string;
  /** The paths its edit and write calls named; `undefined` when its messages are not known. */
  readonly files?: readonly string[];
  /** Its saved session, with the whole transcript. */
  readonly sessionFile?: string;
}

/** A finished editing delegation a reviewer may start for. */
export interface ReviewTarget {
  readonly delegationId: string;
  /** Absent for a delegation without a tier, which is gated as elevated. */
  readonly tier?: RiskTier;
  /** The reviewer's routing constraints: at the delegation's tier or higher, never on its rung. */
  readonly constraints: { readonly minimumTier: RiskTier; readonly excludedRung: ConstraintRung };
  readonly material: ReviewMaterial;
}

/** Appended to a reviewer's system prompt after the reporting rules, with the reviewed delegation after it. */
export const REVIEW_RULES = `# Review rules

You are a reviewer: an independent check of another worker's finished delegation. The orchestrator judges that delegation by your Result. Its task, its Result and the files it changed follow below.

- Check the change itself against the delegation's task: read the changed files and the diff (git status, git diff). Its Result is the worker's account, not evidence: check each claim that matters.
- Rerun nothing, no build, test or command from its Verified by section, unless your task tells you to.
- Change nothing. Name what falls short instead of fixing it.
- Answer accept or request changes, with the reasons. For request changes, name each shortfall with its file:line and what the task asked for.

Start your Confirmed section with your answer on a line of its own, "Answer: accept" or "Answer: request changes", then write your Result sections as the reporting rules say.`;

interface MessageLike {
  readonly role?: string;
  readonly content?: string | readonly { readonly type: string; readonly text?: string; readonly name?: string; readonly arguments?: unknown }[];
}

function textOf(message: MessageLike): string {
  if (typeof message.content === "string") return message.content;
  return (message.content ?? []).map((part) => part.type === "text" ? part.text ?? "" : "").join("");
}

/** The tasks, Result and edited paths in a delegation's own messages. */
function materialOf(messages: readonly MessageLike[]): Pick<ReviewMaterial, "tasks" | "result" | "files"> {
  const files: string[] = [];
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string") continue;
    for (const part of message.content ?? []) {
      const path = (part.arguments as { path?: unknown } | undefined)?.path;
      if (part.type === "toolCall" && (part.name === "edit" || part.name === "write") && typeof path === "string" && !files.includes(path)) files.push(path);
    }
  }
  const result = messages.filter((message) => message.role === "assistant").map(textOf).filter((text) => text.trim() !== "").at(-1) ?? "";
  return { tasks: messages.filter((message) => message.role === "user").map(textOf), result, files };
}

/** The saved session of this orchestrator session's delegation `id`, if one exists. */
function savedSession(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string): string | undefined {
  let file = workerBoard().byDelegation(id)?.sessionFile;
  if (file === undefined) {
    try { file = SessionManager.findById(ctx.cwd, id, workerSessionDir(ctx.sessionManager)); } catch { /* none saved */ }
  }
  return file !== undefined && existsSync(file) ? file : undefined;
}

/** The delegation's own messages: a fork's copy of the orchestrator's branch,
 *  up to its fork point, is left out. The file is only read, as the transcript view reads it. */
function ownMessages(file: string, forkPoint: string | null | undefined): MessageLike[] {
  const entries = parseSessionEntries(readFileSync(file, "utf8"));
  const start = forkPoint === undefined || forkPoint === null ? 0 : entries.findIndex((entry) => "id" in entry && entry.id === forkPoint) + 1;
  return entries.slice(start).flatMap((entry) => entry.type === "message" ? [entry.message as MessageLike] : []);
}

function reviewMaterial(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string, records: readonly RoutingRecord[]): ReviewMaterial {
  const fork = records.filter((record): record is ForkRecord => record.recordType === "fork" && record.delegationId === id).at(-1);
  const file = savedSession(ctx, id);
  if (file !== undefined) return { ...materialOf(ownMessages(file, fork?.forkPoint)), sessionFile: file };
  const board = workerBoard().byDelegation(id);
  const unsaved = board === undefined ? undefined : workerBoard().unsavedMessages(board.id) as readonly MessageLike[] | undefined;
  const tasks = board === undefined ? [] : [board.task];
  if (unsaved === undefined) return { tasks, result: "" };
  // An unsaved fork's messages start with its copy of the orchestrator's branch, which has no fork point to cut at.
  const material = materialOf(unsaved);
  return fork === undefined ? material : { tasks, result: material.result };
}

/** The rung the board saw serve the delegation's latest run, for a delegation no record names one for. */
function boardRung(id: string): ConstraintRung | undefined {
  const model = workerBoard().byDelegation(id)?.model;
  if (model?.kind === "routed") {
    const rung = model.rungs.at(-1);
    return rung === undefined ? undefined : { model: rung.model, effort: rung.effort };
  }
  return model?.kind === "fork" || (model?.kind === "preserved" && model.effort !== undefined)
    ? { model: model.model, effort: model.effort! } : undefined;
}

/** The finished editing delegation `id` for a review item, or an Error with
 *  the reason no reviewer may start for it. `records` is the record folder in file order. */
export function reviewTarget(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, id: string, records: readonly RoutingRecord[]): ReviewTarget {
  const refuse = (why: string): never => { throw new Error(`cannot review delegation ${id}: ${why}`); };
  const checked = editingDelegationProblem(ctx, records, id);
  if (checked.problem !== undefined) {
    const { problem } = checked;
    refuse(problem.kind === "running" ? "it is still running; review it once it has finished"
      : problem.kind === "nested" ? `it is a worker's own worker; its edits count for delegation ${problem.delegationId}, so review that one`
      : problem.kind === "research" ? "it did not edit; only an editing delegation gets a reviewer"
      : problem.kind === "unknown" ? "unknown delegation id" : "it belongs to another orchestrator session");
  }
  const routing = delegationRouting(records, id);
  const rung = routing.rung ?? boardRung(id) ??
    refuse("no record names the rung it ran on and the worker board does not show it, so a reviewer cannot be kept off that rung");
  return {
    delegationId: id, ...(routing.tier === undefined ? {} : { tier: routing.tier }),
    constraints: { minimumTier: routing.tier ?? "elevated", excludedRung: rung },
    material: reviewMaterial(ctx, id, records),
  };
}

/** The review rules and the reviewed delegation, for the reviewer's system prompt. */
export function reviewerPrompt(target: ReviewTarget): string {
  const { delegationId, tier, material } = target;
  const [task, ...later] = material.tasks;
  const files = material.files === undefined
    ? "The files it changed are not known: check git status and git diff."
    : `Files its edit and write calls named: ${material.files.length === 0 ? "none" : material.files.join(", ")}. ` +
      "Changes it made through bash, ctx_execute or a worker it started are not listed: check git status and git diff.";
  return [
    REVIEW_RULES,
    "# The reviewed delegation",
    `Delegation ${delegationId}, ${tier === undefined ? "without a tier, so it is gated as elevated" : `routed at the ${tier} tier`}. ` +
      (material.sessionFile === undefined ? "Its session was not saved." : `Its saved session, with the whole transcript: ${material.sessionFile}`),
    `<task>\n${task ?? "Not known."}\n</task>`,
    ...later.map((text) => `<later-instruction>\n${text}\n</later-instruction>`),
    `<result>\n${material.result === "" ? "It gave no Result." : material.result}\n</result>`,
    files,
  ].join("\n\n");
}

/** Why `reviewerId` cannot stand as the reviewer of `reviewedId` in a
 *  verdict, or `undefined` when it can: a completed review of that delegation
 *  by this orchestrator session, started after the delegation's latest edit. */
export function reviewerProblem(ctx: Pick<ExtensionContext, "cwd" | "sessionManager">, reviewerId: string, reviewedId: string,
  records: readonly RoutingRecord[]): string | undefined {
  if (reviewerId === reviewedId) return `delegation ${reviewedId} cannot be its own reviewer`;
  if (isRunningDelegation(reviewerId)) return `reviewer ${reviewerId} is still running; name it once it has finished`;
  // The board's latest entry is the reviewer's latest run; a resumed reviewer's entry has no review, and its saved outcome keeps it.
  const board = workerBoard().byDelegation(reviewerId);
  const file = savedSession(ctx, reviewerId);
  const saved = file === undefined ? undefined : readWorkerOutcome(file);
  const reviewed = board?.review ?? saved?.review?.delegationId;
  if (reviewed === undefined) {
    return `delegation ${reviewerId} is not a reviewer of this orchestrator session; start one with a subagents item whose review is ${reviewedId}`;
  }
  if (reviewed !== reviewedId) return `reviewer ${reviewerId} reviewed delegation ${reviewed}, not ${reviewedId}`;
  const state = board?.state ?? saved?.status;
  if (state !== "completed") return `reviewer ${reviewerId} ${state === undefined ? "did not finish" : `ended ${state}`}; only a completed review counts`;
  const started = board?.startedAt ?? (saved?.review === undefined ? undefined : Date.parse(saved.review.startedAt));
  const lastEdit = records.filter((record): record is EditRecord => record.recordType === "edit" && record.delegationId === reviewedId).at(-1);
  if (started !== undefined && lastEdit !== undefined && started < Date.parse(lastEdit.timestamp)) {
    return `reviewer ${reviewerId} started before delegation ${reviewedId}'s latest edit; start a new review`;
  }
  return undefined;
}
