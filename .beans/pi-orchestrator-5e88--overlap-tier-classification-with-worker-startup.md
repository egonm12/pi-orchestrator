---
# pi-orchestrator-5e88
title: Overlap tier classification with worker startup
status: in-progress
type: task
created_at: 2026-10-09T16:00:31Z
updated_at: 2026-10-09T16:00:31Z
---

Start classifyTask when the worker is created, not at its first request (src/router/auto-model.ts:399). Expected gain 0.7-1.8 s per routed worker.

## Todo

- [x] Worker runtime hands a routed worker's task to its router before binding extensions (setPendingTask)
- [x] Router starts classifyTask at the worker's session_start; first request awaits it inside firstRoute, before the choice queue
- [x] Early classification used only when task text, agent role and router match the first request's; else classify as before
- [x] Failure handling unchanged (deps.disable + fallback pin), no unhandled rejection
- [x] Tests in src/router/extension.test.ts; typecheck and full test suite pass
- [ ] Measure the gain in a live run (PI_ORCHESTRATOR_ROUTER_PROBE=1) with MCP servers configured

## Summary of changes

- `src/router/auto-model.ts`: `setPendingTask` (process-global map, like routing constraints), `agentRoleOf`, and `classifyEarly` / `dropEarlyClassification` on the auto model router. `firstRoute` takes the early classification and awaits it when its task text, agent role and router match; otherwise it classifies as before. The rung is still chosen and timestamped inside `withRoutingChoice`.
- `src/router/extension.ts`: session_start calls `classifyEarly` for a session on the auto model (role from `ctx.getSystemPrompt()`); session_shutdown drops an unused early classification.
- `src/subagents/worker.ts`: sets the pending task for a routed worker without a carried classification, before `bindExtensions`, and removes it when the worker ends.
- The classification now overlaps the rest of `bindExtensions` and the MCP startup wait in `before_agent_start`; worker SDK/package startup before session_start is not overlapped, since the worker's router settings are read at session_start.
