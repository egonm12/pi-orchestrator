---
# pi-orchestrator-k2xj
title: Labels on worker rows
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-28T14:30:23Z
updated_at: 2026-09-28T14:30:23Z
parent: pi-orchestrator-cml8
---

## Parent

pi-orchestrator-cml8 (user stories 21 to 27).

## What to build

Each item of the subagents tool gains an optional short `label`, such as `research: budget code`. The worker board keeps the label and the worker's tier. Worker rows in the widget, the /subagents picker, the transcript view's nested workers and the status output read label · tier · rung · state · elapsed · turns · activity. The name falls back from label to agent definition to `worker`; reviewers are always `reviewer`. Long labels are shortened to fit one line.

## Acceptance criteria

- [ ] Optional `label` in the subagents tool schema
- [ ] Rows show label · tier · rung · state · elapsed · turns · activity in widget, picker, transcript view and status
- [ ] Fallback to agent definition, then `worker`; reviewers always `reviewer`
- [ ] Long labels shortened to keep one line per worker
- [ ] Widget, render, picker and transcript-view tests with a real worker board and a plain theme, plus end-to-end board and widget tests

## Blocked by

None, can start immediately.
