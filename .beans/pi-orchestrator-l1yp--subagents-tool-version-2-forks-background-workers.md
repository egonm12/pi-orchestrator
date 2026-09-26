---
# pi-orchestrator-l1yp
title: 'Subagents tool version 2: forks, background workers, resume, nesting (ADR 0008)'
status: completed
type: epic
priority: normal
created_at: 2026-09-26T08:12:34Z
updated_at: 2026-09-26T08:56:44Z
---

Version 2 of the built-in subagents tool, settled in the grilling session of 2026-09-26. See docs/adr/0008-forked-and-background-workers.md and CONTEXT.md (forked worker, background worker, report, parent delegation).

## Summary of Changes

All seven child beans are built and merged into main, in three waves:

- Wave 1: rc8i (forked workers on the session model), 399w (background calls, completion notice, `/subagents`, `maxBackgroundWorkers`), 76jj (resume a finished worker) and qdz9 (nested delegation).
- Wave 2: 2vox (`subagents_status` snapshot and wait) and 3r8g (`subagents_message` steer or follow-up).
- Wave 3: n5ly (`report` tool for progress and questions from workers).

Integration work done while merging:

- zuce: a worker's call refuses fork items, and a fork never gets the `subagents` tool.
- A background call picks its delegation ids before forks are copied, so a background fork's session id is its delegation id.
- A resume item skips fork setup, keeps its own delegation id in a background call, and resumes a fork on its fork record's pin.

Each piece has its own tests. On main, `npm run typecheck` passes and `npm test` has 591 passing, 0 failing and 17 skipped.

Follow-ups left open under this epic: ap9b (background calls fail invalid items before returning delegation ids) and fvul (budget preflight for preserved-model workers).
