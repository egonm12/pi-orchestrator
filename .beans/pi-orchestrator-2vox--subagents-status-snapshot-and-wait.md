---
# pi-orchestrator-2vox
title: 'subagents_status: snapshot and wait'
status: completed
type: feature
priority: normal
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:46:07Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-399w
---

Tool `subagents_status({ id?, wait? })`. Without id: this session's background calls. With a call id: a snapshot per item; with a delegation id: one item. A snapshot holds state, current tool, turn count, elapsed time, the last lines of text and the session file. `wait: true` blocks until the call finishes and returns its results; that call's completion notice is then not delivered. Ctrl+C during a wait stops only the wait. Workers do not get this tool.

## Todo
- [x] Test: list, call snapshot and delegation snapshot
- [x] Test: wait returns results and suppresses the notice
- [x] Test: Ctrl+C stops the wait, not the workers
- [x] README

## Summary of Changes

- New `src/subagents/status.ts`: the `subagents_status` tool. Without `id` it shows the `/subagents list` listing; with a call id a snapshot per item, with a delegation id one item. With a call id and `wait: true` it returns the call's completion notice text and details instead of delivering the notice. The tool's abort signal (Ctrl+C) stops only the wait. `wait` needs a call id; a delegation id or no id is refused.
- `src/subagents/background.ts`: `BackgroundCalls` tracks each item's worker activity (turns, latest text, session file, start and end time), and gains `snapshots(id?)`, `wait(id, signal)` and a public `listing()` (was `#list`). A finished call's notice goes to its pending waits when there are any, otherwise to the session.
- `src/subagents/worker.ts`: `runWorker` reports `WorkerActivity` through a new `onActivity` option when the worker starts, on each turn start and assistant text update, and when it ends.
- `src/subagents/agent-definitions.ts`: a definition's `tools:` list never keeps `subagents_status`, so workers do not get it.
- `src/subagents/extension.ts`: registers the tool and passes `onActivity` to both `runWorker` calls.
- Tests in `src/subagents/extension.test.ts`; README section Status and wait.
