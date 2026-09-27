---
# pi-orchestrator-vu2o
title: Shared orchestrator-session check and /pi-orchestrator subcommands
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-27T22:07:20Z
parent: pi-orchestrator-3p1z
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

Prefactor, no behaviour change. One check answers "is this the orchestrator's own session?" (not a worker, not a pi-subagents child, not a herdr pane-native child), used by the guard, the router extension and the subagents extension instead of repeating the environment checks. The /pi-orchestrator command dispatches subcommands, so later tickets can add budget and gate beside init.

## Acceptance criteria

- [ ] One shared orchestrator-session check; the guard and router extension no longer test the child environment variables themselves
- [ ] /pi-orchestrator dispatches by subcommand; init behaves exactly as before; an unknown subcommand prints usage listing the subcommands
- [ ] Existing tests pass unchanged; new tests cover the check for orchestrator, worker, forked worker and child-process sessions

## Blocked by

None, can start immediately.
