---
# pi-orchestrator-ol6t
title: Init, the fresh-install notice and the README for the auto model
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:55Z
updated_at: 2026-09-25T20:46:16Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-bjyw
    - pi-orchestrator-bmid
    - pi-orchestrator-itu1
---

## Parent

pi-orchestrator-6nhd

## What to build

`/pi-orchestrator init` and the fresh-install notice add one line telling the owner to make `orchestrator/auto` the default worker model in their subagent extension; init edits no other extension's settings. The README describes the auto model, the main thread rule, pins, the fallback, background workers needing an installed package, and the setup step.

## Acceptance criteria

- [x] Init and the fresh-install notice show the line, and init writes no other extension's settings
- [x] The README covers the auto model, the main thread rule, pins, the fallback and the setup step, in the CONTEXT.md vocabulary
- [x] The README no longer describes `subagent` call rewriting

## Blocked by

- pi-orchestrator-bjyw
- pi-orchestrator-bmid
- pi-orchestrator-itu1

## Summary of Changes

- `/pi-orchestrator init` and the fresh-install notice end with one line telling the owner to make `orchestrator/auto` the default worker model in their subagent extension (for pi-subagents, `subagents.defaultModel`). Init writes no other extension's settings; tests check an existing `subagents` key stays untouched and an absent one stays absent.
- README: describes the auto model, the main thread rule (including a saved `orchestrator/auto` default being put back), pins and resume in live mode, the fallback to the orchestrator's model and when it is refused, that the router extension sets `PI_ORCHESTRATOR_SESSION_MODEL` itself, shadow and live mode, background workers needing an installed package, the per-session task allowance, and the setup step. It no longer describes `subagent` call rewriting.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): OK with notes, all fixed.
