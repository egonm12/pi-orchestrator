---
# pi-orchestrator-399w
title: Background calls with a completion notice
status: completed
type: feature
priority: normal
created_at: 2026-09-26T08:12:55Z
updated_at: 2026-09-26T08:29:24Z
parent: pi-orchestrator-l1yp
---

`background: true` on a call returns at once with the delegation ids and call id. When every item finishes, one completion notice with the same result text as a foreground call is delivered as a follow-up that starts a turn if idle. Each call keeps its own maxParallel. `orchestrator.subagents.maxBackgroundWorkers` (default 8) refuses a call that would exceed it. Ctrl+C leaves background workers running; a `/subagents` command lists and stops them; session shutdown aborts them (status aborted). Nested calls cannot be background.

## Todo
- [x] Test: a background call returns ids at once and delivers one notice when all items finish
- [x] Test: the cap refuses a call with the reason
- [x] Test: Ctrl+C does not stop background workers; shutdown aborts them
- [x] /subagents list and stop
- [x] README

## Summary of Changes

- New `src/subagents/background.ts`: `BackgroundCalls`, one per orchestrator session. It chooses each item's delegation id up front, gives each call its own abort signals (the tool's signal, which Ctrl+C fires, never reaches background workers), counts queued and running background workers for the cap, delivers one completion notice per call, runs the `/subagents` command (`list`, `stop <call id | delegation id | all>`), and at session shutdown aborts every call and records its notice without starting a turn.
- `src/subagents/extension.ts`: a `background` parameter; a background call is refused inside a worker's session and when it would exceed `maxBackgroundWorkers`; it returns at once with its call id and delegation ids (`SubagentsBackgroundDetails`), and its notice (custom message `subagents-completion`, the foreground result text headed by the call id) is sent as a follow-up that starts a turn when idle. The `/subagents` command and a `session_shutdown` handler are registered. The queue loop is unchanged apart from the signals it reads and the preset session id.
- `src/subagents/worker.ts`: `WorkerSetup.sessionId` presets the worker's session id.
- `src/subagents/settings.ts`: `orchestrator.subagents.maxBackgroundWorkers`, default 8, a positive integer.
- `src/subagents/render.ts`: `shortTask` exported for the `/subagents` listing.
- README: a background calls section, the new setting, and the updated limits.
- Tests in `src/subagents/extension.test.ts` (background call ids and notices with per-call maxParallel, the cap, Ctrl+C and shutdown, `/subagents` list and stop, no background call from a worker) and `src/subagents/settings.test.ts`.
- Follow-up: pi-orchestrator-ap9b (validate items before a background call returns its delegation ids).
