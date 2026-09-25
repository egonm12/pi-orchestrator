---
# pi-orchestrator-71dw
title: One TUI line per worker
status: in-progress
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:19:26Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-k3l9
---

While workers run, show one line per worker: agent name, short task, and current tool or state (queued, running, done, error). Expanding shows the final text. A preserved-model worker also shows its model, marked when the ban-list exception applied.

## Todo
- [x] Render partial updates and the final result
- [ ] Check it by hand in an interactive session

Note: the hand check in an interactive session is left for the owner, so this bean stays in progress.

## Summary of changes

- New `src/subagents/render.ts`: `renderCall` shows a `subagents N tasks` header; `renderResult`, partial or final, shows one line per worker with its agent name (`worker` without one), its short task (first line, cut at 60 characters) and its current tool or state: queued, running, `running: <tool>`, done, error, aborted or not started. Expanded, each finished worker's final text or error follows its line. Lines wrap to the render width through pi's `truncateToVisualLines`, since pi-tui does not resolve from the package.
- `details.results[i].model?` and `details.results[i].banListException?` are optional fields on every result; the renderer shows the model and marks `(ban-list exception)` when present. bbge and ro35 fill them.
- The tool's `execute` sends partial updates through `onUpdate` with `SubagentsProgressDetails`: every item queued at the start, then running, running with its worker's current tool, and finished. `runWorker` takes an `onTool` callback fed by the worker session's tool execution events.
- Tests: `src/subagents/render.test.ts` covers the rendering as pure functions; a new test in `src/subagents/extension.test.ts` checks the partial updates of a real call whose workers call a tool. README documents the display.
