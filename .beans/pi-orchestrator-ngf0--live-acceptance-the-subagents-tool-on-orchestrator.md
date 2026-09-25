---
# pi-orchestrator-ngf0
title: 'Live acceptance: the subagents tool on orchestrator/auto'
status: in-progress
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:28:25Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-k3l9
---

Behind PI_ORCHESTRATOR_LIVE=1: a real session with pi-orchestrator and one noisy extension (see 5he0) runs two parallel workers through `subagents` and asserts their decision records and results.

## Todo
- [x] Live test
- [ ] Run it once and record the result

## Summary of changes

- `src/fixtures/noisy-extension.ts`: a throwaway pi package standing in for an extension like context-mode (bean 5he0). Its one extension appends a plain `{role: "user"}` message with a "Purge" anchor through pi's `context` hook, after the delegated prompt. It logs one line per `context` event to `PI_NOISY_EXTENSION_LOG`, so a test can tell the noise really fired.
- `src/acceptance/subagents-acceptance.test.ts`: behind `PI_ORCHESTRATOR_LIVE=1`, a real `pi -p` session with this checkout (no pi-subagents) and the noisy extension installed as packages. One `subagents` call carries two items (both under the default `maxParallel` of 4, so both workers start together), each a known-mechanical reformat task. Assertions: both results are `completed` with the stub worker's `ACK` reply, in item order; exactly one decision record per worker's session id, `mode` live, `taskTextPrefix` equal to that item's task text only (no "Purge" text), `classification.floorSignals` empty, tier `mechanical`, `ranOn` the mechanical rung; the auto provider's request-probe line names that rung for that worker's session id; the noisy extension's log file has at least one line per worker, so the assertions above are not vacuous. A provider refusal is a skip, never a pass.
- Without `PI_ORCHESTRATOR_LIVE=1` the test skips (`credentialsAvailable()`), so `npm test` stays offline and green; confirmed with `npm test` (539 tests, 522 pass, 17 skip, 0 fail) and `npm run typecheck`.

## To run the live test

`PI_ORCHESTRATOR_LIVE=1 node --test src/acceptance/subagents-acceptance.test.ts`

Not run live here, and the second todo item is left unchecked: the orchestrator runs it after merging.
