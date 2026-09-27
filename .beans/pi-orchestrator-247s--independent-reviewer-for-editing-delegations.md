---
# pi-orchestrator-247s
title: Independent reviewer for editing delegations
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
