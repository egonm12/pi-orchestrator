---
# pi-orchestrator-ir82
title: Changes requested retries on the next effort-ladder rung
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-27T22:07:20Z
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
