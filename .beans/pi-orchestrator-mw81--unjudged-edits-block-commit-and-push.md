---
# pi-orchestrator-mw81
title: Unjudged edits block commit and push
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
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. While any editing delegation of this session has no verdict, git commit and git push from the orchestrator are denied with a message naming the unjudged delegations. At the end of each orchestrator turn with unjudged delegations, a notice names them. The final reply and new delegations are never blocked.

## Acceptance criteria

- [ ] git commit and git push are denied while a verdict is outstanding and allowed once every editing delegation has one
- [ ] The deny message and the turn-end notice name each unjudged delegation
- [ ] Other bash, new delegations and the final reply are not blocked
- [ ] Workers are not affected
- [ ] Tests

## Blocked by

- pi-orchestrator-kokv
