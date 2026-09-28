---
# pi-orchestrator-ir82
title: Changes requested retries on the next effort-ladder rung
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-28T09:24:58Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-kokv
    - pi-orchestrator-uezs
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. When subagents_verdict records request_changes, its reply names the next effort-ladder rung, or says the ladder is exhausted. A subagents item retry: <delegation id> with the feedback as task starts a new delegation forced onto that rung, linked to the failed attempt by an effort-ladder record. After two climbs for the same task, a retry is refused and the orchestrator is told to take it back to the user. The protocol gains a paragraph on retries.

## Acceptance criteria

- [ ] request_changes replies with the next rung, or that none is left
- [ ] A retry runs on that rung as a new delegation, with an effort-ladder record linked to the failed attempt
- [ ] The third climb for the same task is refused with the take-it-to-the-user message
- [ ] A retry of a delegation without request_changes is refused
- [ ] The protocol describes retries
- [ ] Tests

## Blocked by

- pi-orchestrator-kokv
- pi-orchestrator-uezs


## Notes from uezs
- setRoutingConstraints(id, { forcedRung: { rung, tier } }) pins a forced rung or refuses it (code no_authorized_candidate) when it fails a hard filter. Nothing calls it yet; WorkerSetup needs a field.
- A forced rung writes a normal decision record carrying constraints, not an effort-ladder record. This ticket must write the effort-ladder record (buildEffortLadderRecord) linked to the failed attempt and reconcile the two.


## Owner decisions (2026-09-28), folded into this ticket
Reviewer fixes on top of 247s, and two small additions:
- Same-rung review (Q1): when routing cannot choose a rung other than the implementer's (shadow mode, routing off), a reviewer runs on the same rung instead of failing, with a fresh context. The verdict it backs is recorded as a same-rung review (a field on the verdict or reviewer decision record), and subagents_verdict accepts it. Replaces 247s's fail-with-a-reason fallback for reviewers in shadow mode and with routing off.
- Reviewers cannot edit (Q2): in a reviewer's session, editing tool calls (the editing rule in src/subagents/editing.ts) are denied with a reason; reading, searching, building and testing stay allowed. A reviewer never becomes an editing delegation.
- Retries in shadow mode and with routing off (Q3): a retry runs on the session model like any worker; its effort-ladder record names the rung it would have used; the two-climb limit still applies.
- ctx_batch_execute (Q4): in a worker's session it counts as editing when any of its commands, classified with the bash classifier, is neither read-only nor build/test.

- [ ] Reviewer runs on the same rung in shadow mode and with routing off; the verdict records a same-rung review
- [ ] A reviewer's editing calls are denied; its reads, searches, builds and tests run
- [ ] In shadow mode and with routing off a retry runs on the session model, its effort-ladder record names the would-be rung, and the limit holds
- [ ] ctx_batch_execute counts as editing when one of its commands would
