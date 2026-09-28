import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { personalAgentDir } from "../policy/ban-lists.ts";
import { isOrchestratorSession } from "../subagents/orchestrator-session.ts";

// Live check for bean pi-orchestrator-6yxt: a pi extension that records, for
// every provider request, whether the system prompt the provider actually got
// holds the orchestrator protocol, and what started the request's run: a typed
// prompt (a skill prompt or plain text) or a message (a completion notice, a
// worker's report or question, a gate reminder). Load it with
// `pi -e src/live-check/protocol-probe.ts`; see protocol-probe.md. It is not
// part of the package's extensions and never changes a request.
//
// It reads the provider payload, not pi's transcript: the protocol can be in
// the transcript while a forced prompt (an extension that returns
// systemPrompt) keeps it from the provider, and a request can carry it while
// the transcript does not. Only the payload's system text is searched (the
// Anthropic `system` field, the Responses `instructions`, and system or
// developer items): a tool result that read orchestrator-protocol.ts must not
// count. No prompt, message or payload text is written, only markers.

export const PROBE_VERSION = 1;

/** Present in the protocol's text, and together in no other system prompt. */
const MARKERS = ["# Orchestrator protocol", "You are the orchestrator. You own clarification"] as const;

/** The system text of a provider payload: every string under its system,
 *  instructions, and system or developer role items. */
export function payloadSystemText(payload: unknown): string {
  const texts: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") texts.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  if (!payload || typeof payload !== "object") return "";
  const body = payload as Record<string, unknown>;
  collect(body.system);
  collect(body.instructions);
  for (const list of [body.messages, body.input]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const role = (item as { role?: unknown } | null)?.role;
      if (role === "system" || role === "developer") collect((item as { content?: unknown }).content);
    }
  }
  return texts.join("\n");
}

/** Whether `text` holds the orchestrator protocol. */
export function hasProtocol(text: string): boolean {
  return MARKERS.every((marker) => text.includes(marker));
}

/** The probe file: `PI_PROTOCOL_PROBE_FILE`, or one file per pi process in the state folder's `live-check/`. */
export function probeFile(env: NodeJS.ProcessEnv = process.env, now: Date = new Date()): string {
  const configured = env.PI_PROTOCOL_PROBE_FILE;
  if (configured) return resolve(configured === "~" || configured.startsWith("~/") ? `${homedir()}${configured.slice(1)}` : configured);
  const state = env.PI_ORCHESTRATOR_STATE_DIR ?? join(personalAgentDir(env), "pi-orchestrator");
  return resolve(state, "live-check", `protocol-probe-${now.toISOString().replace(/[:.]/g, "-")}-${process.pid}.jsonl`);
}

/** What started a run: a prompt (typed, `skill` when it was /skill:…), or a message (its custom types). */
export type RunStart = { readonly by: "prompt"; readonly skill: boolean } | { readonly by: "message" };

export interface ProbeRecord {
  readonly v: number;
  readonly at: string;
  readonly session: string;
  readonly orchestrator: boolean;
  /** The run's number in this session, from 1. */
  readonly run: number;
  readonly start: RunStart;
  /** The custom messages (by customType) the run has seen so far, such as subagents-completion. */
  readonly messages: readonly string[];
  /** Skill prompts typed while this run was streaming, queued into it. */
  readonly queuedSkills: number;
  /** The request's number within its run, from 1: 2 and later follow a tool call. */
  readonly turn: number;
  /** Whether the provider's system text held the protocol. */
  readonly protocol: boolean;
  /** Whether pi's own view of the prompt (ctx.getSystemPrompt) held it. */
  readonly piPrompt: boolean;
  /** Whether the provider's system text held pi-claude-rules' section, which forces the prompt. */
  readonly projectRules: boolean;
}

interface SessionState { runs: number; run?: { start: RunStart; messages: string[]; queuedSkills: number; turns: number }; pending?: RunStart; nextSkill: boolean }

