import type { TranscriptFrame } from "./transcript-view.ts";
import { elapsedMs, type BoardWorker, type RungServing } from "./worker-board.ts";
import { agentLabel, fitted, formatElapsed, oneLine, STATE_COLOR, type Part } from "./worker-widget.ts";

// The transcript view's top (epic a338, vo0z): the orchestrator bar, which
// keeps the user who reads one worker's transcript aware of the rest, and the
// header, what they want to know about that worker. A few lines, each cut to
// the width.

const SEPARATOR = " · ";

/** `850`, `12.3k`, `456k` or `1.2M` tokens. The bounds sit where rounding
 *  would reach the next step, so no count reads `100.0k` or `1000k`. */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 99_950) return `${(count / 1_000).toFixed(1)}k`;
  if (count < 999_500) return `${Math.round(count / 1_000)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/** `$0.042`: the replies' reported cost, as pi's footer shows it. */
export function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

/** Agent, worker state, and once it has started its elapsed time, turns,
 *  tokens and cost; then which worker of how many it is. */
function statsLine(frame: TranscriptFrame): string {
  const { worker } = frame;
  const parts: Part[] = [["accent", agentLabel(worker)], [STATE_COLOR[worker.state], worker.state]];
  const elapsed = elapsedMs(worker, frame.now);
  if (elapsed !== undefined) {
    parts.push(["dim", formatElapsed(elapsed)], ["dim", `${worker.turns} ${worker.turns === 1 ? "turn" : "turns"}`],
      ["dim", `${formatTokens(worker.tokens.total)} tok`], ["dim", formatCost(worker.cost)]);
  }
  parts.push(["dim", frame.position === 0 ? "no longer on the board" : `worker ${frame.position} of ${frame.count}`]);
  return fitted("", parts, frame.theme, frame.width);
}

/** `12:00:05`, local time. */
function clockTime(epochMs: number): string {
  return new Date(epochMs).toTimeString().slice(0, 8);
}

/** One rung of a routed worker's history: since its first request, and the escalation it came from. */
function rungText(rung: RungServing): string {
  const escalation = rung.escalation === undefined ? "" : ` (escalated from ${rung.escalation.from} to ${rung.escalation.to})`;
  return `${rung.model}:${rung.effort} since ${clockTime(rung.since)}${escalation}`;
}

const THEN = ", then ";
/** Stands for the rungs a narrow terminal leaves out. */
const EARLIER = "… then ";

/** The model and effort. A routed worker's whole rung history, in order; a
 *  worker keeps its pin (ADR 0006), so there is normally one rung. The rung
 *  serving its latest request matters most, so a narrow terminal drops the oldest first. */
function modelLine(frame: TranscriptFrame): string {
  const { model } = frame.worker;
  let text: string;
  switch (model.kind) {
    case "routing": text = "routing…"; break;
    case "routed": {
      const rungs = model.rungs.map(rungText);
      let first = 0;
      const joined = () => `${first === 0 ? "" : EARLIER}${rungs.slice(first).join(THEN)}`;
      while (first < rungs.length - 1 && joined().length > frame.width) first++;
      text = joined();
      break;
    }
    case "fork": text = `${model.model}:${model.effort} (the session model, not routed)`; break;
    case "preserved": text = `${model.effort === undefined ? model.model : `${model.model}:${model.effort}`} (the agent definition's model, not routed)`; break;
  }
  return fitted("", [["text", text]], frame.theme, frame.width);
}

/** A delegation id cut to its first characters, for a narrow terminal. */
function shortId(id: string): string {
  return id.length <= 9 ? id : `${id.slice(0, 8)}…`;
}

/** The delegation id and, for a nested worker, its parent delegation and
 *  that worker's agent. Short ids when the full ones do not fit. A queued
 *  foreground worker gets its delegation id only when it starts. */
function delegationLine(frame: TranscriptFrame): string {
  const { worker } = frame;
  const parent = worker.parentId === undefined ? undefined : frame.workers.find((other) => other.id === worker.parentId);
  const text = (id: (full: string) => string) => [
    worker.delegationId === undefined ? "no delegation id yet" : `delegation ${id(worker.delegationId)}`,
    ...worker.parentDelegationId === undefined ? []
      : [`parent delegation ${id(worker.parentDelegationId)}${parent === undefined ? "" : ` (${agentLabel(parent)})`}`],
  ].join(SEPARATOR);
  const full = text((id) => id);
  return fitted("", [["dim", full.length <= frame.width ? full : text(shortId)]], frame.theme, frame.width);
}

/** The task's first line. */
function taskLine(frame: TranscriptFrame): string {
  return fitted("", [["muted", oneLine(frame.worker.task, "first")]], frame.theme, frame.width);
}

/** The default header: the worker's agent, worker state and progress; its
 *  model; its delegation; and its task. */
export function transcriptHeader(frame: TranscriptFrame): string[] {
  return [statsLine(frame), modelLine(frame), delegationLine(frame), taskLine(frame)];
}

/** `worker 2 (reviewer)`: an asking worker by its place, the one "worker n of m" and ←→ go by. */
function askingWorker(worker: BoardWorker, position: number): string {
  return worker.agent === undefined ? `worker ${position}` : `worker ${position} (${worker.agent})`;
}

/** The default bar: whether the orchestrator is running or idle, and the
 *  workers asking it, the count first so a narrow terminal keeps it. It only
 *  tells; answering is the orchestrator's (subagents_message). */
export function orchestratorBar(frame: TranscriptFrame): string[] {
  const parts: Part[] = [[frame.orchestrator === "running" ? STATE_COLOR.running : "dim", `orchestrator ${frame.orchestrator}`]];
  const asking = frame.workers.flatMap((worker, index) => worker.state === "asking" ? [askingWorker(worker, index + 1)] : []);
  if (asking.length > 0) {
    parts.push([STATE_COLOR.asking, `${asking.length} ${asking.length === 1 ? "worker" : "workers"} asking: ${asking.join(", ")}`]);
  }
  return [fitted("", parts, frame.theme, frame.width)];
}
