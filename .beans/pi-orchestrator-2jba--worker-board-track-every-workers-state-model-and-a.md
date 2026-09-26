---
# pi-orchestrator-2jba
title: 'Worker board: track every worker''s state, model and activity'
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:36:41Z
parent: pi-orchestrator-a338
---

One in-process record of every worker of the orchestrator session, fed by the workers' event streams: foreground, background and nested (with parent delegation); worker state (queued, running, asking, completed, failed, aborted); agent; model and effort; for routed workers the rung serving the latest request, with rung history; elapsed time; turns; tokens and cost; current tool or latest text; and a change signal for views. Finished workers stay on the board for the session. Confirm first that the router's chosen rung can be read in-process; if it cannot, stop and report.

## Todo
- [x] Test: foreground, background and nested workers appear, nested with their parent
- [x] Test: queued, running, asking and each end state
- [x] Test: a routed worker's served rung, "routing" before the first request, escalation in the rung history
- [x] Test: turns, tokens, cost and current activity update; views get a change signal

## Rung gate

The rung the router chooses for a routed worker's request can be read in-process, with one small hook in the router.

- Every worker, foreground, background and nested, is a pi session in the orchestrator's process (ADR 0007). The router extension that the worker loads registers `orchestrator/auto` in the worker's model runtime, so `streamSimple` in `src/router/auto-provider.ts` resolves the pin for each request in the same process, keyed by `options.sessionId`, which is the delegation id.
- The assistant message's `provider` and `model` cannot be used: the provider relabels every reply `orchestrator/auto` (ADR 0006), so the session's events never name the rung. The pin map is private to the provider's closure, and the only outputs today are the probe line on stderr and the decision record file, which is written only for a new decision.
- So the provider publishes each served rung through a process-global registry on `globalThis` (`Symbol.for`), the pattern `setResumePin` and `markWorkerSession` already use, since pi loads each extension with a fresh module copy. The board listens there and matches the delegation id to its worker. A request whose session id is no worker's, such as a compaction summary request, is ignored.

What escalation means here: a worker keeps its pin for all its requests (ADR 0006, CONTEXT.md Pin), and a retry on the effort ladder is a new delegation, so it is never in one worker's history. Escalation is the glossary's term: the routing decision moved the task up from its classified tier because the hard filters emptied that tier (`route.startedAtTier` below `route.tier`). The board's rung history lists each rung that served the worker's requests in order, normally one, and marks an entry with the tiers it escalated from and to. A rung is published for a new decision, a reused recorded decision (which carries its escalation too), a resume pin and the session model fallback (refusal, shadow mode, router disabled); the last three carry no escalation.

## Summary of Changes

- `src/router/served-rungs.ts` (new): a process-global registry. `publishServedRung` and `watchServedRungs` carry `ServedRung { delegationId, model, effort, escalation? }`. `src/router/auto-provider.ts` publishes the pin on every request before forwarding it, with the escalation (`startedAtTier` to `tier`) of a new or reused live decision.
- `src/subagents/worker-board.ts` (new): `WorkerBoard`, the process's board `workerBoard()`, the read-only `WorkerBoardView` for views, `BoardWorker`, `WorkerModel` (`routing`, `routed` with its rung history, `fork`, `preserved`), `WorkerState`, `elapsedMs`, `LiveWorker`. The subagents extension feeds it through `add()`, which returns a `WorkerFeed` (`started`, `session`, `ended`), and through `asking()`. The board subscribes to each worker's own session events for turns, tokens, cost, current tool and latest text, and hears served rungs through the registry. Views call `subscribe()` for the change signal, and `live(id)` gives a running worker's messages and events for the later transcript view.
- `src/subagents/worker.ts`: a new `onSession` hook hands over the delegation id, session file, effort, messages and events before the first request.
- `src/subagents/extension.ts`: every item goes on the board when it is queued. It starts with its model (fork, preserved, resume pin), ends through `showProgress` or as aborted when it never started, and shows as asking while a background question waits. The orchestrator's `session_start` starts the board for its session; a worker's own copy of the extension shares it.
- `src/subagents/resume.ts`: a resume says whether the delegation is a fork's, so a resumed fork shows its fixed model.
- Choices: one entry per run, so a resume is a new entry with the same delegation id and `byDelegation` gives the latest. An item aborted while still queued ends aborted, with no start time. A new orchestrator session (not a reload) empties the board.
- Tests: 7 in `worker-board.test.ts`, 4 new plus 1 extended in `extension.test.ts` (real foreground, background, nested, forked and preserved workers, the routed rung and an escalation end to end).
- Follow-up to consider: `subagents_status` (background.ts) still works out turns, text and elapsed time from `onActivity`. It could read the board instead, which would remove the duplicated event reading in worker.ts. The board is user-invisible, so README.md is unchanged.
