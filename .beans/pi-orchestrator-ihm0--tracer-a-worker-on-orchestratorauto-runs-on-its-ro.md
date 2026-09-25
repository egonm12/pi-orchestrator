---
# pi-orchestrator-ihm0
title: 'Tracer: a worker on orchestrator/auto runs on its routed rung'
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T19:14:43Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-j27y
---

## Parent

pi-orchestrator-6nhd

## What to build

pi-orchestrator registers the auto model `orchestrator/auto`. A worker started on it has its first request classified from the user text before its first reply, routed through the tier map and hard filters, recorded with the worker's session id as delegation id, and pinned. Every request of that worker goes to the pinned rung through the session's model registry with the rung provider's own login, with the rung's effort instead of any requested thinking level. Replies are labelled `orchestrator/auto`, and earlier replies are relabelled as the rung when forwarded. The agent role comes from an `<active_agent>` tag when present. Under `PI_ORCHESTRATOR_ROUTER_PROBE=1` each routed request prints its rung, pin and timing. The old `subagent` call rewriting keeps working for calls that name no model.

## Acceptance criteria

- [x] A worker started with model `orchestrator/auto` in live mode runs on the chosen rung, shown by a seam-1 test driving the registered provider
- [x] The second and later requests with the same `sessionId` go to the pinned rung without a new classification
- [x] The forwarded request carries no `apiKey` or `headers` meant for `orchestrator`, and carries the rung's effort
- [x] Streamed events, the final message and errors are labelled `orchestrator/auto`; earlier `orchestrator/auto` replies are forwarded labelled as the rung
- [x] Usage and cost in the reply are the rung's
- [x] One `decision-record/3` record per classified session, keyed by the session id, with `ranOn` equal to the rung
- [x] Existing `tool_call` routing tests still pass

## Blocked by

- pi-orchestrator-j27y

## Summary of Changes

- The router extension registers the `orchestrator` provider with one model, `auto` (`src/router/auto-provider.ts`, streaming helper `src/router/auto-stream.ts`).
- A worker's first request (no pin for its `sessionId`) takes the task from the user text before the first assistant message and the role from an `<active_agent>` tag in the system message's text parts or prompt sections, is classified and routed through the shared `routeTask` (`src/router/route-task.ts`, also used by the old `planSlot`), writes one `decision-record/3` record with the session id as delegation id and `ranOn` equal to the rung, and is pinned.
- Every request goes to the pinned rung through the session model registry without the `apiKey` and `headers` resolved for `orchestrator`, with the rung's effort clamped by `streamReasoning` (`off` sends no reasoning). Earlier `orchestrator/auto` replies are relabelled as the rung inward; partials, final messages and errors are labelled `orchestrator/auto` outward, with the rung's usage and cost. A stream that ends without a final event settles with an error.
- `PI_ORCHESTRATOR_ROUTER_PROBE=1` prints each routed request's rung, pin and timing. The `tool_call` routing is unchanged.
- Seam-1 tests in `src/router/extension.test.ts` drive the registered provider, one test per behaviour.
- Implemented by codex (gpt-6-sol), reviewed by claude (opus-5-5): BLOCK on the role source and effort clamp, fixed, re-check OK with notes.
- Known limits left for later tickets: shadow mode, routing not enabled and refusals end with a stream error until bjyw; the declared context window is fixed until rowk; resumed pins are kqli. Abort is passed to the rung call but not to classification, and a consumer that stops iterating does not cancel the rung stream.
