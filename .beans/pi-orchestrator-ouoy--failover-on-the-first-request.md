---
# pi-orchestrator-ouoy
title: Failover on the first request
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-5inr
---

## Parent

pi-orchestrator-cml8 (user stories 42, 43, 45).

## What to build

The auto model detects a usage or rate-limit failure of a worker's first request, before any output, and pins the worker again to the next surviving rung, excluding that provider where another survives. A limit later in the run fails the worker cleanly. Both record a usage observation. The decision record gains failover entries linked to the refused attempt.

## Acceptance criteria

- [ ] First-request usage-limit error repins the worker to the other provider
- [ ] Failover recorded in the decision record, linked to the refused attempt
- [ ] An exhausted or throttled observation is recorded
- [ ] A mid-run limit fails the worker
- [ ] Router extension tests with a provider double and a temporary state folder

## Blocked by

- 07 Usage store and error signals
