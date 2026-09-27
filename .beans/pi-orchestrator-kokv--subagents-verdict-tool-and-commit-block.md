---
# pi-orchestrator-kokv
title: Orchestrator records verdicts on editing delegations
status: todo
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T21:58:41Z
updated_at: 2026-09-27T22:07:20Z
parent: pi-orchestrator-3p1z
blocked_by:
    - pi-orchestrator-y8cd
    - pi-orchestrator-jeyq
---

## Parent

pi-orchestrator-3p1z (orchestrator enforcement)

## What to build

ADR 0010. The runtime tracks, per delegation, whether it edited: its session ran edit, write, or a bash command the budget's classification does not recognise as a read-only search or a build or test run. Edits by a worker's own workers belong to the top-level delegation. A new subagents_verdict tool (delegation id, accept or request_changes, reason) lets the orchestrator record a verdict on an editing delegation, whether from its own spot check or from a reviewer; it attaches the verdict to the decision record, and the routing report counts it. A verdict on a non-editing delegation is refused with a reason. The protocol gains a paragraph on judging Results and recording verdicts.

## Acceptance criteria

- [ ] Editing is recorded per delegation and survives the worker's end; nested workers' edits count for their top-level delegation
- [ ] bash that the classification does not recognise as read-only or build/test counts as editing
- [ ] subagents_verdict records accept and request_changes on editing delegations; the routing report shows them
- [ ] A verdict on an unknown or non-editing delegation is refused with a reason
- [ ] A later verdict on the same delegation replaces the earlier one in the report
- [ ] The protocol describes verdicts
- [ ] Tests

## Blocked by

- pi-orchestrator-y8cd
- pi-orchestrator-jeyq
