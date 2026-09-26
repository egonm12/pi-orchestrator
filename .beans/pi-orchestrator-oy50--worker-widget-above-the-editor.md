---
# pi-orchestrator-oy50
title: Worker widget above the editor
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:47:47Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-2jba
---

A widget above the editor listing active workers from the worker board: one line each (agent, model and effort, worker state, elapsed time, turns, current tool or latest text), nested workers indented under their parent, at most 6 lines then "+N more". A finished worker stays about 10 s with its end state, then drops out; the widget disappears when no worker runs.

## Todo
- [x] Test: line content and nesting
- [x] Test: the 6-line cap and "+N more"
- [x] Test: finished workers linger then drop; an empty board hides the widget
- [x] README

## Summary of Changes

- src/subagents/worker-widget.ts (new): the worker widget. `widgetRows(workers, now)` is a pure function from the board's workers to `WidgetRows { rows: WidgetRow[], more }`, where each `WidgetRow { worker, depth }` knows its worker (`row.worker.id`) and depth, and `more` counts the workers past the 6-row cap (`MAX_WIDGET_ROWS`). A worker shows while queued, running or asking, and for `LINGER_MS` (10 s) after its end. `widgetLines(rows, now, theme, width)` renders one line per row plus a separate "+N more" line, each cut with an ellipsis to the render width. `startWorkerWidget(ui, board, options?)` keeps the widget (key `WORKER_WIDGET`) above the editor while any row shows, removes it otherwise, redraws on the board's change signal and on a 1 s timer that runs only while the widget is shown, and returns a stop function.
- A line: agent (`worker` without one, `(fork)` for a fork), model and effort (`routing…` before a routed worker's first request, then its latest rung, `↑<tier>` after an escalation; a fork's or preserved model's fixed model), worker state, and once started its elapsed time and turns, then its current tool, else the last line of its latest text, else for a failed worker its error, else its short task. A nested worker is indented under its parent with `└ `.
- src/subagents/extension.ts: the orchestrator's session_start starts the widget when the session has a UI; a worker's own copy of the extension shows none. session_shutdown stops it before stopping background workers.
- Tests: 5 in worker-widget.test.ts (line content and nesting, the cap and "+N more", width, linger and hide, change signal and a new session) and 1 in extension.test.ts (real lead and nested workers in the widget, removed at session end).
- README.md: a Worker widget section under the subagents tool.
- For xytd: selection can index `widgetRows(...).rows` and open `row.worker.id` through the board; the "+N more" line is not a row.
