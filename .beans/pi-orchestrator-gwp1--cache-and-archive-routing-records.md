---
# pi-orchestrator-gwp1
title: Cache and archive routing records
status: in-progress
type: task
created_at: 2026-10-09T16:00:31Z
updated_at: 2026-10-09T16:00:31Z
---

Cache parsed routing record files by stat and archive day files older than 30 days (src/routing/decision-record.ts:1173,1286); routing report must still read archives.

## Todo

- [x] Per-file parse cache keyed by path, size, mtimeMs and ino; appended tail parsed alone
- [x] Tests for the cache
- [x] Decide on archiving: not done, see below (follow-up needed)
- [ ] Archive old day files once lookups by delegation id no longer need unbounded history

## Summary of changes

- `src/routing/decision-record.ts`: `RecordFolderReader` gains an optional `stat`; `NODE_RECORD_FOLDER_READER` provides it via `statSync`. A module-level cache (`parsedRecordFiles`) keeps each day file's parsed lines. An unchanged stat reuses them without reading; a file that grew and still starts with the cached text (which ended in a newline, same ino) parses only the appended tail, with file line numbers kept; anything else reparses. Cached records and entries are deep-frozen since all readers share them. A reader without `stat` (test readers) parses every time, as before.
- `src/routing/decision-record.test.ts`: one test covering reuse, tail append with a skipped line, the strict reader still naming the cached bad line, a rewrite, and a reader without stat.
- Measured on the real folder (1,848 records): first read 166 ms cold, then 0.2 to 0.4 ms per read.

## Why archiving was not done

Readers that look up a delegation by id have no time window: `savedPin` in `src/subagents/resume.ts` (agent-model and fork pins on resume), retry and review targets in `src/subagents/extension.ts` (`retrySetup`, `reviewTarget`, `delegationRouting`), `quality-gate.ts`, the verdict tool (`readRoutingRecordsJudging`, fail closed) and the commit gate (`waitingForVerdict`, an outstanding gate requirement of a session). Moving a day file away after 30 days would silently change those: a resumed agent-model worker would lose its named model, and an old unjudged gate requirement would stop blocking (fails open). Only the 5 h balancing window in `src/router/route-task.ts` is bounded. With the cache, a full read is already cheap, so archiving now buys little against that risk. A follow-up would need those lookups to fall back to `archive/` on a miss (or an index by delegation id) before old files move.
