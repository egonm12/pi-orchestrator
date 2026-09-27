---
# pi-orchestrator-n0fj
title: The transcript view replaces pi's view in regular tuiMode
status: completed
type: task
priority: normal
tags:
    - ready-for-agent
created_at: 2026-09-27T14:35:10Z
updated_at: 2026-09-27T15:13:20Z
parent: pi-orchestrator-z51n
blocked_by:
    - pi-orchestrator-s993
---

## Parent

pi-orchestrator-z51n (epic pi-orchestrator-kd8n, ADR 0009 accepted; mechanism confirmed by spike pi-orchestrator-jjem).

## What to build

In regular tuiMode, opening a worker replaces pi's whole view with the transcript, which scrolls with the terminal's own scrollback, wheel and search. Mechanism, from the spike: open through ctx.ui.custom without overlay; inside the factory save the root TUI's children, clear the root and add the view; on leaving put the saved children back before calling done, so pi restores the editor, its text and focus. The view reads the tuiMode from the tui it is given; fullscreen tuiMode keeps the overlay.

Regular-tuiMode layout, top to bottom:
- printed once: agent, model and rung history, delegation id, and the whole task, wrapped without a limit;
- the transcript, in full (no windowing);
- live lines at the end: worker state, elapsed, turns, tokens, cost, activity, worker n of m, the orchestrator bar, and the key hints.

Keys in regular tuiMode: Esc (and ctrl+c) leaves, ←→ switches worker, ctrl+o toggles tool output, x stops a worker after confirmation. PgUp, PgDn, Home, End and following are gone. Leaving and switching worker reprint and land at the bottom. The view never closes on its own.

In fullscreen tuiMode the overlay's pinned header shows the task wrapped to at most 3 lines, ending in … when longer.

## Acceptance criteria

- [x] Regular tuiMode: pi's view is swapped out while open and restored intact on leaving (chat, editor text, worker widget, focus)
- [x] Regular tuiMode: the layout above, with the whole task wrapped and live lines last
- [x] Regular tuiMode: scroll keys and following are removed; the key hints match the keys
- [x] Fullscreen tuiMode: overlay unchanged except the task wraps to at most 3 lines
- [x] Tests cover both modes' layouts and the swap and restore
- [x] README's transcript view section describes both modes
- [x] scratch/root-swap-spike/ is deleted
- [x] Typecheck and the full test suite pass

## Blocked by

- pi-orchestrator-s993 (Split the transcript view into head, body and live lines)

## Summary of changes

- In regular tuiMode, openTranscript swaps pi's root for the view (`swapRoot`) and puts pi's tree back before pi closes, so the chat, editor text, worker widget and focus return. pi takes the overlay choice before the factory runs, so the view always opens as an overlay with options read after the factory. In regular tuiMode that overlay is a key stub that draws nothing (`KEYS_OVERLAY`), as the widget's alt+a focus does. ADR 0009 has an implementation note on this.
- Regular layout: `transcriptTop` (agent, model and rung history, delegation, and the whole task wrapped), the full transcript, then the live lines (`liveStats`, the orchestrator bar, and hints `←→ worker · x stop · ctrl+o tool output · Esc back`). Scroll keys and following are gone there. Opening, switching worker and leaving force a reprint.
- Fullscreen tuiMode keeps the overlay. Its header now wraps the task to at most 3 lines, ending in `…`.
- Tests cover both layouts and the swap and restore. README describes both modes. The untracked scratch/root-swap-spike/ is deleted.
- Left for n39l: nested workers in the regular layout. Minor: the 3-line `…` cut counts characters, not display width.
