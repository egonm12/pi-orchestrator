---
# pi-orchestrator-kdo3
title: 'Live guard test: the fable subagent call is not refused'
status: todo
type: bug
tags:
    - needs-triage
created_at: 2026-09-25T20:51:25Z
updated_at: 2026-09-25T20:51:25Z
---

src/guard/session.test.ts, 'live guard handles six tool calls in one Haiku session', fails with PI_ORCHESTRATOR_LIVE=1: the second call (subagent, model anthropic/claude-fable-5) comes back as a launched async worker instead of 'prohibited model: anthropic/claude-fable-5'. It fails the same way at 10f1c69, before epic pi-orchestrator-6nhd, so it is not caused by the auto model work. Check whether Haiku drops the model field or whether pi-subagents 0.71.0 changed how the call reaches the guard.
