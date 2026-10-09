import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearFingerprintCache, fingerprintStats, RACY_MARGIN_MS, snapshotWorkingTree, workingTreeChanges } from "./working-tree.ts";

// Working-tree snapshots (pi-orchestrator-v2rc): read without blocking the
// event loop, and a file's hash reused only while its stat is unchanged and
// it last changed well before the snapshot that hashed it.

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "working-tree-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

/** A snapshot start far enough ahead that every file counts as settled. */
const settled = () => ({ startedMs: Date.now() + 10 * RACY_MARGIN_MS });

function counted<T>(run: () => Promise<T>): Promise<{ value: T; hashed: number; reused: number }> {
  const hashed = fingerprintStats.hashed, reused = fingerprintStats.reused;
  return run().then((value) => ({ value, hashed: fingerprintStats.hashed - hashed, reused: fingerprintStats.reused - reused }));
}

test("an unchanged settled file's hash is reused", async () => {
  const dir = repo();
  try {
    clearFingerprintCache();
    writeFileSync(join(dir, "a.txt"), "one");
    const first = await counted(() => snapshotWorkingTree(dir, settled()));
    const second = await counted(() => snapshotWorkingTree(dir, settled()));
    assert.equal(first.hashed, 1);
    assert.deepEqual([second.hashed, second.reused], [0, 1]);
    assert.equal(second.value!.paths.get("a.txt"), first.value!.paths.get("a.txt"));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a content change of the same size is rehashed, even with the old mtime put back", async () => {
  const dir = repo();
  try {
    clearFingerprintCache();
    const file = join(dir, "a.txt");
    writeFileSync(file, "one");
    const { mtime } = statSync(file);
    const before = (await snapshotWorkingTree(dir, settled()))!;
    writeFileSync(file, "two");
    utimesSync(file, mtime, mtime);
    const after = await counted(() => snapshotWorkingTree(dir, settled()));
    assert.deepEqual([after.hashed, after.reused], [1, 0]);
    assert.notEqual(after.value!.paths.get("a.txt"), before.paths.get("a.txt"));
    assert.deepEqual((await workingTreeChanges(before, after.value!, dir)).paths, ["a.txt"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a file changed within the racy margin of the snapshot is not cached", async () => {
  const dir = repo();
  try {
    clearFingerprintCache();
    writeFileSync(join(dir, "a.txt"), "one");
    const first = await counted(() => snapshotWorkingTree(dir));
    const second = await counted(() => snapshotWorkingTree(dir));
    assert.deepEqual([first.hashed, second.hashed, second.reused], [1, 1, 0]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a snapshot lets the event loop run while it reads the tree", async () => {
  const dir = repo();
  try {
    for (let i = 0; i < 20; i++) writeFileSync(join(dir, `f${i}.txt`), String(i));
    let ran = false;
    setImmediate(() => { ran = true; });
    const snapshot = snapshotWorkingTree(dir);
    assert.equal(ran, false);
    assert.equal((await snapshot)!.paths.size, 20);
    assert.equal(ran, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("outside a repository there is no snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "working-tree-"));
  try { assert.equal(await snapshotWorkingTree(dir), undefined); } finally { rmSync(dir, { recursive: true, force: true }); }
});
