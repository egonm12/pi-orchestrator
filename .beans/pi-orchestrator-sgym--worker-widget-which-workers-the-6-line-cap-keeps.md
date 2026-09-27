---
# pi-orchestrator-sgym
title: 'Worker widget: which workers the 6-line cap keeps'
status: todo
type: task
tags:
    - needs-triage
created_at: 2026-09-27T13:58:28Z
updated_at: 2026-09-27T13:58:28Z
parent: pi-orchestrator-a338
---

Two choices made while building the worker widget (oy50) that the owner has not confirmed:

- The cap was read as up to 6 worker lines plus a separate `+N more` line, so 7 lines at most. If 6 lines in total was meant, `widgetRows` changes by one line.
- The cap follows board order, so finished workers still lingering for their 10 s can push active ones into `+N more`. Active workers could come first instead.

## Todo

- [ ] Owner decides both points
- [ ] Change widgetRows and its tests if needed; README
