---
# pi-orchestrator-n5ly
title: 'report: background workers talk to the orchestrator'
status: todo
type: feature
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:12:55Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-399w
    - pi-orchestrator-3r8g
---

A worker-side `report` tool. Background workers get progress and question kinds; foreground workers progress only. Progress is shown in the TUI at once and reaches the orchestrator at its next turn without starting one. A question starts an orchestrator turn when idle and blocks the worker until a subagents_message reply, an abort or a /subagents stop; no time limit.

## Todo
- [ ] Test: progress reaches the next turn without starting one
- [ ] Test: a question starts a turn and blocks until the reply
- [ ] Test: foreground workers have no question kind
- [ ] README
