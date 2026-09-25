---
# pi-orchestrator-ro35
title: 'agentDefinitionModel.allowBanned: the ban-list exception'
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:43:16Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-bbge
---

With `use: "preserve"` and `allowBanned: true`, a model on the subagent ban list named by an agent definition may run. For a project's definition this also needs `allowProjectOverrides`. The agent-model record gets `banListException: true`. Under "route", a true value warns once. The guard and the router must not refuse such a worker; every other path stays banned.

## Todo
- [x] Test: personal definition with a banned model runs only with allowBanned on
- [x] Test: project definition with a banned model runs only with allowBanned and allowProjectOverrides on
- [x] Test: tier map and tool-call paths still refuse the banned model

## Summary of changes

Added `agentDefinitionModel.allowBanned` (boolean, default false) to the subagents settings loader, so a project's `agentDefinitionModel` replaces it whole under `allowProjectOverrides`, as uccb does for every key. Under "preserve", a definition-named model on the subagent ban list now runs when `allowBanned` is on; a definition from the project's `.pi/agents/` also needs personal `allowProjectOverrides`. Such a worker gets `banListException: true` on its agent-model record and its item result, which the renderer already marks. Under "route", a true value warns once per session. No guard or router exception mechanism was needed: the guard refuses only model-carrying tool calls and the session ban list, and the router does not route a worker on a named model. Integration tests load the guard and the router into the worker and show the exception worker runs, the project case needs both flags, and the tier map still drops the banned rung while the guard still refuses a tool call naming it. The README's `allowBanned` row describes the shipped behaviour.
