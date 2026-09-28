---
# pi-orchestrator-8tgr
title: Balanced tier order
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T16:26:35Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 28 to 33, 35, 36). ADR 0012, amending ADR 0001.

## What to build

Each tier in the tier map gains an optional order, `balanced` (default) or `ordered`. A project tier replaces the personal tier with the same name, including its order. Balancing chooses among the survivors of one step the rung whose provider started the fewest delegations in the last 5 hours, counted per provider across all tiers from the global decision records under the owner's state directory, counting only rungs that were actually pinned (not shadow recommendations). Rungs chosen earlier in the same call count too, so a fan-out spreads. List order breaks ties. Hard filters, escalation and the effort ladder's step order are unchanged. The decision record gains the provider counts behind a balanced choice and the tier order in force.

## Acceptance criteria

- [x] `balanced` (default) and `ordered` tier order; project tier replaces personal tier including its order
- [x] Balanced choice by per-provider count over a rolling 5-hour window, across sessions and projects
- [x] Shadow records ignored
- [x] A parallel fan-out spreads over providers
- [x] Ties broken by list order; `ordered` keeps first survivor wins
- [x] Hard filters, escalation and effort ladder step order unchanged
- [x] Decision record shows counts and tier order
- [x] Tier-router tests with `fixtureRoute`; router extension tests with a fixed `now` and records in a temporary state directory

## Blocked by

None, can start immediately.

## Summary of changes

Added balanced-by-default and ordered tier settings with project replacement of both rungs and order. The tier router chooses the least-used surviving provider from pinned global live decisions in the rolling five-hour window, including earlier fan-out pins; shadow recommendations do not count. Decisions record tier order and the counts behind balanced choices. Documented settings in README and covered map resolution, routing, records, rolling window, cross-session/project/tier usage, shadow exclusion and fan-out with focused tests. `npx tsc --noEmit` passed; `npm test` passed with 805 passing and 16 skipped.

Follow-up after the reviews of 2c66eb3 and f121ca1 (the owner authorized direct implementation after the effort ladder's two climbs):

- **Worker fan-out.** The orchestrator's workers share one process, though each loads its own router extension. A process-wide queue serializes their routing choices and pending-reservation writes by state folder. Classification runs before the queue; the time used for routing and the decision record is taken inside it, so a slower classifier sees a faster worker's earlier pin. Sessions in other processes read the shared decision and reservation files but simultaneous choices in separate processes are not guaranteed to spread. The PRD requires rungs chosen earlier in one call to count, not cross-process atomicity.
- **Pending choices.** A live choice writes a reservation under the queue. The decision is appended only when the inner stream gives its first event, since pi's registry prepares a request lazily. Until then the reservation counts toward balancing, so a fan-out spreads even if a request has not produced output yet. A request that throws, or ends with no event, is released and leaves no decision and no pin. If the commit fails, the inner request is stopped. Reservations of dead processes, ones outside the 5-hour window and invalid JSON files are ignored; an invalid file must not disable routing.
- **Board order.** The served rung is published after the decision is written, so the worker board reads the tier from it.
- **Known limit.** A first event that is an error still counts, because an error the provider returned (an overflow, a 400) is a real attempt that keeps its pin. pi-ai reports its own setup failures as an error event of the same shape, so those count too. The registry lookup and the authorization filter run first. Ticket 09 handles first-request limit errors.
- **Tests.** Router extension tests cover cross-instance fan-out, a request still pending its first event, an inverted classification order with advancing clocks, a lazy request that throws while preparing, a failed registry lookup, a synchronous failed start, and a corrupt reservation. The inverted-order and corrupt-reservation tests were red before their fixes. No filesystem choice lock, stale-recovery guard or heartbeat remains.

Final review follow-up: A write failure during reservation or decision append again disables routing and reports the error; a failed commit also stops the inner stream. A reservation file containing JSON `null` or another non-object, like invalid JSON, is ignored rather than disabling routing. A worker whose stream ends without an event no longer publishes a served rung. The queue comment now notes the rare reclassification case that may wait inside it. The two new router extension tests were red before the fixes and green after them.
