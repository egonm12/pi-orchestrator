---
# pi-orchestrator-3kau
title: Move the routing acceptance gate to the auto model
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T20:22:10Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-bjyw
    - pi-orchestrator-c28l
---

## Parent

pi-orchestrator-6nhd

## What to build

The live routing acceptance gate runs its workers on `orchestrator/auto` instead of relying on `subagent` call rewriting. It keeps the same six classifications, the shadow case and the refusals by hard filters. The verdict parts are skipped until verdicts can be linked to decision records.

## Acceptance criteria

- [x] The six classifications (two mechanical, two standard, two critical) pass with workers on `orchestrator/auto`
- [x] The shadow case runs the worker on the orchestrator's model and records the rung the router would have chosen
- [x] The refusal cases fall back to the orchestrator's model and are recorded
- [x] Verdict cases are reported as skipped

## Blocked by

- pi-orchestrator-bjyw
- pi-orchestrator-c28l

## Summary of Changes

- `src/acceptance/routing-acceptance.test.ts`: the live gate's workers run on `orchestrator/auto` through the auto model provider, not `subagent` call rewriting. The throwaway agent dir lists the Anthropic login package, pi-subagents and this checkout as packages with `subagents.defaultModel` set to `orchestrator/auto`; the worker agent file also pins the auto model until itu1 removes the `tool_call` hook.
- Each worker's decision record is found by the session id in its session file, and the probe line confirms the rung that served it (`ranOn`).
- Kept: the six classifications (two mechanical, two standard, two critical), the project override with the banned Fable rung, Codex out of usage, the emptied top tier refusing and falling back to the orchestrator's model (recorded with `ranOn` equal to it), shadow on the orchestrator's model recording the would-be rung, the banned-model guard refusal, and the report. Verdict reviews are a skipped subtest until verdicts can be linked to decision records.
- Every probed request rung is asserted to be Haiku; the launch cap is the real count, 13.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): OK with notes, all fixed. Parent live runs: 12 pass, 1 skipped (verdicts), 0 fail.
