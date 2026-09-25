---
# pi-orchestrator-bmid
title: /model refuses orchestrator/auto for the main thread
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-25T18:35:54Z
updated_at: 2026-09-25T19:37:09Z
parent: pi-orchestrator-6nhd
blocked_by:
    - pi-orchestrator-ihm0
---

## Parent

pi-orchestrator-6nhd

## What to build

When the owner selects `orchestrator/auto` for the main thread in `/model` or by cycling, the router extension restores the previous model and shows one line saying the auto model is for workers. A session that starts on `orchestrator/auto`, as a worker does, is left alone.

## Acceptance criteria

- [x] A `model_select` with source `set` or `cycle` to `orchestrator/auto` restores the previous model and shows one line
- [x] A startup or restore selection of `orchestrator/auto` is not undone
- [x] Selecting any other model is not affected

## Blocked by

- pi-orchestrator-ihm0

## Summary of Changes

- New `src/router/main-thread.ts`: a `model_select` handler that acts when the source is `set` or `cycle` and the model is `orchestrator/auto`. It calls `pi.setModel` with the previous model and shows one line (`ctx.ui.notify`, or stderr without a UI): `pi-orchestrator router: orchestrator/auto is for workers; restored <model> for the main thread.`
- pi has no startup source: a session that starts on the auto model (a worker) fires no `model_select`, and `restore` is left alone.
- When "set as default" saved `orchestrator/auto` as the global default (pi writes it before `model_select`), the handler waits for pi's queued save and puts the default back through pi's own `SettingsManager` (changed-fields-only merge under pi's lock). The line then says so; if it cannot, the line says the saved default is still `orchestrator/auto`.
- The seam-1 fake ExtensionAPI now keeps every handler per event, as pi does; a test checks `PI_ORCHESTRATOR_SESSION_MODEL` names the restored model after a refusal.
- Implemented by claude (opus-5-5), reviewed by codex (gpt-6-sol): BLOCK (persisted default), fixed; re-check OK.
- Known limits (accepted): set-as-default with a model scope also adds the auto model to the scoped and enabled models; cycling forward can stall when the auto model is next in the cycle. pi's in-memory default marker stays stale until the session ends.
