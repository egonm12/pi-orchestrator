---
# pi-orchestrator-bjyw
title: Workers fall back to the orchestrator's model
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T19:31:19Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-ihm0
---

## Parent

pi-orchestrator-6nhd

## What to build

The router extension keeps the orchestrator's model in `PI_ORCHESTRATOR_SESSION_MODEL`, set at session start and on every model change, never to `orchestrator/auto`. A worker runs on that model when the tier router refuses (every rung removed in every tier), in shadow mode (the record keeps the rung the router would have chosen), when routing is not enabled (no record), and on an internal failure of the router extension (one `pi-orchestrator router disabled:` line per process). When the variable is missing or its model is on the subagent ban list, the request fails with an error naming the reason.

## Acceptance criteria

- [x] The variable is set at session start and updated on `model_select`, and is not set to `orchestrator/auto`
- [x] A refusal, shadow mode, routing not enabled and an internal failure each forward to the orchestrator's model, shown at seam 1
- [x] Shadow and refusal records have `ranOn` equal to the orchestrator's model; routing not enabled writes no record
- [x] A missing variable and a banned orchestrator's model each end the stream with an error naming the reason, and nothing is forwarded
- [x] An internal failure prints one disabled line, once per process

## Blocked by

- pi-orchestrator-ihm0

## Summary of Changes

- The router extension in a main session sets `PI_ORCHESTRATOR_SESSION_MODEL` to `provider/id:effort` at session start, on `model_select` and on `thinking_level_select`. It never sets it to `orchestrator/auto` and skips worker processes (`PI_SUBAGENT_CHILD`, `PI_SUBAGENTS_HERDR_BRIDGE`).
- The auto provider forwards to that model, with its effort and the same relabelling and auth dropping as a rung, when the tier router refuses (live record with `ranOn` = the orchestrator's model), in shadow mode (record keeps the rung the router would have chosen; `handPickedModel` = the model without suffix, `ranOn` = with effort), when routing is not enabled (no record), and on an internal failure.
- A missing variable, or an orchestrator's model on the subagent ban list, ends the stream with an error naming the reason; nothing is forwarded and no record is written.
- Every disable path (session start, `tool_call`, provider) prints one `pi-orchestrator router disabled:` line per process. The flag lives on `globalThis` under a `Symbol.for` key because pi loads each extension with a fresh module copy (jiti `moduleCache: false`).
- Seam-1 tests cover every case, including three module copies in one process printing one line.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): BLOCK (shadow `handPickedModel` suffix), fixed; re-check OK with notes; the module-copy note fixed by the parent.
- Residual risk: a foreground in-process worker session that starts on an explicit model without a child marker could overwrite the variable; c28l's live tests exercise the real process layout.
