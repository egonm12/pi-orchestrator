---
# pi-orchestrator-rc8i
title: Forked workers run on the session model
status: todo
type: feature
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:12:55Z
parent: pi-orchestrator-l1yp
---

An item with `fork: true` starts a worker from a copy of the orchestrator's current branch, ending before the assistant message that makes the delegating call. Its pin is the session model and effort at the call, unrouted, exempt from the subagent ban list. It may name an agent definition (instructions, narrowed tools; the definition's model/thinking ignored, no warning). It writes a `fork` record (delegation id, model, effort, parent session, fork point). Forks never get `subagents`. Several forks and ordinary items may share a call.

## Todo
- [ ] Test: the fork's context is the orchestrator's branch up to, not including, the delegating assistant message
- [ ] Test: runs on the session rung at call time, unrouted, and a later model switch does not move it
- [ ] Test: a session model on the subagent ban list still runs as a fork, and the record says so
- [ ] Test: fork plus agent applies instructions and tools, ignores the definition's model
- [ ] Test: the fork record is written and a verdict attaches to it
- [ ] TUI line marks a fork and its model
- [ ] README
