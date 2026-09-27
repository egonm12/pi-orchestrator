---
# pi-orchestrator-vo0z
title: Transcript header and orchestrator bar
status: completed
type: feature
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-27T13:41:21Z
parent: pi-orchestrator-a338
blocked_by:
    - pi-orchestrator-llnk
---

The transcript view's header: agent, worker state, elapsed time, turns, model and effort with rung history, tokens and cost, delegation id and parent delegation, first line of the task. A top bar shows the orchestrator's state (running or idle) and any asking workers, updated live; the view never pulls the user out.

## Todo
- [x] Test: header fields, rung history, the parent of a nested worker
- [x] Test: the bar shows orchestrator state and asking workers, updates live, never closes the view
- [x] README

## Decisions
- **Header layout:** four lines, each cut to the width. (1) agent · worker state · elapsed · turns · tokens · cost · worker n of m, the progress parts only once the worker has started; (2) model and effort: a routed worker's rung history (`model:effort since HH:MM:SS (escalated from <tier> to <tier>)`, joined with `, then `), `routing…` before its first request, a fork's or preserved model's fixed model with why it is not routed; (3) delegation id and, for a nested worker, `parent delegation <id> (<parent's agent>)`, or `no delegation id yet` for a queued foreground worker; (4) the task's first non-empty line, whitespace collapsed.
- **Formats:** tokens are the total (input, output and cache together) as `850`, `12.3k`, `456k` or `1.2M`; cost as `$0.042`, like pi's footer; elapsed as the widget's `12s`, `3m04s`, `1h02m`; rung times in local time.
- **Narrow terminals:** the rung history drops its oldest rungs first behind `… then `, always keeping the rung serving the latest request; delegation ids shrink to their first 8 characters plus `…` when the full line does not fit; every other line is cut at the end with an ellipsis, so the stats line loses "worker n of m" and then cost first and keeps agent and worker state. The bar puts the asking count before the names so a cut keeps it.
- **The bar:** one line, `orchestrator running|idle`, then `N worker(s) asking: worker 2 (reviewer), worker 3`: asking workers by their place among the board's workers, the number "worker n of m" and ←→ use. Read-only: it has no key and never closes or moves the view. It is `openTranscript`'s default bar (`orchestratorBar` in transcript-header.ts), so xytd's openers get it without options.
- **Where the orchestrator state lives:** on the worker board (`WorkerBoard.setOrchestratorState` / `orchestratorState()`, in `WorkerBoardView`), so the view has one subscription. A change signals listeners with `undefined` (not one worker). A new orchestrator session resets it to idle; a reload of the same session keeps it.
- **What feeds it:** the subagents extension's `agent_start` (running) and `agent_settled` (idle) handlers, only when `!isWorkerSession(ctx)`: a worker whose agent definition lists subagents loads its own copy of the extension, which hears the worker's runs. `agent_settled` rather than `agent_end`, since pi fires it once no retry, compaction or queued continuation will run, so the bar does not flicker idle between them.
- **Timer:** the view redraws every second while open (unref'd setInterval, injectable through `setInterval` / `clearInterval` options, cleared on close), so elapsed time ticks.

## Summary of Changes
- New `src/subagents/transcript-header.ts`: `transcriptHeader` (the default header above), `orchestratorBar` (the default bar), `formatTokens`, `formatCost`.
- `src/subagents/transcript-view.ts`: the frame carries the board's workers and the orchestrator state; header and bar default to transcript-header.ts; a 1 s redraw timer while open (new `setInterval` / `clearInterval` options).
- `src/subagents/worker-board.ts`: `OrchestratorState`, `setOrchestratorState`, `orchestratorState` (added to `WorkerBoardView`); a new session starts idle.
- `src/subagents/extension.ts`: `agent_start` / `agent_settled` handlers feed the board from the orchestrator's session only.
- `src/subagents/worker-widget.ts`: `formatElapsed`, `oneLine`, `fitted` and `Part` exported for the header.
- Tests: header fields, rung history, nested parent, short ids, token and cost formats, the bar (content, live, stays open, keys still work), the timer (transcript-view.test.ts); the board's orchestrator state (worker-board.test.ts); the state fed from the orchestrator's events and not a worker's (extension.test.ts); the existing transcript view tests in extension.test.ts read the header under the bar.
- README: the transcript view's bar and header fields, with an example.
