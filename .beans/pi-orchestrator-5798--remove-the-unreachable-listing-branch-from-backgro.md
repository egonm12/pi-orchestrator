---
# pi-orchestrator-5798
title: Remove the unreachable listing branch from BackgroundCalls.command
status: todo
type: task
tags:
    - ready-for-agent
created_at: 2026-09-27T13:58:27Z
updated_at: 2026-09-27T13:58:27Z
parent: pi-orchestrator-a338
---

Since xytd, `/subagents` without arguments opens the worker picker and every argument except `stop ...` is a direct jump, so only `stop` reaches `BackgroundCalls.command` (src/subagents/background.ts). Its `""` and `list` branch (the background-calls-only listing) can no longer be reached from the command. `listing()` itself is still used by subagents_status and stays. Remove the dead branch and its usage text, or make `command` only handle `stop`.

## Todo

- [ ] Remove the branch; tests for /subagents stop still pass unchanged
