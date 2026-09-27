---
status: accepted
date: 2026-09-27
---

# The transcript view replaces pi's view in regular tuiMode

Spike rcjm and ticket llnk made the transcript view a full-screen overlay (`ctx.ui.custom` with `overlay: true`), because it never writes to the terminal's scrollback and leaves the session exactly as it was. In regular tuiMode that means the terminal's own scrolling does not reach the transcript: the mouse wheel scrolls the orchestrator's chat behind the overlay, and the view needs its own PgUp/PgDn keys. The owner wants the transcript to scroll like pi's chat. So in regular tuiMode the transcript view swaps pi's whole root for the transcript through pi-tui's public `TUI` API (`children`, `clear()`, `addChild()`), the way pi's own tuiMode switch does, and puts it back on leaving. pi-tui reprints the terminal, scrollback included, on each swap; the chat comes back from memory. Fullscreen tuiMode keeps the overlay until it gets its own ScrollView (a follow-up).

## Considered options

- **Keep the overlay and add wheel handling.** Regular tuiMode's screen does not capture the mouse, so the wheel never reaches the view.
- **Print the transcript below the chat.** Native scrolling, but the chat stays above it in the scrollback: the view adds to pi's view instead of replacing it.
- **Replace the root (chosen).** Native scrolling, selection and search. Nothing can stay pinned at the top, so the live stats sit at the bottom.

## Consequences

- Opening, leaving and switching worker reprint the whole terminal. You land at the bottom, not at your earlier scroll position.
- A change above the visible screen reprints everything, as pi's chat does.
- While the view is open, the orchestrator's output reaches only the swapped-out tree. It shows once the user leaves.
- The scroll keys and "following" are gone.
