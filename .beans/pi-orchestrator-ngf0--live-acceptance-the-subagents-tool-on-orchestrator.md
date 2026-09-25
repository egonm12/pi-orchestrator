---
# pi-orchestrator-ngf0
title: 'Live acceptance: the subagents tool on orchestrator/auto'
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:47:00Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-k3l9
---

Behind PI_ORCHESTRATOR_LIVE=1: a real session with pi-orchestrator and one noisy extension (see 5he0) runs two parallel workers through `subagents` and asserts their decision records and results.

## Todo
- [x] Live test
- [x] Run it once and record the result

## Summary of changes

- `src/fixtures/noisy-extension.ts`: a throwaway pi package standing in for an extension like context-mode (bean 5he0). Its one extension appends a plain `{role: "user"}` message with a "Purge" anchor through pi's `context` hook, after the delegated prompt. It logs one line per `context` event to `PI_NOISY_EXTENSION_LOG`, so a test can tell the noise really fired.
- `src/acceptance/subagents-acceptance.test.ts`: behind `PI_ORCHESTRATOR_LIVE=1`, a real `pi -p` session with this checkout (no pi-subagents) and the noisy extension installed as packages. One `subagents` call carries two items (both under the default `maxParallel` of 4, so both workers start together), each a known-mechanical reformat task. Assertions: both results are `completed` with the stub worker's `ACK` reply, in item order; exactly one decision record per worker's session id, `mode` live, `taskTextPrefix` equal to that item's task text only (no "Purge" text), `classification.floorSignals` empty, tier `mechanical`, `ranOn` the mechanical rung; the auto provider's request-probe line names that rung for that worker's session id; the noisy extension's log file has at least one line per worker, so the assertions above are not vacuous. A provider refusal is a skip, never a pass.
- Without `PI_ORCHESTRATOR_LIVE=1` the test skips (`credentialsAvailable()`), so `npm test` stays offline and green; confirmed with `npm test` (539 tests, 522 pass, 17 skip, 0 fail) and `npm run typecheck`.

## To run the live test

`PI_ORCHESTRATOR_LIVE=1 node --test src/acceptance/subagents-acceptance.test.ts`

Not run live here, and the second todo item is left unchecked: the orchestrator runs it after merging.

## Live run

- Date: 2026-09-26.
- Model: anthropic/claude-haiku-4-5 for the orchestrator session (`--thinking off`), the classifier (`anthropic/claude-haiku-4-5:off`) and every rung of the tier map.
- Result: pass, 3 of 3 (the test and its two subtests), in 7.5 s.
- Decision records: 2, one per worker session (01a0dabf-c12b-7128-996d-50048a061446 and 01a0dabf-c12b-7128-996d-500781b21d9c). Both mode live, tier mechanical, no floor signals, task text equal to the item's own task (no "Purge" text), chosen rung and `ranOn` anthropic/claude-haiku-4-5:low, confirmed by the auto provider's request probe line.
- Both workers completed with ACK, results in item order. The noisy extension fired 4 times.
- First attempt failed with `no subagents call: []`: the test passed `-t subagent` (pi-subagents' tool name, copied from routing-acceptance.test.ts) to pi's tool allowlist, so the orchestrator session had no active tool and the model never called one. Fixed by passing `SUBAGENTS_TOOL` (`subagents`) to `-t` and matching events on the same constant. The failure message now also shows the session's event types, assistant text and errors, and pi's stderr tail.
