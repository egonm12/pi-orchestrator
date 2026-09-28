---
# pi-orchestrator-8tgr
title: Balanced tier order
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T16:09:32Z
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
