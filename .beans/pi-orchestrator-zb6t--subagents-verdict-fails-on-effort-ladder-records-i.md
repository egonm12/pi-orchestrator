---
# pi-orchestrator-zb6t
title: subagents_verdict fails on effort-ladder records in the routing log
status: completed
type: bug
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:35:09Z
updated_at: 2026-09-28T14:55:16Z
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

## Review follow-up (changes requested on e0abfd7)

- [x] Fail closed: refuse a verdict when a skipped line belongs to the judged delegation or its reviewer, naming the file, the line and /reload
- [x] Name the skipped lines of other delegations in the verdict reply
- [x] Tests: an unreadable critical decision at gate level low, an unreadable latest edit, an unreadable reviewer decision, and the exact reported line
- [x] Correct this summary on the routing report and the commit gate

## Summary of changes

First commit (e0abfd7):

- src/routing/decision-record.ts: the folder walk is shared by two readers. readRoutingRecordEntries stays strict and throws at the first invalid line. readUsableRoutingRecordEntries and readUsableRoutingRecords return the valid records and skip each invalid line (bad JSON, an unknown record type, an unknown shape or a newer schema version), naming it by file and line.
- Kept strict on purpose: the routing report, which reads every record type and lists effort-ladder records separately in its ladders list (routing-report.ts:151), and the commit gate, whose catch denies a commit when it cannot read the folder (fail-closed, commit-gate.ts:135-139).
- Every record type the extension writes (decision, placed and unplaced effort-ladder, fork, agent-model, edit, gate-requirement, verdict, orphaned-verdict) validates in the current reader. There is no failover record type in the code.

Review follow-up (second commit):

- Skipping every invalid line was unsafe in the verdict path. Without a critical delegation's decision, delegationRouting finds no tier, the delegation is gated as elevated, and at gate level low it passes on a spot check with no reviewer. A skipped newer edit record lets a review started before that edit pass (reviewerProblem, review.ts).
- src/routing/decision-record.ts: readRoutingRecordsJudging(dir, ids) reads like the usable reader but fails closed. A skipped line that belongs to one of ids throws UnreadableDelegationRecordError, which names the file, the line and the field, and says /reload may be needed. A line belongs to a delegation when its delegationId or nestedDelegationId names it, or when its raw text contains the id. Skipped lines keep their raw text for this.
- src/subagents/verdict.ts: subagents_verdict reads through it for the judged delegation and, when one is named, its reviewer, and refuses the verdict with that message. The refusal also covers the read in attachVerdict. The reply names the skipped lines of other delegations briefly (up to three locations). The request_changes retry plan reads the same way and says why no retry can be planned instead of throwing.
- src/routing/verdicts.ts: attachVerdict reads through it for its delegation, so it records nothing when a line of that delegation cannot be read.
- Tests: decision-record.test.ts (ownership by delegationId, nestedDelegationId and raw text; other lines skipped), verdicts.test.ts (attachVerdict throws and records nothing), review.test.ts (a critical delegation at gate level low with an unreadable decision is refused with and without a reviewer; an unreadable latest edit; an unreadable reviewer decision), extension.test.ts (the exact 2026-09-28.jsonl:107 line beside the judged delegation's decision takes a verdict; the reply names other delegations' skipped lines).
- The real 2026-09-28.jsonl reads with the judging reader: nothing skipped, line 107 is an unplaced effort-ladder record, and the file's hash is unchanged.
- A pi session loaded before these commits still runs its old code in memory and needs /reload (or a restart) to get this fix.
