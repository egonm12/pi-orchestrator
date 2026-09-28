---
# pi-orchestrator-l8af
title: Ungated and missing verdicts in the routing report
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-28T09:24:58Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-mxmz
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010, 0011. An editing delegation whose gate action was none is recorded as ungated. When an editing delegation ends, its gate requirement is recorded (ungated, spot check or reviewer). The routing report derives missing: a required verdict with no verdict record. This avoids pi's session_shutdown, which also fires for reload, resume, new and fork, and a verdict recorded later (after a resume) simply removes it from missing. The routing report counts ungated and missing apart; neither is a learning observation. The old meaning of missing (a reviewer result without structured output) is retired, together with the pi-subagents verdict-reviewer agent and reading verdicts from structured output.

## Acceptance criteria

- [ ] Ungated delegations appear in the decision record and the report's ungated count
- [ ] A required verdict with no verdict record counts as missing; recording the verdict later removes it
- [ ] Neither creates a learning observation
- [ ] Verdicts backed by a same-rung review are counted apart (owner decision 2026-09-28)
- [ ] The verdict-reviewer agent and structured-output verdict reading are removed, with their tests
- [ ] Tests

## Blocked by

- pi-orchestrator-mxmz
