---
# pi-orchestrator-oy50
title: Worker widget above the editor
status: todo
type: feature
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:18:43Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-2jba
---

A widget above the editor listing active workers from the worker board: one line each (agent, model and effort, worker state, elapsed time, turns, current tool or latest text), nested workers indented under their parent, at most 6 lines then "+N more". A finished worker stays about 10 s with its end state, then drops out; the widget disappears when no worker runs.

## Todo
- [ ] Test: line content and nesting
- [ ] Test: the 6-line cap and "+N more"
- [ ] Test: finished workers linger then drop; an empty board hides the widget
- [ ] README
