---
# pi-orchestrator-3r8g
title: 'subagents_message: steer a background worker'
status: completed
type: feature
priority: normal
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:41:29Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-399w
---

Tool `subagents_message({ id, text, mode: "steer" | "followUp" })`, default steer, to one delegation only. Steer arrives after the worker's current tool call; followUp when it would stop. Also how the orchestrator answers a report question. Refused for a finished or foreground worker. Workers do not get this tool.

## Todo
- [x] Test: steer and followUp reach the worker at the right point
- [x] Test: refused for finished, foreground and unknown delegations
- [x] README

## Summary of Changes

Added `subagents_message` for running background workers, using pi's steer and follow-up queues and a direct reply seam for a blocking report question. Covered delivery timing, refusal cases and worker tool isolation in the subagents integration tests, and documented usage in README.md.
