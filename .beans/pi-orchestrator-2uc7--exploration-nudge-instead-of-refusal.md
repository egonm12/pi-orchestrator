---
# pi-orchestrator-2uc7
title: Exploration nudge instead of refusal
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T15:37:46Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 1 to 9, and the nudge part of 20). ADR 0013.

## What to build

Exploratory calls by the orchestrator are never denied. The same counting as today (read-only and unrecognised calls per user prompt, reset at a user prompt whose source is not `extension`, workers not counted) now drives an exploration nudge appended to the call's result once the count passes the setting, such as `4 exploratory calls this prompt: consider handing the rest to a worker.` The setting is `orchestrator.subagents.explorationNudge` (positive integer, default 3), and the old `explorationBudget` key is read when the new key is absent. The `/pi-orchestrator budget` subcommand is removed. The protocol text describes the nudge instead of a refusal.

## Acceptance criteria

- [x] Exploratory calls beyond the setting succeed and their result carries the nudge with the call count
- [x] A new user prompt resets the count; an extension-sourced prompt does not
- [x] Workers are never nudged
- [x] `explorationNudge` setting with default 3; old `explorationBudget` key used when the new one is absent (unit test)
- [x] `/pi-orchestrator budget` subcommand removed
- [x] Protocol text describes the nudge, not a refusal
- [x] Tests use the real-session seam (`orchestratorSession` with a scripted fake provider)

## Blocked by

None, can start immediately.


## Summary of changes

- `src/subagents/exploration-nudge.ts` replaces `exploration-budget.ts`. The same counting (read-only and unrecognised calls per user prompt, reset at a user prompt whose source is not `extension`, only the orchestrator's own session) is done in `tool_call`, and never blocks. In `tool_result`, each counted call past the setting gets a text part appended to its result: `<n> exploratory calls this prompt: consider handing the rest to a worker.`
- `/pi-orchestrator budget` is removed; `/pi-orchestrator gate` stays.
- Settings: `orchestrator.subagents.explorationNudge`, a positive integer, default 3. When it is absent, the old `explorationBudget` key is read, and a bad value is named by the key it came from.
- The protocol's exploration paragraph now describes the nudge and says no call is denied. The gate paragraph and the protocol's delivery are unchanged (tickets 02 and 03).
- Tests: the real-session tests in `extension.test.ts` use `orchestratorSession` with a scripted fake provider. Counting coverage proves that `read` and a `git show` spot check count, as does an unrecognised bash call; `node --test`, `git commit`, and a `subagents` delegation do not. Other cases prove calls past the setting succeed and carry the nudge with the count, a new user prompt resets while `sendUserMessage` and a `sendMessage` run with `triggerTurn` count on, workers, forked workers and a pi-subagents child are never nudged, and `budget` is an unknown subcommand. The class-level `exploration-budget.test.ts` is removed. `settings.test.ts` covers the new key and the old one.
- README describes the exploration nudge and the new settings key. CONTEXT.md already defined the exploration nudge.
