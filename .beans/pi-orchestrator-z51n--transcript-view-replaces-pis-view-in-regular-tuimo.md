---
# pi-orchestrator-z51n
title: Transcript view replaces pi's view in regular tuiMode
status: completed
type: feature
priority: normal
tags:
    - needs-triage
created_at: 2026-09-27T14:25:50Z
updated_at: 2026-09-27T15:16:38Z
parent: pi-orchestrator-kd8n
blocked_by:
    - pi-orchestrator-jjem
---

Rebuild the transcript view on the mechanism the spike confirms (ADR 0009). Split into tickets after the spike.

## Behaviour
- Top, printed once: agent, model and rung history, delegation id, and the full task, wrapped, without a limit.
- Bottom, live: worker state, elapsed, turns, tokens, cost, activity, worker n of m, the orchestrator bar, and the key hints.
- Scrolling is the terminal's own. PgUp, PgDn, Home, End and following are removed.
- Keys: Esc leaves, ←→ switches worker, ctrl+o toggles tool output, x stops a worker after confirmation.
- A change above the visible screen reprints, as pi's chat does. Leaving and switching worker reprint and land at the bottom.
- The view never closes on its own; the orchestrator's output shows once the user leaves.
- Fullscreen tuiMode keeps the overlay for now.

## Todo
- [x] Split into tickets after the spike

## Summary of changes

Done in three tickets:

- s993 split the transcript view into head, body and live lines.
- n0fj made the view replace pi's view in regular tuiMode. It prints its top once, then the whole transcript, then the live lines, and the terminal does the scrolling. Fullscreen tuiMode keeps the overlay, with the task wrapped to at most 3 lines.
- n39l listed nested workers in the live lines.

Fullscreen scrolling is still open as 1v5z.
