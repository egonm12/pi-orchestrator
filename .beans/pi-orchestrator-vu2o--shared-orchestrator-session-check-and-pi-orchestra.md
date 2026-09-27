---
# pi-orchestrator-vu2o
title: Shared orchestrator-session check and /pi-orchestrator subcommands
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-27T22:28:17Z
parent: pi-orchestrator-3p1z
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

Prefactor, no behaviour change. One check answers "is this the orchestrator's own session?" (not a worker, not a pi-subagents child, not a herdr pane-native child), used by the guard, the router extension and the subagents extension instead of repeating the environment checks. The /pi-orchestrator command dispatches subcommands, so later tickets can add budget and gate beside init. Today the command handles only init; the dispatcher is new.

## Acceptance criteria

- [x] One shared orchestrator-session check; the guard and router extension no longer test the child environment variables themselves
- [x] /pi-orchestrator dispatches by subcommand; init behaves exactly as before; an unknown subcommand prints usage listing the subcommands
- [x] Existing tests pass unchanged; new tests cover the check for orchestrator, worker, forked worker and child-process sessions

## Blocked by

None, can start immediately.

## Summary of Changes

- New `src/subagents/orchestrator-session.ts`: `isOrchestratorSession(ctx, env = process.env)` is false in a pi-subagents child process (`PI_SUBAGENT_CHILD=1` or `PI_SUBAGENTS_HERDR_BRIDGE=1`) and for any session marked as a worker (forked and nested workers included), true otherwise. Tests in `orchestrator-session.test.ts` (orchestrator, worker, nested worker, forked worker, both child markers) and an integration test in `subagents/extension.test.ts` that runs a real worker and a real fork and asks the check from an extension they load.
- The guard's session ban list and the router extension's remembered session model and fresh-install notice use the shared check; neither tests the child environment variables any more.
- New `src/init/subcommands.ts`: `dispatchSubcommand` picks the subcommand by the first word and passes it the rest; no subcommand or an unknown one prints the usage listing every subcommand. The router extension registers `/pi-orchestrator` through it with `init` as the only subcommand; `init` still goes through `runInit` with the same argument string and error handling.
- README: the setup section names the subcommand dispatch and says the notice shows in the orchestrator's own session only.

Notes for review:
- One small behaviour shift: the fresh-install notice used to show in a herdr pane-native child (`PI_SUBAGENTS_HERDR_BRIDGE=1`), because that check tested only `PI_SUBAGENT_CHILD`. It no longer does, matching its "owner's session only" comment. Covered by a router test.
- `/pi-orchestrator` with no argument now prints the general usage instead of `usage: /pi-orchestrator init`.
- The guard now reads the child markers on each check instead of once at load.
- The subagents extension is not switched to the check: its `isWorkerSession` uses (worker board, widget, alt+a, orchestrator run state, nested delegation) would change behaviour in pi-subagents children, which this prefactor must not do. Later tickets (protocol, budget) can use `isOrchestratorSession` there.


Orchestrator verdict: accepted. The subagents extension keeps isWorkerSession for its in-process uses (worker board, widget, nested delegation); switching them would change behaviour inside pi-subagents children. The protocol and budget tickets use isOrchestratorSession there.
