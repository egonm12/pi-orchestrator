---
# pi-orchestrator-uezs
title: Per-worker routing constraints
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

Prefactor for the reviewer and retry tickets. The router extension accepts routing constraints for one worker before its first request: a minimum tier, a rung it must not run on, or a forced rung. The hard filters see the full rung (model and effort), not only the model, so a single rung can be excluded. Constraints never bypass the hard filters; a forced rung that fails them is a refusal. Decision records name any constraint applied.

## Acceptance criteria

- [ ] A minimum tier routes the worker at that tier or higher, with the usual escalation
- [ ] An excluded rung is never chosen, including by escalation
- [ ] A forced rung is pinned if it passes the hard filters, else the worker is refused with a reason
- [ ] The decision record names the constraint
- [ ] Existing routing behaviour is unchanged without constraints
- [ ] Tests

## Blocked by

None, can start immediately.
