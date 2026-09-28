---
# pi-orchestrator-z4cp
title: Reviewer prefers another provider
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-8tgr
---

## Parent

pi-orchestrator-cml8 (user story 34). ADR 0012.

## What to build

The reviewer's routing constraint gains a provider to avoid: the implementer's provider. It is a preference, not a hard filter, so when only the implementer's provider survives the reviewer still runs there.

## Acceptance criteria

- [ ] Reviewer prefers a rung from a different provider than the implementer's
- [ ] Falls back to the same provider when no other survives
- [ ] Review test covers both cases

## Blocked by

- 10 Balanced tier order
