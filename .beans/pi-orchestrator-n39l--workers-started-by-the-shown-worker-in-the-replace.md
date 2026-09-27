---
# pi-orchestrator-n39l
title: Workers started by the shown worker, in the replaced view
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T14:35:10Z
updated_at: 2026-09-27T15:16:37Z
parent: pi-orchestrator-z51n
blocked_by:
    - pi-orchestrator-n0fj
---

## Parent

pi-orchestrator-z51n (epic pi-orchestrator-kd8n, ADR 0009).

## What to build

In regular tuiMode, the workers the shown worker started (nested workers) are listed in the live lines at the end of the view, just above the stats line, at most 6 rows as the worker widget draws them, the selected one marked. ↑↓ selects, Enter opens the selected worker in the same view. The list updates live as those workers change. Fullscreen tuiMode is unchanged.

## Acceptance criteria

- [x] Regular tuiMode: nested workers show above the stats line, capped at 6 rows, scrolled to keep the selection in view
- [x] ↑↓ and Enter work as in the overlay; the key hint appears only when there are nested workers
- [x] Tests cover the list, selection and opening a nested worker
- [x] Typecheck and the full test suite pass

## Blocked by

- pi-orchestrator-n0fj (The transcript view replaces pi's view in regular tuiMode)

## Summary of changes

- In regular tuiMode, the live lines start with the shown worker's nested workers. They sit just above the stats line, at most 6 rows as the worker widget draws them, scrolled to keep the selection in view, and they update with the board.
- ↑↓ and Enter now work in regular tuiMode as in the overlay. Enter opens the selected worker and reprints. The hint `↑↓ Enter nested worker` shows only when there are nested workers.
- Fullscreen tuiMode is unchanged. A test covers the list, the selection and opening a worker, and README's regular mode section lists the keys.
