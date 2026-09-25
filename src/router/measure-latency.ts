// The router hook's added latency per routed `subagent` call, measured
// inside real pi sessions. A one-off measurement script, not a suite test.
//
//   node harness/router/measure-latency.ts --live [--calls 5] [--rung anthropic/claude-haiku-4-5:off]
//
// Since ADR 0004 the classifier runs inside the pi session through the
// session's model registry, so it can only be measured in a real session:
// this script cannot build a session registry of its own (pi's packages do
// not resolve from this project, and the Anthropic auth package's shaping is
// installed by pi when it loads the extension). Ticket 27's version called
// the hook in process with a `pi -p` classifier child, which no longer is the
// router's path.
//
// Per mode (shadow, then live) it runs ONE real `pi -p` session on
// anthropic/claude-haiku-4-5 with the router installed in a throwaway agent
// dir and PI_HARNESS_ROUTER_PROBE=1. The parent calls `subagent` `--calls`
// times on an agent that does not exist: the router's `tool_call` hook runs
// in full for each call (classify, route, record; pi runs every call's hook
// before any tool executes, pi-agent-core dist/agent-loop.js:364-440), and
// pi-subagents then refuses the unknown agent inside the tool's execution,
// so no child is started. It reads the probe's `hook <ms> ms` line per call
// and the in-session classifier's `first token` and `total` line, checks
// that every call wrote a decision record under its tool call id and came
// back as pi-subagents' unknown-agent error, and prints median and maximum
// per mode, with every `pi` launch and its tokens and pi's reported cost
// (a consumption signal on the subscription route, not a bill).
//
// Launches: one parent per mode; no children. Everything runs under a
// throwaway agent dir and state folder; the real agent dir is only read.

import { isDeepStrictEqual } from "node:util";
import type { PiEvent } from "../fixtures/live-pi-session.ts";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createGuardedAgentDir, credentialsAvailable, liveAuthExtensionPath, realAgentDirPath } from "../fixtures/guarded-agent-dir.ts";
import { installPiLaunchLog } from "../fixtures/pi-launch-log.ts";
import { piEvents, PROVIDER_REFUSAL } from "../fixtures/live-pi-session.ts";
import { createTempRepo } from "../fixtures/temp-repo.ts";
import { authorizeRecipient, emptyAuthorization, grantOwnerApproval, saveAuthorization } from "../recipients/authorization.ts";
import { readRoutingRecords } from "../routing/decision-record.ts";
import { installRouterEntry } from "../fixtures/extension-entry.ts";
import { ROUTER_PREFIX } from "./extension.ts";

const HAIKU = "anthropic/claude-haiku-4-5";
const DEFAULT_RUNG = `${HAIKU}:low`;
const RUNG_PATTERN = new RegExp(`^${HAIKU}:(off|minimal|low|medium|high)$`);
const MAX_CALLS = 10;
const ABSENT_AGENT = "router-latency-absent";
const TASK = "Add a retry option to the fetch helper in src/fetch.ts and cover it with a unit test.";

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function summary(label: string, values: readonly number[]): string {
  return values.length === 0 ? `${label}: none` : `${label}: median ${median(values).toFixed(1)} ms, max ${Math.max(...values).toFixed(1)} ms over ${values.length}`;
}

const HOOK_LINE = new RegExp(`^${ROUTER_PREFIX} hook (\\d+\\.\\d) ms for (\\d+) slot\\(s\\), mode (\\w+)$`);
const CLASSIFIER_LINE = new RegExp(`^${ROUTER_PREFIX} classifier \\S+ first token (?:(\\d+\\.\\d) ms|none), total (\\d+\\.\\d) ms, tokens (\\d+), reported cost (?:\\$(\\d+\\.\\d+)|none)$`);

interface ModeResult {
  readonly hookMs: number[];
  readonly firstTokenMs: number[];
  readonly classifierTotalMs: number[];
  readonly classifierTokens: number;
  readonly classifierUsd: number;
}

