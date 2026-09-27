---
# pi-orchestrator-1175
title: Activity by phase, held for at least 1.5 s
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T14:25:50Z
updated_at: 2026-09-27T14:59:53Z
parent: pi-orchestrator-kd8n
---

The activity (CONTEXT.md) changes with each streamed text chunk today: worker-widget.ts activity() falls back to the last line of worker.text, which worker-board.ts updates on every message_update.

## Behaviour
- Activity is one of: `thinking…`, `writing…`, the running tool's name (no arguments), or why the worker failed.
- An activity stays shown for at least 1.5 s; the newest pending one replaces it after that. A failure shows at once.
- The same activity shows in the worker widget and in the transcript view's live lines.

## Todo
- [x] Tests first: phase from events, the 1.5 s hold, failure bypasses the hold
- [x] Derive the phase on the worker board instead of the last text line
- [x] Use it in the widget and the transcript view

## Summary of changes

- The worker board derives each worker's activity from its session events (`Activity` in worker-board.ts): thinking on a turn start or streamed thinking, writing on streamed text or a tool call, the running tool's name, or the failure. A streamed piece within one phase changes nothing.
- An activity is held `ACTIVITY_HOLD_MS` (1.5 s). The newest pending one replaces it from the moment its hold passed, even when nobody read the board in time. A failure shows at once, with `failed` when there is no reason.
- `BoardWorker.text` and `tool` are gone. The worker widget and the transcript view's header both draw `activityPart`. The header's stats line stands in for the live lines until n0fj.
- README's worker widget section describes the activity.
- Left as it was: an asking background worker keeps its last activity. That predates this change, and a background notice (background.ts, status.ts) still uses the worker's streamed text.
