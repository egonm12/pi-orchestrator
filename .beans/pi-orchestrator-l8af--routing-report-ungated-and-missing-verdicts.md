---
# pi-orchestrator-l8af
title: Ungated and missing verdicts in the routing report
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:07:20Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-mxmz
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010, 0011. An editing delegation whose gate action was none is recorded as ungated. A verdict the gate level required but that was never recorded when the orchestrator's session ends is recorded as missing. The routing report counts ungated and missing apart; neither is a learning observation. The old meaning of missing (a reviewer result without structured output) is retired, together with the pi-subagents verdict-reviewer agent and reading verdicts from structured output.

## Acceptance criteria

- [ ] Ungated delegations appear in the decision record and the report's ungated count
- [ ] Session end records missing verdicts; the report counts them
- [ ] Neither creates a learning observation
- [ ] The verdict-reviewer agent and structured-output verdict reading are removed, with their tests
- [ ] Tests

## Blocked by

- pi-orchestrator-mxmz
