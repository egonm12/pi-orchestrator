---
# pi-orchestrator-qdz9
title: Nested delegation from workers
status: todo
type: feature
priority: normal
created_at: 2026-09-25T21:42:45Z
updated_at: 2026-09-26T08:12:55Z
parent: pi-orchestrator-l1yp
---

A worker may call `subagents` only when its agent definition lists `subagents` in `tools:`. One extra level deep, foreground only, routed through the auto model, own maxParallel per call. Decision records of its workers name the parent delegation. Forked workers never delegate.

## Todo
- [ ] Test: without `subagents` in tools a worker has no subagents tool; with it, it can delegate
- [ ] Test: a nested worker cannot delegate further, and cannot start background calls
- [ ] Test: records carry the parent delegation id
- [ ] README
