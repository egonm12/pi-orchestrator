---
# pi-orchestrator-v2rc
title: Non-blocking, stat-cached working-tree snapshots
status: completed
type: task
priority: normal
created_at: 2026-10-09T16:00:31Z
updated_at: 2026-10-09T16:04:33Z
---

Make snapshotWorkingTree async (no execFileSync) and reuse fingerprints when size/mtime/ctime/inode match, rehashing recently touched files (racy timestamps). src/subagents/working-tree.ts, editing.ts:123,162.

## Todo

- [x] Async snapshotWorkingTree and workingTreeChanges (execFile, fs/promises, bounded read concurrency)
- [x] trackEdits and finish() async; worker.ts awaits both
- [x] Fingerprint cache keyed by absolute path (size, mtimeNs, ctimeNs, ino, dev), racy margin 2 s, LRU bound 50,000
- [x] Tests: reuse, same-size change, racy file, event loop runs, no repo
- [x] npm run typecheck and npm test pass

## Summary of changes

- `src/subagents/working-tree.ts`: `snapshotWorkingTree` is async: git runs through `execFile`, files are read with `fs/promises`, 16 at a time. Semantics kept: `undefined` without a repo or when status fails, `--no-optional-locks`, the same fingerprint kinds (gone, link, other, large, file, unreadable). A regular file's SHA-1 is cached on the process global by absolute path with its bigint stat (size, mtimeNs, ctimeNs, ino, dev); reused only when every field matches. A hash is cached only when the file's later of mtime and ctime is more than 2 s before the snapshot started (git's racy-timestamp rule); otherwise the next snapshot rehashes. The cache keeps at most 50,000 entries, least recently used dropped first. `workingTreeChanges` is async too (its git diff).
- `src/subagents/editing.ts`: `trackEdits` returns a promise and `finish()` returns `Promise<boolean>`, memoised so a second call gives the same answer.
- `src/subagents/worker.ts`: awaits `trackEdits` and `finish()`.
- `src/subagents/working-tree.test.ts`: new tests.
- Timing, 3,215 untracked 4 KB files: old sync snapshot 120 to 159 ms with the event loop blocked for all of it; new cold 133 ms, warm 51 to 58 ms, longest event-loop stall 2 to 3 ms.
