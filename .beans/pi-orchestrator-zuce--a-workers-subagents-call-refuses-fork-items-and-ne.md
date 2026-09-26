---
# pi-orchestrator-zuce
title: A worker's subagents call refuses fork items and never gives a fork the subagents tool
status: todo
type: task
created_at: 2026-09-26T08:24:06Z
updated_at: 2026-09-26T08:24:06Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-rc8i
---

ADR 0008 says a worker's own workers are routed and forked workers never delegate. Nested delegation (qdz9) routes a worker's items and refuses a worker's background call, but fork items did not exist on its branch.

Once forked workers (rc8i) land:
- A worker's subagents call must refuse an item with fork: true (a fork is unrouted and runs on the session model), before any worker starts.
- A fork item in the orchestrator's call must not get the subagents tool, even when its agent definition lists it: in src/subagents/extension.ts pass mayDelegate = false to resolveAgent for fork items (today it is parentDelegationId === undefined).

## Todo
- [ ] Test: a worker's call with a fork item is refused before any worker starts
- [ ] Test: a fork whose definition lists subagents has no subagents tool
