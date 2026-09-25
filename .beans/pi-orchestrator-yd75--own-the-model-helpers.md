---
# pi-orchestrator-yd75
title: Own the model helpers
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T18:51:57Z
parent: pi-orchestrator-6nhd
---

## Parent

pi-orchestrator-6nhd

## What to build

The thinking-level, thinking-suffix and allowed-model helpers that the tier map, tier router, classifier, ban lists and init use become pi-orchestrator's own code, tested on their own and no longer compared with pi-subagents. Agent lookup and model resolution stay for now. Nothing the owner sees changes.

## Acceptance criteria

- [x] The tier map, tier router, classifier, ban lists and init no longer import anything from the pi-subagents reimplementation
- [x] The helpers have their own unit tests, and no test of them needs pi-subagents installed
- [x] The offline suite and the typecheck pass

## Blocked by

None, can start immediately.

## Summary of Changes

- Moved the thinking-level, thinking-suffix and `toModelInfo` helpers to `src/models/model-info.ts` and the allowed-model match to `src/models/model-scope.ts`, described as pi-orchestrator's own code.
- The tier map, tier router, classifier, effort ladder, session classifier call, ban lists, delegation model check, init and fixtures import from `src/models/`. Only `src/router/extension.ts` still imports agent lookup and model resolution from `src/subagents/` (removed in itu1).
- New unit tests `src/models/model-info.test.ts` and `src/models/model-scope.test.ts` need no pi-subagents. The helper parity checks are gone; `src/subagents/model-resolution.test.ts` keeps the model resolution parity check.
- Implemented by claude (opus-5-5), reviewed by codex (gpt-6-sol): merge verdict OK.