/** Registers the probe on `pi`, writing JSONL to `file`. */
export function installProtocolProbe(pi: ExtensionAPI, file: string, now: () => Date = () => new Date()): void {
  const sessions = new Map<string, SessionState>();
  const idOf = (ctx: ExtensionContext) => { try { return ctx.sessionManager.getSessionId(); } catch { return "unknown"; } };
  const state = (ctx: ExtensionContext) => {
    const id = idOf(ctx);
    let found = sessions.get(id);
    if (!found) sessions.set(id, found = { runs: 0, nextSkill: false });
    return found;
  };
  let failed = false;
  const write = (record: ProbeRecord) => {
    try {
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${JSON.stringify(record)}\n`);
    } catch (error) {
      if (!failed) process.stderr.write(`protocol-probe: cannot write ${file}: ${error instanceof Error ? error.message : String(error)}\n`);
      failed = true;
    }
  };

  pi.on("session_start", (_event, ctx) => { if (ctx.hasUI) ctx.ui.notify(`protocol-probe: writing ${file}`, "info"); });
  pi.on("input", (event, ctx) => {
    const skill = event.text.startsWith("/skill:");
    const current = state(ctx);
    if (event.streamingBehavior !== undefined && current.run) { if (skill) current.run.queuedSkills += 1; }
    else current.nextSkill = skill;
    return { action: "continue" };
  });
  pi.on("before_agent_start", (_event, ctx) => {
    const current = state(ctx);
    current.pending = { by: "prompt", skill: current.nextSkill };
    current.nextSkill = false;
  });
  pi.on("agent_start", (_event, ctx) => {
    const current = state(ctx);
    current.runs += 1;
    current.run = { start: current.pending ?? { by: "message" }, messages: [], queuedSkills: 0, turns: 0 };
    current.pending = undefined;
  });
  pi.on("message_start", (event, ctx) => {
    const message = event.message as { role?: string; customType?: string };
    if (message.role === "custom" && message.customType) state(ctx).run?.messages.push(message.customType);
  });
  pi.on("before_provider_request", (event, ctx) => {
    const current = state(ctx);
    const run = current.run;
    if (!run) return undefined;
    run.turns += 1;
    const system = payloadSystemText(event.payload);
    let piPrompt = false;
    try { piPrompt = hasProtocol(ctx.getSystemPrompt()); } catch { piPrompt = false; }
    write({ v: PROBE_VERSION, at: now().toISOString(), session: idOf(ctx), orchestrator: isOrchestratorSession(ctx), run: current.runs,
      start: run.start, messages: [...run.messages], queuedSkills: run.queuedSkills, turn: run.turns, protocol: hasProtocol(system),
      piPrompt, projectRules: system.includes("## Project rules") });
    return undefined;
  });
}

/** The owner's verdict over a probe file's records: which acceptance cases were seen and whether each held. */
export function summarize(records: readonly ProbeRecord[]): { readonly lines: readonly string[]; readonly pass: boolean } {
  const orchestrator = records.filter((record) => record.orchestrator);
  const lines = orchestrator.map((record) => {
    const start = record.start.by === "prompt" ? (record.start.skill ? "skill prompt" : "prompt") : `message ${record.messages.join(", ") || "(none seen)"}`;
    return `run ${record.run} (${start}${record.queuedSkills > 0 ? `, ${record.queuedSkills} skill prompt(s) queued` : ""}) turn ${record.turn}: ` +
      `protocol ${record.protocol ? "yes" : "NO"} · pi's prompt ${record.piPrompt ? "yes" : "no"}${record.projectRules ? " · project rules forced" : ""}`;
  });
  const cases: readonly [string, (record: ProbeRecord) => boolean][] = [
    ["a typed skill prompt's run", (record) => record.start.by === "prompt" && record.start.skill],
    ["a run a completion notice started", (record) => record.start.by === "message" && record.messages.includes("subagents-completion")],
    ["a turn after a tool call in a run a message started", (record) => record.start.by === "message" && record.turn >= 2],
  ];
  let pass = orchestrator.length > 0;
  for (const [name, matches] of cases) {
    const seen = orchestrator.filter(matches);
    const held = seen.length > 0 && seen.every((record) => record.protocol);
    if (!held) pass = false;
    lines.push(`${seen.length === 0 ? "NOT SEEN" : held ? "PASS" : "FAIL"}: ${name} (${seen.length} request${seen.length === 1 ? "" : "s"})`);
  }
  const missing = orchestrator.filter((record) => !record.protocol).length;
  if (missing > 0) pass = false;
  lines.push(`${missing === 0 ? "PASS" : "FAIL"}: every orchestrator request has the protocol (${orchestrator.length - missing} of ${orchestrator.length})`);
  const workers = records.filter((record) => !record.orchestrator);
  const leaked = workers.filter((record) => record.protocol).length;
  if (leaked > 0) pass = false;
  lines.push(`${leaked === 0 ? "PASS" : "FAIL"}: no worker request has the protocol (${workers.length} worker request${workers.length === 1 ? "" : "s"} probed)`);
  lines.push(pass ? "RESULT: PASS" : "RESULT: FAIL");
  return { lines, pass };
}

export default function protocolProbe(pi: ExtensionAPI): void {
  installProtocolProbe(pi, probeFile());
}

// `node src/live-check/protocol-probe.ts <file>` prints the summary of a probe file.
if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const path = process.argv[2];
  if (!path) {
    process.stderr.write("usage: node src/live-check/protocol-probe.ts <probe file>\n");
    process.exit(2);
  }
  const records = readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0).map((line) => JSON.parse(line) as ProbeRecord);
  const { lines, pass } = summarize(records);
  process.stdout.write(`${lines.join("\n")}\n`);
  process.exit(pass ? 0 : 1);
}
