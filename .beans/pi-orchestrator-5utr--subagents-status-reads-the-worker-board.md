---
# pi-orchestrator-5utr
title: subagents_status reads the worker board
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-27T13:58:27Z
updated_at: 2026-09-27T13:58:27Z
parent: pi-orchestrator-a338
---

`subagents_status` (src/subagents/background.ts) still works out turns, latest text and elapsed time from the worker's `onActivity` hook, while the worker board (2jba) reads the same session events for the widget and transcript view. Let the status tool read the board instead, and drop the duplicated event reading in src/subagents/worker.ts. The tool's output must stay the same.

## Todo

- [ ] Test: subagents_status output unchanged for running, asking and finished background workers
- [ ] Status reads the board; onActivity's duplicated reading removed