function measureMode(mode: "shadow" | "live", calls: number, authExtension: string, rung: string): ModeResult {
  const agent = createGuardedAgentDir({ withCredentials: true, installGuard: false });
  const repo = createTempRepo();
  const launches = installPiLaunchLog(agent.home);
  try {
    installRouterEntry(agent.dir);
    writeFileSync(join(agent.dir, "settings.json"), JSON.stringify({
      defaultProjectTrust: "ask",
      quietStartup: true,
      enableInstallTelemetry: false,
      harness: { routing: { enabled: true, mode, classifier: { model: rung, timeoutMs: 90_000, fallback: [] }, tiers: { mechanical: [rung], standard: [rung], elevated: [rung], critical: [rung] } } },
    }));
    const stateDir = join(agent.home, "state");
    const approval = grantOwnerApproval({ approvedBy: "router latency measurement", scope: "data-recipient", acknowledgement: "send the measurement task to anthropic" });
    saveAuthorization(join(stateDir, "authorized-recipients.json"), authorizeRecipient(emptyAuthorization(), "anthropic", approval));
    const tmp = join(agent.home, "tmp");
    mkdirSync(tmp);

    const call = { agent: ABSENT_AGENT, task: TASK, context: "fresh", async: false };
    const prompt =
      `Call the subagent tool exactly ${calls} times, one call per message, each time with exactly these arguments and no others:\n` +
      `${JSON.stringify(call)}\n` +
      "Every call returns an unknown-agent error. That is expected: do not change the arguments, do not stop early and do nothing else. " +
      `After the ${calls === 1 ? "result" : `${calls}th result`}, reply with the single word DONE.`;
    const subagents = join(realAgentDirPath(), "npm", "node_modules", "pi-subagents", "index.js");
    const run = spawnSync(
      "pi",
      ["-p", prompt, "--mode", "json", "-t", "subagent", "-e", authExtension, "-e", subagents, "--model", HAIKU, "--thinking", "off", "--no-session"],
      { cwd: repo.dir, env: agent.env({ ...launches.env, TMPDIR: tmp, PI_HARNESS_STATE_DIR: stateDir, PI_HARNESS_ROUTER_PROBE: "1" }), encoding: "utf8", timeout: 600_000, maxBuffer: 256 * 1024 * 1024 },
    );
    const stdout = run.stdout ?? "";
    const stderr = run.stderr ?? "";
    const lines = stderr.split("\n");

    const hookMs: number[] = [];
    for (const line of lines) {
      const match = HOOK_LINE.exec(line);
      if (match) hookMs.push(Number(match[1]));
    }
    const firstTokenMs: number[] = [];
    const classifierTotalMs: number[] = [];
    let classifierTokens = 0;
    let classifierUsd = 0;
    for (const line of lines) {
      if (line.startsWith(`${ROUTER_PREFIX} classifier `)) process.stdout.write(`${mode}: ${line}\n`);
      const match = CLASSIFIER_LINE.exec(line);
      if (!match) continue;
      if (match[1] !== undefined) firstTokenMs.push(Number(match[1]));
      classifierTotalMs.push(Number(match[2]));
      classifierTokens += Number(match[3]);
      classifierUsd += match[4] === undefined ? 0 : Number(match[4]);
    }

    const events = piEvents(stdout);
    const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
    const records = readRoutingRecords(join(stateDir, "routing"));
    const refusal = `${stdout}${stderr}`.match(PROVIDER_REFUSAL)?.[0];
    if (refusal) throw new Error(`${mode}: live provider refused: ${refusal}`);
    if (run.status !== 0) throw new Error(`${mode}: pi exited ${run.status}: ${stderr.slice(-1000)}`);
    validateLatencyRun({ calls, rung, mode, events, records, lines, launches: launches.read() });
    for (const [index, end] of ends.entries()) {
      const record = records.find((entry) => entry.attemptId === end.toolCallId);
      const text = (end.result?.content ?? []).map((block) => block.text ?? "").join(" ");
      const routed = record?.recordType === "decision" ? `decision ${record.classification.cause} -> ${record.route.outcome}` : `record ${record?.recordType ?? "missing"}`;
      process.stdout.write(`${mode} call ${index + 1}: ${end.toolCallId} ${routed}; hook ${hookMs[index]?.toFixed(1) ?? "?"} ms; tool error=${String(end.isError)}: ${text.slice(0, 80)}\n`);
    }
    for (const line of lines.filter((l) => l.startsWith("harness router disabled"))) process.stdout.write(`${mode}: ${line}\n`);
    for (const launch of launches.read()) {
      process.stdout.write(`${mode} launch ${launch.index + 1}: ${launch.kind} turns=${launch.assistantTurns} tokens=${launch.usage.totalTokens} reported cost $${launch.usage.costUsd.toFixed(5)}\n`);
    }
    process.stdout.write(`${mode}: in-session classifier tokens ${classifierTokens}, reported cost $${classifierUsd.toFixed(5)}\n`);
    process.stdout.write(`${mode}: ${summary("hook", hookMs)}; ${summary("classifier first token", firstTokenMs)}; ${summary("classifier total", classifierTotalMs)}\n`);

    return { hookMs, firstTokenMs, classifierTotalMs, classifierTokens, classifierUsd };
  } finally {
    launches.stopRunning();
    repo.cleanup();
    agent.cleanup();
  }
}

