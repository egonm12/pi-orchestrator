---
# pi-orchestrator-k3l9
title: Parallel workers with a concurrency limit and abort
status: completed
type: feature
priority: normal
created_at: 2026-09-25T21:42:44Z
updated_at: 2026-09-25T22:14:04Z
parent: pi-orchestrator-6bam
blocked_by:
    - pi-orchestrator-0rng
---

One call takes up to 8 items; at most `orchestrator.subagents.maxParallel` (default 4) run at once, the rest queue. Abort (Ctrl+C) stops running and queued workers.

## Todo
- [x] Test: 8 items with maxParallel 2 never run more than 2 at once, results keep item order
- [x] Test: more than 8 items is refused
- [x] Test: abort marks running items aborted and queued items not started

## Summary of changes

• The subagents tool accepts 1 to 8 {task} items and returns one result per item in input order. Invalid item counts are refused.
• Worker calls use a bounded queue with maxParallel defaulting to 4. Personal settings may enable project overrides. Abort stops running workers and leaves queued items not started.
• Integration tests cover the concurrency limit, item order, refused counts, abort, default limit and project override permission. Typecheck and full test suite pass with no failures.
