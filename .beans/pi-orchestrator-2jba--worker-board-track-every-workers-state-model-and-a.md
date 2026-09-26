---
# pi-orchestrator-2jba
title: 'Worker board: track every worker''s state, model and activity'
status: todo
type: feature
tags:
    - ready-for-agent
created_at: 2026-09-26T09:18:43Z
updated_at: 2026-09-26T09:18:43Z
parent: pi-orchestrator-a338
---

One in-process record of every worker of the orchestrator session, fed by the workers' event streams: foreground, background and nested (with parent delegation); worker state (queued, running, asking, completed, failed, aborted); agent; model and effort; for routed workers the rung serving the latest request, with rung history; elapsed time; turns; tokens and cost; current tool or latest text; and a change signal for views. Finished workers stay on the board for the session. Confirm first that the router's chosen rung can be read in-process; if it cannot, stop and report.

## Todo
- [ ] Test: foreground, background and nested workers appear, nested with their parent
- [ ] Test: queued, running, asking and each end state
- [ ] Test: a routed worker's served rung, "routing" before the first request, escalation in the rung history
- [ ] Test: turns, tokens, cost and current activity update; views get a change signal
