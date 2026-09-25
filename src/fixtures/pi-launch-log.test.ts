import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { installPiLaunchLog, processStartTime } from "./pi-launch-log.ts";

// The counting `pi` shim against a fake `pi` script, never the real one. The
// fake starts one grandchild (as a parent pi starts subagent children) and
// writes both pids to FAKE_PI_PIDS, then either kills itself with SIGTERM
// (FAKE_PI_MODE=signal) or waits forever (FAKE_PI_MODE=hang). With
// FAKE_PI_TITLE=pi it first sets its process title as the real pi does,
// which on macOS replaces its args with "pi".
const FAKE_PI = `#!${process.execPath}
"use strict";
if (process.env.FAKE_PI_TITLE) process.title = process.env.FAKE_PI_TITLE;
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(process.env.FAKE_PI_PIDS, JSON.stringify([process.pid, grandchild.pid]));
process.stdout.write("fake pi started\\n");
if (process.env.FAKE_PI_MODE === "signal") {
  grandchild.kill("SIGKILL");
  process.kill(process.pid, "SIGTERM");
} else {
  setInterval(() => {}, 1000);
}
`;

interface FakePiSetup {
  readonly root: string;
  readonly shim: string;
  readonly pidsFile: string;
  readonly launches: ReturnType<typeof installPiLaunchLog>;
  env(mode: "signal" | "hang", title?: string): NodeJS.ProcessEnv;
}

function setUpFakePi(): FakePiSetup {
  const root = mkdtempSync(join(tmpdir(), "pi-harness-launch-log-"));
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, "pi"), FAKE_PI);
  chmodSync(join(fakeBin, "pi"), 0o755);
  const launches = installPiLaunchLog(join(root, "home"), fakeBin);
  const pidsFile = join(root, "pids.json");
  return {
    root,
    shim: join(root, "home", "bin", "pi"),
    pidsFile,
    launches,
    env: (mode, title) => ({ ...process.env, ...launches.env, FAKE_PI_MODE: mode, FAKE_PI_PIDS: pidsFile, ...(title ? { FAKE_PI_TITLE: title } : {}) }),
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(condition: () => boolean, ms: number): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return condition();
}

function fakePids(setup: FakePiSetup): number[] {
  return JSON.parse(readFileSync(setup.pidsFile, "utf8")) as number[];
}

