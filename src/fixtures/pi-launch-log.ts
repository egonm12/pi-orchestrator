import { spawnSync } from "node:child_process";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";

// A counting `pi` for live tests with a spend cap: a shim placed first on
// PATH inside a throwaway home that runs the real `pi` with the same
// arguments, passes stdin and stderr through, copies stdout to the caller and
// to a log file, and ends as the real pi ended: with its status, or by
// re-raising the signal that killed it, so a caller's `spawnSync` sees the
// signal. The real pi runs in its own process group; SIGTERM and SIGINT to
// the shim are forwarded to that whole group (pi and its subagent children).
// A SIGKILL on the shim (runAbortableProcess's escalation in
// ../routing/pi-classifier-call.ts, say) cannot be forwarded, so the real pi's pid
// and start time are logged and `stopRunning` kills every group whose launch
// has not exited and whose leader still has that pid and start time; a test
// calls it before removing its temp roots. The start time, not the args,
// identifies the process: pi sets `process.title = "pi"`, which on macOS
// overwrites its args, so the owner's own interactive pi looks the same.
// A pid whose start time was not recorded is never killed.
// The shim's `ps` call and `processStartTime` run the same command, by
// absolute path: the shim's PATH may hold no system directory.
const PS = "/bin/ps";
const PS_START_TIME_ARGS = ["-o", "lstart=", "-p"] as const;
// Every `pi` started through PATH is logged: the test's own parent
// sessions and `--list-models`, and any `pi -p` classifier child
// (`runAbortableProcess("pi", ...)` in ../routing/pi-classifier-call.ts),
// which the router no longer starts (ADR 0004): the live router tests assert
// there is none.
// pi-subagents starts its children with `process.execPath` and pi's CLI
// script (`getPiSpawnCommand`), not through PATH, so children are not logged
// here; a test counts them from the subagent results instead.

export interface PiLaunchUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  /** pi's reported cost, summed over the launch's assistant turns: a
   *  consumption signal on the subscription route, not a bill. */
  readonly costUsd: number;
}

export interface PiLaunch {
  readonly index: number;
  readonly args: readonly string[];
  readonly kind: "parent" | "classifier" | "list-models" | "other";
  readonly assistantTurns: number;
  readonly usage: PiLaunchUsage;
}

export interface StopRunningResult {
  /** Leader pids whose process group was sent SIGKILL. */
  readonly stopped: readonly number[];
  /** Launches without an exit marker that were left alone, and why:
   *  no start time was recorded, or the pid is gone or now belongs to
   *  another process (its start time differs). */
  readonly skipped: readonly { readonly pid: number; readonly reason: "start-time-unrecorded" | "not-the-logged-process" }[];
}

export interface PiLaunchLog {
  /** Prepend to PATH, with `PI_HARNESS_LAUNCH_LOG_DIR`, in a child's env. */
  readonly env: { readonly PATH: string; readonly PI_HARNESS_LAUNCH_LOG_DIR: string };
  read(): PiLaunch[];
  /** SIGKILL the process group of every logged real pi that has not exited
   *  (an orphan of a SIGKILLed shim) and is still the process the shim
   *  started: same pid, same recorded start time. */
  stopRunning(): StopRunningResult;
}

/** `ps`'s start time of a live pid, in the C locale, or undefined when `ps`
 *  finds no such process. */
export function processStartTime(pid: number): string | undefined {
  const run = spawnSync(PS, [...PS_START_TIME_ARGS, String(pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const started = (run.stdout ?? "").trim();
  return run.status === 0 && started !== "" ? started : undefined;
}

/** The `pi` a bare `pi` would start now, found on PATH. */
export function realPiPath(path: string = process.env.PATH ?? ""): string {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "pi");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* not here */
    }
  }
  throw new Error("pi is not on PATH");
}