function main(): void {
  // Validate the rung without authorizing calls or inspecting credentials.
  const rungIndex = process.argv.indexOf("--rung");
  const rung = rungIndex === -1 ? DEFAULT_RUNG : String(process.argv[rungIndex + 1]);
  if (!RUNG_PATTERN.test(rung)) throw new Error(`--rung must be ${HAIKU} with an effort suffix (off, minimal, low, medium, high)`);
  if (!process.argv.includes("--live")) {
    process.stderr.write("usage: node harness/router/measure-latency.ts --live [--calls N] [--rung anthropic/claude-haiku-4-5:<effort>]   (one Haiku pi session per mode, N routed calls each, N <= 10)\n");
    process.exit(2);
  }
  const callsIndex = process.argv.indexOf("--calls");
  const calls = callsIndex === -1 ? 5 : Number(process.argv[callsIndex + 1]);
  if (!Number.isInteger(calls) || calls < 1 || calls > MAX_CALLS) throw new Error(`--calls must be an integer from 1 to ${MAX_CALLS}`);
  const authExtension = liveAuthExtensionPath();
  if (!credentialsAvailable() || authExtension === undefined) throw new Error("live credentials or the Anthropic auth package are unavailable");
  for (const mode of ["shadow", "live"] as const) measureMode(mode, calls, authExtension, rung);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

export interface LatencyEvidence {
  readonly calls: number;
  readonly rung: string;
  readonly mode: "shadow" | "live";
  readonly events: readonly PiEvent[];
  readonly records: readonly { attemptId: string; recordType: string; classification?: { cause: string } }[];
  readonly lines: readonly string[];
  readonly launches: readonly { kind: string }[];
}

/** Accept only complete evidence of the requested in-session measurement. */
export function validateLatencyRun(input: LatencyEvidence): void {
  const { calls, rung, mode, events, records, lines, launches } = input;
  const require = (valid: boolean, detail: string) => { if (!valid) throw new Error(`${mode}: ${detail}`); };
  const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === "subagent");
  require(ends.length === calls, "unexpected result count");
  require(new Set(ends.map((end) => end.toolCallId)).size === calls, "duplicate result IDs");
  require(records.length === calls, "unexpected record count");
  for (const end of ends) {
    require(typeof end.toolCallId === "string" && end.toolCallId.length > 0, "missing result ID");
    const matching = records.filter((record) => record.attemptId === end.toolCallId);
    require(matching.length === 1, "missing or duplicate matching record");
    require(matching[0]?.recordType === "decision", "not a decision record");
    require(matching[0]?.classification?.cause === `model:${rung}`, "wrong classifier cause");
    require(end.isError === true, "tool result must be an error");
    require(end.result?.content?.length === 1 && isAbsentAgentError(end.result.content[0]?.text), "unexpected tool error");
  }
  for (const event of events.filter((event) => event.toolName === "subagent" && event.args !== undefined)) {
    require(ends.some((end) => end.toolCallId === event.toolCallId), "arguments have no matching result");
    require(isDeepStrictEqual(event.args, { agent: ABSENT_AGENT, task: TASK, context: "fresh", async: false }), "unexpected tool arguments");
  }
  const probes = lines.filter((line) => line.startsWith(`${ROUTER_PREFIX} classifier `));
  require(probes.length === calls, "unexpected classifier probe count");
  for (const line of probes) {
    require(CLASSIFIER_LINE.test(line), "failed or malformed classifier probe");
    require(line.startsWith(`${ROUTER_PREFIX} classifier ${rung} first token `), "wrong classifier probe rung");
  }
  const hooks = lines.map((line) => HOOK_LINE.exec(line)).filter((match) => match !== null);
  require(hooks.length === calls && hooks.every((match) => match[2] === "1" && match[3] === mode), "unexpected hook evidence");
  require(launches.filter((launch) => launch.kind === "parent").length === 1, "expected exactly one parent launch");
  require(launches.every((launch) => launch.kind === "parent" || launch.kind === "list-models"), "unexpected classifier or other launch");
}

// Installed pi-subagents appends discovery diagnostics to the exact error line.
function isAbsentAgentError(text: string | undefined): boolean {
  if (text === undefined) return false;
  const [error, ...diagnostics] = text.split("\n");
  return error === `Unknown agent: ${ABSENT_AGENT}` && (diagnostics.length === 0 ||
    /^Effective cwd: [^\n]+\nConsulted agent-definition directories:\n(?:- [^\n]+\n)+Discovered agents:\n- [^\n]+(?:\n- [^\n]+)*$/.test(diagnostics.join("\n")));
}
