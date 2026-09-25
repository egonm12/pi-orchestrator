---
# pi-orchestrator-bbge
title: 'agentDefinitionModel.use: route or preserve'
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:24:07Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-vsbt
---

`orchestrator.subagents.agentDefinitionModel.use`: "route" (default) ignores a definition's `model`/`thinking` with one warning. "preserve" runs a worker whose definition names a model on that model and thinking, unrouted, and writes an `agent-model` record (delegation id, agent name, definition file, model, effort). A definition without a model is still routed.

## Todo
- [x] Test: route mode ignores model and warns once
- [x] Test: preserve mode runs on the named model and writes the agent-model record
- [x] Test: a banned named model is refused when allowBanned is off

## Summary of changes

Implemented owner-only agentDefinitionModel.use: route ignores model and thinking with one warning per session; preserve uses the named model and thinking without routing, refuses banned names, and records an agent-model entry keyed by worker session id in the routing day file. Added integration and record validation tests. Corrected README worker tool description.
