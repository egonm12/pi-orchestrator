---
# pi-orchestrator-rowk
title: Long workers compact on their rung
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T19:25:27Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-ihm0
---

## Parent

pi-orchestrator-6nhd

## What to build

The auto model declares the largest context window and output limit among the tier map's rungs, and re-registers when the tier map is read. An overflow error from the pinned rung reaches pi labelled `orchestrator/auto`, so pi compacts the worker and retries on the same rung. The summary request compaction sends arrives with a new session id and is classified and routed like any other first request.

## Acceptance criteria

- [x] The registered model's context window and output limit equal the largest among the tier map's rungs
- [x] An overflow error from the rung comes back as an error labelled `orchestrator/auto` with its message unchanged
- [x] A request with a new session id whose text is a compaction summary prompt is classified and recorded as a first request

## Blocked by

- pi-orchestrator-ihm0

## Summary of Changes

- New `src/router/auto-model-limits.ts`: the auto model declares the largest context window and the largest output limit among the tier map's rungs, taken from pi's model registry (each maximum on its own; 200,000 / 64,000 when no rung declares one).
- `src/router/extension.ts` re-registers the `orchestrator` provider with those limits once the tier map is read at session start (live and shadow). The same `streamSimple` closure is kept, so pins survive re-registration.
- Seam-1 tests: the declared limits ignore models outside the tier map; an Anthropic overflow error (`prompt is too long: ...`, the pattern pi-ai's overflow detector matches) comes back labelled `orchestrator/auto` with its message unchanged and the retry stays on the pinned rung; a compaction summary request with a new session id is classified and recorded as a first request.
- Implemented by claude (opus-5-5), reviewed by codex (gpt-6-sol): OK with notes. The live case that forces pi's own compact-and-retry is part of c28l.