function shimSource(realPi: string): string {
  return `#!${process.execPath}
"use strict";
const { spawn, spawnSync } = require("node:child_process");
const { mkdirSync, openSync, writeSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const dir = process.env.PI_HARNESS_LAUNCH_LOG_DIR;
mkdirSync(dir, { recursive: true });
const id = \`\${Date.now()}-\${process.pid}\`;
writeFileSync(join(dir, \`\${id}.args.json\`), JSON.stringify(process.argv.slice(2)));
const out = openSync(join(dir, \`\${id}.stdout\`), "a");
const child = spawn(${JSON.stringify(realPi)}, process.argv.slice(2), { stdio: ["inherit", "pipe", "inherit"], detached: true });
writeFileSync(join(dir, \`\${id}.pid\`), String(child.pid));
child.stdout.on("data", (chunk) => { writeSync(out, chunk); process.stdout.write(chunk); });
const forwarded = ["SIGTERM", "SIGINT"];
for (const signal of forwarded) process.on(signal, () => { try { process.kill(-child.pid, signal); } catch {} });
if (child.pid !== undefined) {
  const ps = spawnSync(${JSON.stringify(PS)}, [...${JSON.stringify(PS_START_TIME_ARGS)}, String(child.pid)], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" } });
  const started = (ps.stdout ?? "").trim();
  if (ps.status === 0 && started !== "") writeFileSync(join(dir, \`\${id}.start\`), started);
}
child.on("close", (code, signal) => {
  writeFileSync(join(dir, \`\${id}.exit\`), JSON.stringify({ code, signal }));
  if (signal === null) { process.exitCode = code ?? 0; return; }
  for (const name of forwarded) process.removeAllListeners(name);
  process.exitCode = 128 + (require("node:os").constants.signals[signal] ?? 0);
  process.stdout.write("", () => process.kill(process.pid, signal));
});
`;
}

/** Install the shim under `<home>/bin` and log under `<home>/pi-launches`. */
export function installPiLaunchLog(home: string, path: string = process.env.PATH ?? ""): PiLaunchLog {
  const bin = join(home, "bin");
  const logDir = join(home, "pi-launches");
  mkdirSync(bin, { recursive: true });
  mkdirSync(logDir, { recursive: true });
  const shim = join(bin, "pi");
  writeFileSync(shim, shimSource(realPiPath(path)));
  chmodSync(shim, 0o755);
  return {
    env: { PATH: `${bin}${delimiter}${path}`, PI_HARNESS_LAUNCH_LOG_DIR: logDir },
    read: () => readLaunches(logDir),
    stopRunning: () => stopRunningLaunches(logDir),
  };
}

function stopRunningLaunches(logDir: string): StopRunningResult {
  const stopped: number[] = [];
  const skipped: StopRunningResult["skipped"][number][] = [];
  for (const name of readdirSync(logDir).filter((entry) => entry.endsWith(".pid"))) {
    const id = name.slice(0, -".pid".length);
    if (existsSync(join(logDir, `${id}.exit`))) continue;
    const pid = Number(readFileSync(join(logDir, name), "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const startFile = join(logDir, `${id}.start`);
    if (!existsSync(startFile)) {
      skipped.push({ pid, reason: "start-time-unrecorded" });
      continue;
    }
    if (processStartTime(pid) !== readFileSync(startFile, "utf8")) {
      skipped.push({ pid, reason: "not-the-logged-process" });
      continue;
    }
    try {
      process.kill(-pid, "SIGKILL");
      stopped.push(pid);
    } catch {
      /* the group is already gone */
    }
  }
  return { stopped, skipped };
}

function launchKind(args: readonly string[]): PiLaunch["kind"] {
  if (args.includes("--list-models")) return "list-models";
  if (args.includes("--system-prompt") && args.includes("--no-extensions")) return "classifier";
  if (args.includes("-p")) return "parent";
  return "other";
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Sum of pi's `usage` over the assistant `message_end` events of one
 *  `--mode json` stdout. */
export function usageFromPiJson(stdout: string): { assistantTurns: number; usage: PiLaunchUsage } {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, costUsd: 0 };
  let assistantTurns = 0;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    let event: { type?: string; message?: { role?: string; usage?: Record<string, unknown> } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (event.type !== "message_end" || event.message?.role !== "assistant") continue;
    assistantTurns += 1;
    const reported = event.message.usage ?? {};
    usage.input += number(reported.input);
    usage.output += number(reported.output);
    usage.cacheRead += number(reported.cacheRead);
    usage.cacheWrite += number(reported.cacheWrite);
    usage.totalTokens += number(reported.totalTokens);
    const cost = reported.cost as { total?: unknown } | undefined;
    usage.costUsd += number(cost?.total);
  }
  return { assistantTurns, usage };
}

function readLaunches(logDir: string): PiLaunch[] {
  const ids = readdirSync(logDir).filter((name) => name.endsWith(".args.json")).map((name) => name.slice(0, -".args.json".length)).sort();
  return ids.map((id, index) => {
    const args = JSON.parse(readFileSync(join(logDir, `${id}.args.json`), "utf8")) as string[];
    let stdout = "";
    try {
      stdout = readFileSync(join(logDir, `${id}.stdout`), "utf8");
    } catch {
      /* a launch that wrote nothing */
    }
    return { index, args, kind: launchKind(args), ...usageFromPiJson(stdout) };
  });
}
