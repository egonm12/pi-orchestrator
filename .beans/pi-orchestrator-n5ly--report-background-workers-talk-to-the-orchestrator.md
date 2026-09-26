---
# pi-orchestrator-n5ly
title: 'report: background workers talk to the orchestrator'
status: completed
type: feature
priority: normal
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:55:07Z
parent: pi-orchestrator-l1yp
blocked_by:
    - pi-orchestrator-399w
    - pi-orchestrator-3r8g
---

A worker-side `report` tool. Background workers get progress and question kinds; foreground workers progress only. Progress is shown in the TUI at once and reaches the orchestrator at its next turn without starting one. A question starts an orchestrator turn when idle and blocks the worker until a subagents_message reply, an abort or a /subagents stop; no time limit.

## Todo
- [x] Test: progress reaches the next turn without starting one
- [x] Test: a question starts a turn and blocks until the reply
- [x] Test: foreground workers have no question kind
- [x] README

## Summary of Changes

- New `src/subagents/report.ts`: the worker-side `report` tool (`kind` progress or question, `text`) as an inline extension, and `workerReports`, which delivers reports into the delegating session as `subagents-report` messages.
- Every worker gets `report`: `runWorker` takes a `reports` setup, loads the report extension and adds `report` to an agent definition's `tools:` list. Foreground workers get progress only; a background call's workers also get question.
- Progress: sent with `triggerTurn: false`, so it reaches the orchestrator at its next turn without starting one. An idle session shows the message at once; a busy one records it at the end of the turn, so the TUI shows a notification at once.
- Question: sent with `triggerTurn: true, deliverAs: "steer"` (supervisor decision), so it starts a turn when idle and arrives after the current tool call when busy. `BackgroundCalls.question` (replacing the unused `registerQuestion` seam) blocks the worker until the next `subagents_message`, and the tool's abort signal, fired by `/subagents stop`, a stopped call or session shutdown, releases it. One question at a time per worker.
- Supervisor decision: a question ends a pending `subagents_status` wait on its call with a hint to answer with `subagents_message` and wait again, and a new wait on a call with an unanswered question is refused with the same hint.
- Tests in `src/subagents/extension.test.ts`: progress shown at once and delivered without a turn, question with steer delivery, wait interruption, wait refusal and reply, stop and shutdown releasing a blocked question, and no question kind for foreground workers. Existing tool-list expectations now include `report`.
- README: new Reports section, a Status and wait bullet, and the agent definitions note that every worker gets `report`.