/** SIGKILL whatever a failed assertion left running, then remove the root. */
function tearDown(setup: FakePiSetup): void {
  if (existsSync(setup.pidsFile)) {
    for (const pid of fakePids(setup)) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  rmSync(setup.root, { recursive: true, force: true });
}

test("pi launch log: when the real pi dies by a signal, the shim dies by the same signal, so the caller sees it", () => {
  const setup = setUpFakePi();
  try {
    const run = spawnSync(setup.shim, ["-p", "hello"], { env: setup.env("signal"), encoding: "utf8", timeout: 30_000 });
    assert.equal(run.error, undefined);
    assert.equal(run.signal, "SIGTERM", `status ${run.status}, stderr ${run.stderr}`);
    assert.equal(run.status, null);
    assert.equal(run.stdout, "fake pi started\n");
    assert.equal(setup.launches.read().length, 1);
  } finally {
    tearDown(setup);
  }
});

test("pi launch log: a SIGTERM to the shim (a spawnSync timeout) reaches the real pi's whole process group, and the caller sees SIGTERM", async () => {
  const setup = setUpFakePi();
  try {
    const run = spawnSync(setup.shim, ["-p", "hello"], { env: setup.env("hang"), encoding: "utf8", timeout: 3_000 });
    assert.equal(run.signal, "SIGTERM", `status ${run.status}, stderr ${run.stderr}`);
    const pids = fakePids(setup);
    assert.equal(pids.length, 2);
    assert.ok(await waitFor(() => pids.every((pid) => !alive(pid)), 5_000), `still alive: ${pids.filter(alive)}`);
  } finally {
    tearDown(setup);
  }
});

function argsOf(pid: number): string {
  return (spawnSync("ps", ["-o", "args=", "-p", String(pid)], { encoding: "utf8" }).stdout ?? "").trim();
}

test("pi launch log: after a SIGKILL on the shim (the classifier's escalation), stopRunning kills the orphaned real pi and its children, though its args read only \"pi\"", async () => {
  const setup = setUpFakePi();
  try {
    const shim = spawn(setup.shim, ["-p", "hello"], { env: setup.env("hang", "pi"), stdio: "ignore" });
    const exited = new Promise((resolve) => shim.on("exit", resolve));
    assert.ok(await waitFor(() => existsSync(setup.pidsFile), 10_000), "the fake pi never started");
    // The shim records the start time just after the spawn; a SIGKILL before
    // that would leave a launch stopRunning refuses to touch.
    const logDir = setup.launches.env.PI_HARNESS_LAUNCH_LOG_DIR;
    assert.ok(await waitFor(() => readdirSync(logDir).some((name) => name.endsWith(".start")), 10_000), "the shim never recorded a start time");
    const pids = fakePids(setup);
    shim.kill("SIGKILL");
    await exited;
    // SIGKILL cannot be forwarded: the real pi outlives the shim.
    assert.ok(pids.every(alive), "the fake pi died with the shim; the orphan case is not exercised");
    assert.equal(argsOf(pids[0]!), "pi", "the fake pi's title did not replace its args; the title case is not exercised");
    const result = setup.launches.stopRunning();
    assert.deepEqual(result, { stopped: [pids[0]], skipped: [] });
    assert.ok(await waitFor(() => pids.every((pid) => !alive(pid)), 5_000), `still alive after stopRunning: ${pids.filter(alive)}`);
  } finally {
    tearDown(setup);
  }
});

/** A detached process that sleeps until killed: a group leader, as the real
 *  pi is and as a process that reused its pid might be. */
function startSleeper(): number {
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
  sleeper.unref();
  assert.ok(sleeper.pid !== undefined, "the sleeper did not start");
  return sleeper.pid;
}

/** Log a launch by hand: `<id>.pid`, and optionally `<id>.start` and an
 *  `<id>.exit` marker, as the shim writes them. */
function logLaunch(setup: FakePiSetup, id: string, pid: number, extra: { start?: string; exited?: boolean }): void {
  const dir = setup.launches.env.PI_HARNESS_LAUNCH_LOG_DIR;
  writeFileSync(join(dir, `${id}.pid`), String(pid));
  if (extra.start !== undefined) writeFileSync(join(dir, `${id}.start`), extra.start);
  if (extra.exited) writeFileSync(join(dir, `${id}.exit`), JSON.stringify({ code: 0, signal: null }));
}

// Each guard below is proven alone: the sleeper passes every other guard, so
// removing the guard under test makes stopRunning kill it.

test("pi launch log: stopRunning leaves a launch that already exited alone, even when its pid is live with the recorded start time", () => {
  const setup = setUpFakePi();
  const sleeper = startSleeper();
  try {
    const start = processStartTime(sleeper);
    assert.ok(start, "no start time for the sleeper");
    logLaunch(setup, "1-exited", sleeper, { start, exited: true });
    assert.deepEqual(setup.launches.stopRunning(), { stopped: [], skipped: [] });
    assert.ok(alive(sleeper), "stopRunning killed a process whose launch had exited");
  } finally {
    try { process.kill(sleeper, "SIGKILL"); } catch { /* already gone */ }
    tearDown(setup);
  }
});

test("pi launch log: stopRunning leaves a reused pid alone: a live group leader whose start time is not the recorded one", () => {
  const setup = setUpFakePi();
  const sleeper = startSleeper();
  try {
    logLaunch(setup, "1-reused", sleeper, { start: "Thu Jan  1 00:00:00 1970" });
    assert.deepEqual(setup.launches.stopRunning(), { stopped: [], skipped: [{ pid: sleeper, reason: "not-the-logged-process" }] });
    assert.ok(alive(sleeper), "stopRunning killed a process that only reused the logged pid");
  } finally {
    try { process.kill(sleeper, "SIGKILL"); } catch { /* already gone */ }
    tearDown(setup);
  }
});

test("pi launch log: stopRunning leaves a launch without a recorded start time alone", () => {
  const setup = setUpFakePi();
  const sleeper = startSleeper();
  try {
    logLaunch(setup, "1-unrecorded", sleeper, {});
    assert.deepEqual(setup.launches.stopRunning(), { stopped: [], skipped: [{ pid: sleeper, reason: "start-time-unrecorded" }] });
    assert.ok(alive(sleeper), "stopRunning killed a process with no recorded start time");
  } finally {
    try { process.kill(sleeper, "SIGKILL"); } catch { /* already gone */ }
    tearDown(setup);
  }
});
