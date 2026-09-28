import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readUsageObservations, recordUsageObservation, usageObservationsPath, type UsageObservation } from "./usage-observations.ts";

// The usage store seam: recordUsageObservation and readUsageObservations over
// a temporary state folder. Other writers are simulated by the files they
// leave next to the store: a lock file names its writer's pid and a token,
// and a writer's temporary file names its pid.

const EXHAUSTED: UsageObservation = { state: "exhausted", resetsAt: "2026-09-26T12:42:00.000Z", observedAt: "2026-09-26T12:00:00.000Z", source: "error" };

function stateFolder(): { dir: string; path: string; cleanup(): void } {
  const dir = mkdtempSync(join(tmpdir(), "pi-usage-store-"));
  return { dir, path: usageObservationsPath(dir), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** The lock file a writer with `pid` leaves while it holds the store, `ageMs` old. */
function lockHeldBy(path: string, pid: number, ageMs = 0): string {
  const content = `${pid} ${randomUUID()}\n`;
  writeFileSync(`${path}.lock`, content);
  const at = new Date(Date.now() - ageMs);
  utimesSync(`${path}.lock`, at, at);
  return content;
}

test("a write waits for a lock a live writer holds without blocking the event loop, and leaves that lock alone", async () => {
  const store = stateFolder();
  try {
    // Held for 3 s: a slow live writer, not one that died.
    const held = lockHeldBy(store.path, process.pid, 3_000);
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 5);
    try {
      const write = recordUsageObservation(store.path, "openai-codex", EXHAUSTED);
      await delay(100);
      assert.ok(ticks >= 5, `timers ran while the write waited (${ticks} ticks)`);
      assert.equal(readFileSync(`${store.path}.lock`, "utf8"), held, "the live writer's lock is not broken");
      assert.equal(existsSync(store.path), false, "nothing is written while the lock is held");
      assert.deepEqual(readUsageObservations(store.path), { "openai-codex": EXHAUSTED }, "this process already reads the waiting write");
      rmSync(`${store.path}.lock`);
      await write;
    } finally { clearInterval(timer); }
    assert.deepEqual(readUsageObservations(store.path), { "openai-codex": EXHAUSTED });
    assert.equal(existsSync(`${store.path}.lock`), false);
  } finally { store.cleanup(); }
});

/** The pid of a process that has exited. */
function deadPid(): number {
  const child = spawnSync(process.execPath, ["-e", ""]);
  assert.equal(child.status, 0);
  return child.pid;
}

test("a lock left by a writer that died is broken at once", async () => {
  const store = stateFolder();
  try {
    lockHeldBy(store.path, deadPid());
    const started = performance.now();
    await recordUsageObservation(store.path, "openai-codex", EXHAUSTED);
    assert.ok(performance.now() - started < 500, "no wait for the dead writer's lock to age");
    assert.deepEqual(readUsageObservations(store.path), { "openai-codex": EXHAUSTED });
    assert.equal(existsSync(`${store.path}.lock`), false);
  } finally { store.cleanup(); }
});

test("a lock older than any write takes is broken even when its pid runs", async () => {
  const store = stateFolder();
  try {
    lockHeldBy(store.path, process.pid, 60_000);
    await recordUsageObservation(store.path, "openai-codex", EXHAUSTED);
    assert.deepEqual(readUsageObservations(store.path), { "openai-codex": EXHAUSTED });
    assert.equal(existsSync(`${store.path}.lock`), false);
  } finally { store.cleanup(); }
});

/** The temporary file a writer with `pid` writes before renaming it over the store, `ageMs` old. */
function temporaryOf(path: string, pid: number, ageMs = 0): string {
  const temporary = `${path}.${pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, "{\"schemaVersion\":\"usage-observations/1\",\"pro");
  const at = new Date(Date.now() - ageMs);
  utimesSync(temporary, at, at);
  return temporary;
}

test("a write removes the temporary files of writers that died or hung, and keeps a running writer's", async () => {
  const store = stateFolder();
  try {
    const crashed = temporaryOf(store.path, deadPid());
    const hung = temporaryOf(store.path, process.pid, 60_000);
    const active = temporaryOf(store.path, process.pid);
    const unrelated = join(store.dir, "notes.tmp");
    writeFileSync(unrelated, "not the store's\n");
    await recordUsageObservation(store.path, "openai-codex", EXHAUSTED);
    assert.deepEqual([existsSync(crashed), existsSync(hung), existsSync(active), existsSync(unrelated)], [false, false, true, true]);
    assert.deepEqual(readdirSync(store.dir).sort(), [active.slice(store.dir.length + 1), "notes.tmp", "usage-observations.json"].sort());
  } finally { store.cleanup(); }
});

const STORE_MODULE = new URL("./usage-observations.ts", import.meta.url).href;

/** Runs `count` writer processes that start together at a lock a dead writer
 *  left, each recording its own provider. Resolves with their exit codes. */
async function racingWriters(path: string, count: number): Promise<(number | null)[]> {
  const { spawn } = await import("node:child_process");
  const startAt = Date.now() + 700;
  const script = `import { recordUsageObservation } from ${JSON.stringify(STORE_MODULE)};
    while (Date.now() < ${startAt}) {}
    await recordUsageObservation(process.argv[1], process.argv[2], ${JSON.stringify(EXHAUSTED)});`;
  return Promise.all(Array.from({ length: count }, (_, index) => new Promise<number | null>((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script, path, `provider-${index}`], { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  })));
}

test("writer processes racing to break a dead writer's lock keep every provider and leave no lock or temporary file", async () => {
  for (let round = 0; round < 3; round += 1) {
    const store = stateFolder();
    try {
      lockHeldBy(store.path, deadPid());
      assert.deepEqual(await racingWriters(store.path, 8), Array(8).fill(0));
      assert.deepEqual(Object.keys(readUsageObservations(store.path)).sort(), Array.from({ length: 8 }, (_, index) => `provider-${index}`).sort(),
        `round ${round}: no write was lost`);
      assert.deepEqual(readdirSync(store.dir), ["usage-observations.json"], `round ${round}: nothing is left next to the store`);
    } finally { store.cleanup(); }
  }
});

test("an observation the store cannot save fails the write, this process still reads it, and the next write that succeeds saves it", async () => {
  const store = stateFolder();
  try {
    // A folder where the store file should be: every write fails.
    mkdirSync(join(store.path, "in-the-way"), { recursive: true });
    await assert.rejects(recordUsageObservation(store.path, "openai-codex", EXHAUSTED));
    assert.deepEqual(readUsageObservations(store.path), { "openai-codex": EXHAUSTED });

    rmSync(store.path, { recursive: true });
    const available: UsageObservation = { state: "available", observedAt: "2026-09-26T13:00:00.000Z", source: "header" };
    await recordUsageObservation(store.path, "anthropic", available);
    const saved = JSON.parse(readFileSync(store.path, "utf8")) as { providers: unknown };
    assert.deepEqual(saved.providers, { "openai-codex": EXHAUSTED, anthropic: available }, "other processes see it from now on");
    rmSync(store.path);
    assert.deepEqual(readUsageObservations(store.path), {}, "a saved observation is read from the store only");
  } finally { store.cleanup(); }
});
