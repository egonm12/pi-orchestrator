---
# pi-orchestrator-kqli
title: A resumed worker keeps its rung
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T19:38:24Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-ihm0
---

## Parent

pi-orchestrator-6nhd

## What to build

When a request arrives with a session id that has no pin in this process, the router extension first looks for the latest decision record with that delegation id. If its rung still passes the hard filters, the worker is pinned to it without a new classification or a new record. Otherwise the request is classified as a first request.

## Acceptance criteria

- [x] A session id with an earlier record is pinned to that record's rung with no classifier call
- [x] A rung that no longer passes the hard filters leads to a normal classification and a new record
- [x] A session id with no record is classified as before

## Blocked by

- pi-orchestrator-ihm0

## Summary of Changes

- In live mode, a request whose session id has no pin in this process first looks up the latest decision record with that delegation id (`latestDecision` in `src/router/auto-provider.ts`). It reuses the record's rung, with no classifier call and no new record, when the record is a live chosen decision whose `ranOn` is missing (`/2`) or equals the rung, and the rung still passes the hard filters. The filters are the same `failedHardFilter` checks `routeTier` applies, on evidence from the shared `hardFilterEvidence` (`src/router/route-task.ts`).
- Shadow, refused and fallback records, and a record whose rung now fails a filter, lead to a normal classification and a new record. A damaged records folder (`RoutingRecordError`) counts as no record.
- The `ranOn` check compares against the canonical `model:effort`, so a rung written in settings with different case is still reused.
- Seam-1 tests: reuse without classifying, a `/2` record, the latest of two, a failed filter, a shadow record, a mode change, a damaged day file, a mixed-case rung.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): OK with notes, fixed; re-check OK with notes (case comparison), fixed by the parent.
- Known cost: the first request of each worker reads the whole records folder.
