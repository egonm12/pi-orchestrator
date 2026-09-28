---
# pi-orchestrator-z4cp
title: Reviewer prefers another provider
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T21:58:22Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-8tgr
---

## Parent

pi-orchestrator-cml8 (user story 34). ADR 0012.

## What to build

The reviewer's routing constraint gains a provider to avoid: the implementer's provider. It is a preference, not a hard filter, so when only the implementer's provider survives the reviewer still runs there.

## Acceptance criteria

- [x] Reviewer prefers a rung from a different provider than the implementer's
- [x] Falls back to the same provider when no other survives
- [x] Review test covers both cases

## Blocked by

- 10 Balanced tier order

## Summary of changes

- `RoutingConstraints` and `RouterEvidence` gain `avoidedProvider` (src/routing/tier-router.ts). In `routeTier`, stage 2 chooses among the tier's survivors from other providers when any is left, else among all survivors. It is a preference, not a hard filter: it never moves routing to another tier, never brings back a removed rung, and never touches the minimum tier or the excluded rung. Balanced and ordered tier orders apply to the narrowed set; `providerCounts` lists the providers chosen among.
- `routeTask` passes the avoided provider through with the other constraints (src/router/route-task.ts).
- `reviewTarget` sets `avoidedProvider` to the provider of the reviewed delegation's rung (src/subagents/review.ts); the subagents extension already passes `target.constraints` through unchanged.
- New review routing test file src/subagents/review-provider.test.ts, driving real reviewer workers through the subagents tool with fake anthropic and openai-codex providers: preference over an ordered tier's list order, preference over balancing's less-used provider, and fallback to the implementer's provider at the minimum tier (not a lower-tier or higher-tier other-provider rung, not the excluded rung).

## Notes

- The avoided provider is not written to the decision record's `constraints` (schema unchanged), so `madeUnderConstraints` ignores it. Possible follow-up if the record should show the preference.
