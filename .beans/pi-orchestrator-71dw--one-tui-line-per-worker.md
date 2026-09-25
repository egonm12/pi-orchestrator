---
# pi-orchestrator-71dw
title: One TUI line per worker
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-k3l9
---

While workers run, show one line per worker: agent name, short task, and current tool or state (queued, running, done, error). Expanding shows the final text. A preserved-model worker also shows its model, marked when the ban-list exception applied.

## Todo
- [ ] Render partial updates and the final result
- [ ] Check it by hand in an interactive session
