---
# pi-orchestrator-ir82
title: Changes requested retries on the next effort-ladder rung
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-28T13:47:32Z
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

- [x] request_changes replies with the next rung, or that none is left
- [x] A retry runs on that rung as a new delegation, with an effort-ladder record linked to the failed attempt
- [x] The third climb for the same task is refused with the take-it-to-the-user message
- [x] A retry of a delegation without request_changes is refused
- [x] The protocol describes retries
- [x] Tests

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
- Retries in shadow mode and with routing off (Q3): a retry runs on the session model like any worker. In shadow mode its effort-ladder record names the would-be rung. With routing off there is no loaded tier map, so its record is unplaced with no rung. The two-climb limit still applies.
- ctx_batch_execute (Q4): in a worker's session it counts as editing when any of its commands, classified with the bash classifier, is neither read-only nor build/test.

- [x] Reviewer runs on the same rung in shadow mode and with routing off; the verdict records a same-rung review
- [x] A reviewer's editing calls are denied; its reads, searches, builds and tests run
- [x] In shadow mode a retry runs on the session model and its effort-ladder record names the would-be rung; with routing off it runs on the session model with an unplaced record and no rung; the limit holds
- [x] ~~ctx_batch_execute counts as editing when one of its commands would~~ Superseded: ADR 0013 is leading (owner, 2026-09-28), and an editing delegation is defined by working-tree comparison, not by tool calls

## Summary of Changes

Completed request_changes retry planning and replies, new retry delegations with linked effort-ladder records, ordinary routing decisions for what ran, a two-climb refusal, and protocol and README guidance. Unplaced attempts (routing off, forks, named-model workers, refused routes, or rungs absent from the tier map) record step `unplaced` without a rung, route normally when routing is on or use the session model when off, and count toward the same limit. Same-rung reviews run only in shadow mode or with routing off, are recorded on verdicts, and cannot edit; reads, searches, builds and tests remain allowed. Added and updated integration and record tests. `npm run typecheck`, targeted tests and `npm test` passed (761 passed, 17 skipped). Self-review: standards and spec axes checked against the dirty diff and this bean; no remaining ir82 issue found beyond the held criterion.

ON HOLD: `ctx_batch_execute counts as editing` remains unchecked because a separate uncommitted design redefines editing delegation using working-tree comparison rather than command classification. Do not implement the superseded classifier rule in this ticket. Bean remains in progress.


Orchestrator verdict: accepted for everything but the on-hold ctx_batch_execute criterion. typecheck clean; npm test 761 pass 0 fail. Bean stays in progress until the owner decides whether ADR 0013's working-tree definition of an editing delegation supersedes that criterion.
