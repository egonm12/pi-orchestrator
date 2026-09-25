---
# pi-orchestrator-j27y
title: Decision records name the model the worker ran on
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T18:55:30Z
parent: pi-orchestrator-6nhd
---

## Parent

pi-orchestrator-6nhd

## What to build

Decision records move to `decision-record/3` with a `ranOn` field: the model the worker actually ran on (the rung in live mode, the orchestrator's model in shadow mode and on a refusal). The current router fills it in. The owner's existing `decision-record/2` records, including explicit and verdict records, stay readable.

## Acceptance criteria

- [x] New decision records are written as `decision-record/3` with `ranOn`
- [x] In shadow mode `ranOn` equals the orchestrator's model; in live mode it equals the chosen rung; on a refusal it names the model the call ran on
- [x] A folder with `/2` and `/3` records reads without errors, and the validator still rejects unknown fields
- [x] The offline suite and the typecheck pass

## Blocked by

None, can start immediately.

## Summary of Changes

- Decision records are written as `decision-record/3` with a required `ranOn` field: the chosen rung in live mode, the hand-picked model in shadow mode, and the model the unchanged call runs on after a refusal.
- Verdict, orphaned-verdict and effort-ladder records are also written as `/3`. Explicit records stay `/2` until itu1 removes their writer. The validator reads `/2` and `/3` side by side and still rejects unknown fields; `ranOn` is only allowed on `/3` decision records.
- A live refusal without a session model now fails with a live-refusal message instead of a shadow mode one.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): OK with notes, all notes fixed. Note: `ranOn` carries the effort suffix in live mode but not in shadow mode; bjyw revisits the orchestrator's model format.
