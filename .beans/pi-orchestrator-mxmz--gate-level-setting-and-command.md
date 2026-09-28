---
# pi-orchestrator-mxmz
title: Gate level
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T13:47:53Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
    - pi-orchestrator-mw81
    - pi-orchestrator-247s
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0011, as amended by ADR 0013. The gate level (low, medium, high, max) sets the gate action for each editing delegation from its tier, using the table in ADR 0011: none, spot check or reviewer. Critical always needs a reviewer, and a delegation without a tier counts as elevated. The gate action replaces today's fixed medium rule in one place, and everything that asks "does this delegation need a verdict, and does it need a reviewer" reads it:
- the commit gate and the turn-end notice name only delegations whose gate action is not none (today the gate blocks; epic pi-orchestrator-atod turns it into a notice, and this ticket must not depend on which);
- subagents_verdict refuses a self-judged verdict where the gate action is reviewer.

At max, reviewers are told to rerun the Result's Verified by commands. The personal default is medium, a project may override it, and /pi-orchestrator gate <level> sets it for the session. The orchestrator may raise the level for one delegation with a reason in subagents_verdict, never lower it. The protocol names the current level.

## Acceptance criteria

- [ ] Every cell of the ADR 0011 table gives the right gate action, and a delegation without a tier counts as elevated
- [ ] Gate action none: no verdict needed; the delegation is never named by the commit gate or the turn-end notice
- [ ] Gate action reviewer: subagents_verdict refuses a self-judged verdict; spot check: a self-judged verdict is accepted
- [ ] Personal setting, project override and the session command work; an invalid level is refused with usage
- [ ] Raising for one delegation works and is recorded; lowering is refused
- [ ] At max, reviewer instructions include rerunning Verified by
- [ ] The protocol names the current gate level
- [ ] Tests

## Blocked by

- pi-orchestrator-vu2o
- pi-orchestrator-mw81
- pi-orchestrator-247s
