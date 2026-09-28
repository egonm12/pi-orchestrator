---
# pi-orchestrator-ouoy
title: Failover on the first request
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T21:45:18Z
parent: pi-orchestrator-cml8
blocked_by:
    - pi-orchestrator-5inr
---

## Parent

pi-orchestrator-cml8 (user stories 42, 43, 45).

## What to build

The auto model detects a usage or rate-limit failure of a worker's first request, before any output, and pins the worker again to the next surviving rung, excluding that provider where another survives. A limit later in the run fails the worker cleanly. Both record a usage observation. The decision record gains failover entries linked to the refused attempt.

## Acceptance criteria

- [x] First-request usage-limit error repins the worker to the other provider
- [x] Failover recorded in the decision record, linked to the refused attempt
- [x] An exhausted or throttled observation is recorded
- [x] A mid-run limit fails the worker
- [x] Router extension tests with a provider double and a temporary state folder

## Blocked by

- 07 Usage store and error signals


## Summary of changes

- The auto model fails over on a worker's first request (`src/router/auto-provider.ts`). When a new live choice's rung answers with a limit error before any output, the refused attempt's decision stays recorded (it names the rung that was tried, `ranOn` included). Then the observation for that provider is written to the usage store, the task is routed again with the same classification and routing constraints, and the worker is pinned to the chosen rung. The exhausted or throttled provider is removed by the hard filter, so the new rung is always on another provider. A leading `start` event is held until the rung answers or refuses, so the worker never sees a second start or any of the refused rung's events. Several failovers in a row are possible; each refused provider is kept out, even if its observation has already lapsed.
- No failover when the limit comes after the rung's first output, on a later request of a pinned worker, for a restored or resumed pin, in shadow mode, after a refusal's session-model fallback, or when routing has no other provider's rung left (the session-model fallback is not used for a failover). The worker then gets the provider's error, and the usage observation is recorded as before.
- New record type `failover` (`src/routing/decision-record.ts`, `buildFailoverRecord`): `refusedAttempt` (the refused decision's timestamp and rung, same delegation id), `limit` (`exhausted` or `throttled`), `resetsAt` when the error states it, `detail` (the error text, redacted and cut like other free text) and `rung` (the rung it moved to). It is written together with the decision for the new rung when that rung's request produces its first event, in the same way as a first choice's pending decision and reservation. Validation names each bad field.
- Balancing counts a delegation once, for the provider of its latest pin, and a pending reservation overrides a committed decision of the same delegation (`src/router/route-task.ts`, `src/router/routing-choice-reservations.ts` `pendingRoutingChoices`). A failed-over delegation therefore counts where it ran, not on the provider that refused it.
- The worker board gets the refused rung and then the new one, as its rung history.
- Tests: router extension tests (`src/router/extension.test.ts`) with the scripted session registry as the provider double and a temporary state folder: a first-request usage limit fails over (one answer, no error, three linked records, one report row on the new rung, the pin kept, the next routing avoiding the provider), a start then a rate limit (no second start, a throttled failover, balancing after the throttle lifts), a mid-run limit and a later-request limit (no failover, output forwarded once, observation recorded), and no other provider left (the limit error, no failover record). Decision-record tests for the failover record's round trip and validation. The 5inr limit-text table now expects a failover; two 5inr tests use a mid-run limit so the worker still fails.
- CONTEXT.md: the pin entry names failover as the one way a pin moves, and a new term, failover.

## Documentation for the orchestrator (README not edited: another worker owns it)

- README "usage limits" paragraph (around the `usage-observations.json` list, line ~464): add that a limit error on a worker's first request, before any output, fails over to the next surviving rung on another provider, recorded as a failover record linked to the refused attempt; a limit later in the run, or with no other provider's rung left, fails the worker.
- README pin paragraph (line ~471): "The worker keeps the chosen rung as its pin" needs the failover exception.
- README state-folder table, `routing/*.jsonl` (line ~484): add failover records.
