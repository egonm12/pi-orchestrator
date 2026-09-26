---
# pi-orchestrator-rc8i
title: Forked workers run on the session model
status: completed
type: feature
priority: normal
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:24:02Z
parent: pi-orchestrator-l1yp
---

An item with `fork: true` starts a worker from a copy of the orchestrator's current branch, ending before the assistant message that makes the delegating call. Its pin is the session model and effort at the call, unrouted, exempt from the subagent ban list. It may name an agent definition (instructions, narrowed tools; the definition's model/thinking ignored, no warning). It writes a `fork` record (delegation id, model, effort, parent session, fork point). Forks never get `subagents`. Several forks and ordinary items may share a call.

## Todo
- [x] Test: the fork's context is the orchestrator's branch up to, not including, the delegating assistant message
- [x] Test: runs on the session rung at call time, unrouted, and a later model switch does not move it
- [x] Test: a session model on the subagent ban list still runs as a fork, and the record says so
- [x] Test: fork plus agent applies instructions and tools, ignores the definition's model
- [x] Test: the fork record is written and a verdict attaches to it
- [x] TUI line marks a fork and its model
- [x] README

## Summary of Changes

Added forked worker snapshots of the active branch before the delegating assistant message, pinned to the session model and effort without routing. Fork records include the parent session, fork point and ban-list exemption, and verdicts attach to them. Forks honor agent instructions and narrowed tools, render as forks in the TUI, and are documented in README.md. Tests cover branch isolation, model switches, mixed calls, banned models, agents, records and unsaved sessions.
