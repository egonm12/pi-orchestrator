---
# pi-orchestrator-s993
title: Split the transcript view into head, body and live lines
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T14:35:10Z
updated_at: 2026-09-27T15:02:49Z
parent: pi-orchestrator-z51n
---

## Parent

pi-orchestrator-z51n (epic pi-orchestrator-kd8n, ADR 0009).

## What to build

A prefactor with no visible change. The transcript view builds three parts separately: the head (orchestrator bar, header, nested workers), the body (the transcript, with its notices and end state) and the live lines (the footer). The fullscreen-overlay layout then arranges them exactly as today: head pinned at the top, the body windowed and scrolled, the footer at the bottom. This makes the regular-tuiMode layout (the next ticket) another arrangement of the same parts.

## Acceptance criteria

- [x] The view's parts are produced separately from how they are laid out
- [x] The overlay renders exactly as before; existing transcript view tests pass unchanged
- [x] Typecheck and the full test suite pass

## Blocked by

None, can start immediately.

## Summary of changes

- transcript-view.ts builds `TranscriptParts` in `#parts`: the head (bar, header, nested workers), the body (transcript, notices, end state) and the live lines (the footer, which may take a `BodyWindow`). `#overlayLayout` arranges them as before.
- The live lines' count never depends on the window, so a layout can size the window by them.
- No visible change: the transcript view tests pass unchanged. Typecheck is clean and the full suite passes.
- Left for n0fj: the regular layout moves the bar and the stats line into the live lines, so it splits the head further.
