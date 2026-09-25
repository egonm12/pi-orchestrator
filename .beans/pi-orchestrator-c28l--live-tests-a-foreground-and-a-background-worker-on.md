---
# pi-orchestrator-c28l
title: 'Live tests: a foreground and a background worker on orchestrator/auto'
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T20:08:03Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-ihm0
    - pi-orchestrator-rowk
---

## Parent

pi-orchestrator-6nhd

## What to build

Seam 2: a real `pi -p` session on Haiku, with pi-subagents and pi-orchestrator installed in a throwaway agent dir, starts one foreground and one background worker on `orchestrator/auto`. A third case forces compaction on a worker. Runs only with `PI_ORCHESTRATOR_LIVE=1`.

## Acceptance criteria

- [x] Both workers answer, and pi-subagents reports no model verification failure
- [x] The state folder holds one record per worker, keyed by each worker's session id, with `ranOn` equal to the chosen rung
- [x] The forced-compaction case finishes on the same rung after one compaction
- [x] Without `PI_ORCHESTRATOR_LIVE=1` the tests are skipped, not passed
- [x] Only Haiku runs

## Blocked by

- pi-orchestrator-ihm0
- pi-orchestrator-rowk

## Summary of Changes

- New live test file `src/router/auto-model-session.test.ts` (seam 2, only with `PI_ORCHESTRATOR_LIVE=1`). Each case starts a real `pi -p` session on Haiku in a throwaway agent dir that lists the Anthropic login package, the installed pi-subagents 0.71.0 and this checkout as packages (nothing copied, the real agent dir only read), with pi-subagents' `subagents.defaultModel` set to `orchestrator/auto`.
- Case 1: one foreground and one background worker answer, pi-subagents reports no model verification failure, and the state folder holds one decision record per worker keyed by its session id with `ranOn` equal to the rung the probe line saw. The background worker is routed in pi-subagents' separate runner process.
- Case 2: a worker on a small-window dated Haiku rung stops at `length`; pi compacts once and retries (no new user turn), and every request, including the retry, goes to the same pinned rung.
- Only Haiku runs: the tier map, classifier (`:off`) and parent are Haiku, and the test asserts it. Without the flag both cases report as skipped.
- The test agent files also pin `model: orchestrator/auto` while the old `tool_call` hook exists (it would rewrite `defaultModel`); itu1 removes the pin.
- Implemented by claude (opus-5-5), reviewed by codex (gpt-6-sol): BLOCK (threshold compaction is not retried), fixed with the recoverable-length path; re-check OK. Parent live runs: 2 pass, 0 fail.
- Residual: a provider-reported overflow error is covered offline (rowk), not live; token margins of case 2 are printed per run for re-tuning.
