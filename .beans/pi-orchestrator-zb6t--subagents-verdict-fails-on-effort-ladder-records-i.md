---
# pi-orchestrator-zb6t
title: subagents_verdict fails on effort-ladder records in the routing log
status: completed
type: bug
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:35:09Z
updated_at: 2026-09-28T14:38:37Z
---

## Error

subagents_verdict fails every time with: routing record 2026-09-28.jsonl:107: field 'kindOfWork' is missing.

Line 107 of ~/.pi/agent/pi-orchestrator/routing/2026-09-28.jsonl is a valid unplaced effort-ladder record (step unplaced, mode live, a detail, no kindOfWork, tierMap, route or skipped).

## Cause

Two parts:

1. Version skew. Unplaced effort-ladder records, their writer (buildUnplacedLadderRecord) and their validation branch arrived together in 5183d43. The validator before it (validateRoutingRecord in src/routing/decision-record.ts) required kindOfWork, tierMap, route and skipped on every effort-ladder record. A pi session loaded before 5183d43 still runs that validator, while newer processes write unplaced records into the shared log. The old reader reproduces the exact error on the real log; the current reader accepts it.
2. All-or-nothing reading. readRoutingRecordEntries throws on the first invalid line, and subagents_verdict (src/subagents/verdict.ts) and attachVerdict (src/routing/verdicts.ts) read the whole folder through it. So one foreign, corrupt or newer-shaped line blocks every verdict.

## Fix plan

- [x] Failing test: a routing log with an effort-ladder record (and a line the reader cannot validate), then record a verdict
- [x] Add a reader that skips invalid lines and names them, next to the strict one
- [x] Use it in the verdict path (subagents_verdict and attachVerdict); keep the routing report and the fail-closed commit gate strict
- [x] Check that every record type the extension writes validates in the current reader
- [x] Typecheck, affected tests, full suite
- [x] Load the real 2026-09-28.jsonl with the fixed reader without editing it

## Summary of changes

- src/routing/decision-record.ts: the folder walk is shared by two readers. readRoutingRecordEntries stays strict and throws at the first invalid line, for the routing report. The new readUsableRoutingRecordEntries and readUsableRoutingRecords return the valid records and skip each invalid line (bad JSON, an unknown record type, an unknown shape or a newer schema version), naming it by file and line.
- src/subagents/verdict.ts and src/routing/verdicts.ts: subagents_verdict (both of its reads) and attachVerdict now use the usable reader, so one foreign or torn line no longer blocks every verdict.
- Kept strict on purpose: the routing report (a bad record is named, not counted around) and the commit gate, which denies a commit when it cannot read the folder (fail-closed, commit-gate.ts).
- Every record type the extension writes (decision, placed and unplaced effort-ladder, fork, agent-model, edit, gate-requirement, verdict, orphaned-verdict) validates in the current reader. There is no failover record type in the code.
- Tests: one each in decision-record.test.ts, verdicts.test.ts and extension.test.ts.
- The real 2026-09-28.jsonl reads with both readers: 142 entries, none skipped, line 107 is an unplaced effort-ladder record. The file was not changed.
- A pi session loaded before 5183d43 still runs the old validator in memory and needs /reload (or a restart) to get this fix.
