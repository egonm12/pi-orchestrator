---
# pi-orchestrator-k3l9
title: Parallel workers with a concurrency limit and abort
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T21:42:44Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-0rng
---

One call takes up to 8 items; at most `orchestrator.subagents.maxParallel` (default 4) run at once, the rest queue. Abort (Ctrl+C) stops running and queued workers.

## Todo
- [ ] Test: 8 items with maxParallel 2 never run more than 2 at once, results keep item order
- [ ] Test: more than 8 items is refused
- [ ] Test: abort marks running items aborted and queued items not started
