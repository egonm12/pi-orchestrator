---
# pi-orchestrator-qdz9
title: Nested delegation from workers
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:45Z
updated_at: 2026-09-26T08:24:17Z
parent: pi-orchestrator-l1yp
---

A worker may call `subagents` only when its agent definition lists `subagents` in `tools:`. One extra level deep, foreground only, routed through the auto model, own maxParallel per call. Decision records of its workers name the parent delegation. Forked workers never delegate.

## Todo
- [x] Test: without `subagents` in tools a worker has no subagents tool; with it, it can delegate
- [x] Test: a nested worker cannot delegate further, and cannot start background calls
- [x] Test: records carry the parent delegation id
- [x] README

## Summary of Changes

- A worker gets the `subagents` tool only when the orchestrator started it and its agent definition lists `subagents` in `tools:` (`resolveAgent`'s `mayDelegate`; `runWorker` keeps the subagents extension only when the tools list names the tool).
- A worker's own workers never get the tool, always run on the auto model (preserve mode does not apply to them), and a worker's call that asks for `background: true` is refused before any worker starts (`src/subagents/nested-delegation.ts`).
- Worker sessions are kept with their parent delegation (`src/subagents/worker-sessions.ts`); the router extension writes it as the optional `parentDelegationId` of the decision record, which validation accepts when it names another delegation.
- Each call keeps its own `maxParallel`, as every call runs its own queue.
- README: a nested delegation section.
- Follow-up: pi-orchestrator-zuce (a worker's call refuses fork items, and a fork never gets the tool) once forked workers land.
