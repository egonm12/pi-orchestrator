---
# pi-orchestrator-247s
title: Independent reviewer for editing delegations
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T22:07:20Z
updated_at: 2026-09-27T22:52:02Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-kokv
    - pi-orchestrator-uezs
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. A subagents item review: <delegation id> starts an independent reviewer for an editing delegation: routed through the auto model at the implementer's tier or higher, never on the implementer's rung, with review instructions (check the change against the task, rerun nothing unless told, answer accept or request changes with reasons). A delegation without a tier (a forked worker, or one whose agent definition names a model) counts as elevated. subagents_verdict refuses a self-judged verdict on an elevated or critical delegation unless it names the reviewer delegation. The protocol gains a paragraph on reviewers.

## Acceptance criteria

- [ ] A review item is routed at or above the implementer's tier and never on its rung
- [ ] The reviewer's decision record links to the reviewed delegation
- [ ] subagents_verdict on an elevated or critical delegation without a reviewer delegation is refused; with one it is accepted
- [ ] Forked and agent-model delegations are gated as elevated
- [ ] The protocol describes reviewers
- [ ] Tests

## Blocked by

- pi-orchestrator-kokv
- pi-orchestrator-uezs


## Notes from uezs
- Routing constraints exist: setRoutingConstraints(id, { minimumTier, excludedRung }) in the auto provider, read at the worker's first request; nothing calls it yet, so WorkerSetup needs a field to pass them.
- When routing refuses, runs in shadow mode or is off, a worker falls back to the orchestrator's session model without checking the excluded rung. ADR 0010 says a reviewer never runs on the implementer's rung, so a review item whose fallback model is the implementer's rung must fail with a reason instead of running.
- A compaction summary gets a new session id and is routed without the worker's constraints; decide whether that matters for a reviewer.
