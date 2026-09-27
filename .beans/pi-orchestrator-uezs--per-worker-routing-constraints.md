---
# pi-orchestrator-uezs
title: Per-worker routing constraints
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-27T22:52:02Z
parent: pi-orchestrator-3p1z
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

Prefactor for the reviewer and retry tickets. The router extension accepts routing constraints for one worker before its first request: a minimum tier, a rung it must not run on, or a forced rung. The hard filters see the full rung (model and effort), not only the model, so a single rung can be excluded. Constraints never bypass the hard filters; a forced rung that fails them is a refusal. Decision records name any constraint applied.

## Acceptance criteria

- [x] A minimum tier routes the worker at that tier or higher, with the usual escalation
- [x] An excluded rung is never chosen, including by escalation
- [x] A forced rung is pinned if it passes the hard filters, else the worker is refused with a reason
- [x] The decision record names the constraint
- [x] Existing routing behaviour is unchanged without constraints
- [x] Tests

## Blocked by

None, can start immediately.

## Summary of Changes

- `setRoutingConstraints(sessionId, constraints)` in `src/router/auto-provider.ts` sets constraints for one worker before its first request, kept process-wide like resume pins. It returns the function that removes them. Nothing calls it yet: the reviewer (247s) and retry (ir82) tickets will.
- `RoutingConstraints` in `src/routing/tier-router.ts` is a union: `{ minimumTier?, excludedRung? }` (what the reviewer needs) or `{ forcedRung }` alone. A forced rung is a `Pick<TierRouteChoice, "rung" | "tier">`, so ir82 can pass the effort ladder's `LadderChoice` as is.
- `failedHardFilter` takes the whole rung (model and effort). `RouterEvidence.excludedRung` removes only that model at that effort, in every tier, with the new removal reason `excluded rung`. The effort ladder, the restore check and resume go through the same function.
- `routeTask` raises a lower classified tier to the minimum tier and escalates from there as usual. A forced rung goes through `routeForcedRung`: pinned if it passes the hard filters, else a refusal naming the filter. The worker then runs on the orchestrator's session model, as any refused worker does. The classifier still runs, so the record keeps its tier and why.
- Decision records get an optional `constraints` field (`minimumTier`, `excludedRung`, `forcedRung: { tier, rung }`), validated on write and read. An unconstrained record has no such field.
- In live mode, a recorded decision restores a pin only if it was made under the same constraints.
- Tests: 8 new router extension tests, 1 routeTier test and 1 decision-record test. README's "How routing decides" describes routing constraints.

Open points for 247s and ir82:
- The session-model fallback (refusal, shadow mode, routing off) ignores the excluded rung. If the session model is the implementer's rung, the reviewer can still run on it. In shadow mode it always does.
- A compaction summary request has a new session id, so it is routed without the worker's constraints.
- A forced rung writes a `decision` record, not an `effort-ladder` record. ir82 has to decide how its effort-ladder record relates to it.


Orchestrator verdict: accepted. Open points carried to 247s and ir82.
