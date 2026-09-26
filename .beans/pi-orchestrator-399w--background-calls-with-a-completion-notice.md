---
# pi-orchestrator-399w
title: Background calls with a completion notice
status: todo
type: feature
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:12:55Z
parent: pi-orchestrator-l1yp
---

`background: true` on a call returns at once with the delegation ids and call id. When every item finishes, one completion notice with the same result text as a foreground call is delivered as a follow-up that starts a turn if idle. Each call keeps its own maxParallel. `orchestrator.subagents.maxBackgroundWorkers` (default 8) refuses a call that would exceed it. Ctrl+C leaves background workers running; a `/subagents` command lists and stops them; session shutdown aborts them (status aborted). Nested calls cannot be background.

## Todo
- [ ] Test: a background call returns ids at once and delivers one notice when all items finish
- [ ] Test: the cap refuses a call with the reason
- [ ] Test: Ctrl+C does not stop background workers; shutdown aborts them
- [ ] /subagents list and stop
- [ ] README
