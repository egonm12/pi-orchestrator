---
# pi-orchestrator-ojjh
title: 'Live auto model test: Haiku sometimes makes extra subagent calls'
status: todo
type: task
tags:
    - needs-triage
created_at: 2026-09-25T20:51:25Z
updated_at: 2026-09-25T20:51:25Z
---

src/router/auto-model-session.test.ts 'a foreground and a background worker...' failed once in a full PI_ORCHESTRATOR_LIVE=1 run with 5 subagent calls instead of 2, and passed on two reruns. Consider making the parent prompt stricter or asserting on the first two calls.
