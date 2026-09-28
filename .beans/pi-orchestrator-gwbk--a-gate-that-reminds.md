---
# pi-orchestrator-gwbk
title: A gate that reminds
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 10 to 13, and the gate part of 20). ADR 0013, amending ADR 0010.

## What to build

The quality gate never denies commit or push. A commit or push result gets a reminder naming the delegations still waiting for a verdict. The verdict-reminder messages and the routing report's missing-verdict count stay. Gate levels and gate actions (ADR 0011) are unchanged. The protocol text describes the reminding gate instead of a refusal.

## Acceptance criteria

- [ ] A commit or push with a delegation waiting for a verdict succeeds
- [ ] Its result names the waiting delegations
- [ ] The routing report still counts missing verdicts
- [ ] Gate levels and gate actions unchanged
- [ ] Protocol text describes the reminding gate
- [ ] Tests use the real-session seam

## Blocked by

None, can start immediately.
