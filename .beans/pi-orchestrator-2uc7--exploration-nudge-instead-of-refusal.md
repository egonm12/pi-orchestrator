---
# pi-orchestrator-2uc7
title: Exploration nudge instead of refusal
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 1 to 9, and the nudge part of 20). ADR 0013.

## What to build

Exploratory calls by the orchestrator are never denied. The same counting as today (read-only and unrecognised calls per user prompt, reset at a user prompt whose source is not `extension`, workers not counted) now drives an exploration nudge appended to the call's result once the count passes the setting, such as `4 exploratory calls this prompt: consider handing the rest to a worker.` The setting is `orchestrator.subagents.explorationNudge` (positive integer, default 3), and the old `explorationBudget` key is read when the new key is absent. The `/pi-orchestrator budget` subcommand is removed. The protocol text describes the nudge instead of a refusal.

## Acceptance criteria

- [ ] Exploratory calls beyond the setting succeed and their result carries the nudge with the call count
- [ ] A new user prompt resets the count; an extension-sourced prompt does not
- [ ] Workers are never nudged
- [ ] `explorationNudge` setting with default 3; old `explorationBudget` key used when the new one is absent (unit test)
- [ ] `/pi-orchestrator budget` subcommand removed
- [ ] Protocol text describes the nudge, not a refusal
- [ ] Tests use the real-session seam (`orchestratorSession` with a scripted fake provider)

## Blocked by

None, can start immediately.
