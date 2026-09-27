---
# pi-orchestrator-mxmz
title: Gate level
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:18:26Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-vu2o
    - pi-orchestrator-mw81
    - pi-orchestrator-247s
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0011. The gate level (low, medium, high, max) sets the gate action per tier (none, spot check, reviewer) using the table in ADR 0011; critical always needs a reviewer. It drives which delegations need a verdict (commit block) and which need a reviewer (subagents_verdict). At max, reviewers are told to rerun the Result's Verified by commands. The personal default is medium, a project may override it, and /pi-orchestrator gate <level> sets it for the session. The orchestrator may raise the level for one delegation with a reason in subagents_verdict, never lower it. The protocol names the current level.

## Acceptance criteria

- [ ] Every cell of the ADR 0011 table is honoured by the commit block and the reviewer requirement
- [ ] Gate action none: no verdict needed, commit not blocked
- [ ] Personal setting, project override and the session command work; an invalid level is refused with usage
- [ ] Raising for one delegation works and is recorded; lowering is refused
- [ ] At max, reviewer instructions include rerunning Verified by
- [ ] The protocol names the current gate level
- [ ] Tests

## Blocked by

- pi-orchestrator-vu2o
- pi-orchestrator-mw81
- pi-orchestrator-247s
